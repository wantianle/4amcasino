// Table bots (Phase 1 UI): the host's one dialog to seat a bot opponent and
// manage the ones already at the felt. Every mutation hits the host-only
// routes in apps/server/src/botRoutes.ts; nothing here pretends to know the
// runner's business - the supervisor owns `starting -> running` and the
// graceful wind-down, so the dialog just reflects the status the GET returns.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Coins, Play, Robot, SpinnerGap, Stop, Trash, X } from '@phosphor-icons/react';
import { ApiError, type BotPublic } from '../../shared/api.ts';
import { api } from '../../shared/api.ts';
import { MAX_TABLE_PLAYERS_WITH_BOTS } from '@4am/shared';
import { t } from '../../shared/i18n/index.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { fmtBB } from '../../shared/lib/bb.ts';
import { Badge, Button, Dialog, Input } from '../../shared/ui/index.tsx';
import { cn } from '../../shared/lib/cn.ts';
import {
  AUTO_BOT_POLICY_KIND,
  BOT_POLICIES,
  BOT_DIFFICULTIES,
  botDifficultyLabel,
  botPolicyLabel,
  botStatusLabel,
  botStatusTone,
  type BotTone,
} from './botStatus.ts';
import type { BotDifficulty } from '../../shared/api.ts';

/** Seat ring of a nine-max table - the server caps seats at 0-8. */
const ALL_SEATS = Array.from({ length: 9 }, (_, i) => i);

const BADGE_TONE: Record<BotTone, 'emerald' | 'indigo' | 'amber' | 'rose' | 'slate'> = {
  live: 'emerald',
  busy: 'indigo',
  wait: 'amber',
  bad: 'rose',
  gone: 'slate',
};

interface Flash {
  kind: 'ok' | 'err';
  text: string;
}

/** Quick buy-in ladder, in big blinds - the same shape the host thinks in. */
const BB_PRESETS = [50, 100, 200];

/**
 * The host's bot console. It deliberately owns NO fetch of its own: the page
 * passes the shared `useRoomBots` state (list + reload) so the dialog and the
 * seat badges are always the same read - a create/stop here repaints the felt
 * in the same frame, and the polling cadence lives in one place.
 */
export function BotsDialog({
  roomId,
  open,
  onClose,
  takenSeats,
  seatedHumans,
  bb,
  bots,
  loading,
  error,
  reload,
}: {
  roomId: string;
  open: boolean;
  onClose: () => void;
  /** Seats already occupied by players (bots included) - offered as disabled. */
  takenSeats: number[];
  /** Seated humans (bots excluded) - the server's table-with-bots cap counts
   *  these plus every SEATED bot, so the dialog hides its create form once that
   *  sum reaches MAX_TABLE_PLAYERS_WITH_BOTS rather than letting the add fail. */
  seatedHumans: number;
  /** The room's big blind, so presets read in BB and the default is honest. */
  bb: number;
  bots: BotPublic[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ── create form ───────────────────────────────────────────────────────────
  const freeSeats = useMemo(() => {
    const taken = new Set(takenSeats);
    return ALL_SEATS.filter((s) => !taken.has(s));
  }, [takenSeats]);
  const [seat, setSeat] = useState<number | null>(null);
  const [policy, setPolicy] = useState(BOT_POLICIES[0]!.kind);
  const [difficulty, setDifficulty] = useState<BotDifficulty>('medium');
  const [buyBb, setBuyBb] = useState(100);
  const [buyChips, setBuyChips] = useState('');
  const [name, setName] = useState('');

  // Table cap (server-authoritative; this only mirrors it). The server counts
  // seated humans + SEATED bots, so this must too: a bot with no real seat
  // (ghost/legacy row) is not capacity and is excluded here, keeping the mirror
  // in step with `botCapacity`. The form is hidden the moment the table is full.
  const seatedBots = bots.filter((b) => b.seated).length;
  const remainingBots = Math.max(
    0,
    MAX_TABLE_PLAYERS_WITH_BOTS - seatedHumans - seatedBots,
  );
  const atCapacity = remainingBots === 0;

  // keep a sensible seat picked while the dialog is open and seats move
  useEffect(() => {
    if (!open) return;
    setSeat((cur) => (cur !== null && freeSeats.includes(cur) ? cur : (freeSeats[0] ?? null)));
  }, [open, freeSeats]);

  const initialBuyIn = buyChips.trim() === '' ? buyBb * bb : Number(buyChips.trim());
  const formValid =
    seat !== null && Number.isInteger(initialBuyIn) && initialBuyIn > 0 && !busy && !atCapacity;

  // ── per-bot inline add-chips row ─────────────────────────────────────────
  const [buyFor, setBuyFor] = useState<string | null>(null);
  const [buyAmt, setBuyAmt] = useState('');
  // two-tap removal, mirroring the pod's kick gesture: a stray click inside a
  // busy dialog must never drop a bot mid-session.
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setBuyFor(null);
      setRemoveArmed(null);
      setBusy(null);
    }
  }, [open]);
  const flashTimer = useRef<number | null>(null);
  const show = (f: Flash) => {
    setFlash(f);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 6000);
  };

  /** Server prose arrives via ApiError.message (already dictionary-translated,
   *  English fallback); status codes only add a hint where the prose is not
   *  self-explanatory for a host. */
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 503) {
      show({
        kind: 'err',
        text: `${e.message} ${t('The bot service is not available right now - try again in a moment.')}`,
      });
      return;
    }
    show({
      kind: 'err',
      text: e instanceof Error ? e.message : t('That did not go through. Try again.'),
    });
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      reload();
    }
  };

  const addBot = () =>
    run('create', async () => {
      if (seat === null) return;
      const created = await api.createBot(roomId, {
        seat,
        ...(name.trim() ? { name: name.trim() } : {}),
        // "Auto" is the default and means "server, balance the table": omit the
        // field entirely rather than sending the sentinel (it is not a real
        // policy kind the server persists). Any explicit pick is sent as-is and
        // the server honours it.
        ...(policy === AUTO_BOT_POLICY_KIND ? {} : { policyKind: policy }),
        difficulty,
        initialBuyIn,
      });
      const bot = created.bot;
      if (created.buyRequest?.status === 'pending') {
        // Host is not the room's banker: the chips wait in the normal queue.
        // Starting now would only earn a 409, so say what unlocks it.
        show({
          kind: 'ok',
          text: t(
            '{name} is seated - the buy-in waits for the banker. Press Start once it clears.',
            { name: bot.displayName ?? t('Bot') },
          ),
        });
        return;
      }
      await api.startBot(roomId, bot.id);
      show({
        kind: 'ok',
        text: t('{name} is in and taking its seat at seat {seat}.', {
          name: bot.displayName ?? t('Bot'),
          seat: bot.seat !== null ? bot.seat + 1 : seat + 1,
        }),
      });
      setName('');
      setBuyChips('');
      setBuyBb(100);
    });

  const start = (bot: BotPublic) =>
    run(`start:${bot.id}`, () => api.startBot(roomId, bot.id).then(() => {}));
  const stop = (bot: BotPublic) =>
    run(`stop:${bot.id}`, () =>
      api.stopBot(roomId, bot.id).then(() => {
        show({ kind: 'ok', text: t('Stopping - it finishes the hand it is in, then leaves.') });
      }),
    );
  const buy = (bot: BotPublic) =>
    run(`buy:${bot.id}`, () => {
      const amount = Number(buyAmt.trim());
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error(t('Enter a whole number of chips.'));
      }
      return api.buyBot(roomId, bot.id, amount).then((r) => {
        setBuyFor(null);
        setBuyAmt('');
        show({
          kind: 'ok',
          text:
            r.buyRequest.status === 'approved'
              ? t('Chips on the way - the buy was approved.')
              : t('The buy-in waits for the banker.'),
        });
      });
    });
  const remove = (bot: BotPublic) =>
    run(`remove:${bot.id}`, () =>
      api.removeBot(roomId, bot.id).then(() => {
        setRemoveArmed(null);
        show({
          kind: 'ok',
          text: t('{name} leaves the table.', { name: bot.displayName ?? t('Bot') }),
        });
      }),
    );

  return (
    <Dialog open={open} onClose={onClose} title={t('Bot opponents')} size="lg">
      <p className="-mt-2 mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t(
          'Seat a bot opponent when the table is one short. Bots buy in like any player and play on their own clock.',
        )}
      </p>

      {flash && (
        <div
          role="status"
          className={cn(
            'mb-4 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium',
            flash.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
          )}
        >
          {flash.text}
        </div>
      )}
      {error && (
        <div
          role="status"
          className="mb-4 rounded-xl bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      {/* ── at the table ── */}
      <section aria-label={t('Bots at this table')}>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t('Bots at this table')}
        </h3>
        {loading ? (
          <p className="py-3 text-sm text-slate-400">{t('Loading bots…')}</p>
        ) : bots.length === 0 ? (
          <p className="py-3 text-sm text-slate-400">
            {t('No bots yet. Seat one below and it takes the next free chair.')}
          </p>
        ) : (
          <ul className="mb-5 space-y-2">
            {bots.map((bot) => {
              const tone = botStatusTone(bot.status);
              const key = bot.id;
              const startable = ['ready', 'stopped', 'error'].includes(bot.status);
              const stoppable = ['ready', 'starting', 'running'].includes(bot.status);
              return (
                <li
                  key={key}
                  className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-3.5 py-3 dark:border-slate-700/70 dark:bg-slate-800/40"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"
                    >
                      <Robot size={17} weight="fill" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm font-semibold">
                        {bot.displayName ?? bot.username ?? t('Bot')}
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {bot.seat !== null
                          ? t('Seat {n}', { n: bot.seat + 1 })
                          : t('Between hands')}
                        {' · '}
                        {botPolicyLabel(bot.policyKind)}
                        {' · '}
                        {botDifficultyLabel(bot.difficulty ?? 'medium')}
                      </span>
                     </span>
                     <span
                       className="shrink-0 text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200"
                       title={t('Current stack')}
                     >
                       {fmt(bot.stack ?? 0)}
                     </span>
                     <Badge tone={BADGE_TONE[tone]}>{botStatusLabel(bot.status)}</Badge>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {startable && (
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => start(bot)}
                          className="!min-h-8 !px-3 !text-xs"
                        >
                          {busy === `start:${key}` ? (
                            <SpinnerGap size={13} className="animate-spin" />
                          ) : (
                            <Play size={13} weight="fill" />
                          )}
                          {bot.status === 'error' ? t('Retry') : t('Start')}
                        </Button>
                      )}
                      {stoppable && (
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => stop(bot)}
                          className="!min-h-8 !px-3 !text-xs"
                        >
                          {busy === `stop:${key}` ? (
                            <SpinnerGap size={13} className="animate-spin" />
                          ) : (
                            <Stop size={13} weight="fill" />
                          )}
                          {t('Stop')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (buyFor === key) {
                            setBuyFor(null);
                          } else {
                            // expanding starts at 100 BB of the current table -
                            // the host's default add-chips gesture, not an empty box
                            setBuyFor(key);
                            setBuyAmt(String(100 * bb));
                          }
                        }}
                        className="!min-h-8 !px-3 !text-xs"
                        title={t('Add chips for this bot')}
                      >
                        <Coins size={13} />
                        {t('Add chips')}
                      </Button>
                      {removeArmed === key ? (
                        <Button
                          variant="danger"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => remove(bot)}
                          className="!min-h-8 !px-3 !text-xs"
                        >
                          {t('Delete for good?')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => setRemoveArmed(key)}
                          className="!min-h-8 !px-3 !text-xs !text-rose-600 dark:!text-rose-400"
                          title={t('Delete this bot')}
                        >
                          <Trash size={13} />
                          {t('Delete')}
                        </Button>
                      )}
                    </span>
                  </div>
                  {buyFor === key && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-2.5 dark:border-slate-700/70">
                      {BB_PRESETS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setBuyAmt(String(n * bb))}
                          aria-pressed={Number(buyAmt) === n * bb}
                          className={cn(
                            'rounded-lg border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors',
                            Number(buyAmt) === n * bb
                              ? 'border-indigo-500 bg-indigo-600 text-white'
                              : 'border-slate-200/70 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                          )}
                        >
                          {n} BB
                        </button>
                      ))}
                      <Input
                        aria-label={t('Chips to add for {name}', {
                          name: bot.displayName ?? t('Bot'),
                        })}
                        inputMode="numeric"
                        value={buyAmt}
                        onChange={(e) => setBuyAmt(e.target.value.replace(/[^\d]/g, ''))}
                        placeholder={t('amount')}
                        className="h-8 !min-h-8 w-28 text-xs"
                      />
                      <Button
                        type="button"
                        disabled={busy !== null || !Number(buyAmt)}
                        onClick={() => buy(bot)}
                        className="!min-h-8 !px-3 !text-xs"
                      >
                        {busy === `buy:${key}` && <SpinnerGap size={13} className="animate-spin" />}
                        {t('Send')}
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => setBuyFor(null)}
                        className="!min-h-8 !px-2 !text-xs"
                        aria-label={t('Cancel')}
                      >
                        <X size={13} />
                      </Button>
                      <span className="text-xs text-slate-400">
                        {t('Goes through the banker queue, same as a player.')}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── seat a new bot ── */}
      <section aria-label={t('Seat a new bot')}>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t('Seat a new bot')}
        </h3>
        {atCapacity ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t(
              'This table is full (6 players, bots included) - remove a bot or have a player stand up first.',
            )}
          </p>
        ) : freeSeats.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('All nine seats are taken - stop and remove a bot to free one up.')}
          </p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (formValid) void addBot();
            }}
          >
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('Up to 6 players including bots - {left} more can join.', {
                left: remainingBots,
              })}
            </p>
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {t('Seat')}
              </span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('Seat')}>
                {ALL_SEATS.map((s) => {
                  const free = freeSeats.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={seat === s}
                      disabled={!free}
                      title={
                        free ? t('Seat {n}', { n: s + 1 }) : t('Seat {n} - taken', { n: s + 1 })
                      }
                      onClick={() => setSeat(s)}
                      className={cn(
                        'h-9 w-9 rounded-xl border text-sm font-bold tabular-nums transition-colors',
                        seat === s
                          ? 'border-indigo-500 bg-indigo-600 text-white'
                          : free
                            ? 'border-slate-200/70 bg-white text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200'
                            : 'cursor-not-allowed border-slate-200/50 bg-slate-100 text-slate-400 line-through dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-600',
                      )}
                    >
                      {s + 1}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {t('Difficulty')}
              </span>
              <div
                className="grid grid-cols-2 gap-1.5"
                role="radiogroup"
                aria-label={t('Difficulty')}
              >
                {BOT_DIFFICULTIES.map((d) => {
                  const llm = policy === 'llm';
                  return (
                    <button
                      key={d.kind}
                      type="button"
                      role="radio"
                      aria-checked={difficulty === d.kind}
                      aria-describedby={`bot-difficulty-${d.kind}-description`}
                      disabled={llm}
                      title={
                        llm ? t('Large language models are not affected by difficulty.') : d.blurb
                      }
                      onClick={() => setDifficulty(d.kind)}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-left transition-colors',
                        llm && 'cursor-not-allowed opacity-50',
                        difficulty === d.kind && !llm
                          ? 'border-indigo-500 bg-indigo-600/10'
                          : 'border-slate-200/70 hover:border-indigo-300 dark:border-slate-700',
                      )}
                    >
                      <span className="block text-sm font-semibold">{d.label}</span>
                      <span
                        id={`bot-difficulty-${d.kind}-description`}
                        className="block text-xs text-slate-500 dark:text-slate-400"
                      >
                        {d.blurb}
                      </span>
                    </button>
                  );
                })}
              </div>
              {policy === 'llm' ? (
                <p className="mt-1.5 text-xs text-slate-400">
                  {t('Large language models are not affected by difficulty.')}
                </p>
              ) : null}
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                {t('Play style')}
              </span>
              <div
                className="grid grid-cols-2 gap-1.5"
                role="radiogroup"
                aria-label={t('Play style')}
              >
                {BOT_POLICIES.map((p) => (
                  <button
                    key={p.kind}
                    type="button"
                    role="radio"
                    aria-checked={policy === p.kind}
                    aria-describedby={`bot-policy-${p.kind}-description`}
                    disabled={!p.available}
                    title={p.available ? p.blurb : t('Coming soon')}
                    onClick={() => setPolicy(p.kind)}
                    className={cn(
                      'rounded-xl border px-3 py-2 text-left transition-colors',
                      !p.available && 'cursor-not-allowed opacity-50',
                      policy === p.kind
                        ? 'border-indigo-500 bg-indigo-600/10'
                        : 'border-slate-200/70 hover:border-indigo-300 dark:border-slate-700',
                    )}
                  >
                    <span className="block text-sm font-semibold">
                      {p.label}
                      {!p.available && (
                        <span className="ml-2 align-middle text-[0.6rem] font-bold uppercase tracking-wide text-slate-400">
                          {t('Soon')}
                        </span>
                      )}
                    </span>
                    <span
                      id={`bot-policy-${p.kind}-description`}
                      className="block text-xs text-slate-500 dark:text-slate-400"
                    >
                      {p.blurb}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <span className="mb-1.5 block text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {t('Buy-in')}
                </span>
                <div className="flex items-center gap-1.5">
                  {BB_PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        setBuyBb(n);
                        setBuyChips('');
                      }}
                      aria-pressed={buyChips.trim() === '' && buyBb === n}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 text-xs font-bold tabular-nums transition-colors',
                        buyChips.trim() === '' && buyBb === n
                          ? 'border-indigo-500 bg-indigo-600 text-white'
                          : 'border-slate-200/70 text-slate-600 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-300',
                      )}
                    >
                      {n} BB
                    </button>
                  ))}
                  <Input
                    aria-label={t('Custom buy-in in chips')}
                    inputMode="numeric"
                    value={buyChips}
                    onChange={(e) => setBuyChips(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder={fmt(bb * 100)}
                    className="h-9 w-24 text-sm"
                  />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="bots-name"
                  className="mb-1.5 block text-xs font-semibold text-slate-500 dark:text-slate-400"
                >
                  {t('Name (optional)')}
                </label>
                <Input
                  id="bots-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 24))}
                  placeholder={t('e.g. River Bot')}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {initialBuyIn > 0
                  ? t('Buys in for {n} chips ({bb} BB).', {
                      n: fmt(initialBuyIn),
                      bb: fmtBB(initialBuyIn, bb),
                    })
                  : t('Enter a whole number of chips.')}
              </span>
              <Button type="submit" disabled={!formValid}>
                {busy === 'create' ? (
                  <>
                    <SpinnerGap size={15} className="animate-spin" /> {t('Seating…')}
                  </>
                ) : (
                  <>
                    <Robot size={15} weight="fill" /> {t('Seat & start')}
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </section>
    </Dialog>
  );
}
