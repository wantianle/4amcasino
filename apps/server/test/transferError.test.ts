import { describe, expect, it } from 'vitest';
import { isTransientTransferError } from '../src/game.js';

const coded = (code: string) => Object.assign(new Error(code), { code });

describe('isTransientTransferError', () => {
  it('accepts contention and interrupt codes, including extended codes', () => {
    for (const c of [
      'SQLITE_BUSY',
      'SQLITE_BUSY_SNAPSHOT',
      'SQLITE_LOCKED',
      'SQLITE_LOCKED_SHAREDCACHE',
      'SQLITE_INTERRUPT',
    ])
      expect(isTransientTransferError(coded(c))).toBe(true);
  });

  it('rejects environmental, programming and unknown failures', () => {
    for (const c of [
      'SQLITE_IOERR',
      'SQLITE_IOERR_READ',
      'SQLITE_FULL',
      'SQLITE_NOMEM',
      'SQLITE_PROTOCOL',
      'SQLITE_CORRUPT',
      'SQLITE_CONSTRAINT',
      'SQLITE_ERROR',
    ])
      expect(isTransientTransferError(coded(c))).toBe(false);
    expect(isTransientTransferError(new Error('plain'))).toBe(false);
    expect(isTransientTransferError(new TypeError('boom'))).toBe(false);
    expect(isTransientTransferError(null)).toBe(false);
    expect(isTransientTransferError(undefined)).toBe(false);
  });

  it('rejects look-alike codes that merely share a prefix', () => {
    // A bare `startsWith` would wrongly accept these; only an exact code or an
    // `_`-separated extended form is transient.
    for (const c of ['SQLITE_BUSYNESS', 'SQLITE_LOCKED_BROKEN', 'SQLITE_INTERRUPT_FOO'])
      expect(isTransientTransferError(coded(c))).toBe(false);
    // but the real extended forms are accepted
    for (const c of ['SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED_SHAREDCACHE'])
      expect(isTransientTransferError(coded(c))).toBe(true);
  });
});
