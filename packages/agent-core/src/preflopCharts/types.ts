import type { RangeRole } from '../rangeParser.js';

/**
 * Headcount-adaptive preflop charts: intermediate `preflop-chart/v1` format and
 * the raw provider subset it is built from.
 *
 * The intermediate chart deliberately carries *both* the raw provider metadata
 * (`source`) and the derived per-hand action mix, so a persisted chart is
 * self-describing and auditable back to the upstream solver export.
 */

/** Provenance of an extracted raw provider subset. */
export interface RawProvenance {
  provider: string;
  url: string;
  commit: string;
  ref: string;
  license: string;
  capturedAt: string;
  sourceFile: string;
  note: string;
}

/**
 * One hand's action frequencies as `[raise, allin, call]`. The fold frequency is
 * `1 - raise - allin - call`; a hand absent from a spot is a pure fold. Storing
 * the triple (rather than four numbers) keeps the data subset compact.
 */
export type RawTriple = readonly [number, number, number];

export type RawSpot = Record<string, RawTriple>;

export interface RawChartFile {
  provenance: RawProvenance;
  spots: Record<string, RawSpot>;
}

/** Enriched, fully-normalised action mix for one hand class. */
export interface ChartMix {
  raise: number;
  allin: number;
  call: number;
  fold: number;
  /**
   * Raise role used when the mix is converted back to `RangeEntry[]`. `value`
   * when the hand never folds and raises; `bluff` when raise and fold mix;
   * `null` when the hand does not raise at all.
   */
  raiseRole: RangeRole | null;
}

export type ChartSituation = 'unopened' | 'facingOpen' | 'facing3Bet';

export interface ChartGame {
  /** Players dealt into the hand. */
  seats: number;
  format: '6max' | '9max' | 'short' | 'hu';
  depthBB: number;
  openSizeBB: number;
}

export interface ChartSpot {
  situation: ChartSituation;
  /** Acting position, when a single seat acts (used for documentation). */
  actor: string | null;
  /** Canonical behind-unacted slot B0..B8 for the hero. */
  actorSlot: number;
  /** Opener position, when the spot is facing a raise. */
  opener: string | null;
  /** Canonical behind-unacted slot of the opener, when there is one. */
  openerSlot: number | null;
  activeCount: number;
  behindUnacted: number;
}

export interface ChartSource {
  provider: string;
  url: string;
  commit: string;
  capturedAt: string;
  usage: string;
}

/** `preflop-chart/v1`: all 169 classes, each cell normalised to sum 1. */
export interface PreflopChart {
  schema: 'preflop-chart/v1';
  id: string;
  game: ChartGame;
  spot: ChartSpot;
  source: ChartSource;
  mix: Record<string, ChartMix>;
}
