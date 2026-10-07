import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChipStack } from '../src/widgets/table/ChipStack.tsx';

/**
 * L4b blocker: the chip piles are SB-denominated, so every felt consumer must
 * hand `ChipStack` the room's REAL small blind. Rooms whose structure is not
 * `sb = bb/2` (1/3, 2/5, 5/10 …) silently rendered the wrong denominations
 * because `TablePage` passed only `bb` and `ChipStack` fell back to the
 * standard derivation. These checks pin both halves:
 *
 *  - the model: an explicit `sb` produces a different (correct) split than the
 *    `bb/2` fallback, and standard structures are unchanged;
 *  - the wiring: `TablePage` actually passes `room.room.sb` to the felt
 *    (`RoundTable` → street bets) and to the center-pot `ChipStack`.
 *
 * The wiring half is a source assertion because vitest runs in plain Node and
 * `TablePage` is a store/router-bound page: a static marker in the JSX is the
 * only DOM-free way to prove the prop is present (same technique as
 * bettingPanel.test.ts). Removing either `sb={…}` turns these cases red.
 */

type Props = {
  amount: number;
  bb: number;
  sb?: number;
  size?: 'xs' | 'sm';
};

const markup = (props: Props) => renderToStaticMarkup(<ChipStack {...props} />);

const root = (html: string): string => {
  const m = /<div[^>]*data-table-bet-stack[^>]*>/.exec(html);
  if (!m || m[0] === undefined) throw new Error('no [data-table-bet-stack] root in markup');
  return m[0];
};

const attr = (html: string, name: string): string | null => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(root(html));
  const value = m?.[1];
  return value === undefined ? null : value;
};

const columns = (props: Props): string | null => attr(markup(props), 'data-chip-columns');

const readSource = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

describe('chip denominations follow the real small blind', () => {
  it('splits a non-standard structure differently than the bb/2 fallback', () => {
    // Room 1/3: sb=1, bb=3. 630 chips -> 500+100+25+5 = 4 distinct tiers.
    expect(columns({ amount: 630, bb: 3, sb: 1 })).toBe('4');
    // Without the real sb the widget derives sb=round(3/2)=2: 200×3 + 10×3 = 2.
    expect(columns({ amount: 630, bb: 3 })).toBe('2');
  });

  it('treats an explicit sb as authoritative, independent of bb', () => {
    // Same real sb, different bb: the pile must not move.
    expect(columns({ amount: 630, bb: 3, sb: 1 })).toBe(
      columns({ amount: 630, bb: 1, sb: 1 }),
    );
  });

  it('keeps a standard structure byte-identical whether sb is passed or derived', () => {
    // 5/10: the room sb (5) equals sbFromBb(10) → passing it changes nothing.
    expect(markup({ amount: 250, bb: 10, sb: 5 })).toBe(markup({ amount: 250, bb: 10 }));
  });

  it('picks the room sb for a 2/5 room too (not bb/2)', () => {
    // 2/5: real sb = 2, but the bb/2 fallback derives round(5/2) = 3.
    // 250 chips: sb=2 -> 200 + 50 (2 tiers); sb=3 -> 75×3 + 15 + leftover (3).
    expect(columns({ amount: 250, bb: 5, sb: 2 })).toBe('2');
    expect(columns({ amount: 250, bb: 5 })).toBe('3');
    // The real sb=2 is exactly the standard sb of a 4 BB, so it must render
    // identically to a room whose derived structure already equals it.
    expect(markup({ amount: 250, bb: 5, sb: 2 })).toBe(markup({ amount: 250, bb: 4 }));
  });
});

describe('TablePage hands the real sb to every chip consumer', () => {
  const source = readSource('src/pages/table/TablePage.tsx');

  it('passes room.room.sb into RoundTable (street-bet piles)', () => {
    expect(source).toMatch(/bb=\{room\.room\.bb\}\s*\n\s*sb=\{room\.room\.sb\}/);
  });

  it('passes room.room.sb into the center-pot ChipStack', () => {
    expect(source).toMatch(
      /<ChipStack amount=\{pot\} bb=\{room\?\.room\.bb \?\? 1\} sb=\{room\?\.room\.sb\}/,
    );
  });

  it('keeps RoundTable forwarding its sb prop to the street-bet ChipStack', () => {
    const roundTable = readSource('src/widgets/table/RoundTable.tsx');
    expect(roundTable).toMatch(/amount=\{committed\}\s*\n\s*bb=\{bb\}\s*\n\s*sb=\{sb\}/);
  });
});
