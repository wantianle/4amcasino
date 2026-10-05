import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { claimDealMotion } from '../../shared/gameClient.ts';

type ActiveDeal = {
  animation: Animation;
  element: HTMLDivElement;
  media: MediaQueryList;
  onMediaChange: () => void;
  cancelTimer: number | null;
  finished: boolean;
};

const activeDeals = new Map<string, ActiveDeal>();

export function activeDealRegistrySize(): number {
  return activeDeals.size;
}

function cancelRecord(key: string, record: ActiveDeal): void {
  if (record.cancelTimer !== null) {
    window.clearTimeout(record.cancelTimer);
    record.cancelTimer = null;
  }
  if (activeDeals.get(key) !== record) return;
  record.finished = true;
  record.animation.onfinish = null;
  record.animation.cancel();
  record.media.removeEventListener('change', record.onMediaChange);
  activeDeals.delete(key);
  delete record.element.dataset.dealing;
}

/** Animate the real card, not a duplicate. A registry owns the animation,
 * listener and DOM marker so StrictMode replay can reuse all three safely. */
export function DealCard({ children, delay = 0, handId = null, motionKey, epoch = 0, reveal = false }: {
  children: ReactNode; delay?: number; handId?: string | null; motionKey?: string; epoch?: number; reveal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const deck = el?.closest('.table-canvas')?.querySelector('[data-table-deck]');
    if (!el || !deck || !motionKey) return;
    const key = `${handId}:${motionKey}:${epoch}`;

    // A newer event for this card owns the DOM marker and must cancel its old
    // animation before starting. Old callbacks cannot touch the new element.
    for (const [oldKey, old] of activeDeals) {
      if (handId && oldKey.startsWith(`${handId}:${motionKey}:`) && oldKey !== key)
        cancelRecord(oldKey, old);
    }

    const existing = activeDeals.get(key);
    if (existing && existing.element === el) {
      if (existing.cancelTimer !== null) {
        window.clearTimeout(existing.cancelTimer);
        existing.cancelTimer = null;
      }
      const cleanup = () => {
        if (existing.finished || existing.cancelTimer !== null) return;
        existing.cancelTimer = window.setTimeout(() => cancelRecord(key, existing), 0);
      };
      return cleanup;
    }
    if (!claimDealMotion(handId, motionKey, epoch)) return;

    const media = matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return;
    const to = el.getBoundingClientRect();
    const from = deck.getBoundingClientRect();
    const scale = to.width / el.offsetWidth || 1;
    const style = getComputedStyle(el);
    const animation = el.animate(reveal ? [
      { transform: 'perspective(600px) rotateY(90deg)', opacity: 0 },
      { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
    ] : [
      { transform: `translate(${(from.x + from.width / 2 - to.x - to.width / 2) / scale}px, ${(from.y + from.height / 2 - to.y - to.height / 2) / scale}px) scale(.55) rotate(-8deg)`, opacity: 0.3 },
      { transform: 'none', opacity: 1 },
    ], {
      duration: reveal ? 700 : parseFloat(style.getPropertyValue('--table-dur-highlight')) * 1000 || 620,
      delay: reveal ? 0 : delay, easing: style.getPropertyValue('--table-ease-decelerate').trim(), fill: 'backwards',
    });
    const record: ActiveDeal = {
      animation, element: el, media, onMediaChange: () => cancelRecord(key, record),
      cancelTimer: null, finished: false,
    };
    activeDeals.set(key, record);
    el.dataset.dealing = 'true';
    const finish = () => {
      record.finished = true;
      record.media.removeEventListener('change', record.onMediaChange);
      if (activeDeals.get(key) === record) {
        activeDeals.delete(key);
        delete el.dataset.dealing;
      }
    };
    animation.onfinish = finish;
    record.media.addEventListener('change', record.onMediaChange);
    const cleanup = () => {
      if (record.finished || record.cancelTimer !== null) return;
      record.cancelTimer = window.setTimeout(() => cancelRecord(key, record), 0);
    };
    return cleanup;
  }, [epoch, handId, motionKey, reveal]);
  return <div ref={ref} className="table-dealt-card">{children}</div>;
}
