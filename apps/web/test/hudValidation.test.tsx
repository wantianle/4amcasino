import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidHudPlayer, streakBadgeFor } from '../src/widgets/table/SeatBadges.tsx';
import { SeatBadges } from '../src/widgets/table/SeatBadges.tsx';
import type { HudPlayer } from '../src/features/stats/types.ts';
import { t } from '../src/shared/i18n/index.ts';

const hudPlayer = (tier: 'hot2' | 'hot1' | 'cold1' | 'cold2' | null, vpipPct: number | null = 20) => ({
  userId: 1, username: 'probe', displayName: 'Probe', hidden: false, sample: 30,
  minHands: 20, sufficient: true, confidence: 'ok' as const, dataConfidence: 'exact' as const,
  stats: { vpip: { hits: 6, opportunities: vpipPct === null ? 0 : 30, pct: vpipPct, unit: 'pct' as const } },
  streak: tier === null ? null : { tier, netBB: tier.startsWith('hot') ? 42 : -42, realNetBB: tier.startsWith('hot') ? 400 : -400, sample: 30 },
});

describe('RoomHud player validation', () => {
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid userId %s', (userId) => {
    expect(isValidHudPlayer({ userId })).toBe(false);
  });

  it('accepts a positive integer userId', () => {
    expect(isValidHudPlayer({ userId: 1 })).toBe(true);
    expect(isValidHudPlayer({ userId: 42 })).toBe(true);
  });

  it('rejects malformed player elements', () => {
    expect(isValidHudPlayer(null)).toBe(false);
    expect(isValidHudPlayer({})).toBe(false);
    expect(isValidHudPlayer('player')).toBe(false);
  });

  it('distinguishes large and small fire/ice badges and hides neutral tiers', () => {
    expect(streakBadgeFor('hot2')?.glyph).not.toBe(streakBadgeFor('hot1')?.glyph);
    expect(streakBadgeFor('cold2')?.glyph).not.toBe(streakBadgeFor('cold1')?.glyph);
    expect(streakBadgeFor(null)).toBeNull();
    expect(streakBadgeFor(undefined)).toBeNull();
  });

  it.each(['hot2', 'hot1', 'cold1', 'cold2'] as const)('renders %s exactly once with translated labels', (tier) => {
    const markup = renderToStaticMarkup(<SeatBadges player={hudPlayer(tier)} minHands={20} />);
    expect(markup.match(/data-streak-tier=/g)).toHaveLength(1);
    expect(markup).toContain(`data-streak-tier="${tier}"`);
    expect(markup).toContain(`aria-label="${t(streakBadgeFor(tier)!.label)}"`);
    expect(markup).toContain(`title="${t(streakBadgeFor(tier)!.label)}"`);
  });

  it('renders a valid streak when VPIP is unavailable', () => {
    const markup = renderToStaticMarkup(<SeatBadges player={hudPlayer('hot1', null)} minHands={20} />);
    expect(markup).toContain('data-streak-tier="hot1"');
  });

  it.each<[string, Partial<Omit<HudPlayer, 'streak'>> & { streak?: HudPlayer['streak'] }]>([
    ['hidden with nonempty streak', { hidden: true }],
    ['insufficient with nonempty streak', { sufficient: false }],
    ['low sample with nonempty streak', { sample: 19 }],
    ['player minimum with nonempty streak', { minHands: 31 }],
    ['insufficient confidence with nonempty streak', { confidence: 'insufficient' }],
    ['invalid player with nonempty streak', { userId: 0 }],
    ['neutral tier', { streak: { tier: null, netBB: 12, realNetBB: 9, sample: 30 } }],
    ['null streak', { streak: null }],
    ['undefined legacy streak', { streak: undefined }],
  ])('does not render a badge: %s', (_name, overrides) => {
    // Explicit undefined survives the spread; it does not trigger a default argument.
    const player = { ...hudPlayer('hot1'), ...overrides } as HudPlayer;
    const markup = renderToStaticMarkup(<SeatBadges player={player} minHands={20} />);
    expect(markup).not.toContain('data-streak-tier=');
    expect(markup).not.toContain('🔥');
  });
  it('respects the room minimum with nonempty streak', () => {
    expect(renderToStaticMarkup(<SeatBadges player={hudPlayer('hot1')} minHands={31} />)).not.toContain('data-streak-tier=');
  });
});
