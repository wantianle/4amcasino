import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

async function user(name: string) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const get = (url: string, token: string) =>
  ctx.app.inject({ method: 'GET', url, headers: auth(token) });

// Smallest plausible PNG header; the read path never decodes it, it only checks
// that the column is non-null and echoes the stored bytes back.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function seed(opts: {
  low: number;
  high: number;
  debtor: number;
  marks: { userId: number; note?: string; proof?: Buffer }[];
}): number {
  const info = ctx.db
    .prepare(
      `INSERT INTO settlements (room_id, low_user, high_user, amount, debtor, confirmed_low, confirmed_high, created_ts)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
    )
    .run('room-proof', opts.low, opts.high, 250, opts.debtor, Date.now());
  const id = Number(info.lastInsertRowid);
  const ins = ctx.db.prepare(
    'INSERT INTO settlement_marks (settlement_id, user_id, note, proof, proof_mime, ts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  opts.marks.forEach((m, i) =>
    ins.run(id, m.userId, m.note ?? null, m.proof ?? null, m.proof ? 'image/png' : null, i + 1),
  );
  return id;
}

describe('settlement proof access', () => {
  it('serves a party their own proof, and 404s when they have none', async () => {
    const a = await user('proof_a1');
    const b = await user('proof_b1');
    const id = seed({
      low: a.userId,
      high: b.userId,
      debtor: a.userId,
      marks: [{ userId: a.userId, note: 'sent', proof: PNG }],
    });
    const own = await get(`/api/settlements/${id}/proof/${a.userId}`, a.token);
    expect(own.statusCode).toBe(200);
    expect(String(own.headers['content-type'])).toContain('image/png');
    expect(Buffer.compare(own.rawPayload, PNG)).toBe(0);
    const none = await get(`/api/settlements/${id}/proof/${b.userId}`, a.token);
    expect(none.statusCode).toBe(404);
  });

  it('404s when a party targets a third-party mark on the settlement', async () => {
    const a = await user('proof_a2');
    const b = await user('proof_b2');
    const c = await user('proof_c2');
    const id = seed({
      low: a.userId,
      high: b.userId,
      debtor: a.userId,
      marks: [
        { userId: a.userId, note: 'mine', proof: PNG },
        { userId: c.userId, note: 'intruder', proof: PNG },
      ],
    });
    // Would have been 200 image/png before the target check; the third party is
    // not a side of this settlement, so their proof must not be reachable.
    const leaked = await get(`/api/settlements/${id}/proof/${c.userId}`, a.token);
    expect(leaked.statusCode).toBe(404);
    // Both genuine sides remain reachable.
    expect((await get(`/api/settlements/${id}/proof/${a.userId}`, a.token)).statusCode).toBe(200);
    expect((await get(`/api/settlements/${id}/proof/${b.userId}`, a.token)).statusCode).toBe(404);
  });

  it('403s when a non-party requests any proof', async () => {
    const a = await user('proof_a3');
    const b = await user('proof_b3');
    const c = await user('proof_c3');
    const id = seed({
      low: a.userId,
      high: b.userId,
      debtor: a.userId,
      marks: [{ userId: a.userId, proof: PNG }],
    });
    expect((await get(`/api/settlements/${id}/proof/${a.userId}`, c.token)).statusCode).toBe(403);
    expect((await get(`/api/settlements/${id}/proof/${c.userId}`, c.token)).statusCode).toBe(403);
  });

  it('marks only returns the two parties, never a stray third-party mark', async () => {
    const a = await user('proof_a4');
    const b = await user('proof_b4');
    const c = await user('proof_c4');
    const id = seed({
      low: a.userId,
      high: b.userId,
      debtor: a.userId,
      marks: [
        { userId: a.userId, note: 'a note', proof: PNG },
        { userId: b.userId, note: 'b note' },
        { userId: c.userId, note: 'third note', proof: PNG },
      ],
    });
    const res = await get(`/api/settlements/${id}/marks`, a.token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      marks: { userId: number; name: string; note: string | null; hasProof: boolean; ts: number }[];
    };
    expect([...body.marks.map((m) => m.userId)].sort((x, y) => x - y)).toEqual(
      [a.userId, b.userId].sort((x, y) => x - y),
    );
    expect(body.marks.some((m) => m.userId === c.userId)).toBe(false);
    // The {marks:[...]} contract stays intact for the clients that already read it.
    const aMark = body.marks.find((m) => m.userId === a.userId)!;
    expect(aMark.hasProof).toBe(true);
    expect(typeof aMark.name).toBe('string');
    expect(aMark.note).toBe('a note');
    expect(body.marks.find((m) => m.userId === b.userId)!.hasProof).toBe(false);
  });
});
