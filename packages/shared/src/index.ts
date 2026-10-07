/**
 * Single public entry point for @4am/shared.
 *
 * `shared` holds values that the server, the web client and the agent packages
 * must agree on. It is NOT a home for server domain logic: a symbol only one
 * app uses belongs in that app. The exports below are grouped by layer so the
 * kind of each module - and who consumes it - is visible at the boundary:
 *
 *   rules     pure poker/table computation. No I/O, no wire or DTO shape.
 *   protocol  WebSocket frames and HTTP response DTOs.
 *   prefs     shared preference/vocabulary contracts the server persists and
 *             the web edits or renders.
 *   util      generic helpers with no poker/table meaning.
 *
 * This is an explicit export list rather than `export *`: publishing a symbol
 * is a deliberate edit here and nothing leaks out of a module by accident.
 * Modules are flat on disk; the grouping is by layer, not by directory.
 */

// ---- rules: pure poker / table computation -------------------------------

export {
  ALL_CARDS,
  RANKS,
  SUITS,
  cardFromName,
  cardName,
  rankOf,
  suitOf,
  type CardId,
} from './cards.js';
export {
  HAND_CATEGORY,
  HAND_CATEGORY_NAMES,
  bestFive,
  describeScore,
  evaluate5,
  evaluate7,
  handCategory,
  type HandCategory,
} from './evaluate.js';
export {
  activeNonAllIn,
  applyAction,
  awardPots,
  bestScoreSeats,
  computePots,
  intersectSeatSets,
  legalActions,
  nextStreet,
  splitAmountEven,
  startBombPot,
  startHand,
  streetClosed,
  type BettingState,
  type PlayerAction,
  type SeatInHand,
  type Street,
} from './betting.js';
export {
  LEGACY_ROOM_COMMISSION_BPS,
  NEW_ROOM_COMMISSION_BPS,
  commissionForPot,
  commissionRateLabel,
} from './commission.js';
export {
  BOMB_POT_ANTE_BB_MAX,
  BOMB_POT_ANTE_BB_MIN,
  BOMB_POT_ANTE_BB_VALUES,
  BOMB_POT_DURATION_SECONDS_MAX,
  BOMB_POT_DURATION_SECONDS_MIN,
  BOMB_POT_HANDS_MAX,
  BOMB_POT_HANDS_MIN,
  DEFAULT_GAMEPLAY_SETTINGS,
  MAX_QUALIFYING_HANDS,
  MAX_TIME_BANK_MS,
  MULTI_RUN_MAX_RUNS,
  SQUID_MIN_PLAYERS_MAX,
  SQUID_MIN_PLAYERS_MIN,
  SQUID_PENALTY_BB_MAX,
  SQUID_PENALTY_BB_MIN,
  TIME_BANK_INITIAL_SECONDS,
  TIME_BANK_MAX_CARDS,
  TIME_BANK_REFILL_EVERY_HANDS,
  TIME_BANK_REFILL_EVERY_HANDS_MAX,
  TIME_BANK_REFILL_EVERY_HANDS_MIN,
  TIME_BANK_REFILL_SECONDS,
  TIME_BANK_SECONDS_MAX,
  TIME_BANK_SECONDS_MIN,
  type RoomGameplaySettings,
} from './roomRules.js';
// Quick-bet ratios: constants + guard shared by the web action bar / Settings
// card and the server profile schema (see the module header).
export {
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  BET_RATIO_SLOTS,
  DEFAULT_BET_RATIOS,
  sanitizeBetRatios,
} from './betRatios.js';

// ---- protocol: wire frames + HTTP DTOs -----------------------------------

// WebSocket frames: the discriminated client union, the server union, the zod
// schemas built from them, and the payload helpers they carry.
export {
  clientMsgSchema,
  dleqProofSchema,
  playerActionSchema,
  signedBody,
  type ClientMsg,
  type FeatureStartedPayload,
  type HandSeat,
  type MultiRunEquity,
  type MultiRunReason,
  type MultiRunStage,
  type RoomStatePlayer,
  type SeatTimeBank,
  type ServerMsg,
  type SquidNet,
  type SquidPayment,
  type SquidTransfer,
} from './wsProtocol.js';
// Runtime validation for inbound server frames, applied at the web socket
// boundary so a malformed/unknown frame is dropped instead of reaching the
// store (see the module header for why this is hand-written).
export { isServerMsg, parseServerMsg, type ServerMsgParseResult } from './serverMsgValidation.js';
// Pure HTTP response DTOs (no wire frames). The server constructs them; the
// web API layer consumes them.
export type {
  AdminOverview,
  CommissionScope,
  CommissionSettings,
  HouseBalance,
  HouseDues,
  HouseRoom,
  PlatformDuesReport,
  PlatformDuesUser,
} from './house.js';

// ---- prefs: shared preference & vocabulary contracts ---------------------

// Poker keyboard shortcuts: the server validates and persists them
// (apps/server/src/profile.ts), the web editor renders and edits them. Also
// carries the web-only keyboard-event adapter `pokerBindingFromEvent`.
export {
  DEFAULT_POKER_HOTKEYS,
  POKER_HOTKEY_ACTIONS,
  parsePokerHotkeys,
  pokerBindingFromEvent,
  pokerHotkeysError,
  validPokerBinding,
  type PokerHotkeyAction,
  type PokerHotkeys,
} from './pokerHotkeys.js';
// Bot difficulty: one vocabulary for the HTTP API, the bot runner resolver
// (@4am/agent-core) and the web UI.
export {
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  RETIRED_BOT_DIFFICULTIES,
  normalizeBotDifficulty,
  parseBotDifficulty,
  type BotDifficulty,
} from './botDifficulty.js';
// Bot lifecycle states: the server owns the machine, the web only labels it.
export { BOT_STATUSES, type BotStatus } from './botStatus.js';

// ---- util ----------------------------------------------------------------

// Nickname rules enforced identically by the server and the settings form.
export {
  DISPLAY_NAME_MAX_WIDTH,
  displayNameError,
  displayNameWidth,
  isEastAsianWide,
} from './displayName.js';
