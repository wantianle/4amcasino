/** Typings for `check-commission-rate-invariant.mjs`, consumed by the vitest
 *  suite (which imports the `.mjs` directly). `tsc` needs this `.d.mts`
 *  companion for a NodeNext `.mjs` import. */
import type Database from 'better-sqlite3';

export interface CommissionRateGroup {
  roomId: string;
  canonicalRef: string | null;
  rows: number;
  distinctRates: number;
  /** Distinct effective rates in the group, ascending. */
  rates: number[];
  totalDelta: number;
  /** True when the group's rake is positive (the report would bucket it). */
  allocates: boolean;
}

export function commissionRateInvariantSql(): string;
export function commissionRateGroups(db: Database.Database): CommissionRateGroup[];
export function findCommissionRateViolations(db: Database.Database): CommissionRateGroup[];
export function openReadonly(dbPath: string): Database.Database;
