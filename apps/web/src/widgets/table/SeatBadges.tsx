import type { HudPlayer, StreakTier } from '../../features/stats/types.ts';
import { t } from '../../shared/i18n/index.ts';

export function isValidHudPlayer(value: unknown): value is HudPlayer {
  const userId = value && typeof value === 'object' ? (value as { userId?: unknown }).userId : undefined;
  return Number.isInteger(userId) && (userId as number) > 0;
}

export function vpipTone(value: number) {
  return value < 10 ? 'red' : value < 20 ? 'yellow' : value < 30 ? 'green' : value < 40 ? 'blue' : 'purple';
}
const streakBadge: Record<StreakTier, { glyph: string; label: string; className: string }> = {
  hot2: { glyph: '♨', label: 'Big hot streak', className: 'border-orange-300/70 text-orange-200 bg-orange-950/70 px-1.5' },
  hot1: { glyph: '🔥', label: 'Hot streak', className: 'border-amber-300/60 text-amber-200 bg-amber-950/60 px-1' },
  cold1: { glyph: '❄', label: 'Cold streak', className: 'border-cyan-300/60 text-cyan-200 bg-cyan-950/60 px-1' },
  cold2: { glyph: '❄❄', label: 'Big cold streak', className: 'border-sky-300/70 text-sky-100 bg-sky-950/70 px-1.5' },
};
export function streakBadgeFor(tier: StreakTier | null | undefined) { return tier == null ? null : streakBadge[tier]; }

export function SeatBadges({ player, minHands }: { player?: HudPlayer; minHands: number }) {
  const value = player?.stats?.vpip?.pct;
  const hudVisible = player && isValidHudPlayer(player) && !player.hidden && player.sufficient && player.confidence !== 'insufficient'
    && player.sample >= Math.max(minHands, player.minHands);
  const visible = hudVisible && value != null;
  const streak = player?.streak?.tier == null ? null : streakBadgeFor(player.streak.tier);
  return <span className="table-seat-badges">
    {visible && <span className={`table-vpip table-vpip--${vpipTone(value)}`} title={`VPIP ${value}% · ${player.sample}`} aria-label={`VPIP ${value}%`}>{Math.round(value)}</span>}
    {/* VPIP owns the five color tones; streak relies on fire/ice glyph shape first. */}
    {hudVisible && streak && <span data-streak-tier={player.streak!.tier} className={`inline-flex h-[15px] min-w-[15px] items-center justify-center rounded border text-[10px] font-bold leading-none ${streak.className}`} title={t(streak.label)} aria-label={t(streak.label)}>{streak.glyph}</span>}
  </span>;
}
