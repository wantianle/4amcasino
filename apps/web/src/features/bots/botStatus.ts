// Table bots (Phase 1 UI): the shared vocabulary between the seat pod, the
// host dialog and the ⋮ menu. The lifecycle states themselves are owned by
// apps/server/src/botRoutes.ts - this file only maps them to display copy.
import { DEFAULT_BOT_DIFFICULTY, RETIRED_BOT_DIFFICULTIES } from '@4am/shared';
import type { BotDifficulty, BotStatus } from '../../shared/api.ts';
import { t } from '../../shared/i18n/index.ts';

/** Visual weight of a bot status, shared by the pill on the felt and the
 *  badge in the dialog. */
export type BotTone = 'live' | 'busy' | 'wait' | 'bad' | 'gone';

export function botStatusTone(status: BotStatus | string): BotTone {
  switch (status) {
    case 'running':
      return 'live';
    case 'created':
    case 'starting':
    case 'stopping':
      return 'busy';
    case 'waiting_buy_approval':
    case 'ready':
      return 'wait';
    case 'error':
      return 'bad';
    default:
      return 'gone';
  }
}

/** Readable prose for every lifecycle state, including the two the host must
 *  act on: `waiting_buy_approval` (banker queue) and `error` (retry or drop). */
export function botStatusLabel(status: BotStatus | string): string {
  switch (status) {
    case 'created':
      return t('Just created');
    case 'waiting_buy_approval':
      return t('Waiting for buy-in approval');
    case 'ready':
      return t('Ready');
    case 'starting':
      return t('Starting up');
    case 'running':
      return t('Playing');
    case 'stopping':
      return t('Finishing the hand');
    case 'stopped':
      return t('Stopped');
    case 'error':
      return t('Hit an error');
    case 'removed':
      return t('Removed');
    default:
      return status;
  }
}

/** Play styles offered at the seat. These kinds are accepted by the server. */
export interface BotPolicyOption {
  kind: string;
  label: string;
  blurb: string;
  available: boolean;
}

/**
 * Sentinel for "let the server pick". It is never persisted: `BotsDialog` omits
 * `policyKind` from the create body when this is selected, so the server's
 * balanced-by-deficit draw runs. It must stay first in `BOT_POLICIES` so a fresh
 * dialog defaults to it.
 */
export const AUTO_BOT_POLICY_KIND = 'auto';

export const BOT_POLICIES: BotPolicyOption[] = [
  {
    kind: AUTO_BOT_POLICY_KIND,
    label: t('Auto (random)'),
    blurb: t('A balanced mix - the server fills in the style this table is short of.'),
    available: true,
  },
  {
    kind: 'scripted',
    label: t('Tight-aggressive'),
    blurb: t('Solid preflop ranges, strong when it has a hand.'),
    available: true,
  },
  {
    kind: 'loose-aggressive',
    label: t('Loose-aggressive'),
    blurb: t('Applies pressure with a wide range.'),
    available: true,
  },
  {
    kind: 'calling-station',
    label: t('Calling station'),
    blurb: t('Calls often, raises rarely.'),
    available: true,
  },
  {
    kind: 'constrained-random',
    label: t('Constrained random'),
    blurb: t('Makes varied choices while staying within legal moves.'),
    available: true,
  },
  {
    kind: 'llm',
    label: t('Large language model'),
    blurb: t(
      'Decides step by step; slower, needs a server key. Short action timers use local play, without a model request.',
    ),
    available: true,
  },
];

/** Style label for a bot's `policyKind` (unknown kinds read as-is). */
export function botPolicyLabel(kind: string): string {
  const normalized = kind
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const aliases: Record<string, string> = {
    scripted: 'scripted',
    tag: 'scripted',
    tight: 'scripted',
    'tight-aggressive': 'scripted',
    lag: 'loose-aggressive',
    loose: 'loose-aggressive',
    'loose-aggressive': 'loose-aggressive',
    station: 'calling-station',
    caller: 'calling-station',
    'calling-station': 'calling-station',
    random: 'constrained-random',
    rand: 'constrained-random',
    'constrained-random': 'constrained-random',
    llm: 'llm',
  };
  const canonical = aliases[normalized] ?? normalized;
  return BOT_POLICIES.find((p) => p.kind === canonical)?.label ?? kind;
}

export interface BotDifficultyOption {
  kind: BotDifficulty;
  label: string;
  blurb: string;
}

export const BOT_DIFFICULTIES: BotDifficultyOption[] = [
  { kind: 'low', label: t('Basic'), blurb: t('Uses the existing local rules.') },
  {
    kind: 'medium',
    label: t('Advanced'),
    blurb: t('Uses rules-v1 with modern preflop ranges and postflop heuristics.'),
  },
];

/** Tiers the product has retired but that may still be persisted on a legacy
 *  bot row. They run as the default tier, so the label reads that tier, not the
 *  raw value. The retired set itself is owned by @4am/shared. */
export function botDifficultyLabel(kind: string): string {
  const effective = (RETIRED_BOT_DIFFICULTIES as readonly string[]).includes(kind)
    ? DEFAULT_BOT_DIFFICULTY
    : (kind as BotDifficulty);
  return BOT_DIFFICULTIES.find((d) => d.kind === effective)?.label ?? kind;
}
