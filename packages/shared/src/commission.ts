/** One basis point = 0.01%. The current default; the platform can change it at runtime. */
export const NEW_ROOM_COMMISSION_BPS = 50;
/**
 * The historical 1% rate. NOT a default anymore: new rooms and every existing
 * room settle at `NEW_ROOM_COMMISSION_BPS` (0.5%). Kept only so the old rate
 * has a name when reading historical (already-charged) dues; the one-shot
 * `commission-0.5-1` migration snapshots those rates into
 * `hand_commission_rates` before rooms move to 0.5%, and the hash-chained
 * ledger itself is never rewritten.
 */
export const LEGACY_ROOM_COMMISSION_BPS = 100;

/** Whole chips only: floor each pot before awarding it or splitting its boards. */
export function commissionForPot(amount: number, commissionBps: number): number {
  return Math.floor((amount * commissionBps) / 10_000);
}

/**
 * Formats a rate. The default is the CURRENT rate (0.5%), not the historical
 * 1%: callers that mean a specific room's stored rate pass it explicitly.
 */
export function commissionRateLabel(commissionBps = NEW_ROOM_COMMISSION_BPS): string {
  return `${commissionBps / 100}%`;
}
