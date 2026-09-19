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
   `active` forever for a program closed since its last refresh — stale in exactly the case the
   field exists to catch. Added 2026-08-30 at Leaderboard's ask, after a closed program drew on
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

- **The record warnings are DERIVED, never stored** (2026-08-31). `duplicate_of` (the red "actuals
  match X — verify") and `rate_changed` (the amber "rate $25 → $50") are recomputed on every read in
  `annotateActuals_`, and **stripped before any write** in `programToRow_`. Don't re-add them as
  columns. They were stored once, written by the Calculator importer; when the importers were cut
  the computing code went with them and the stored values stayed, so the banner froze — correcting
  the numbers or pulling live actuals left it claiming a match that no longer existed, and Sky
  found there was no way to clear one. Derived means fixing the numbers clears it on **both**
  records at once, which a stored flag could never do: it can only clear the row you edited, leaving
  its partner still pointing at a program that no longer matches.

- **Status follows the dates, on its own** (Sky, 2026-08-31). The hourly engine trigger rolls each
  program before it sweeps: a **draft goes ACTIVE on its start date** with no human step, and an
  **active program CLOSES** once its end date has passed (inclusive — a program ending the 30th is
  still running on the 30th). Sky chose full auto-activation deliberately; nothing pays out on a
  clock, since the vendor report is still Tawny's click, so an early start costs a screen showing a
  program a day sooner, not money moving.

  Two things it deliberately will **not** do, and both are load-bearing. **Closed is terminal** — a
  typo'd `end_date` must never reopen a program whose actuals may already be on a vendor report.
  And a **draft whose window passed entirely is left alone** and reported as `stale`, because
  "drafted and never run" is a different fact from "ran and finished" and only a human knows which.
  Rows with no window are skipped.

  This matters beyond the landing page: `?action=progress&status=active` is resolved from this
  field, and **GX Crew's incentive column and the Leaderboard kiosk cards both read that route** —
  a program left active past its end date keeps drawing on kiosk cards, which is the exact failure
  `status` was added to catch. Preview a roll with `?action=rollStatuses&dry=1` (deploy-secret
  gated, writes nothing); drop `dry` to run it. Rules are pinned by `tests/status_roll_test.js`.

- **A program's window is whole pay periods** (Sky, 2026-08-31). The record panel picks a FIRST
  and a LAST pay period; start/end dates are derived from that and shown read-only. Two selects,
  not one, because a program can run longer than a fortnight — Buddies ran 2026-06-22 → 2026-07-19,
  two whole periods. **Three live records are off the grid and must stay there**: that Buddies row,
  `green-cross-2025-08-11-2025-08-17` (seven days). *(The third was the `wyld-0626` draft, a
  calendar month — deleted, see below, so **two** off-grid records remain.)*
  Two are CLOSED and were reported to the vendor against the dates they hold, so the panel warns
  and keeps them rather than snapping them onto the grid. `periodSpanOf()` is the test for "is this
  window a run of whole periods"; it refuses the half-open cases, which is how a closed program's
  window would otherwise gain a fortnight. Pinned by `tests/window_and_goal_test.js`.

- **A closed program's actuals record themselves** (Sky, 2026-09-15: "we shouldn't rely on a human to
  remember that"). Hourly, straight after the freeze, `recordMeasuredActuals_` writes `actual_json`
  from the close-out measurement (`progress_json`) with `pullActuals`' arithmetic, tagged
  `source: 'measured'`. It **never overwrites** recorded actuals (they may be on a vendor report),
  **never records a partial** measurement (a refused store is not a zero), **never records zero
  units** (usually a dead filter — logged as needing a person), and leaves stale drafts alone.
  `?action=recordActuals` runs it on demand (secret, dry by default). History shows the measurement,
  labeled "not yet recorded", for the hour before it runs. Pinned by `tests/record_actuals_test.js`
  and `tests/history_measured_test.js`.

- **Every GX app shares one 30-at-once execution ceiling — don't fan out** (2026-09-15, v1.422).
  All web apps and triggers run as sky@, and Google caps an account at 30 simultaneous executions;
  that afternoon the suite hit 114 and every app's screens queued. SPIFF's share, and the fixes:
  a signed-in call no longer re-asks GX Core about the token each time (`gxAuth_` caches a **yes
  only**, 5 min, keyed by a hash — so a removed grant or changed role takes up to 5 min to bite);
  store pulls run **`PULL_LANES` (2) at a time** via `inLanes`, never `Promise.all` over stores; a
  **running program opens on the hourly figures**, labeled with their time, and only Refresh (or a
  store the cache lacks) pulls live, up to today rather than the end date; the hourly job holds a
  **lease** so two copies can't overlap, and `diag` reports `hourlyTriggerCopies`. Pinned by
  `tests/shared_account_load_test.js`.

- **The screen opens with ONE call to this engine, not four** (2026-09-18). `start()` used to fire
  `programs`, `brands`, `progress` and `employees` as four separate reads. Apps Script serializes
  executions of one script, so they queued nose-to-tail rather than overlapping — 2.4s warm / 8.7s
  cold EACH (the comment above `listProgramsCached_`) — and each paid its own `gxAuth_` round trip
  to GX Core on top. `?action=boot` (`bootAll_` in Code.gs) answers all four from the SAME caches
  those routes already keep warm (the 5-minute programs cache, `BRANDS_CACHE_KEY`, the roster's
  15-minute cache), behind one `guard_` check. **Each part has its own try/catch** — a slow or
  broken brand list must never blank the program list a user is staring at, so a failed part comes
  back as its own `{ok:false, error}` in its own slot and the other three still arrive. The four
  solo routes are unchanged and stay live, both as the fallback for an old cached client and for
  a future one-part refresh.

  **`bootOnce()` on the client memoizes the one call** so `loadPrograms`, `loadBrandReps` and
  `loadProgressCache` (`loadRoster` too — see roster_names_test.js) all consume its slots instead
  of making their own request; whichever loader runs first in `start()`'s parallel wave is the one
  that actually fires it. **Falls back part-for-part to the solo route** if `boot` itself is missing
  or unrecognized (an engine that has not been deployed with this route yet answers "Unknown
  action" rather than throwing) — every loader below then makes the one call it always used to
  make, so an old-cached client degrades to exactly today's behavior rather than breaking.

  **Employees and brands also mirror to a 24h localStorage cache** (`BOOT_MIRROR_KEY`, same shape as
  `PG_CACHE_KEY`), painted by `paintBootMirror()` before `boot()` has even answered — a warm reopen
  shows yesterday's rep list and friendly names immediately instead of an empty section or Dutchie's
  legal names for the few seconds boot takes. Boot's real answer always replaces it. `brandCall`
  writes its own edit straight into the mirror so the next open sees it, never a stale copy.

  Pinned by `tests/engine_boot_test.js` (the server route), `tests/client_boot_fanout_test.js` (the
  three-loader fan-out) and `tests/boot_mirror_test.js` (the 24h mirror). **Deployed 2026-09-18
  (v1.440)** — the call-count and latency win was proven against a stubbed transport before that;
  see the hedging bullet right below for what live traffic actually showed once it shipped.

  **The next lever, not built here**: opening a single PROGRAM is still N stores × M windows of
  live Dutchie pulls (`loadProgress`, spiff.js `async function loadProgress`) — the same shape the
  boot reads used to have, one level down. Left alone this time because the ask was the four-call
  *open*, not this.

- **A dropped `boot` reply cost a full minute, not a retry — fixed by hedging this engine's OWN
  reads** (2026-09-18, v1.440). Apps Script's `/exec` silently drops a few percent of JSONP
  responses on its first hop (gx-client.js's `HEDGE_MS` comment has the numbers); the shared client
  answers that by firing one extra copy of a READ that has gone quiet for 6s and taking whichever
  lands first — but only for an action named in the client's `hedgeReads`, and `ENG = GXClient(ENGINE)`
  carried none: with no `defaults.hedgeReads`, it silently inherited gx-client's DEFAULT list, which
  is **GX Core's** route names (`health`, `stores`, `config`, …) — none of which this engine answers.
  So `boot` never hedged, and a dropped first copy waited out the whole 45s attempt before the retry
  fired — measured live as Sky's ~1-minute landing page on a quiet afternoon (execution load was
  nowhere near the 30-at-once ceiling; this was a silent drop, not a queue).

  `ENG` now hedges its own read routes: `var ENG = GXClient(ENGINE, { hedgeReads: ENGINE_HEDGE_READS });`,
  with `ENGINE_HEDGE_READS` (spiff.js, above `ENG`) naming `boot`, `programs`, `program`, `brands`,
  `progress`, `employees`, `catalog`, `sellthrough`, `storeView`, `storeLinks`, `refunits` and
  `emailDraft` — every one checked against its own handler in `apps-script/Code.gs`, not copied from
  `index.html`'s `GX_DEV_READS` (which lists actions, like `config`/`version_history`/`productStats`,
  this engine does not even implement). **A hedged write runs twice** — the losing JSONP copy is
  never canceled, so hedging one of this engine's mutating actions (`editProgram`, `deleteProgram`,
  `saveBrand`, `publishToCore`, …) would fire it twice on a slow network. `bootOnce`'s budget was
  also cut from `{timeoutMs:45000, retries:1}` to `{timeoutMs:20000, retries:2}` (cold start measures
  ~9s; 20s clears it with room, and the extra retry covers a call that misses both hedge copies), and
  the `brands` fallback call in `loadBrandReps` got the same cut. `bootOnce` now logs
  `console.info('[spiff] boot answered in Ns')` on success and `console.warn` past 15s or on
  fallback, so the next slow open says why in the console instead of just being slow.

  Pinned by `tests/boot_hedge_test.js` — asserts `boot` and its boot-composed reads are hedgeable,
  that every hedged name is both a real Code.gs action and on a hand-vetted pure-read list, that
  none of ~30 known write/session-mint actions ever appear in the hedge list (spot-checked by name),
  and that `bootOnce`'s actual call-site budget is ≤20s / ≥2 retries / ≥2× the 6s hedge delay.

- **The per-budtender goal is pinnable per store**, and an empty pin is not a zero. The Calculator
  splits the typed target by last month's volume; typing over one store's number pins it and leaves
  the others tracking the target. Clearing the box means *back to the split* — running it through
  `Number(x) || 0` like the other cells would turn a cleared field into a store told to sell
  nothing, which the chain total absorbs silently. A typed `0` IS honored: sitting a store out is a
  real choice.

- **An orphaned progress row is never payable** (2026-08-31). A cached `spiff_progress` row whose
  `program_id` is gone from `programs` is counted in `orphan_rows` and named in
  `orphan_program_ids`, and kept out of both `rows` and `by_employee`. It cost real money once: 25
  BeGOAT rows keyed to the pre-seed `begoat-0826` carried $350 of `earned`, and since Crew reads
  this route unfiltered, fourteen people showed as owed $25 for a fortnight already paid. The
  converse is guarded too — an **empty** programs tab makes every row look orphaned, so that
  refuses rather than answering with silence shaped like zero.

- **Orphaned cache rows are swept, not left as a standing exclusion** (2026-09-06). The 26 rows
  that predated the delete route — 25 under `begoat-0826`, plus one with no `program_id` — were
  removed by `?action=sweepOrphanProgress` (deploy-secret gated, **dry by default**, `apply=1` to
  write, and what it removes is copied to a `swept_progress_rows` tab first). They were already
  kept out of `rows` and `by_employee`, so nothing was wrong; a permanent exclusion every
  consumer must remember is the trap. **It calls a row orphaned only when its `program_id` is
  absent from `programs`** — deliberately stricter than `spiffProgress_`, which drops a row when
  its resolved status is empty and so also catches a program that exists with a blank status
  cell. That is recoverable in a response and not in a delete. Same empty-programs refusal as the
  read path, and it matters more here. Pinned by `tests/orphan_sweep_test.js`.

- **Never delete a program by deleting its row** (2026-09-06). Use the Delete section in the
  record panel, or `?action=deleteProgram` — a program is not one row. Its measurements live in
  `spiff_progress` keyed on `program_id`, and `?action=progress` is read by GX Crew's incentive
  column and the Leaderboard kiosks, so pulling the `programs` row by hand strands every one of
  them as an orphan still carrying `earned` dollars. That is the BeGOAT failure above,
  manufactured on purpose. The route unfiles the program, drops its measurements and clears the
  cache together, and copies the row to a **`deleted_programs`** tab (with who and when) before
  removing it, so a wrong delete is recoverable. **A CLOSED program is refused** — it was
  reported to the vendor and paid, so it stays in History; draft and active are deletable. The
  confirmation is the typed program name, checked server-side, because writes ride on GET here
  and a URL gets pasted and re-fetched. A deploy secret alone cannot delete: the handler wants a
  real session. Pinned by `tests/delete_program_test.js`.

- **Payout model.** Most programs are **flat**: a fixed dollar bounty to each budtender who hits their
  individual target (`SPIFF $25 × 17 BTs = $425`). But **`per_unit` is real and implemented** — Hapy
  Kitchen (2.16–3.1.26) paid "$1 for every unit sold", with "Unit Based"/"You Decide" where the goals
  normally sit. The Calculator flattened it, which is why the imported history looked uniformly flat;
  the SPIF docs show the truth. `tiered` remains schema'd and unimplemented. Read the payout model off
  the doc rather than assuming.
- **Cost, not payout, is where programs vary.** Multi-SKU programs blend it — the sheet's
  `Combined WS Cost` / `Average Cost` / `Combined Total for 20pc & 2pc`. `cost_json` supports
  `flat` and `blended`.
- **Brand reps live in GX Core's shared brand registry, not on the program** (Sky, 2026-09-14/15;
  GXCore v330). `brands` + `brand_contacts`, keyed by **brand** — Sky chose that over a
  vendor/distributor layer. SPIFF edits reps on the program screen (`saveBrandContact`,
  `removeBrandContact`, `addBrand` — editor session, stamped `by` the signed-in user) and Core is the
  only writer. Inventory is a named consumer.

  **The vendor sign-in reads it.** `clientView_` lets in any **active rep on an active brand**, with
  the brand resolved by `GXCore.resolveBrand` from `match_json.brand` (else `vendor`). The old
  per-program `contact_email` opens **nothing** now, and `contact_name` / `contact_email` are out of
  `EDITABLE_FIELDS` — the columns stay because names are names. Removing a rep is soft in Core and
  closes their access at once.

  **Core's library read is slow** — `getBrands` measured 6–30s. The engine caches it **for the screen
  only**: the hourly trigger re-reads it (`warmBrandsCache_`, 65-minute cache), and SPIFF's own writes
  **patch** the cached list from Core's answer (`applyBrandWrite_`, mirrored by `applyBrandWrite` in
  the browser) instead of re-reading it — the re-read made every add sit for half a minute. An edit
  made outside SPIFF can take up to an hour to show. The sign-in never reads that cache, or a removed
  rep would keep access. Contact emails are half of a rep's login, so no route hands
  the list to an anonymous caller.

  **Settings holds the brand directory** (Sky, 2026-09-15): every brand, searchable by brand or rep,
  with reps and website / notes / other spellings editable (`saveBrand`). It deliberately cannot
  rename a brand or turn one off — a program finds its brand by name, and turning a brand off locks
  out all its reps; both are rare enough to do on purpose, not from a list.

  **Settings has two doors, one per context** (Sky, 2026-09-15). Standalone it is the chip menu's
  Settings row; **nested in Inventory** the shared theme hides the whole user tray, so a
  `data-gx-embed-only` gear at the end of SPIFF's own tab bar replaces it (the suite's outline gear). Same dialog,
  same editor-only rule as the menu. Tawny works through Inventory, so without it she had no way in.
  Pinned by `tests/nested_settings_test.js`.

  **Its search autocompletes** (Sky, 2026-09-15): brands in the list, reps by name or email, and
  every brand Dutchie has **in stock** that is not in the list yet, added in **Dutchie's spelling**.
  A name Dutchie does not carry can still be added and says so. The Dutchie list is the Calculator
  picker's `catalog` cache, not a second fetch.

  The 16 brands SPIFF had run programs on were seeded with no reps by `?action=seedBrands`
  (secret-gated, dry by default, skips anything Core already resolves). Pinned by
  `tests/brand_contacts_test.js`.
- **A test RUNS the code, or says why it cannot** (2026-09-15, Sky's "flip the test ratio").
  `tests/_gas.js` is the shared harness — it lifts a function out of `Code.gs` by name and runs it
  with the sheet, the clock and GX Core stubbed at the edges, so what executes is the shipped path
  rather than a restatement of it. The five money routes (rename, delete, orphan sweep, publish to
  Core, the three vendor close-out documents) now run for real; `progress_cache`, `payout_math`,
  `status_roll` and `window_and_goal` always did. **A source-text check is still right for two
  things**: an architecture guard with no other enforcement (this field is not editable, this route
  is not on the secret-only list, nothing calls a function that no longer exists), and screen
  markup and click wiring, which cannot run here — mark those in the file rather than replacing them
  with a regex that looks like coverage. What a regex must never stand in for is a number, an
  ordering of writes, or a refusal: `indexOf(a) < indexOf(b)` on source text is equally true of a
  route that moves the rows first and one whose loop never matches a row.

  **The rule is a ratchet, not a memo** (2026-09-15). `tests/suite_shape_test.js` fails if a test
  file neither runs code nor carries a `SOURCE-SHAPED:` line in its header saying why it cannot.
  Six files are declared: the static analyzer, the cache-invalidation scan (whose claim is about
  writers nobody has written yet), and four that are markup, browser painting or call counting.
  Writing a regex will always be faster than building a harness, so the marker is what makes
  choosing one a decision somebody wrote down rather than the path of least resistance.

- **A bug report carries its screenshot** (2026-09-15, v1.424). The browser uploads the image to
  Drive on its own call and puts the url on the payload as `screenshot_url`; `reportBug_` forwards
  a NAMED list of fields to `GXCore.gxIngestBug`, and until v1.424 that list did not include it —
  so the upload succeeded, the url arrived, and the board showed a report with no picture. Found by
  core-admin across the suite: 140 reports, seven apps, not one image. Add a field to the payload
  and it must be added to that list too; pinned by `tests/bug_report_test.js`.

- **SPIFF reads the roster, never writes it.** `employees` and `stores` come from GX Core; don't
  re-hardcode store names — Command Center edits must flow through on the next load.
- **SPIFF PUBLISHES TO CORE NOW — the write contract exists as of 2026-09-08 (v1.374).** After every
  hourly refresh SPIFF pushes its finished per-employee sell-through and payout into GX Core's
  **`spiff_publications`** tab, one publication per pay period, via
  `GXCore.publishSpiffProgress(secret, scope, payload)`. Leaderboard and Crew read it back with
  `publishedSpiffProgress` / `?action=published_spiff_progress` instead of calling this engine's
  `/exec`. That is **step 2 of 4** in the hub's `GX_CONSOLIDATION_MAP.md`; steps 3 and 4 are
  Leaderboard deleting its `spiff.gs` and Crew reading Core on the incentive screen. **Requires
  GXCore v306** — the routes exist only in that snapshot.

  **SPIFF still owns the numbers.** Core stores the payload verbatim and recomputes nothing; the
  vendor is paid SPIFF's figure, and a second computation would be a second answer. The payload is
  the same shape `?action=progress` already served, deliberately, so a consumer changes its source
  and not its parser.

  **THE PUBLICATION IS THE CONSUMER, NOT `storeView` — check the pipe, not the route** (2026-09-17).
  Leaderboard's kiosk panel and Crew's incentive column read the PUBLICATION. `storeView` is the
  kiosk *page's* own route and is nobody else's source. This was got wrong twice in one week: a
  field was added to `storeView`, the work was reported done, and the consumer could not see it —
  after the same confusion had already happened over the program sidecar. Leaderboard found both by
  reading this repo's source instead of taking the answer. **Before telling another app a field is
  available, grep for what THEY call**, not for what the field is on.

  `last_programs` is the field that came out of it: a per-store map on every published scope,
  `last_programs[store_id]` → `{vendor, program_name, end_date, store_pct?}`, for the kiosk's
  "nothing running" chip. It is deliberately **not** on `?action=progress` — that route takes
  `pay_period` / `program` / `status` filters and a map computed from a filtered slice is quietly
  wrong rather than absent, which is worse than the broken "same keys" promise. A store appears only
  when nothing is running there, and `programRunsAt_` is shared by both pipes so the two can never
  disagree about what that means. Pinned by `tests/publish_to_core_test.js`.

  **Two things that bite.** The new failure mode is **silent staleness** — nothing throws if
  publishing stops, the payload just ages — so every read must check `age_minutes`. And the
  **`pay_period` column is unusable as a scope**: live rows hold `"2026-08-17 - 2026-08-30"` (a
  range) and `"2026-09-18"` (a date after its own window), despite a schema comment claiming
  `YYYY-MM-DD`. The scope is **derived** from the program's `start_date` against
  `cfg.payPeriodAnchor` (read via `GXCore.getKv` — there is no `getConfig()`). The column is left
  alone on purpose.

  **The documented exception:** Crew's `incentiveApprove_` and `incentiveSend_` keep reading SPIFF
  **live**, because they freeze vendor money into `crew_incentive_history` where it can never be
  recomputed — a stale figure frozen there is silent and permanent, where a live read that fails is
  loud and recoverable in front of the person who just clicked Approve. Not an oversight to tidy.

  Publish on demand with `?action=publishToCore` (deploy-secret gated, **dry by default**,
  `apply=1` to write).

  *Superseded the note below, kept because the lesson stands:*
- **SPIFF once had a cross-app write contract that did not exist.** *Corrected 2026-08-25: this bullet used to say "SPIFF
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

**The Drive importers are GONE — cut 2026-08-30. This app is the system of record.** There is no
longer any code that reads the Calculator sheet or Tawny's SPIF docs; the `importCalc`,
`previewCalc`, `importDocs`, `previewDocs`, `seedDocs` and `seedCleanup` routes, the
"Import from Calculator sheet" button, and the whole `.docx` parser were removed together the day
the seed finished.

**What the seed did, once.** All 113 SPIF docs became 23 `programs` rows carrying their REAL
windows and real per-budtender goals. The 21 Calculator-era rows they replaced had their cost,
baseline and reconciled actuals merged forward onto the corrected window and were then deleted.
`programs` ended at **25 rows**: those 23, plus `wyld-0626` (a Calculator program with no doc — the
docs were never a superset) and one row this file called "Sky's test row".

*`wyld-0626` IS GONE (confirmed 2026-09-09).* Sky: "wyld 10pc was never real, delete it." It was
already absent — the engine answers `not found: wyld-0626` — so it was deleted at some point after
`?action=deleteProgram` shipped on 2026-09-06, which was built for this program specifically ("Wyld
10pc is a draft"). Exactly when and by whom is in the engine sheet's `deleted_programs` tab; there
is no route to read that, so this file does not guess. It had no cached progress rows, so nothing
was stranded. `programs` still reads 25 because two rows were added since — the Hellavated draft
and the second Portland Heights.

**It is still listed as one of four programs to reconcile** in `bug_mtkt4a4l_bpor` and its brain
note. That scope is now **three**: Drops, Buddies and Freshy. core-admin has been told.

*Corrected 2026-09-08: `green-cross-test-202608` was NOT a test row.* It is the real Portland
Heights fortnight — Aug 17 → Aug 30, 242 units, $181.50 paid, closed and reported to the vendor. It
carried a test-shaped id because ids are minted from `program_name` at creation
(`slug_(name) + YYYYMM`) and never change, and it was created while named "Green Cross test". Sky
asked for the id to say what the program is, and it is now
**`portland-heights-2026-08-17-2026-08-30`**, matching how the other windowed programs are keyed.

**Re-key through `?action=renameProgramId`, never by editing the cell.** `program_id` is a foreign
key: `spiff_progress` keys every measurement row on it, `?action=progress` drops any cached row
whose program is missing from `programs`, and Crew's incentive column, the Leaderboard kiosks and
Core's published payload all read that. Editing the cell alone would have stranded 38 rows carrying
$181.50 — the BeGOAT failure exactly. The route moves the measurements first, then the row, then
republishes to Core, tombstones the old row to `deleted_programs`, refuses an id already in use,
wants a real session plus the program name typed back, and is dry by default. A **closed** program
IS renameable, unlike deletable: a delete removes money that was reported and paid, a rename moves
the same money to a key that tells the truth.

Two gaps it could not fill, both known and neither a bug: `green-cross-2025-08-11-2025-08-17` is a
real program Sky confirmed, but the Calculator never held it, so it has goals and **no
`actual_json`** — no units sold, no ROI. *Sky, 2026-09-15: leave it as is.* Its close-out measurement
found 0 units (a filter that matches nothing), so the hourly actuals recording logs it as "needs a
person" every run — that line is expected, not a new problem.
`hapy-kitchen` states "Unit Based" / "You Decide" where goals go, so it kept the Calculator's
targets; its `per_unit` $1/unit payout came off the doc correctly.

**Do not rebuild an importer.** Every Calculator-era row is gone, so re-running one would not top
History up — it would add a second, worse copy beside the good one, keyed differently and windowed
by calendar month. The last revision that still had all the machinery is commit `db7a4c5`
(`git show db7a4c5:apps-script/Code.gs`, shipped as v1.322) — seed map included.

*Three of Tawny's filenames carry date typos (`Mule … 9.1326`, and both the River and South
Hellavated docs, where River's typo is in the body too). The parser read them anyway before it was
removed, so nothing was lost — noted only so a future reader doesn't go hunting for missing docs.*

**Leftover:** the `SPIF_DOC_INDEX` script property is now orphaned. Harmless, deletable from
Project Settings whenever.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met —
the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it
out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`;
on merge → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.


## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken, not because it was theorized.

On 2026-09-02 a spoke session made a small, correct, tested fix to GX Core and put it on a branch for
Sky to merge, because Core library cuts are PR-gated. **Another Claude session had the same repo open
at the same time.** These repos are Dropbox-synced, so the two sessions shared one working tree and
one HEAD: the branch was switched out from under the first session, its commit landed on `main`
instead, and the other session pushed `main` and shipped it. The change went out as library v284 with
no PR and no review. The code was fine — that is the point. Nothing failed, nothing warned, and the
gate on the highest-stakes repo in the suite simply was not there that time.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from SPIFF: `add_note` to `core-admin` with what you need and why, and stop.** Requests are welcome
and quick, and the hub session holds the repo alone while it works.

**Where the line is, because over-applying this is its own failure:**

- **Reading the hub is fine and often necessary** — `gx_core.gs` is the source of truth for every
  route SPIFF calls, and guessing a payload shape instead of reading it is how this suite invented a
  `spiff_payouts` tab that never existed. Read freely; run `./gxpins.sh`; diff against it.
- **Calling GX Core's HTTP routes is not editing it.** `deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note` and the rest are the documented interface, secret-gated and
  designed for exactly this. Changing a *setting* through `set_config` is a config change SPIFF owns;
  changing *code* is not.
- **Do not restyle a shared component from inside SPIFF either.** A local rule that beats `.gx-btn-green`
  wins here and silently diverges from the other five — that is how the suite ended up with six
  different login screens. The test is *"should all six get this?"*
- **SPIFF's own engine and repo are still yours.** `clasp push` / `./deploy.sh` here touch only this app.
