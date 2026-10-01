import { useEffect, useState } from 'react';
import { api } from '../../shared/api.ts';
import { leaveSeat } from '../../shared/gameClient.ts';
import { useStore } from '../../shared/store.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Dialog, Input } from '../../shared/ui/index.tsx';
import { useAsyncGuard } from '../../shared/lib/useAsyncGuard.ts';

/** Shown automatically when you are seated with zero chips between hands:
 *  request a buy-in from the banker, or stand up and watch as a viewer. */
export function BrokeBuyInDialog({
  roomId,
  open,
  onClose,
}: {
  roomId: string;
  open: boolean;
  onClose: () => void;
}) {
  const room = useStore((s) => s.room);
  const userId = useStore((s) => s.auth.userId);
  const pendingBuy = room?.players.find((p) => p.userId === userId)?.pendingBuy ?? 0;
  const pushError = useStore((s) => s.pushError);
  const [amount, setAmount] = useState(() => (room?.room.bb ?? 20) * 50);
  const [sent, setSent] = useState(false);
  const guard = useAsyncGuard();
  useEffect(() => {
    if (!open) setSent(false);
  }, [open]);

  function buy(e: React.FormEvent) {
    e.preventDefault();
    guard.run(async () => {
      try {
        await api.buy(roomId, amount);
        setSent(true);
      } catch (err) {
        pushError(err instanceof Error ? err.message : t('buy request failed'));
      }
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('You are out of chips')}>
      {sent || pendingBuy > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-emerald-600">
            {pendingBuy > 0
              ? t('{n} points are awaiting approval.', { n: fmt(pendingBuy) })
              : t('Buy-in request sent.')}
            {t(
              'As soon as the banker approves it, the points land on your stack and you are back in the next hand.',
            )}
          </p>
          <Button variant="secondary" className="w-full" onClick={onClose}>
            {t('Got it')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            {t(
              'Your stack is empty, so the next hands will deal around you. Buy more points from the bank, or stand up and watch.',
            )}
          </p>
          <form onSubmit={buy} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-500">{t('Buy-in amount')}</span>
              <Input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(+e.target.value)}
              />
            </label>
            <Button type="submit" className="w-full" disabled={guard.busy}>
              {guard.busy ? t('Requesting…') : t('Request {n} points', { n: fmt(amount) })}
            </Button>
          </form>
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              leaveSeat();
              onClose();
            }}
          >
            {t('Watch as a viewer')}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
