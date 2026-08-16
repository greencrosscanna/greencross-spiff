# Green Cross SPIFF

Vendor-funded budtender incentives, end to end — model a program with the vendor, watch it fill from
Dutchie sell-through, close it out into a vendor report and staff payouts.

Live: https://greencrosscanna.github.io/greencross-spiff/
Embedded as a tab in [Inventory](https://greencrosscanna.github.io/greencross-inventory/).

| | |
|---|---|
| Frontend | `index.html` · `spiff.js` · `spiff.css` (GitHub Pages) |
| Backend | `apps-script/Code.gs` (clasp) |
| Shared | `gx-theme.css` + `gx-client.js` by URL; `deploy.sh` + brain hook via `./gx-sync.sh` |
| App key | `spiff` (GX Core) |

Ship a release: bump the `?v=` on the `spiff.js` tag in `index.html`, push, then
`GX_NOTES="what changed" ./deploy.sh`.

See [CLAUDE.md](CLAUDE.md) for what this app is, the rules it runs on, and how it talks to the brain.
