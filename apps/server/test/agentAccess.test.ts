import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { resolveAgentGrant, agentMaySend } from '../src/agentAccess.js';
import { attachHub } from '../src/hub.js';
import WebSocket from 'ws';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
let ctx: ReturnType<typeof createApp>;
let token: string;
let uid: number;
let room: string;
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
beforeEach(async () => {
  ctx = createApp(':memory:');
  attachHub(ctx.app, ctx.db);
  uid = createUser(ctx.db, 'agent_owner', 'a'.repeat(64), 'b'.repeat(64)).userId;
  token = createSession(ctx.db, uid);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Agent room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});
afterEach(async () => ctx.app.close());
/** Mint a grant row the way the bot runner does: only the token hash is stored. */
function grant(canPlay = true) {
  const id = randomBytes(12).toString('hex');
  const grantToken = `4am_agent_${randomBytes(32).toString('hex')}`;
  ctx.db
    .prepare(
      'INSERT INTO agent_grants(id,user_id,token_hash,label,scope_kind,scope_id,can_play,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      uid,
      tokenHash(grantToken),
      'Local agent',
      'room',
      room,
      Number(canPlay),
      Date.now(),
      Date.now() + 86400_000,
    );
  return { id, token: grantToken };
}
it('stores only a token hash and denies account/bank access', async () => {
  const g = grant();
  const row = ctx.db.prepare('SELECT * FROM agent_grants').get();
  expect(JSON.stringify(row)).not.toContain(g.token);
  expect(resolveAgentGrant(ctx.db, g.token)?.scope_id).toBe(room);
  const res = await ctx.app.inject({
    url: '/api/me',
    headers: { authorization: `Bearer ${g.token}` },
  });
  expect(res.statusCode).toBe(401);
  expect(agentMaySend(resolveAgentGrant(ctx.db, g.token)!, { t: 'action' })).toBe(true);
  // a bot is a player: it may answer a paid peek like anyone else
  expect(agentMaySend(resolveAgentGrant(ctx.db, g.token)!, { t: 'peek_accept' })).toBe(true);
  expect(agentMaySend(resolveAgentGrant(ctx.db, g.token)!, { t: 'peek_decline' })).toBe(true);
  expect(agentMaySend(resolveAgentGrant(ctx.db, g.token)!, { t: 'kick' })).toBe(false);
  const read = grant(false);
  expect(agentMaySend(resolveAgentGrant(ctx.db, read.token)!, { t: 'action' })).toBe(false);
});
it('denies read-only gameplay sockets and disconnects a revoked playing grant', async () => {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/ws`;
  const read = grant(false);
  const denied = new WebSocket(url, ['bearer', read.token]);
  const failure = await new Promise<Error>((resolve) => denied.once('error', resolve));
  expect(failure.message).toContain('403');
  const play = grant(true);
  const socket = new WebSocket(url, ['bearer', play.token]);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  ctx.db.prepare('UPDATE agent_grants SET revoked_at = ? WHERE id = ?').run(Date.now(), play.id);
  expect((await closed)[0]).toBe(1008);
});
it('revokes access immediately, including membership and expiry', async () => {
  const g = grant();
  ctx.db.prepare('UPDATE agent_grants SET revoked_at = ? WHERE id = ?').run(Date.now(), g.id);
  expect(resolveAgentGrant(ctx.db, g.token)).toBeNull();
  const expired = grant();
  ctx.db.prepare('UPDATE agent_grants SET expires_at = 0 WHERE id = ?').run(expired.id);
  expect(resolveAgentGrant(ctx.db, expired.token)).toBeNull();
  const member = grant();
  ctx.db.prepare('DELETE FROM room_players WHERE room_id = ? AND user_id = ?').run(room, uid);
  expect(resolveAgentGrant(ctx.db, member.token)).toBeNull();
});
