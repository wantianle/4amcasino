// P2 Lane D — gameplay rules ("玩法规则") editor for squid / time bank / bomb pot /
// multi-run, shared by the lobby create-room form and the table (later lane opens
// GameplaySettingsDialog from the table menu). Values and bounds come from
// @4am/shared/roomRules.ts so client and server can never drift; the server keeps
// the final word on validation (host-only, hand boundary only).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BOMB_POT_ANTE_BB_VALUES,
  BOMB_POT_DURATION_SECONDS_MAX,
  BOMB_POT_DURATION_SECONDS_MIN,
  BOMB_POT_HANDS_MAX,
  BOMB_POT_HANDS_MIN,
  DEFAULT_GAMEPLAY_SETTINGS,
  MULTI_RUN_MAX_RUNS,
  SQUID_MIN_PLAYERS_MAX,
  SQUID_MIN_PLAYERS_MIN,
  SQUID_PENALTY_BB_MAX,
  SQUID_PENALTY_BB_MIN,
  TIME_BANK_REFILL_EVERY_HANDS_MAX,
  TIME_BANK_REFILL_EVERY_HANDS_MIN,
  TIME_BANK_SECONDS_MAX,
  TIME_BANK_SECONDS_MIN,
  type RoomGameplaySettings,
} from '@4am/shared';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Dialog, Input } from '../../shared/ui/index.tsx';
import { cn } from '../../shared/lib/cn.ts';
import { Bomb, CaretDown, Cards, Skull, Timer } from '@phosphor-icons/react';

/**
 * UI starting point for a fresh form. The shared `DEFAULT_GAMEPLAY_SETTINGS`
 * still carries the pre-P2 numbers (min players 2, refill every 10 hands); the
 * server's `ROOM_FEATURE_DEFAULTS` — and both P2 docs — settled on 3 players
 * and a 30-hand refill, so the UI seeds the values the host actually sees.
 * Every field is still editable and every bound is still the shared constant.
 */
export const GAMEPLAY_UI_DEFAULTS: RoomGameplaySettings = {
  squid: { ...DEFAULT_GAMEPLAY_SETTINGS.squid, minPlayers: 3 },
  timeBank: { ...DEFAULT_GAMEPLAY_SETTINGS.timeBank, refillEveryHands: 30 },
  bombPot: { ...DEFAULT_GAMEPLAY_SETTINGS.bombPot },
  multiRun: { ...DEFAULT_GAMEPLAY_SETTINGS.multiRun },
};

const BOMB_DEFAULT_HANDS = 10;
const BOMB_DEFAULT_DURATION_SECONDS = 600;

function clampInt(value: number, min: number, max: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, rounded));
}

/** Deep copy so a form draft never mutates the room's stored settings. */
export function cloneGameplaySettings(s: RoomGameplaySettings): RoomGameplaySettings {
  return {
    squid: { ...s.squid },
    timeBank: { ...s.timeBank },
    bombPot: { enabled: s.bombPot.enabled, anteBb: s.bombPot.anteBb, schedule: { ...s.bombPot.schedule } },
    multiRun: { ...s.multiRun },
  };
}

/** Re-seed a settings object coming from the server: bounds enforced, maxRuns pinned. */
export function normalizeGameplaySettings(s: RoomGameplaySettings): RoomGameplaySettings {
  const mode = s.bombPot?.schedule?.mode === 'duration' ? 'duration' : 'hands';
  const rawValue = s.bombPot?.schedule?.value ?? BOMB_DEFAULT_HANDS;
  return {
    squid: {
      enabled: !!s.squid?.enabled,
      penaltyBb: clampInt(s.squid?.penaltyBb ?? 1, SQUID_PENALTY_BB_MIN, SQUID_PENALTY_BB_MAX),
      minPlayers: clampInt(s.squid?.minPlayers ?? 3, SQUID_MIN_PLAYERS_MIN, SQUID_MIN_PLAYERS_MAX),
    },
    timeBank: {
      enabled: !!s.timeBank?.enabled,
      initialSeconds: clampInt(
        s.timeBank?.initialSeconds ?? 30,
        TIME_BANK_SECONDS_MIN,
        TIME_BANK_SECONDS_MAX,
      ),
      refillEveryHands: clampInt(
        s.timeBank?.refillEveryHands ?? 30,
        TIME_BANK_REFILL_EVERY_HANDS_MIN,
        TIME_BANK_REFILL_EVERY_HANDS_MAX,
      ),
      refillSeconds: clampInt(
        s.timeBank?.refillSeconds ?? 30,
        TIME_BANK_SECONDS_MIN,
        TIME_BANK_SECONDS_MAX,
      ),
    },
    bombPot: {
      enabled: !!s.bombPot?.enabled,
      anteBb: (BOMB_POT_ANTE_BB_VALUES as readonly number[]).includes(s.bombPot?.anteBb)
        ? (s.bombPot.anteBb as 1 | 2 | 3)
        : 1,
      schedule: {
        mode,
        value:
          mode === 'hands'
            ? clampInt(rawValue, BOMB_POT_HANDS_MIN, BOMB_POT_HANDS_MAX)
            : clampInt(rawValue, BOMB_POT_DURATION_SECONDS_MIN, BOMB_POT_DURATION_SECONDS_MAX),
      },
    },
    multiRun: { enabled: !!s.multiRun?.enabled, maxRuns: MULTI_RUN_MAX_RUNS },
  };
}

export function enabledFeatureCount(s: RoomGameplaySettings): number {
  return [s.squid.enabled, s.timeBank.enabled, s.bombPot.enabled, s.multiRun.enabled].filter(
    Boolean,
  ).length;
}

/** Short names for the collapsed lobby header, e.g. 「鱿鱼游戏 · 炸弹池」. */
export function enabledFeatureNames(s: RoomGameplaySettings): string[] {
  const names: string[] = [];
  if (s.squid.enabled) names.push(t('Squid Game'));
  if (s.timeBank.enabled) names.push(t('Time bank'));
  if (s.bombPot.enabled) names.push(t('Bomb pot'));
  if (s.multiRun.enabled) names.push(t('Multi-run all-in'));
  return names;
}

// ── small building blocks ────────────────────────────────────────────────────

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-indigo-600 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-indigo-500 peer-disabled:opacity-50 dark:bg-slate-600"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5 peer-disabled:opacity-70"
      />
    </span>
  );
}

function Field({
  label,
  min,
  max,
  value,
  onChange,
  disabled,
  unit,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  unit: string;
}) {
  const [raw, setRaw] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  // sync when the number changes from the outside (mode switch, server echo)
  useEffect(() => {
    setRaw(String(value));
    setInvalid(false);
  }, [value]);

  function commit(text: string) {
    setRaw(text);
    const n = Number(text);
    const ok = /^\s*\d+\s*$/.test(text) && Number.isInteger(n) && n >= min && n <= max;
    setInvalid(!ok);
    if (ok) onChange(n);
  }

  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={raw}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => {
            const n = Number(raw);
            if (!/^\s*\d+\s*$/.test(raw) || !Number.isFinite(n)) {
              setRaw(String(value));
              setInvalid(false);
            } else {
              const fixed = clampInt(n, min, max);
              setInvalid(false);
              setRaw(String(fixed));
              onChange(fixed);
            }
          }}
          className={cn(
            'min-w-0 flex-1',
            invalid && 'ring-1 ring-rose-400 dark:ring-rose-500',
          )}
        />
        <span className="shrink-0 text-xs text-slate-400">{unit}</span>
      </span>
      {invalid && (
        <span className="mt-1 block text-xs text-rose-600 dark:text-rose-400">
          {t('Enter a whole number from {min} to {max}.', { min, max })}
        </span>
      )}
    </label>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-8 flex-1 rounded-md px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed',
            o.value === value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FeatureCard({
  icon,
  iconClass,
  title,
  pitch,
  enabled,
  onToggle,
  toggleLabel,
  disabled,
  previews,
  children,
}: {
  icon: ReactNode;
  iconClass: string;
  title: string;
  pitch: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  toggleLabel: string;
  disabled?: boolean;
  previews: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border p-4 transition-colors',
        enabled
          ? 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900/60'
          : 'border-slate-200 dark:border-slate-700',
        disabled && 'opacity-60',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', iconClass)}>
            {icon}
          </span>
          <div className="min-w-0">
            <h4 className="font-display text-sm font-semibold">{title}</h4>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{pitch}</p>
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onChange={onToggle}
          label={toggleLabel}
        />
      </header>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-300 ease-out',
          enabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {enabled && (
            <div className="mt-3.5">
              {children && <div className="grid gap-3 sm:grid-cols-2">{children}</div>}
              <ul className="mt-3 space-y-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {previews}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Preview({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-1.5">
      <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
      <span>{children}</span>
    </li>
  );
}

/** Human cadence label for the bomb-pot preview: 120 → 「2 分钟」, 15 → 「15 手」. */
function formatBombInterval(mode: 'hands' | 'duration', value: number): string {
  if (mode === 'hands') return t('{n} hands', { n: value });
  const units: [number, string][] = [
    [86400, '{n} days'],
    [3600, '{n} hours'],
    [60, '{n} minutes'],
    [1, '{n} seconds'],
  ];
  for (const [sec, key] of units) {
    if (value % sec === 0 && value / sec >= 1) return t(key, { n: value / sec });
  }
  return t('{n} seconds', { n: value });
}

/**
 * Bomb-pot cadence in human units: the number edits in the chosen unit while the
 * stored value stays plain seconds (`BOMB_POT_DURATION_SECONDS_MIN..MAX`).
 */
function DurationField({
  label,
  seconds,
  unit,
  onUnitChange,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  seconds: number;
  unit: number;
  onUnitChange: (unit: number) => void;
  onChange: (totalSeconds: number) => void;
  disabled?: boolean;
  hint: string;
}) {
  const toDisplay = (total: number) => String(Math.max(1, Math.round(total / unit)));
  const [raw, setRaw] = useState(() => toDisplay(seconds));
  const [invalid, setInvalid] = useState(false);
  // re-sync when the value or the unit changes from the outside
  useEffect(() => {
    setRaw(toDisplay(seconds));
    setInvalid(false);
  }, [seconds, unit]);

  function commit(text: string, total: number) {
    const n = Number(text);
    const ok = /^\s*\d+\s*$/.test(text) && Number.isInteger(n) && n * unit >= total;
    setInvalid(!ok);
    return ok ? n : null;
  }

  const units = [
    { value: 1, label: t('seconds') },
    { value: 60, label: t('minutes') },
    { value: 3600, label: t('hours') },
    { value: 86400, label: t('days') },
  ];

  return (
    <label className="block text-sm sm:col-span-2">
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span className="flex items-center gap-2">
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          aria-invalid={invalid}
          value={raw}
          onChange={(e) => {
            const text = e.target.value;
            setRaw(text);
            if (commit(text, BOMB_POT_DURATION_SECONDS_MIN) === null) return;
            onChange(
              clampInt(
                Number(text) * unit,
                BOMB_POT_DURATION_SECONDS_MIN,
                BOMB_POT_DURATION_SECONDS_MAX,
              ),
            );
          }}
          onBlur={() => {
            setInvalid(false);
            setRaw(toDisplay(seconds));
          }}
          className={cn(
            'min-w-0 flex-1',
            invalid && 'ring-1 ring-rose-400 dark:ring-rose-500',
          )}
        />
        <select
          aria-label={t('Interval unit')}
          disabled={disabled}
          value={unit}
          onChange={(e) => onUnitChange(Number(e.target.value))}
          className="min-h-10 w-28 shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
        >
          {units.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </span>
      {invalid ? (
        <span className="mt-1 block text-xs text-rose-600 dark:text-rose-400">
          {t('Between {min} and {max}.', {
            min: formatBombInterval('duration', BOMB_POT_DURATION_SECONDS_MIN),
            max: formatBombInterval('duration', BOMB_POT_DURATION_SECONDS_MAX),
          })}
        </span>
      ) : (
        <span className="mt-1 block text-xs text-slate-400">{hint}</span>
      )}
    </label>
  );
}


// ── the editor ───────────────────────────────────────────────────────────────

/** Seed the duration unit so a stored 3600 reads as 「1 小时」 rather than 「3600 秒」. */
function seedDurationUnit(seconds: number): number {
  for (const unit of [86400, 3600, 60]) {
    if (seconds % unit === 0 && seconds / unit >= 1) return unit;
  }
  return 1;
}

export interface GameplaySettingsEditorProps {
  value: RoomGameplaySettings;
  onChange: (next: RoomGameplaySettings) => void;
  /** locked view for non-hosts: everything readable, nothing editable */
  disabled?: boolean;
}

export function GameplaySettingsEditor({ value, onChange, disabled }: GameplaySettingsEditorProps) {
  const [bombUnit, setBombUnit] = useState(() =>
    value.bombPot.schedule.mode === 'duration'
      ? seedDurationUnit(value.bombPot.schedule.value)
      : 60,
  );

  const setSquid = (p: Partial<RoomGameplaySettings['squid']>) =>
    onChange({ ...value, squid: { ...value.squid, ...p } });
  const setTimeBank = (p: Partial<RoomGameplaySettings['timeBank']>) =>
    onChange({ ...value, timeBank: { ...value.timeBank, ...p } });
  const setBomb = (
    p: Partial<Omit<RoomGameplaySettings['bombPot'], 'schedule'>>,
    schedule?: Partial<RoomGameplaySettings['bombPot']['schedule']>,
  ) =>
    onChange({
      ...value,
      bombPot: {
        ...value.bombPot,
        ...p,
        schedule: { ...value.bombPot.schedule, ...(schedule ?? {}) },
      },
    });
  const setMultiRun = (p: Partial<RoomGameplaySettings['multiRun']>) =>
    onChange({ ...value, multiRun: { ...value.multiRun, ...p } });

  const bombMode = value.bombPot.schedule.mode;

  return (
    <div className="space-y-3">
      {/* B1 — Squid Game ------------------------------------------------------ */}
      <FeatureCard
        icon={<Skull size={18} weight="bold" className="text-rose-600 dark:text-rose-400" />}
        iconClass="bg-rose-50 dark:bg-rose-950/50"
        title={t('Squid Game')}
        pitch={t('Loser pays the whole table')}
        enabled={value.squid.enabled}
        disabled={disabled}
        onToggle={(v) => setSquid({ enabled: v })}
        toggleLabel={t('Enable Squid Game')}
        previews={
          <>
            <Preview>
              {(() => {
                // Concrete example: the doc's 「5 人时每人最多付 4 BB」 at default
                // settings; grows with the penalty and the host's own floor.
                const players = Math.max(5, value.squid.minPlayers);
                return t('At {players} players, each loser pays up to {amount} BB', {
                  players,
                  amount: value.squid.penaltyBb * (players - 1),
                });
              })()}
            </Preview>
            <Preview>
              {t('Only fires with at least {n} players in the hand', {
                n: value.squid.minPlayers,
              })}
            </Preview>
            <Preview>
              {t(
                'The host triggers it by hand. Penalties come off table stakes; short stacks pay only what they have.',
              )}
            </Preview>
          </>
        }
      >
        <Field
          label={t('Penalty per loser')}
          unit={t('× BB')}
          min={SQUID_PENALTY_BB_MIN}
          max={SQUID_PENALTY_BB_MAX}
          value={value.squid.penaltyBb}
          disabled={disabled}
          onChange={(n) => setSquid({ penaltyBb: n })}
        />
        <Field
          label={t('Minimum players')}
          unit={t('players')}
          min={SQUID_MIN_PLAYERS_MIN}
          max={SQUID_MIN_PLAYERS_MAX}
          value={value.squid.minPlayers}
          disabled={disabled}
          onChange={(n) => setSquid({ minPlayers: n })}
        />
      </FeatureCard>

      {/* B2 — Time bank ------------------------------------------------------ */}
      <FeatureCard
        icon={<Timer size={18} weight="bold" className="text-amber-600 dark:text-amber-400" />}
        iconClass="bg-amber-50 dark:bg-amber-950/50"
        title={t('Time bank')}
        pitch={t('Banked thinking time')}
        enabled={value.timeBank.enabled}
        disabled={disabled}
        onToggle={(v) => setTimeBank({ enabled: v })}
        toggleLabel={t('Enable time bank')}
        previews={
          <>
            <Preview>
              {t('Everyone starts with {initial} seconds, then gets {refill} seconds every {hands} hands', {
                initial: value.timeBank.initialSeconds,
                refill: value.timeBank.refillSeconds,
                hands: value.timeBank.refillEveryHands,
              })}
            </Preview>
            <Preview>
              {t('The regular timer runs down first; an empty bank folds for you.')}
            </Preview>
            <Preview>{t('Change these numbers and every bank resets to the new start.')}</Preview>
          </>
        }
      >
        <Field
          label={t('Starting bank')}
          unit={t('seconds')}
          min={TIME_BANK_SECONDS_MIN}
          max={TIME_BANK_SECONDS_MAX}
          value={value.timeBank.initialSeconds}
          disabled={disabled}
          onChange={(n) => setTimeBank({ initialSeconds: n })}
        />
        <Field
          label={t('Refill every')}
          unit={t('hands')}
          min={TIME_BANK_REFILL_EVERY_HANDS_MIN}
          max={TIME_BANK_REFILL_EVERY_HANDS_MAX}
          value={value.timeBank.refillEveryHands}
          disabled={disabled}
          onChange={(n) => setTimeBank({ refillEveryHands: n })}
        />
        <Field
          label={t('Refill amount')}
          unit={t('seconds')}
          min={TIME_BANK_SECONDS_MIN}
          max={TIME_BANK_SECONDS_MAX}
          value={value.timeBank.refillSeconds}
          disabled={disabled}
          onChange={(n) => setTimeBank({ refillSeconds: n })}
        />
      </FeatureCard>

      {/* B3 — Bomb pot -------------------------------------------------------- */}
      <FeatureCard
        icon={<Bomb size={18} weight="bold" className="text-violet-600 dark:text-violet-400" />}
        iconClass="bg-violet-50 dark:bg-violet-950/50"
        title={t('Bomb pot')}
        pitch={t('Ante up, straight to the flop')}
        enabled={value.bombPot.enabled}
        disabled={disabled}
        onToggle={(v) => setBomb({ enabled: v })}
        toggleLabel={t('Enable bomb pot')}
        previews={
          <>
            <Preview>
              {t(
                'Every {interval}: each player antes {ante} BB, blinds are skipped, and the hand starts on the flop',
                {
                  interval: formatBombInterval(bombMode, value.bombPot.schedule.value),
                  ante: value.bombPot.anteBb,
                },
              )}
            </Preview>
            <Preview>{t('The host can also drop one between hands.')}</Preview>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            {t('Ante per player')}
          </span>
          <Segmented
            ariaLabel={t('Ante per player')}
            disabled={disabled}
            value={value.bombPot.anteBb}
            onChange={(v) => setBomb({ anteBb: v })}
            options={BOMB_POT_ANTE_BB_VALUES.map((n) => ({
              value: n,
              label: t('{n}× BB', { n }),
            }))}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            {t('Fire every')}
          </span>
          <Segmented
            ariaLabel={t('Fire every')}
            disabled={disabled}
            value={bombMode}
            onChange={(mode) => {
              if (mode === 'duration') setBombUnit(seedDurationUnit(BOMB_DEFAULT_DURATION_SECONDS));
              setBomb(
                {},
                {
                  mode,
                  value:
                    mode === 'hands' ? BOMB_DEFAULT_HANDS : BOMB_DEFAULT_DURATION_SECONDS,
                },
              );
            }}
            options={[
              { value: 'hands' as const, label: t('By hands') },
              { value: 'duration' as const, label: t('By time') },
            ]}
          />
        </label>
        {bombMode === 'hands' ? (
          <Field
            label={t('Interval')}
            unit={t('hands')}
            min={BOMB_POT_HANDS_MIN}
            max={BOMB_POT_HANDS_MAX}
            value={value.bombPot.schedule.value}
            disabled={disabled}
            onChange={(n) => setBomb({}, { value: n })}
          />
        ) : (
          <DurationField
            label={t('Interval')}
            seconds={value.bombPot.schedule.value}
            unit={bombUnit}
            disabled={disabled}
            onUnitChange={(nextUnit) => {
              const seconds = value.bombPot.schedule.value;
              const display = Math.max(
                Math.ceil(BOMB_POT_DURATION_SECONDS_MIN / nextUnit),
                Math.round(seconds / nextUnit),
              );
              setBombUnit(nextUnit);
              setBomb(
                {},
                {
                  value: clampInt(
                    display * nextUnit,
                    BOMB_POT_DURATION_SECONDS_MIN,
                    BOMB_POT_DURATION_SECONDS_MAX,
                  ),
                },
              );
            }}
            onChange={(totalSeconds) => setBomb({}, { value: totalSeconds })}
            hint={t('Between {min} and {max}.', {
              min: formatBombInterval('duration', BOMB_POT_DURATION_SECONDS_MIN),
              max: formatBombInterval('duration', BOMB_POT_DURATION_SECONDS_MAX),
            })}
          />
        )}
      </FeatureCard>

      {/* B4 — Multi-run ------------------------------------------------------- */}
      <FeatureCard
        icon={<Cards size={18} weight="bold" className="text-emerald-600 dark:text-emerald-400" />}
        iconClass="bg-emerald-50 dark:bg-emerald-950/50"
        title={t('Multi-run all-in')}
        pitch={t('Run the board up to {maxRuns} times', { maxRuns: MULTI_RUN_MAX_RUNS })}
        enabled={value.multiRun.enabled}
        disabled={disabled}
        onToggle={(v) => setMultiRun({ enabled: v })}
        toggleLabel={t('Enable multi-run all-in')}
        previews={
          <>
            <Preview>
              {t('Up to {maxRuns} runs when cards are still to come', {
                maxRuns: MULTI_RUN_MAX_RUNS,
              })}
            </Preview>
            <Preview>{t('The behind hand picks 1–3 runs; the ahead hand has to agree.')}</Preview>
            <Preview>{t('More than two players all-in, or equal odds: it runs once.')}</Preview>
          </>
        }
      />
    </div>
  );
}

// ── the dialog ───────────────────────────────────────────────────────────────

export interface GameplaySettingsDialogProps {
  roomId: string;
  /** the room's stored settings; the dialog edits a copy of them */
  features: RoomGameplaySettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** fires with the server's canonical settings after a successful save */
  onSaved?: (features: RoomGameplaySettings) => void;
}

/**
 * Edit one room's gameplay rules in place. The same editor the lobby uses at
 * create time, wired to `api.setRoomFeatures`. Host-only (the server enforces
 * it; the dialog also locks up when it can see a non-host at the table), and
 * saving waits for a hand boundary because rules only make sense between hands.
 */
export function GameplaySettingsDialog({
  roomId,
  features,
  open,
  onOpenChange,
  onSaved,
}: GameplaySettingsDialogProps) {
  const roomState = useStore((s) => s.room);
  const userId = useStore((s) => s.auth.userId);
  // Host checks only apply when this room is the one loaded at the table;
  // elsewhere the server stays the authority and answers 403.
  const atTable = roomState?.room.id === roomId ? roomState : null;
  const isHost = atTable ? userId === atTable.room.hostId : true;
  const handActive = !!atTable?.handActive;

  const [draft, setDraft] = useState<RoomGameplaySettings>(() => cloneGameplaySettings(features));
  const [baseline, setBaseline] = useState<RoomGameplaySettings>(() =>
    cloneGameplaySettings(features),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // Re-seed the draft whenever the dialog opens. Deliberately not keyed on
  // `features`: a parent re-render must not wipe what the host is typing.
  useEffect(() => {
    if (!open) return;
    setDraft(cloneGameplaySettings(features));
    setBaseline(cloneGameplaySettings(features));
    setError(null);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  function discard() {
    setDraft(cloneGameplaySettings(baseline));
    setError(null);
    setSaved(false);
  }

  async function save() {
    if (saving || !dirty || !isHost || handActive) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = (await api.setRoomFeatures(roomId, draft)) as {
        ok: boolean;
        features?: RoomGameplaySettings;
      };
      const canonical = normalizeGameplaySettings(res.features ?? draft);
      setDraft(canonical);
      setBaseline(canonical);
      onSaved?.(canonical);
      setSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2600);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('could not save gameplay settings'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t('Gameplay settings')}
      size="lg"
    >
      <p className="-mt-1 mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t('Optional twists on top of regular poker. The host can change them between hands.')}
      </p>

      {dirty && !handActive && isHost && (
        <p className="mb-3 text-xs font-medium text-indigo-600 dark:text-indigo-400">
          {t('Unsaved changes')}
        </p>
      )}

      <GameplaySettingsEditor
        value={draft}
        onChange={setDraft}
        disabled={!isHost || saving}
      />

      <div className="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div aria-live="polite" className="min-h-5 text-sm">
          {error ? (
            <p role="alert" className="text-rose-600 dark:text-rose-400">
              {error}
            </p>
          ) : saved ? (
            <p className="text-emerald-600 dark:text-emerald-400">{t('Saved.')}</p>
          ) : !isHost ? (
            <p className="text-slate-500 dark:text-slate-400">
              {t('Only the host can change gameplay settings.')}
            </p>
          ) : handActive ? (
            <p className="text-slate-500 dark:text-slate-400">
              {t('These settings apply between hands. The hand in play keeps its own rules.')}
            </p>
          ) : null}
        </div>
        {isHost && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" disabled={!dirty || saving} onClick={discard}>
              {t('Discard')}
            </Button>
            <Button
              type="button"
              disabled={!dirty || saving || handActive}
              onClick={() => void save()}
            >
              {saving ? t('Saving…') : t('Save changes')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Chevron header piece the lobby uses for its collapsible rules section. */
export function GameplayRulesToggle({
  open,
  onToggle,
  summary,
  count,
}: {
  open: boolean;
  onToggle: (v: boolean) => void;
  summary: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!open)}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left"
    >
      <span className="min-w-0">
        <span className="block font-display text-sm font-semibold">{t('Gameplay rules')}</span>
        <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
          {summary}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {count > 0 ? (
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
            {t('{n} on', { n: count })}
          </span>
        ) : (
          <span className="text-xs text-slate-400">{t('None enabled')}</span>
        )}
        <CaretDown
          size={16}
          className={cn(
            'text-slate-400 transition-transform duration-300',
            open && 'rotate-180',
          )}
        />
      </span>
    </button>
  );
}
