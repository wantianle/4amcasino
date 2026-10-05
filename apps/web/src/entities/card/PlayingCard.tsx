import { motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import { RANKS, SUITS, rankOf, suitOf, type CardId } from '@4am/shared';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { useStore } from '../../shared/store.ts';

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'] as const;

const sizes = {
  xs: 'h-10 w-7 rounded-md text-[0.55rem]',
  sm: 'h-14 w-10 rounded-lg text-xs',
  // L2 seat-unit hole cards: 80×56, the mockup's enlarged pod cards
  // (corner index ~21px + single center pip, no rotated bottom-right index)
  pod: 'h-20 w-14 rounded-lg text-[21px]',
  // L3 community-card tier: the mockup's board card — 84×120, big index,
  // single center pip
  board: 'h-30 w-21 rounded-[13px] text-[30px]',
  md: 'h-24 w-[4.2rem] rounded-xl text-base',
} as const;
const centerSizes = {
  xs: 'text-sm',
  sm: 'text-lg',
  pod: 'text-[30px]',
  board: 'text-[58px]',
  md: 'text-3xl',
} as const;

/* rev-3 seat-pod face rules (podFace): big corner index + single center pip,
   NO rotated bottom-right index. An explicit visual prop — never inferred
   from the size name — so desktop `pod` and phone `sm`/`xs` seat cards share
   the same face contract. */
const podFaceCorner: Partial<Record<keyof typeof sizes, string>> = {
  xs: 'text-[11px]',
  sm: 'text-base',
};
const podFacePip: Partial<Record<keyof typeof sizes, string>> = {
  xs: 'text-[16px]',
  sm: 'text-[22px]',
};

export type CardFacePreset = 'gg-four-color' | 'gg-solid' | 'classic-large' | 'jumbo-accessible' | 'minimal';
export type CardBackPreset =
  | 'indigo'
  | 'crimson'
  | 'emerald'
  | 'slate'
  | 'wine-lattice'
  | 'black-gold'
  | 'classic-red-blue'
  | 'geometry'
  | 'deep-blue-silver';

const CARD_BACK_PRESETS: readonly CardBackPreset[] = [
  'indigo', 'crimson', 'emerald', 'slate', 'wine-lattice', 'black-gold',
  'classic-red-blue', 'geometry', 'deep-blue-silver',
];
const CARD_FACE_PRESETS: readonly CardFacePreset[] = [
  'gg-four-color', 'gg-solid', 'classic-large', 'jumbo-accessible', 'minimal',
];
function isCardFacePreset(value: unknown): value is CardFacePreset {
  return typeof value === 'string' && CARD_FACE_PRESETS.includes(value as CardFacePreset);
}
function isCardBackPreset(value: unknown): value is CardBackPreset {
  return typeof value === 'string' && CARD_BACK_PRESETS.includes(value as CardBackPreset);
}

/** A compact, self-hosted court sprite. Only the upper half is defined; the
 * second use rotates that half into the lower half. The seam is deliberately
 * left open: no half draws a stroke on y=35, so the two halves join once. */
function CourtArt() {
  const rawId = useId();
  const spriteId = `card-court-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className="playing-card-court" viewBox="0 0 48 70" aria-hidden="true">
      <use href={`#${spriteId}`} />
      <use href={`#${spriteId}`} transform="rotate(180 24 35)" />
      <defs>
        <g id={spriteId}>
          <g clipPath={`url(#${spriteId}-clip)`}>
            <path className="playing-card-court-crown" d="M9 15 13 4l7 7 4-8 4 8 7-7 4 11-15 6Z" />
            <path className="playing-card-court-hair" d="M16 17c1-7 15-9 17 0v10H16Z" />
            <circle className="playing-card-court-face" cx="24" cy="22" r="7" />
            <path className="playing-card-court-face-detail" d="m20 22 2 1 2-1m3 0 2 1 1-1M22 26q2 2 4 0" />
            <path className="playing-card-court-collar" d="m16 29 8-5 8 5-3 6H19Z" />
            <path className="playing-card-court-coat" d="M10 36c1-7 6-10 14-10s13 3 14 10Z" />
            <path className="playing-card-court-sash" d="m15 30 17-7-2 11-16 3Z" />
            <path className="playing-card-court-jewel" d="m24 27 2 3-2 3-2-3Z" />
            <path className="playing-card-court-sword" d="m35 28 5-10m-7 12 5-1" />
          </g>
        </g>
        <clipPath id={`${spriteId}-clip`}><rect width="48" height="35" /></clipPath>
      </defs>
    </svg>
  );
}

export function PlayingCard({
  card,
  faceDown = false,
  size = 'md',
  deal = false,
  dealDelay = 0,
  podFace = false,
  cardFace,
  cardBackStyle,
  className,
}: {
  card?: CardId;
  faceDown?: boolean;
  size?: keyof typeof sizes;
  deal?: boolean;
  /** Seconds to hold before the flip — lets a flop cascade left to right. */
  dealDelay?: number;
  /** seat-pod face contract (see podFaceCorner) — used by the L2 seat unit */
  podFace?: boolean;
  /** Optional visual preset hook; preference wiring can select this later. */
  cardFace?: CardFacePreset;
  /** Optional back preset hook; preference wiring can select this later. */
  cardBackStyle?: CardBackPreset;
  className?: string;
}) {
  const { cardBack, fourColor } = useStore((s) => s.prefs);
  const reduce = useReducedMotion();
  const facePreset: CardFacePreset = isCardFacePreset(cardFace)
    ? cardFace
    : fourColor
      ? 'gg-four-color'
      : 'classic-large';
  const backPreset: CardBackPreset = isCardBackPreset(cardBackStyle)
    ? cardBackStyle
    : isCardBackPreset(cardBack)
      ? cardBack
      : 'crimson';
  if (faceDown || card === undefined) {
    return (
      <div
        className={cn(
          sizes[size],
          'card-back shrink-0 shadow-sm ring-1 ring-black/10',
          `card-back-${backPreset}`,
          deal && 'animate-deal',
          !faceDown && 'opacity-0', // placeholder slot keeps layout stable
          className,
        )}
        data-card-back={backPreset}
        data-card-size={size}
        role={faceDown ? 'img' : undefined}
        aria-hidden={!faceDown || undefined}
        aria-label={faceDown ? t('face-down card') : undefined}
      />
    );
  }
  const rank = RANKS[rankOf(card)]!;
  const suitIdx = suitOf(card);
  const glyph = SUIT_GLYPHS[suitIdx]!;
  const flip = deal && !reduce;
  // a dealt card lands back-first and flips over: the wrapper holds perspective,
  // the inner turns 180° with both faces backface-hidden so you see back → face
  // (real reveal animation requested by notpritam, docs/FEATURES.md)
  return (
    <motion.div
      initial={flip ? { y: -14, opacity: 0 } : deal ? { opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.25, delay: dealDelay, ease: 'easeOut' }}
      style={{ perspective: 640 }}
        className={cn(sizes[size], podFace && podFaceCorner[size], 'relative shrink-0 select-none', className)}
      data-card-face={facePreset}
      data-card-back={backPreset}
      data-card-size={size}
        aria-label={`${rank}${SUITS[suitIdx]}`}
      role="img"
    >
      <motion.div
        initial={flip ? { rotateY: 180 } : false}
        animate={{ rotateY: 0 }}
        transition={{ type: 'spring', stiffness: 190, damping: 21, delay: dealDelay + 0.1 }}
        style={{ transformStyle: 'preserve-3d' }}
        className="absolute inset-0"
      >
        <div
          className={cn(
            'absolute inset-0 rounded-[inherit] bg-white shadow-sm ring-1 ring-slate-200 [backface-visibility:hidden]',
            'playing-card-face',
          )}
          data-card-face={facePreset}
          data-card-back={backPreset}
          data-card-rank={rank}
          data-card-suit={suitIdx}
        >
             <div className="playing-card-index absolute left-1 top-0.5 font-display font-bold leading-tight">
            {rank}
            <div className="-mt-0.5">{glyph}</div>
          </div>
           {(['J', 'Q', 'K'].includes(rank) && (facePreset === 'classic-large' || facePreset === 'gg-four-color')) ? (
             <CourtArt />
           ) : facePreset === 'gg-solid' ? (
             <div className="playing-card-solid-logo" aria-hidden="true">{glyph}</div>
           ) : (podFace || size === 'pod' || size === 'board' || size === 'md') && (
            <div
              className={cn(
                'playing-card-pip absolute inset-0 flex items-center justify-center',
                centerSizes[size],
                podFace && podFacePip[size],
              )}
            >
              {glyph}
            </div>
          )}
          {/* rev-3: the pod face drops the rotated bottom-right index — via the
              explicit podFace prop; the felt board tier drops it too */}
           {((!podFace && size !== 'pod' && size !== 'board') || facePreset === 'gg-solid') && (
             <div className="playing-card-index playing-card-index--bottom absolute bottom-0.5 right-1 rotate-180 font-display font-bold leading-tight">
              {rank}
              <div className="-mt-0.5">{glyph}</div>
            </div>
          )}
        </div>
        {flip && (
          <div
            className={cn(
              'card-back absolute inset-0 rounded-[inherit] shadow-sm ring-1 ring-black/10 [backface-visibility:hidden] [transform:rotateY(180deg)]',
               `card-back-${backPreset}`,
            )}
            data-card-back={backPreset}
            aria-hidden="true"
          />
        )}
      </motion.div>
    </motion.div>
  );
}
