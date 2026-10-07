import { describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeConfig,
  applyRuntimeConfigBeforeRender,
  RUNTIME_CONFIG_TIMEOUT_MS,
  runtimeCssVars,
} from '../src/app/main.tsx';

// ---------------------------------------------------------------------------
// Frontend half of the runtime-config channel: the server publishes durations
// (see apps/server/test/config.test.ts) and this bootstrap overlays them onto
// `:root` as inline custom properties. The fetch/root are injected, so these
// tests need no DOM and no server.
// ---------------------------------------------------------------------------

function fakeRoot(): { root: HTMLElement; setProperty: ReturnType<typeof vi.fn> } {
  const setProperty = vi.fn();
  return { root: { style: { setProperty } } as unknown as HTMLElement, setProperty };
}

function jsonFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe('runtimeCssVars', () => {
  it('maps every public duration to its CSS custom property in ms', () => {
    expect(
      runtimeCssVars({
        tableDurPulseMs: 1600,
        tableDurGlowMs: 450,
        tableDurDimMs: 460,
        tableDurHighlightMs: 620,
        tableDurFlopPullMs: 400,
        tableDurFlopStaggerMs: 300,
        winFxMs: 3000,
        stackLandMs: 910,
      }),
    ).toEqual([
      ['--table-dur-pulse', '1600ms'],
      ['--table-dur-glow', '450ms'],
      ['--table-dur-dim', '460ms'],
      ['--table-dur-highlight', '620ms'],
      ['--table-dur-flop-pull', '400ms'],
      ['--table-dur-flop-stagger', '300ms'],
      ['--win-fx-ms', '3000ms'],
      ['--stack-land-ms', '910ms'],
    ]);
  });

  it('skips non-finite, negative, and non-numeric values', () => {
    expect(
      runtimeCssVars({
        tableDurGlowMs: -1,
        tableDurDimMs: 'nope',
        tableDurHighlightMs: Number.NaN,
      }),
    ).toEqual([]);
  });
});

describe('applyRuntimeConfig', () => {
  it('writes the fetched durations onto :root', async () => {
    const { root, setProperty } = fakeRoot();
    await applyRuntimeConfig(jsonFetch({ tunables: { tableDurGlowMs: 777, winFxMs: 3000 } }), root);
    expect(setProperty).toHaveBeenCalledWith('--table-dur-glow', '777ms');
    expect(setProperty).toHaveBeenCalledWith('--win-fx-ms', '3000ms');
  });

  it('degrades gracefully when the endpoint is missing', async () => {
    const { root, setProperty } = fakeRoot();
    await expect(
      applyRuntimeConfig(jsonFetch({ error: 'not found' }, false), root),
    ).resolves.toBeUndefined();
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('degrades gracefully when fetch rejects', async () => {
    const { root, setProperty } = fakeRoot();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(applyRuntimeConfig(fetchImpl, root)).resolves.toBeUndefined();
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('does nothing without a root (non-browser import)', async () => {
    await expect(applyRuntimeConfig(jsonFetch({ tunables: {} }), undefined)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B1: the bootstrap must apply the config BEFORE the first render. These pin the
// bounded wait that makes that true without risking a white screen on a hung
// request.
// ---------------------------------------------------------------------------

describe('applyRuntimeConfigBeforeRender', () => {
  it('waits for a response that arrives inside the timeout and applies it', async () => {
    const { root, setProperty } = fakeRoot();
    const slowFetch = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, json: async () => ({ tunables: { tableDurHighlightMs: 1234 } }) }),
            50,
          ),
        ),
    ) as unknown as typeof fetch;
    await applyRuntimeConfigBeforeRender(slowFetch, root, 1_000);
    // The value is in place by the time the bootstrap promise resolves, i.e.
    // before `main.tsx` calls `createRoot(...).render(...)`.
    expect(setProperty).toHaveBeenCalledWith('--table-dur-highlight', '1234ms');
  });

  it('resolves at the timeout when the request never settles, applying nothing', async () => {
    vi.useFakeTimers();
    try {
      const { root, setProperty } = fakeRoot();
      const never = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
      const pending = applyRuntimeConfigBeforeRender(never, root, RUNTIME_CONFIG_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(RUNTIME_CONFIG_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();
      expect(setProperty).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rejects, even when the fetch rejects', async () => {
    const { root } = fakeRoot();
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(applyRuntimeConfigBeforeRender(fetchImpl, root, 50)).resolves.toBeUndefined();
  });
});
