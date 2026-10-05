import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';

/** feature_started is the first authoritative announcement, not room settings. */
export function BombPotIntro() {
  const handId = useStore((s) => s.hand.handId);
  const active = useStore((s) => !!s.hand.featureStarted?.bombPot?.enabled);
  const ended = useStore((s) => !!(s.hand.abort || s.hand.result));
  const seen = useRef<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!handId || !active || ended || seen.current === handId) return;
    seen.current = handId;
    setDismissed(false);
  }, [handId, active, ended]);
  useEffect(() => {
    if (!active || !handId || ended || dismissed) return;
    const timer = setTimeout(() => setDismissed(true), 2200);
    return () => clearTimeout(timer);
  }, [active, handId, ended, dismissed]);
  if (!active || ended || dismissed) return null;
  return <div className="table-bomb-intro" role="status" data-testid="bomb-pot-intro">
    <strong>{t('Bomb pot!')}</strong>
    <span>{t('Everyone antes · No preflop betting')}</span>
  </div>;
}
