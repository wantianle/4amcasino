import { t } from '../../shared/i18n/index.ts';

/** Signed bb string. Mirrors the amount convention used elsewhere (leading `+`
 *  for gains, a plain `-` for losses). */
function signedBb(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

/**
 * Room-HUD primary line: the TRUE net win over the last window, in bb.
 * `realNetBB` is the uncapped sum of per-hand `poker_delta / that hand's bb`
 * (each hand divided by its OWN blind). It is the only score now: the same
 * value also drives the hot/cold badge tier.
 */
export function hudNetWinLine(streak: { realNetBB: number; sample: number } | null): string {
  if (!streak) return t('Last 50 hands: unavailable');
  return t('Last 50 hands net: {net} bb · {sample} hands', {
    net: signedBb(streak.realNetBB),
    sample: streak.sample,
  });
}
