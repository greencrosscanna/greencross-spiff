# Handoff: SPIFF — program editor, tightened

## Overview

The program editor is the Calculator panel (`#panel-calculator`). It has accreted a second surface at
each step of its evolution — the record moved onto it in v1.336, Progress folded into it as `#calcLive`
when the tab was retired, the model gained a `<details>` wrapper, and the stat strip, the two mini
cards and the scales panel arrived with the redesign. Nothing here is wrong; there is just more of it
than there is screen, and the order never changes regardless of what the program is doing.

This pass is a **layout and flow change on the existing markup and renderers**. No new state, no new
routes, no new data. Same functions, same collectors, same save paths.

Four moves:

1. **One program bar** replaces the editing chip, the four-card stat strip and the fold header.
2. **The status decides the order.** A draft opens on the model, a running program opens on
   sell-through, a closed one opens on what it paid. The other sections collapse to a one-line
   summary that still states its facts.
3. **Prose moves onto `ⓘ` affordances** — the per-store table note, the vendor argument, the
   pay-period note and the goal-drift explainer.
4. **Actuals become a read-only figure strip.** Brand reps leave the editor.

## About the design files

`Program Editor.dc.html` is a design reference in HTML — a prototype of the intended look, not
production code to paste in. `Program Editor — today.dc.html` is a faithful recreation of the screen
as it renders now, built from `index.html`, `spiff.js` and `spiff.css`, so the two can be compared
directly.

Recreate the design inside `greencross-spiff` using its established patterns: extend `spiff.css` and
the existing `spiff.js` render functions. Do not introduce a framework or a second stylesheet
architecture.

## Fidelity

**High.** Every value is already in the palette — this pass invented no color, no font and no radius.
Where a hex appears below it is because the mockup had to inline it; in the codebase prefer the
equivalent `gx-theme.css` / `spiff-tokens.css` custom property.

| Role | Token | Value |
|---|---|---|
| App background | `--gx-bg` | `#0a0e0d` |
| Panel surface | `--gx-surface` | `#121715` |
| Segment / fold surface | `--gx-surface-2` | `#161c1a` |
| Control surface | `--gx-surface-3` | `#1a221f` |
| Inset (rows, wells, figure cells) | `--sp-inset` | `#0d1211` |
| Border | `--gx-border` | `#232a27` |
| Border, raised | `--gx-border-strong` | `#2e3733` |
| Divider inside a card | `--sp-divider` | `#1c2320` |
| Text / dim / mute | `--gx-text` · `--gx-text-dim` · `--gx-text-mute` | `#e6ece9` · `#8a958f` · `#5e6864` |
| Accent | `--gx-green` · `--gx-green-bright` · `--gx-green-dim` | `#4ade80` · `#5ee68f` · `#2f8a52` |
| Accent soft | `--gx-green-soft` | `rgba(74,222,128,.10)` |
| Attention / blocked | `--gx-gold` · `--gx-red` | `#d4a847` · `#ef4444` |
| Pace gradient | `--sp-pace` | `linear-gradient(90deg,#265939,#4ade80)` |
| Display face | `--sp-display` | Montserrat 700/800 |

Store colors come from the GX Core registry (`gx_core.gs` → `GX_STORE_SEED`, mirrored in
`gx-stores.js`). Never hardcode them per screen.

Type scale in use: `9.5–10px` uppercase labels (700, `letter-spacing:1px`) · `11–11.5px` meta and
notes · `12–12.5px` table and row text · `13.5px` inputs · `16px` program title (Montserrat 700) ·
`20px` figure-rail values (Montserrat 800). All figures `font-variant-numeric: tabular-nums`.

Spacing: workspace padding `18px 24px 28px`; section gap `14px`; panel padding `14px 16px`; table
cells `7–8px 14px`. Radius: `6px` inputs · `9px` figure cells · `10px` collapsed bars · `12px` panels
· `14px` app shell · `999px` pills and bars.

---

## Screens

### 0 — The screen today · `screens/0-today.png`

The reference. Everything below is measured against this: stat strip (116px) → fold header (44px) →
model → per-store table → five-line table note → "What's selling" (its own four-card strip, its own
prose line) → six store cards → a 2px rule → "This program" (status select alone in a two-column
grid, brand reps, seven actuals fields, footer). Roughly 1,730px of workspace for one program.

### 1a Draft — modeling with the brand · `screens/1a-draft.png`

The model is the screen.

- **Program bar.** Status pill · `programLabel(p)` in Montserrat 16/700 · a meta line carrying window,
  countdown, product, payout and store/budtender counts. Right: the four projected figures from
  `cstat()` as a rail of label-over-value pairs separated by `1px solid #232a27`, then Present and
  Save. This is the whole of the old `#calcStats` and `#calcEditing`.
- **The model, unfolded, three columns** — `grid-template-columns: 288px 320px 1fr`.
  - *The deal.* The `.sp-fld` well treatment is dropped: label above input, `4px` gap, `11px` between
    fields, one bordered panel around the group. Cost per unit and Payout share a row.
  - *The goal.* Target / growth / the drag bar, then four derived figures as inset rows — goal lands
    at, each budtender hears, cost per extra unit, break-even. The last two are the old `#calcMinis`
    two-up; they belong to the goal, not to the argument.
  - *It scales with success.* The `scaleRows()` table, unchanged. Its footer carries the one sentence
    of the argument that is a *figure* claim (the invariant percentage return); the rest of
    `#calcArgue` is on the heading's `ⓘ`.
- **Per store.** Same eight columns, same editable cells, same pin affordance. Row padding `7px`,
  inputs `68px` / `44px`. The five-line note is the heading's `ⓘ`. `#calcWaiting` moves to the right
  end of that heading row.
- **Record** collapses to one line: "Draft · not started · nothing measured yet".

### 1b Running — checking in · `screens/1b-running.png`

Sell-through is the screen.

- **Program bar** carries the *live* figures instead of the projected ones: units sold with a 3px
  pace bar, at-target with its own bar, earned so far against committed, and pace. The meta line
  states day-of-window and the hourly stamp — `pgPulled` and the cached/hourly note from
  `paintProgress` collapse into it. Refresh sits in the bar.
- **`#pgStats` is deleted.** All four of its figures are in the rail now; keeping both is the
  duplication that makes this screen long.
- **Store cards** keep every state (ahead / normal / pulling / failed) and every budtender row.
  Density only: card padding `11px 13px`, rows `5px 7px` at `12px`, avatar `20px`. The prose line
  under the heading becomes `ⓘ` + "green has already earned it".
- **The deal** collapses to one line stating the terms — product, cost, payout, target and growth,
  store and budtender counts — with an Edit model button. Expanded, it is exactly 1a.
- **Record** collapses to one line, and carries the `needsRep(p)` warning as a gold dot rather than
  a full notice block.

### 1c Closed — settled · `screens/1c-closed.png`

What it paid is the screen.

- **Program bar** reads in the past tense off `actual_json`, the `settled` branch of `recalc` — they
  funded, revenue it earned, their return, unit lift — with closed-on and reported-on in the meta.
- **Actuals as a strip.** Six figures in a six-column bordered row, `17px` values over `10px`
  uppercase labels. "Correct by hand" is an underlined text button; Re-measure is a normal button.
  The seven `actField()` inputs are still the save path — the strip renders their values and the
  fields appear in place when the unlock is taken. Revenue is folded into the `ⓘ` (nothing reads it;
  the vendor report derives `added_revenue` fresh).
- **What sold** is the frozen `#resGrid`, unchanged but at 1b's density and with no animation on the
  bars.
- **The deal** collapses with a "locked — reported to the brand" marker. `applyCalcLock` is unchanged;
  the fold is just closed by default, which it already is for a closed program.

---

## Behavior

- **Staging.** `applyStatusView` already branches on status to open or close `#calcModelFold` and to
  show `#calcLive` / `#calcResults`. It grows two more jobs: choosing the section **order** in the
  DOM, and rendering the non-primary sections as their collapsed summary bar. A collapsed bar is a
  `<details>` summary — same pattern as `.sp-fold`, so keyboard and focus behavior come free.
- **The bar is one renderer.** The rail contents are the `cstat()` / `pgStat()` figures that already
  exist; feed them into one `renderProgramBar(p, mode)` rather than three strips. `mode` follows the
  same `settled` test `recalc` uses today.
- **`ⓘ` is a `title` in the mockup.** In the app, give it the theme's tooltip if there is one; a
  `title` is an acceptable floor. The text must not be lost — several of those notes are the only
  place a rule is written down for the person reading the screen.
- **Loading, failure, recalculation, focus and lock** are all unchanged: skeleton geometry per region,
  per-store failure with its own retry, one `gxpulse` on a figure that moved, `#4ade80` focus border,
  `applyCalcLock` re-applied after every table repaint.
- **Brand reps leave the editor.** `renderBrandReps` and `#rBrandReps` come off this screen; the
  Settings brand directory (`renderBrandDirectory`) is unchanged and is the only place they are
  edited from now. `needsRep(p)` still fires — as a one-line notice on a draft, as a dot on the
  collapsed Record bar elsewhere. `saveBrandContact` / `removeBrandContact` / `addBrand` keep working;
  they just have one caller.

## Open question for Sky/Tawny

**Pace** on 1b (`−8%`, "behind by 48 units") does not exist today. It is derivable with no new data —
units sold against target, prorated by day-of-window — but it is a new figure and a new judgment.
Drop it if you would rather not add one.

## Where the work lands

| Change | Files |
|---|---|
| Program bar | `index.html` `#panel-calculator` head, new `renderProgramBar` in `spiff.js` replacing `#calcStats` + `#calcEditing`, `spiff.css` new `.sp-pbar-*` |
| Section staging and collapsed bars | `spiff.js` `applyStatusView`, `syncRecordMount`; `spiff.css` `.sp-fold` extended |
| Model, three columns, no wells | `index.html` `.sp-calc-grid`, `spiff.css` `.sp-calc-grid` `.sp-flds` `.sp-fld` |
| Goal panel derived figures | `spiff.js` `recalc` (`#calcMinis` merged into the goal block) |
| Per-store density + note to `ⓘ` | `spiff.css` `.sp-tbl` `.sp-tbl-note`, `spiff.js` `renderCalcTable` markup |
| `#pgStats` removal, card density | `spiff.js` `paintProgress` / `pgCard`, `spiff.css` `.sp-pg-stats` `.sp-pgcard-*` `.sp-bt*` |
| Actuals strip | `spiff.js` `renderRecord` / `actField`, `spiff.css` `.sp-act` |
| Brand reps out of the editor | `spiff.js` `renderRecord` (drop the `#rBrandReps` host); `renderBrandReps` kept for Settings |

## Files in this bundle

- `README.md` — this document.
- `screens/0-today.png` — the screen as it renders now.
- `screens/1a-draft.png`, `screens/1b-running.png`, `screens/1c-closed.png` — the three staged states.
- `Program Editor.dc.html` — the design, all three states on one canvas. Open in a browser; pan/zoom.
- `Program Editor — today.dc.html` — the recreation of the current screen.
- `support.js` — runtime for the two design files only. **Not** part of the deliverable.
