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

/**
 * Golden class snapshot.
 *
 * `ResultFlash` used to take a `dark` prop, but its only caller always passed
 * `false` (TablePage renderFlash), so every `dark ? A : B` A-branch was dead.
 * These are the literal class strings a `dark=false` render produced *before*
 * the dead branches were removed. If a surviving branch is ever accidentally
 * swapped for a deleted dark one, these turn red.
 *
 * (The `dark:` Tailwind variants below are NOT the removed prop - they are
 *  Tailwind's `prefers-color-scheme` variants and must stay.)
 */
const CONTAINER_CLASS =
  'pointer-events-auto flex max-w-full items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 backdrop-blur bg-white/95 text-slate-900 shadow-[0_14px_40px_rgba(15,23,42,0.18)] ring-1 ring-slate-200/80 dark:bg-slate-900/90 dark:text-white dark:shadow-[0_14px_40px_rgba(2,6,23,0.55)] dark:ring-white/10';
const DETAIL_CLASS = 'min-w-0 shrink-[2] truncate text-xs text-slate-500 dark:text-slate-400';
const SIDE_BUTTON_CLASS =
  'shrink-0 rounded-full p-1.5 transition-colors text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200';

/** Class list of the first element whose class attribute contains `needle`. */
const classContaining = (html: string, needle: string): string => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`class="([^"]*${escaped}[^"]*)"`).exec(html);
  if (!match) throw new Error(`no class attribute containing "${needle}"`);
  return match[1] ?? '';
};

describe('ResultFlash runtime classes are unchanged by the dark-prop removal', () => {
  const aborted = () =>
    renderToStaticMarkup(
      <ResultFlash headline="Hand aborted" detail={DETAIL} aborted onDismiss={() => undefined} />,
    );

  it('pins the aborted pill: container, icon, detail, side buttons', () => {
    const html = aborted();
    expect(classContaining(html, 'pointer-events-auto')).toBe(CONTAINER_CLASS);
    expect(classContaining(html, 'text-rose-500')).toBe('shrink-0 text-rose-500');
    expect(classContaining(html, 'shrink-[2]')).toBe(DETAIL_CLASS);
    expect(classContaining(html, 'text-slate-400 hover:bg-slate-100')).toBe(SIDE_BUTTON_CLASS);
  });

  it('pins the non-aborted pill icon to amber (never the deleted dark amber-300)', () => {
    const html = markup(DETAIL);
    expect(classContaining(html, 'text-amber-500')).toBe('shrink-0 text-amber-500');
    expect(html).not.toContain('text-amber-300');
  });
});
