import { randomBytes } from 'node:crypto';
import { commissionSettings } from './platformSettings.js';
import { MAX_QUALIFYING_HANDS } from '@4am/shared';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { requireUser } from './auth.js';
import { appendLedger, verifyLedger } from './ledger.js';
import { BuyServiceError, approveRoomBuy, requestRoomBuy } from './buyService.js';
import { LIMITS } from './limits.js';
import { activeHands } from './liveHands.js';
import { platformUserId } from './platform.js';
import { settlementNotVoidedSql, voidHandExistsSql } from './handProjection.js';
import {
  applyRoomFeatures,
  bombScheduleError,
  gameplayFeaturesSchema,
  mergeRoomFeatures,
  readRoomFeatures,
  ROOM_FEATURE_DEFAULTS,
} from './gameplaySettings.js';

export interface RoomRow {
  id: string;
  name: string;
  join_code: string;
  host_id: number;
  banker_id: number;
  sb: number;
  bb: number;
  audit_mode: string;
  action_secs: number | null;
  co_banker_id: number | null;
  min_settle_hands: number;
  seven_deuce_bonus: number;
  voided: number;
  archived: number;
  archived_at: number | null;
  deleted: number;
  meet_link: string | null;
  visibility: string;
  spectate_token: string | null;
  allow_spectators: number;
  auto_approve_buys: number;
  tv_replays: number;
  auto_deal: number;
  commission_bps: number;
  created_at: number;
  // gameplay features - see gameplaySettings.ts
  squid_enabled: number;
  squid_penalty_bb: number;
  squid_min_players: number;
  time_bank_enabled: number;
  time_bank_initial_secs: number;
  time_bank_refill_every_hands: number;
  time_bank_refill_secs: number;
  time_bank_epoch: number;
  bomb_pot_enabled: number;
  bomb_pot_ante_bb: number;
  bomb_pot_schedule_mode: string;
  bomb_pot_schedule_value: number;
  multi_run_enabled: number;
  multi_run_max_runs: number;
}

/** The main banker and the backup banker both hold banking powers. */
export function canBank(room: RoomRow, userId: number): boolean {
  return room.banker_id === userId || room.co_banker_id === userId;
}

/** Emits ('changed', roomId) when REST mutations alter room membership or stacks. */
export const roomEvents = new EventEmitter();

const actionSecsSchema = z.union([z.literal(0), z.number().int().min(5).max(180)]); // 0 = no limit

const minSettleSchema = z.number().int().min(0).max(MAX_QUALIFYING_HANDS);

const meetLinkSchema = z
  .string()
  .max(300)
  .regex(/^https:\/\//, 'must be an https link')
  .or(z.literal(''));

const createSchema = z.object({
  name: z.string().min(1).max(48),
  sb: z.number().int().positive(),
  bb: z.number().int().positive(),
  auditMode: z.enum(['private', 'strict-audit']).optional(),
  actionSecs: actionSecsSchema.optional(),
  minSettleHands: minSettleSchema.optional(),
  commissionRevision: z.number().int().positive().optional(),
  meetLink: meetLinkSchema.optional(),
  visibility: z.enum(['private', 'public']).optional(),
  autoApproveBuys: z.boolean().optional(),
  features: gameplayFeaturesSchema.optional(),
});

function newJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => chars[b % chars.length]!).join('');
}

export function getRoom(db: DB, roomId: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined;
}

export interface ArchiveTransition {
  /** The room was already archived; nothing changed. */
  alreadyClosed: boolean;
  /** The stable archived_at (original on a repeat, new on the transition). */
  archivedAt: number | null;
  /** True only for the 0 -> 1 transition (callers emit `changed` only then). */
  changed: boolean;
}

/**
 * The archive state change, to be called INSIDE an open transaction. One
 * implementation shared by `/api/rooms/:id/close`, the admin lifecycle
 * approval and the admin archive route so they cannot drift:
 *
 *  - idempotent and race-safe: a conditional `WHERE archived = 0` update plus
 *    its `changes` count means two overlapping archives transition once, and
 *    `archived_at` is never overwritten;
 *  - on the transition it clears every seat and marks everyone sitting out,
 *    exactly like `/close`. A hand already in flight keeps its own seat
 *    snapshot and still settles; nobody is dealt into the next one.
 *
 * CONTRACT - the three archive entry points differ ONLY in their pre-checks,
 * never in the resulting state (all three funnel through this function):
 *
 *  1. `POST /api/rooms/:id/close` (host/platform): NO `activeHands` check. A
 *     live hand is allowed to finish; close only guarantees nobody is dealt
 *     into the next one. Immediate, no approval.
 *  2. `POST /api/admin/rooms/:id/archive` (platform, toggling archived=true):
 *     REFUSES while `activeHands` holds the room (400) - a stricter admin
 *     guard. Unarchive has no such guard.
 *  3. Lifecycle approval (`/api/rooms/:id/archive` request then
 *     `POST /api/admin/lifecycle/:id`): NO `activeHands` check, because the
 *     request was filed when the room was idle and a hand may legitimately
 *     have started while it sat in the approval queue. Approving archives and
 *     clears seats; any in-flight hand settles on its snapshot exactly as
 *     `/close` would. This is deliberate and safe - `startHand` re-reads
 *     `archived` inside its own claim transaction, so an approval that lands
 *     first still prevents the next deal.
 */
export function archiveRoomTx(db: DB, roomId: string): ArchiveTransition {
  const current = getRoom(db, roomId);
  if (!current) return { alreadyClosed: true, archivedAt: null, changed: false };
  if (current.archived)
    return { alreadyClosed: true, archivedAt: current.archived_at ?? null, changed: false };
  const now = Date.now();
  const info = db
    .prepare('UPDATE rooms SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0')
    .run(now, roomId);
  if (info.changes === 0) {
    const again = getRoom(db, roomId);
    return { alreadyClosed: true, archivedAt: again?.archived_at ?? null, changed: false };
  }
  db.prepare('UPDATE room_players SET seat = NULL, sitting_out = 1 WHERE room_id = ?').run(roomId);
  return { alreadyClosed: false, archivedAt: now, changed: true };
}

/** {@link archiveRoomTx} in its own IMMEDIATE transaction (the writer lock that
 *  serializes against a concurrent `startHand` feature-claim). */
export function archiveRoom(db: DB, roomId: string): ArchiveTransition {
  return db.transaction(() => archiveRoomTx(db, roomId)).immediate();
}

export function isSpectator(db: DB, roomId: string, userId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM spectators WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId);
}

export function isMember(db: DB, roomId: string, userId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId);
}

export function roomPlayers(db: DB, roomId: string) {
  return db
    .prepare(
      `SELECT rp.user_id as userId, u.username, COALESCE(u.display_name, u.username) as displayName,
              u.avatar_version as avatarVersion, u.pubkey as publicKey, rp.seat, rp.stack,
              rp.sitting_out as sittingOut, u.private_mode as privateMode,
              COALESCE(b.total, 0) as totalBought,
              COALESCE(pr.pending, 0) as pendingBuy
       FROM room_players rp
       JOIN users u ON u.id = rp.user_id
       LEFT JOIN (
         SELECT user_id, SUM(delta) as total FROM ledger
         WHERE room_id = ? AND kind IN ('purchase', 'revert') GROUP BY user_id
       ) b ON b.user_id = rp.user_id
       LEFT JOIN (
         SELECT user_id, SUM(amount) as pending FROM buy_requests
         WHERE room_id = ? AND status = 'pending' GROUP BY user_id
       ) pr ON pr.user_id = rp.user_id
       WHERE rp.room_id = ? ORDER BY rp.seat`,
    )
    .all(roomId, roomId, roomId) as {
    userId: number;
    username: string;
    displayName: string;
    avatarVersion: number;
    publicKey: string;
    seat: number | null;
    stack: number;
    sittingOut: number;
    privateMode: number;
    totalBought: number;
    pendingBuy: number;
  }[];
}

/** `roomPlayers` minus the platform/house account. The platform's `room_players` row
 *  (its rake stack) is real accounting data and must stay in the DB - this only
 *  filters it out of arrays shown to clients. Shared by the REST room payload
 *  (`roomJson`) and the live table's websocket broadcast so neither can drift and
 *  leak the house as a "player". */
export function presentablePlayers(db: DB, roomId: string) {
  const platformId = platformUserId(db);
  return roomPlayers(db, roomId).filter((p) => p.userId !== platformId);
}

function roomJson(db: DB, room: RoomRow) {
  return {
    id: room.id,
    name: room.name,
    joinCode: room.join_code,
    hostId: room.host_id,
    bankerId: room.banker_id,
    sb: room.sb,
    bb: room.bb,
    auditMode: room.audit_mode,
    actionSecs: room.action_secs,
    coBankerId: room.co_banker_id,
    minSettleHands: room.min_settle_hands,
    sevenDeuceBonus: room.seven_deuce_bonus,
    voided: !!room.voided,
    archived: !!room.archived,
    archivedAt: room.archived_at,
    meetLink: room.meet_link,
    visibility: room.visibility,
    allowSpectators: !!room.allow_spectators,
    autoApproveBuys: !!room.auto_approve_buys,
    tvReplays: !!room.tv_replays,
    autoDeal: !!room.auto_deal,
    commissionBps: room.commission_bps,
    features: readRoomFeatures(room),
    timeBankEpoch: room.time_bank_epoch,
    players: presentablePlayers(db, room.id).map((p) => ({
      ...p,
      privateMode: undefined,
      privateStats: !!p.privateMode,
      totalBought: p.privateMode ? 0 : p.totalBought,
      pendingBuy: p.pendingBuy,
    })),
  };
}

interface FeatureTriggerRow {
  id: number;
  room_id: string;
  request_id: string;
  kind: string;
  source: string;
  status: string;
  requested_by: number | null;
  created_at: number;
  claimed_hand_id: string | null;
  resolved_at: number | null;
}

function featureTriggerJson(row: FeatureTriggerRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    feature: row.kind,
    source: row.source,
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    claimedHandId: row.claimed_hand_id,
    resolvedAt: row.resolved_at,
  };
}

export function registerRoomRoutes(app: FastifyInstance, db: DB): void {
  const authed = { preHandler: requireUser(db) };

  app.post('/api/rooms', authed, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    if (
      parsed.data.commissionRevision !== undefined &&
      parsed.data.commissionRevision !== commissionSettings(db).revision
    )
      return reply.code(409).send({
        error: 'The house cut changed. Review the updated rate and create the room again.',
      });
    const {
      name,
      sb,
      bb,
      auditMode,
      actionSecs,
      minSettleHands,
      meetLink,
      visibility,
      autoApproveBuys,
      features,
    } = parsed.data;
    if (bb < sb) return reply.code(400).send({ error: 'big blind must be >= small blind' });
    // Normalize against the migrated defaults up front so an invalid bomb-pot
    // cadence is rejected before a room row exists.
    const normalizedFeatures = features
      ? mergeRoomFeatures(ROOM_FEATURE_DEFAULTS, features)
      : undefined;
    if (normalizedFeatures) {
      const bombError = bombScheduleError(normalizedFeatures);
      if (bombError) return reply.code(400).send({ error: bombError });
    }
    const id = randomBytes(6).toString('hex');
    const joinCode = newJoinCode();
    db.prepare(
      `INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, audit_mode, action_secs, min_settle_hands, meet_link, visibility, spectate_token, auto_approve_buys, created_at, commission_bps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      joinCode,
      req.userId,
      req.userId,
      sb,
      bb,
      auditMode ?? 'private',
      actionSecs ?? null,
      minSettleHands ?? 0,
      meetLink || null,
      visibility ?? 'private',
      randomBytes(9).toString('hex'),
      autoApproveBuys ? 1 : 0,
      Date.now(),
      commissionSettings(db).commissionBps,
    );
    db.prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)').run(id, req.userId);
    if (normalizedFeatures) {
      const stored = readRoomFeatures(getRoom(db, id)!);
      applyRoomFeatures(db, id, normalizedFeatures, stored);
    }
    return roomJson(db, getRoom(db, id)!);
  });

  app.post('/api/rooms/join', authed, async (req, reply) => {
    // codes are exactly 6 chars from a 32-char alphabet; an unbounded string here
    // was a free brute-force surface against the room-membership gate
    const parsed = z.object({ joinCode: z.string().trim().length(6) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const room = db
      .prepare('SELECT * FROM rooms WHERE join_code = ?')
      .get(parsed.data.joinCode.toUpperCase()) as RoomRow | undefined;
    if (!room) return reply.code(404).send({ error: 'no such room' });
    // A closed/archived (or deleted) table takes no new members: the join code
    // stays on the client but must not resurrect access to hands/ledger.
    if (room.archived || room.deleted)
      return reply.code(409).send({ error: 'this table is closed' });
    db.prepare('INSERT OR IGNORE INTO room_players (room_id, user_id) VALUES (?, ?)').run(
      room.id,
      req.userId,
    );
    roomEvents.emit('changed', room.id);
    return roomJson(db, room);
  });

  app.get('/api/rooms/:id', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (isMember(db, id, req.userId)) return { ...roomJson(db, room), youAre: 'member' };
    if (isSpectator(db, id, req.userId))
      return { ...roomJson(db, room), joinCode: '', youAre: 'spectator' };
    return reply.code(403).send({ error: 'not a member' });
  });

  // browse and join tables whose hosts made them public (no code needed)
  app.get('/api/rooms/public', authed, async () => {
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.sb, r.bb, r.meet_link as meetLink,
                COALESCE(u.display_name, u.username) as hostName,
                (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id
                   AND rp.user_id NOT IN (SELECT CAST(value AS INTEGER) FROM meta WHERE key='platform_user_id')) as playerCount
         FROM rooms r JOIN users u ON u.id = r.host_id
         WHERE r.visibility = 'public' AND r.archived = 0 AND r.deleted = 0
         ORDER BY r.created_at DESC LIMIT 30`,
      )
      .all();
    return { rooms: rows };
  });

  app.post('/api/rooms/:id/join-public', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.visibility !== 'public')
      return reply.code(403).send({ error: 'this table is private' });
    if (room.archived || room.deleted)
      return reply.code(409).send({ error: 'this table is closed' });
    db.prepare('INSERT OR IGNORE INTO room_players (room_id, user_id) VALUES (?, ?)').run(
      id,
      req.userId,
    );
    db.prepare('DELETE FROM spectators WHERE room_id = ? AND user_id = ?').run(id, req.userId);
    roomEvents.emit('changed', id);
    return roomJson(db, room);
  });

  app.post('/api/rooms/:id/buy', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    // The cap is load-bearing, not cosmetic. Without it ~10 buys of 1e18 push
    // room_players.stack past 2^63, SQLite silently retypes the value to REAL,
    // and from then on every debit rounds away to nothing while every credit
    // lands - an unlimited chip faucet for anyone at a table with auto-approve.
    const parsed = z
      .object({
        amount: z.number().int().positive().max(LIMITS.maxChipAmount),
        note: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    {
      const room = getRoom(db, id);
      if (room && (room.archived || room.deleted))
        return reply.code(409).send({ error: 'this table is closed' });
    }
    // All buy semantics (pending cap, idempotency window, auto-approve, banker
    // attribution, ledger + stack move) live in the shared buy service so bots
    // cannot get a different deal from humans.
    try {
      return requestRoomBuy(db, {
        roomId: id,
        userId: req.userId,
        amount: parsed.data.amount,
        note: parsed.data.note,
      });
    } catch (e) {
      if (e instanceof BuyServiceError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/rooms/:id/requests', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (!canBank(room, req.userId)) return reply.code(403).send({ error: 'banker only' });
    const rows = db
      .prepare(
        `SELECT br.id, br.user_id as userId, u.username, br.amount, br.note, br.ts
         FROM buy_requests br JOIN users u ON u.id = br.user_id
         WHERE br.room_id = ? AND br.status = 'pending' ORDER BY br.id`,
      )
      .all(id);
    return { requests: rows };
  });

  app.post('/api/rooms/:id/approve', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ requestId: z.number().int(), approve: z.boolean() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    {
      const room = getRoom(db, id);
      if (room && (room.archived || room.deleted))
        return reply.code(409).send({ error: 'this table is closed' });
    }
    try {
      approveRoomBuy(db, {
        roomId: id,
        actorId: req.userId,
        requestId: parsed.data.requestId,
        approve: parsed.data.approve,
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof BuyServiceError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });

  // the main banker names (or clears) a backup banker with the same powers
  app.put('/api/rooms/:id/co-banker', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ userId: z.number().int().nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.banker_id !== req.userId)
      return reply.code(403).send({ error: 'only the main banker can pick a backup' });
    if (parsed.data.userId !== null && !isMember(db, id, parsed.data.userId))
      return reply.code(400).send({ error: 'the backup banker must be a room member' });
    db.prepare('UPDATE rooms SET co_banker_id = ? WHERE id = ?').run(parsed.data.userId, id);
    roomEvents.emit('changed', id);
    return { ok: true };
  });

  // banker reverses a specific earlier purchase with a compensating ledger entry
  app.post('/api/rooms/:id/revert', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ entryId: z.number().int() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.archived || room.deleted)
      return reply.code(409).send({ error: 'this table is closed' });
    if (!canBank(room, req.userId)) return reply.code(403).send({ error: 'banker only' });
    // Chips at risk in a live hand are held in memory, not deducted from the
    // stack, so a mid-hand revert passes its own solvency check and then settles
    // into a negative balance. Transfers already refuse for the same reason.
    if (activeHands.has(id)) {
      return reply.code(400).send({ error: 'wait for the hand to finish' });
    }
    const entry = db
      .prepare('SELECT * FROM ledger WHERE id = ? AND room_id = ?')
      .get(parsed.data.entryId, id) as
      { id: number; user_id: number; delta: number; kind: string; entry_hash: string } | undefined;
    if (!entry) return reply.code(404).send({ error: 'no such ledger entry' });
    if (entry.kind !== 'purchase')
      return reply.code(400).send({ error: 'only purchases can be reverted' });
    const already = db
      .prepare("SELECT 1 FROM ledger WHERE room_id = ? AND kind = 'revert' AND ref = ?")
      .get(id, entry.entry_hash);
    if (already) return reply.code(400).send({ error: 'that purchase was already reverted' });
    const player = db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(id, entry.user_id) as { stack: number } | undefined;
    if (!player || player.stack < entry.delta)
      return reply
        .code(400)
        .send({ error: 'the player no longer has enough chips to revert this' });
    const apply = db.transaction(() => {
      appendLedger(db, {
        roomId: id,
        userId: entry.user_id,
        delta: -entry.delta,
        kind: 'revert',
        approvedBy: req.userId,
        ref: entry.entry_hash,
        note: `revert of purchase #${entry.id}`,
      });
      db.prepare('UPDATE room_players SET stack = stack - ? WHERE room_id = ? AND user_id = ?').run(
        entry.delta,
        id,
        entry.user_id,
      );
    });
    apply();
    roomEvents.emit('changed', id);
    return { ok: true };
  });

  app.put('/api/rooms/:id/settings', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        actionSecs: actionSecsSchema.optional(),
        minSettleHands: minSettleSchema.optional(),
        sevenDeuceBonus: z.number().int().min(0).max(100_000).optional(),
        meetLink: meetLinkSchema.optional(),
        visibility: z.enum(['private', 'public']).optional(),
        autoApproveBuys: z.boolean().optional(),
        tvReplays: z.boolean().optional(),
        autoDeal: z.boolean().optional(),
        features: gameplayFeaturesSchema.optional(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'turn time must be 0 (no limit) or 5-180 seconds' });
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.host_id !== req.userId && !canBank(room, req.userId))
      return reply.code(403).send({ error: 'host or banker only' });
    if (parsed.data.autoDeal !== undefined && room.host_id !== req.userId)
      return reply.code(403).send({ error: 'only the host can change auto-deal' });
    // Auto-approve and visibility are the two settings that grant money or
    // access, so a backup banker must not be able to flip them - otherwise the
    // backup turns auto-approve on, buys itself a fortune, and turns it back off.
    const privileged =
      parsed.data.autoApproveBuys !== undefined || parsed.data.visibility !== undefined;
    if (privileged && room.banker_id !== req.userId && room.host_id !== req.userId) {
      return reply.code(403).send({ error: 'only the host or the main banker can change that' });
    }
    // Gameplay features are a host call, never the (backup) banker's: they
    // change how chips move, so the same reasoning as auto-approve applies but
    // stricter. They also only make sense at a hand boundary.
    if (parsed.data.features !== undefined) {
      if (room.host_id !== req.userId)
        return reply.code(403).send({ error: 'only the host can change gameplay settings' });
      if (activeHands.has(id))
        return reply.code(409).send({ error: 'Gameplay settings apply between hands.' });
      const current = readRoomFeatures(room);
      const next = mergeRoomFeatures(current, parsed.data.features);
      const bombError = bombScheduleError(next);
      if (bombError) return reply.code(400).send({ error: bombError });
      applyRoomFeatures(db, id, next, current);
    }
    if (parsed.data.actionSecs !== undefined)
      db.prepare('UPDATE rooms SET action_secs = ? WHERE id = ?').run(parsed.data.actionSecs, id);
    if (parsed.data.minSettleHands !== undefined)
      db.prepare('UPDATE rooms SET min_settle_hands = ? WHERE id = ?').run(
        parsed.data.minSettleHands,
        id,
      );
    if (parsed.data.sevenDeuceBonus !== undefined)
      db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(
        parsed.data.sevenDeuceBonus,
        id,
      );
    if (parsed.data.meetLink !== undefined)
      db.prepare('UPDATE rooms SET meet_link = ? WHERE id = ?').run(
        parsed.data.meetLink || null,
        id,
      );
    if (parsed.data.visibility !== undefined)
      db.prepare('UPDATE rooms SET visibility = ? WHERE id = ?').run(parsed.data.visibility, id);
    if (parsed.data.autoApproveBuys !== undefined)
      db.prepare('UPDATE rooms SET auto_approve_buys = ? WHERE id = ?').run(
        parsed.data.autoApproveBuys ? 1 : 0,
        id,
      );
    // TV replays: after every hand each player's per-hand key is saved to the
    // transcript so replays show ALL hole cards, WSOP broadcast style
    // (requested by notpritam, docs/FEATURES.md)
    if (parsed.data.tvReplays !== undefined)
      db.prepare('UPDATE rooms SET tv_replays = ? WHERE id = ?').run(
        parsed.data.tvReplays ? 1 : 0,
        id,
      );
    if (parsed.data.autoDeal !== undefined)
      db.prepare('UPDATE rooms SET auto_deal = ? WHERE id = ?').run(
        parsed.data.autoDeal ? 1 : 0,
        id,
      );
    roomEvents.emit('changed', id, { restartAutoDeal: parsed.data.autoDeal === true });
    // Hand back the normalized gameplay settings so the client can render the
    // canonical values (e.g. merged defaults) instead of echoing its own patch.
    return { ok: true, features: readRoomFeatures(getRoom(db, id)!) };
  });

  app.get('/api/my-rooms', authed, async (req) => {
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.join_code as joinCode, r.sb, r.bb, r.archived as archived,
                (SELECT COUNT(*) FROM room_players rp2 WHERE rp2.room_id = r.id
                   AND rp2.user_id NOT IN (SELECT CAST(value AS INTEGER) FROM meta WHERE key='platform_user_id')) as playerCount
         FROM rooms r JOIN room_players rp ON rp.room_id = r.id
         WHERE rp.user_id = ? AND r.deleted = 0 ORDER BY r.created_at DESC`,
      )
      .all(req.userId);
    return { rooms: rows };
  });

  // "My results": every room this account has ever been part of - including
  // archived/closed and deleted ones - with a per-room net and hand count, so a
  // finished game can still be reviewed after the host closes the table. Reads
  // only `room_players`, `rooms` and the hash-chained `ledger`, so it needs no
  // new table and survives every lifecycle state (rows are never dropped).
  // Query params are validated rather than silently clamped: a bad limit/offset
  // ("abc", 0, 201, -1) is a client bug and gets a 400, not a normalized page.
  const meRoomsQuerySchema = z.object({
    archived: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  });

  app.get('/api/me/rooms', authed, async (req, reply) => {
    const parsed = meRoomsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const where: string[] = [];
    if (parsed.data.archived === 'true') where.push('r.archived = 1');
    else if (parsed.data.archived === 'false') where.push('r.archived = 0');
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';
    // `total` is the filtered room count, so the client can page through every
    // room the caller was part of instead of silently truncating at one page.
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM room_players rp JOIN rooms r ON r.id = rp.room_id
           WHERE rp.user_id = ? ${whereSql}`,
        )
        .get(req.userId) as { n: number }
    ).n;
    // Career totals over the whole filtered set (not just the current page):
    // the history header must not shrink when the user pages or filters.
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(t.myHands), 0) AS hands, COALESCE(SUM(t.myNet), 0) AS net
         FROM (
           SELECT
             (rp.stack - COALESCE((
               SELECT SUM(l.delta) FROM ledger l
               WHERE l.room_id = r.id AND l.user_id = rp.user_id
                 AND l.kind IN ('purchase', 'revert')
             ), 0)) AS myNet,
             (SELECT COUNT(DISTINCT l.ref) FROM ledger l
               WHERE l.room_id = r.id AND l.user_id = rp.user_id
                 AND l.kind = 'hand-settlement' AND l.ref IS NOT NULL
                 AND ${settlementNotVoidedSql('l')}) AS myHands
           FROM room_players rp JOIN rooms r ON r.id = rp.room_id
           WHERE rp.user_id = ? ${whereSql}
         ) t`,
      )
      .get(req.userId) as { hands: number; net: number };
    const rows = db
      .prepare(
        `SELECT r.id AS roomId, r.name, r.sb, r.bb, r.created_at AS createdAt,
                r.host_id AS hostId, COALESCE(hu.display_name, hu.username) AS hostName,
                r.archived, r.archived_at AS archivedAt, r.archived_at AS closedAt
                  /* closedAt kept for the closing-room consumers; archivedAt is
                     the documented alias. updatedAt is the last money movement
                     in the room, falling back to when it was retired or created,
                     so the history list can sort by real activity. */,
                MAX(
                  COALESCE((SELECT MAX(l2.ts) FROM ledger l2 WHERE l2.room_id = r.id), 0),
                  COALESCE(r.archived_at, 0), r.created_at
                ) AS updatedAt,
                r.deleted, r.voided,
                (SELECT COUNT(*) FROM room_players rp2 WHERE rp2.room_id = r.id
                   AND rp2.user_id NOT IN (SELECT CAST(value AS INTEGER) FROM meta WHERE key='platform_user_id')) AS playerCount,
                (rp.stack - COALESCE((
                  SELECT SUM(l.delta) FROM ledger l
                  WHERE l.room_id = r.id AND l.user_id = rp.user_id
                    AND l.kind IN ('purchase', 'revert')
                ), 0)) AS myNet,
                -- Count settled hands, excluding voided ones. Uses the shared
                -- void correlation helper so this agrees with handStats/HUD.
                -- squid-game rows share the settlement ref but a different
                -- kind, so they never add a count; aborted hands have no
                -- settlement row.
                (SELECT COUNT(DISTINCT l.ref) FROM ledger l
                  WHERE l.room_id = r.id AND l.user_id = rp.user_id
                    AND l.kind = 'hand-settlement' AND l.ref IS NOT NULL
                    AND ${settlementNotVoidedSql('l')}) AS myHands
         FROM room_players rp
         JOIN rooms r ON r.id = rp.room_id
         JOIN users hu ON hu.id = r.host_id
         WHERE rp.user_id = ? ${whereSql}
         -- Product semantics: most recently active room first. The sort must use
         -- the same expression as the updatedAt column (latest ledger movement,
         -- archive or creation), not archived_at/created_at, or a fresh hand on
         -- an old table would sink below idle archived rooms.
         ORDER BY MAX(
           COALESCE((SELECT MAX(l2.ts) FROM ledger l2 WHERE l2.room_id = r.id), 0),
           COALESCE(r.archived_at, 0), r.created_at
         ) DESC, r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(req.userId, limit, offset) as {
      roomId: string;
      name: string;
      sb: number;
      bb: number;
      createdAt: number;
      hostId: number;
      hostName: string;
      archived: number;
      archivedAt: number | null;
      closedAt: number | null;
      updatedAt: number;
      deleted: number;
      voided: number;
      playerCount: number;
      myNet: number;
      myHands: number;
    }[];
    return {
      rooms: rows.map((r) => ({
        ...r,
        archived: !!r.archived,
        archivedAt: r.archivedAt ?? null,
        closedAt: r.closedAt ?? null,
        deleted: !!r.deleted,
        voided: !!r.voided,
        isHost: r.hostId === req.userId,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      totals,
    };
  });

  // Each hand carries YOUR result: net chips from the settlement ledger plus
  // how the hand ended for you (folded and where, showdown, quiet win, sat
  // out). Highly requested by siwans - see docs/FEATURES.md.
  app.get('/api/rooms/:id/hands', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getRoom(db, id)) return reply.code(404).send({ error: 'no such room' });
    if (!isMember(db, id, req.userId)) return reply.code(403).send({ error: 'not a member' });
    // Paginated like /api/me/rooms: transcripts are the largest per-room table,
    // so pagination is validated rather than silently clamped (a bad limit is a
    // client bug and gets a 400). Default 100 keeps the response bounded while
    // covering any realistic session in one page.
    const handsQuerySchema = z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    });
    const parsed = handsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE room_id = ?').get(id) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT t.hand_id as handId, t.head, t.entries, t.ts,
                ${voidHandExistsSql({ roomExpr: 't.room_id', handIdExpr: 't.hand_id', headExpr: 't.head' })} AS voided
         FROM transcripts t WHERE t.room_id = ?
         -- Stable newest-first: multiple hands can share a millisecond, and
         -- without the hand_id tie-breaker OFFSET paging could duplicate or
         -- skip rows when the sort order is not total.
         ORDER BY t.ts DESC, t.hand_id DESC LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset) as { handId: string; head: string; entries: string; ts: number; voided: number }[];
    const nets = new Map(
      (
        db
          .prepare(
            `SELECT ref, SUM(delta) as net FROM ledger
             WHERE room_id = ? AND user_id = ? AND kind IN ('hand-settlement', 'squid-game') GROUP BY ref`,
          )
          .all(id, req.userId) as { ref: string; net: number }[]
      ).map((r) => [r.ref, r.net]),
    );
    const STREETS = ['preflop', 'on the flop', 'on the turn', 'on the river'];
    const hands = rows.map((row) => {
      let outcome = 'played';
      try {
        const entries = JSON.parse(row.entries) as {
          type: string;
          payload: Record<string, unknown>;
        }[];
        const hs = entries.find((e) => e.type === 'hand_start');
        const seats = (hs?.payload?.seats ?? []) as { seat: number; userId: number }[];
        const seat = seats.find((x) => x.userId === req.userId)?.seat;
        if (seat === undefined) {
          outcome = 'sat out';
        } else {
          let street = 0;
          let foldedAt: number | null = null;
          let revealed = false;
          let award = 0;
          let anyReveals = false;
          for (const e of entries) {
            if (e.type === 'street') street++;
            if (e.type === 'action' && (e.payload.seat as number) === seat) {
              const a = e.payload.action as { type: string };
              if (a.type === 'fold') foldedAt = Math.min(street, 3);
            }
            if (e.type === 'settlement') {
              const p = e.payload as {
                awards?: { seat: number; amount: number }[];
                reveals?: { seat: number }[];
              };
              anyReveals = (p.reveals ?? []).length > 0;
              revealed = (p.reveals ?? []).some((r) => r.seat === seat);
              award = (p.awards ?? []).find((a) => a.seat === seat)?.amount ?? 0;
            }
          }
          if (foldedAt !== null) outcome = `folded ${STREETS[foldedAt]}`;
          else if (award > 0 && revealed) outcome = 'won at showdown';
          else if (award > 0 && !anyReveals) outcome = 'won, everyone folded';
          else if (award > 0) outcome = 'won';
          else if (revealed) outcome = 'lost at showdown';
        }
      } catch {
        /* unreadable transcript: keep the neutral label */
      }
      return {
        handId: row.handId,
        head: row.head,
        ts: row.ts,
        myNet: nets.get(row.head) ?? null,
        outcome,
        voided: !!row.voided,
      };
    });
    return { hands, total, limit, offset };
  });

  app.get('/api/rooms/:id/hands/:handId', authed, async (req, reply) => {
    const { id, handId } = req.params as { id: string; handId: string };
    if (!getRoom(db, id)) return reply.code(404).send({ error: 'no such room' });
    if (!isMember(db, id, req.userId)) return reply.code(403).send({ error: 'not a member' });
    const row = db
      .prepare(
        'SELECT hand_id as handId, head, entries, ts FROM transcripts WHERE room_id = ? AND hand_id = ?',
      )
      .get(id, handId) as { handId: string; head: string; entries: string; ts: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such hand' });
    return { handId: row.handId, head: row.head, ts: row.ts, entries: JSON.parse(row.entries) };
  });

  app.get('/api/rooms/:id/ledger', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (!isMember(db, id, req.userId)) return reply.code(403).send({ error: 'not a member' });
    const entries = db
      .prepare(
        `SELECT l.id, l.user_id as userId, u.username, l.delta, l.kind, l.approved_by as approvedBy,
                l.note, l.ref, l.ts, l.prev_hash as prevHash, l.entry_hash as entryHash
         FROM ledger l JOIN users u ON u.id = l.user_id WHERE l.room_id = ? ORDER BY l.id`,
      )
      .all(id);
    return { entries, verified: verifyLedger(db, id) };
  });

  const featureTriggerSchema = z.object({
    feature: z.enum(['squid', 'bomb']),
    requestId: z
      .union([z.string().trim().min(1).max(128), z.number().int().nonnegative()])
      .transform(String),
  });

  /**
   * Host asks for squid/bomb to run on the next hand. Idempotent by
   * `(room, requestId)`: a retried request returns the row it originally
   * created, while reusing an id for a different feature is a 409 instead of a
   * silent mix-up.
   */
  app.post('/api/rooms/:id/feature-triggers', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = featureTriggerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.host_id !== req.userId) return reply.code(403).send({ error: 'host only' });
    if (room.archived || room.deleted)
      return reply.code(409).send({ error: 'this table is closed' });
    const { feature, requestId } = parsed.data;
    if (feature === 'squid' && !room.squid_enabled)
      return reply.code(400).send({ error: 'squid game is not enabled for this table' });
    if (feature === 'bomb' && !room.bomb_pot_enabled)
      return reply.code(400).send({ error: 'bomb pot is not enabled for this table' });
    if (activeHands.has(id))
      return reply.code(409).send({ error: 'wait for the current hand to finish' });

    const existing = db
      .prepare('SELECT * FROM room_feature_triggers WHERE room_id = ? AND request_id = ?')
      .get(id, requestId) as FeatureTriggerRow | undefined;
    if (existing) {
      if (existing.kind !== feature)
        return reply
          .code(409)
          .send({ error: 'that request id was already used for a different feature' });
      return { trigger: featureTriggerJson(existing), duplicate: true };
    }

    // Squid only bites when enough people were dealt in; bomb pot has no such
    // gate (it hitches a ride on whatever hand is dealt).
    if (feature === 'squid') {
      const { n } = db
        .prepare(
          `SELECT COUNT(*) as n FROM room_players rp
           WHERE rp.room_id = ? AND rp.sitting_out = 0
             AND rp.user_id NOT IN (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'platform_user_id')`,
        )
        .get(id) as { n: number };
      if (n < room.squid_min_players)
        return reply
          .code(400)
          .send({ error: `squid game needs at least ${room.squid_min_players} players` });
    }

    const pending = db
      .prepare(
        "SELECT 1 FROM room_feature_triggers WHERE room_id = ? AND kind = ? AND status = 'pending'",
      )
      .get(id, feature);
    if (pending)
      return reply.code(409).send({ error: `a ${feature} trigger is already pending` });

    const info = db
      .prepare(
        `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, requested_by, created_at)
         VALUES (?, ?, ?, 'manual', 'pending', ?, ?)`,
      )
      .run(id, requestId, feature, req.userId, Date.now());
    const row = db
      .prepare('SELECT * FROM room_feature_triggers WHERE id = ?')
      .get(info.lastInsertRowid) as FeatureTriggerRow;
    roomEvents.emit('changed', id);
    return { trigger: featureTriggerJson(row) };
  });

  /** Host cancels their own not-yet-claimed manual trigger. */
  app.delete('/api/rooms/:id/feature-triggers/:requestId', authed, async (req, reply) => {
    const { id, requestId } = req.params as { id: string; requestId: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.host_id !== req.userId) return reply.code(403).send({ error: 'host only' });
    const row = db
      .prepare(
        "SELECT * FROM room_feature_triggers WHERE room_id = ? AND request_id = ? AND status = 'pending'",
      )
      .get(id, requestId) as FeatureTriggerRow | undefined;
    if (!row) return reply.code(404).send({ error: 'no such pending trigger' });
    if (row.source !== 'manual')
      return reply.code(400).send({ error: 'only manual triggers can be cancelled' });
    db.prepare("UPDATE room_feature_triggers SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(
      Date.now(),
      row.id,
    );
    roomEvents.emit('changed', id);
    return { ok: true };
  });
}
