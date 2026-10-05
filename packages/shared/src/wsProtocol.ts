import { z } from 'zod';
import type { BettingState, PlayerAction, Street } from './betting.js';
import type { CardId } from './cards.js';
import type { RoomGameplaySettings } from './roomRules.js';

const hex = (len?: number) =>
  len
    ? z
        .string()
        .length(len)
        .regex(/^[0-9a-f]+$/)
    : z.string().regex(/^[0-9a-f]+$/);

/** Hand ids are randomBytes(8); bound them so an unbounded string never reaches
 *  a map key or a DB lookup. */
const handId = z.string().min(1).max(64);

/** A scalar reduced mod the group order, so at most 64 hex characters - but
 *  these are produced by BigInt.toString(16), which does not zero-pad, so a
 *  short one is perfectly legitimate. Bounded rather than fixed-width: leaving
 *  them open let a single frame carry ~100MB of hex straight into
 *  BigInt('0x'+...), which is superlinear in V8 and blocks the one thread every
 *  live table shares. */
const scalarHex = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9a-f]+$/);

export const dleqProofSchema = z.object({ A1: hex(64), A2: hex(64), z: scalarHex });

export const playerActionSchema = z.object({
  type: z.enum(['fold', 'check', 'call', 'bet', 'raise']),
  amount: z.number().int().positive().optional(),
});

/** Client -> server messages. Signed ones carry `sig` = signContent(secret, handId, t, body). */
export const clientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('join_room'), roomId: z.string() }),
  z.object({ t: z.literal('sit'), seat: z.number().int().min(0).max(8) }),
  z.object({ t: z.literal('leave_seat') }),
  z.object({ t: z.literal('start_hand') }),
  z.object({ t: z.literal('key_commit'), handId: z.string(), commit: hex(64), sig: hex(128) }),
  z.object({
    t: z.literal('shuffle_deck'),
    handId: z.string(),
    deck: z.array(hex(64)).length(52),
    sig: hex(128),
  }),
  z.object({
    t: z.literal('unmask_share'),
    handId: z.string(),
    deckIndex: z.number().int().min(0).max(51),
    out: hex(64),
    proof: dleqProofSchema,
    sig: hex(128),
  }),
  z.object({
    t: z.literal('action'),
    handId: z.string(),
    action: playerActionSchema,
    sig: hex(128),
  }),
  z.object({ t: z.literal('reveal_key'), handId, key: scalarHex, sig: hex(128) }),
  z.object({
    t: z.literal('show_cards'),
    handId: z.string(),
    shares: z
      .array(
        z.object({
          deckIndex: z.number().int().min(0).max(51),
          out: hex(64),
          proof: dleqProofSchema,
        }),
      )
      .min(1)
      .max(2),
    sig: hex(128),
  }),
  z.object({ t: z.literal('sit_out'), sittingOut: z.boolean() }),
  z.object({ t: z.literal('im_ready') }),
  z.object({ t: z.literal('rit_vote'), handId: z.string(), yes: z.boolean(), sig: hex(128) }),
  z.object({ t: z.literal('fold_key'), handId, key: scalarHex, sig: hex(128) }),
  z.object({
    t: z.literal('peek_offer'),
    handId,
    targetSeat: z.number().int().min(0).max(8),
    amount: z.number().int().positive().max(1_000_000),
  }),
  z.object({
    t: z.literal('peek_accept'),
    handId: z.string(),
    offerId: z.string(),
    shares: z
      .array(
        z.object({
          deckIndex: z.number().int().min(0).max(51),
          out: hex(64),
          proof: dleqProofSchema,
        }),
      )
      .min(1)
      .max(2),
    sig: hex(128),
  }),
  z.object({ t: z.literal('peek_decline'), handId: z.string(), offerId: z.string() }),
  z.object({
    t: z.literal('chat'),
    text: z.string().min(1).max(400),
    kind: z.enum(['text', 'sticker', 'phrase']).optional(),
  }),
  // relayed verbatim to another player, so it needs its own ceiling - SDP and
  // ICE payloads are a few KB, nowhere near this
  z.object({
    t: z.literal('rtc'),
    to: z.number().int(),
    data: z
      .unknown()
      .refine((d) => JSON.stringify(d ?? null).length <= 8192, 'rtc payload too large'),
  }),
  z.object({ t: z.literal('voice_state'), muted: z.boolean() }),
  // ---- multi-run negotiation (signed) ----
  // The player ahead picks how many times to run the board; the player behind
  // then agrees (or not). `decisionId` ties the reply to the offer.
  z.object({
    t: z.literal('run_count_choice'),
    handId: z.string(),
    decisionId: z.string(),
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    sig: hex(128),
  }),
  z.object({
    t: z.literal('run_count_agree'),
    handId: z.string(),
    decisionId: z.string(),
    agree: z.boolean(),
    sig: hex(128),
  }),
]);
export type ClientMsg = z.infer<typeof clientMsgSchema>;

/** The body that gets content-signed for each signed client message type. */
export function signedBody(msg: ClientMsg): unknown {
  switch (msg.t) {
    case 'key_commit':
      return { commit: msg.commit };
    case 'shuffle_deck':
      return { deck: msg.deck };
    case 'unmask_share':
      return { deckIndex: msg.deckIndex, out: msg.out, proof: msg.proof };
    case 'action':
      return { action: msg.action };
    case 'reveal_key':
      return { key: msg.key };
    case 'rit_vote':
      return { yes: msg.yes };
    case 'fold_key':
      return { key: msg.key };
    case 'show_cards':
      return { shares: msg.shares };
    case 'peek_accept':
      return { offerId: msg.offerId, shares: msg.shares };
    case 'run_count_choice':
      return { decisionId: msg.decisionId, count: msg.count };
    case 'run_count_agree':
      return { decisionId: msg.decisionId, agree: msg.agree };
    default:
      return null;
  }
}

// ---- server -> client ----

export interface HandSeat {
  seat: number;
  userId: number;
  username: string;
  publicKey: string;
  stack: number;
}

export interface RoomStatePlayer {
  userId: number;
  username: string;
  displayName: string;
  avatarVersion: number;
  publicKey: string;
  seat: number | null;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
  /** Net chips bought from the bank in this room (purchases minus reverts). 0 when privateStats. */
  totalBought: number;
  /** The player asked for their winnings to stay hidden. */
  privateStats: boolean;
  /** Chips requested from the bank, still waiting for banker approval. */
  pendingBuy: number;
}

export type ServerMsg =
  | { t: 'hello'; serverPublicKey: string }
  | {
      t: 'room_state';
      room: {
        id: string;
        name: string;
        joinCode: string;
        hostId: number;
        bankerId: number;
        sb: number;
        bb: number;
        auditMode: string;
        actionTimeoutMs: number;
        actionSecs: number | null;
        coBankerId: number | null;
        minSettleHands: number;
        sevenDeuceBonus: number;
        voided: boolean;
        meetLink: string | null;
        autoApproveBuys: boolean;
        tvReplays: boolean;
        /** Optional while clients/servers roll between releases. */
        autoDeal?: boolean;
        autoDealerId?: number | null;
        commissionBps?: number;
      };
      players: RoomStatePlayer[];
      handActive: boolean;
      autoDealAt?: number | null;
      autoDealPaused?: boolean;
      readyCheck?: { deadlineTs: number; eligible: number[]; ready: number[] } | null;
    }
  | { t: 'error'; message: string }
  | {
      t: 'chat';
      from: string;
      userId: number;
      text: string;
      kind: 'text' | 'sticker' | 'phrase';
      ts: number;
    }
  | { t: 'rtc'; from: number; data: unknown }
  | { t: 'voice_state'; userId: number; muted: boolean }
  | { t: 'auto_deal'; inMs: number }
  | { t: 'ready_check'; deadlineTs: number; eligible: number[]; ready: number[] }
  | { t: 'ready_end' }
  | { t: 'seven_deuce'; handId: string; seat: number; amount: number }
  | {
      t: 'hand_start';
      handId: string;
      seats: HandSeat[];
      buttonSeat: number;
      sb: number;
      bb: number;
      auditMode: string;
    }
  | { t: 'key_commit_applied'; handId: string; seat: number; commit: string }
  | { t: 'shuffle_turn'; handId: string; seat: number; deck: string[] }
  | { t: 'deck_state'; handId: string; seat: number; deck: string[] }
  | {
      t: 'need_share';
      handId: string;
      deckIndex: number;
      point: string;
      forSeat: number | null;
      purpose: 'hole' | 'board' | 'showdown';
    }
  | {
      t: 'share_applied';
      handId: string;
      deckIndex: number;
      seat: number;
      out: string;
      forSeat: number | null;
    }
  | { t: 'your_card'; handId: string; deckIndex: number; point: string }
  | { t: 'board_open'; handId: string; deckIndex: number; card: CardId; run?: 1 | 2 | 3 }
  | { t: 'rit_offer'; handId: string; deadlineTs: number; voters: number[] }
  | { t: 'rit_result'; handId: string; runTwice: boolean; sharedBoard: CardId[] }
  | {
      t: 'betting_state';
      handId: string;
      actionSeq: number;
      state: BettingState;
      board: CardId[];
      /** Deadline for the current actor (ms epoch), or null when untimed. */
      deadline: number | null;
      /** Shared base clock deadline (ms epoch), or null when untimed.
       *  Optional while clients/servers roll between releases. */
      baseDeadline?: number | null;
      /** Per-seat time bank remaining (ms). Optional while rolling out. */
      timeBanks?: SeatTimeBank[];
    }
  | {
      t: 'action_applied';
      handId: string;
      seat: number;
      action: PlayerAction;
      auto?: boolean;
      /**
       * Authoritative, server-assigned 0-based index of this action among the
       * actions applied in this hand (the same counter `betting_state.actionSeq`
       * reports as "actions applied so far"). It is stable across a client
       * reconnect/missed frame, unlike a locally accumulated ordinal.
       * Optional only while clients/servers roll between releases; the server
       * always sends it. */
      actionSeq?: number;
    }
  | {
      t: 'showdown';
      handId: string;
      reveals: { seat: number; cards: CardId[]; score: number }[];
      awards: { seat: number; amount: number }[];
      /** Present when the table ran it twice: both boards + per-run awards. */
      runTwice?: {
        boards: [CardId[], CardId[]];
        awards: [{ seat: number; amount: number }[], { seat: number; amount: number }[]];
      };
      /** Present when the board was run 2 or 3 times (supersedes runTwice). */
      multiRun?: {
        boards: CardId[][];
        awards: { seat: number; amount: number }[][];
      };
    }
  // ---- new gameplay features ----
  | { t: 'feature_started'; handId?: string } & FeatureStartedPayload
  | { t: 'time_bank_update'; handId: string; seat: number; remainingMs: number }
  | {
      t: 'multi_run_offer';
      handId: string;
      decisionId: string;
      stage: MultiRunStage;
      aheadSeat: number;
      behindSeat: number;
      /** Pot equities of the all-in players, in basis points. */
      equities: MultiRunEquity[];
      /** How many runs the ahead player has asked for (set once chosen). */
      requestedRuns?: 1 | 2 | 3;
      deadlineTs: number;
    }
  | {
      t: 'multi_run_result';
      handId: string;
      runs: number;
      reason: MultiRunReason;
      sharedBoard: CardId[];
    }
  | {
      t: 'squid_result';
      handId: string;
      winners: number[];
      transfers: SquidTransfer[];
      requestedPerLoser: number;
      paidBySeat: SquidPayment[];
      /** Authoritative per-seat net for the hand. Always emitted by the engine;
       *  optional slot so older clients/tests that don't read it keep building. */
      netBySeat?: SquidNet[];
      noClaimant: boolean;
    }
  | {
      t: 'hand_end';
      handId: string;
      head: string;
      stacks: { seat: number; stack: number }[];
      deltas: { seat: number; delta: number }[];
      commission?: number;
      commissionBps?: number;
    }
  | { t: 'cards_shown'; handId: string; seat: number; cards: CardId[] }
  | {
      t: 'peek_offer';
      offerId: string;
      handId: string;
      fromUserId: number;
      fromName: string;
      targetSeat: number;
      amount: number;
    }
  | {
      t: 'peek_result';
      offerId: string;
      handId: string;
      targetSeat: number;
      status: 'accepted' | 'declined';
      amount: number;
      cards?: CardId[];
    }
  | { t: 'hand_abort'; handId: string; reason: string; blamedSeat: number | null }
  | { t: 'need_keys'; handId: string }
  | {
      t: 'transcript_entry';
      handId: string;
      seq: number;
      type: string;
      from: string;
      head: string;
    };

export type { BettingState, PlayerAction, Street };

// ---- new-gameplay server payload helpers ----

/** Multi-run negotiation stage: ahead player chooses, behind player agrees. */
export type MultiRunStage = 'choice' | 'agreement';

/** Why a multi-run decision resolved the way it did. `equity_failed` means the
 *  server could not compute equities in time, so the hand falls back to 1 run. */
export type MultiRunReason =
  | 'agreed'
  | 'declined'
  | 'timeout'
  | 'ineligible'
  | 'disabled'
  | 'equity_failed';

/** A player's pot equity expressed in basis points (10_000 = 100%). */
export interface MultiRunEquity {
  seat: number;
  bps: number;
}

/** One squid-game transfer between seats. */
export interface SquidTransfer {
  from: number;
  to: number;
  amount: number;
}

/** What a seat actually paid into the squid pot. */
export interface SquidPayment {
  seat: number;
  amount: number;
}

/** Authoritative per-seat squid outcome (positive = received, negative = paid).
 *  With multiple losers a seat can both pay and receive, so this - not
 *  `winners` - is the source of truth for chip movement. */
export interface SquidNet {
  seat: number;
  net: number;
}

/** Per-seat time bank snapshot. */
export interface SeatTimeBank {
  seat: number;
  remainingMs: number;
}

/** Payloads carried by `feature_started`. */
export interface FeatureStartedPayload {
  squid?: RoomGameplaySettings['squid'];
  bombPot?: RoomGameplaySettings['bombPot'];
}
