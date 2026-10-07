import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultFlash } from '../src/widgets/table/ResultFlash.tsx';
import { t } from '../src/shared/i18n/index.ts';

/**
 * ResultFlash overflow regression.
 *
 * The pill is `flex max-w-full`, so every unshrinkable child pushes the rest of
 * the row past `max-w-full` and off the screen. `detail` used to be `shrink-0`,
 * which meant a long server reason (hand_abort.reason) shoved the Dismiss/Share
 * buttons out of the viewport.
 *
 * vitest runs in a plain Node environment here (no jsdom), so there is no real
 * layout to measure: `getBoundingClientRect()` would only report a tautological
 * zero-width box and could never fail. Instead we pin the one CSS invariant that
 * *causes* the overflow, and the real geometry is proven end-to-end by
 * `test/browser/result-flash-overflow.mjs` (Playwright, real Chromium). Reverting
 * this fix (detail back to `shrink-0` / dropping `min-w-0`) turns the first case
 * red, so the case is genuinely counterfactual rather than always-green.
 */

const DETAIL = 'qa-overflow-detail-marker';

const markup = (detail: string | null) =>
  renderToStaticMarkup(
    <ResultFlash
      headline="Alex +880"
      detail={detail}
      onDismiss={() => undefined}
      onShare={() => undefined}
    />,
  );

/** Class list of the first element whose text is exactly `text`. */
const classForText = (html: string, text: string): string => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<span class="([^"]*)"[^>]*>${escaped}</span>`).exec(html);
  if (!match) throw new Error(`no span carrying "${text}" in markup`);
  return match[1] ?? '';
};

describe('ResultFlash overflow', () => {
  it('keeps the detail shrinkable so the action buttons are never pushed out', () => {
    const html = markup(DETAIL);
    const classes = classForText(html, DETAIL).split(/\s+/);
    // `shrink-0` is exactly what let the long detail overflow the pill.
    expect(classes).not.toContain('shrink-0');
    // `min-w-0` lets the flex item take a bounded width; only then can its
    // own `truncate` clip with an ellipsis instead of overflowing.
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('truncate');
    // Secondary copy yields first: an explicit 2× shrink factor, not none.
    expect(classes).toContain('shrink-[2]');
  });

  it('keeps the headline shrinkable too, so an oversized headline alone cannot overflow', () => {
    const classes = classForText(markup(DETAIL), 'Alex +880').split(/\s+/);
    expect(classes).not.toContain('shrink-0');
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('truncate');
  });

  it('keeps both action buttons unshrinkable so they stay visible', () => {
    const html = markup(DETAIL);
    for (const label of [t('Dismiss result'), t('Share')]) {
      const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
      if (!match) throw new Error(`no button labelled "${label}" in markup`);
      expect(match[0]).toContain('shrink-0');
    }
  });

  it('renders no detail span when detail is absent', () => {
    expect(markup(null)).not.toContain(DETAIL);
  });
});
