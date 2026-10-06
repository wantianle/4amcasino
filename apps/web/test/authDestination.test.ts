import { expect, it } from 'vitest';
import { authDestination } from '../src/shared/authDestination.ts';
it('retains the agent-access destination across sign-in without enabling external redirects', () => {
  expect(authDestination('?next=%2Fagents')).toBe('/agents');
  for (const next of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/tournaments/../admin',
    '/tournaments/a?next=evil',
    '/agents/../admin',
    '/api/me',
  ]) {
    expect(authDestination(`?next=${encodeURIComponent(next)}`)).toBeNull();
  }
});
