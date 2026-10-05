import { useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Spinner } from '../../shared/ui/index.tsx';
import { metricValue, type RoomHud } from '../../features/stats/types.ts';
import { isValidHudPlayer } from './SeatBadges.tsx';

/** Off by default. Closing unmounts the request consumer and clears all numbers. */
export function PlayerHud({ roomId, userId, onClose, opener, onData }: { roomId: string; userId: number; onClose: () => void; opener?: HTMLElement | null; onData: (data: RoomHud | null) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    document.addEventListener('keydown', trap, true);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('keydown', trap, true); if (opener?.isConnected) opener.focus(); };
  }, [onClose, opener]);
  return <div className="relative shrink-0">
    <div className="fixed inset-0 z-50 bg-black/20" onClick={onClose} />
    <section ref={dialogRef} id="room-player-hud" role="dialog" aria-modal="true" data-poker-hotkeys-blocked aria-label={t('Player HUD')} className="fixed left-1/2 top-1/2 z-50 w-[min(22rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700 bg-slate-950 p-3 text-slate-100 shadow-xl">
      <header className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t('Player HUD')}</h2><Button variant="ghost" onClick={onClose}>{t('Close')}</Button></header>
      <HudContent key={`${roomId}-${userId}`} roomId={roomId} userId={userId} onData={onData} />
    </section>
  </div>;
}

function HudContent({ roomId, userId, onData }: { roomId: string; userId: number; onData: (data: RoomHud | null) => void }) {
  const [data, setData] = useState<RoomHud | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError(''); onData(null);
    api.roomHud(roomId).then((r) => { if (!active) return; if (Array.isArray(r?.players)) { setData(r); onData(r); } else setError(t('Could not load statistics.')); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [roomId, revision, onData]);
  if (error) return <div role="alert" className="space-y-2 text-sm"><p>{t('Could not load statistics.')}</p><p className="text-xs text-slate-400">{error}</p><Button onClick={() => refresh((n) => n + 1)}>{t('Retry')}</Button></div>;
  if (!data) return <div role="status"><Spinner label={t('Loading statistics…')} /></div>;
  const players = Array.isArray(data.players) ? data.players.filter(isValidHudPlayer) : [];
  return <><p className="mb-3 text-xs text-slate-400">{t('This room only · minimum {n} hands', { n: data.minHands })}</p><div className="max-h-[50dvh] space-y-2 overflow-y-auto">
    {players.length === 0 && <p role="status" className="text-sm text-slate-400">{t('No players yet.')}</p>}
    {players.filter((p) => p.userId === userId).map((p) => <article key={p.userId} className="rounded-lg border border-slate-800 p-3" data-hud-player={p.userId}>
      <h3 className="truncate text-sm font-semibold">{p.displayName || p.username}</h3>
      {p.hidden ? <p className="mt-2 text-xs text-slate-400">{t('Statistics hidden')}</p>
        : !p.sufficient || p.sample < Math.max(data.minHands, p.minHands) || !p.stats ? <p className="mt-2 text-xs text-amber-400">{t('Low sample: {n} / {min} hands', { n: p.sample, min: Math.max(data.minHands, p.minHands) })}</p>
         : <><p className="mt-1 text-xs text-slate-400">{t('{n} hands', { n: p.sample })} · {p.dataConfidence}{p.confidence === 'low' && <span className="ml-2 text-amber-400">{t('Low confidence')}</span>}</p><p className="mt-2 rounded-md border border-slate-800 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-300">{p.streak ? t('Last 50 hands: {net} bb · {sample} hands', { net: p.streak.netBB > 0 ? `+${p.streak.netBB}` : p.streak.netBB, sample: p.streak.sample }) : t('Last 50 hands: unavailable')}</p><dl className="mt-3 grid grid-cols-3 gap-2 text-xs">{[['vpip', 'VPIP'], ['pfr', 'PFR'], ['threeBet', '3bet']].map(([key, label]) => <div key={key}><dt className="text-slate-400">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{metricValue(p.stats![key!])}</dd><dd className="mt-1 text-[10px] text-slate-500">{p.stats![key!] ? `${p.stats![key!]!.hits} / ${p.stats![key!]!.opportunities}` : '—'}</dd></div>)}</dl></>}
    </article>)}
  </div><div className="mt-3"><Button variant="secondary" onClick={() => refresh((n) => n + 1)}>{t('Refresh')}</Button></div></>;
}
