import { describe, expect, it } from 'vitest';
import { issuedRecoveryCode } from '../src/pages/login/issuedRecovery.ts';

describe('registration surfaces the one-time recovery code', () => {
  it('holds the signup flow on the code returned by /api/register', () => {
    const code = 'ABCDEF-GHJKLM-NPQRST-UVWXYZ';
    expect(issuedRecoveryCode('register', { userId: 1, token: 't', recoveryCode: code })).toBe(
      code,
    );
  });

  it('ignores login and recover responses', () => {
    expect(issuedRecoveryCode('login', { recoveryCode: 'ABCDEF-GHJKLM-NPQRST-UVWXYZ' })).toBeNull();
    expect(
      issuedRecoveryCode('recover', { recoveryCode: 'ABCDEF-GHJKLM-NPQRST-UVWXYZ' }),
    ).toBeNull();
  });

  it('proceeds normally when a register response has no usable code', () => {
    expect(issuedRecoveryCode('register', { userId: 1, token: 't' })).toBeNull();
    expect(issuedRecoveryCode('register', { recoveryCode: '' })).toBeNull();
    expect(issuedRecoveryCode('register', { recoveryCode: 42 })).toBeNull();
    expect(issuedRecoveryCode('register', null)).toBeNull();
  });
});
