# Handoff: SPIFF kiosk board (store.html)

## Overview
`store.html` is the SPIFF board that opens as a popup from the SPIFF button on each store's
kiosk. It is a **shared screen**: no sign-in, and it never shows anyone's earnings, vendor cost,
investment, or ROI — a customer can read it over the counter. The personal view (`flyer.html`)
keeps its own sign-in and is out of scope here.

This pass redesigns that surface. It is the tenth SPIFF surface and is **not** covered by
`design_handoff_spiff_redesign/`; it reuses that handoff's token vocabulary exactly and invents
no new color, font, or radius.

What changed from the live board, and why:

| Change | Reason |
|---|---|
| Single program only — the `is-multi` two-column grid and `.st-wrap.is-multi` media query are removed | Only one program ever runs at a time per store |
| Three headline figures instead of two: **what it pays**, **units to hit your bonus**, **days left** | The three things a budtender acts on; confirmed with Sky |
| Team board promoted to its own panel as the centerpiece — ranked, rank numbers, 46px rows, 16px names | The board is what staff actually come to the screen for; it was a footnote under the figures |
| Rows sorted by units descending, with rank | Makes it a competitive board rather than a roster |
| Rows that have hit take the pace gradient + `gxaheadglow` and a green row wash | Readable as "done" at a glance, at arm's reach |
| Store target moved into the board header as a thin registry-color bar | It is context, not a headline; it was a loose sentence before |
| Tips numbered and moved below the board | They lost the top of the screen to the three figures, but keep full 15px body size |
| Real empty state: last program + how the store finished | The old empty state was a dead screen |
| Page-level store name, "as of" stamp, footer text removed | The kiosk modal already supplies chrome ("SPIFF · Century", Close, closing timer) |

Still deliberately absent: earnings per person, vendor cost, investment, ROI. The engine's
`storeView` route returns none of it — keep it that way.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype of the intended
look and behavior, not production code to paste in. The task is to **recreate this design inside
the existing `greencross-spiff` codebase**: vanilla HTML/CSS/JS, `gx-theme.css` + `spiff-tokens.css`,
and the `store.js` render functions. Do not introduce a framework or a new stylesheet
architecture — extend `store.css` and the existing `render()` / `card()` / `crew()` functions.

`SPIFF Kiosk Board.dc.html` opens in a browser directly. It is a design-canvas document; the
`support.js` beside it is its runtime only and is **not** part of the deliverable. Its inline
styles are how that format works — in the codebase these become classes in `store.css`.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and states are final and should be matched
exactly. Every value is from the gx-theme palette as tabulated in
`design_handoff_spiff_redesign/README.md`. Where a value appears here as a hex it is because the
mockup had to inline it; in the codebase prefer the equivalent `gx-theme.css` custom property.

⚠ Note the live bug that handoff already flagged and that this page inherits through `flyer.css`:
`--gx-panel`, `--gx-line`, and `--gx-bg-soft` are not defined in `gx-theme.css`, so they fall
through to off-palette fallbacks. `store.css` is clean; `flyer.css`, which `store.html` also
loads, is not. Fix it there (panel → `#121715`, line → `#232a27`, soft bg → `#0d1211`).

---

## Screens / Views

### Kiosk board — live (`screens/kiosk-board-live.png`)
**Purpose:** a budtender glances at this between customers and learns four things: what is running,
what it pays, how far they have to go, and where the room stands.

**Layout.** A single column, `max-width: 720px`, centered, `padding: 18px 16px 24px` on the page
wrapper, `display:flex; flex-direction:column; gap:12px`. No fixed heights anywhere — the popup
window can be narrow, and the design reflows. Three stacked panels:

**1. Program panel**
- Card: `#121715`, `1px solid #232a27`, radius `12px`, padding `18px 20px 20px`.
- Vendor eyebrow: 10px / 700 / `letter-spacing:1.3px` / uppercase / `#5e6864`. Content: `WYLD`.
- Program name: Montserrat 900, `30px`, `line-height:1.12`, `letter-spacing:-.5px`, `#e6ece9`,
  `margin-top:5px`. Content: `Wyld 10pc Gummies`. Joined by `programLabel()` in `store.js` —
  keep that function in step with `programLabel()` in `spiff.js`.
- Status row, `margin-top:10px`, `gap:10px`, wraps:
  - "RUNNING NOW" pill: `padding:4px 9px`, radius `5px`, background `rgba(74,222,128,.12)`,
    border `1px solid rgba(74,222,128,.3)`, text 10px / 700 / `letter-spacing:1.1px` / uppercase /
    `#5ee68f`.
  - Date range: 12.5px `#8a958f`, tabular-nums. Content: `Sep 8 – Sep 21`. Dates are formatted by
    hand from the `YYYY-MM-DD` text (never through `Date`, which parses as UTC and renders the
    previous day in Los Angeles).
- "SELL" well, `margin-top:16px`: background `#0d1211`, border `1px solid #232a27`, radius `9px`,
  padding `12px 14px`, baseline-aligned flex, `gap:10px`, wraps. Label 10px / 700 /
  `letter-spacing:1.2px` / uppercase / `#5e6864`; product 15px / 600 / `#e6ece9`. The whole well
  is omitted when `p.product` is empty.
- Figure trio, `margin-top:12px`: `display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px`.
  Each cell: `#0d1211`, radius `9px`, padding `15px 16px 14px`. Figure is Montserrat 900 / `40px` /
  `line-height:1` / `letter-spacing:-1px` / tabular-nums; label `margin-top:7px`, 12px,
  `line-height:1.35`, `#8a958f`.
  - **Pays** — the only colored figure: `#4ade80`, and its cell takes border
    `1px solid rgba(74,222,128,.32)` instead of `#232a27`. Flat: `$25` / "when you hit your goal".
    Per-unit: `$3` / "for every unit you sell".
  - **Goal** — `#e6ece9`. Flat: `8` / "units to hit your bonus". Per-unit: `Any` /
    "unit pays — no personal goal" (a per-unit program has no individual target; a `0` there reads
    as "you are not in this one").
  - **Days left** — `#e6ece9`, or `#d4a847` when `days <= 3`. Content `6` /
    "days left, ends Sep 21"; singular "day left" at 1. Counted inclusive of the end date on whole
    days, matching the operator app: a program running through the 30th has one day left on the
    30th.

**2. Board panel — the centerpiece**
- Card: `#121715`, `1px solid #232a27`, radius `12px`, padding `16px 20px 18px`.
- Header row, baseline-aligned, space-between, wraps:
  - Title: Montserrat 800 / `17px` / `letter-spacing:-.2px` / `#e6ece9`. "Where everyone stands"
    (flat) or "Sold so far" (per-unit).
  - Hit count: 12.5px / 700 / tabular-nums, `#5ee68f` when any have hit else `#8a958f`. Content
    `3 of 7 hit`. Per-unit programs have no goal to hit, so this reads `42 units sold` instead.
- Store line, `margin-top:12px`, `padding-bottom:14px`, `border-bottom:1px solid #1c2320`,
  flex, `gap:10px`: uppercase 10px `#5e6864` "STORE" label; a flexible `5px` track
  (`#1a221f`, radius `999px`, `min-width:40px`) whose fill is the **store registry color** at
  radius `999px`; then `42 of 60 units` in 12.5px `#8a958f` tabular-nums.
- Rows, `margin-top:4px`, one per person at the store **including everyone at zero** — a board
  that lists only sellers cannot tell you whether you are behind or simply missing.
  - Row grid: `grid-template-columns: 26px minmax(0,1fr) minmax(52px,1.5fr) 64px`, `gap:12px`,
    `align-items:center`, `min-height:46px`, `padding:0 10px`, `margin:0 -10px`, radius `7px`.
    The units column is a **fixed 64px, not `auto`** — with `auto`, a two-digit leader resized its
    own row's columns and knocked its bar ~10px off the axis of the rows below it, on a screen
    whose whole job is row-to-row comparison.
  - Rank: Montserrat 800 / 13px / right-aligned / tabular-nums. `#4ade80` if hit, else `#5e6864`.
  - Name: 16px / 600, single line, ellipsis. `#5ee68f` if hit · `#e6ece9` if selling ·
    `#8a958f` if zero. **Do not use `#5e6864` for a name** — at 16px on `#121715` it is ~3.2:1
    and fails contrast; it is the micro-label color, not a data color.
  - Bar: `8px` track, `#1a221f`, radius `999px`. Fill radius `999px`, width
    `units / goal` clamped 0–100% (for per-unit programs, where there is no goal, scale against
    the leader's units instead). Fill color: `linear-gradient(90deg,#265939,#4ade80)` + 
    `gxaheadglow 2.6s ease-in-out infinite` when hit · flat `#265939` when selling · `#1a221f`
    when zero.
  - Units: 16px / 700 / tabular-nums / right-aligned, same color rule as the name, with the
    `/8` goal suffix in 600 `#5e6864`. Omit the suffix when there is no personal goal.
  - Row background: `rgba(74,222,128,.10)` when hit, else transparent.
  - **Names must never be clipped to fit a bar.** The bar column gives up width first; at 375px it
    can collapse to near nothing, but `Jayce Alexander` stays whole. It is the quick read, not the
    fact.

**3. Tips panel** (`screens/kiosk-board-live.png`)
- Card: `#121715`, `1px solid #232a27`, radius `12px`, padding `16px 20px 18px`.
- Heading: 10px / 700 / `letter-spacing:1.3px` / uppercase / `#5e6864`. Content
  `HOW TO SELL IT · FROM TAWNY`.
- List, `margin-top:12px`, `gap:11px`. Each item is
  `grid-template-columns: 16px minmax(0,1fr)`, `gap:10px`, `align-items:start`: the number in
  Montserrat 800 / 11px / `line-height:1.55` / `#4ade80`, the text in 15px / `line-height:1.55` /
  `#e6ece9`.
- **The whole panel is absent, not empty, when Tawny has written no tips.** A "How to sell it"
  heading over nothing reads as a broken page.
- Tip copy in the mockup is placeholder. Real tips come from `p.tips`.

### Kiosk board — no program running (`screens/kiosk-board-empty.png`)
Replaces the three panels with one: `#121715`, `1px solid #232a27`, radius `12px`,
`padding:40px 28px`, centered text.
- Headline: Montserrat 800 / `26px` / `letter-spacing:-.5px` / `#e6ece9` — "Nothing running right now".
- Body: 15px / `line-height:1.6` / `#8a958f`, `margin-top:10px` — "The next SPIFF at {store} shows
  up here on its own. Nothing to do but sell."
- "Last one" chip, `margin-top:22px`, inline-flex baseline, `gap:10px`, `padding:12px 16px`,
  `#0d1211`, border `1px solid #232a27`, radius `9px`: uppercase 10px `#5e6864` label, then the
  program name in 13px `#e6ece9`, then the result in 13px / 700 / `#4ade80`.
- **The engine returns this — draw the chip.** `storeView` carries `last_program` on the empty
  path, shipped in the same release as this handoff (v1.429, live since 2026-09-16):

  ```json
  "last_program": { "vendor": "Wyld", "program_name": "Wyld 5pc Gummies",
                    "end_date": "2026-09-06", "store_pct": 112 }
  ```

  Join `vendor` + `program_name` through `programLabel()`, the same rule a running program uses,
  so the board calls a SPIFF one thing whether it is on or finished. **`store_pct` is optional** —
  it is omitted, not zeroed, when the program carried no goal for this store, and the result span
  is then dropped rather than rendered as `0%`. The whole `last_program` key is **absent** when the
  store has never finished one, and when the most recent close happened before its end date (a
  program closed early is not the last one to *finish*). Absent means no chip: the headline and the
  two body lines are a complete screen on their own. **Never infer the chip client-side** — the
  page cannot know attainment, and a guessed number on a wall screen is worse than no chip.

  *This paragraph told you the opposite until 2026-09-17, and it was wrong the day it was written:
  the field shipped in the same commit as this file. Leaderboard read it, believed it, and
  correctly dropped the chip from the panel now live on six wall screens.*

### Kiosk board — per-unit program (`screens/kiosk-board-per-unit.png`)
Same layout. Differences are listed inline above: pays figure and label, `Any` goal figure,
"Sold so far" board title, units-sold count in place of the hit count, no `/goal` suffix, bars
scaled against the leader, no hit states.

## Interactions & Behavior
This surface is **read-only and never touched** — it is a popup on a shared kiosk. There are no
hover states, no focus states, no controls, no links, no tabs. Anything that looks tappable is a
bug here.

- **Refresh:** keep the current behavior — `setInterval` every 10 minutes, plus an immediate
  reload on `visibilitychange` when the screen wakes, so a kiosk that slept overnight is not
  showing yesterday's program to the morning shift. Goals and tips change rarely and nothing on
  this screen moves by the minute; more frequent polling would put six shop screens on the
  engine's neck all day for nothing.
- **Loading:** render skeleton geometry matching the final layout (`gxskel`, defined in
  `spiff-tokens.css`) — the program card, three figure cells, and six board rows. No spinner and
  no "Loading…" string; the current `.fl-boot` text should go.
- **Failure:** keep the plain-language messages and the distinction the engine draws between a
  revoked link, an incomplete link, and a store with nothing running. Telling somebody the wrong
  one sends them looking in the wrong place. Nobody is standing at a kiosk to read a stack trace.
- **Motion:** `gxaheadglow` on hit rows only. `prefers-reduced-motion: reduce` removes all
  animation — these are idle loops that never stop, which is exactly what vestibular-triggered
  users ask not to have on a wall.
- **Responsive:** fluid to the popup width. Below ~560px the bar column shrinks and the figure trio
  may wrap to one column; names and figures never shrink below the sizes above.

## State Management
No new client state. The page renders one `storeView` payload:
`{ ok, store_id, store_name, today, programs: [{ vendor, program_name, product, start_date,
end_date, payout, payout_type, bt_goal, store_goal, measured_at, tips: [], people: [{ name,
units, hit }] }] }`.

Derived at render time, not stored: days left, rank order (units descending), bar percentages,
hit count, store attainment. The store's registry color comes from the GX Core store registry
(`gx_core.gs` → `GX_STORE_SEED`, mirrored in `gx-stores.js`) — never hardcode it per screen.

One behavior change to make in `store.js`: `crew()` currently renders `p.people` in the order
received. Sort by units descending for the ranked board.

The `?t=` token identifies the **screen, not a program** — one permanent link per store that
resolves to whatever is running there today. Do not change that; a per-program link would need
re-pasting into six kiosks every time a SPIFF ended, and the first time somebody forgot, a kiosk
would show a finished program as though it were live.

## Design Tokens

### Color
| Role | Value |
|---|---|
| Page background | `#050706` |
| Panel / card surface | `#121715` |
| Inset surface (wells, figure cells, chip) | `#0d1211` |
| Bar track | `#1a221f` |
| Border, default | `#232a27` |
| Divider inside a card | `#1c2320` |
| Text, primary | `#e6ece9` |
| Text, secondary (labels, muted rows) | `#8a958f` |
| Text, micro-label only | `#5e6864` |
| Accent green | `#4ade80` |
| Accent green, bright figure / hit text | `#5ee68f` |
| Hit row wash | `rgba(74,222,128,.10)` |
| Pays cell border | `rgba(74,222,128,.32)` |
| Running-now pill | bg `rgba(74,222,128,.12)`, border `rgba(74,222,128,.3)` |
| Pace gradient (hit bar) | `linear-gradient(90deg,#265939,#4ade80)` |
| Partial bar fill | `#265939` |
| Attention gold (≤3 days left) | `#d4a847` |

Store colors, from the registry: Century `#22D3EE` · Center `#3B82F6` · Commercial `#A855F7` ·
Baseline `#6366F1` · Portland `#D946EF` · River `#EC4899`.

### Typography
- Display: `Montserrat` 800/900 — program name (30px), figures (40px), board title (17px), rank
  (13px), tip numbers (11px), empty-state headline (26px).
- UI/body: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- Scale: 10px and 10.5px uppercase eyebrows (700, `letter-spacing:1.2–1.3px`) · 12px figure
  labels · 12.5px dates and secondary figures · 15px product name and tip text · 16px board names
  and units · 17px board title · 26px / 30px / 40px display.
- Every figure uses `font-variant-numeric: tabular-nums`. Body copy uses `text-wrap: pretty`.

### Spacing, radius
- Spacing rhythm: 4 / 5 / 7 / 10 / 12 / 14 / 16 / 18 / 20 / 22 px. Page `18px 16px 24px`;
  panel gap `12px`; card padding `18px 20px 20px` (program) and `16px 20px 18px` (board, tips).
- Radius: `5px` pill · `7px` board row · `9px` inset cells and wells · `12px` cards · `999px`
  bars and dots.
- Cards are flat. Separation comes from the `#232a27` border, never shadow.

## Assets
None. No images, no icons, no logo on this surface — the kiosk modal supplies its own chrome.
Store colors are data, from the registry. Montserrat loads from Google Fonts in the mockup; in the
codebase use the font link `store.html` already carries.

## Files
- `SPIFF Kiosk Board.dc.html` — the design. Open in a browser.
- `support.js` — runtime for that file only. Not part of the deliverable.
- `screens/kiosk-board-live.png` — live program, flat payout.
- `screens/kiosk-board-empty.png` — nothing running.
- `screens/kiosk-board-per-unit.png` — per-unit payout.

## Where the work lands
| Piece | Files to change |
|---|---|
| Layout and all three panels | `store.css` (`.st-*`) — the `.st-wrap.is-multi` grid and its `min-width:1100px` media query can be deleted |
| Program panel + figure trio | `store.js` `card()` — third figure (days left) is new; `daysLeft()` already exists |
| Ranked board | `store.js` `crew()` — sort by units desc, add rank column, hit gradient + glow |
| Empty state | `store.js` `emptyBoard()` / `msg()` — the chip's data is already on `storeView` as `last_program` |
| Skeletons | `store.html` `#boot` → skeleton markup; `gxskel` is already in `spiff-tokens.css` |
| Undefined-token bug | `flyer.css` (`--gx-panel`, `--gx-line`, `--gx-bg-soft`) |
