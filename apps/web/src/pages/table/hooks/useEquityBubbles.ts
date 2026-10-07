import { useEffect, useRef, useState } from 'react';
import type { HandView } from '../../../shared/store.ts';

type Bubble = HandView['equityBubble'];

/** Present the live all-in bubble.
 *
 *  Between two runs the bubble must first disappear and come back only after
 *  the re-computed number is on hand, so when the run index advances this holds
 *  the display hidden for ~2s before showing the new run's figures. Within a
 *  run every per-street frame replaces the numbers immediately. */
export function useEquityBubbles(bubble: Bubble): Bubble {
  const [shown, setShown] = useState<Bubble>(bubble);
  const runRef = useRef<number | null>(bubble?.run ?? null);

  useEffect(() => {
    if (!bubble) {
      runRef.current = null;
      setShown(null);
      return;
    }
    if (runRef.current !== null && bubble.run !== runRef.current) {
      runRef.current = bubble.run;
      setShown(null);
      const timer = setTimeout(() => setShown(bubble), 2000);
      return () => clearTimeout(timer);
    }
    runRef.current = bubble.run;
    setShown(bubble);
  }, [bubble]);

  return shown;
}
