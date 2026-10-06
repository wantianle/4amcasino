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
 * `app/table-tokens.css` need no edit. If the fetch fails the stylesheet wins
 * and the app renders unchanged - configuration is best-effort, never a gate.
 */

/** Public duration key -> CSS custom property. Anything the server does not
 *  publish is simply absent from the response and stays at its CSS default. */
const DURATION_CSS_VARS: ReadonlyArray<readonly [key: string, cssVar: string]> = [
  ['tableDurPulseMs', '--table-dur-pulse'],
  ['tableDurGlowMs', '--table-dur-glow'],
  ['tableDurDimMs', '--table-dur-dim'],
  ['tableDurHighlightMs', '--table-dur-highlight'],
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

const rootEl = typeof document === 'undefined' ? null : document.getElementById('root');
if (rootEl) {
  void applyRuntimeConfig();
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
