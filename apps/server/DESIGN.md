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

## Peek (paid card look) house rules

A peek is a paid request to privately see an opponent's cards from the hand that
just ended. The rules are server-authoritative and enforced in
`GameRoom.onPeekOffer` / `onPeekAnswer`:

- **Fixed price, 1bb.** The server charges `room.bb` from the requester to the
  player being looked at ("the target"). A client-supplied `amount` on
  `peek_offer` is accepted for wire compatibility but is ignored — old clients
  that send a number are not trusted. `peek_result.amount` echoes the fixed 1bb.
- **Heads-up, fold-decided only.** A peek is offered only when the last hand was
  exactly two players (`ShowSnapshot.bySeat.size === 2`) and ended by a fold
  (`ShowSnapshot.endedByFold`, i.e. `betting.winnerByFold !== null`). A ring hand
  or a hand decided at showdown has no hidden cards left to sell; those requests
  are rejected with an error.
- **Mutual consent, ledger transfer.** The target must accept (signed
  `peek_accept` with unmask shares verified against the finished hand's snapshot);
  only then does the 1bb move, through two `kind: 'peek'` ledger rows that net to
  zero. Declining sends `peek_result` with `status: 'declined'` and moves nothing.
- **Bots are players.** A bot's agent grant may send `peek_accept`/`peek_decline`
  (`agentAccess.ts` `PLAY_MESSAGES`). `HeadlessClient` auto-accepts any offer for
  its recent hand, signing against the offer's own `handId`.
- **Both sides get a terminal signal.** `peek_result` (carrying the reveal on
  acceptance) goes to the requester. The target gets a narrow
  `peek_offer_closed` (`offerId`, `handId`, `targetSeat`, `status`) on every
  terminal outcome — accepted / declined / expired / failed — so its pending
  banner closes in sync with the requester's result instead of on a client-side
  timeout. The target frame deliberately omits `cards` and `amount`: the target
  already has the price from `peek_offer` and the reveal is the buyer's to see,
  so it can never leak buyer-only information. A bot may ignore the frame.
- **Reconnect-safe clearing.** `peek_offer_closed` is a one-shot unicast: if the
  target's socket is gone when the offer resolves (TTL, next hand, or a
  room/process shutdown), the frame is dropped and not replayed, which would
  strand a banner. On every `join` the server therefore sends the target a
  `peek_offers_snapshot` listing the **still-open incoming** offer ids; the
  client keeps those and drops every other pending banner (an empty list clears
  them all). It is ids only - no `cards`/`amount`/`fromUserId`/failure reason -
  and it says nothing about the user's own outgoing offers. Offers are never
  persisted, so after a process restart the snapshot is simply empty, which is
  the correct signal (a 5s offer cannot survive a restart). No closure journal
  and no DB writes are needed: the snapshot is the single authority.

### Front-end contract (web lane)

The web lane owns the client presentation. The server contract it must render:

1. **Fixed price.** A peek always costs `bb` (server-fixed, `peek_result.amount`
   echoes it). Do not offer an editable amount and do not subtract anything
   client-side from `showdown`/`hand_end`; the server moves the chips.
2. **Server-owned 5s window.** The offer lapses `PEEK_OFFER_TTL_MS` (5s) after
   `peek_offer`, *server-side*, and the server sends the terminal
   `peek_result`. Do **not** run an independent client-side timeout as the source
   of truth; treat a local timer only as cosmetic. A target who disconnects or
   ignores the frame can never leave the requester waiting. The same terminal
   outcome is pushed to the **target** as `peek_offer_closed`, so the target
   closes its banner on the server signal (all four statuses), not on a timer.
3. **Four terminal states.** `peek_result.status` is one of:
   - `'accepted'` — reveal the target's two cards (buyer only) for ~3s;
   - `'declined'` — the target refused; close the request UI;
   - `'expired'` — the 5s window (or the next hand) ended it; close the request UI
     and, on the **target** side, withdraw the pending offer too (its
     `peek_offer_closed` carries `'expired'`); a reconnect reconciles against
     `peek_offers_snapshot` and drops it even if the closure was missed;
   - `'failed'` — bad signature/shares, the buyer can no longer pay, or a new
     hand already started. This is terminal and must never be rendered as a
     decline.
   A client-side `expired`/`failed` must both be explicit; do not collapse them
   into "declined".

## Showdown / settlement timing

The ordering contract is **durable write → reveal → hold → `hand_end`**:

1. `Hand.settle()` computes the outcome once (pot/rake/squid). In audit mode
   (`strict-audit` or `tv-replays`) it waits for the replay keys, or the crypto
   timeout, before settling best-effort.
2. `Hand.settle()` resolves the automatic showdown **7-2 offsuit bounty**
   against the post-pot stacks and folds that transfer into the hand's combined
   `deltas` / `pokerDeltas` and into `stackDeltas`, so the transcript, the
   projection and the chip movement all describe the same money.
   `Hand.publishSettlement()` then calls `Hand.persistSettlement()`, which
   writes the whole hand - chip deltas, poker/squid ledger, rake, time banks,
   feature triggers, the transcript, the stats projection and the
   `hand_settlements` marker - in ONE synchronous `applyHandSettlement`
   transaction; the writer only records the bounty's `seven-deuce` ledger legs
   (its stack movement already rode `stackDeltas`). A crash can never commit a
   settled hand without paying it. A `duplicate` marker means the chips already
   moved and nothing is replayed.
3. **Single source of truth for final stacks.** Inside the same transaction the
   writer re-reads `room_players.stack` after every money move (pot, rake,
   squid, bounty) and returns it as `finalStacks`. `persistSettlement()` adopts
   that read as `Hand.settlement.stacks`, so
   `room_players.stack === hand_settlements.final_stacks === hand_players.ending_stack === Hand.settlement.stacks === hand_end.stacks`,
   and `hand_end.deltas` are the exact poker+squid+bounty nets
   (`sum(deltas) === -rake`, i.e. 0 with no rake). The projection's `net_delta`
   equals `ending_stack - starting_stack`; the bounty is a zero-sum transfer
   folded into the projection's poker view.
4. Only after the commit is the `showdown` reveal broadcast. `hand_end` is then
   delayed by the reveal hold via `scheduleHandEnd()` / `broadcastHandEnd()`.
   The hold (`showdownHoldMs`) only gates the `hand_end` frame and auto-deal; it
   never gates the database write. A fold-out has no reveal, so its `hand_end`
   is immediate. After a showdown's `hand_end`, auto-deal additionally waits
   `SETTLE_HOLD_MS` (`scheduleAutoDeal` / `setSettlementHold`), so the next deal
   never starts before the settlement animation can finish.
5. **Failure handling.** If the durable write throws (SQLITE_BUSY, projection
   rejection, ...), `Hand.onPersistFailed()` isolates it: the already-computed
   settlement is kept (deterministic and retryable), the hand stays alive so no
   next hand is dealt over it, a `settlement_failed { retrying }` frame is
   broadcast, and the write is retried on the settle clock (`SETTLE_RETRY_MS`)
   up to `SETTLE_MAX_RETRIES`. After that the table is **frozen** (see
   "Settlement recovery" below). A failure of a broadcast *after* a committed
   write is swallowed (`safeBroadcast`, which also logs on the normal error
   channel): it can only lose a frame, never the settlement, and never triggers
   a refund/abort.
6. **Reconnect.** `Hand.resendPending()` replays the FULL terminal context
   during the hold - `hand_start`, their own `your_card`, every `board_open`, the
   `showdown` (and `squid_result`) - so a page refresh rebuilds the board and
   private cards from scratch. A **spectator** (no seat) gets the public part
   only: every `board_open`, the `showdown` reveal and the `squid_result`; the
   private `your_card`/`hand_start` frames go to seated participants alone. It
   never replays a live betting snapshot once the settlement is committed.
7. **Cleanup.** The hold lives in `Hand.settleTimer` and is cleared by
   `clearTimer()` on abort and `GameRoom.shutdown()`, so a hand switch, room
   archive/teardown or app close cannot fire a stale settlement. A settlement
   already computed is guarded against re-settlement by a racing disconnect
   (`settle()` and `foldDroppedIfDecisive` both bail once `this.settlement` is
   set), and the sealed transcript is never mutated by a late audit key (which
   is discarded, see below) or by a voluntary show during the hold (a
   live-only frame).

### Settlement recovery (frozen / fail-closed)

The settlement transaction is atomic and idempotent on its
`hand_settlements` marker. On top of it there are two distinct recovery
paths, with different powers:

- **In-process settlement freeze (recoverable).** When a durable write
  exhausts `SETTLE_MAX_RETRIES`, `onPersistFailed()` leaves `GameRoom.hand`
  alive, stops retrying, and marks the room unhealthy as **recoverable**. The
  frozen hand keeps the next deal from starting. A host can recover without a
  restart by sending `retry_settlement`: `Hand.retrySettlement()` clears the
  retry budget and re-runs the writer against the same deterministic result.
  When the write finally commits, `GameRoom.settlementRecovered()` clears that
  specific recoverable mark. Because the writer is idempotent, every leg is
  paid exactly once. This path only proves a settlement write succeeded; it is
  **not** a general operator recovery.
- **Durable hand lifecycle (fail-closed).** Every hand is registered in
  `hand_lifecycle` as `running` in the same transaction that claims its feature
  triggers, i.e. before the first card is dealt. `applyHandSettlement()` marks
  that row `committed` inside the financial transaction; a normal pre-settlement
  `abort()` marks it `aborted`. On startup each room scans for a row still
  `running` / `prepared` / `quarantined` and freezes dealing if one exists.
  This is the authoritative "dealt but never settled" signal and is strictly
  stronger than the old "transcript without a marker" check: the settlement
  transaction writes transcript, marker and lifecycle row together, so a
  rolled-back write leaves the `running` row and **no transcript at all** -
  exactly the case the old check missed.

What each window can and cannot do:

- **Write failed, process still up:** recoverable via `retry_settlement`.
- **Crashed after commit:** the `committed` row and marker exist; a restart
  must not re-pay (writer duplicate) but the committed hand is recovered.
- **Crashed before commit, with only a `running` lifecycle row:** there is no
  prepared-input record to replay, so this is **process-restart / manual
  resolution only**. The room stays frozen; the engine never guesses a winner
  or fabricates a marker. This is a deliberately documented limitation, not a
  complete operator recovery.
- **Graceful shutdown:** the hub stops dealing, gives a live not-yet-settled
  hand a bounded window (`shutdownDrainMs`, default `SHUTDOWN_DRAIN_MS`) to
  reach a terminal state, then `abort()`s it so its row becomes `aborted`. This
  is why a normal deploy no longer freezes rooms. (A hand whose settlement
  already committed is never aborted.) The drain runs in Fastify's **`preClose`**
  hook, not `onClose`: `onClose` runs only after `server.close()` has waited for
  the open websockets, which is exactly the state the drain needs to read;
  `preClose` runs first, while the sockets and the DB are still live. The drain
  confirms the durable `aborted` row before it clears the in-memory hand: if the
  update cannot be proven (DB already closed, `SQLITE_BUSY`, ...) the hand is
  left **fail-closed** rather than pretending it was resolved. The abort is a
  single durable attempt whose `busy_timeout` is temporarily shortened to 250ms,
  and that shortened budget covers **every** DB touch in the abort - the initial
  terminal read-back, the lifecycle `UPDATE`, and the confirming read-back - not
  just the update; if it were installed after the first read, that read could
  still wait out the 10s connection default and the bound would be false. Rooms
  are shut down **sequentially** because they share one SQLite connection and the
  `busy_timeout` pragma is connection-global: serializing makes the shortened
  value single-owner (the abort window is also synchronous, so this is
  belt-and-braces). The real budget is therefore, **per room**,
  `shutdownDrainMs` (default 3s) + **up to four** short DB touches (the initial
  `lifecycleTerminal()` read-back, the `UPDATE` and its confirming read-back
  inside `markLifecycleAborted()`, and the outer final confirming read-back;
  ~250ms each) + small overhead; with rooms shut down one
  after another the multi-room worst case is the **sum** over affected rooms, not
  the max. Note that only a room with a live, not-yet-terminal hand pays the
  `shutdownDrainMs` part at all.
- **Upgrade from pre-lifecycle history (strict reconciliation).** A transcript
  with no `hand_settlements` marker is never assumed settled. On every open, any
  markerless transcript with no terminal lifecycle row (or a retired `legacy`
  row) is checked against its transcript payload, the ledger and the stats
  projection: its entry chain must reproduce the stored head, its rake must be a
  non-negative integer, its `hand-settlement` / `squid-game` / `commission` /
  `seven-deuce` legs must be present and close exactly (`sum(hand-settlement) =
  -rake`, `sum(commission) = rake`, squid zero, seven-deuce zero-sum with exactly
  one winner leg funded by its payers), every `hand-settlement`/`squid-game`/
  `seven-deuce` user must be a seat in this hand's `hand_players`, `rake > 0`
  requires exactly one commission leg to a real room account (and `rake == 0`
  forbids one), the `hands`/`hand_players` projection must exist **for the same
  room** with a trusted (`ok`) status and a matching non-negative integer rake,
  each player's `net_delta` must equal its ledger legs, `poker_delta` must equal
  `hand-settlement + seven-deuce`, `ending - starting` must equal
  `net_delta + commission`, and the room ledger hash chain must verify. All of
  that -> `committed` (recorded as `last_error = 'legacy reconciled'`);
  **anything else -> `quarantined`**, which gates dealing. A mid-hand buy makes
  `ending - starting` diverge, so such a markerless hand is quarantined rather
  than guessed at. The check is time-independent: the previous `ts < cutoff`
  rule was removed because a process wall-clock is not a protocol boundary (a
  half-settled hand, clock skew, or an unparsable cutoff could all be
  whitelisted). `auditMarkerlessTranscripts()` is the read-only operator
  diagnostic that reports the decision without writing. The two ledger refs are
  strictly isolated: the settlement-head ref may carry **only**
  `hand-settlement`/`squid-game`/`commission`, and the hand-id ref may carry
  **only** `seven-deuce`; a kind on the wrong ref (e.g. `commission` with
  `ref = hand_id`) is an unexplained money leg and quarantines the hand.
- **A marker is only trusted when it agrees with the transcript and room.** A
  `hand_settlements` row is proof only if its `room_id`, `head` and `rake` match
  the transcript and its entry chain - never by `hand_id` alone. A consistent
  marker drives the lifecycle to `committed`, overriding a stale `running` /
  `prepared` / `quarantined` / `legacy` row **and also an `aborted` row**: the
  marker proves the settlement transaction committed, so `aborted` is a
  contradiction and the only safe resolution is `committed` (freeze) - the table
  must never re-deal over a settled hand. An inconsistent marker is corruption
  and becomes `quarantined`, not trusted.

**Known residual gap (accepted, out of scope).** The reconciliation proves the
transcript, ledger and stats projection agree *with each other*; it does **not**
anchor to the wallet history. It does not rebuild each account's balance in
ledger order, and it does not check `room_players.stack`. So if an old finalize
had written transcript/ledger/projection in one transaction and updated the
wallets in a second, crashing in between, such a markerless hand still reconciles
to `committed` even though the stacks never moved. This is accepted rather than
fixed: the real databases have `markerless = 0` (this scenario does not trigger
on upgrade), and under the real deployment threat model (trusted internal
database, no adversarial writer) it is not worth adding a wallet-anchoring
mechanism - and, crucially, the atomic settlement writer introduced with
`hand_settlements` means new hands cannot reach that split-write state at all.
Wallet anchoring remains a possible future hardening, tracked separately.

`firstUnsettledHand()` is the deal-time gate, not a recovery mechanism: it
queries `hand_lifecycle` for a non-terminal row and refuses to deal. It cannot
reconstruct a hand, and it cannot see a pre-lifecycle crash that left no
transcript at all. It is a guard, not a promise that every unsettled hand is
recoverable.

Health states are separate from the settlement freeze:
`GameRoom.markUnhealthy()` is for an unexpected (programming) error caught by
the hub. Unknown errors are **not** recoverable and can only be cleared by a
process restart; only a settlement-failure mark is `recoverable` and cleared by
a proven retry. Marks escalate, never downgrade: a recoverable settlement mark
set first is upgraded to permanent if a real programming error then appears, so
a later settlement success can never clear the room while an unknown error is
unexplained. A known, retryable business failure (a rolled-back post-hand 7-2
bounty) is raised as a `RetryableGameError` - a `GameError` - so the hub answers
the client and leaves the room healthy instead of locking it. Only an
*identifiably transient* failure is downgraded this way: lock contention or an
interrupt, matched by an exact allow-list of the base codes and their real
extended forms (`SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT`,
`SQLITE_BUSY_TIMEOUT`, `SQLITE_LOCKED`, `SQLITE_LOCKED_SHAREDCACHE`,
`SQLITE_INTERRUPT`) or the injected test fault. Environmental and programming
failures (`SQLITE_IOERR*`, `SQLITE_FULL`, `SQLITE_NOMEM`, `SQLITE_PROTOCOL`, a
look-alike code such as `SQLITE_BUSYNESS`, a `TypeError`, an invariant
violation) propagate to the hub and mark the room unhealthy.

### Commission (rake) legs and stack reconciliation

Settlement separates the **game leg** from the **commission leg**:

```
gameDelta(u)        = poker + squid + automatic 7-2 bounty   // projection net_delta
commissionDelta(u)  = +rake when u is the rake recipient, else 0
ending_stack(u) - starting_stack(u) = gameDelta(u) + commissionDelta(u)   (no mid-hand buy)
```

`hand_end.deltas` / `hand_players.net_delta` are the game leg; `hand_end.
commissionDeltas` is the **seat-filtered** commission leg (empty when the
recipient - platform or fallback banker - is not in the hand, in which case the
credit lives on that external account's `commission` ledger row). Aggregate:

```
sum(deltas) === -commission                       ALWAYS
sum(deltas) + sum(commissionDeltas) === 0         ONLY when the recipient is in hand
```

The rake recipient is resolved **once** at settle time (the configured platform
account if present, else the in-room banker) and that single value drives the
transcript's `settlement.commissionDeltas`, the durable commission ledger row and
`hand_end.commissionDeltas`. The persisted transcript therefore carries the same
seat-filtered `commissionDeltas` (empty for an out-of-hand recipient), so a
historical replay recovers the recipient seat without reverse-engineering it
from the final stacks, and can never disagree with the ledger. This is an
additive transcript field: it changes a new hand's `head` (the head hashes the
entries) but not the head algorithm, the parser version, or the reconciliation
contract — `reconcileTranscript` still reads only the settlement `commission`
field.

**Note (accepted, non-blocking):** the reconciliation's "real room account"
check for a commission recipient only proves the account exists in the room. It
does **not** re-derive who the rake recipient *was* at the time: the historical
data has no reliable way to recompute the then-current `banker_id` / platform
account, and re-deriving it would risk rejecting genuine history. So the check
is deliberately limited to "a plausible recipient account", not "the correct
recipient".

**Known, accepted exception - mid-hand buy.** A buy approved while a hand is
live is an intervening account delta on top of the hand result, so the naive
per-seat identity `ending - starting === net_delta` explicitly does **not**
hold: it becomes `net_delta + commissionDelta + (chips bought mid-hand)`. This
is a controlled, tested contract (`P1-6`), not an incidental behaviour; a
consumer that wants the hand-only result must read `net_delta`, not a stack
difference.

### Known, accepted deviation: post-settlement voluntary shows

The immutable transcript is sealed the moment `persistSettlement()` commits the
hand (its `head` is bound into `hand_settlements`/`transcripts`). Therefore a
`show_cards` that arrives **after** the settlement is committed - whether from a
folded player during the reveal hold or through the between-hands
`onPostHandShow` path - is broadcast as a live `cards_shown` frame (and can
still trigger the fold-winner 7-2 bounty via `recordShow`) but is **never**
appended to the transcript chain. Product meaning: the replay/audit view shows
only cards that were public at settlement time; a courtesy reveal after the hand
is settled is a live-table event, not part of the immutable hand record.

A late `reveal_key` is a different case: it is **discarded**, not live-only.
`Hand.onRevealKey()` returns immediately once `phase !== 'audit'` or the
settlement is applied, so the key is dropped - no `hole_cards` frame is
broadcast and the sealed head cannot change retroactively. Only `show_cards`
is a live-only frame; a late `reveal_key` is simply lost.
