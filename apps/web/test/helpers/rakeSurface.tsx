/**
 * Off-DOM (plain Node) rendering harness for the two rake surfaces:
 * `RakeNotice` (the chip inside the result window) and `LastHandStrip` (the
 * durable recap strip).
 *
 * vitest runs with no DOM, so `renderToStaticMarkup` is the only renderer. Two
 * things are needed to render these widgets outside a browser:
 *
 *  1. Zustand v5's `useStore` hands React the store's *initial* state as the
 *     server snapshot (`getInitialState`), so a `setState` before
 *     `renderToStaticMarkup` would silently render the empty store. The shim
 *     below makes React's server snapshot read the live state instead - exactly
 *     what a hydrated client does. It only changes the test's own React, and
 *     nothing at product runtime.
 *  2. `LastHandStrip` reads the recap-open flag in a `useState` initializer, so
 *     `localStorage` must exist; `'on'` opens the strip so its rake line is on
 *     screen. It also renders a react-router `<Link>`, hence `MemoryRouter`.
 *
 * The exported helpers are deliberately thin: `renderLastHandStrip` returns the
 * real strip's markup, `renderRakeNotice` the real chip's, and
 * `renderTableRakeSurfaces` composes both under the SAME conditions TablePage
 * applies (see the result branch of `pages/table/TablePage.tsx`), so a test can
 * count how many `Rake N` figures are on screen at once.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { HandView, LastHandSnap } from '../../src/shared/store.ts';
import { emptyHand, useStore } from '../../src/shared/store.ts';
import { LastHandStrip, rakeTakenOf } from '../../src/widgets/table/LastHandStrip.tsx';
import { RakeNotice } from '../../src/widgets/table/RakeNotice.tsx';

const realUseSyncExternalStore = React.useSyncExternalStore;
(
  React as unknown as { useSyncExternalStore: typeof realUseSyncExternalStore }
).useSyncExternalStore = (subscribe, getSnapshot, _getServerSnapshot) =>
  realUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
  clear: () => mem.clear(),
});
mem.set('4am-last-hand', 'on');

/** Point the store at the given hand + recap before a render. */
export function setRakeState(hand: HandView, lastHand: LastHandSnap | null): void {
  useStore.setState({ hand, lastHand });
}

/** The real chip, as TablePage feeds it the hand's `-Σdeltas`. */
export function renderRakeNotice(amount: number): string {
  return renderToStaticMarkup(<RakeNotice amount={amount} />);
}

/** The real durable strip, rendered on its own (its hide rule still applies). */
export function renderLastHandStrip(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LastHandStrip roomId="rake-surface" />
    </MemoryRouter>,
  );
}

/** Both surfaces under TablePage's result branch (result window chip + the
 *  always-mounted strip), so `Rake N` occurrences can be counted across them. */
export function renderTableRakeSurfaces(hand: HandView, lastHand: LastHandSnap | null): string {
  useStore.setState({ hand, lastHand });
  // TablePage: `showResult = (hand.result !== null || hand.abort !== null) &&
  // !resultDismissed`; the result window is up in these tests.
  const showResult = hand.result !== null || hand.abort !== null;
  const resultRake = hand.result ? rakeTakenOf(hand.result.deltas) : 0;
  return renderToStaticMarkup(
    <MemoryRouter>
      {showResult && !hand.abort && hand.result && resultRake > 0 && (
        <RakeNotice amount={resultRake} />
      )}
      <LastHandStrip roomId="rake-surface" />
    </MemoryRouter>,
  );
}

/** A minimal valid recap for a completed hand. */
export function lastHandSnap(
  handId: string,
  deltas: { seat: number; delta: number }[],
): LastHandSnap {
  return {
    handId,
    ts: 1,
    board: [],
    board2: [],
    boards: [[]],
    reveals: [],
    shown: {},
    deltas,
    runTwice: null,
    names: {},
  };
}

/** A recap-open hand with no live result, so the strip is visible. */
export const emptyCurrentHand: HandView = { ...emptyHand, handId: 'current' };
