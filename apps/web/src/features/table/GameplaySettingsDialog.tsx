// P2 Lane D — gameplay rules ("玩法规则") editor for squid / bomb pot / multi-run,
// shared by the lobby create-room form and the table (later lane opens
// GameplaySettingsDialog from the table menu). Values and bounds come from
// @4am/shared/roomRules.ts so client and server can never drift; the server keeps
// the final word on validation (host-only, and 409s while a hand is in play — the
// dialog's save queue is what turns that hard boundary into an always-clickable
// button). The time bank lives in the table's timer popover
// (widgets/table/TableQuickControls.tsx), which reuses this file's Field / Switch
// primitives and the useFeatureSaveQueue hook.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BOMB_POT_ANTE_BB_MAX,
  BOMB_POT_ANTE_BB_MIN,
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
import { ApiError, api, type RoomFeaturesPatch } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Dialog, Input } from '../../shared/ui/index.tsx';
import { cn } from '../../shared/lib/cn.ts';
import { Bomb, CaretDown, Cards, Skull } from '@phosphor-icons/react';

/**
 * UI-only default used when a host flips the bomb-pot cadence from hands to
 * time: the shared `DEFAULT_GAMEPLAY_SETTINGS` seeds hands at 10, but there is
 * no shared "default duration" (the DB default is hands mode), so this is a
 * presentation choice and deliberately not sourced from @4am/shared.
 */
const BOMB_DEFAULT_DURATION_SECONDS = 600;
/** The shared default bomb-pot interval, in hands. */
const BOMB_DEFAULT_HANDS = DEFAULT_GAMEPLAY_SETTINGS.bombPot.schedule.value;

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
      penaltyBb: clampInt(
        s.squid?.penaltyBb ?? DEFAULT_GAMEPLAY_SETTINGS.squid.penaltyBb,
        SQUID_PENALTY_BB_MIN,
        SQUID_PENALTY_BB_MAX,
      ),
      minPlayers: clampInt(
        s.squid?.minPlayers ?? DEFAULT_GAMEPLAY_SETTINGS.squid.minPlayers,
        SQUID_MIN_PLAYERS_MIN,
        SQUID_MIN_PLAYERS_MAX,
      ),
    },
    timeBank: {
      enabled: !!s.timeBank?.enabled,
      initialSeconds: clampInt(
        s.timeBank?.initialSeconds ?? DEFAULT_GAMEPLAY_SETTINGS.timeBank.initialSeconds,
        TIME_BANK_SECONDS_MIN,
        TIME_BANK_SECONDS_MAX,
      ),
      refillEveryHands: clampInt(
        s.timeBank?.refillEveryHands ?? DEFAULT_GAMEPLAY_SETTINGS.timeBank.refillEveryHands,
        TIME_BANK_REFILL_EVERY_HANDS_MIN,
        TIME_BANK_REFILL_EVERY_HANDS_MAX,
      ),
      refillSeconds: clampInt(
        s.timeBank?.refillSeconds ?? DEFAULT_GAMEPLAY_SETTINGS.timeBank.refillSeconds,
        TIME_BANK_SECONDS_MIN,
        TIME_BANK_SECONDS_MAX,
      ),
    },
    bombPot: {
      enabled: !!s.bombPot?.enabled,
      // free numeric ante now: clamp whatever arrived (legacy 1/2/3 enums are
      // inside this range anyway) instead of snapping anything off-preset back
      // to the default.
      anteBb: clampInt(
        s.bombPot?.anteBb ?? DEFAULT_GAMEPLAY_SETTINGS.bombPot.anteBb,
        BOMB_POT_ANTE_BB_MIN,
        BOMB_POT_ANTE_BB_MAX,
      ),
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

/**
 * Features the dialog owns: the time bank lives in the table's timer popover
 * now, so it is deliberately not counted or named here even though it stays
 * part of the room's settings object.
 */
export function enabledFeatureCount(s: RoomGameplaySettings): number {
  return [s.squid.enabled, s.bombPot.enabled, s.multiRun.enabled].filter(Boolean).length;
}

/** Short names for the collapsed lobby header, e.g. 「鱿鱼游戏 · 炸弹池」. */
export function enabledFeatureNames(s: RoomGameplaySettings): string[] {
  const names: string[] = [];
  if (s.squid.enabled) names.push(t('Squid Game'));
  if (s.bombPot.enabled) names.push(t('Bomb pot'));
  if (s.multiRun.enabled) names.push(t('Multi-run all-in'));
  return names;
}

// ── small building blocks ────────────────────────────────────────────────────

export function Switch({
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

export function Field({
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

      {/* B2 — Time bank moved to the table timer popover (TableQuickControls) */}

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
        {/* Free numeric ante (whole BBs, BOMB_POT_ANTE_BB_MIN..MAX) with the
            old 1/2/3 enum demoted to quick presets under the field. */}
        <div>
          <Field
            label={t('Ante per player')}
            unit={t('× BB')}
            min={BOMB_POT_ANTE_BB_MIN}
            max={BOMB_POT_ANTE_BB_MAX}
            value={value.bombPot.anteBb}
            disabled={disabled}
            onChange={(n) => setBomb({ anteBb: n })}
          />
          <div role="group" aria-label={t('Ante presets')} className="mt-1.5 flex gap-1">
            {BOMB_POT_ANTE_BB_VALUES.map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-pressed={value.bombPot.anteBb === n}
                onClick={() => setBomb({ anteBb: n })}
                className={cn(
                  'min-h-7 rounded-md px-2 text-xs font-semibold ring-1 transition-colors disabled:cursor-not-allowed',
                  value.bombPot.anteBb === n
                    ? 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:ring-indigo-800'
                    : 'bg-white text-slate-500 ring-slate-200 hover:text-slate-800 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700 dark:hover:text-slate-200',
                )}
              >
                {t('{n}× BB', { n })}
              </button>
            ))}
          </div>
        </div>
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

// ── save queue ───────────────────────────────────────────────────────────────
//
// Server semantics (verified against rooms.ts): a `features` write through
// PUT /api/rooms/:id/settings is rejected with **409 for the whole duration of
// a hand** (`if (activeHands.has(id)) → 409 'Gameplay settings apply between
// hands.'`), and the server never queues the change itself. The old UI reacted
// by greying the Save button while `handActive` — on a table that auto-deals
// nonstop that button was permanently dead and the host had no way to express
// intent. The queue lives client-side instead, next to the only party that can
// see the hand boundary from here: a submit writes immediately between hands,
// and while a hand is in play (or when a hand start beats the PUT to the
// server) the write stays pending and flushes itself at the next boundary,
// retried on 409. The "applies between hands" rule stays enforced exactly
// where the server enforces it; the button never lies about being unusable.

/** How often a queued write re-checks the boundary while the table keeps
 *  dealing. Only active while the dialog/popover holds an unflushed submit. */
const QUEUE_POLL_MS = 2000;
/** How long the 「Saved.」 flash stays up after a write lands. */
const SAVED_FLASH_MS = 2600;

export interface FeatureSaveQueue {
  /** a PUT is in flight right now */
  saving: boolean;
  /** the submit is waiting for a hand boundary (fresh queue or 409 retry) */
  queued: boolean;
  /** the last submit landed; flashes for a moment */
  saved: boolean;
  /** a real rejection (400/403/500…): the queue gave up, the draft stays */
  error: string | null;
  /** write now if between hands, otherwise hold it for the next boundary */
  submit: (patch: RoomFeaturesPatch) => void;
  /** drop a queued (not yet landed) write */
  cancel: () => void;
  /** cancel + clear error/flash, e.g. when a form re-seeds */
  reset: () => void;
}

/**
 * One save queue per form surface. Dialog and timer popover use the same hook
 * so both honour the same server rule with the same words. `onSaved` is read
 * through a ref, so callers can pass a closure over fresh state without
 * re-arming the queue on every render.
 */
export function useFeatureSaveQueue(opts: {
  roomId: string;
  /** true while this client sees a hand in play at the table */
  handActive: boolean;
  /** receives the server's canonical full settings after a successful write */
  onSaved: (features: RoomGameplaySettings) => void;
}): FeatureSaveQueue {
  const { roomId } = opts;
  const [saving, setSaving] = useState(false);
  const [queued, setQueued] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef<RoomFeaturesPatch | null>(null);
  const pollRef = useRef<number | null>(null);
  const flashRef = useRef<number | null>(null);
  const handActiveRef = useRef(opts.handActive);
  const onSavedRef = useRef(opts.onSaved);
  const commitRef = useRef<() => void>(() => {});

  const clearPoll = () => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  };

  const commit = useCallback(() => {
    const patch = pendingRef.current;
    if (!patch) return;
    if (handActiveRef.current) {
      // hand in play: the server would 409, so wait for the boundary
      clearPoll();
      pollRef.current = window.setTimeout(() => {
        pollRef.current = null;
        commitRef.current();
      }, QUEUE_POLL_MS);
      return;
    }
    setSaving(true);
    setError(null);
    void (api.setRoomFeatures(roomId, patch) as Promise<{ features?: RoomGameplaySettings }>)
      .then((res) => {
        if (pendingRef.current === patch) {
          pendingRef.current = null;
          setQueued(false);
        }
        if (res.features) onSavedRef.current(res.features);
        setSaved(true);
        if (flashRef.current !== null) window.clearTimeout(flashRef.current);
        flashRef.current = window.setTimeout(() => setSaved(false), SAVED_FLASH_MS);
      })
      .catch((err: unknown) => {
        // a hand started between our snapshot and the server: stay queued and
        // retry at the next boundary instead of failing the host's intent
        if (err instanceof ApiError && err.status === 409) {
          clearPoll();
          pollRef.current = window.setTimeout(() => {
            pollRef.current = null;
            commitRef.current();
          }, QUEUE_POLL_MS);
          return;
        }
        if (pendingRef.current === patch) {
          pendingRef.current = null;
          setQueued(false);
        }
        setError(err instanceof Error ? err.message : t('could not save gameplay settings'));
      })
      .finally(() => setSaving(false));
  }, [roomId]);
  commitRef.current = commit;

  // flush a queued write the moment the table shows the hand is over
  useEffect(() => {
    const wasActive = handActiveRef.current;
    handActiveRef.current = opts.handActive;
    if (wasActive && !opts.handActive && pendingRef.current) {
      clearPoll();
      commitRef.current();
    }
  }, [opts.handActive]);

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
      if (flashRef.current !== null) window.clearTimeout(flashRef.current);
    },
    [],
  );

  const submit = useCallback((patch: RoomFeaturesPatch) => {
    setError(null);
    setSaved(false);
    pendingRef.current = patch;
    setQueued(true);
    commitRef.current();
  }, []);

  const cancel = useCallback(() => {
    pendingRef.current = null;
    setQueued(false);
    clearPoll();
  }, []);

  const reset = useCallback(() => {
    cancel();
    setError(null);
    setSaved(false);
  }, [cancel]);

  return { saving, queued, saved, error, submit, cancel, reset };
}

/**
 * The dialog owns squid / bomb pot / multi-run. The time bank lives in the
 * timer popover, so it is deliberately NOT in this patch: the server deep-
 * merges what is absent, which keeps a bank change made after this dialog was
 * seeded from being silently overwritten by a stale copy.
 */
export function ownedFeaturePatch(s: RoomGameplaySettings): RoomFeaturesPatch {
  return { squid: s.squid, bombPot: s.bombPot, multiRun: s.multiRun };
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
 * it; the dialog also locks up when it can see a non-host at the table). The
 * Save button is always live: the server only accepts feature writes between
 * hands (409 during one), so a mid-hand click queues the change and the queue
 * flushes it at the next boundary.
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

  const queue = useFeatureSaveQueue({
    roomId,
    handActive,
    onSaved: (serverFeatures) => {
      const canonical = normalizeGameplaySettings(serverFeatures);
      setDraft(canonical);
      setBaseline(canonical);
      onSaved?.(canonical);
    },
  });

  // Re-seed the draft whenever the dialog opens. Deliberately not keyed on
  // `features`: a parent re-render must not wipe what the host is typing.
  // Closing drops an un-flushed queue: a "queued" save only holds while the
  // host is actually looking at the form - nothing writes behind their back.
  useEffect(() => {
    if (!open) {
      queue.cancel();
      return;
    }
    setDraft(cloneGameplaySettings(features));
    setBaseline(cloneGameplaySettings(features));
    queue.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  );

  function discard() {
    setDraft(cloneGameplaySettings(baseline));
    queue.cancel();
  }

  function save() {
    // `handActive` is deliberately NOT a gate: a click during a hand queues.
    if (queue.saving || !dirty || !isHost) return;
    queue.submit(ownedFeaturePatch(draft));
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

      {dirty && !queue.queued && !queue.saved && isHost && (
        <p className="mb-3 text-xs font-medium text-indigo-600 dark:text-indigo-400">
          {t('Unsaved changes')}
        </p>
      )}

      <GameplaySettingsEditor
        value={draft}
        onChange={setDraft}
        disabled={!isHost || queue.saving}
      />

      <div className="mt-5 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div aria-live="polite" className="min-h-5 text-sm">
          {queue.error ? (
            <p role="alert" className="text-rose-600 dark:text-rose-400">
              {queue.error}
            </p>
          ) : queue.saved ? (
            <p className="text-emerald-600 dark:text-emerald-400">{t('Saved.')}</p>
          ) : !isHost ? (
            <p className="text-slate-500 dark:text-slate-400">
              {t('Only the host can change gameplay settings.')}
            </p>
          ) : queue.queued ? (
            <p className="text-amber-600 dark:text-amber-400">
              {t('Queued — saves as soon as this hand ends.')}
            </p>
          ) : handActive && dirty ? (
            <p className="text-slate-500 dark:text-slate-400">
              {t('These settings apply between hands. The hand in play keeps its own rules.')}
            </p>
          ) : null}
        </div>
        {isHost && (
          <div className="flex items-center justify-end gap-2">
            {queue.queued && (
              <Button variant="ghost" type="button" onClick={queue.cancel}>
                {t('Cancel queue')}
              </Button>
            )}
            <Button variant="ghost" type="button" disabled={!dirty || queue.saving} onClick={discard}>
              {t('Discard')}
            </Button>
            <Button
              type="button"
              disabled={!dirty || queue.saving}
              onClick={save}
            >
              {queue.saving
                ? t('Saving…')
                : queue.queued
                  ? t('Re-queue changes')
                  : t('Save changes')}
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
