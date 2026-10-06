import type { ServerMsg } from './wsProtocol.js';

/**
 * Runtime guard for every inbound `ServerMsg`, applied at the WebSocket
 * boundary before a frame can reach the store.
 *
 * Hand-written rather than schema-driven on purpose. This runs once per frame
 * on the live-table hot path; the shared package's zod schemas build a fresh
 * object graph on every parse, which is exactly the per-frame deep copy we want
 * to avoid. These guards only read the fields they check: the validator itself
 * does not construct or copy any nested payload, and adds no dependency. (The
 * end-to-end boundary is not zero-allocation - `JSON.parse` and the parse-result
 * object still allocate - but validation adds no per-frame garbage of its own.)
 *
 * Coverage is a compile-time obligation: `guards` is a
 * `Record<ServerMsg['t'], ...>`, so adding a frame to the union without a guard
 * fails typecheck rather than silently slipping through at runtime.
 *
 * The table is given a null prototype and `parseServerMsg` also looks keys up
 * with `Object.hasOwn` - a network-supplied `t` must never reach an inherited
 * member such as `toString`, `constructor` or `__proto__`.
 *
 * Structure and primitive types only, never business rules. A false reject
 * would silently drop a legitimate frame, so numeric bounds and cross-field
 * invariants are deliberately left to the server and the state machine.
 */

type Rec = Record<string, unknown>;

const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isNumArr = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
const optional = (v: unknown, guard: (x: unknown) => boolean): boolean =>
  v === undefined || guard(v);

function oneOf<T extends string | number>(values: readonly T[]) {
  const allowed = new Set<T>(values);
  return (v: unknown): v is T => allowed.has(v as T);
}

const isChatKind = oneOf(['text', 'sticker', 'phrase'] as const);
const isSharePurpose = oneOf(['hole', 'board', 'showdown'] as const);
const isRun = oneOf([1, 2, 3] as const);
const isPeekStatus = oneOf(['accepted', 'declined', 'expired', 'failed'] as const);
const isMultiRunStage = oneOf(['choice', 'agreement'] as const);
const isMultiRunReason = oneOf([
  'agreed',
  'declined',
  'timeout',
  'ineligible',
  'disabled',
  'equity_failed',
] as const);
const isRecoveryStatus = oneOf(['committed', 'aborted', 'unresolved'] as const);
const isStreet = oneOf(['preflop', 'flop', 'turn', 'river'] as const);
const isActionType = oneOf(['fold', 'check', 'call', 'bet', 'raise'] as const);
const isScheduleMode = oneOf(['hands', 'duration'] as const);

// ---- nested payload shapes -------------------------------------------------

const isSeatInHand = (v: unknown): boolean =>
  isObj(v) &&
  isNum(v.seat) &&
  isNum(v.stack) &&
  isNum(v.committed) &&
  isNum(v.total) &&
  isBool(v.folded) &&
  isBool(v.allIn) &&
  isNumOrNull(v.lastActedAt);

const isBettingState = (v: unknown): boolean =>
  isObj(v) &&
  isStreet(v.street) &&
  Array.isArray(v.seats) &&
  v.seats.every(isSeatInHand) &&
  isNum(v.buttonSeat) &&
  isNum(v.sb) &&
  isNum(v.bb) &&
  isNum(v.currentBet) &&
  isNum(v.lastRaiseSize) &&
  isNum(v.lastFullRaiseAt) &&
  isNumOrNull(v.toAct) &&
  isNumArr(v.needToAct) &&
  isNumOrNull(v.winnerByFold);

const isPlayerAction = (v: unknown): boolean =>
  isObj(v) && isActionType(v.type) && optional(v.amount, isNum);

const isHandSeat = (v: unknown): boolean =>
  isObj(v) &&
  isNum(v.seat) &&
  isNum(v.userId) &&
  isStr(v.username) &&
  isStr(v.publicKey) &&
  isNum(v.stack);

const isRoomStatePlayer = (v: unknown): boolean =>
  isObj(v) &&
  isNum(v.userId) &&
  isStr(v.username) &&
  isStr(v.displayName) &&
  isNum(v.avatarVersion) &&
  isStr(v.publicKey) &&
  (v.seat === null || isNum(v.seat)) &&
  isNum(v.stack) &&
  isBool(v.sittingOut) &&
  isBool(v.connected) &&
  isNum(v.totalBought) &&
  isBool(v.privateStats) &&
  isNum(v.pendingBuy);

const isReadyCheck = (v: unknown): boolean =>
  isObj(v) && isNum(v.deadlineTs) && isNumArr(v.eligible) && isNumArr(v.ready);

const isSeatTimeBank = (v: unknown): boolean => isObj(v) && isNum(v.seat) && isNum(v.remainingMs);

const isShowdownReveal = (v: unknown): boolean =>
  isObj(v) && isNum(v.seat) && isNumArr(v.cards) && isNum(v.score);

const isAward = (v: unknown): boolean => isObj(v) && isNum(v.seat) && isNum(v.amount);
const isAwardArr = (v: unknown): boolean => Array.isArray(v) && v.every(isAward);
const isCardArrPair = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every(isNumArr);
const isAwardArrPair = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every(isAwardArr);
const isCardArrArr = (v: unknown): boolean => Array.isArray(v) && v.every(isNumArr);
const isAwardArrArr = (v: unknown): boolean => Array.isArray(v) && v.every(isAwardArr);
const isSeatStackArr = (v: unknown): boolean =>
  Array.isArray(v) && v.every((s) => isObj(s) && isNum(s.seat) && isNum(s.stack));
const isSeatDeltaArr = (v: unknown): boolean =>
  Array.isArray(v) && v.every((d) => isObj(d) && isNum(d.seat) && isNum(d.delta));

const isEquity = (v: unknown): boolean => isObj(v) && isNum(v.seat) && isNum(v.bps);
const isTransfer = (v: unknown): boolean =>
  isObj(v) && isNum(v.from) && isNum(v.to) && isNum(v.amount);
const isPayment = (v: unknown): boolean => isObj(v) && isNum(v.seat) && isNum(v.amount);
const isSquidNet = (v: unknown): boolean => isObj(v) && isNum(v.seat) && isNum(v.net);

const isSquidSettings = (v: unknown): boolean =>
  isObj(v) && isBool(v.enabled) && isNum(v.penaltyBb) && isNum(v.minPlayers);

const isBombPotSettings = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  const { schedule } = v;
  return (
    isBool(v.enabled) &&
    isRun(v.anteBb) &&
    isObj(schedule) &&
    isScheduleMode(schedule.mode) &&
    isNum(schedule.value)
  );
};

const isTimeBanks = (v: unknown): boolean => Array.isArray(v) && v.every(isSeatTimeBank);
const isSquidNetArr = (v: unknown): boolean => Array.isArray(v) && v.every(isSquidNet);

// ---- frame guards ----------------------------------------------------------
//
// `Record<ServerMsg['t'], ...>` makes this exhaustive at compile time.

const guards: Record<ServerMsg['t'], (m: Rec) => boolean> = {
  hello: (m) => isStr(m.serverPublicKey),

  room_state: (m) => {
    const room = m.room;
    if (!isObj(room)) return false;
    return (
      isStr(room.id) &&
      isStr(room.name) &&
      isStr(room.joinCode) &&
      isNum(room.hostId) &&
      isNum(room.bankerId) &&
      isNum(room.sb) &&
      isNum(room.bb) &&
      isStr(room.auditMode) &&
      isNum(room.actionTimeoutMs) &&
      isNumOrNull(room.actionSecs) &&
      isNumOrNull(room.coBankerId) &&
      isNum(room.minSettleHands) &&
      isNum(room.sevenDeuceBonus) &&
      isBool(room.voided) &&
      isBool(room.autoApproveBuys) &&
      isBool(room.tvReplays) &&
      optional(room.autoDeal, isBool) &&
      optional(room.autoDealerId, isNumOrNull) &&
      optional(room.commissionBps, isNum) &&
      optional(room.archived, isBool) &&
      optional(room.archivedAt, isNumOrNull) &&
      Array.isArray(m.players) &&
      m.players.every(isRoomStatePlayer) &&
      isBool(m.handActive) &&
      optional(m.autoDealAt, isNumOrNull) &&
      optional(m.autoDealPaused, isBool) &&
      (m.readyCheck === undefined || m.readyCheck === null || isReadyCheck(m.readyCheck))
    );
  },

  error: (m) => isStr(m.message),
  chat: (m) =>
    isStr(m.from) && isNum(m.userId) && isStr(m.text) && isChatKind(m.kind) && isNum(m.ts),
  rtc: (m) => isNum(m.from) && m.data !== undefined,
  voice_state: (m) => isNum(m.userId) && isBool(m.muted),
  auto_deal: (m) => isNum(m.inMs),
  ready_check: (m) => isNum(m.deadlineTs) && isNumArr(m.eligible) && isNumArr(m.ready),
  ready_end: () => true,
  seven_deuce: (m) => isStr(m.handId) && isNum(m.seat) && isNum(m.amount),

  hand_start: (m) =>
    isStr(m.handId) &&
    Array.isArray(m.seats) &&
    m.seats.every(isHandSeat) &&
    isNum(m.buttonSeat) &&
    isNum(m.sb) &&
    isNum(m.bb) &&
    isStr(m.auditMode),
  key_commit_applied: (m) => isStr(m.handId) && isNum(m.seat) && isStr(m.commit),
  shuffle_turn: (m) => isStr(m.handId) && isNum(m.seat) && isStrArr(m.deck),
  deck_state: (m) => isStr(m.handId) && isNum(m.seat) && isStrArr(m.deck),
  need_share: (m) =>
    isStr(m.handId) &&
    isNum(m.deckIndex) &&
    isStr(m.point) &&
    (m.forSeat === null || isNum(m.forSeat)) &&
    isSharePurpose(m.purpose),
  share_applied: (m) =>
    isStr(m.handId) &&
    isNum(m.deckIndex) &&
    isNum(m.seat) &&
    isStr(m.out) &&
    (m.forSeat === null || isNum(m.forSeat)),
  your_card: (m) => isStr(m.handId) && isNum(m.deckIndex) && isStr(m.point),
  board_open: (m) =>
    isStr(m.handId) && isNum(m.deckIndex) && isNum(m.card) && optional(m.run, isRun),
  rit_offer: (m) => isStr(m.handId) && isNum(m.deadlineTs) && isNumArr(m.voters),
  rit_result: (m) => isStr(m.handId) && isBool(m.runTwice) && isNumArr(m.sharedBoard),

  betting_state: (m) =>
    isStr(m.handId) &&
    isNum(m.actionSeq) &&
    isBettingState(m.state) &&
    isNumArr(m.board) &&
    isNumOrNull(m.deadline) &&
    optional(m.baseDeadline, isNumOrNull) &&
    optional(m.timeBanks, isTimeBanks),

  action_applied: (m) =>
    isStr(m.handId) &&
    isNum(m.seat) &&
    isPlayerAction(m.action) &&
    optional(m.auto, isBool) &&
    optional(m.actionSeq, isNum),

  showdown: (m) => {
    if (!isStr(m.handId) || !Array.isArray(m.reveals) || !m.reveals.every(isShowdownReveal)) {
      return false;
    }
    if (!Array.isArray(m.awards) || !m.awards.every(isAward)) return false;
    if (m.runTwice !== undefined) {
      const r = m.runTwice;
      if (!isObj(r) || !isCardArrPair(r.boards) || !isAwardArrPair(r.awards)) return false;
    }
    if (m.multiRun !== undefined) {
      const r = m.multiRun;
      if (!isObj(r) || !isCardArrArr(r.boards) || !isAwardArrArr(r.awards)) return false;
    }
    return true;
  },

  feature_started: (m) =>
    optional(m.handId, isStr) &&
    optional(m.squid, isSquidSettings) &&
    optional(m.bombPot, isBombPotSettings),

  time_bank_update: (m) => isStr(m.handId) && isNum(m.seat) && isNum(m.remainingMs),

  multi_run_offer: (m) =>
    isStr(m.handId) &&
    isStr(m.decisionId) &&
    isMultiRunStage(m.stage) &&
    isNum(m.aheadSeat) &&
    isNum(m.behindSeat) &&
    Array.isArray(m.equities) &&
    m.equities.every(isEquity) &&
    optional(m.requestedRuns, isRun) &&
    isNum(m.deadlineTs),

  multi_run_result: (m) =>
    isStr(m.handId) && isNum(m.runs) && isMultiRunReason(m.reason) && isNumArr(m.sharedBoard),

  squid_result: (m) =>
    isStr(m.handId) &&
    isNumArr(m.winners) &&
    Array.isArray(m.transfers) &&
    m.transfers.every(isTransfer) &&
    isNum(m.requestedPerLoser) &&
    Array.isArray(m.paidBySeat) &&
    m.paidBySeat.every(isPayment) &&
    optional(m.netBySeat, isSquidNetArr) &&
    isBool(m.noClaimant),

  hand_end: (m) =>
    isStr(m.handId) &&
    isStr(m.head) &&
    isSeatStackArr(m.stacks) &&
    isSeatDeltaArr(m.deltas) &&
    optional(m.commissionDeltas, isSeatDeltaArr) &&
    optional(m.commission, isNum) &&
    optional(m.commissionBps, isNum) &&
    optional(m.recovered, isBool),

  settlement_failed: (m) =>
    isStr(m.handId) && isStr(m.reason) && isNum(m.attempt) && isBool(m.retrying),

  hand_recovery: (m) => isStr(m.handId) && isRecoveryStatus(m.status),

  cards_shown: (m) => isStr(m.handId) && isNum(m.seat) && isNumArr(m.cards),

  peek_offer: (m) =>
    isStr(m.offerId) &&
    isStr(m.handId) &&
    isNum(m.fromUserId) &&
    isStr(m.fromName) &&
    isNum(m.targetSeat) &&
    isNum(m.amount),

  peek_result: (m) =>
    isStr(m.offerId) &&
    isStr(m.handId) &&
    isNum(m.targetSeat) &&
    isPeekStatus(m.status) &&
    isNum(m.amount) &&
    optional(m.cards, isNumArr),

  peek_offer_closed: (m) =>
    isStr(m.offerId) && isStr(m.handId) && isNum(m.targetSeat) && isPeekStatus(m.status),

  peek_offers_snapshot: (m) => isStrArr(m.incomingOfferIds),

  hand_abort: (m) =>
    isStr(m.handId) && isStr(m.reason) && (m.blamedSeat === null || isNum(m.blamedSeat)),

  need_keys: (m) => isStr(m.handId),

  transcript_entry: (m) =>
    isStr(m.handId) && isNum(m.seq) && isStr(m.type) && isStr(m.from) && isStr(m.head),
};

// Null prototype: a second line of defence so no frame type can ever resolve an
// inherited member, even if a future lookup path forgets the own-property check.
Object.setPrototypeOf(guards, null);

export type ServerMsgParseResult = { ok: true; msg: ServerMsg } | { ok: false; reason: string };

/** Validate one decoded frame. Never throws: returns the typed message on
 *  success, or a human-readable reason on failure (bad shape or unknown `t`). */
export function parseServerMsg(raw: unknown): ServerMsgParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'not a JSON object' };
  const t = raw.t;
  if (typeof t !== 'string') return { ok: false, reason: 'missing string "t" tag' };
  // Own-property check, not `guards[t]` directly: `t` comes straight from the
  // network, and a plain object would resolve inherited members such as
  // `toString`/`constructor` (accepted as guards) or `__proto__`/`valueOf`
  // (called and thrown). `Object.hasOwn` keeps unknown and prototype keys on
  // the reject path so this function never throws.
  if (!Object.hasOwn(guards, t)) {
    return { ok: false, reason: `unknown frame type "${t}"` };
  }
  const guard = guards[t as ServerMsg['t']];
  if (!guard) return { ok: false, reason: `unknown frame type "${t}"` };
  if (!guard(raw)) return { ok: false, reason: `frame "${t}" failed validation` };
  return { ok: true, msg: raw as unknown as ServerMsg };
}

/** Boolean form for callers that don't need the rejection reason. */
export function isServerMsg(raw: unknown): raw is ServerMsg {
  return parseServerMsg(raw).ok;
}
