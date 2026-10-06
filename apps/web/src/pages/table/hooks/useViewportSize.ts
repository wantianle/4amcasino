import { useEffect, useState } from 'react';

/** The layout minimum is 1280×720 (docs/table-redesign-spec.md). Below that,
 *  button labels drop to icon-only first; only the table canvas itself scales
 *  down (the RoundTable fits its container), never wrapping. A SHORT viewport
 *  (landscape phones) gets the phone oval too: the desktop canvas floors there
 *  at a scale whose bottom seats end up underneath the corner cluster. */
function useViewportSize(): { w: number; h: number } {
  const [size, setSize] = useState(() =>
    typeof window === 'undefined'
      ? { w: 1280, h: 800 }
      : { w: window.innerWidth, h: window.innerHeight },
  );
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export { useViewportSize };
