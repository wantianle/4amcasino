import { useEffect, useState } from 'react';
import { api } from '../../shared/api.ts';
import { t } from '../../shared/i18n/index.ts';
import { Badge, Button, Panel, Spinner } from '../../shared/ui/index.tsx';
import { NetAreaChart } from './charts.tsx';
import { METRICS, metricValue, type HandStats, type MetricBucket } from './types.ts';

type Dimension = 'overall' | 'position' | 'street' | 'ip';
const DIMENSIONS: [Dimension, string][] = [['overall', 'Overview'], ['position', 'Position'], ['street', 'Street'], ['ip', 'IP / OOP']];
// Keep this in the same ring order as handStats.ts POSITION_VALUES.
const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'];
const STREETS: Record<string, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };

export function ProStats({ roomId }: { roomId: string }) {
  const [data, setData] = useState<HandStats | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const [dimension, setDimension] = useState<Dimension>('overall');
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    api.myStats({ roomId, minHands: 20 }).then((result) => { if (active) setData(result); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [roomId, revision]);
  if (error) return <div role="alert"><Panel className="space-y-3"><p>{t('Could not load statistics.')}</p><p className="text-sm text-slate-400">{error}</p><Button onClick={() => refresh((n) => n + 1)}>{t('Retry')}</Button></Panel></div>;
  if (!data) return <div role="status"><Panel><Spinner label={t('Loading statistics…')} /></Panel></div>;
  const empty: MetricBucket = { sample: 0, stats: {} };
  const buckets: [string, MetricBucket][] = dimension === 'overall' ? [[t('Overview'), data]]
    : dimension === 'position' ? [...POSITIONS, ...Object.keys(data.byPosition).filter((p) => !POSITIONS.includes(p))].map((p) => [p, data.byPosition[p] ?? empty])
    : dimension === 'street' ? Object.entries(STREETS).map(([key, label]) => {
      const s = data.byStreet[key];
      return [t(label), s ? { sample: s.sample, stats: { af: s.af, afq: s.afq } } : empty];
    }) : [['IP', data.byIpOop.ip], ['OOP', data.byIpOop.oop]];
  const metrics = dimension === 'street' ? METRICS.filter(([key]) => key === 'af' || key === 'afq') : METRICS;
  return <div className="space-y-4">
    <Panel className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-display text-lg font-bold">{t('Your room statistics')}</h2><p className="mt-1 text-xs text-slate-400">{t('Newest 5,000 settled hands · poker only, excluding squid.')}</p></div>
      <div className="flex items-center gap-2"><Badge tone={data.sufficient && data.sample > 0 ? 'slate' : 'amber'}>{t('{n} hands', { n: data.sample })}</Badge><Button variant="secondary" onClick={() => refresh((n) => n + 1)}>{t('Refresh')}</Button></div>
    </Panel>
    {data.sample === 0 ? <div role="status"><Panel><h3 className="font-semibold">{t('No completed hands yet.')}</h3><p className="mt-2 text-sm text-slate-400">{t('Statistics appear after a settled hand. Missing values are not zero.')}</p></Panel></div>
      : !data.sufficient && <p role="status" className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-400">{t('Low sample: {n} / {min} hands. Treat these numbers as observations, not conclusions.', { n: data.sample, min: data.minHands })}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900" aria-label={t('Statistics table')}>
      <div className="flex flex-wrap gap-1 border-b border-slate-800 p-3" role="group" aria-label={t('Statistics dimension')}>
        {DIMENSIONS.map(([key, label]) => <Button key={key} variant={dimension === key ? 'primary' : 'ghost'} aria-pressed={dimension === key} onClick={() => setDimension(key)}>{t(label)}</Button>)}
      </div>
      <p className="px-4 py-3 text-xs text-slate-400">{t(dimension === 'street' ? 'Street breakdown contains AF and AFq only.' : 'Value · hits / opportunities. Each column is an independent sample.')}</p>
      <div className="overflow-x-auto" tabIndex={0} aria-label={t('Statistics table')}>
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="sr-only">{t('Statistics table')}</caption>
          <thead><tr className="border-y border-slate-800 bg-slate-950/50"><th scope="col" className="sticky left-0 z-10 bg-slate-900 px-4 py-3">{t('Metric')}</th>{buckets.map(([label, bucket]) => <th key={label} scope="col" className="min-w-32 px-4 py-3 text-right font-medium"><div>{label}</div><div className="mt-1 text-xs font-normal text-slate-400">{t('{n} hands', { n: bucket.sample })}</div>{bucket.sample < data.minHands && <div className="mt-1 text-xs font-normal text-amber-400">{t('Low sample')}</div>}</th>)}</tr></thead>
          <tbody>{metrics.map(([key, label]) => <tr key={key} className="border-b border-slate-800/70 last:border-0 hover:bg-slate-800/40"><th scope="row" className="sticky left-0 bg-slate-900 px-4 py-2.5 font-medium whitespace-nowrap">{t(label)}</th>{buckets.map(([name, bucket]) => {
            const m = bucket.stats[key];
            return <td key={name} className="px-4 py-2 text-right"><div className="font-semibold">{metricValue(m)} <span className="text-[10px] font-normal text-slate-400">{m?.unit === 'ratio' ? 'ratio' : m?.unit === 'bb/100' ? 'bb/100' : ''}</span></div><div className="mt-0.5 whitespace-nowrap text-xs text-slate-400">{m ? `${m.hits} / ${m.opportunities}` : '—'}{(!m || m.opportunities === 0) && <span className="ml-2">{t('No opportunities')}</span>}</div></td>;
          })}</tr>)}</tbody>
        </table>
      </div>
      <p className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400">{t('AFq is a ratio (0–1). Net is a chip sum, not a percentage. Raw numerator / denominator follow the API; bb/100 numerator is scaled by 100.')}</p>
    </section>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0"><NetAreaChart points={data.trend} hands={data.sample} /></div>
      <Panel className="space-y-4"><h3 className="font-semibold">{t('Data quality')}</h3><div className="grid grid-cols-3 gap-2">{(['exact', 'legacy', 'partial'] as const).map((quality) => <div key={quality} className="rounded-lg bg-slate-800/60 p-3"><div className="text-xs text-slate-400">{quality}</div><div className="mt-1 font-display text-xl tabular-nums">{data.dataQuality[quality]}</div></div>)}</div><h4 className="text-sm font-medium">{t('Calculation notes')}</h4><ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-slate-400">{data.approximations.map((note) => <li key={note}>{t(note)}</li>)}</ul><p className="text-xs text-slate-500">{t('Metric version')} {data.metricVersion}</p></Panel>
    </div>
  </div>;
}
