import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHIP_STACK_NATURAL_MAX_PX,
  ChipStack,
  fitChipStack,
} from '../src/widgets/table/ChipStack.tsx';

/**
 * L4b bet-stack markers + width budget.
 *
 * vitest runs in plain Node (no jsdom), so there is no real layout to measure:
 * `getBoundingClientRect()` would only ever report a tautological zero-width
 * box and could never fail. The width invariant is therefore pinned two ways:
 *
 *  - `fitChipStack()` is exported as a pure, DOM-free fitter and unit-tested
 *    directly;
 *  - the SSR render exposes the fitter's computed geometry as `data-chip-*`
 *    attributes, so the gate can assert "stack width ≤ budget" without parsing
 *    the decorative children.
 *
 * `renderToStaticMarkup` is the same SSR path the sibling widget tests use
 * (rakeNotice / resultFlash). Removing the markers or short-circuiting the
 * compression turns these cases red (verified by reverting each in turn).
 */

type Props = {
  amount: number;
  bb: number;
  sb?: number;
  size?: 'xs' | 'sm';
  className?: string;
  maxWidthPx?: number;
};

const markup = (props: Props) => renderToStaticMarkup(<ChipStack {...props} />);

/** The opening tag of the pile root (the element carrying the anchor). */
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

const width = (html: string): number => {
  const value = attr(html, 'data-chip-width');
  if (value === null) throw new Error('no data-chip-width on the pile root');
  return Number(value);
};

describe('ChipStack markers', () => {
  it('anchors the pile itself and stays decorative', () => {
    const html = markup({ amount: 4, bb: 2, size: 'xs' });
    expect(html).toContain('data-table-bet-stack');
    expect(root(html)).toContain('aria-hidden="true"');
  });

  it('exposes the amount, size tier and rendered column count', () => {
    const html = markup({ amount: 4, bb: 2, size: 'xs' });
    expect(attr(html, 'data-chip-amount')).toBe('4');
    expect(attr(html, 'data-chip-face')).toBe('xs');
    expect(attr(html, 'data-chip-columns')).toBe('1');
  });

  it('reports a different face tier per size', () => {
    expect(attr(markup({ amount: 4, bb: 2, size: 'xs' }), 'data-chip-face')).toBe('xs');
    expect(attr(markup({ amount: 4, bb: 2, size: 'sm' }), 'data-chip-face')).toBe('sm');
  });

  it('derives the rendered column count from the amount', () => {
    const columns = (amount: number) =>
      attr(markup({ amount, bb: 2, size: 'xs' }), 'data-chip-columns');
    // bb=2 -> sb unit = 1; these amounts hit 1..5 distinct denominations.
    expect(columns(4)).toBe('1');
    expect(columns(30)).toBe('2');
    expect(columns(130)).toBe('3');
    expect(columns(630)).toBe('4');
    expect(columns(631)).toBe('5');
  });

  it('renders nothing for a zero or negative amount', () => {
    expect(markup({ amount: 0, bb: 2 })).toBe('');
    expect(markup({ amount: -1, bb: 2 })).toBe('');
  });
});

describe('ChipStack width budget: default path', () => {
  it('reports the natural width and never compacts without maxWidthPx', () => {
    expect(width(markup({ amount: 4, bb: 2, size: 'xs' }))).toBe(11);
    expect(width(markup({ amount: 631, bb: 2, size: 'xs' }))).toBe(
      CHIP_STACK_NATURAL_MAX_PX.xs,
    );
    expect(width(markup({ amount: 631, bb: 2, size: 'sm' }))).toBe(
      CHIP_STACK_NATURAL_MAX_PX.sm,
    );
  });

  it('stays uncompressed when the natural pile already fits the budget', () => {
    const html = markup({ amount: 631, bb: 2, size: 'sm', maxWidthPx: 100 });
    expect(attr(html, 'data-chip-compact')).toBeNull();
    expect(attr(html, 'data-chip-overflow')).toBeNull();
    expect(width(html)).toBe(CHIP_STACK_NATURAL_MAX_PX.sm);
  });

  it('leaves the shared pot call shape intact (className + anchor)', () => {
    const html = markup({
      amount: 100,
      bb: 2,
      size: 'xs',
      className: 'table-pot-chips',
    });
    expect(root(html)).toContain('table-pot-chips');
    expect(html).toContain('data-table-bet-stack');
  });
});

describe('ChipStack width budget: compression', () => {
  it('shrinks the face while keeping every denomination', () => {
    const html = markup({ amount: 631, bb: 2, size: 'xs', maxWidthPx: 40 });
    expect(width(html)).toBeLessThanOrEqual(40);
    expect(attr(html, 'data-chip-compact')).toBe('true');
    expect(attr(html, 'data-chip-columns')).toBe('5');
    expect(attr(html, 'data-chip-overflow')).toBeNull();
    // the visual size must be unchanged: the budget only moves the geometry.
    expect(attr(html, 'data-chip-face')).toBe('xs');
  });

  it('folds the lowest tiers into a +N marker once the face floor is reached', () => {
    const html = markup({ amount: 631, bb: 2, size: 'xs', maxWidthPx: 30 });
    expect(width(html)).toBeLessThanOrEqual(30);
    expect(attr(html, 'data-chip-compact')).toBe('true');
    expect(attr(html, 'data-chip-columns')).toBe('2');
    expect(attr(html, 'data-chip-overflow')).toBe('3');
    expect(html).toContain('+3');
  });

  it.each([1_234_567, 9_999_999_999])(
    'keeps an extreme amount (%i) within the budget at xs',
    (amount) => {
      const html = markup({ amount, bb: 20, size: 'xs', maxWidthPx: 50 });
      expect(attr(html, 'data-chip-columns')).toBe('5');
      expect(width(html)).toBeLessThanOrEqual(50);
    },
  );
});

describe('fitChipStack', () => {
  it('is the identity when there is no budget', () => {
    expect(fitChipStack(5, 'xs')).toEqual({
      face: 11,
      gap: 3,
      columns: 5,
      overflow: 0,
      width: CHIP_STACK_NATURAL_MAX_PX.xs,
      compact: false,
    });
    expect(fitChipStack(5, 'sm').width).toBe(CHIP_STACK_NATURAL_MAX_PX.sm);
  });

  it('prefers squeezing the gaps before touching the face', () => {
    // n=5, faces only = 55; a 60px budget fits all faces with 1px gaps.
    expect(fitChipStack(5, 'xs', 60)).toEqual({
      face: 11,
      gap: 1,
      columns: 5,
      overflow: 0,
      width: 59,
      compact: true,
    });
  });

  it('keeps the invariant width <= budget across a range of budgets', () => {
    for (const budget of [67, 66, 55, 54, 40, 35, 30, 24, 20]) {
      const layout = fitChipStack(5, 'xs', budget);
      expect(layout.width).toBeLessThanOrEqual(budget);
    }
  });
});
