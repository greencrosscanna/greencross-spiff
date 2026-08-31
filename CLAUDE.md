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
   Dutchie. Published as `?action=progress` (token-gated) off the `spiff_progress` cache, which an
   hourly trigger refreshes. **GX Crew consumes it** — `applySpiffEarnings_` fills the incentive
   SPIFF column from what SPIFF measured, so Mike reads a figure instead of typing one.
   Every row carries **`status`** (draft | active | closed), and `&status=active` filters to it
   server-side — which trims `by_employee` totals too, since those are summed from the surviving
   rows. It is **resolved at read time** from the `programs` tab, never stored on the cached row:
   the cache is a snapshot and the hourly sweep is active-only, so a stored column would read
   `active` forever for a programme closed since its last refresh — stale in exactly the case the
   field exists to catch. Added 2026-08-30 at Leaderboard's ask, after a closed programme drew on
   23 of 40 kiosk cards because window-overlap was the only inference available.
   *Corrected 2026-08-29: this said "Mirrored by the Leaderboard kiosks so staff can see what they
   have coming." **Nothing in `greencross-leaderboard` calls the route** — the mirror was aspiration
   written as fact. It is wanted (SPIFF ticks on kiosk staff cards) and is **Leaderboard-side work**
   against a route SPIFF already publishes; it needs no code here.*
3. **Reports** — close-out: vendor PDF saved to Drive, a **drafted** vendor email for a human to send, and
   a gift-card buy list for staff payouts.
4. **History** — every closed program by pay period, so "what did we run 9 periods ago" and "last time we
   did a Wyld SPIFF" are lookups.

### The source of truth

Tawny's **SPIF program docs** in Drive are authoritative — one `.docx` per store per program, named
`<Store> - <Program> - <M.D.YY>-<M.D.YY>.docx`, in
**[Current SPIF / Archived SPIF](https://drive.google.com/drive/folders/1ux44BjJf9PDUFbIaecnmFOwZDy4LTQVa)**.
They carry the two things the Calculator never recorded: **exact program windows** (in the filename) and
the **real per-budtender goal** (in the body). 112 docs → 22 programs. Programs group by **vendor +
window**, not title — the same program is named differently store to store. **"South" is the old name for
the Commercial St store.** The docs are `.docx`, so the engine unzips `word/document.xml` rather than
using DocumentApp, and stitches table cells back into rows.

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
| datastore | sheet `1IXtgygVInEOak83RRC81bAUvr_zukdT0GJOLaqzuT44` — lives in **[GX2 Dashboard](https://drive.google.com/drive/folders/1BXH5SrK9dWupl-w1UW5Bjt5oSORednLD)** |
| ship | `clasp push --force` then `clasp update-deployment <id>` — **update**, never create, so `/exec` holds |
| run (frontend) | `python3 serve.py` → <http://localhost:8754> — no build step, the working tree IS the app |
| tests | no automated suite — verify against the live engine |

The dev server talks to the **live** engine; `gx-dev.js` blocks writes until you arm them, and
`gx-preflight.sh` runs as a **pre-push hook** refusing dev leftovers (fixtures on, writes armed, localhost
URLs, `@devonly` blocks).

**Writes ride on GET.** The browser calls the engine cross-origin via JSONP and Apps Script serves no CORS
headers for POST, so mutating actions (`importCalc`) are exposed on `doGet` too. Same pattern as GX Core.

**Every file this app creates in Drive belongs in
[GX2 Dashboard](https://drive.google.com/drive/folders/1BXH5SrK9dWupl-w1UW5Bjt5oSORednLD)** —
datastores, engine-bound sheets, anything an app owns. `clasp create-script --type sheets` drops the new
spreadsheet at Drive **root**, so it must be moved after creation; that is how the SPIFF engine sheet ended
up loose. Business documents are the exception: vendor close-out PDFs stay in the **SPIFF Reports** folder
under **Incentive Program**, where the business already keeps them and Tawny expects to find them.

**Script properties this engine needs** (Project Settings → Script Properties; never in the repo):
`CLIENT_VIEW_PASSWORD` (vendor link passphrase) and `GX_DEPLOY_SECRET` (calls GX Core's secret-gated
`sales_by_employee` for Progress).

**After any scope change**, open the script editor and run `authorize()` once — the web app returns
Google's consent HTML instead of JSON until the owner has authorized.

## The rules that matter

- **Payout model.** Most programs are **flat**: a fixed dollar bounty to each budtender who hits their
  individual target (`SPIFF $25 × 17 BTs = $425`). But **`per_unit` is real and implemented** — Hapy
  Kitchen (2.16–3.1.26) paid "$1 for every unit sold", with "Unit Based"/"You Decide" where the goals
  normally sit. The Calculator flattened it, which is why the imported history looked uniformly flat;
  the SPIF docs show the truth. `tiered` remains schema'd and unimplemented. Read the payout model off
  the doc rather than assuming.
- **Cost, not payout, is where programs vary.** Multi-SKU programs blend it — the sheet's
  `Combined WS Cost` / `Average Cost` / `Combined Total for 20pc & 2pc`. `cost_json` supports
  `flat` and `blended`.
- **SPIFF reads the roster, never writes it.** `employees` and `stores` come from GX Core; don't
  re-hardcode store names — Command Center edits must flow through on the next load.
- **SPIFF has no cross-app write contract.** *Corrected 2026-08-25: this bullet used to say "SPIFF
  writes `spiff_payouts`… GX Crew consumes these payouts for its bonus calc." **No such tab exists** —
  it is not in `GX_TABS`, nothing writes it and nothing reads it. SPIFF's only GX Core calls are READS:
  `getEmployees`, `getStores`, `getProducts`, `libVersion`. Payout data lives in SPIFF's own sheet.*
  A documented contract that does not exist is worse than an undocumented one: it invites a future
  session to "maintain" it, or to assume pay data already flows and build on top of it.
- **The underlying goal is still real, and still unbuilt.** Incentive moved out of Leaderboard into
  **GX Crew** (decision 2026-08-16), so "connect to SPIFF" work targets Crew. Today Mike hand-types a
  SPIFF dollar per employee per pay period (`{nameKey: {att, spiff}}`), and replacing that hand-entry is
  the point. When that gets built it will need a real contract — designed, not assumed.
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

**Version format is `vMAJOR.BBB`** — three-digit build, e.g. **`v1.280`**. SPIFF ran on bare integers
through v27, went to `1.28` on 2026-08-22, and padded to `1.280` on 2026-08-23 when the suite fixed the
width. One number for the whole app: `index.html`, `flyer.html` and `client.html` all carry the same `?v=`.

**The pad is to the RIGHT.** The build is the fractional half of a decimal that has been counting up, so
`1.28` is the 280s — left-padding to `1.028` would send the app *backwards* past everything it has already
shipped. Widths that disagree don't sort: `v1.28` is above `v1.280` as a string and below it as a number,
so What's New ordering and every "is this newer than what I've seen" check disagree the moment the counter
crosses a digit boundary. `deploy.sh` refuses a non-conforming version, and GX Core's `gxRecordVersion`
enforces the same rule server-side — that one is the real gate, since any curl can bypass the script.

**Auto-record on deploy:** `deploy.sh` POSTs `deploy_version` (app=spiff) to GX Core; `APP_VERSION` is
single-sourced from the `?v=` cache-buster on the `spiff.js` tag in `index.html`. Bump that number and
run `./deploy.sh` after each ship, so releases show up in `version_history`.

**"Each ship" includes a BACKEND-ONLY ship** — an engine change, a GXCore re-pin, anything that never
touches `index.html`. *Decided 2026-08-30 by Sky, after this drifted for ten commits.* The `?v=` is the
**app's release number** that happens to be stored in a cache-buster, not a statement about the
frontend; the line above already says one number covers the whole app. `deploy.sh` extracts it from
`HEAD:index.html`, so a backend ship with no bump gives it nothing new to find, it records nothing, and
**it says nothing while doing so** — there is no error, because from its side there is no new release.

That is how `app_versions` came to claim spiff's latest release was `v1.319 / 117a459` while the live
engine ran ten commits later, including the `status` field on progress rows that GX Crew and
Leaderboard consume. Nothing was broken; the log was just quietly wrong about what was live, in the
one place you would go to check.

So: **bump `?v=` and run `./deploy.sh` even when no frontend file changed.** The whole cost is a no-op
re-fetch of `spiff.js` on the next load. Pass `GX_NOTES="…"` — for a backend ship the version number is
all a reader gets otherwise, and most rows in the log already have empty notes.

Note the two axes do not line up and are not meant to: `version_history` tracks the **app** version
(`v1.320`), while the engine has its own **clasp deployment** version (`@71`), visible from
`clasp list-deployments` and via `./gxpins.sh` for the library pin. Recording the app version is what
ties a `git_sha` to what is live; the clasp number is not expressible in the `vMAJOR.BBB` format
`gxRecordVersion` enforces, so don't try to file it as one.

`deploy.sh` reads MAJOR.BBB correctly as of gx-theme's 2026-08-23 fix — run it normally. It briefly
could not: the old extractor stopped at the dot and filed `?v=1.28` as **`v1`**, silently, with a success
line, so v1.28 was recorded by hand. That workaround is retired.

> Worth keeping, because this repo proposed the wrong fix. Widening the second stage to `[0-9.]+` looks
> like the one-character answer and **is worse than the bug** — it matches the dot in `.js` before it
> reaches the version and returns `.` for *every* app, including the integer ones that work today.
> Verified here against our own `index.html`. What shipped (Crew's proposal) strips up to `?v=` with sed
> instead of hunting for digits anywhere in the tag; `gx-theme/tests/deploy_version_test.js` now re-runs
> both rejected patterns to prove they are worse. Don't re-propose either.

**Shared files** (`deploy.sh`, `.claude/gx-brain-notes.sh`) come from **gx-theme** via `./gx-sync.sh`,
filled from `.gx_app`. Edit them **there**, not here, then re-sync. `gx-theme.css` and `gx-client.js` load
by URL from gx-theme — this file (CLAUDE.md) is intentionally NOT synced.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next
prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you
can build here without switching to the CC. It reads the app key above automatically.

**Pre-launch: work live on `main`.** SPIFF is not in anyone's hands yet, so skip the PR-per-change
dance other spokes use — commit and push straight to `main`, verify on Pages, and keep moving. Revisit
this the moment Tawny is actually using it; from then on it ships like every other spoke (PR → Sky
merges). Still `./deploy.sh` after each ship so `version_history` stays honest.

**The Sheets are a one-time seed, not a sync.** The point is to leave the Calculator and SPIFF_Sales
Report behind entirely — this app becomes the system of record. `importCalc` exists to seed history
once; don't build features that assume re-importing. (Hand-corrected rows are stamped `edited_by` and
skipped by the importer purely as a guardrail against a stray re-run.)

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met —
the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it
out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`;
on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job
via `dev_queue` (filtered to this app) if you need its id.
