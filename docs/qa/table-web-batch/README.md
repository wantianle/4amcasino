# Table web batch QA

## Scope

This batch moves the player HUD to seat avatars, adds VPIP seat badges, makes
the seat plaque two-row and makes check feedback visible. The paid peek affordance
is now a compact TableDock item and is limited to a settled heads-up hand with
an unrevealed opponent. No server protocol or server source was changed.

## Validation

- `npm run build -w @4am/web`: passed on 2026-10-05.
- `npx vitest run apps/web/test`: passed — 15 files, 85 tests.
- `git diff --check`: passed.
- `table-overlap.mjs` (`ASSERT=1`, Chrome, `zh-CN`): PASS. The current run was
  regenerated at `gitHash=0152794` and is `overlap-current-0152794.json`; the
  review-captured clean comparison is `overlap-clean-7d9bf95.json`. Both used the
  same probe (`probeHash=6335722a6b2a`) and had `pageErrors=[]`. Both JSON files
  are relative to this directory and contain `generatedAt`, locale, hash, page
  errors, text coverage, and desktop pod-pair values. (The batch's web code is
  identical at `7d9bf95` and `0152794`; the latter only added agent-core changes,
  so the earlier `7d9bf95` web numbers remain valid and are kept for the clean
  baseline.)

### Recorded overlap values

| case | clean HEAD | current worktree |
| --- | ---: | ---: |
| 9p-myturn 1440×900 textCov | 0.9169 | 0.9167 |
| 9p-myturn 1280×720 textCov | 0.8413 | 0.8334 |
| 9p-myturn 390×844 textCov | 0.9004 | 0.8595 |
| 2p-headsup-myturn 390×844 textCov | 0.9696 | 0.9686 |
| 2p-headsup-myturn 667×375 textCov | 1.0000 | 1.0000 |
| 9p-myturn 1440×900 podPairPx | 0 | 0 |
| 9p-myturn 1280×720 podPairPx | 0 | 0 |

`ASSERT=1` passed because the gate's required desktop/primary-phone cases all
passed; the 1280×720 value is retained as a non-gating diagnostic.

### Evidence coverage

- **Automated browser evidence:** overlap screenshots from the passing run are
  in `/tmp/opencode/table-repair-v2-pass` and were not copied into this lane;
  the auditable numeric JSON is committed here instead.
- **HUD success/loading/low-sample/hidden/error, opener/Escape/backdrop/Close
  focus restoration, VPIP, check feedback, and paid peek:** source-level
  behavior is implemented and the existing browser fixture transport can
  exercise the table states, but a dedicated screenshot/semantic manifest for
  each of these states was **not captured in this lane**. Do not treat the
  README as claiming screenshot proof for those states. The automated browser
  probe does cover page stability, seat text coverage, board coverage, and
  page errors.
- **Unit evidence:** `apps/web/test/hudValidation.test.ts` covers
  `NaN`, `Infinity`, negative, zero, fractional, malformed, and valid positive
  integer player IDs.

Malformed HUD arrays, including `null` and `{}`, are treated as empty players
and never crash the table.

The overlap probe's hero check now selects only `[data-card-size="board"]`
community cards. Hero hole cards are outside the center-column board semantics;
the old generic selector incorrectly made clean HEAD fail its own gate.

## Rules

VPIP badge colors are red `0–<10`, yellow `10–<20`, green `20–<30`, blue
`30–<40`, and purple `40+`. Badges disappear for hidden, insufficient, or
below-minimum samples. HUD cards retain hidden and low-sample states.

The RoomHud contract currently has no last-50-hands net-BB field. A zero-size
temperature slot and a TODO are intentionally reserved; lifetime `bb100` or
net values are not used as a false substitute. Small/large cold and hot
thresholds remain `±30`/`±85` over 50 hands once the field is exposed.

## Stage guide for this batch

Stage only hunks matching these features; unrelated account/admin/table work is
not part of this batch:

- HUD opens from an in-table avatar, lazy HUD request, malformed-player guard,
  dialog focus/opener restoration and spectator no-entry behavior;
- VPIP `SeatBadges` and two-row plaque markup;
- check feedback pill and reduced-motion styling;
- paid-peek TableDock visibility/containment;
- phone `display: contents` restoration and hero phone positioning;
- overlap probe community-board selector calibration;
- HUD validation unit tests and the two overlap JSON evidence files.
