/** Nickname (display name) rules, shared verbatim by the server and the web
 *  client so both enforce exactly the same allowlist and width table.
 *
 *  Why shared: the server is authoritative, but the settings form wants instant
 *  feedback. Two hand-maintained copies drifted (the browser mirrored the
 *  server's approximate width regex and a different error string), so the rule
 *  lives here once and each side imports it.
 *
 *  Allowed characters (an allowlist, not a denylist):
 *    - Han / Chinese ideographs (`\p{Script=Han}`)
 *    - ASCII Latin letters and digits (`A-Z a-z 0-9`)
 *    - the punctuation set `_ @ - ·`
 *    - wide emoji: pictographs whose real East_Asian_Width is W or F
 *  This rejects Cyrillic/Greek (`Ж`), math symbols (`∑`) and letterlike symbols
 *  (`©`, which is Extended_Pictographic but only EAW=A) without enumerating
 *  them. Combining marks may only continue an allowed base, so a bare
 *  diacritic can never ride along as its own "character".
 *
 *  Width: measured over Unicode grapheme clusters against the real
 *  East_Asian_Width W/F tables (generated from Unicode 15.0.0), never an
 *  approximate range list. CJK and wide emoji count as 2 columns; everything
 *  else as 1. An emoji ZWJ sequence or a base+combining-mark pair stays one
 *  cluster, so neither can smuggle in a second visible character.
 *
 *  An empty string is a valid nickname meaning "clear it" (reads fall back to
 *  the login username). Anything containing whitespace is rejected, including
 *  leading and trailing whitespace: we never trim, because `' abc '` silently
 *  becoming `'abc'` is exactly the bug this guards against. */
export const DISPLAY_NAME_MAX_WIDTH = 16;

/** Sorted, non-overlapping [start, end] code-point pairs for every code point
 *  with East_Asian_Width W or F (Unicode 15.0.0), 121 ranges. Generated data -
 *  do not hand-edit; regenerate from `unicodedata.east_asian_width`. */
const WIDE_RANGES: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3,
  0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1,
  0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b,
  0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797,
  0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x2e80, 0x2e99,
  0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x2ffb, 0x3000, 0x303e, 0x3041, 0x3096, 0x3099, 0x30ff,
  0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e3, 0x31f0, 0x321e, 0x3220, 0x3247, 0x3250, 0x4dbf,
  0x4e00, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4,
  0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18d00, 0x18d08, 0x1aff0, 0x1aff3, 0x1aff5,
  0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155,
  0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191,
  0x1f19a, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265,
  0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf,
  0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc,
  0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4,
  0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7,
  0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c,
  0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa88, 0x1fa90, 0x1fabd,
  0x1fabf, 0x1fac5, 0x1face, 0x1fadb, 0x1fae0, 0x1fae8, 0x1faf0, 0x1faf8, 0x20000, 0x2fffd, 0x30000,
  0x3fffd,
];

/** True when `cp` is East_Asian_Width W or F. Binary search over the sorted
 *  generated table. */
export function isEastAsianWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = WIDE_RANGES[mid * 2]!;
    const end = WIDE_RANGES[mid * 2 + 1]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** ── Sequence-level validation ─────────────────────────────────────────────
 *  Validity is decided over the WHOLE string as one ordered sequence, never per
 *  grapheme cluster: `Intl.Segmenter` keeps `a + ZWJ + b` together in some
 *  engines and not others, and a per-cluster "has a base" check let a lone
 *  leading/trailing joiner, a ZWJ between two Latin letters, or a bare skin-tone
 *  modifier through. The walk below tracks what the previous code point permits.
 *
 *  Token classes:
 *    TEXT_BASE   Han, ASCII letters/digits, `_ @ - ·`
 *    EMOJI_BASE  an Extended_Pictographic / Regional_Indicator code point that is
 *                also EAW W/F (so `©` is not one) and is not an emoji modifier
 *    EMOJI_MOD   `\p{Emoji_Modifier}` skin-tone modifiers
 *    COMBINING   `\p{Mn}\p{Me}\p{Mc}` including the keycap U+20E3 (VS are Mn too
 *                but are classified separately below)
 *    VS          U+FE0E / U+FE0F variation selectors
 *    ZWJ         U+200D
 *
 *  Rules (every code point must be exactly one of the classes, in a legal spot):
 *    - TEXT_BASE may be followed only by COMBINING marks. It cannot take a VS,
 *      an emoji modifier or a ZWJ: `a\ufe0f`, `a\ufe0f` and `a\u200db` are all
 *      invalid.
 *    - EMOJI_BASE may be followed by EMOJI_MOD / VS / COMBINING in any order
 *      (runs allowed), or by `ZWJ EMOJI_BASE` to form an emoji ZWJ chain.
 *    - ZWJ is legal ONLY between two EMOJI_BASE code points: the token on its
 *      left must be an emoji base and the token on its right must be an emoji
 *      base. A leading, trailing or doubled ZWJ is refused.
 *    - EMOJI_MOD is never a base: it may only follow an EMOJI_BASE (directly or
 *      after other continuations). `🏽` and `🏽a` are invalid.
 *    - VS may only follow an EMOJI_BASE; a lone VS or one attached to Latin/Han
 *      (`a\ufe0f`) is invalid. (Product rule: no VS on plain text.)
 *    - COMBINING may only follow a TEXT_BASE or EMOJI_BASE; a lone combining
 *      mark is invalid.
 *  This keeps the previously-valid `😀`, `👍🏽`, `👨‍👩‍👧`, `e\u0301`, CJK and
 *  `_ @ - ·`, while `😀\u200d`, `a\u200db`, `\u200d😀`, `🏽` and `🏽a` are all
 *  refused. */
const TEXT_BASE = /[\p{Script=Han}A-Za-z0-9_@\-·]/u;
const EMOJI_PICT = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const EMOJI_MOD = /\p{Emoji_Modifier}/u;
const COMBINING = /[\p{Mn}\p{Me}\p{Mc}]/u;
const VARIATION_SELECTOR = /[\ufe0e\ufe0f]/u;
const ZWJ = 0x200d;

function isTextBase(ch: string): boolean {
  return TEXT_BASE.test(ch);
}
function isEmojiModifier(ch: string): boolean {
  return EMOJI_MOD.test(ch);
}
function isVariationSelector(ch: string): boolean {
  return VARIATION_SELECTOR.test(ch);
}
/** Combining marks, excluding variation selectors (which are Mn but are only
 *  legal after an emoji base). */
function isCombining(ch: string): boolean {
  return COMBINING.test(ch) && !isVariationSelector(ch);
}
/** An allowed emoji base: a pictograph/regional indicator that is genuinely wide
 *  (rejects `©`, Extended_Pictographic but EAW=A) and is not a skin-tone
 *  modifier (which may never start a run). */
function isEmojiBase(ch: string): boolean {
  return EMOJI_PICT.test(ch) && !isEmojiModifier(ch) && isEastAsianWide(ch.codePointAt(0)!);
}

function* graphemes(value: string): Generator<string> {
  for (const { segment } of graphemeSegmenter.segment(value)) yield segment;
}

/** Validates the whole string as one ordered sequence (rules in the block
 *  above). Returns false on any code point that is not a base or a legal
 *  continuation in its position. */
function sequenceAllowed(value: string): boolean {
  const cps = Array.from(value);
  let i = 0;
  // the previous significant token was an EMOJI_BASE, so a ZWJ may follow it
  let prevEmojiBase = false;
  // we just consumed a ZWJ and still owe an EMOJI_BASE on its right
  let needEmojiBase = false;
  while (i < cps.length) {
    const ch = cps[i]!;
    if (ch.codePointAt(0) === ZWJ) {
      if (!prevEmojiBase) return false; // ZWJ with no emoji base on its left
      prevEmojiBase = false;
      needEmojiBase = true;
      i++;
      continue;
    }
    if (isEmojiBase(ch)) {
      needEmojiBase = false;
      prevEmojiBase = true;
      i++;
      // trailing emoji continuations: modifiers, variation selectors, marks
      while (i < cps.length) {
        const next = cps[i]!;
        if (isEmojiModifier(next) || isVariationSelector(next) || isCombining(next)) i++;
        else break;
      }
      continue;
    }
    if (isTextBase(ch)) {
      if (needEmojiBase) return false; // a ZWJ must be followed by an emoji base
      prevEmojiBase = false;
      i++;
      // plain text takes combining marks only - no VS, no modifier, no ZWJ
      while (i < cps.length && isCombining(cps[i]!)) i++;
      continue;
    }
    // whitespace, control, a lone modifier/VS/combining mark, or a foreign script
    return false;
  }
  return !needEmojiBase;
}

/** Display width of `value`: each grapheme cluster is 2 if any of its code
 *  points is East_Asian_Width W or F, otherwise 1. */
export function displayNameWidth(value: string): number {
  let width = 0;
  for (const cluster of graphemes(value)) {
    let clusterWidth = 1;
    for (const ch of cluster) {
      if (isEastAsianWide(ch.codePointAt(0)!)) {
        clusterWidth = 2;
        break;
      }
    }
    width += clusterWidth;
  }
  return width;
}

/** Human-readable reason the nickname is invalid, or null when it is fine.
 *  `''` is valid and clears the nickname; a non-empty value is validated as
 *  typed (no trimming). */
export function displayNameError(value: string): string | null {
  if (value === '') return null; // empty clears the nickname -> falls back to the username
  if (!sequenceAllowed(value)) {
    return 'Nicknames may only use Chinese, Latin letters, digits, _ @ - · and emoji.';
  }
  if (displayNameWidth(value) > DISPLAY_NAME_MAX_WIDTH) {
    return `Nickname must be ${DISPLAY_NAME_MAX_WIDTH} characters wide or fewer (Chinese counts as two).`;
  }
  return null;
}
