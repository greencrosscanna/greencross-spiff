# Handoff: SPIFF — visual refinement

## Overview
SPIFF is the Green Cross tool for building vendor-funded incentive programs, tracking them while they run, and reporting the result back to the vendor. The app's logic already works; this handoff covers a **visual pass only** — bringing SPIFF up to the polish level of Crew and Leaderboard by adopting the shared gx-theme vocabulary (app shell, sub-nav filter bar, stat strip, skeleton loaders, store-color registry, pace bars) instead of the ad-hoc styling it has today.

Nine surfaces are covered: Programs, Calculator, Calculator in pitch mode, Progress, Reports, History, the Record modal, the budtender My SPIFF flyer, and the vendor client view.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes of the intended look and behavior, not production code to paste in. The task is to **recreate these designs inside the existing `greencross-spiff` codebase** (vanilla HTML/CSS/JS with `gx-theme.css`, `gx-stores.js`, and per-page `spiff.js` / `flyer.js` / `client.js` render functions), using its established patterns. Do not introduce a framework or a new stylesheet architecture — extend `spiff.css` / `flyer.css` / `client.css` and the existing render functions.

`SPIFF Redesign.dc.html` is a single design-canvas document containing all nine screens side by side. Each screen is marked with `data-screen-label="…"`; matching PNGs are in `screens/`.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and states in the mockups are final and should be matched exactly. Every value comes from the existing gx-theme palette — nothing new was invented. Where a value below is given as a hex, it is because the mockups had to inline it; in the codebase prefer the equivalent `gx-theme.css` custom property.

⚠ **Known live bug to fix as part of this work:** `flyer.css` references `--gx-panel`, `--gx-line`, and `--gx-bg-soft`, which are not defined in `gx-theme.css`. The budtender page therefore renders on off-palette CSS fallbacks. Point these at the real tokens (panel → `#121715`, line → `#232a27`, soft bg → `#0d1211`) or define them in the theme.

---

## Design tokens

### Color
| Role | Value |
|---|---|
| Page background (canvas behind the app) | `#050706` |
| App background | `#0a0e0d` |
| Panel / header / card surface | `#121715` |
| Inset surface (rows, wells, sub-cards) | `#0d1211` |
| Control surface (inputs, selects) | `#1a221f` |
| Border, default | `#232a27` |
| Border, interactive / raised | `#2e3733` |
| Divider inside a card | `#1c2320` |
| Text, primary | `#e6ece9` |
| Text, secondary | `#8a958f` |
| Text, muted / labels | `#5e6864` |
| Accent green (primary action, positive) | `#4ade80` |
| Accent green, hover / bright figure | `#5ee68f` |
| On-accent text | `#06210f` |
| Pace-bar gradient (behind → on pace) | `linear-gradient(90deg, #265939, #4ade80)` |
| Warning / attention gold | `#d4a847` |
| Error / blocked red | `#ef4444` |

Store colors come from the **GX Core store registry** (`gx_core.gs` → `GX_STORE_SEED`, mirrored in `gx-stores.js`). Never hardcode them per screen; read them from the registry so new stores inherit correctly. Values in the mockups:

| Store | Color |
|---|---|
| Century | `#22D3EE` |
| Center | `#3B82F6` |
| Commercial | `#A855F7` |
| Baseline | `#6366F1` |
| Portland | `#D946EF` |
| River | `#EC4899` |

All six stores are always in scope. There is no store multi-select — the design grows by adding rows/cards as stores are added to the registry (grids are three across, so a seventh store starts a new row).

### Typography
- **Display / headings:** `Montserrat`, weights 600/700/800/900. Used for page titles, big figures, pitch-mode numbers. Titles carry `letter-spacing: -.5px`.
- **UI / body:** system stack — `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif`, weights 400/500/600/700.
- Scale in use: `9.5px` micro-labels · `10–11px` uppercase eyebrow labels (weight 700, `letter-spacing: 1–1.4px`, uppercase) · `12–12.5px` body/table text · `13–13.5px` card titles · `14px` header figures · `15px` intro copy (`line-height: 1.6`) · `34px+` page titles · pitch mode goes far larger (see 1c).
- All numeric columns and figures use `font-variant-numeric: tabular-nums`.
- Body copy uses `text-wrap: pretty`.

### Spacing, radius, elevation
- Spacing rhythm: 6 / 8 / 10 / 12 / 14 / 20 / 24 / 28 px. Card padding `14px 15px`; panel padding `10px 20px` (bars) and `20px` (bodies); screen gutters `48px`.
- Radius: `5px` badges · `7px` list rows · `8px` inputs/selects · `9px` inset cards · `12px` cards · `14px` app shell / modal · `26px` phone flyer · `999px` pills and bars.
- Elevation: app shell and modals use `box-shadow: 0 28px 70px rgba(0,0,0,.5)`. Cards are flat — separation comes from the `#232a27` border, not shadow.
- Severity is expressed as a **3px left border** on an otherwise normal card (gold `#d4a847` for attention, red `#ef4444` for blocked), plus a matching uppercase micro-label in the same color.

### Motion
```css
@keyframes gxskel     { 0%,100% { opacity:.25 } 50% { opacity:.6 } }
@keyframes gxpulse    { 0% { box-shadow:0 0 0 0 rgba(74,222,128,.5) }
                        70% { box-shadow:0 0 0 7px rgba(74,222,128,0) }
                        100%{ box-shadow:0 0 0 0 rgba(74,222,128,0) } }
@keyframes gxaheadglow{ 0%,100% { box-shadow:0 0 10px rgba(74,222,128,.45) }
                        50%     { box-shadow:0 0 18px rgba(74,222,128,.8) } }
```
- `gxskel` — skeleton blocks (2.4s ease-in-out infinite). **Skeletons replace every "Loading…" string in the app.**
- `gxaheadglow` — a bar that is ahead of pace (2.6s ease-in-out infinite). Lifted from Leaderboard `docs-mocks/standings_mock.html`.
- `gxpulse` — one-shot confirmation on a value that just changed.

---

## Shared chrome (every desktop screen)

**App shell:** `1px solid #232a27`, radius `14px`, `overflow:hidden`, background `#0a0e0d`, the standard shadow. Fixed design width 1440px.

**Header** — `min-height:52px`, background `#121715`, bottom border `#232a27`, padding `0 20px`, flex `gap:14px`:
- gx logo (`https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png`, 22px tall) + the wordmark `SPIFF` in 11px/700 uppercase `#5e6864`, `letter-spacing:1.1px`.
- Nav: borderless 40px-tall buttons, `padding:6px 12px`, `gap:2px`. Active is `#e6ece9`; the rest are `#5e6864`. Hover lifts to `#e6ece9`.
- Right cluster: live clock (14px/700) over the date (10px uppercase `#5e6864`), then the signed-in identity chip.

**Sub-nav / filter bar** — a second bar directly under the header, background `#121715`, bottom border `#232a27`, padding `10px 20px`, `flex-wrap:wrap; gap:9px`. Starts with an uppercase 11px/700 `#5e6864` label naming the bar's job ("Modeling", "Filter", …), then search input, scope pills, and store pills. Inputs: background `#1a221f`, border `#232a27`, radius `8px`, `padding:6px 10px`, 12.5px, `color-scheme:dark`.

**Stat strip** — a row of figures directly under the sub-nav: big Montserrat number over a 10px uppercase muted label. Figures that carry a judgement take the accent green or the severity color; neutral figures stay `#e6ece9`.

---

## Screens

Every screen below has a full-size PNG in `screens/`.

### 1a Programs — `screens/1a-programs.png`
The landing surface. One program at a time is the standard; there is no multi-program import.
- Header → sub-nav (search + status pills) → stat strip → program grid.
- Program cards: `#121715`, border `#232a27`, radius `12px`, title 13.5px, status pill top-right, key figures in a small internal grid.
- Flagged programs get the 3px gold or red left border plus the matching micro-label.
- Empty and loading states use skeleton cards, not text.

### 1b Calculator — `screens/1b-calculator.png`
The working modeling view. Sub-nav label is "Modeling" and carries a program `<select>` (max-width 240px).
- **One merged store table** — all six stores in a single table, not one card per store. Columns are right-aligned tabular numbers; the store name cell carries the registry color as a leading dot.
- **"Scales with success" panel** — the addition that makes the pitch: vendor funding at each hit rate, cost per unit, and the break-even point. This panel is the screen's argument; give it visual weight (its own bordered block, larger figures) rather than burying it in the table.
- Inputs recalc live; changed figures get one `gxpulse`.

### 1c Calculator — pitch mode — `screens/1c-pitch-mode.png`
What the vendor sees across the desk. Full-bleed 1440×960 dark canvas, absolutely-positioned logo top-left, no chrome. Type scale jumps: headline figures are Montserrat at display size with the gx-login glow treatment. Nothing on this screen is interactive except advancing/exiting. Deliberately trimmed to 960px so there is no dead air above the footer.

### 1d Progress — `screens/1d-progress.png`
Mid-pull state, showing all four store-card conditions at once — this is the reference for loading behavior.
- Store cards, three across: registry-color dot + store name + unit count; a 5px `#1a221f` track with a `999px` fill in the store color; a footer line reading "N of M hit" (green when complete) and the per-store average.
- **Ahead of pace:** the fill is the `#265939 → #4ade80` gradient running `gxaheadglow`.
- **Still loading:** the bar runs `gxskel` and the footer reads "pulling from Dutchie…".
- **Failed:** the whole card takes a `#ef4444` border and a retry affordance replaces the bar.
- Budtender leaderboard rows inside each card: 22px circular avatar (`linear-gradient(135deg,#3a5a4a,#1e2a26)`, border `#2e3733`), name, delta, count. Rows at or above target get background `rgba(74,222,128,.10)` and green text (`#5ee68f`); the rest stay `#8a958f` with their negative delta in `#5e6864`.

### 1e Reports — `screens/1e-reports.png`
Three steps, in order — review, file, send. Each step is a bordered block with a numbered heading; completed steps collapse to a summary line. The close-out PDF preview is **light and printable** (white paper, dark text) and leads with the growth figures, not the program terms.

### 1f History — `screens/1f-history.png`
The lookup surface. Sub-nav is search + month scope. Rows are dense (12.5px, tabular numerics), grouped under sticky month labels, with the outcome figure right-aligned and colored only when it beat or missed target.

### 1g Record modal — `screens/1g-record-modal.png`
Signed-in, editable, one flagged record. Overlay `rgba(0,0,0,.62)`; panel 820px wide, `#121715`, border `#2e3733`, radius `14px`, standard shadow, internally scrolling with a fixed header and footer.
- Modelled and actual figures sit **side by side in two bordered groups** (`grid-template-columns:1fr 1fr; gap:24px`) — that comparison is the reason the record exists.
- The eighteen inputs are labeled rows inside those groups; only program identity keeps the field-card treatment.
- Notices are the 3px-left-border block: gold `#d4a847` "rate differs — Modelled at $25 per budtender, settled at $20."; a missing contact email borders gold and states what it blocks.

### 1h My SPIFF — `screens/1h-my-spiff.png`
The budtender phone view, 390px wide, radius `26px`, padding `20px 16px 16px`. Big single figure ("what you've earned"), then the active programs as compact rows. Optimized for glancing at on the floor: nothing below 44px is tappable, and the earned figure is the largest thing on screen.

### 1i Vendor view — `screens/1i-vendor-view.png`
The page the rep opens, 820px wide. It exists to brag: **ROI as both % and $** at the top, then sold/hit proof broken out by store, then the program terms. Light on chrome, heavy on figures.

---

## Interactions & behavior
- **Loading:** every async region renders skeleton geometry matching the final layout (`gxskel`). No spinner, no "Loading…" text.
- **Failure:** per-store, not per-page — one store failing to pull shows a red-bordered card with retry while the others keep their data.
- **Recalculation:** Calculator inputs recalc on change; the affected figures fire one `gxpulse`.
- **Pace:** any bar at or ahead of target switches to the gradient fill plus `gxaheadglow`.
- **Hover:** nav items and muted text lift `#5e6864` → `#e6ece9`; cards get border `#232a27` → `#2e3733`. No transform, no shadow change.
- **Focus:** inputs take a `#4ade80` border. Keep a visible focus ring everywhere.
- **Pitch mode:** entered from the Calculator, exits on Escape; suppresses all chrome.
- **Print:** the close-out PDF and the vendor view must print on white — do not rely on the dark theme in print stylesheets.

## State
No new state is introduced by this pass. Existing state keeps its shape:
- selected program (single), per-store pull status (`idle | loading | ok | error`), calculator model inputs, progress data by store and budtender, report step (1–3), record modal open/dirty/validation.
- Store list is read from the GX Core registry at load, never hardcoded per screen.

## Assets
- gx logo: `https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png` (already in the theme repo).
- Fonts: Montserrat (600–900) and the system UI stack. Montserrat loads from Google Fonts in the mockup; use whatever the theme repo already does.
- No other images. Store colors are data, from the registry.

## Files in this bundle
- `SPIFF Redesign.dc.html` — all nine screens as one design canvas. Open in a browser; pan/zoom.
- `support.js` — runtime for the design canvas file only. **Not** part of the deliverable.
- `screens/*.png` — full-size render of each screen.
- `github.md` — repo/branch pointers and the screen-to-source map (which existing files back each screen).

## Where the work lands
| Screen | Files to change |
|---|---|
| 1a Programs | `index.html` `#panel-programs`, `spiff.js` `renderPrograms`/`sortPrograms`, `spiff.css` `.grid` `.status` `.flag` |
| 1b/1c Calculator | `index.html` `#panel-calculator`, `spiff.js` `calcModel`/`recalc`/`renderCalcStores`, `spiff.css` `.calc-*` |
| 1d Progress | `spiff.js` `loadProgress`/`paintProgress`, `spiff.css` `.pg-*` |
| 1e Reports | `spiff.js` `renderReport`/`fileReport`/`copyEmail`, `spiff.css` `.rep-*` |
| 1f History | `spiff.js` `renderHistory`/`histRow`/`monthLabel`, `spiff.css` `.hist-*` |
| 1g Record | `spiff.js` `renderRecord`/`field`/`makeShare`, `spiff.css` `.modal-*` `.notice` `.fld` |
| 1h My SPIFF | `flyer.html`, `flyer.js` `renderFlyer`, `flyer.css` `.fl-*` (**fix the undefined tokens here**) |
| 1i Vendor view | `client.html`, `client.js` `render`/`stat`, `client.css` `.client-*` |
| Shared chrome | `gx-theme.css` `.gx-topnav` `.gx-btn` `.gx-input`; store colors from `gx_core.gs` `GX_STORE_SEED` |
