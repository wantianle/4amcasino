import { t } from '../../shared/i18n/index.ts';

/** Signed bb string. Mirrors the amount convention used elsewhere (leading `+`
 *  for gains, a plain `-` for losses). */
function signedBb(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * Room-HUD primary line: the TRUE net win over the last window, in bb.
 * `realNetBB` is the uncapped sum of per-hand `poker_delta / that hand's bb`
 * (each hand divided by its OWN blind). `netBB` is only the winsorized hot/cold
 * score and is deliberately NOT shown here, so a user never reads a capped
 * number as their actual net win.
 */
export function hudNetWinLine(streak: { realNetBB: number; sample: number } | null): string {
  if (!streak) return t('Last 50 hands: unavailable');
  return t('Last 50 hands net: {net} bb · {sample} hands', {
    net: signedBb(streak.realNetBB),
    sample: streak.sample,
  });
}

/**
 * Secondary/tooltip line that keeps the hot/cold score visible while labelling
 * it as winsorized. Returns null when there is no streak, so the caller can
 * omit the title entirely. The hot/cold `tier` badge rendering is untouched.
 */
export function hudStreakScoreLine(streak: { netBB: number } | null): string | null {
  if (!streak) return null;
  return t('Hot/cold score (winsorized): {net} bb', { net: signedBb(streak.netBB) });
}
