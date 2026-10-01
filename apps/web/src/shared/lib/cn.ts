import clsx, { type ClassValue } from 'clsx';
import { intlLocaleTag } from '../i18n/locale.ts';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Number formats per BCP 47 tag: built lazily, reused across calls. The tag
 *  is read from the ACTIVE locale on every call, so switching language picks
 *  the right formatter without any invalidation logic. zh-CN keeps thousands
 *  grouping (docs/zh-i18n.md §4.1). */
const numberFormats = new Map<string, Intl.NumberFormat>();

function activeNumberFormat(): Intl.NumberFormat {
  const tag = intlLocaleTag();
  const cached = numberFormats.get(tag);
  if (cached) return cached;
  const format = new Intl.NumberFormat(tag, { useGrouping: true });
  numberFormats.set(tag, format);
  return format;
}

export function fmt(n: number): string {
  return activeNumberFormat().format(n);
}
