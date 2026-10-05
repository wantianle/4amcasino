import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const bootstrap = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');

function boot(saved: string | null, storageBlocked = false) {
  const classes = new Set<string>();
  const style = { colorScheme: '' };
  let chromeColor = '';
  const root = {
    style,
    classList: {
      add: (value: string) => classes.add(value),
      contains: (value: string) => classes.has(value),
      remove: (value: string) => classes.delete(value),
      toggle: (value: string, enabled: boolean) =>
        enabled ? classes.add(value) : classes.delete(value),
    },
  };
  runInNewContext(bootstrap, {
    document: {
      documentElement: root,
      querySelector: () => ({
        setAttribute: (_key: string, value: string) => {
          chromeColor = value;
        },
      }),
    },
    // Route A: the bootstrap must never read storage. This stub exists only to
    // prove that whatever it returns (or throws) cannot change the result.
    localStorage: {
      getItem: () => {
        if (storageBlocked) throw new Error('Blocked');
        return saved;
      },
    },
  });
  return { classes, style, chromeColor: () => chromeColor };
}

describe('permanent dark appearance before React starts', () => {
  it.each([null, 'light', 'dark', 'cyber', 'invalid'])(
    'always boots dark regardless of saved theme %s',
    (saved) => {
      const page = boot(saved);
      expect([...page.classes].sort()).toEqual(['dark', 'zeus']);
      expect(page.style.colorScheme).toBe('dark');
      expect(page.chromeColor()).toBe('#262626');
    },
  );
  it('still boots dark when storage is blocked', () => {
    const page = boot('light', true);
    expect(page.classes.has('dark')).toBe(true);
    expect(page.classes.has('zeus')).toBe(true);
    expect(page.style.colorScheme).toBe('dark');
    expect(page.chromeColor()).toBe('#262626');
  });
});
