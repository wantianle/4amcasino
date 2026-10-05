/** THE single source of truth for 2D table geometry (Phase 1 of the table UI
 *  refactor, docs audit H1/H2). Every number that positions something on the
 *  felt — the canvas, the ellipse layers, the seat ring, the bet ring, the pot
 *  sweep target, the center column and its size budget — lives here, so the
 *  shapes can be changed together instead of one magic constant at a time.
 *
 *  Percentages are of the canvas (w for x, h for y); px values are DESIGN px
 *  in the unscaled canvas — the whole canvas is uniformly scaled by `k`, so
 *  they all shrink together.
 *
 *  Consumers: RoundTable (positions everything from here), TablePage (center
 *  column budget + compact tier), ReplayPage (inherits via RoundTable).
 *  Phone has its own taller oval (PHONE_CANVAS, 548×410 — see below), never stretched. */

export const SEAT_COUNT = 9;

/** A locked table canvas: pixel size + the seat-ring percentages. */
export interface TableCanvas {
  w: number;
  h: number;
  rx: number;
  ryNear: number;
  ryFar: number;
  /** Worst-case pod height IN DESIGN PX on this canvas — the center column's
   *  size budget clears pods by this much above and below. Desktop pods are
   *  the full plaque; the phone's compact grid pod is much shorter (L6). */
  podWorstPx: number;
}

/** A3: the locked design canvas. Ellipse = 87%×60% of the canvas; rx/ry are
 *  the SEAT RING percentages — the pods grow off those points via anchorOf(),
 *  so the near ring sits deep enough (40) for the bottom pod — cards, plate,
 *  action pill — to clear both the board and the rim. */
export const TABLE_CANVAS: TableCanvas = {
  w: 1180,
  h: 660,
  rx: 45,
  ryNear: 40,
  ryFar: 33,
  podWorstPx: 150,
};

/** L6: the phone canvas is NOT the desktop one at 1/2 — a half-scale 590×330
 *  oval cannot fit a 9-seat ring, because pod CSS px do not shrink with the
 *  canvas and the bottom arc's adjacent ring points only sit ~31–78 design px
 *  apart at that height, far below any readable pod. The phone therefore gets
 *  a TALLER oval of its own: 548×410. The width is capped by the narrowest
 *  supported phone: at K_FLOOR the canvas is 548·0.55 ≈ 301.4 design px, so a
 *  320px viewport (304 CSS px of stage after the page's p-2) still fits
 *  WITHOUT scrolling, and the extra height vs the desktop half-scale spreads
 *  the bottom arc so the compact phone pods (podWorstPx=122) and the board
 *  column clear each other: the ±40° seats' ring points sit 39 design px
 *  below the hero's but ~155 design px to its side — wider than any 78px pod
 *  — so no phone pod ever has to hang. rx/ry keep the ellipse at ~44%/41%
 *  proportions of the new box. */
export const PHONE_CANVAS: TableCanvas = {
  w: 548,
  h: 410,
  rx: 44,
  ryNear: 41,
  ryFar: 33,
  podWorstPx: 122,
};

/** Feedback #1: never scale below the readability floor — past it the stage
 *  scrolls instead of shrinking into illegibility. The caps stop a huge
 *  monitor from ballooning the table past its designed proportions. */
export const K_FLOOR = 0.55;
export const K_CAP_DESKTOP = 1.3;
export const K_CAP_PHONE = 0.9;

/** The isometric table, bottom-up: ground shadow, the table's dark side, the
 *  charcoal rail top, and the felt inset on it. dropPx is how far below the
 *  canvas center each layer sits (the thickness cue).
 *  (L1: the racetrack stitch ellipse was dropped by the rev-3 design; the
 *  paint for these layers lives in app/table-surface.css, sizes stay here.) */
export const FELT = {
  shadow: { wPct: 88, hPct: 60, dropPx: 36 },
  side: { wPct: 87, hPct: 60, dropPx: 26 },
  rim: { wPct: 87, hPct: 60, dropPx: 0 },
  inset: { wPct: 83, hPct: 56, dropPx: 1 },
} as const;

/** The tighter ellipse between the seats and the pot where each seat's
 *  street-bet pile + D/SB/BB discs ride. The straight-bottom seat gets a
 *  sideways nudge (feedback v2 #1): there is no vertical room left between
 *  the river card and a full pod, so its pile sits just off the center line.
 *  Deliberately NOT halved on the phone canvas — the phone's own ring lives
 *  in BET_RING_PHONE below. */
export const BET_RING = {
  rxPct: 27,
  ryPct: 19,
  nudgePct: 13,
  nudgeSinMin: 0.55,
  nudgeCosAbsMax: 0.35,
} as const;

/** L6 phone bet ring. The phone oval has NO free band between the board
 *  column's bottom and the ±40° pods' tops, so the ring splits near/far radii
 *  like the seat ring does: near piles ride ry 25 — just under the board's
 *  budget floor, above the pods' top edge — while far piles tuck up to 7,
 *  the only lane left between the far pods and the pot pill. The hero nudge
 *  grows to ±42 because at phone scale every narrower offset lands the pile
 *  on a neighbour's pod; pushed wide, it sits on open felt beside the bottom
 *  seats' outer corners. */
export const BET_RING_PHONE = {
  rxPct: 31,
  ryPct: 25,
  ryFarPct: 7,
  nudgePct: 42,
  nudgeSinMin: 0.9,
  nudgeCosAbsMax: 0.35,
} as const;

export type BetRing = {
  rxPct: number;
  ryPct: number;
  /** far-half radius; defaults to ryPct (the desktop ring is a single
   *  ellipse - only the phone oval splits it, see BET_RING_PHONE). */
  ryFarPct?: number;
  nudgePct: number;
  nudgeSinMin: number;
  nudgeCosAbsMax: number;
};

/** Where a street-closing bet pile sweeps to (just above the canvas center,
 *  i.e. into the pot row). */
export const POT_SWEEP_TARGET = { xPct: 50, yPct: 44 } as const;

/** How a pod is anchored to its ring point so it can never be clipped by the
 *  canvas edge or the stage scroll box: pods at the far left/right edge grow
 *  toward the table's interior (|cos| past sideFlipCos), bottom-arc pods hang
 *  ABOVE their anchor (sin past hangSin) with hangGapPx of clearance. */
export const SEAT_ANCHOR = {
  sideFlipCos: 0.7,
  hangSin: 0.55,
  hangGapPx: 12,
} as const;

export type SeatAnchor = {
  sideFlipCos: number;
  hangSin: number;
  hangGapPx: number;
};

/** L6 phone anchors. On the tall 548×410 oval NO phone pod hangs and none
 *  flips: the ±40° seats clear the hero HORIZONTALLY (ring points ~80 design
 *  px apart vs an 80px pod), and a side flip would grow the ±170° pods
 *  TOWARD the board column — measured worse than their ~3px canvas-edge
 *  overhang (which lands in the scroll gutters). hangSin past 1 keeps the
 *  hero centred on its ring point so the full showdown pod cannot climb into
 *  the board's budget; only its pill row spills into the strip under the
 *  canvas, which the console layout reserves. */
export const SEAT_ANCHOR_PHONE: SeatAnchor = {
  sideFlipCos: 1.01,
  hangSin: 1.01,
  hangGapPx: 12,
};

/** The lone sit spot shown when the table is empty. */
export const SIT_SPOT_EMPTY = { xPct: 50, yPct: 84 } as const;

/** The pot/board/status column (A5): centered on the canvas, `widthPct` wide.
 *
 *  SIZE BUDGET (audit H2): the column is opaque content (pot, board rows,
 *  feature banners, run prompts, squid summary) while the seat pods are
 *  opaque too — when the column grows past its budget it collides with the
 *  bottom pods (the 3-run baseline shows run 3 covering the hero's plate).
 *  The budget is the largest height that stays clear of BOTH the bottom-arc
 *  pods (which hang above their ring point) and the far pods (centered on
 *  theirs), assuming a worst-case pod of podWorstPx. RoundTable measures the
 *  column and scales it down to the budget when `centerBudget` is on;
 *  TablePage switches to the compact tier (smaller cards, collapsed gaps)
 *  first. The clamp is a BACKSTOP, not a guarantee: it scales uniformly down
 *  to minScale (0.72), and an extreme pile (3 runs + banners + summary) can
 *  still overrun the budget past that floor and touch a pod. */
export const CENTER_COLUMN = {
  xPct: 50,
  yPct: 50,
  /** EFFECTIVE MULTI-RUN boards only (server-declared runs > 1, or a
   *  non-empty extra run already dealt; a legacy declined-rit placeholder
   *  `[]` does NOT count): the column rides
   *  2% higher so the taller equal-row stack keeps bottom clearance from the
   *  hero pod and the bet ellipse. Single-run stacks - banner/summary piles
   *  included - always stay at yPct (baseline anchor). */
  compactYPct: 48,
  widthPct: 66,
  /** the clamp never shrinks the column below this — past it the board is
   *  not readable and the compact tier should have caught the overflow */
  minScale: 0.72,
} as const;

/** Largest design-px height the center column can occupy without touching the
 *  nearest pods above/below. The column is centered, so the budget is twice
 *  the smaller of the two clearances. The pod worst case is per-canvas (L6):
 *  the phone's compact grid pod is much shorter than the desktop plaque.
 *  L6: the bottom limit is the HIGHEST bottom-arc pod edge — the hero's
 *  (hung above its anchor, or centred on it when the anchor never hangs)
 *  and the ±40° neighbours a 9-seat ring puts next to the hero. Desktop
 *  keeps its historical 204px: its hanging hero (432) is still higher than
 *  the 40° edge (453), so the min() changes nothing there. */
export function centerColumnBudgetPx(
  canvas: TableCanvas,
  anchor: SeatAnchor = SEAT_ANCHOR,
  heroHoloOverhangPx = 0,
): number {
  const center = canvas.h / 2;
  const bottomAnchor = (canvas.h * (50 + canvas.ryNear)) / 100;
  const topAnchor = (canvas.h * (50 - canvas.ryFar)) / 100;
  // Face-up hero cards sit above the plaque. This is deliberately an explicit
  // caller-supplied allowance: empty tables, opponents' face-down fans, and
  // replay layouts keep the historical budget unchanged.
  const heroTop =
    anchor.hangSin > 1
      ? bottomAnchor - canvas.podWorstPx / 2 - heroHoloOverhangPx
      : bottomAnchor - anchor.hangGapPx - canvas.podWorstPx - heroHoloOverhangPx;
  // The seat beside a 9-seat hero sits at 90° − 360°/9 = 50°; its pod is
  // centred on its ring point, so that top edge (+ a small margin) is what
  // the column must clear.
  const SIDE_NEIGHBOR_ANGLE = (50 * Math.PI) / 180;
  const NEIGHBOR_CLEARANCE_PX = 4;
  const side40Top =
    (canvas.h * (50 + canvas.ryNear * Math.sin(SIDE_NEIGHBOR_ANGLE))) / 100 -
    canvas.podWorstPx / 2 -
    NEIGHBOR_CLEARANCE_PX;
  const bottomLimit = Math.min(heroTop, side40Top);
  const topLimit = topAnchor + canvas.podWorstPx / 2;
  return 2 * Math.min(center - topLimit, bottomLimit - center);
}

/** Seats are spread evenly around the oval starting at the bottom (90°);
 *  the caller rotates the order so the hero's seat is index 0. */
export function angleOf(idx: number, n: number): number {
  return (Math.PI / 180) * (90 + (idx / n) * 360);
}

/** A point on the seat ring. Near seats use ryNear, far seats ryFar, so the
 *  bottom of the ring dips deep enough for the hanging pods. */
export function seatPoint(
  a: number,
  canvas: TableCanvas,
): { x: number; y: number; sin: number; cos: number } {
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const ry = sin > 0 ? canvas.ryNear : canvas.ryFar;
  return { x: 50 + canvas.rx * cos, y: 50 + ry * sin, sin, cos };
}

/** A point on the bet ring for the seat at angle `a`, including the
 *  straight-bottom sideways nudge. `ring` lets the phone pass its own,
 *  wider-spaced ellipse (BET_RING_PHONE); the desktop default is unchanged. */
export function betPoint(a: number, ring: BetRing = BET_RING): { x: number; y: number } {
  const s = Math.sin(a);
  const c = Math.cos(a);
  const nudge =
    s > ring.nudgeSinMin && Math.abs(c) < ring.nudgeCosAbsMax
      ? c >= 0
        ? ring.nudgePct
        : -ring.nudgePct
      : 0;
  const ry = s > 0 ? ring.ryPct : (ring.ryFarPct ?? ring.ryPct);
  return { x: 50 + ring.rxPct * c + nudge, y: 50 + ry * s };
}

/** The translate() that anchors a pod to its ring point (see SEAT_ANCHOR).
 *  `anchor` lets the phone use SEAT_ANCHOR_PHONE (no pod hangs or flips); the
 *  desktop default is unchanged. */
export function anchorOf(
  sin: number,
  cos: number,
  anchor: SeatAnchor = SEAT_ANCHOR,
): { tx: string; ty: string } {
  const tx = cos > anchor.sideFlipCos ? '-100%' : cos < -anchor.sideFlipCos ? '0%' : '-50%';
  // the gap keeps even the fullest bottom pod clear of the community cards
  const ty = sin > anchor.hangSin ? `calc(-100% - ${anchor.hangGapPx}px)` : '-50%';
  return { tx, ty };
}

/** L3: can the feature ribbon ride the top rail band, or must it flow at the
 *  head of the center column? Seats spread evenly at 90° + i·360/n, and the
 *  rail band under the canvas top is clear only when NO seat sits near
 *  top-center (270°). The stable rail-safe set is 1/3/5 seated players —
 *  nearest top seat ≥36° away, wider than the English ribbon's half-span.
 *  7p measures 25.7° (borderline — English text clips under the top seats'
 *  fans) and 2/4/6/8/9 have a seat at or within 20° of top-center, so they
 *  all take the column fallback. Shared by RoundTable (placement) and
 *  TablePage (column budget) so the two can never drift apart. */
export function ribbonFitsRail(seatCount: number): boolean {
  return seatCount === 1 || seatCount === 3 || seatCount === 5;
}
