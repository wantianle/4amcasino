# Table motion QA

Desktop action-label comparison for the same 9-player / active-turn fixture:

- Before: `before-action-labels.png` — existing baseline captured before the motion tuning.
- After: `after-action-labels.png` — `table-baseline.mjs`, 1440×900, after the timing changes.

The fixture includes visible call action labels (the same label path used by check,
bet, and raise). The screenshot fixture runs with reduced motion enabled, so these
images verify the action-label placement and desktop layout without introducing
animation timing into the pixels. Timing changes are verified from the source
constants below and with the browser fixture completing without page errors.

## Timing record

| Feedback | Before | After |
| --- | ---: | ---: |
| Acting glow | 0.20s | 0.45s |
| Fold/leave dim | 0.30s | 0.46s |
| Win highlight | 0.40s | 0.62s |
| Action-label spring stiffness / damping | 380 / 17 | 220 / 22 |
| Action-label highlight hold | none | 0.82s (`0–18%` highlight, then settles) |
| Bet flight | 0.32s + 0.06s stagger | 0.48s + 0.09s stagger |

Command used:

```sh
BASE_URL=http://127.0.0.1:5177 UAT_OUTPUT=/tmp/4am-table-motion-after \
  VIEWS=desktop node apps/web/test/browser/table-baseline.mjs
```

Result: 22 screenshots generated, no page errors.
