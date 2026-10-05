# `@4am/server` design notes

## Bot runner deployment boundary

The LLM bot runner is **not a standalone service**: it is co-located with the
game engine and shares its process, SQLite DB and in-memory hand set.

- **Same process as the engine.** `BotSupervisor` → `BotRunner` → `HeadlessClient`
  talk to the engine over a loopback WebSocket, and `BotRunner.serverHandActive()`
  reads the engine's in-process `activeHands` set. There is no out-of-process
  runner.
- **Single instance only.** Do not run multiple server replicas serving the same
  room/DB. The `starting → running` claim (`claimStartingBot`) is a one-shot CAS
  that assumes exactly one owner, and per-room hand state lives in process
  memory.
- **Sticky WebSockets required.** A client (human or bot) must reconnect to the
  *same* instance that owns the room. There is no cross-instance session or
  hand-context handoff.
- **No mixed-version rooms.** Client and server versions must match within a
  room. Protocol boundary: `betting_state.actionSeq` is **required** and always
  sent (pre-existing), while `action_applied.actionSeq` is the only optional
  add-on (with a `localActionOrdinal` fallback). A same-version client/server is
  assumed; do not mix releases in one room.
- **Upgrade = drain, then restart.** Stop accepting new starts (the
  `isShuttingDown` gate returns 503), let running bots wind down gracefully
  (`stopAll`: runners fold on their turn and wait for the current hand to settle;
  the grant is revoked only after `done`), then restart. Do not rolling-restart
  while hands are live.

## Reconnect / resync semantics (client)

`HeadlessClient.isResynced` is the single decision gate. It requires:

1. a usable connection (`connected`, current socket identity), and
2. this connection epoch's `room_state` snapshot, and
3. when that snapshot reports a live hand, an authoritative frame for **that**
   hand (`hand_start`, a crypto frame, `multi_run_offer`/`need_keys`, or a
   `betting_state`) — a bare `room_state` is not enough, and only a real
   `betting_state` rebuilds a decidable turn.

Frames are validated by socket identity (superseded sockets are ignored),
by the current connection epoch, and by hand identity (a stale previous-hand
frame neither opens the gate nor mutates cached state). A resync that reports no
live hand clears the stale hand snapshot and opens the gate.
