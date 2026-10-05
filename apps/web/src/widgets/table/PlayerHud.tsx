import { useEffect, useState } from 'react';
import { api } from '../../shared/api.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Spinner } from '../../shared/ui/index.tsx';
import { metricValue, type RoomHud } from '../../features/stats/types.ts';

/** Off by default. Closing unmounts the request consumer and clears all numbers. */
export function PlayerHud({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  return <div className="relative shrink-0">
    <button type="button" aria-expanded={open} aria-controls="room-player-hud" onClick={() => setOpen(!open)} className="h-8 rounded-lg px-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-indigo-400">HUD</button>
    {open && <section id="room-player-hud" aria-label={t('Player HUD')} className="fixed right-3 top-36 z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-slate-700 bg-slate-950 p-3 shadow-xl md:absolute md:top-10">
      <header className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t('Player HUD')}</h2><Button variant="ghost" onClick={() => setOpen(false)}>{t('Close')}</Button></header>
      <HudContent key={roomId} roomId={roomId} />
    </section>}
  </div>;
}

function HudContent({ roomId }: { roomId: string }) {
  const [data, setData] = useState<RoomHud | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    api.roomHud(roomId).then((r) => { if (active) setData(r); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [roomId, revision]);
  if (error) return <div role="alert" className="space-y-2 text-sm"><p>{t('Could not load statistics.')}</p><p className="text-xs text-slate-400">{error}</p><Button onClick={() => refresh((n) => n + 1)}>{t('Retry')}</Button></div>;
  if (!data) return <div role="status"><Spinner label={t('Loading statistics…')} /></div>;
  return <><p className="mb-3 text-xs text-slate-400">{t('This room only · minimum {n} hands', { n: data.minHands })}</p><div className="max-h-[50dvh] space-y-2 overflow-y-auto">
    {data.players.length === 0 && <p role="status" className="text-sm text-slate-400">{t('No players yet.')}</p>}
    {data.players.map((p) => <article key={p.userId} className="rounded-lg border border-slate-800 p-3" data-hud-player={p.userId}>
      <h3 className="truncate text-sm font-semibold">{p.displayName || p.username}</h3>
      {p.hidden ? <p className="mt-2 text-xs text-slate-400">{t('Statistics hidden')}</p>
        : !p.sufficient || p.sample < Math.max(data.minHands, p.minHands) || !p.stats ? <p className="mt-2 text-xs text-amber-400">{t('Low sample: {n} / {min} hands', { n: p.sample, min: Math.max(data.minHands, p.minHands) })}</p>
        : <><p className="mt-1 text-xs text-slate-400">{t('{n} hands', { n: p.sample })} · {p.dataConfidence}{p.confidence === 'low' && <span className="ml-2 text-amber-400">{t('Low confidence')}</span>}</p><dl className="mt-3 grid grid-cols-3 gap-2 text-xs">{[['vpip', 'VPIP'], ['pfr', 'PFR'], ['threeBet', '3bet']].map(([key, label]) => <div key={key}><dt className="text-slate-400">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{metricValue(p.stats![key!])}</dd><dd className="mt-1 text-[10px] text-slate-500">{p.stats![key!] ? `${p.stats![key!]!.hits} / ${p.stats![key!]!.opportunities}` : '—'}</dd></div>)}</dl></>}
    </article>)}
  </div><div className="mt-3"><Button variant="secondary" onClick={() => refresh((n) => n + 1)}>{t('Refresh')}</Button></div></>;
}
