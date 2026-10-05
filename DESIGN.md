---
name: 4AM Casino — Zeus
description: Private poker tables with a Zeus account interface.
colors:
  primary: 'oklch(62.3% 0.214 259.815)'
  primary-deep: 'oklch(54.6% 0.245 262.881)'
  canvas: '#0a0a0a'
  surface: '#171717'
  border: '#262626'
  ink: '#ededed'
  muted: '#b8b8b8'
typography:
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '14px'
    lineHeight: '20px'
  title:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '24px'
    fontWeight: 600
rounded:
  control: '10px'
  panel: '16px'
  sidebar: '24px'
spacing:
  small: '8px'
  medium: '12px'
  panel: '20px'
  section: '24px'
components:
  sidebar:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.sidebar}'
    padding: '12px'
    width: '260px'
  panel:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '20px'
---

# Design System: 4AM Casino

## Overview

**Creative North Star: "Zeus around the table"**

Use the official Zeus UI design system selected by the user at myzeusui.com, in its
dark appearance only: a dark canvas, neutral panels, Inter typography, blue actions, and a floating icon
sidebar. Poker remains the content.

**Key Characteristics:**

- The app is **always dark**, matched to the poker-table style; the light/dark toggle and its device
  preference have been removed (see Colors).
- Compact navigation that expands to show names and real tables.
- Actual account data, honest empty states, readable gains and losses.

## Colors

The normative palette comes from `@zeus/tokens` 0.2.3. `zeus.css` bridges existing
slate and indigo utility names to the neutral and blue palette. Primary colors in
the frontmatter retain the source OKLCH values. Emerald means positive results,
rose means losses or a fold, and amber means committed chips or blind positions.
Small text on neutral panels uses the lighter muted tone. The whole application renders in the dark
appearance only: the light appearance, the theme switch control, and the pre-render device preference have
been removed; no design work targets a light canvas.

Table-surface tokens (`--table-*` / `table-*` utilities in `apps/web/src/app/table-tokens.css`) are
**appearance-independent and always dark**: `.dark` must never override them, and no light-mode variant of
the felt, rail, gold system, or betting cluster will be designed.

Card faces stay white for recognition; card-back colorways and four-color suits remain player preferences.
The former before-render theme device preference is gone with the toggle — the app starts dark with no
device lookup.

## Typography

Inter is self-hosted and used for both headings and body copy. The official Zeus
SDK supplies control metrics; use tabular numbers for chips, timestamps, and
charts. Keep labels in normal sentence case. Card ranks and cryptographic hashes
retain their appropriate card and monospace treatments.

## Layout

The desktop sidebar floats twelve pixels from the viewport edges. It is sixty
pixels wide as an icon rail and expands to the width recorded above. Its width is
persisted. Below 768 pixels, a keyboard-accessible navigation drawer replaces the
rail. Search uses the same destination list, including settlement and settings.

Account panels use a responsive grid with zero minimum column widths to prevent
long content from pushing the viewport wider. The lobby is checked down to 320
pixels.

Public pages inherit the same Zeus controls and typography. Landing-page
composition, example-media rules, and responsive behavior live in its
[surface brief](apps/web/.impeccable/surfaces/apps-web-src-pages-landing-landingpage-tsx.md)
rather than changing the account interface's density or navigation.

The administration workspace is a separate shell: a 240px sidebar (210px below
1200px), a bounded content area, and section links for tournaments and earnings,
overview, dues, rooms, users, requests and platform settings. Below 900px navigation
moves above the content; below 600px all seven destinations remain visible in a two-column grid.
Tables scroll inside their own positioned container rather than widening the page.

Tournament operations extend this same account and administration layout. Published
terms use divided fact rows; earnings use wrapping totals above bounded tables.
The public watch surface pairs the table and completed-hand review with a supporting
column, then stacks them on small screens. Its measurements and responsive steps
belong to the [arena surface brief](.impeccable/surfaces/agent-arena.md).

## Elevation & Depth

Use Zeus tonal surfaces with restrained shadows on navigation and raised
controls. Selected navigation uses the official blue gradient and inset highlight.
Keep ordinary account panels quiet. Glass controls use a translucent dark backing,
a subtle border, and a stronger fallback for reduced transparency.

## Shapes

Controls are softly rounded; panels have broader corners, and the floating
sidebar has the broadest corners. Preserve actual playing-card proportions and
round status chips only where their meaning calls for a badge.

## Components

### Shared controls and navigation

Use `Button` and `InputBase` from `@zeus/ui/base` through the shared adapters.
Preserve native form submission, disabled state, keyboard focus, and accessible
names. Icons in the shared sidebar and settings navigation use Remix Icon.
The navigation supports collapse, search, active routes, account status, and a
mobile focus trap. Links from a live table open account destinations separately.

### Charts

Use the actual Zeus `ChartCard` and `ChartLegend` around the existing Recharts
plots. Winnings are cumulative chips with a visible zero line and a domain that
includes losses. Never substitute sample history. Include period filters,
explicit empty states, and an accessible data table. Respect reduced motion.

### Platform administration

Keep settings inline, with the current value beside the editable percentage,
explicit application scope, a whole-chip example, and an audit table. Save and
reload states must show whether another session changed the underlying value.
Use semantic secondary text tokens in custom CSS so the dark theme retains contrast;
selected blue options use tinted blue explanatory text. Neutral admin panels use
14px corners and 24px padding (18px on mobile), while shared controls retain Zeus
SDK geometry and interaction states.

The admin commission chart is a fixed 14-day SVG bar chart with real daily values,
a visible zero baseline, UTC date labels, an explicit empty state, and an accessible
daily-amounts table. No animation is needed for this operational snapshot.

### Tournament operations

Keep published terms, explicit consent, approval state and recording state visible
beside the relevant controls. Use native labeled fields, shared Zeus buttons,
semantic secondary text and tabular chip amounts. Financial tables retain separate
play and settlement columns, signed values and descriptive captions. Filters wrap;
review and receipt forms stay inline. Public watching separates the current table
from the selected completed hand and its decision controls. Sponsor disclosure and
external-link labels remain readable on the dark surfaces. Reuse the shared playing
cards and neutral panels; this surface establishes no separate visual identity.

### Playing cards

Use `PlayingCard` everywhere, including marketing. Face-up and face-down cards
have image roles and accessible names; invisible spacing slots stay out of the
accessibility tree. Use dark text on bright blind badges.

## Do's and Don'ts

- Do use the installed Zeus SDK and tokens for shared application controls.
- Do preserve native forms and all existing poker actions during visual changes.
- Do show real account data and readable negative chart values.
- The app is always dark (Zeus dark tokens); do not design light canvases, and do not restore cyber overrides.
