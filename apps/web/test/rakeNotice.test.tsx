import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RakeNotice } from '../src/widgets/table/RakeNotice.tsx';
import { rakeTakenOf } from '../src/widgets/table/LastHandStrip.tsx';
import { fmt } from '../src/shared/lib/cn.ts';
import { t } from '../src/shared/i18n/index.ts';

/**
 * The rake chip shown for the instant a hand ends.
 *
 * The whole point of the chip is the display CONDITION and the VALUE: exactly
 * the same `rakeTakenOf` (-sum(deltas), the players' side) figure the
 * last-hand strip reads, and nothing at all for an unraked hand. vitest runs in
 * plain Node (no jsdom), so we SSR-render and pin the markup; the real-browser
 * proof that it is on screen the moment the result window opens (and gone with
 * it) is `test/browser/hand-end-rake.mjs`.
 */

const markup = (amount: number) => renderToStaticMarkup(<RakeNotice amount={amount} />);
/** The exact token pair the last-hand strip composes: `t('Rake') <fmt(n)>`. */
const expected = (n: number) => `${t('Rake')} ${fmt(n)}`;

describe('RakeNotice', () => {
  it('renders the total raked when the hand ended positively raked', () => {
    // Winner nets +108, two losers -55 each: sum = -2 => 2 chips raked.
    const rake = rakeTakenOf([{ delta: 108 }, { delta: -55 }, { delta: -55 }]);
    expect(rake).toBe(2);
    expect(markup(rake)).toContain(expected(2));
  });

  it('uses the same figure the last-hand strip renders', () => {
    const deltas = [
      { delta: 878 },
      ...Array.from({ length: 8 }, () => ({ delta: -110 })),
    ];
    // The protocol invariant: sum(deltas) === -commission.
    expect(markup(rakeTakenOf(deltas))).toContain(expected(2));
  });

  it('renders nothing when the hand was not raked (no phantom "Rake 0")', () => {
    expect(markup(rakeTakenOf([{ delta: 110 }, { delta: -110 }]))).toBe('');
  });

  it('renders nothing for a zero or negative amount', () => {
    expect(markup(0)).toBe('');
    expect(markup(-1)).toBe('');
  });
});
