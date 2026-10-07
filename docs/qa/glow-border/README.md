# Glow-border verification captures

Real-product screenshots validating the think-glow rework on branch
`omos/glow-border` (rebased onto `6a268dd`): the acting pod's white **fill
overlay** (the "mask" the user complained about) is replaced by a white
**border halo** - a 2px spread ring hugging the pod's outer edge plus a soft
bloom, with a fully transparent interior. Hole cards, avatar, name, stack and
action line are never covered. The halo paint is now the **single declaration
site** in `table-pod.css` (base rule + adjacent reduced-motion block);
`table-motion.css` keeps only the 1s breathing keyframes - no cross-file
cascade, no dependence on `index.css` import order. The `--table-dur-action-flash`
cycle, the `.table-pod-card--acting` selector and `pointer-events: none` are
untouched.

## Single-source audit (at capture time)

- `.table-pod-card--acting::after` is declared ONLY in `table-pod.css`
  (base rule + the `prefers-reduced-motion` block right below it).
  `table-motion.css` contains zero rules for the acting selector - only
  `@keyframes table-pod-action-flash`.
- `inset` and `background`: exactly one declaration each (pod base).
  `box-shadow`/`animation`: base + reduced-motion media override, adjacent in
  the same file (order is local and explicit).

## Stacking-mystery resolution (pixel evidence)

Before/after peak crops were captured in the SAME run with the SAME crop
geometry (only the CSS swapped). PIL sampling of the 5x5 patch at the left
hole-card face: **delta (0,0,0)** - the old fill never painted the cards
(the z-10 `.table-pod-holo` sits above the z-0 `::after`, as the cascade
says). The pod-surface patch: before (134,117,77) vs after (97,75,24) - the
surface really was veiled ~+40 RGB. The "cards covered" impression was
simultaneous contrast: the fill brightened the surface behind the cards and
the old 18px glow bled around their edges. The fix removes both sources.

## How they were captured

- **Source**: this worktree's own Vite dev server on `http://localhost:5215`.
- **Driver**: a temporary Playwright (`playwright-core`) script (lived under
  `/tmp`, not committed) that boots the real app with a synthetic `room_state`
  over a mocked WebSocket, then injects a live hand through the app's real
  `useStore` so the acting seat renders the real `.table-pod-card--acting` DOM
  and CSS. BEFORE captures temporarily restored the committed (fill) CSS of
  both files; the working tree was always left on the halo CSS. No test code
  or other product code was touched.
- **Browser**: system Google Chrome (headless), `/usr/bin/google-chrome`.
- **Viewport**: 1440 x 900; pod close-ups also at device scale factor 2.
  Locale is the app default `zh-CN`, so the 行动中 / 24s pills match the
  user's real screenshot.
- Phases are freeze-frames of the 1s `table-pod-action-flash` cycle obtained
  by pausing the CSS animation and setting `currentTime`.

## Files

- `before-mask-acting-full.png` / `before-mask-acting-pod-peak.png` - the
  committed (pre-fix) build at flash peak: the pod surface is covered by a
  28% white fill (`background: rgba(255,255,255,0.28)`, `inset: -2px`) -
  the mask.
- `after-acting-phase-000ms.png` ... `-900ms.png` (0/300/420/600/900) - the
  new halo through one breathing cycle: ring fades out at the trough, bright
  at the 420ms peak; the interior stays dark and the cards stay crisp at
  every phase.
- `after-acting-full-420ms.png` - full table: only the acting pod glows, all
  idle pods are untouched, hero cards and both pills below the pod render
  normally.
- `after-acting-pod-peak.png` / `-2x.png` / `after-acting-pod-trough-2x.png` -
  acting pod close-ups.
- `after-idle-full.png` / `after-idle-pod.png` - same table with `toAct=null`
  (control): no ring anywhere.
- `after-hero-acting-cards-peak.png` - the user's exact scenario: hero acting
  with face-up cards; cards are fully crisp, only the pod's outer edge glows.
- `after-reduced-motion-full.png` / `after-reduced-motion-pod.png` - under
  `prefers-reduced-motion: reduce` the halo degrades to a **static outline
  ring** (2px white at 0.72 + soft bloom), still zero interior fill.
- `computed-style-assertions.json` - the raw `getComputedStyle(el,'::after')`
  evidence printed by the harness.

## Verified at capture time

- Acting `::after`: `background: rgba(0, 0, 0, 0)` (transparent - no mask),
  `background-image: none`, `box-shadow: rgba(255,255,255,0.95) 0 0 0 2px,
  rgba(255,255,255,0.5) 0 0 12px 2px, rgba(255,255,255,0.2) 0 0 26px 6px`,
  `inset: -1px` (ring concentric with the pod's 16px border-radius),
  `pointer-events: none`.
- Cycle intact: `animation-name: table-pod-action-flash`,
  `animation-duration: 1s`, `animation-iteration-count: infinite` (the
  `--table-dur-action-flash` token is unchanged).
- Layout: pod `offsetWidth/offsetHeight` identical with and without the
  acting class (124 x 59) - the halo is pure box-shadow, it cannot resize
  the pod.
- Idle pod: `::after content: none`, no background, no shadow.
- Reduced motion: `animation-name: none`, `background: rgba(0,0,0,0)`,
  static white ring shadow present, zero running flash animations.
- Pills (行动中 / 24s bank) live in `.table-pod-pills`, a sibling of the pod
  card - outside the overlay entirely, visually confirmed unaffected.

