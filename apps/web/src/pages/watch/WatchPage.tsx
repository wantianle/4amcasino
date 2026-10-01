import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../shared/api.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Spinner } from '../../shared/ui/index.tsx';

/** Resolves a watch link into spectator access and forwards to the table. */
export function WatchPage() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .watch(token!)
      .then((r) => nav(`/room/${r.roomId}`, { replace: true }))
      .catch((e) => setError(e instanceof Error ? e.message : 'could not open the watch link'));
  }, [token, nav]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      {error ? (
        <>
          <p className="max-w-sm text-sm text-rose-600">{t(error)}</p>
          <Link to="/lobby">
            <Button>{t('Back to the lobby')}</Button>
          </Link>
        </>
      ) : (
        <Spinner label={t('Opening the table…')} />
      )}
    </div>
  );
}
