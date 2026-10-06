import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { clientMsgSchema } from '@4am/shared';
import { genIdentity } from '@4am/mental-poker';
import type { DB } from './db.js';
import { userForToken, touchPresence } from './auth.js';
import { isMember, isSpectator, roomEvents } from './rooms.js';
import { GameRoom, GameError, type GameOpts } from './game.js';
import { LIMITS } from './limits.js';
import { agentMaySend, resolveAgentGrant } from './botAccess.js';
import { readTunable } from './tunables.js';

// 10s per attempt with 3 retries: a stalled player gets a fixed ~40s to rejoin.
// The auto-deal cadence must be short or "auto deal" feels manual, so the hub
// always supplies it rather than relying on the engine's fallback. Both timers
// stay operator-tunable via env (a per-deployment cadence should not need a
// rebuild); they are declared - and parsed - only in `tunables.ts`
// (`FOURAM_AUTO_DEAL_INTERVAL_MS` / `FOURAM_AUTO_DEAL_READY_CHECK_MS`), so the
// `/api/config` table and the room's game options can never drift apart.
export function defaultGameOpts(env: NodeJS.ProcessEnv = process.env): GameOpts {
  return {
    cryptoTimeoutMs: 10_000,
    actionTimeoutMs: 45_000,
    autoDealMs: readTunable('autoDealIntervalMs', env),
    readyCheckMs: readTunable('autoDealReadyCheckMs', env),
  };
}

/** Same-origin only. The game socket carries a session credential, so a page on
 *  any other origin has no business opening one. */
function originAllowed(origin: string | undefined): boolean {
  // No Origin at all means a non-browser client (the bot runner, a script, the
  // tests). Those still need a valid session token, and the header is only
  // meaningful as a defence against a *page* on another origin - which always
  // sends one. Denying here would lock out every non-browser client instead.
  if (!origin) return true;
  if (
    origin === 'https://4amcasino.com' ||
    origin === 'https://www.4amcasino.com' ||
    origin === 'https://admin.4amcasino.com'
  )
    return true;
  const extra = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return (
      host === 'poker.notpritam.in' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      // a house game served off the LAN box
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  } catch {
    return false;
  }
}

export function attachHub(
  app: FastifyInstance,
  db: DB,
  opts: Partial<GameOpts> = {},
): { rooms: Map<string, GameRoom>; serverPublicKey: string } {
  const gameOpts: GameOpts = { ...defaultGameOpts(), ...opts };
  const serverIdentity = genIdentity();
  // ws defaults maxPayload to 100MB; the biggest legitimate message is a 52-card
  // deck at a few KB, and one oversized frame is enough to OOM the instance
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.wsFrameBytes,
    // echo the marker (never the token itself) so the browser sees its offered
    // subprotocol accepted
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });
  const rooms = new Map<string, GameRoom>();
  const socketsPerUser = new Map<number, number>();

  app.server.on('upgrade', (req, socket, head) => {
    // answer with real HTTP before closing, so proxies report 401/404 instead of 502
    const deny = (status: number, label: string) => {
      socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      deny(404, 'Not Found');
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      deny(403, 'Forbidden');
      return;
    }
    // Sec-WebSocket-Protocol keeps the credential out of the request line, which
    // proxies and platform access logs record verbatim. The query parameter is
    // still read so clients mid-deploy keep working.
    const protoHeader = String(req.headers['sec-websocket-protocol'] ?? '');
    const protos = protoHeader.split(',').map((s) => s.trim());
    const fromProto = protos[0] === 'bearer' ? (protos[1] ?? null) : null;
    const token = fromProto ?? url.searchParams.get('token') ?? '';
    const grant = resolveAgentGrant(db, token);
    const userId = grant?.user_id ?? userForToken(db, token);
    if (userId === null) {
      deny(401, 'Unauthorized');
      return;
    }
    if ((socketsPerUser.get(userId) ?? 0) >= 6) {
      deny(429, 'Too Many Requests');
      return;
    }
    if (grant && (grant.scope_kind !== 'room' || !grant.can_play)) {
      deny(403, 'Forbidden');
      return;
    }
    const account = db.prepare('SELECT disabled FROM users WHERE id = ?').get(userId) as
      { disabled: number } | undefined;
    if (!account || account.disabled) {
      deny(401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, userId, token));
  });

  const onRoomChanged = (roomId: string, options?: { restartAutoDeal?: boolean }) =>
    rooms.get(roomId)?.settingsChanged(options?.restartAutoDeal);
  roomEvents.on('changed', onRoomChanged);

  // `preClose`, not `onClose`: Fastify runs `onClose` hooks only AFTER the
  // HTTP server has stopped, and `server.close()` waits for open upgraded
  // websockets - so an `onClose` drain would not run until the very sockets it
  // needs to read are gone (observed as a ~60s stall). `preClose` runs first,
  // while the sockets are still open and the DB is still up.
  app.addHook('preClose', async () => {
    roomEvents.off('changed', onRoomChanged);
    // Drain rooms FIRST, while their sockets are still open, so a live hand can
    // either finish or be aborted into a terminal `hand_lifecycle` state. A
    // `running` row left behind would freeze the room on the next boot.
    //
    // Sequential, not `Promise.all`: `abortForShutdown` temporarily lowers the
    // connection-level `busy_timeout` pragma, and every room shares one SQLite
    // connection. Serializing removes any chance of one room's abort observing
    // another's shortened timeout (or restoring the wrong value). The abort
    // window itself is synchronous, so this is belt-and-braces, but it makes the
    // connection-global mutation provably single-owner. Cost: a deploy's
    // worst-case wait is the SUM over rooms with a live unsettled hand, not the
    // max; each room contributes `shutdownDrainMs + two short DB ops`.
    for (const room of rooms.values()) await room.shutdown();
    // Once every room is terminal, drop the sockets so `server.close()` is not
    // made to wait for clients to hang up; the web app auto-reconnects.
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  function handleConnection(ws: WebSocket, userId: number, token: string): void {
    let current: GameRoom | null = null;
    socketsPerUser.set(userId, (socketsPerUser.get(userId) ?? 0) + 1);
    ws.send(JSON.stringify({ t: 'hello', serverPublicKey: serverIdentity.publicKey }));
    const delegated = token.startsWith('4am_agent_');
    const revokeTimer = delegated
      ? setInterval(() => {
          if (!db.open || !resolveAgentGrant(db, token)) ws.close(1008, 'agent access ended');
        }, 1000)
      : null;
    revokeTimer?.unref();

    // Two buckets, because the two kinds of message have nothing in common.
    //
    // The hand protocol is inherently bursty - dealing one hand fires a key
    // commit, a shuffle, and an unmask share per card per player, all at once -
    // and it is already self-limiting: the engine only accepts a share the hand
    // is actually waiting on. Throttling it by count just breaks the game.
    //
    // The free-form messages are the amplifier: one chat frame fans out to every
    // socket in the room, one rtc frame is relayed verbatim. Those get a tight
    // budget. The wide bucket underneath is only a backstop against a pure flood.
    const PROTOCOL_TYPES = new Set([
      'key_commit',
      'shuffle_deck',
      'unmask_share',
      'action',
      'reveal_key',
      'show_cards',
      'fold_key',
      'rit_vote',
      'run_count_choice',
      'run_count_agree',
      'im_ready',
      'peek_accept',
      'peek_decline',
    ]);
    const bucket = (rate: number) => {
      let tokens = rate;
      let last = Date.now();
      return () => {
        const now = Date.now();
        tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
        last = now;
        if (tokens < 1) return false;
        tokens--;
        return true;
      };
    };
    const takeWide = bucket(300);
    const takeChatty = bucket(LIMITS.wsMessagesPerSec);

    touchPresence(db, userId);
    ws.on('message', (raw) => {
      if (!db.open) return; // shutting down: sockets drain, nothing to do
      if (!takeWide()) {
        ws.close(1008, 'rate limit');
        return;
      }
      touchPresence(db, userId);
      let json: unknown;
      try {
        json = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ t: 'error', message: 'invalid json' }));
        return;
      }
      const parsed = clientMsgSchema.safeParse(json);
      if (!parsed.success) {
        ws.send(JSON.stringify({ t: 'error', message: 'invalid message' }));
        return;
      }
      const msg = parsed.data;
      if (delegated) {
        const grant = resolveAgentGrant(db, token);
        if (!grant) {
          ws.close(1008, 'agent access ended');
          return;
        }
        if (!agentMaySend(grant, msg)) {
          ws.send(
            JSON.stringify({ t: 'error', message: 'Agent token does not permit this command.' }),
          );
          return;
        }
      }
      if (!PROTOCOL_TYPES.has(msg.t) && !takeChatty()) {
        ws.send(JSON.stringify({ t: 'error', message: 'slow down' }));
        return;
      }
      if (msg.t === 'join_room') {
        if (!isMember(db, msg.roomId, userId) && !isSpectator(db, msg.roomId, userId)) {
          ws.send(JSON.stringify({ t: 'error', message: 'not a member of that room' }));
          return;
        }
        current?.leave(userId, ws);
        let room = rooms.get(msg.roomId);
        if (!room) {
          room = new GameRoom(db, msg.roomId, serverIdentity, gameOpts);
          rooms.set(msg.roomId, room);
        }
        current = room;
        room.join(userId, ws, msg.resumeHandId);
        return;
      }
      if (!current) {
        ws.send(JSON.stringify({ t: 'error', message: 'join a room first' }));
        return;
      }
      // A single failing command must never take down the socket loop or the
      // process. Settlement/db failures are isolated inside the room, but this
      // is the last backstop for anything that still escapes.
      try {
        current.handleMessage(userId, msg);
      } catch (err) {
        // A GameError is a known, expected business failure: answer the client
        // and leave the room healthy. Anything else (TypeError, ...) is a
        // programming error - log it, fail the room closed, and never pretend
        // it was an ordinary client error.
        if (err instanceof GameError) {
          try {
            ws.send(JSON.stringify({ t: 'error', message: err.message }));
          } catch {
            /* socket already gone; nothing more to do */
          }
          return;
        }
        console.error('room message handler failed (unexpected)', err);
        current.markUnhealthy(err instanceof Error ? err.message : String(err));
        try {
          ws.send(JSON.stringify({ t: 'error', message: 'server error handling that command' }));
        } catch {
          /* socket already gone; nothing more to do */
        }
      }
    });

    ws.on('close', () => {
      if (revokeTimer) clearInterval(revokeTimer);
      // Late close events can follow the database's onClose hook. Shutdown already
      // clears the room timers; there is no hand or presence left to reconcile.
      if (db.open) current?.leave(userId, ws);
      const left = (socketsPerUser.get(userId) ?? 1) - 1;
      if (left <= 0) socketsPerUser.delete(userId);
      else socketsPerUser.set(userId, left);
      // a room with nobody in it and no hand running holds timers and per-hand
      // maps alive for the life of the process; let it go. `isIdle()` proves
      // `hand === null`, so `shutdown()` completes synchronously here and the
      // promise is already resolved; `void` makes that explicit.
      if (current && current.isIdle()) {
        for (const [id, room] of rooms) {
          if (room === current) {
            void room.shutdown();
            rooms.delete(id);
            break;
          }
        }
      }
    });
  }

  return { rooms, serverPublicKey: serverIdentity.publicKey };
}
