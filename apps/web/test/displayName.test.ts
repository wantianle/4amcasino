import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_WIDTH,
  displayNameError,
  displayNameWidth,
} from '../src/features/account/displayName.ts';

describe('display name width (web mirror)', () => {
  it('counts Chinese/full-width as 2 and Latin/digits as 1', () => {
    expect(displayNameWidth('中')).toBe(2);
    expect(displayNameWidth('中文')).toBe(4);
    expect(displayNameWidth('ab12')).toBe(4);
    expect(displayNameWidth('ＡＢ')).toBe(4);
    expect(displayNameWidth('')).toBe(0);
  });

  it('measures grapheme clusters so emoji/combining marks cannot bypass the cap', () => {
    expect(displayNameWidth('😀')).toBe(2);
    expect(displayNameWidth('e\u0301')).toBe(1);
  });

  it('allows _ @ - · and the empty nickname, and refuses spaces', () => {
    expect(displayNameError('a_@-·')).toBeNull();
    expect(displayNameError('')).toBeNull();
    expect(displayNameError('a b')).not.toBeNull();
    expect(displayNameError('a\u3000b')).not.toBeNull();
    expect(displayNameError('a\u200bb')).not.toBeNull();
  });

  it('rejects whitespace instead of trimming it, including leading/trailing', () => {
    expect(displayNameError('   ')).not.toBeNull();
    expect(displayNameError(' abc')).not.toBeNull();
    expect(displayNameError('abc ')).not.toBeNull();
    expect(displayNameError('\tabc')).not.toBeNull();
  });

  it('rejects scripts and symbols outside the allowlist', () => {
    expect(displayNameError('Ж')).not.toBeNull(); // Cyrillic
    expect(displayNameError('∑')).not.toBeNull(); // math symbol
    expect(displayNameError('©')).not.toBeNull(); // letterlike symbol
  });

  it('allows a combining mark attached to an allowed base, never on its own', () => {
    expect(displayNameError('e\u0301')).toBeNull();
    expect(displayNameError('\u0301')).not.toBeNull();
  });

  it('rejects malformed joiner / modifier / variation-selector sequences', () => {
    expect(displayNameError('😀\u200d')).not.toBeNull(); // trailing ZWJ
    expect(displayNameError('a\u200db')).not.toBeNull(); // ZWJ between Latin letters
    expect(displayNameError('a\u0301\u200d')).not.toBeNull(); // ZWJ after a mark, no emoji base
    expect(displayNameError('\u200d😀')).not.toBeNull(); // leading ZWJ
    expect(displayNameError('🏽')).not.toBeNull(); // bare Emoji_Modifier
    expect(displayNameError('🏽a')).not.toBeNull(); // modifier used as the base
    expect(displayNameError('\ufe0f')).not.toBeNull(); // lone variation selector
    expect(displayNameError('a\ufe0f')).not.toBeNull(); // VS on plain Latin
    expect(displayNameError('😀\u200d🏽')).not.toBeNull(); // ZWJ must point at an emoji base
  });

  it('keeps valid emoji ZWJ / modifier / combining sequences', () => {
    expect(displayNameError('😀')).toBeNull();
    expect(displayNameError('👍🏽')).toBeNull();
    expect(displayNameError('👨\u200d👩\u200d👧')).toBeNull();
    expect(displayNameError('e\u0301')).toBeNull();
    expect(displayNameError('😀😀')).toBeNull();
  });

  it('enforces the 16-wide boundary', () => {
    expect(displayNameError('x'.repeat(DISPLAY_NAME_MAX_WIDTH))).toBeNull();
    expect(displayNameError('x'.repeat(DISPLAY_NAME_MAX_WIDTH + 1))).not.toBeNull();
    expect(displayNameError('中'.repeat(8))).toBeNull(); // width 16
    expect(displayNameError('中'.repeat(9))).not.toBeNull(); // width 18
  });

  it('measures with the real East_Asian_Width W/F table at the boundaries', () => {
    expect(displayNameWidth('\u3248')).toBe(1); // ㉈ EAW=A
    expect(displayNameWidth('\u2329')).toBe(2); // 〈 EAW=W
    expect(displayNameWidth('\u232A')).toBe(2); // 〉 EAW=W
  });
});
