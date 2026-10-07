import { describe, expect, it } from 'vitest';
import type { HandView, LastHandSnap } from '../src/shared/store.ts';
import { emptyHand } from '../src/shared/store.ts';
import type { LifecycleMsg, LifecycleRegistries } from '../src/shared/handLifecycleReducer.ts';
import { handLifecycleReducer } from '../src/shared/handLifecycleReducer.ts';
import { fmt } from '../src/shared/lib/cn.ts';
import { t } from '../src/shared/i18n/index.ts';
import { roomState, handStart } from './helpers/fixtures.ts';
import { renderTableRakeSurfaces } from './helpers/rakeSurface.tsx';

/**
 * The boundary `ora-10` flagged on a57af95: through the real hand_end →
 * hand_start transition there must ALWAYS be exactly one `Rake N` on screen -
 * never 0, never 2. The two surfaces are disjoint by construction:
 *
 *  - result window (between hand_end and the next deal): ONLY the RakeNotice
 *    chip is visible; `LastHandStrip` self-hides because the just-frozen recap
 *    has `last.handId === hand.handId`;
 *  - after hand_start: the chip is gone with the result window and ONLY the
 *    strip remains, showing the previous hand's rake.
 *
 * The states are produced by the REAL `handLifecycleReducer` from real
 * hand_end / hand_start frames (not hand-built), and the markup by the real
 * surfaces (`helpers/rakeSurface.tsx`). A regression in either gate - the
 * strip's handId hide rule, or the chip's result-window lifetime - turns the
 * count into 2 (or 0) and fails here.
 */

interface SurfaceState {
  hand: HandView;
  lastHand: LastHandSnap | null;
}

const REG: LifecycleRegistries = {
  terminalHands: new Set(),
  endedHands: new Set(),
  foldedByMe: new Set(),
};

/** Applies the reducer's store ops, as gameClient's runner would. */
function run(state: SurfaceState, msg: LifecycleMsg): SurfaceState {
  const { ops } = handLifecycleReducer(
    {
      hand: state.hand,
      lastHand: state.lastHand,
      room: roomState(1),
      registries: REG,
      userId: 1,
      resync: false,
      now: () => 1,
      handKey: () => null,
    },
    msg,
  );
  const next: SurfaceState = { hand: state.hand, lastHand: state.lastHand };
  for (const op of ops) {
    if (!('store' in op)) continue;
    if (op.store === 'hand') {
      next.hand = 'reset' in op ? { ...emptyHand, ...op.reset } : { ...next.hand, ...op.patch };
    } else if (op.store === 'lastHand') {
      next.lastHand = op.set;
    }
  }
  return next;
}

const DELTAS = [
  { seat: 0, delta: 108 },
  { seat: 1, delta: -55 },
  { seat: 2, delta: -55 },
];
// sum(deltas) === -2, so the one honest figure on screen is "Rake 2".
const RAKE_LINE = `${t('Rake')} ${fmt(2)}`;
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

const liveHand = (handId: string): HandView => ({
  ...emptyHand,
  handId,
  seats: handStart(handId, 1).seats,
});

describe('hand_end → hand_start: exactly one Rake surface', () => {
  it('has the chip in the result window and only the strip once the next hand starts', () => {
    const atEnd = run({ hand: liveHand('H1'), lastHand: null }, {
      t: 'hand_end',
      handId: 'H1',
      head: 'qa',
      stacks: [],
      deltas: DELTAS,
    });
    // The real reducer froze the recap for THIS hand and settled the hand.
    expect(atEnd.lastHand?.handId).toBe('H1');
    expect(atEnd.hand.handId).toBe('H1');
    expect(atEnd.hand.result).not.toBeNull();
    expect(atEnd.lastHand && atEnd.hand.handId === atEnd.lastHand.handId).toBe(true);

    const during = renderTableRakeSurfaces(atEnd.hand, atEnd.lastHand);
    expect(count(during, RAKE_LINE)).toBe(1);
    // The one figure is the chip; the strip hid itself on the shared handId.
    expect(during).toContain('data-testid="rake-notice"');
    expect(during).not.toContain(t('Last hand'));

    const atStart = run(atEnd, handStart('H2', 1));
    expect(atStart.hand.handId).toBe('H2');
    expect(atStart.hand.result).toBeNull();
    expect(atStart.lastHand?.handId).toBe('H1');

    const after = renderTableRakeSurfaces(atStart.hand, atStart.lastHand);
    expect(count(after, RAKE_LINE)).toBe(1);
    // The chip left with the result window; the strip is now the one surface.
    expect(after).not.toContain('data-testid="rake-notice"');
    expect(after).toContain(t('Last hand'));
  });
});
