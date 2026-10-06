import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { requireUser } from './auth.js';
import { rateLimit } from './limits.js';
import { houseDues, platformDues } from './house.js';
import { isPlatform } from './platform.js';

/** Settling up, made obvious (requested by notpritam, docs/FEATURES.md).
 *
 *  Three things live here:
 *
 *  1. One line per person, netted across every room. You do not owe someone
 *     three separate amounts because you played three tables with them; you owe
 *     them one number.
 *  2. Payment redirects. If Ann owes you 500 and you owe Bob 400, the money does
 *     not need to move twice - Ann can pay Bob directly and two debts close at
 *     once. Only debts YOU are part of are ever used to build a suggestion, so
 *     this never reveals a position you could not already see.
 *  3. House dues: your share of the table commission, which is what keeps the
 *     servers running. Derived from the ledger rather than stored, so it can
 *     never drift from what actually happened at the table. */

const MAX_PROOF_BYTES = 700_000;

export interface NetLine {
  otherUserId: number;
  otherName: string;
  otherAvatarVersion: number;
  /** Positive: they owe you. Negative: you owe them. */
  net: number;
  rooms: {
    roomId: string;
    roomName: string;
    amount: number;
    direction: 'owe' | 'owed';
    settlementId?: number;
  }[];
}

/** Decodes a `data:` URL into bytes, refusing anything that is not a small image. */
function decodeProof(dataUrl: string): { bytes: Buffer; mime: string } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:')) return null;
  const meta = dataUrl.slice(0, comma);
  if (!meta.endsWith(';base64')) return null;
  const mime = meta.slice(5, meta.indexOf(';'));
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PROOF_BYTES) return null;
  // trust the bytes, not the label the client attached to them
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isWebp =
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;
  return { bytes, mime };
}

export function registerSettleRoutes(
  app: FastifyInstance,
  db: DB,
  helpers: {
    roomDebts: (roomId: string) => { from: number; to: number; amount: number }[];
    settledSum: (roomId: string, debtor: number, creditor: number) => number;
    pairOf: (a: number, b: number) => [number, number];
  },
): void {
  const authed = { preHandler: requireUser(db) };
  const { roomDebts, settledSum, pairOf } = helpers;

  /** Every open debt this user is part of, one entry per room. */
  function openDebts(userId: number) {
    const rooms = db
      .prepare(
        `SELECT r.id, r.name FROM rooms r JOIN room_players rp ON rp.room_id = r.id
         WHERE rp.user_id = ? AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0
         ORDER BY r.created_at DESC`,
      )
      .all(userId) as { id: string; name: string }[];
    const out: { roomId: string; roomName: string; other: number; amount: number; iOwe: boolean; settlementId?: number }[] =
      [];
    for (const room of rooms) {
      for (const d of roomDebts(room.id)) {
        if (d.from !== userId && d.to !== userId) continue;
        const outstanding = d.amount - settledSum(room.id, d.from, d.to);
        if (outstanding <= 0) continue;
        const other = d.from === userId ? d.to : d.from;
        const [low, high] = pairOf(userId, other);
        const open = db
          .prepare(
            'SELECT id FROM settlements WHERE room_id = ? AND low_user = ? AND high_user = ? AND settled_ts IS NULL',
          )
          .get(room.id, low, high) as { id: number } | undefined;
        out.push({
          roomId: room.id,
          roomName: room.name,
          other: d.from === userId ? d.to : d.from,
          amount: outstanding,
          iOwe: d.from === userId,
          ...(open ? { settlementId: open.id } : {}),
        });
      }
    }
    return out;
  }

  const nameStmt = db.prepare(
    'SELECT COALESCE(display_name, username) as name, avatar_version as avatarVersion FROM users WHERE id = ?',
  );

  /** One line per person, plus the redirects that would close two debts at once. */
  app.get('/api/me/settle', authed, async (req) => {
    const debts = openDebts(req.userId);

    const byPerson = new Map<number, NetLine>();
    for (const d of debts) {
      let line = byPerson.get(d.other);
      if (!line) {
        const info = nameStmt.get(d.other) as { name: string; avatarVersion: number };
        line = {
          otherUserId: d.other,
          otherName: info?.name ?? 'unknown',
          otherAvatarVersion: info?.avatarVersion ?? 0,
          net: 0,
          rooms: [],
        };
        byPerson.set(d.other, line);
      }
      line.net += d.iOwe ? -d.amount : d.amount;
      line.rooms.push({
        roomId: d.roomId,
        roomName: d.roomName,
        amount: d.amount,
        direction: d.iOwe ? 'owe' : 'owed',
        ...(d.settlementId ? { settlementId: d.settlementId } : {}),
      });
    }
    const people = [...byPerson.values()].sort((a, b) => a.net - b.net);

    // Everyone whose net is against me, matched largest-first against everyone
    // whose net is toward me. Each pairing is one payment that never has to pass
    // through my hands at all.
    const iOwe = people
      .filter((p) => p.net < 0)
      .map((p) => ({ ...p, left: -p.net }))
      .sort((a, b) => b.left - a.left);
    const owedToMe = people
      .filter((p) => p.net > 0)
      .map((p) => ({ ...p, left: p.net }))
      .sort((a, b) => b.left - a.left);

    const redirects: {
      payerUserId: number;
      payerName: string;
      payeeUserId: number;
      payeeName: string;
      amount: number;
    }[] = [];
    let i = 0;
    let j = 0;
    while (i < owedToMe.length && j < iOwe.length) {
      const amount = Math.min(owedToMe[i]!.left, iOwe[j]!.left);
      if (amount > 0) {
        redirects.push({
          payerUserId: owedToMe[i]!.otherUserId,
          payerName: owedToMe[i]!.otherName,
          payeeUserId: iOwe[j]!.otherUserId,
          payeeName: iOwe[j]!.otherName,
          amount,
        });
      }
      owedToMe[i]!.left -= amount;
      iOwe[j]!.left -= amount;
      if (owedToMe[i]!.left === 0) i++;
      if (iOwe[j]!.left === 0) j++;
    }

    const totalOwed = people.reduce((s, p) => s + (p.net > 0 ? p.net : 0), 0);
    const totalOwe = people.reduce((s, p) => s + (p.net < 0 ? -p.net : 0), 0);
    const settled = db
      .prepare(
        `SELECT s.id as settlementId, s.amount, s.debtor, s.settled_ts as settledTs,
                CASE WHEN s.low_user = ? THEN s.high_user ELSE s.low_user END as otherUserId,
                COALESCE(u.display_name, u.username) as otherName
         FROM settlements s JOIN users u ON u.id = CASE WHEN s.low_user = ? THEN s.high_user ELSE s.low_user END
         WHERE s.settled_ts IS NOT NULL AND (s.low_user = ? OR s.high_user = ?)
         ORDER BY s.settled_ts DESC LIMIT 20`,
      )
      .all(req.userId, req.userId, req.userId, req.userId) as {
      settlementId: number;
      amount: number;
      debtor: number;
      settledTs: number;
      otherUserId: number;
      otherName: string;
    }[];

    return {
      people,
      redirects,
      totals: { owedToMe: totalOwed, iOwe: totalOwe, net: totalOwed - totalOwe },
      settled,
      house: houseDues(db, req.userId),
      ...(isPlatform(db, req.userId) ? { platformHouse: platformDues(db) } : {}),
    };
  });

  /** Everything waiting on this user, for the pending-tasks nudge. */
  app.get('/api/me/pending', authed, async (req) => {
    const debts = openDebts(req.userId);
    // settlements the other side has already confirmed and I have not
    const awaitingMe = db
      .prepare(
        `SELECT COUNT(*) as n FROM settlements
         WHERE settled_ts IS NULL AND ((low_user = ? AND confirmed_high = 1 AND confirmed_low = 0)
                                    OR (high_user = ? AND confirmed_low = 1 AND confirmed_high = 0))`,
      )
      .get(req.userId, req.userId) as { n: number };
    // A closed/archived table can no longer be joined, so a pending invite to
    // one must not keep the sidebar badge lit. Same filter as GET /api/invites.
    const invites = db
      .prepare(
        `SELECT COUNT(*) as n FROM invites i JOIN rooms r ON r.id = i.room_id
         WHERE i.to_id = ? AND i.status = 'pending'
           AND r.archived = 0 AND r.deleted = 0`,
      )
      .get(req.userId) as { n: number };
    const friendRequests = db
      .prepare("SELECT COUNT(*) as n FROM friends WHERE target_id = ? AND status = 'pending'")
      .get(req.userId) as { n: number };
    const house = houseDues(db, req.userId);
    return {
      settlementsAwaitingMe: awaitingMe.n,
      openDebts: debts.length,
      iOweCount: debts.filter((d) => d.iOwe).length,
      invites: invites.n,
      friendRequests: friendRequests.n,
      houseOutstanding: house.outstanding,
    };
  });

  /** The remark (and optional photo) one side attached when marking settled. */
  app.get('/api/settlements/:id/marks', authed, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const row = db
      .prepare('SELECT low_user as low, high_user as high FROM settlements WHERE id = ?')
      .get(id) as { low: number; high: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such settlement' });
    if (req.userId !== row.low && req.userId !== row.high)
      return reply.code(403).send({ error: 'not your settlement' });
    // Only the two parties to this settlement. A stray or historical third-party
    // mark must never surface here, or the client would offer its note - and its
    // userId - to a side that has no business seeing either.
    const marks = db
      .prepare(
        `SELECT m.user_id as userId, COALESCE(u.display_name, u.username) as name, m.note,
                m.proof IS NOT NULL as hasProof, m.ts
         FROM settlement_marks m JOIN users u ON u.id = m.user_id
         WHERE m.settlement_id = ? AND m.user_id IN (?, ?) ORDER BY m.ts`,
      )
      .all(id, row.low, row.high) as { userId: number; name: string; note: string | null; hasProof: number; ts: number }[];
    return { marks: marks.map((m) => ({ ...m, hasProof: !!m.hasProof })) };
  });

  app.get('/api/settlements/:id/proof/:userId', authed, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const row = db
      .prepare('SELECT low_user as low, high_user as high FROM settlements WHERE id = ?')
      .get(Number(id)) as { low: number; high: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such settlement' });
    if (req.userId !== row.low && req.userId !== row.high)
      return reply.code(403).send({ error: 'not your settlement' });
    // The requester being a party is not enough: the target of the URL must be a
    // party too. Otherwise one side could read any third-party mark that happens
    // to exist on this settlement. A proof is private data; do not rely on the
    // database never containing a mark outside the pair.
    const target = Number(userId);
    if (target !== row.low && target !== row.high)
      return reply.code(404).send({ error: 'no photo' });
    const mark = db
      .prepare('SELECT proof, proof_mime as mime FROM settlement_marks WHERE settlement_id = ? AND user_id = ?')
      .get(Number(id), target) as { proof: Buffer | null; mime: string | null } | undefined;
    if (!mark?.proof) return reply.code(404).send({ error: 'no photo' });
    return reply
      .header('content-type', mark.mime ?? 'image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .send(mark.proof);
  });

  /** Record a payment toward the house. Kept separate from room chips: this is
   *  real money for the servers, not a stack at a table. */
  app.post(
    '/api/house/pay',
    { preHandler: [requireUser(db), rateLimit({ name: 'house-pay', limit: 20, windowMs: 60 * 60_000, by: 'user' })] },
    async (req, reply) => {
      const parsed = z
        .object({
          amount: z.number().int().positive().max(10_000_000),
          note: z.string().max(300).optional(),
          proof: z.string().max(1_000_000).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
      let bytes: Buffer | null = null;
      let mime: string | null = null;
      if (parsed.data.proof) {
        const decoded = decodeProof(parsed.data.proof);
        if (!decoded) return reply.code(400).send({ error: 'that photo is not a usable image' });
        bytes = decoded.bytes;
        mime = decoded.mime;
      }
      db.prepare(
        'INSERT INTO house_payments (user_id, amount, note, proof, proof_mime, ts) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(req.userId, parsed.data.amount, parsed.data.note ?? null, bytes, mime, Date.now());
      return { ok: true, house: houseDues(db, req.userId) };
    },
  );

  app.get('/api/me/house', authed, async (req) => {
    const payments = db
      .prepare(
        'SELECT id, amount, note, confirmed, ts FROM house_payments WHERE user_id = ? ORDER BY ts DESC LIMIT 50',
      )
      .all(req.userId);
    return { ...houseDues(db, req.userId), payments };
  });

  return;
}

export { decodeProof };
