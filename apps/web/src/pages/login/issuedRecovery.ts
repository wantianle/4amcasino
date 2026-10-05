export type AuthMode = 'login' | 'register' | 'recover';

/** The registration response carries the recovery code exactly once. This
 *  decides whether the login page must stop on the one-time code screen:
 *  it returns the code string when the signup response has one, or null when
 *  the caller should continue as usual. */
export function issuedRecoveryCode(mode: AuthMode, res: unknown): string | null {
  if (mode !== 'register') return null;
  const code = (res as { recoveryCode?: unknown } | null | undefined)?.recoveryCode;
  return typeof code === 'string' && code.length > 0 ? code : null;
}
