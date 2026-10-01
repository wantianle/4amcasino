// Locale-aware date/time helpers. Kept standalone so call sites can migrate
// gradually. Formatting follows the ACTIVE locale (docs/zh-i18n.md §4.1):
// zh-CN keeps 24-hour `HH:mm` and `10月1日`; en falls back to en-US norms.
import { getLocale, intlLocaleTag } from '../i18n/locale.ts';

export type DateInput = Date | number;

/** Intl formatters are comparatively expensive to construct; cache per
 *  key. The key always includes the active tag, so a locale switch simply
 *  resolves a different entry - nothing to invalidate. */
const cache = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  key: string,
  build: (tag: string) => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const tag = intlLocaleTag();
  const mapKey = `${key}|${tag}`;
  const cached = cache.get(mapKey);
  if (cached) return cached;
  const built = build(tag);
  cache.set(mapKey, built);
  return built;
}

function toDate(d: DateInput): Date {
  return typeof d === 'number' ? new Date(d) : d;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** `14:05` in zh-CN, `2:05 PM` in en-US. */
export function fmtTime(d: DateInput): string {
  return cachedFormat('time', (tag) =>
    tag === 'zh-CN'
      ? new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false })
      : new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit', hour12: true }),
  ).format(toDate(d));
}

/** Current year: `10月1日` / `October 1`. Other years add the year. */
export function fmtDate(d: DateInput): string {
  const date = toDate(d);
  const withYear = date.getFullYear() !== new Date().getFullYear();
  return cachedFormat(
    withYear ? 'date:year' : 'date',
    (tag) =>
      new Intl.DateTimeFormat(tag, {
        ...(withYear ? { year: 'numeric' } : {}),
        month: 'long',
        day: 'numeric',
      }),
  ).format(date);
}

const zhUnit = {
  now: '刚刚',
  minute: (n: number) => `${n} 分钟前`,
  hour: (n: number) => `${n} 小时前`,
  yesterday: '昨天',
  day: (n: number) => `${n} 天前`,
};

const enUnit = {
  now: 'just now',
  minute: (n: number) => `${n} minute${n === 1 ? '' : 's'} ago`,
  hour: (n: number) => `${n} hour${n === 1 ? '' : 's'} ago`,
  yesterday: 'Yesterday',
  day: (n: number) => `${n} day${n === 1 ? '' : 's'} ago`,
};

/** 刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 (or the en-US equivalents),
 *  falling back to `fmtDate` beyond 7 days. */
export function fmtRelative(d: DateInput): string {
  const zh = getLocale() !== 'en';
  const u = zh ? zhUnit : enUnit;
  const date = toDate(d);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 1) return u.now;
  if (diffMin < 60) return u.minute(diffMin);

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return u.hour(diffHour);

  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000);
  if (dayDiff <= 1) return u.yesterday;
  if (dayDiff < 7) return u.day(dayDiff);
  return fmtDate(date);
}
