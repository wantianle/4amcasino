# Think-glow verification captures

Real product screenshots from the `omos/think-glow` worktree, captured to
validate the acting-pod flash introduced by this lane. No GG reference material
is stored here.

## How they were captured

- **Source**: the worktree's own Vite dev server (`vite`) on
  `http://localhost:5206`.
- **Driver**: a temporary Playwright (`playwright-core`) script that boots the
  real app with a synthetic `room_state` and a mocked WebSocket transport, then
  injects a live hand through the app's real `useStore` so the acting seat
  renders the real `.table-pod-card--acting` DOM and CSS.
- **Browser**: system Google Chrome 154 (headless), `/usr/bin/google-chrome`.
- **Viewport**: 1440 × 900, device scale factor 1,
  `prefers-reduced-motion: no-preference` (the reduced-motion control uses
  `reduce`).
- The hero is seat 0; the acting seat is a non-hero seat so the pod overlay is
  not obscured by the hero's betting controls.

## Files

- `think-glow-acting-phase-000ms.png` … `-900ms.png` — seven freeze-frames of
  the 1 s `table-pod-action-flash` cycle at 0 / 150 / 300 / 450 / 600 / 750 /
  900 ms, obtained by pausing the CSS animation and setting `currentTime`.
- `think-glow-acting-pod-peak.png` — zoomed crop at 420 ms (brightest point).
- `think-glow-reduced-motion.png` and `-pod.png` — the same table under
  `prefers-reduced-motion: reduce`, where the flash degrades to a static white
  highlight.

## Verified at capture time

- Normal motion: the acting pod's `::after` reports
  `animation-name: table-pod-action-flash`, `animation-duration: 1s`,
  `animation-iteration-count: infinite`, `pointer-events: none`, and
  `inset: -2px` (the overlay covers the whole pod card, not just the ring).
- Decoupling: `--table-dur-action-flash` resolves to `1s` while
  `--table-dur-pulse` resolves to `1.6s`, i.e. the acting flash is independent
  of the 1.6 s wait/bot breathing pulse.
- Reduced motion: `animation-name: none`, static
  `background: rgba(255, 255, 255, 0.2)` white edge, and zero running
  `table-pod-action-flash` animations.

The capture script is not committed; it lived under `/tmp` and only ever drove
the real product app.
