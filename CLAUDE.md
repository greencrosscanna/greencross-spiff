# SPIFF (app key `spiff`) — GX app · Inventory sub-app

Part of the Green Cross app suite, and a **sub-app of Inventory** (embedded as a tab, same pattern as
Price Cards). The **GX Command Center** (GX Core) is the shared "brain": shared sign-on, stores registry,
employee roster, Dutchie connector, and the centralized bug-report + release-note + coordination logs all
live there. Frontend: `index.html` + `spiff.js` + `spiff.css` (GitHub Pages); backend:
`apps-script/Code.gs` (clasp). Its app key in GX Core is **`spiff`**.

## What this app is

Tawny owns the SPIFF program: she works with vendors to set goals, monitors staff sell-through, and sends
the vendor a report — the vendor credits us against the next buy, and we turn that into gift cards for the
budtenders who hit their numbers. This app runs that whole loop.

Four surfaces, one spine:

1. **Calculator** — the live vendor ROI model. Change SPIFF $, target units, or participating stores and
   cost, investment, ROI and per-store/per-budtender targets recompute instantly. It is a **sales tool**
   as much as a form: Tawny presents it to the vendor to show what changing a variable does.
2. **Progress** — the budtender matrix (units by budtender by store vs. target), fed straight from
   Dutchie. Mirrored by the Leaderboard kiosks so staff can see what they have coming.
3. **Reports** — close-out: vendor PDF saved to Drive, a **drafted** vendor email for a human to send, and
   a gift-card buy list for staff payouts.
4. **History** — every closed program by pay period, so "what did we run 9 periods ago" and "last time we
   did a Wyld SPIFF" are lookups.

### What it replaces

Two spreadsheets, and one genuinely painful loop:

- **[Green Cross SPIFF Calculator](https://docs.google.com/spreadsheets/d/1ZtgWU9e5Dq3OPZlrf_cihbIMQnZfYaf7R5JfD0u8SHY/edit)**
  — 19 vendor tabs of ROI math (National Cannabis, Meraki Gardens, Grön, Wyld 10pc, Mule, Kaprikorn,
  Freshy, Hellavated, Buddies, BeGoat, …).
- **[SPIFF_Sales Report](https://docs.google.com/spreadsheets/d/1aYWKC5QTkgIK3I8DSMZR6o2yHRO8vGZiQUBcvshfNn8/edit)**
  (v1.4) — the budtender dashboard. Feeding it means exporting a Dutchie Excel **per store** and
  select-all-delete-pasting into six tabs. We pull Dutchie directly; that loop goes away entirely.
- Vendor close-outs land in **[this Drive folder](https://drive.google.com/drive/folders/1c8Yj23OkEusskHylLKYzHsqPYIgAHP1t)**
  (format precedent: `SPIFF_Sales Report - Gron - 092925.pdf`).

## The engine

Its own Apps Script project, bound to the **GX SPIFF Engine** spreadsheet (that sheet is the datastore —
the `programs` tab holds one row per program).

| | |
|---|---|
| `/exec` | `https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec` |
| script id | `1RZw4VDq06d-gdZT1RYpIDOhS9TcrzZ6qJGlTR692O15FZaAg1mKlCor-` (in `.clasp.json`) |
| datastore | sheet `1IXtgygVInEOak83RRC81bAUvr_zukdT0GJOLaqzuT44` |
| ship | `clasp push --force` then `clasp update-deployment <id>` — **update**, never create, so `/exec` holds |

**Writes ride on GET.** The browser calls the engine cross-origin via JSONP and Apps Script serves no CORS
headers for POST, so mutating actions (`importCalc`) are exposed on `doGet` too. Same pattern as GX Core.

**After any scope change**, open the script editor and run `authorize()` once — the web app returns
Google's consent HTML instead of JSON until the owner has authorized.

## The rules that matter

- **Payout model.** All 19 historical programs are **flat**: a fixed dollar bounty to each budtender who
  hits their individual target. Total owed = amount × budtenders who hit (`SPIFF $25 × 17 BTs = $425`).
  A budtender's target is their store's target spread across that store's budtenders. `payout_type` also
  declares `per_unit` and `tiered` — schema'd, deliberately **not** implemented; adding one is a handler,
  not a migration. Don't invent a payout rule that no vendor has asked for.
- **Cost, not payout, is where programs vary.** Multi-SKU programs blend it — the sheet's
  `Combined WS Cost` / `Average Cost` / `Combined Total for 20pc & 2pc`. `cost_json` supports
  `flat` and `blended`.
- **SPIFF reads the roster, never writes it.** `employees` and `stores` come from GX Core; don't
  re-hardcode store names — Command Center edits must flow through on the next load.
- **SPIFF writes `spiff_payouts`.** That is a written column contract: Leaderboard's Incentive tab and
  Performance read it. Today Mike hand-types a SPIFF dollar per employee per pay period
  (`{nameKey: {att, spiff}}` in `greencross-leaderboard`). Replacing that hand-entry is the point of the
  Asana to-do **"connect to SPIFF"**. Don't change those columns without updating both sides in one change.
- **Nothing goes to a vendor without a human.** Reports are drafted and saved; sending is Tawny's or
  Sky's click, not the app's.
- **Dates are TEXT** (`YYYY-MM-DD`), never Date objects — a sheet/script timezone mismatch silently shifts
  them a day. See `gx-conventions.md` in the Command Center.
- **All GX Core traffic goes through `GXClient`** (`gx-client.js`) — its `/exec` second hop 404s on ~6% of
  rapid calls and needs the retry. Never hand-roll a JSONP call.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX
Core — the sync protocol lives in that one command. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` and the SessionStart hook read
notes addressed to **`to_app=spiff`**, resolve done ones (`resolve_note`), and write note-backs to any app
(`add_note`). As an Inventory sub-app, its **bug reports** bucket to **Inventory** (`app=inventory`,
`tab=spiff`), not to a separate `spiff` bug stream — don't conflate the notes key with the bug tab.

**Auto-record on deploy:** `deploy.sh` POSTs `deploy_version` (app=spiff) to GX Core; `APP_VERSION` (vNN)
is single-sourced from the `?v=` cache-buster on the `spiff.js` tag in `index.html`. Bump that number and
run `./deploy.sh` after each ship, so releases show up in `version_history`.

**Shared files** (`deploy.sh`, `.claude/gx-brain-notes.sh`) come from **gx-theme** via `./gx-sync.sh`,
filled from `.gx_app`. Edit them **there**, not here, then re-sync. `gx-theme.css` and `gx-client.js` load
by URL from gx-theme — this file (CLAUDE.md) is intentionally NOT synced.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you
can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met —
the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it
out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`;
on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job
via `dev_queue` (filtered to this app) if you need its id.
