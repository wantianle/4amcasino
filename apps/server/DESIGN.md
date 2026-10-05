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

## `(room_id, head)` unique-index preflight runbook

`migrateHandStats` (`handProjection.ts`) installs two unique indexes that the
void-hand OR-correlation depends on: `idx_transcripts_room_head` and
`idx_hand_settlements_room_head`, both on `(room_id, head)`. Before creating
them it runs the fail-closed `assertUniqueRoomHead` scan. The indexes are the
migration marker: once both exist the scan is skipped on later startups.

**Startup failure signal.** If legacy data violates the invariant, startup aborts
with a thrown `Error` whose message is:

```
migrateHandStats: <table> has <N> duplicate (room_id, head) group(s); void-hand
correlation is ambiguous and the audit rows must be reconciled (never
auto-deduped). First <shown>: room=<roomId> head=<head> rows=<n>; ...
```

`<table>` is `transcripts` or `hand_settlements` (the scan stops at the first
offending table). Up to 20 groups are listed in `First ...`, largest-group-first
(`ORDER BY n DESC, room_id, head`), each group's exact off-island handle spelled
as `room` / `head` / `rows`. Treat the message as read-only diagnostic output:
it is emitted before SQLite is ever asked for the index, so there is no
`UNIQUE constraint failed`, and nothing was changed.

**Locate the offending rows.** Using the `room`/`head`/`rows` triple from the
log:

```sql
-- transcripts side
SELECT rowid, hand_id, room_id, head, ts
FROM transcripts WHERE room_id = ? AND head = ? ORDER BY ts, rowid;
-- settlements side
SELECT rowid, hand_id, room_id, head, applied_at AS ts
FROM hand_settlements WHERE room_id = ? AND head = ? ORDER BY applied_at, rowid;
```

`rows=<n>` tells you how many rows share that `(room_id, head)`. A `head` is the
hand's committed head; each `(room_id, head)` must map to exactly one `hand_id`.

**Manually reconcile against the ledger.** The ledger is the money source of
truth; use it to decide which audited row is the genuine hand and which is a
replayed/duplicated write:

```sql
SELECT id, user_id, delta, kind, ref, ts
FROM ledger WHERE room_id = ? AND ref = ? ORDER BY id;
```

Cross-check the candidate `hand_id`s: a real `hand-settlement` (or `void-hand`)
ledger row's `ref` matches either the settlement's `head` or the hand's
`hand_id`. The duplicate row that has no matching settlement leg, or whose
`hand_id` was never actually dealt, is the spurious one. If both candidates
correlate to real ledger rows, the ambiguity is real — stop and escalate rather
than guessing.

**When repair is allowed.** Only a human operator, after the ledger/transcript
correlation above, may repair the audit rows. Repair means removing or
re-pointing the *single* spurious row, never bulk deduplication and never
rewriting money. Before touching anything, back up the DB file and wrap the fix
in a transaction:

```sql
BEGIN;
-- example: drop the one replayed transcript that has no matching ledger leg
DELETE FROM transcripts WHERE rowid = ?;
COMMIT;
```

Delete rows only when you can name the spurious one with evidence; when in doubt,
leave the data untouched — the server fails closed on every restart by design.

**Restart and verify both indexes.** After the repair, restart the server so
`migrateHandStats` re-runs. The preflight now passes and both indexes are
created. Verify directly:

```sql
SELECT name FROM sqlite_master
WHERE type = 'index' AND name IN
  ('idx_transcripts_room_head', 'idx_hand_settlements_room_head');
```

Both names must be present, and the startup log must show no
`migrateHandStats: ... duplicate ...` line. If only one exists, a second
offending table was hidden behind the first — fix it the same way and restart
again.
