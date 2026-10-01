// zh-CN date/time helpers. Kept standalone so call sites can migrate gradually.
export type DateInput = Date | number;

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function toDate(d: DateInput): Date {
  return typeof d === 'number' ? new Date(d) : d;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 24-hour `HH:mm`. */
export function fmtTime(d: DateInput): string {
  return timeFormat.format(toDate(d));
}

/** `10月1日` in the current year, `2026年10月1日` otherwise. */
export function fmtDate(d: DateInput): string {
  const date = toDate(d);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${month}月${day}日`;
  }
  return `${date.getFullYear()}年${month}月${day}日`;
}

/** 刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前, falling back to `fmtDate` beyond 7 days. */
export function fmtRelative(d: DateInput): string {
  const date = toDate(d);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;

  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000,
  );
  if (dayDiff <= 1) return '昨天';
  if (dayDiff < 7) return `${dayDiff} 天前`;
  return fmtDate(date);
}
