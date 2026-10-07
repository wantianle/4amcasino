import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

/**
 * Runtime configuration bootstrap.
 *
 * Vite injects env at BUILD time and the web app has no other runtime-config
 * channel (`rg 'import.meta.env|VITE_' apps/web/src` is empty), so the only way
 * to change a frontend animation duration without rebuilding is for the server
 * to hand it over at boot. `GET /api/config` is that channel.
 *
 * The durations below are overlaid onto `:root` as inline custom properties,
 * which outrank the stylesheet's `:root` block, so the committed defaults in
 * `app/table-tokens.css` need no edit.
 *
 * The fetch is applied BEFORE the first render, bounded by
 * `RUNTIME_CONFIG_TIMEOUT_MS`: consumers such as `DealCard` read these custom
 * properties at animation start, so a first frame painted against the
 * stylesheet defaults would silently ignore a configured `.env` value. The
 * timeout is the escape hatch - a failed, slow, or hung request still renders
 * (with the defaults), so configuration is a bounded gate, never a white screen.
 */

/** Public duration key -> CSS custom property. Anything the server does not
 *  publish is simply absent from the response and stays at its CSS default. */
const DURATION_CSS_VARS: ReadonlyArray<readonly [key: string, cssVar: string]> = [
  ['tableDurPulseMs', '--table-dur-pulse'],
  ['tableDurGlowMs', '--table-dur-glow'],
  ['tableDurDimMs', '--table-dur-dim'],
  ['tableDurHighlightMs', '--table-dur-highlight'],
  // The deal entrance split out of --table-dur-highlight (DealCard.tsx): the
  // server table does not carry these keys yet, so the mapping is inert until
  // tunables.ts adds them — the CSS defaults stay authoritative meanwhile.
  ['tableDurDealMs', '--table-dur-deal'],
  ['tableDurFlipMs', '--table-dur-flip'],
  // Flop pull: the board's horizontal slide duration + per-card beat (DealCard).
  ['tableDurFlopPullMs', '--table-dur-flop-pull'],
  ['tableDurFlopStaggerMs', '--table-dur-flop-stagger'],
  // Inert until WinnerFx.tsx reads them (see follow-up); published now so the
  // contract is in place when that lane frees the file.
  ['winFxMs', '--win-fx-ms'],
  ['stackLandMs', '--stack-land-ms'],
];

/** Pure mapping: `/api/config` `tunables` -> `[cssVar, value]` pairs. Only
 *  finite, non-negative numbers are applied; malformed input is skipped. */
export function runtimeCssVars(tunables: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, cssVar] of DURATION_CSS_VARS) {
    const value = tunables[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out.push([cssVar, `${value}ms`]);
    }
  }
  return out;
}

/**
 * Fetch the server's public config and override the root CSS variables.
 * Never throws: a missing endpoint or offline server leaves the defaults.
 * `fetchImpl` / `root` are injectable for tests.
 */
export async function applyRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  root: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): Promise<void> {
  if (!root) return;
  try {
    const res = await fetchImpl('/api/config', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data: unknown = await res.json();
    const tunables = (data as { tunables?: unknown } | null)?.tunables;
    if (!tunables || typeof tunables !== 'object') return;
    for (const [cssVar, value] of runtimeCssVars(tunables as Record<string, unknown>)) {
      root.style.setProperty(cssVar, value);
    }
  } catch {
    // graceful degradation: keep the stylesheet defaults
  }
}

/**
 * How long the bootstrap waits for `/api/config` before rendering with the
 * stylesheet defaults. Same-origin on the deployment target (Render / LAN), so
 * p99 is well under 200ms; 400ms is ~2x headroom and still below the shortest
 * animation it configures (`--table-dur-glow`, 450ms default). Past it we would
 * rather paint than hold a blank `#root` on a hung request.
 */
export const RUNTIME_CONFIG_TIMEOUT_MS = 400;

/**
 * Resolve once the runtime config has been applied OR `timeoutMs` has elapsed,
 * whichever comes first. The fetch is deliberately NOT aborted on timeout: a
 * slow-but-live server still lays its values down for every later read, while
 * the first render is never blocked longer than the timeout.
 */
export async function applyRuntimeConfigBeforeRender(
  fetchImpl: typeof fetch = fetch,
  root: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
  timeoutMs: number = RUNTIME_CONFIG_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      applyRuntimeConfig(fetchImpl, root),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const rootEl = typeof document === 'undefined' ? null : document.getElementById('root');
if (rootEl) {
  // Apply the server's public durations BEFORE the first render. `DealCard`
  // reads `--table-dur-highlight` from computed style when its animation starts,
  // so rendering first would make the first frame use `table-tokens.css`'s
  // committed default and silently ignore `.env`. The wait is bounded by
  // `RUNTIME_CONFIG_TIMEOUT_MS`; a hung request must never white-screen the app,
  // and whatever the promise settles to, we always render.
  void (async () => {
    try {
      await applyRuntimeConfigBeforeRender();
    } catch {
      // Best effort: fall through and paint with the stylesheet defaults.
    }
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })();
}
