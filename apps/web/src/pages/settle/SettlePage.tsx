import { PlatformDues, HouseRooms } from '../../features/house/PlatformDues.tsx';
import type { HouseDues, PlatformDuesReport } from '@4am/shared';
import { commissionRateLabel } from '@4am/shared';
import { useCommissionSettings } from '../../shared/useCommissionSettings.ts';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../shared/api.ts';
import type { SettlementMark } from '../../shared/api.ts';
import { ApiError } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { Button, Dialog, Input, Panel, Spinner } from '../../shared/ui/index.tsx';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { t, tr } from '../../shared/i18n/index.ts';

/** Settling up, in one place (requested by notpritam, docs/FEATURES.md).
 *
 *  One line per person across every room, the redirects that let a debt you are
 *  owed pay off a debt you owe without the money passing through you, and what
 *  you owe the house for keeping the servers on. */

interface NetLine {
  otherUserId: number;
  otherName: string;
  otherAvatarVersion: number;
  net: number;
  rooms: {
    roomId: string;
    roomName: string;
    amount: number;
    direction: 'owe' | 'owed';
    settlementId?: number;
  }[];
}

interface Redirect {
  payerUserId: number;
  payerName: string;
  payeeUserId: number;
  payeeName: string;
  amount: number;
}

interface SettleView {
  people: NetLine[];
  redirects: Redirect[];
  totals: { owedToMe: number; iOwe: number; net: number };
  house: HouseDues;
  platformHouse?: PlatformDuesReport;
  settled: {
    settlementId: number;
    amount: number;
    debtor: number;
    settledTs: number;
    otherUserId: number;
    otherName: string;
  }[];
}

/** Downscale a photo of a transfer to something worth storing. */
async function toProofDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

function Money({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        'font-display font-bold tabular-nums',
        value > 0
          ? 'text-emerald-600 dark:text-emerald-400'
          : value < 0
            ? 'text-rose-600 dark:text-rose-400'
            : '',
        className,
      )}
    >
      {value > 0 ? '+' : ''}
      {fmt(value)}
    </span>
  );
}

/** Fetch one side's transfer proof and turn it into a viewable URL.
 *
 *  Kept out of the component so the success path (Blob -> object URL) and the
 *  403/404 copy can be tested without a DOM. The fetch is injectable for that. */
export async function openSettlementProof(
  settlementId: number,
  userId: number,
  fetchProof: (settlementId: number, userId: number) => Promise<Blob> = api.settlementProof,
): Promise<{ url: string } | { error: string }> {
  try {
    const blob = await fetchProof(settlementId, userId);
    return { url: URL.createObjectURL(blob) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { error: t('No transfer proof uploaded.') };
    if (e instanceof ApiError && e.status === 403)
      return { error: t('This settlement is no longer available to you.') };
    return { error: t('The transfer proof could not be opened.') };
  }
}

export function TransferProofDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <Dialog open size="lg" title={t('Transfer proof')} onClose={onClose}>
      <img src={url} alt={t('Transfer proof')} className="mx-auto max-h-[70vh] max-w-full object-contain" />
    </Dialog>
  );
}

export function SettlementMarksContent({
  myUserId,
  otherUserId,
  otherName,
  marks,
  onOpenProof,
}: {
  myUserId: number | null;
  /** The known counterpart of THIS settlement. Match it exactly: a third-party
   *  mark must never be shown as "the other side" or offered for opening. */
  otherUserId: number;
  otherName: string;
  marks: SettlementMark[];
  onOpenProof?: (userId: number) => void;
}) {
  const otherMark = marks.find((m) => m.userId === otherUserId);
  const myMark = marks.find((m) => m.userId === myUserId);
  const card = (label: string, mark: SettlementMark | undefined, missing: string) => (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-900/60">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {mark ? (
        <>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{mark.note || t('No remark was added.')}</p>
          {mark.hasProof && onOpenProof ? (
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-300"
              onClick={() => onOpenProof(mark.userId)}
            >
              {t('Open transfer proof')}
            </button>
          ) : mark.hasProof ? null : <p className="mt-2 text-xs text-slate-400">{t('No transfer proof uploaded.')}</p>}
        </>
      ) : <p className="mt-1 text-sm text-slate-500">{missing}</p>}
    </div>
  );

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {card(t('Your note'), myMark, t('You have not filled this in yet.'))}
      {card(`${t('Their note')} · ${otherName}`, otherMark, t('{name} has not filled this in yet.', { name: otherName }))}
    </div>
  );
}

function SettlementMarks({ line }: { line: NetLine }) {
  return <div className="space-y-3">{line.rooms.map((room, index) => (
    <SettlementRoomMarks key={room.settlementId ?? `${room.roomId}-${index}`} settlementId={room.settlementId} otherUserId={line.otherUserId} otherName={line.otherName} roomName={room.roomName} />
  ))}</div>;
}

function SettlementRoomMarks({ settlementId, otherUserId, otherName, roomName }: { settlementId?: number; otherUserId: number; otherName: string; roomName: string }) {
  const myUserId = useStore((s) => s.auth.userId);
  const [marks, setMarks] = useState<SettlementMark[]>([]);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!settlementId);
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    setMarks([]);
    setLoading(!!settlementId);
    if (!settlementId) {
      setMarks([]);
      return;
    }
    api.settlementMarks(settlementId)
      .then((response) => {
        if (!alive) return;
        setMarks(response.marks);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          setError(t('This settlement is no longer available to you.'));
        } else setError(t('Could not load settlement notes.'));
      }).finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
    };
  }, [settlementId]);

  useEffect(() => () => {
    if (proofUrl) URL.revokeObjectURL(proofUrl);
  }, [proofUrl]);

  async function openProof(userId: number) {
    if (!settlementId || proofBusy) return;
    setProofBusy(true);
    setProofError(null);
    try {
      const result = await openSettlementProof(settlementId, userId);
      if ('url' in result) setProofUrl(result.url);
      else setProofError(result.error);
    } finally {
      setProofBusy(false);
    }
  }
  return (
    <div className="mt-4 border-t border-slate-200/70 pt-3 dark:border-slate-700/70">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('Settlement notes and proofs')}</div>
      {roomName && <p className="mb-2 text-xs text-slate-500">{roomName}</p>}
      {!settlementId && <p className="mb-2 text-sm text-slate-500">{t('Settlement has not been started yet.')}</p>}
      {error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : loading ? <Spinner label={t('Loading settlement notes…')} /> : settlementId ? (
        <SettlementMarksContent
          myUserId={myUserId}
          otherUserId={otherUserId}
          otherName={otherName}
          marks={marks}
          onOpenProof={(userId) => {
            void openProof(userId);
          }}
        />
      ) : null}
      {proofBusy && <Spinner label={t('Opening transfer proof…')} />}
      {proofError && <p role="alert" className="mt-2 text-sm text-rose-600">{proofError}</p>}
      {proofUrl && <TransferProofDialog url={proofUrl} onClose={() => setProofUrl(null)} />}
    </div>
  );
}

/** Shared by "mark settled" and "record a house payment": a remark and a photo. */
function ProofFields({
  note,
  setNote,
  fileName,
  onPick,
  placeholder,
}: {
  note: string;
  setNote: (v: string) => void;
  fileName: string | null;
  onPick: (f: File | undefined) => void;
  placeholder: string;
}) {
  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Remark')}</span>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          placeholder={placeholder}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Photo of the transfer (optional)')}</span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onPick(e.target.files?.[0])}
          className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:bg-slate-800 dark:file:text-slate-200"
        />
        {fileName && <span className="mt-1 block text-xs text-emerald-600">✓ {fileName}</span>}
      </label>
    </>
  );
}

export function SettlePage() {
  const commission = useCommissionSettings();
  const [view, setView] = useState<SettleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<NetLine | null>(null);
  const [houseOpen, setHouseOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(() => {
    api
      .settleView()
      .then(setView)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not load'));
  }, []);
  useEffect(load, [load]);

  if (error) return <p className="p-6 text-sm text-rose-600">{tr(error)}</p>;
  if (!view) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner label={t('Working out who owes whom…')} />
      </div>
    );
  }

  if (view.platformHouse) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <header className="mb-6">
          <h1 className="font-display text-2xl font-bold">{t('Settle up')}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t('Platform commission due from users, with recorded payments and room details.')}
          </p>
        </header>
        <PlatformDues initialReport={view.platformHouse} />
      </div>
    );
  }

  const { totals, house } = view;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold">{t('Settle up')}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t('Every room you have played, netted down to one number per person.')}
        </p>
      </header>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('Players owe you')}</div>
          <Money value={totals.owedToMe} className="text-2xl" />
        </Panel>
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('You owe players')}</div>
          <Money value={-totals.iOwe} className="text-2xl" />
        </Panel>
        <Panel className="p-4">
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('Player balance')}</div>
          <Money value={totals.net} className="text-2xl" />
        </Panel>
      </div>

      {view.redirects.length > 0 && (
        <Panel className="mb-6 border border-indigo-200 dark:border-indigo-900">
          <h2 className="font-display text-base font-semibold">{t('Close two debts with one payment')}</h2>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">
            {t(
              'Money owed to you can go straight to someone you owe — it never has to pass through your hands. Send them this and both debts clear at once.',
            )}
          </p>
          <ul className="space-y-2">
            {view.redirects.map((r, i) => (
              <li
                key={`${r.payerUserId}-${r.payeeUserId}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-xl bg-indigo-50/70 px-3 py-2.5 text-sm dark:bg-indigo-950/40"
              >
                <span className="font-semibold">{r.payerName}</span>
                <span className="text-slate-400">{t('pays')}</span>
                <span className="font-semibold">{r.payeeName}</span>
                <span className="font-display font-bold tabular-nums text-indigo-600 dark:text-indigo-300">
                  {fmt(r.amount)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      t('{payer} → {payee}: {amount} (settling up through me on 4AM Casino)', {
                        payer: r.payerName,
                        payee: r.payeeName,
                        amount: fmt(r.amount),
                      }),
                    )
                  }
                  className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-900"
                >
                  {t('Copy')}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold">{t('Your platform dues')}</h2>
            <p className="mt-0.5 max-w-md text-xs leading-relaxed text-slate-500">
              {t(
                'Your share of the platform commission deducted from pots you won. New rooms charge {rate}. Each hand uses its room’s rate when dealt. This total reflects the actual deductions.',
                {
                  rate: commission.settings
                    ? commissionRateLabel(commission.settings.commissionBps)
                    : t('the current platform rate'),
                },
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-slate-400">{t('Outstanding')}</div>
            <span className="font-display text-2xl font-bold tabular-nums">
              {fmt(house.outstanding)}
            </span>
            <div className="text-xs text-slate-400">
              {t('{accrued} accrued · {paid} recorded payments', {
                accrued: fmt(house.accrued),
                paid: fmt(house.paid),
              })}
            </div>
          </div>
        </div>
        {(house.rooms?.length ?? 0) > 0 && (
          <details className="mt-4 text-sm">
            <summary className="w-fit cursor-pointer text-indigo-600 hover:underline dark:text-indigo-300">
              {t('Commission by room')}
            </summary>
            <HouseRooms rooms={house.rooms} />
          </details>
        )}
        {house.credit > 0 && (
          <p className="mt-3 text-sm text-slate-500">
            {t('Recorded credit: {credit}', { credit: fmt(house.credit) })}
          </p>
        )}
        <Button className="mt-3" variant="secondary" onClick={() => setHouseOpen(true)}>
          {t('Record a payment')}
        </Button>
      </Panel>

      <h2 className="mb-3 font-display font-semibold">{t('Per person')}</h2>
      {view.people.length === 0 ? (
        <Panel>
          <p className="text-sm text-slate-500">
            {t('No outstanding payments between players. Your platform dues are shown above.')}
          </p>
        </Panel>
      ) : (
        <div className="space-y-2">
          {view.people.map((p) => (
            <Panel key={p.otherUserId} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Avatar userId={p.otherUserId} name={p.otherName} version={p.otherAvatarVersion} />
                <Link to={`/players/${p.otherUserId}`} className="font-medium hover:underline">
                  {p.otherName}
                </Link>
                <span className="text-xs text-slate-400">
                  {p.net > 0 ? t('owes you') : t('you owe')} ·{' '}
                  {t('across {n} rooms', { n: p.rooms.length })}
                </span>
                <Money value={p.net} className="ml-auto text-lg" />
                <Button variant="secondary" onClick={() => setOpen(p)}>
                  {t('Mark settled')}
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setExpanded(expanded === p.otherUserId ? null : p.otherUserId)}
                className="mt-2 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {expanded === p.otherUserId ? t('Hide the rooms behind this') : t('Show the rooms behind this')}
              </button>
              {expanded === p.otherUserId && (
                <ul className="mt-2 space-y-1 border-t border-slate-200/70 pt-2 text-xs dark:border-slate-700/70">
                  {p.rooms.map((r) => (
                    <li key={r.roomId} className="flex items-center gap-2">
                      <Link to={`/room/${r.roomId}/ledger`} className="hover:underline">
                        {r.roomName}
                      </Link>
                      <span className="ml-auto tabular-nums">
                        <Money value={r.direction === 'owe' ? -r.amount : r.amount} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <SettlementMarks line={p} />
            </Panel>
          ))}
        </div>
      )}
      {view.settled.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-display font-semibold">{t('Recently settled')}</h2>
          <div className="space-y-2">
            {view.settled.map((item) => (
              <Panel key={item.settlementId} className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{item.otherName}</span>
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('Both sides confirmed')}</span>
                  <span className="ml-auto text-sm tabular-nums">{fmt(item.amount)}</span>
                </div>
                <SettlementMarks
                  line={{
                    otherUserId: item.otherUserId,
                    otherName: item.otherName,
                    otherAvatarVersion: 0,
                    net: item.debtor === useStore.getState().auth.userId ? -item.amount : item.amount,
                    rooms: [{ roomId: '', roomName: '', amount: item.amount, direction: 'owed', settlementId: item.settlementId }],
                  }}
                />
              </Panel>
            ))}
          </div>
        </>
      )}

      {open && <SettleDialog line={open} onClose={() => setOpen(null)} onDone={load} />}
      {houseOpen && <HousePayDialog onClose={() => setHouseOpen(false)} onDone={load} />}
    </div>
  );
}

function SettleDialog({
  line,
  onClose,
  onDone,
}: {
  line: NetLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      // a settlement is per room, so marking "settled with this person" marks
      // every room they and I still have open between us
      let anySettled = false;
      for (const r of line.rooms) {
        const res = await api.markSettled(
          r.roomId,
          line.otherUserId,
          note || undefined,
          proof ?? undefined,
        );
        anySettled ||= !!res.settled;
      }
      setMsg(
        anySettled
          ? t('Settled — both of you have confirmed.')
          : t('Marked. It clears once {name} confirms too.', { name: line.otherName }),
      );
      onDone();
      setTimeout(onClose, 1600);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'could not mark it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t('Settle with {name}', { name: line.otherName })}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {line.net > 0 ? (
            <>
              <span className="font-semibold">{line.otherName}</span> {t('owes you')}{' '}
              <span className="font-semibold">{fmt(line.net)}</span>
            </>
          ) : (
            <>
              {t('You owe')} <span className="font-semibold">{line.otherName}</span>{' '}
              <span className="font-semibold">{fmt(-line.net)}</span>
            </>
          )}
          {t('. Both of you have to confirm before it clears on the platform.')}
        </p>
        <ProofFields
          note={note}
          setNote={setNote}
          fileName={fileName}
          placeholder={t('paid on UPI, 9:40pm')}
          onPick={(f) => {
            if (!f) return;
            setFileName(f.name);
            void toProofDataUrl(f).then(setProof);
          }}
        />
        {msg && <p className="text-sm text-emerald-600">{tr(msg)}</p>}
        <Button onClick={() => void submit()} disabled={busy} className="w-full">
          {busy ? <Spinner label={t('Recording…')} /> : t('Mark settled')}
        </Button>
      </div>
    </Dialog>
  );
}

function HousePayDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <Dialog open onClose={onClose} title={t('Record a payment to the house')}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            'This keeps 4AM Casino online. Record what you sent and it comes off your outstanding balance.',
          )}
        </p>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-500">{t('Amount')}</span>
          <Input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="500"
          />
        </label>
        <ProofFields
          note={note}
          setNote={setNote}
          fileName={fileName}
          placeholder={t('UPI to notpritam@…')}
          onPick={(f) => {
            if (!f) return;
            setFileName(f.name);
            void toProofDataUrl(f).then(setProof);
          }}
        />
        {msg && <p className="text-sm text-rose-600">{tr(msg)}</p>}
        <Button
          className="w-full"
          disabled={busy || !(Number(amount) > 0)}
          onClick={() => {
            setBusy(true);
            setMsg(null);
            api
              .payHouse(Math.floor(Number(amount)), note || undefined, proof ?? undefined)
              .then(() => {
                onDone();
                onClose();
              })
              .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'could not record it'))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner label={t('Recording…')} /> : t('Record payment')}
        </Button>
      </div>
    </Dialog>
  );
}
