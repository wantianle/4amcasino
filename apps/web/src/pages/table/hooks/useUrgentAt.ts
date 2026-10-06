import { useEffect, useState } from 'react';

/**
 * Review fix #8: instead of ticking the whole TablePage twice a second,
 * urgency is ONE scheduled flip per deadline (fires at T-10s, clears at T).
 */
function useUrgentAt(deadline: number | null, handLive: boolean): boolean {
  const [urgent, setUrgent] = useState(false);
  useEffect(() => {
    if (!handLive || !deadline) {
      setUrgent(false);
      return;
    }
    const check = () => setUrgent(deadline - Date.now() <= 10_000);
    check();
    const toUrgent = Math.max(0, deadline - 10_000 - Date.now());
    const toPass = Math.max(toUrgent, deadline - Date.now());
    const t1 = setTimeout(check, toUrgent);
    const t2 = setTimeout(() => setUrgent(false), toPass);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [deadline, handLive]);
  return urgent;
}

export { useUrgentAt };
