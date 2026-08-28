repo: greencrosscanna/greencross-spiff
branch: main

Also read for reference (visual language, shared theme, store registry):
- greencrosscanna/greencross-gx-theme — gx-theme.css tokens, gx-stores.js
- greencrosscanna/greencross-crew — index.html (polish reference)
- greencrosscanna/greencross-command-center — gx_core.gs (store registry + colours)

## Last sync
date: 2026-08-28T00:51:46Z

### Updated in this project
- Revised `SPIFF Redesign.dc.html` on Sky's notes: one-program-at-a-time Programs card, Import-from-Calculator removed, Calculator merged into one store table plus a "scales with success" panel, pitch bars split at today's number with Leaderboard's ahead-of-pace glow, light printable PDF preview, vendor recap carrying ROI $ and %.
- Pace-bar and glow vocabulary lifted from `greencross-leaderboard/docs-mocks/standings_mock.html`.
- Noted a live bug: `flyer.css` uses undefined tokens (`--gx-panel`, `--gx-line`, `--gx-bg-soft`) so the budtender page runs on off-palette fallbacks.
- No source files changed yet; production edits await sign-off on the mockups.

## Sync history
- 2026-08-28T00:32:33Z — first pass: mockups of all nine SPIFF surfaces built from spiff.js/flyer.js/client.js, gx-theme.css, crew/index.html, gx_core.gs store registry.

## Screen map
| Screen (in SPIFF Redesign.dc.html) | Built from |
|---|---|
| 1a Programs | index.html (#panel-programs), spiff.js renderPrograms/sortPrograms, spiff.css .grid/.status/.flag |
| 1b Calculator | index.html (#panel-calculator), spiff.js calcModel/recalc/renderCalcStores, spiff.css .calc-* |
| 1c Calculator — present mode | new; same model as 1b, gx-theme .gx-login glow + Crew type scale |
| 1d Progress | spiff.js loadProgress/paintProgress, spiff.css .pg-* ; skeletons from crew index.html .crew-skel |
| 1e Reports | spiff.js renderReport/fileReport/copyEmail, spiff.css .rep-* |
| 1f History | spiff.js renderHistory/histRow/monthLabel, spiff.css .hist-* |
| 1g Record modal | spiff.js renderRecord/field/makeShare, spiff.css .modal-*/.notice/.fld |
| 1h My SPIFF flyer | flyer.html, flyer.js renderFlyer, flyer.css .fl-* |
| 1i Vendor client view | client.html, client.js render/stat, client.css .client-* |
| Shared chrome | gx-theme.css .gx-topnav/.gx-btn/.gx-input; store colours from gx_core.gs GX_STORE_SEED |
