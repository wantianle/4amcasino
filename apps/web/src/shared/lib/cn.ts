import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

const numberFormat = new Intl.NumberFormat('zh-CN', { useGrouping: true });

export function fmt(n: number): string {
  return numberFormat.format(n);
}
