import type { DB } from './db.js';
import { appendLedger } from './ledger.js';
import { botGoneMessage, isBotGone } from './botLifecycle.js';
import { LIMITS } from './limits.js';
import { canBank, getRoom, isMember, roomEvents } from './rooms.js';

/**
 * The single path by which chips enter a seat. Both the public `/api/rooms/:id/buy`
 * routes and the bot creation flow go through here; nothing writes
 * `room_players.stack` for a purchase except this module, so the pending limit,
 * idempotency window, banker attribution and the hash-chained ledger stay in
 * one place.
 */

export class BuyServiceError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestRoomBuyInput {
  roomId: string;
  userId: number;
  amount: number;
  note?: string;
}

export interface RoomBuyResult {
  id: number;
  status: string;
  duplicate?: boolean;
}

/**
 * Raise a buy request. Returns `status: 'pending'` when a banker must approve,
 * or `'approved'` when the room auto-approves buys. Behaviour is unchanged from
 * the original route: pending cap, dedup window, two roomEvents emissions on the
 * auto-approve path, and banker attribution all preserved.
 */
export function requestRoomBuy(db: DB, input: RequestRoomBuyInput): RoomBuyResult {
  const { roomId, userId, amount, note } = input;
  // The service is the single money path, so validate the cap here too rather
  // than trusting every caller to repeat the route's zod bound.
  if (!Number.isInteger(amount) || amount <= 0 || amount > LIMITS.maxChipAmount) {
    throw new BuyServiceError(400, 'invalid amount');
  }
  const room = getRoom(db, roomId);
  if (!room) throw new BuyServiceError(404, 'no such room');
  if (!isMember(db, roomId, userId)) throw new BuyServiceError(403, 'not a member');
  const pending = db
    .prepare(
      "SELECT COUNT(*) as n FROM buy_requests WHERE room_id = ? AND user_id = ? AND status = 'pending'",
    )
    .get(roomId, userId) as { n: number };
  if (pending.n >= LIMITS.pendingBuysPerRoom) {
    throw new BuyServiceError(429, 'you already have buy requests waiting');
  }
  // Idempotency: an identical buy moments after the last one is the same buy.
  const recent = db
    .prepare(
      'SELECT id, status FROM buy_requests WHERE room_id = ? AND user_id = ? AND amount = ? AND ts > ? ORDER BY id DESC LIMIT 1',
    )
    .get(roomId, userId, amount, Date.now() - LIMITS.dedupWindowMs) as
    { id: number; status: string } | undefined;
  if (recent) return { id: recent.id, status: recent.status, duplicate: true };

  const info = db
    .prepare('INSERT INTO buy_requests (room_id, user_id, amount, note, ts) VALUES (?, ?, ?, ?, ?)')
    .run(roomId, userId, amount, note ?? null, Date.now());
  const requestId = Number(info.lastInsertRowid);

  if (!room.auto_approve_buys) {
    roomEvents.emit('changed', roomId);
    return { id: requestId, status: 'pending' };
  }

  // The banker pre-approved buys for this room; settle it like a banker click,
  // attributed to the standing banker so the ledger names who vouched.
  const apply = db.transaction(() => {
    db.prepare("UPDATE buy_requests SET status = 'approved' WHERE id = ?").run(requestId);
    appendLedger(db, {
      roomId,
      userId,
      delta: amount,
      kind: 'purchase',
      approvedBy: room.banker_id,
      note: note ?? undefined,
    });
    db.prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?').run(
      amount,
      roomId,
      userId,
    );
  });
  apply();
  // Promote before emitting: a subscriber woken by the event must never read the
  // still-`waiting_buy_approval` row and treat a funded bot as not ready.
  promoteBotAfterBuy(db, roomId, userId);
  roomEvents.emit('changed', roomId);
  return { id: requestId, status: 'approved' };
}

export interface ApproveRoomBuyInput {
  roomId: string;
  actorId: number;
  requestId: number;
  approve: boolean;
}

/**
 * Banker decision on one pending buy request. On approval the chips move through
 * the ledger exactly as before; rejection only flips the request status.
 */
export function approveRoomBuy(db: DB, input: ApproveRoomBuyInput): void {
  const { roomId, actorId, requestId, approve } = input;
  const room = getRoom(db, roomId);
  if (!room) throw new BuyServiceError(404, 'no such room');
  if (!canBank(room, actorId)) throw new BuyServiceError(403, 'banker only');
  const request = db
    .prepare("SELECT * FROM buy_requests WHERE id = ? AND room_id = ? AND status = 'pending'")
    .get(requestId, roomId) as
    { id: number; user_id: number; amount: number; note: string | null } | undefined;
  if (!request) throw new BuyServiceError(404, 'no such pending request');

  // A buy request can outlive the bot it funds: the host raises it while the bot
  // is alive, then asks for a hard delete. With a live runner the delete parks
  // the bot `stopping` + `delete_requested_at` until the wind-down finishes, and
  // only then does `finalizeBotRemoved` cancel pending buys and drop the seat
  // row. In that window a banker approval used to write the ledger and bump
  // `room_players.stack`, leaving a funded purchase whose seat is then deleted.
  // Refuse before ANY write (so buy_requests stays pending too).
  //
  // Keyed by the request's `user_id`, which maps to at most one bot_accounts row
  // (`bot_accounts.user_id` is UNIQUE -> an automatic index, so this is an
  // indexed point lookup, not a scan). A human buyer has no bot_accounts row, so
  // the human path is untouched.
  if (approve) {
    const bot = db
      .prepare('SELECT status, delete_requested_at FROM bot_accounts WHERE user_id = ? AND room_id = ?')
      .get(request.user_id, roomId) as { status: string; delete_requested_at: number | null } | undefined;
    if (bot && isBotGone(bot)) throw new BuyServiceError(409, botGoneMessage(bot));
  }

  const apply = db.transaction(() => {
    db.prepare('UPDATE buy_requests SET status = ? WHERE id = ?').run(
      approve ? 'approved' : 'rejected',
      request.id,
    );
    if (approve) {
      appendLedger(db, {
        roomId,
        userId: request.user_id,
        delta: request.amount,
        kind: 'purchase',
        approvedBy: actorId,
        note: request.note ?? undefined,
      });
      db.prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?').run(
        request.amount,
        roomId,
        request.user_id,
      );
    }
  });
  apply();
  if (approve) promoteBotAfterBuy(db, roomId, request.user_id);
  roomEvents.emit('changed', roomId);
}

/** A bot waiting on its first buy-in becomes ready the moment chips land. */
function promoteBotAfterBuy(db: DB, roomId: string, userId: number): void {
  db.prepare(
    "UPDATE bot_accounts SET status = 'ready', updated_at = ? WHERE room_id = ? AND user_id = ? AND status = 'waiting_buy_approval'",
  ).run(Date.now(), roomId, userId);
}
