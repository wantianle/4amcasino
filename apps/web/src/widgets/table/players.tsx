import { Link } from 'react-router-dom';
import type { CardId, PlayerAction } from '@4am/shared';
import { Badge } from '../../shared/ui/index.tsx';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { Crown, MicrophoneSlash } from '@phosphor-icons/react';
import { TurnProgress } from './TurnProgress.tsx';
import { StackValue, WinBadge } from './WinnerFx.tsx';

export interface SeatView {
  seat: number;
  userId: number;
  username: string;
  displayName: string;
  avatarVersion: number;
  stack: number;
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  isToAct: boolean;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  broke: boolean;
  sittingOut: boolean;
  /** Currently up the most chips in this room (stack minus buy-ins). */
  isLeader: boolean;
  connected: boolean;
  speaking: boolean;
  voiceMuted: boolean;
  revealed?: CardId[];
  won: boolean;
  /** Chips netted by this seat in the settled hand; only set when `won`. */
  wonAmount?: number;
  /** Chips requested from the bank, still waiting for approval. */
  pendingBuy: number;
  lastAction?: PlayerAction & { auto?: boolean };
  /** P2 B2: this seat's remaining time bank in ms. Optional and additive -
   *  consumers that predate the feature (3D) never see it. */
  bankMs?: number;
}

function actionChip(a: PlayerAction & { auto?: boolean }) {
  const label =
    a.type === 'fold'
      ? a.auto
        ? t('Timed out')
        : t('Fold')
      : a.type === 'check'
        ? t('Check')
        : a.type === 'call'
          ? t('Call')
          : a.type === 'bet'
            ? t('Bet {n}', { n: fmt(a.amount ?? 0) })
            : t('Raise to {n}', { n: fmt(a.amount ?? 0) });
  const tone = a.type === 'fold' ? 'rose' : a.type === 'raise' || a.type === 'bet' ? 'amber' : 'slate';
  return <Badge tone={tone}>{label}</Badge>;
}

function LeaderCrown({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      title={t('Chip leader')}
      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-white ring-2 ring-white dark:ring-slate-900"
    >
      <Crown size={11} weight="fill" />
    </span>
  );
}

function VoiceDot({ muted }: { muted: boolean }) {
  if (!muted) return null;
  return (
    <span
      title={t('muted')}
      className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[0.6rem] text-white ring-2 ring-white dark:ring-slate-900"
    >
      <MicrophoneSlash size={11} weight="fill" />
    </span>
  );
}

export function PlayerRow({ p, urgent }: { p: SeatView; urgent: boolean }) {
  return (
    <div
      className={cn(
        'relative flex items-center gap-3 rounded-2xl bg-white p-3 pb-4 pr-4 ring-1 ring-slate-200/70 transition-all dark:bg-slate-900 dark:ring-slate-700/70',
        p.isToAct && 'turn-stripes bg-indigo-50/80 ring-2 ring-indigo-500 shadow-md dark:bg-indigo-950/40',
        p.isToAct && urgent && 'turn-stripes-rose bg-rose-50/80 ring-rose-500 animate-urgent dark:bg-rose-950/40',
        p.isLeader && !p.isToAct && 'ring-2 ring-amber-400/70',
        p.won && 'animate-winner',
        (p.folded || !p.connected) && 'opacity-50',
        p.broke && 'opacity-60 saturate-50',
      )}
    >
      {p.isToAct && <TurnProgress seat={p.seat} />}
      <div className="relative">
        <Link
          to={`/players/${p.userId}`}
          aria-label={t("{name}'s profile", { name: p.displayName })}
        >
          <Avatar userId={p.userId} name={p.displayName} version={p.avatarVersion} speaking={p.speaking} />
        </Link>
        <VoiceDot muted={p.voiceMuted} />
        <LeaderCrown show={p.isLeader} />
        {p.isButton && (
          <span
            title={t('Dealer button')}
            className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[0.6rem] font-bold text-white ring-2 ring-white dark:ring-slate-900"
          >
            D
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Link to={`/players/${p.userId}`} className="block truncate text-sm font-semibold hover:underline">
          {p.displayName}
        </Link>
        <div
          className={cn(
            'font-display text-xs',
            p.broke ? 'font-bold text-rose-500' : 'text-slate-500 dark:text-slate-400',
          )}
        >
          <StackValue stack={p.stack} won={p.won} />
          {p.isToAct && p.bankMs !== undefined && p.bankMs > 0 && (
            <span className="ml-1.5 font-semibold text-amber-500" title={t('time bank remaining')}>
              {t('Bank {n}s', { n: Math.ceil(p.bankMs / 1000) })}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {p.won && <WinBadge amount={p.wonAmount ?? 0} />}
        {p.broke ? (
          <Badge tone="rose">{t('Out of chips')}</Badge>
        ) : p.sittingOut ? (
          <Badge tone="slate">{t('Sitting out')}</Badge>
        ) : p.lastAction ? (
          actionChip(p.lastAction)
        ) : p.allIn ? (
          <Badge tone="indigo">{t('All-in')}</Badge>
        ) : null}
      </div>
      {p.inHand && (!p.folded || p.revealed) && (
        <div className="flex gap-1">
          {p.revealed ? (
            p.revealed.map((c) => <PlayingCard key={c} card={c} size="xs" deal />)
          ) : (
            <>
              <PlayingCard faceDown size="xs" />
              <PlayingCard faceDown size="xs" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function YouRow({ p, cards, urgent }: { p: SeatView; cards: CardId[]; urgent: boolean }) {
  return (
    <div
      className={cn(
        'relative flex items-center gap-4 rounded-2xl bg-white p-4 pb-5 ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70',
        p.isToAct && 'turn-stripes bg-indigo-50/80 ring-2 ring-indigo-500 shadow-lg dark:bg-indigo-950/40',
        p.isToAct && urgent && 'turn-stripes-rose bg-rose-50/80 ring-rose-500 animate-urgent dark:bg-rose-950/40',
        p.isLeader && !p.isToAct && 'ring-2 ring-amber-400/70',
        p.won && 'animate-winner',
        p.folded && 'opacity-60',
      )}
    >
      {p.isToAct && <TurnProgress seat={p.seat} className="inset-x-4 bottom-1.5" />}
      <div className="relative">
        <Avatar userId={p.userId} name={p.displayName} version={p.avatarVersion} size="lg" speaking={p.speaking} className="bg-indigo-600 text-white" />
        <VoiceDot muted={p.voiceMuted} />
        <LeaderCrown show={p.isLeader} />
      </div>
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span>
            {t('You')}
            {p.isButton && <span className="ml-2 text-xs text-slate-400">{t('(dealer)')}</span>}
          </span>
          {p.won && <WinBadge amount={p.wonAmount ?? 0} />}
        </div>
        <div
          className={cn(
            'font-display text-sm',
            p.broke ? 'font-bold text-rose-500' : 'text-slate-500 dark:text-slate-400',
          )}
        >
          <StackValue stack={p.stack} won={p.won} />
          {p.isToAct && p.bankMs !== undefined && p.bankMs > 0 && (
            <span className="ml-1.5 text-xs font-semibold text-amber-500" title={t('time bank remaining')}>
              {t('Bank {n}s', { n: Math.ceil(p.bankMs / 1000) })}
            </span>
          )}
        </div>
      </div>
      <div className="ml-2">
        {p.broke ? (
          <Badge tone="rose">{t('Out of chips')}</Badge>
        ) : p.sittingOut ? (
          <Badge tone="slate">{t('Sitting out')}</Badge>
        ) : (
          p.lastAction && actionChip(p.lastAction)
        )}
      </div>
      <div className="ml-auto flex gap-2">
        {p.inHand && (cards.length > 0 || !p.folded) ? (
          cards.length ? (
            cards.map((c) => <PlayingCard key={c} card={c} size="md" deal />)
          ) : (
            <>
              <PlayingCard faceDown size="md" />
              <PlayingCard faceDown size="md" />
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
