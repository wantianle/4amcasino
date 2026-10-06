import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_POKER_HOTKEYS,
  parsePokerHotkeys,
  type PokerHotkeys,
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  BET_RATIO_SLOTS,
  DEFAULT_BET_RATIOS,
  sanitizeBetRatios,
} from '@4am/shared';

// Quick-bet ratio constants and the sanitizer live in `@4am/shared` (single
// source shared with the server profile schema). Re-exported here so every
// existing importer - the Settings card, betPresets, the tests - keeps its
// import path.
export { ALL_IN_RATIO, BET_RATIO_OPTIONS, BET_RATIO_SLOTS, DEFAULT_BET_RATIOS, sanitizeBetRatios };
import type {
  BettingState,
  CardId,
  FeatureStartedPayload,
  PlayerAction,
  ServerMsg,
} from '@4am/shared';

type RoomStateMsg = Extract<ServerMsg, { t: 'room_state' }>;
type HandStartMsg = Extract<ServerMsg, { t: 'hand_start' }>;
type ShowdownMsg = Extract<ServerMsg, { t: 'showdown' }>;
type HandEndMsg = Extract<ServerMsg, { t: 'hand_end' }>;
type HandAbortMsg = Extract<ServerMsg, { t: 'hand_abort' }>;
type MultiRunOfferMsg = Extract<ServerMsg, { t: 'multi_run_offer' }>;
type MultiRunResultMsg = Extract<ServerMsg, { t: 'multi_run_result' }>;
type SquidResultMsg = Extract<ServerMsg, { t: 'squid_result' }>;

export interface ChatMsg {
  from: string;
  userId: number;
  text: string;
  kind: 'text' | 'sticker' | 'phrase';
  ts: number;
}

/** The server's `settlement_failed` frame, plus the small amount of local state
 *  the host-retry UI needs. The hand's chips may not have moved, so the table is
 *  frozen (or auto-retrying) until this clears on `hand_end`. */
export interface SettlementFailure {
  handId: string;
  /** Server prose (SQLITE_BUSY, projection rejection, ...); render via `tr`. */
  reason: string;
  /** The server's own bounded attempt counter (resets when the host retries). */
  attempt: number;
  /** True while the server still owns the retry budget; false once exhausted,
   *  at which point a human - the host - must send `retry_settlement`. */
  retrying: boolean;
  /** Set when the host asked for a manual retry; cleared by any later frame so
   *  the button never looks dead while a request is in flight. */
  retryRequestedAt: number | null;
  /** The host has already spent at least one manual retry on this settlement. */
  manualRetry: boolean;
  /** When this failure state was last set from a server frame. Bounds the
   *  server-owned auto-retry: if no further frame arrives, the automatic retry
   *  is presumed lost and the host is offered a manual retry instead of a
   *  banner that can never act. */
  since: number;
  /** The hand is gone from the server (e.g. after a restart) while the durable
   *  settlement is still uncommitted; only an administrator can resolve it, so
   *  no manual retry is offered. Set on resync when `handActive` is false but a
   *  failure is still pending - the frame's absence is not proof of success. */
  orphaned: boolean;
}

/** The card-back colorways, in picker order. Single source of truth shared by
 *  the profile picker, the store shape, and the server round-trip sanitizer.
 *  Each id maps 1:1 to a `.card-back-<id>` rule in app/index.css. */
export const CARD_BACKS = [
  'indigo', 'crimson', 'emerald', 'slate', 'wine-lattice', 'black-gold',
  'classic-red-blue', 'geometry', 'deep-blue-silver',
] as const;
export type CardBack = (typeof CARD_BACKS)[number];
export const CARD_FACES = ['gg-four-color', 'gg-solid', 'classic-large', 'jumbo-accessible', 'minimal'] as const;
export type CardFace = (typeof CARD_FACES)[number];
export const TABLE_SKINS = ['gg-green', 'sapphire', 'burgundy', 'classic-casino'] as const;
export type TableSkin = (typeof TABLE_SKINS)[number];

/** Guards server/persisted payloads: a foreign value must never reach the
 *  `card-back-${value}` class template or the picker's selected-state compare. */
export function isCardBack(value: unknown): value is CardBack {
  return typeof value === 'string' && (CARD_BACKS as readonly string[]).includes(value);
}
export const isCardFace = (value: unknown): value is CardFace =>
  typeof value === 'string' && (CARD_FACES as readonly string[]).includes(value);
export const isTableSkin = (value: unknown): value is TableSkin =>
  typeof value === 'string' && (TABLE_SKINS as readonly string[]).includes(value);

// Quick-bet ratios (A10, docs/table-redesign-spec.md): the constants and the
// `sanitizeBetRatios` guard live in `@4am/shared` so the action bar, the
// Settings card and the server profile schema share one definition and can
// never drift. The persist `merge` below runs every rehydrated value through
// that sanitizer, which migrates the legacy four-slot list to the five-slot
// default rather than keeping a stale shape alive.

export interface Prefs {
  pokerHotkeys: PokerHotkeys;
  displayName: string;
  bio: string;
  hasAvatar: boolean;
  avatarVersion: number;
  cardBack: CardBack;
  cardFace: CardFace;
  tableSkin: TableSkin;
  /** @deprecated Migrated to cardFace on profile sync; retained for old snapshots. */
  fourColor: boolean;
  quickPhrases: string[];
  /** Hide my winnings from other players (leaderboards, session report, crown). */
  privateMode: boolean;
  /** Friends' table invites add me to the room automatically. */
  autoJoinInvites: boolean;
  /** Skip the ready check: deal me in without asking every hand. */
  autoReady: boolean;
  /** Quick-bet ratios for the table's action bar (A10). */
  betRatios: number[];
  /** Shared table display unit so every seat's money labels agree. */
  stackUnit: 'chips' | 'bb';
}

export const defaultPrefs: Prefs = {
  pokerHotkeys: DEFAULT_POKER_HOTKEYS,
  displayName: '',
  bio: '',
  hasAvatar: false,
  avatarVersion: 0,
  cardBack: 'crimson',
  cardFace: 'gg-four-color',
  tableSkin: 'gg-green',
  fourColor: true,
  quickPhrases: [],
  privateMode: false,
  autoJoinInvites: false,
  // Default on: the server now auto-readies every hand; the player can opt out.
  autoReady: true,
  betRatios: [...DEFAULT_BET_RATIOS],
  stackUnit: 'chips',
};

export interface AuthState {
  token: string | null;
  userId: number | null;
  username: string | null;
  identity: { publicKey: string; secretKey: string } | null;
  /** Whether this account is the platform (house) account; gates the admin console. */
  isPlatform?: boolean;
  /** 1-based leaderboard placement, or null if unranked/hidden. */
  leaderboardRank?: number | null;
}

export interface PeekResult {
  targetSeat: number;
  targetUserId: number;
  /** Frozen at receipt, so leaving or reusing a seat cannot rename this result. */
  targetName: string;
  cards: CardId[];
}

interface HandView {
  handId: string | null;
  seats: HandStartMsg['seats'];
  buttonSeat: number | null;
  myCards: CardId[];
  myCardPoints: { deckIndex: number; point: string }[];
  shown: Record<number, CardId[]>;
  betting: BettingState | null;
  actionSeq: number;
  deadline: number | null;
  lastActions: Record<number, PlayerAction & { auto?: boolean }>;
  showdown: ShowdownMsg | null;
  result: HandEndMsg | null;
  abort: HandAbortMsg | null;
  /** Armed before your turn; the game client fires it the moment you are to act. */
  preAction: 'check-fold' | 'check' | 'call' | 'call-any' | null;
  /** The call price a 'call' pre-action was armed at; it never pays more. */
  preActionCallAt: number | null;
  /** Paid-peek offers waiting for my answer, and reveals only I can see. */
  peekOffers: { offerId: string; fromUserId: number; fromName: string; amount: number }[];
  peekResults: Record<number, PeekResult>;
  /** When the server opens the next automatic ready check. */
  autoDealAt: number | null;
  /** Pre-deal ready check: nobody is dealt in without clicking I'm ready. */
  readyCheck: { deadlineTs: number; eligible: number[]; ready: number[] } | null;
  /** Run-it-twice vote in progress (everyone all-in before the river). */
  ritOffer: { deadlineTs: number; voters: number[]; voted: boolean } | null;
  /** Canonical per-run board state. Index 0 = run 1, index 1 = run 2 (or the
   *  second runout), index 2 = run 3. Sparse until each run's cards land. */
  boards: CardId[][];
  /** @deprecated TEMPORARY compatibility adapter — always `boards[0] ?? []`.
   *  Kept so existing table/replay components keep compiling while they migrate
   *  to reading `boards` directly. Do not write to this from new code. */
  board: CardId[];
  /** @deprecated TEMPORARY compatibility adapter — always `boards[1] ?? []`.
   *  Kept so existing table/replay components keep compiling while they migrate
   *  to reading `boards` directly. Do not write to this from new code. */
  board2: CardId[];
  /** Shared base clock deadline for the current street (ms epoch), or null. */
  baseDeadline: number | null;
  /** Per-seat time-bank balance in ms, keyed by absolute seat. */
  timeBanks: Record<number, number>;
  /** Feature announcement for the hand (squid / bomb pot), from feature_started. */
  featureStarted: FeatureStartedPayload | null;
  /** Live multi-run negotiation, including its current stage. */
  multiRunOffer: MultiRunOfferMsg | null;
  /** The multi-run negotiation's terminal outcome. */
  multiRunResult: MultiRunResultMsg | null;
  /** Squid-game settlement for the hand, from squid_result. */
  squidResult: SquidResultMsg | null;
  /** Set by `settlement_failed`; non-null means the hand's durable settlement
   *  did not commit and the table is frozen until a (host) retry succeeds. */
  settlementFailed: SettlementFailure | null;
  /** Independent durable-recovery answer for THIS hand, from `hand_recovery`.
   *  `'unresolved'` means the server never reached a terminal transaction for
   *  the hand it still held (a restart raced its settlement), so the hand must
   *  NOT be treated as a terminal: no refund was made, only an operator can
   *  resolve it. Kept separate from `settlementFailed` on purpose - a client
   *  that never saw a `settlement_failed` frame must still refuse to synthesise
   *  the restart refund abort. Cleared by a committed/aborted recovery or a new
   *  hand. */
  handRecovery: 'unresolved' | null;
}

/** Everything the last-hand recap needs, frozen at hand_end. */
export interface LastHandSnap {
  handId: string;
  ts: number;
  board: CardId[];
  board2: CardId[];
  /** Canonical per-run boards of the finished hand (index 0 = run 1). Carries
   *  every run (1-3) even though `board`/`board2` only reach the first two.
   *  Optional so recaps frozen before multi-run existed still load. */
  boards?: CardId[][];
  /** Multi-run outcome, when the hand ran 2-3 times. `awards` is per run and
   *  only present when the server froze it (showdown). */
  multiRun?: {
    boards: CardId[][];
    awards?: { seat: number; amount: number }[][];
  } | null;
  reveals: { seat: number; cards: CardId[]; score: number }[];
  shown: Record<number, CardId[]>;
  deltas: { seat: number; delta: number }[];
  /** Account-level rake leg when the recipient is also seated in this hand. */
  commissionDeltas?: { seat: number; delta: number }[];
  runTwice: {
    boards: [CardId[], CardId[]];
    awards: [{ seat: number; amount: number }[], { seat: number; amount: number }[]];
  } | null;
  names: Record<number, string>;
}

export const emptyHand: HandView = {
  handId: null,
  seats: [],
  buttonSeat: null,
  myCards: [],
  myCardPoints: [],
  shown: {},
  betting: null,
  actionSeq: 0,
  deadline: null,
  lastActions: {},
  showdown: null,
  result: null,
  abort: null,
  preAction: null,
  preActionCallAt: null,
  peekOffers: [],
  peekResults: {},
  autoDealAt: null,
  readyCheck: null,
  ritOffer: null,
  boards: [],
  board: [],
  board2: [],
  baseDeadline: null,
  timeBanks: {},
  featureStarted: null,
  multiRunOffer: null,
  multiRunResult: null,
  squidResult: null,
  settlementFailed: null,
  handRecovery: null,
};

/** TEMPORARY migration shim for the `board`/`board2` split.
 *
 *  `boards` is now the canonical state. Components still read the derived
 *  `board` (= `boards[0]`) and `board2` (= `boards[1]`) fields, and some legacy
 *  callers still write to them. This folds either shape into `boards` and then
 *  re-derives both adapters, so the two representations can never drift.
 *  Delete this (and the two `@deprecated` fields) once every consumer reads
 *  `boards` directly. */
function reconcileBoards(prev: HandView, p: Partial<HandView>): Partial<HandView> {
  if (p.boards !== undefined) {
    const boards = p.boards.map((run) => run);
    return { boards, board: boards[0] ?? [], board2: boards[1] ?? [] };
  }
  if (p.board === undefined && p.board2 === undefined) return {};
  const boards = prev.boards.map((run) => run);
  if (p.board !== undefined) boards[0] = p.board;
  if (p.board2 !== undefined) boards[1] = p.board2;
  return { boards, board: boards[0] ?? [], board2: boards[1] ?? [] };
}

interface Store {
  auth: AuthState;
  setAuth: (a: AuthState) => void;
  logout: () => void;

  room: RoomStateMsg | null;
  setRoom: (r: RoomStateMsg | null) => void;
  chat: ChatMsg[];
  pushChat: (m: ChatMsg) => void;
  setChat: (msgs: ChatMsg[]) => void;

  hand: HandView;
  patchHand: (p: Partial<HandView>) => void;
  resetHand: (p?: Partial<HandView>) => void;

  /** The previous completed hand, kept after the next deal wipes `hand` -
   *  feeds the toggleable "last hand" recap strip. */
  lastHand: LastHandSnap | null;
  setLastHand: (h: LastHandSnap | null) => void;

  errors: string[];
  pushError: (e: string) => void;
  dismissError: () => void;

  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  pokerHotkeysFor: number | null;
  setPokerHotkeys: (p: PokerHotkeys, userId: number) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;

  voice: {
    joined: boolean;
    muted: boolean;
    mutedByUser: Record<number, boolean>;
    speakingByUser: Record<number, boolean>;
  };
  patchVoice: (v: Partial<Store['voice']>) => void;
}

export const useStore = create<Store>()(
  persist(
    (set) => ({
      auth: { token: null, userId: null, username: null, identity: null },
      setAuth: (auth) =>
        set((s) => ({
          auth,
          pokerHotkeysFor:
            s.auth.token === auth.token && s.auth.userId === auth.userId ? s.pokerHotkeysFor : null,
        })),
      logout: () =>
        set({
          auth: { token: null, userId: null, username: null, identity: null },
          room: null,
          chat: [],
          hand: emptyHand,
          pokerHotkeysFor: null,
        }),

      room: null,
      setRoom: (room) => set({ room }),
      chat: [],
      pushChat: (m) => set((s) => ({ chat: [...s.chat.slice(-199), m] })),
      setChat: (chat) => set({ chat }),

      hand: emptyHand,
      patchHand: (p) =>
        set((s) => ({ hand: { ...s.hand, ...p, ...reconcileBoards(s.hand, p) } })),
      resetHand: (p = {}) =>
        set(() => ({ hand: { ...emptyHand, ...p, ...reconcileBoards(emptyHand, p) } })),
      lastHand: null,
      setLastHand: (lastHand) => set({ lastHand }),

      errors: [],
      pushError: (e) => set((s) => ({ errors: [...s.errors, e] })),
      dismissError: () => set((s) => ({ errors: s.errors.slice(1) })),

      wsConnected: false,
      setWsConnected: (wsConnected) => set({ wsConnected }),

      pokerHotkeysFor: null,
      setPokerHotkeys: (pokerHotkeys, userId) =>
        set((s) =>
          s.auth.userId === userId
            ? { pokerHotkeysFor: userId, prefs: { ...s.prefs, pokerHotkeys } }
            : {},
        ),
      prefs: defaultPrefs,
      setPrefs: (p) => set((s) => ({ prefs: { ...s.prefs, ...p } })),

      voice: { joined: false, muted: false, mutedByUser: {}, speakingByUser: {} },
      patchVoice: (v) => set((s) => ({ voice: { ...s.voice, ...v } })),
    }),
    {
      name: '4am-auth',
      partialize: (s) => ({ auth: s.auth, prefs: s.prefs }),
      merge: (persisted, current) => {
        const p = persisted as Partial<Store> | undefined;
        const stored = p?.prefs;
        return {
          ...current,
          ...(p ?? {}),
          pokerHotkeysFor: null,
          // new pref fields must survive rehydration from an older stored shape
          prefs: Object.fromEntries(
            Object.entries(defaultPrefs).map(([key, fallback]) => [
              key,
              key === 'pokerHotkeys'
                ? (parsePokerHotkeys(stored?.pokerHotkeys) ?? fallback)
                : key === 'betRatios'
                  ? sanitizeBetRatios(stored?.betRatios)
                  : key === 'cardFace'
                    ? // An old snapshot predates `cardFace`: derive it from the
                      // retired boolean, otherwise a `fourColor:false` pick would
                      // briefly render the default four-colour deck (and stay
                      // wrong for the whole session if the profile sync fails).
                      isCardFace(stored?.cardFace)
                      ? stored.cardFace
                      : stored?.fourColor === false
                        ? 'classic-large'
                        : fallback
                    : key === 'fourColor'
                      ? // Keep the deprecated mirror coherent with the authority.
                        isCardFace(stored?.cardFace)
                        ? stored.cardFace === 'gg-four-color'
                        : stored?.fourColor !== false
                      : (stored?.[key as keyof Prefs] ?? fallback),
            ]),
          ) as unknown as Prefs,
        };
      },
    },
  ),
);
