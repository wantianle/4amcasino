import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  commissionForPot,
  commissionRateLabel,
  type CommissionScope,
  type CommissionSettings,
} from '@4am/shared';
import { api } from '../../shared/api.ts';
import { Button, Input } from '../../shared/ui/index.tsx';
import { fmt } from '../../shared/lib/cn.ts';
import { fmtDate, fmtTime } from '../../shared/lib/datetime.ts';
import { t } from '../../shared/i18n/index.ts';

export function CommissionControl({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<CommissionSettings | null>(null);
  const [rate, setRate] = useState('');
  const [scope, setScope] = useState<CommissionScope>('all_rooms');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [stale, setStale] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const data = await api.adminSettings();
      setSettings(data);
      setRate(String(data.commissionBps / 100));
      setStale(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not load the house cut.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const parsed = /^(?:\d+)(?:\.\d{1,2})?$/.test(rate.trim()) ? Math.round(Number(rate) * 100) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 10000;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings || busy || stale) return;
    if (!valid) {
      setError(t('Enter 0 to 100, using at most two decimal places.'));
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await api.adminChangeCommission(parsed, scope, settings.revision);
      setSettings(result);
      setRate(String(result.commissionBps / 100));
      setSuccess(
        scope === 'all_rooms'
          ? t(
              result.affectedRooms === 1
                ? '{rate} saved. {n} existing room updated for their next hand.'
                : '{rate} saved. {n} existing rooms updated for their next hand.',
              { rate: commissionRateLabel(result.commissionBps), n: result.affectedRooms },
            )
          : t('{rate} saved for newly created rooms.', {
              rate: commissionRateLabel(result.commissionBps),
            }),
      );
      onChanged();
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : t('Could not save the house cut. Reload to check the current value.');
      setError(message);
      // A failed write can be ambiguous (the connection can drop after commit).
      // Reload before another save so the operator sees the authoritative state.
      setStale(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-settings-grid">
      <section
        className="admin-panel"
        aria-labelledby="house-cut-heading"
        aria-busy={loading || busy}
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="house-cut-heading">{t('House cut')}</h2>
            <p>{t('Change the platform commission directly from your account.')}</p>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={busy || loading}>
            {t('Reload settings')}
          </Button>
        </div>
        {loading && !settings ? (
          <div className="admin-loading" role="status">
            {t('Loading settings…')}
          </div>
        ) : (
          settings && (
            <form onSubmit={(e) => void save(e)}>
              <div className="admin-rate-row">
                <label className="admin-rate-input">
                  {t('Commission per pot')}
                  <div>
                    <Input
                      aria-label={t('House cut percentage')}
                      inputMode="decimal"
                      value={rate}
                      disabled={busy || loading}
                      onChange={(e) => {
                        setRate(e.target.value);
                        setSuccess('');
                      }}
                    />
                    <span aria-hidden="true">%</span>
                  </div>
                </label>
                <div className="admin-rate-current">
                  <span>{t('Current default')}</span>
                  <strong>{commissionRateLabel(settings.commissionBps)}</strong>
                </div>
              </div>
              <fieldset disabled={busy || loading} className="admin-scope">
                <legend>{t('Apply this change to')}</legend>
                <label>
                  <input
                    type="radio"
                    name="commission-scope"
                    value="all_rooms"
                    checked={scope === 'all_rooms'}
                    onChange={() => setScope('all_rooms')}
                  />
                  <span>
                    <strong>{t('All rooms')}</strong>
                    <span>{t('Existing rooms use this rate from their next hand. New rooms use it too.')}</span>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="commission-scope"
                    value="new_rooms"
                    checked={scope === 'new_rooms'}
                    onChange={() => setScope('new_rooms')}
                  />
                  <span>
                    <strong>{t('New rooms only')}</strong>
                    <span>{t('Existing rooms keep their currently assigned rate.')}</span>
                  </span>
                </label>
              </fieldset>
              <div className="admin-rate-example">
                <span>{t('On a 2,000-chip pot')}</span>
                <strong>
                  {valid
                    ? t('{n} chips to the house', { n: fmt(commissionForPot(2000, parsed)) })
                    : t('Enter a valid rate')}
                </strong>
              </div>
              <p className="admin-help">
                {t('Each pot is rounded down to whole chips. Completed hands and hands in progress keep their original rate.')}
              </p>
              {success && (
                <p className="admin-success" role="status">
                  {success}
                </p>
              )}
              <div className="admin-form-footer">
                <Button type="submit" disabled={busy || loading || !valid || stale}>
                  {busy ? t('Saving…') : t('Save house cut')}
                </Button>
                <span>{t('Applies immediately. No redeploy needed.')}</span>
              </div>
            </form>
          )
        )}
        {error && (
          <p className="admin-error" role="alert">
            {error}{' '}
            <button type="button" onClick={() => void load()} disabled={busy}>
              {t('Reload settings')}
            </button>
          </p>
        )}
      </section>
      <aside className="admin-panel admin-policy-note">
        <h2>{t('Qualification rules')}</h2>
        <p>
          {t('Rooms can require up to')} <strong>30</strong>
          {t(' hands before winnings qualify.')}
        </p>
        <p>{t('Hosts can choose a lower requirement or set it to zero. Existing requirements above 30 have been reduced.')}</p>
      </aside>
      <section className="admin-panel admin-history" aria-labelledby="rate-history-heading">
        <div className="admin-section-heading">
          <div>
            <h2 id="rate-history-heading">{t('Rate history')}</h2>
            <p>{t('The latest 50 changes, with their scope and administrator.')}</p>
          </div>
        </div>
        {settings ? (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('Changed')}</th>
                  <th>{t('House cut')}</th>
                  <th>{t('Applies to')}</th>
                  <th>{t('Changed by')}</th>
                </tr>
              </thead>
              <tbody>
                {settings.history.map((change) => (
                  <tr key={change.id}>
                    <td>
                      <time dateTime={new Date(change.createdAt).toISOString()}>
                        {fmtDate(change.createdAt)} {fmtTime(change.createdAt)}
                      </time>
                    </td>
                    <td className="admin-rate-history-value">
                      {change.previousBps !== null && (
                        <span>{commissionRateLabel(change.previousBps)} → </span>
                      )}
                      <strong>{commissionRateLabel(change.commissionBps)}</strong>
                    </td>
                    <td>
                      {change.scope === 'all_rooms' ? t('All rooms') : t('New rooms only')}
                      <small>{t('{n} existing rooms updated', { n: change.affectedRooms })}</small>
                    </td>
                    <td>{change.changedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="admin-help">{t('Load settings to view the change history.')}</p>
        )}
      </section>
    </div>
  );
}
