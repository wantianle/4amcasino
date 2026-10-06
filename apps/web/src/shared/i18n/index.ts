import dict from './dict/index.ts';
import { getLocale } from './locale.ts';

type Vars = Record<string, string | number>;

/** Matches `{placeholder}` tokens in both dictionary keys and values. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface TemplateEntry {
  value: string;
  regex: RegExp;
  names: string[];
}

// Exact lookups.
const exact = new Map<string, string>();
// First-character-case-insensitive lookups, used by `tr()`.
const normalized = new Map<string, string>();
// Compiled template keys (a regex per source key). Cached module-level.
const templateCache = new Map<string, { regex: RegExp; names: string[] }>();
const templates: TemplateEntry[] = [];
// First-character-lowercased template variants, used by `tr()`.
const normTemplates: TemplateEntry[] = [];

function normalizeKey(key: string): string {
  if (key.length === 0) return key;
  return key.charAt(0).toLowerCase() + key.slice(1);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `{placeholder}` immediately followed by a lone unit letter (`h`, `m`, `s`)
 * is a "number + unit" template: `{m}m`, `{n}s`, `{h}h {m}m`. Its captured
 * value is always numeric, so it compiles to a number-only pattern. With the
 * generic `(.+?)` such a key also matched any unrelated English string that
 * merely ends in the same letter, so `t('Close room')` was swallowed by `{m}m`
 * and rendered `Close roo 分钟` (and `t('Platform')` → `Platfor 分钟`).
 * A letter that merely begins a longer word (`{n} points`) is not a unit, and
 * only the known time-unit letters count, so ordinary prose placeholders stay
 * open-ended.
 */
const UNIT_LETTERS = new Set(['h', 'm', 's']);
// Number-only capture: integer or decimal, e.g. "5", "2.5".
const NUMERIC_CAPTURE = '(\\d+(?:\\.\\d+)?)';

function isUnitPlaceholder(key: string, end: number): boolean {
  const suffix = key[end];
  if (suffix === undefined || !UNIT_LETTERS.has(suffix)) return false;
  const after = key[end + 1];
  return after === undefined || !/[A-Za-z]/.test(after);
}

/** Compile a key containing `{placeholder}` tokens into an anchored RegExp. */
function compileTemplate(key: string): { regex: RegExp; names: string[] } {
  const cached = templateCache.get(key);
  if (cached) return cached;

  const names: string[] = [];
  let pattern = '^';
  let last = 0;
  key.replace(PLACEHOLDER, (match: string, name: string, index: number) => {
    pattern += escapeRegExp(key.slice(last, index));
    pattern += isUnitPlaceholder(key, index + match.length) ? NUMERIC_CAPTURE : '(.+?)';
    names.push(name);
    last = index + match.length;
    return match;
  });
  pattern += escapeRegExp(key.slice(last)) + '$';

  const compiled = { regex: new RegExp(pattern), names };
  templateCache.set(key, compiled);
  return compiled;
}

for (const [key, value] of Object.entries(dict)) {
  exact.set(key, value);
  normalized.set(normalizeKey(key), value);
  if (PLACEHOLDER.test(key)) {
    PLACEHOLDER.lastIndex = 0;
    const { regex, names } = compileTemplate(key);
    templates.push({ value, regex, names });
    const normKey = normalizeKey(key);
    if (normKey !== key) {
      const variant = compileTemplate(normKey);
      normTemplates.push({ value, regex: variant.regex, names: variant.names });
    }
  }
  PLACEHOLDER.lastIndex = 0;
}

function findTemplate(
  source: string,
  normalize: boolean,
): { value: string; extracted: Vars } | undefined {
  const lists = normalize ? [templates, normTemplates] : [templates];
  for (const list of lists) {
    for (const tpl of list) {
      const match = tpl.regex.exec(source);
      if (!match) continue;
      const extracted: Vars = {};
      tpl.names.forEach((name, i) => {
        extracted[name] = match[i + 1] ?? '';
      });
      return { value: tpl.value, extracted };
    }
  }
  return undefined;
}

/**
 * Fill `{name}` tokens in a translated value. Extracted template vars win over
 * caller-provided ones. If any referenced var is missing, return the source.
 */
function render(
  value: string,
  vars: Vars | undefined,
  extracted: Vars | undefined,
  source: string,
): string {
  const merged: Vars = { ...(vars ?? {}), ...(extracted ?? {}) };
  let missing = false;
  const out = value.replace(PLACEHOLDER, (_token, name: string) => {
    const v = merged[name];
    if (v === undefined) {
      missing = true;
      return _token;
    }
    return String(v);
  });
  return missing ? source : out;
}

function translate(source: string, vars: Vars | undefined, normalize: boolean): string {
  if (typeof source !== 'string' || source.length === 0) return source;
  const key = normalize ? source.trim() : source;

  // (a) exact key match
  const direct = exact.get(key) ?? (normalize ? normalized.get(normalizeKey(key)) : undefined);
  if (direct !== undefined) return render(direct, vars, undefined, source);

  // (b) template match
  const hit = findTemplate(key, normalize);
  if (hit) return render(hit.value, vars, hit.extracted, source);

  // (c) untranslated
  return source;
}

/**
 * Translate an English source string to Chinese, interpolating `{name}` tokens.
 * Falls back to the source unchanged when no translation matches.
 * In `en` mode the source is the display copy, but `{name}` tokens are still
 * filled from `vars` — the template is the English string, same as `tNode()`
 * renders the source template in `en` (without this, tokens would show up
 * literally as `{name}` in the English UI).
 */
export function t(source: string, vars?: Vars): string {
  if (getLocale() === 'en') return vars ? render(source, vars, undefined, source) : source;
  return translate(source, vars, false);
}

/**
 * Translate server-provided prose. Same lookup as `t()` but with light
 * normalization: the input is trimmed and the first character is matched
 * case-insensitively. In `en` mode the source is returned as-is.
 */
export function tr(source: string, vars?: Vars): string {
  if (getLocale() === 'en') return source;
  return translate(source, vars, true);
}

/**
 * Raw dictionary lookup WITHOUT locale gating: exact key first, then the
 * trimmed / first-char-case-insensitive variants that `tr()` uses. Returns the
 * stored value (which may still contain `{placeholder}` tokens) or null.
 * For building rich-text helpers over dictionary values; UI copy should go
 * through `t()` / `tr()`.
 */
export function lookup(source: string): string | null {
  if (typeof source !== 'string' || source.length === 0) return null;
  const trimmed = source.trim();
  return exact.get(source) ?? exact.get(trimmed) ?? normalized.get(normalizeKey(trimmed)) ?? null;
}

/** Whether a translation exists for the given source string. Locale-independent. */
export function hasTranslation(source: string): boolean {
  if (typeof source !== 'string' || source.length === 0) return false;
  const trimmed = source.trim();
  if (exact.has(source) || exact.has(trimmed)) return true;
  if (normalized.has(normalizeKey(trimmed))) return true;
  return findTemplate(source, false) !== undefined || findTemplate(trimmed, true) !== undefined;
}
