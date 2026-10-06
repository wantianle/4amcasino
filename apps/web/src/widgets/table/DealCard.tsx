import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { claimDealMotion } from '../../shared/gameClient.ts';
import { parseDurMs } from '../../shared/lib/tableTimers.ts';

type ActiveDeal = {
  animation: Animation;
  element: HTMLDivElement;
  media: MediaQueryList;
  onMediaChange: () => void;
  cancelTimer: number | null;
  finished: boolean;
};

const activeDeals = new Map<string, ActiveDeal>();

/** Deal cadence (ms). Every "one card behind the next" gap reads these three
 *  constants so a rhythm retune is one edit per number, not a hunt through the
 *  table code. Durations themselves live in the --table-dur-* tokens. */
export const DEAL_STAGGER_MS = 140;      /* second hole card behind the first */
export const SEAT_DEAL_STAGGER_MS = 70;  /* dealer ripple from seat to seat */
export const FLOP_STAGGER_MS = 160;      /* flop cards pushed out one after another */

/** How a card arrives:
 *   fly   — arcs in from the deck, shrinking + tilting (seat hole cards).
 *   slide — glides flat from the deck to its slot (flop push, no rotate/scale).
 *   flip  — turns over in place on the Y axis (showdown, board turn/river).
 *  `reveal` stays as shorthand for 'flip' so the seat call sites don't change. */
export type DealMode = 'fly' | 'slide' | 'flip';

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
 *  listener and DOM marker so StrictMode replay can reuse all three safely. */
export function DealCard({ children, delay = 0, handId = null, motionKey, epoch = 0, reveal = false, mode }: {
  children: ReactNode; delay?: number; handId?: string | null; motionKey?: string; epoch?: number; reveal?: boolean;
  mode?: DealMode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const deck = el?.closest('.table-canvas')?.querySelector('[data-table-deck]');
    if (!el || !deck || !motionKey) return;
    const key = `${handId}:${motionKey}:${epoch}`;
    const dealMode: DealMode = mode ?? (reveal ? 'flip' : 'fly');

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
    // deck → slot delta in the card's own coordinate space (shared by the
    // flight and the flop push; the push keeps the card flat, the toss shrinks it)
    const dx = (from.x + from.width / 2 - to.x - to.width / 2) / scale;
    const dy = (from.y + from.height / 2 - to.y - to.height / 2) / scale;
    const animation = el.animate(dealMode === 'flip' ? [
      { transform: 'perspective(600px) rotateY(90deg)', opacity: 0 },
      { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 },
    ] : dealMode === 'slide' ? [
      // 平移: a card pushed across the felt stays full size, unrotated and
      // (nearly) opaque the whole way — decelerate easing makes it STOP on the
      // slot like friction took it
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.85 },
      { transform: 'none', opacity: 1 },
    ] : [
      { transform: `translate(${dx}px, ${dy}px) scale(.55) rotate(-8deg)`, opacity: 0.3 },
      { transform: 'none', opacity: 1 },
    ], {
      // durations come from the dedicated motion tokens (--table-dur-deal for
      // cards coming into place, --table-dur-flip for in-place reveals). The
      // tokens file writes SECONDS and the /api/config injection writes
      // MILLISECONDS, so parseDurMs is the only safe reader; the literals are
      // its no-token fallbacks.
      duration: parseDurMs(
        style.getPropertyValue(dealMode === 'flip' ? '--table-dur-flip' : '--table-dur-deal'),
        dealMode === 'flip' ? 900 : 820,
      ),
      delay: dealMode === 'flip' ? 0 : delay, easing: style.getPropertyValue('--table-ease-decelerate').trim(), fill: 'backwards',
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
  }, [epoch, handId, motionKey, reveal, mode]);
  return <div ref={ref} className="table-dealt-card">{children}</div>;
}
