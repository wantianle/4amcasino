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

/** Deal cadence (ms). Every "one card behind the next" gap reads these two
 *  constants so a rhythm retune is one edit per number, not a hunt through the
 *  table code. Durations themselves live in the --table-dur-* tokens (the flop
 *  pull reads its own --table-dur-flop-pull/stagger tokens in the effect). */
export const DEAL_STAGGER_MS = 140;      /* second hole card behind the first */
export const SEAT_DEAL_STAGGER_MS = 70;  /* dealer ripple from seat to seat */

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

/** The element's laid-out slot in viewport px, ignoring any running transform:
 *  a slide origin must be a felt position, not a card caught mid-flight.
 *  offsetWidth/Height are pre-transform, and a translate leaves the measured
 *  width intact, so the width ratio is the accumulated canvas scale. */
function slotRect(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  const k = el.offsetWidth ? rect.width / el.offsetWidth : 1;
  const parent = el.offsetParent as HTMLElement | null;
  const pr = parent?.getBoundingClientRect();
  return {
    x: (pr?.left ?? 0) + el.offsetLeft * k,
    y: (pr?.top ?? 0) + el.offsetTop * k,
    width: el.offsetWidth * k,
    height: el.offsetHeight * k,
  };
}

/** A slide card's origin is a felt point on the card's OWN horizontal line, so
 *  the flop is pulled out sideways instead of dropping from the deck (which
 *  sits above the board). The first card starts at the deck's x; a card that
 *  names `slideFrom` starts at that card's slot — the flop's 2nd/3rd cards
 *  slide out from under the 1st. Keeping the origin on the target's y means the
 *  push is a pure horizontal translation. */
function slideOriginRect(
  el: HTMLDivElement,
  deck: Element,
  slideFrom: string | undefined,
  to: DOMRect,
): { x: number; y: number; width: number; height: number } {
  let base: { x: number; y: number; width: number; height: number } = (() => {
    const r = deck.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })();
  if (slideFrom) {
    const canvas = el.closest('.table-canvas');
    const origin = canvas
      ? [...canvas.querySelectorAll<HTMLElement>('.table-dealt-card')].find(
          (c) => c.dataset.dealKey === slideFrom,
        )
      : null;
    if (origin) base = slotRect(origin);
  }
  return { x: base.x, y: to.y, width: base.width, height: to.height };
}

/** Animate the real card, not a duplicate. A registry owns the animation,
 *  listener and DOM marker so StrictMode replay can reuse all three safely. */
export function DealCard({ children, delay = 0, handId = null, motionKey, epoch = 0, reveal = false, mode, slideFrom, staggerIndex }: {
  children: ReactNode; delay?: number; handId?: string | null; motionKey?: string; epoch?: number; reveal?: boolean;
  mode?: DealMode;
  /** motionKey of the card a slide card is pulled out from (the flop's 1st
   *  card); omitted, a slide starts at the deck. */
  slideFrom?: string;
  /** Flop position (0-based). When set, the slide's delay is
   *  `staggerIndex * --table-dur-flop-stagger` and its duration is
   *  `--table-dur-flop-pull`, so the three flop cards read as a sequence
   *  instead of one motion; ignored by non-slide modes. */
  staggerIndex?: number;
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
    const scale = to.width / el.offsetWidth || 1;
    const style = getComputedStyle(el);
    // deck → slot delta in the card's own coordinate space (shared by the
    // flight and the flop push; the push keeps the card flat, the toss shrinks
    // it). The push is HORIZONTAL: its origin sits on the card's own line (see
    // slideOriginRect) so the flop is pulled out sideways — not dropped from
    // the deck above it, which is what read as "落下".
    const from = dealMode === 'slide'
      ? slideOriginRect(el, deck, slideFrom, to)
      : deck.getBoundingClientRect();
    const dx = (from.x + from.width / 2 - to.x - to.width / 2) / scale;
    const dy = (from.y + from.height / 2 - to.y - to.height / 2) / scale;
    // The flop pull is a SEQUENCE, not one motion: its own duration + per-card
    // beat come from the flop tokens so "the 1st card out, then the rest" reads
    // legibly — a 820ms card cannot fit a three-card sequence inside ~1s without
    // also slowing the seat hole-card flight. Non-flop deals keep delay/820ms.
    const flopPull = dealMode === 'slide' && staggerIndex !== undefined;
    const duration = parseDurMs(
      style.getPropertyValue(
        dealMode === 'flip'
          ? '--table-dur-flip'
          : flopPull
            ? '--table-dur-flop-pull'
            : '--table-dur-deal',
      ),
      dealMode === 'flip' ? 900 : flopPull ? 400 : 820,
    );
    const startDelay = dealMode === 'flip'
      ? 0
      : flopPull
        ? staggerIndex * parseDurMs(style.getPropertyValue('--table-dur-flop-stagger'), 300)
        : delay;
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
      // cards coming into place, --table-dur-flip for in-place reveals, the
      // flop-pull pair for the board's sequence). The tokens file writes
      // SECONDS and the /api/config injection writes MILLISECONDS, so
      // parseDurMs is the only safe reader; the literals are its no-token
      // fallbacks.
      duration,
      delay: startDelay, easing: style.getPropertyValue('--table-ease-decelerate').trim(), fill: 'backwards',
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
  }, [epoch, handId, motionKey, reveal, mode, slideFrom, staggerIndex]);
  return <div ref={ref} className="table-dealt-card" data-deal-key={motionKey}>{children}</div>;
}
