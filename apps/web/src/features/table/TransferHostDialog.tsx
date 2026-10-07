import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog } from '../../shared/ui/index.tsx';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';

/**
 * Hand the host role to a seated member of the table. Host-only, and the only
 * way the role ever moves: a host who goes offline keeps it (there is no
 * timeout), so a deliberate transfer is the sole path. The server re-checks
 * every rule here - the target must be a seated member, never the house account
 * and never a bot.
 */
export function TransferHostDialog({
  open,
  onClose,
  botUserIds,
}: {
  open: boolean;
  onClose: () => void;
  /** Bot accounts at this table; excluded because a bot can never be host. */
  botUserIds: number[];
}) {
  const room = useStore((s) => s.room);
  const userId = useStore((s) => s.auth.userId);
  const connected = useStore((s) => s.wsConnected);
  const [toUserId, setToUserId] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToUserId('');
    setError(null);
  }, [open]);

  if (!room) return null;
  const isHost = userId === room.room.hostId;
  const bots = new Set(botUserIds);
  const candidates = room.players.filter(
    (p) => p.userId !== userId && p.seat !== null && !bots.has(p.userId),
  );

  async function submit() {
    if (!room || !connected || saving || !isHost || toUserId === '') return;
    setSaving(true);
    setError(null);
    try {
      await api.transferHost(room.room.id, toUserId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not transfer host. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <Dialog open={open} onClose={onClose} title={t('Transfer host')}>
      <div className="space-y-5 text-sm text-slate-700 dark:text-slate-200">
        {isHost ? (
          <>
            <p>
              {t(
                'Give the host role to another seated player. The host controls room settings, auto-deal and bots - the role never moves on its own.',
              )}
            </p>
            {candidates.length === 0 ? (
              <p className="text-slate-500 dark:text-slate-400">
                {t('No other seated player can take the host role right now.')}
              </p>
            ) : (
              <label className="block">
                <span className="mb-1 block text-slate-500">{t('New host')}</span>
                <select
                  value={toUserId}
                  onChange={(e) => setToUserId(e.target.value === '' ? '' : +e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
                >
                  <option value="">{t('Pick a player')}</option>
                  {candidates.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <p role="alert" className="text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <Button
              type="button"
              className="w-full"
              disabled={toUserId === '' || saving || !connected}
              onClick={() => void submit()}
            >
              {saving ? t('Transferring…') : t('Transfer host')}
            </Button>
          </>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('Only the host can transfer the host role.')}
          </p>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
