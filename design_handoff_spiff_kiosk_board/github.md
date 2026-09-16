repo: greencrosscanna/greencross-spiff
branch: main

Read for reference: `store.html` / `store.css` / `store.js` (the kiosk view),
`spiff-tokens.css`, and `design_handoff_spiff_redesign/README.md` (token table +
nine-surface vocabulary this redesign extends).

## Last sync
date: 2026-09-16T19:32:20Z

### Updated in this project
- Redesigned the kiosk store view as `SPIFF Kiosk Board.dc.html` — the 10th surface, not covered by the existing handoff.
- Scoped to one running program (no multi-program grid), read at arm's reach in a kiosk popup, never touched.
- Top of screen is the trio Sky asked for: what it pays, units to hit your bonus, days left. Team board promoted to the centerpiece — ranked, with the Leaderboard pace gradient + `gxaheadglow` on rows that have hit.
- Tips moved below the board; added a real empty state (last program's result) instead of a dead screen.
- Still no earnings, cost, or ROI on this surface.

## Screen map
| Screen | Built from |
|---|---|
| SPIFF Kiosk Board | store.html, store.js render/card/crew, store.css .st-*, spiff-tokens.css, design_handoff_spiff_redesign token table |
