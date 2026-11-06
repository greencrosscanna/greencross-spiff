# SPIFF (app key `spiff`) — GX app · Inventory sub-app

Part of the Green Cross app suite, and a **sub-app of Inventory** (embedded as a tab, same pattern as
Price Cards). GX Core (the GX Command Center) is the shared brain. Frontend: `index.html` + `spiff.js` +
`spiff.css` (GitHub Pages); backend: `apps-script/Code.gs` (clasp). App key in GX Core: **`spiff`**.

> **This file is rules only.** How each rule was learned — the incidents, the dollar amounts, the
> corrections — is in **`docs/claude-md-history.md`**, the full pre-2026-10-09 text of this file, frozen.
> **Read the history passage a rule points to before changing code that rule guards.** Each rule ends
> with `Hist:` naming the history heading and the words to search for. If the two files disagree,
> this one wins.

## What this app is

Tawny owns the SPIFF program: she works with vendors to set goals, monitors staff sell-through, and sends
the vendor a report — the vendor credits us against the next buy, and we turn that into gift cards for the
budtenders who hit their numbers. Four surfaces, one spine:

1. **Calculator** — the live vendor ROI model; cost, investment, ROI and per-store/per-budtender targets
   recompute instantly. It is a **sales tool** as much as a form: Tawny presents it to the vendor.
2. **Progress** — the budtender matrix (units by budtender by store vs. target), fed straight from
   Dutchie. Published as `?action=progress` (token-gated) off the `spiff_progress` cache, which an
   hourly trigger refreshes. Every row carries **`status`** (draft | active | closed); `&status=active`
   filters server-side, which trims `by_employee` totals too. `status` is **resolved at read time**
   from the `programs` tab, **never stored on the cached row** — the cache is a snapshot and the hourly
   sweep is active-only, so a stored column would read `active` forever for a program closed since
   its last refresh.
3. **Reports** — close-out: vendor PDF saved to Drive, a **drafted** vendor email for a human to send,
   and a gift-card buy list for staff payouts.
4. **History** — every closed program by pay period.

Hist: § What this app is.

**Program identity.** Programs group by **vendor + window**, not title — the same program is named
differently store to store. **"South" is the old name for the Commercial St store.** Tawny's **SPIF
program docs** in Drive (one `.docx` per store per program, named
`<Store> - <Program> - <M.D.YY>-<M.D.YY>.docx`, in
[Current SPIF / Archived SPIF](https://drive.google.com/drive/folders/1ux44BjJf9PDUFbIaecnmFOwZDy4LTQVa))
are authoritative for the exact program window (filename) and the real per-budtender goal (body).
They were seeded once and nothing reads them now; **this app is the system of record** (see "The
Drive importers are GONE" below). Vendor close-outs land in
[this Drive folder](https://drive.google.com/drive/folders/1c8Yj23OkEusskHylLKYzHsqPYIgAHP1t)
(format precedent: `SPIFF_Sales Report - Gron - 092925.pdf`). Hist: § The source of truth; § What it
replaces (links to the two retired spreadsheets).

## The engine

Its own Apps Script project, bound to the **GX SPIFF Engine** spreadsheet (that sheet is the datastore —
the `programs` tab holds one row per program).

| | |
|---|---|
| `/exec` | `https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec` |
| script id | `1RZw4VDq06d-gdZT1RYpIDOhS9TcrzZ6qJGlTR692O15FZaAg1mKlCor-` (in `.clasp.json`) |
| datastore | sheet `1IXtgygVInEOak83RRC81bAUvr_zukdT0GJOLaqzuT44` — lives in **[GX2 Dashboard](https://drive.google.com/drive/folders/1BXH5SrK9dWupl-w1UW5Bjt5oSORednLD)** |
| ship | commit, then `./gxengine.sh --deploy` — **update**, never create, so `/exec` holds |
| run (frontend) | `python3 serve.py` → <http://localhost:8754> — no build step, the working tree IS the app |
| tests | `tests/*_test.js`, each run with `node` |

- **Ship the engine with `./gxengine.sh --deploy`, after committing.** It pushes, redeploys the
  deployment id this repo's own source points at, and records the sha to `core_pins`; it refuses
  uncommitted tracked changes and never creates a deployment. Bare `./gxengine.sh` is a dry run.
  **Never the raw clasp trio, never a new deployment id** — a new one mints a fresh `/exec` and
  orphans every caller. Then bump `?v=` and run `./deploy.sh`.
- The dev server talks to the **live** engine; `gx-dev.js` blocks writes until you arm them, and
  `gx-preflight.sh` runs as a **pre-push hook** refusing dev leftovers (fixtures on, writes armed,
  localhost URLs, `@devonly` blocks).
- **Writes ride on GET.** The browser calls the engine cross-origin via JSONP and Apps Script serves no
  CORS headers for POST, so mutating actions are exposed on `doGet` too. Same pattern as GX Core.
- **Every file this app creates in Drive belongs in GX2 Dashboard** — datastores, engine-bound sheets,
  anything an app owns. `clasp create-script --type sheets` drops the new spreadsheet at Drive
  **root**, so it must be moved after creation. Business documents are the exception: vendor
  close-out PDFs stay in the **SPIFF Reports** folder under **Incentive Program**, where the business
  already keeps them and Tawny expects to find them.
- **Script properties this engine needs** (Project Settings → Script Properties; never in the repo):
  `GX_DEPLOY_SECRET` (calls GX Core's secret-gated
  `sales_by_employee` for Progress). `BRAND_EMAIL_FROM` is optional (see the vendor-send rule).
  **Editor saves can fail silently** (2026-11-02): the editor saves every property in one call, and
  one value over Apps Script's 9 KB cap (the orphaned 14 KB `SPIF_DOC_INDEX`) made `WIX_PUBLISH_ON`
  and `CAL_SYNC_ON` never stick. Check the store with `?action=propsReport` (secret; names and sizes
  only), set the on/off switches with `?action=setSwitch` (secret, dry unless `apply=1`, reads back),
  and remove a listed orphan with `?action=deleteOrphanProp`. Pinned by `tests/props_store_test.js`.
- **After any scope change**, open the script editor and run `authorize()` once — the web app returns
  Google's consent HTML instead of JSON until the owner has authorized.

Hist: § The engine.

## The rules that matter

Every `Hist:` in this section is under history § "The rules that matter" unless it says otherwise.

### Program records

- **The record warnings are DERIVED, never stored** (2026-08-31). `duplicate_of` (the red "actuals
  match X — verify") and `rate_changed` (the amber "rate $25 → $50") are recomputed on every read in
  `annotateActuals_`, and **stripped before any write** in `programToRow_`. Don't re-add them as
  columns. Why: a stored flag froze, and can only clear the row you edited — derived clears it on
  **both** records at once. Hist: "The record warnings are DERIVED".

- **Status follows the dates, on its own** (Sky, 2026-08-31). The hourly engine trigger rolls each
  program before it sweeps: a **draft goes ACTIVE on its start date** with no human step, and an
  **active program CLOSES** once its end date has passed (inclusive — a program ending the 30th is
  still running on the 30th). Sky chose full auto-activation deliberately; nothing pays out on a
  clock, since the vendor report is still Tawny's click.
  Two things it deliberately will **not** do, and both are load-bearing. **Closed is terminal** — a
  typo'd `end_date` must never reopen a program whose actuals may already be on a vendor report.
  And a **draft whose window passed entirely is left alone** and reported as `stale`, because
  "drafted and never run" is a different fact from "ran and finished" and only a human knows which.
  Rows with no window are skipped. **A draft with no payout stays a draft** and is reported as
  `no_payout` (Sky, 2026-11-01): locking in a penciled brand makes a $0 draft, which must not reach
  kiosk cards. It goes active on the first hourly run after a payout is set, even past its start date.
  `?action=progress&status=active` is resolved from this field, and **GX Crew's incentive column and
  the Leaderboard kiosk cards both read that route** — a program left active past its end date keeps
  drawing on kiosk cards. Preview a roll with `?action=rollStatuses&dry=1` (deploy-secret gated,
  writes nothing); drop `dry` to run it. Pinned by `tests/status_roll_test.js`.
  Hist: "Status follows the dates".

- **A program's window is whole pay periods** (Sky, 2026-08-31). The record panel picks a FIRST
  and a LAST pay period; start/end dates are derived from that and shown read-only. Two selects,
  not one, because a program can run longer than a fortnight. **Two live records are off the grid
  and must stay there**: Buddies (2026-06-22 → 2026-07-19, two whole periods) and
  `green-cross-2025-08-11-2025-08-17` (seven days). They are CLOSED and were reported to the vendor against the dates they hold, so the panel warns
  and keeps them rather than snapping them onto the grid. `periodSpanOf()` is the test for "is this
  window a run of whole periods"; it refuses the half-open cases, which is how a closed program's
  window would otherwise gain a fortnight. Pinned by `tests/window_and_goal_test.js`.
  Hist: "A program's window is whole pay periods".

- **A closed program's actuals record themselves** (Sky, 2026-09-15: "we shouldn't rely on a human to
  remember that"). Hourly, straight after the freeze, `recordMeasuredActuals_` writes `actual_json`
  from the close-out measurement (`progress_json`) with `pullActuals`' arithmetic, tagged
  `source: 'measured'`. It **never overwrites** recorded actuals (they may be on a vendor report),
  **never records a partial** measurement (a refused store is not a zero), **never records zero
  units** (usually a dead filter — logged as needing a person), and leaves stale drafts alone.
  `?action=recordActuals` runs it on demand (secret, dry by default). History shows the measurement,
  labeled "not yet recorded", for the hour before it runs. Pinned by `tests/record_actuals_test.js`
  and `tests/history_measured_test.js`. Hist: "A closed program's actuals record themselves".

- **The per-budtender goal is pinnable per store**, and an empty pin is not a zero. The Calculator
  splits the typed target by last month's volume; typing over one store's number pins it and leaves
  the others tracking the target. Clearing the box means *back to the split* — running it through
  `Number(x) || 0` like the other cells would turn a cleared field into a store told to sell
  nothing, which the chain total absorbs silently. A typed `0` IS honored: sitting a store out is a
  real choice. Hist: "The per-budtender goal is pinnable per store".

- **Never delete a program by deleting its row** (2026-09-06). Use the Delete section in the
  record panel, or `?action=deleteProgram` — a program is not one row. Its measurements live in
  `spiff_progress` keyed on `program_id`, and `?action=progress` is read by GX Crew's incentive
  column and the Leaderboard kiosks, so pulling the `programs` row by hand strands every one of
  them as an orphan still carrying `earned` dollars. The route unfiles the program, drops its
  measurements and clears the cache together, and copies the row to a **`deleted_programs`** tab
  (with who and when) before removing it, so a wrong delete is recoverable. **A CLOSED program is
  refused** — it was reported to the vendor and paid, so it stays in History; draft and active are
  deletable. The confirmation is the typed program name, checked server-side, because writes ride
  on GET here and a URL gets pasted and re-fetched. A deploy secret alone cannot delete: the handler
  wants a real session. There is no route to read `deleted_programs`.
  Pinned by `tests/delete_program_test.js`. Hist: "Never delete a program by deleting its row".

- **Re-key through `?action=renameProgramId`, never by editing the cell.** `program_id` is a foreign
  key: `spiff_progress` keys every measurement row on it, `?action=progress` drops any cached row
  whose program is missing from `programs`, and Crew's incentive column, the Leaderboard kiosks and
  Core's published payload all read that. Ids are minted from `program_name` at creation
  (`slug_(name) + YYYYMM`) and never change. When a DIFFERENT vendor already holds that id, the new
  program gets `slug_(vendor)-` in front; the same vendor and name in one month is refused
  (`code: 'name_taken'`). Pinned by `tests/create_program_replay_test.js`. The route moves the measurements first,
  then the row, then republishes to Core, tombstones the old row to `deleted_programs`, refuses an
  id already in use, wants a real session plus the program name typed back, and is dry by default.
  A **closed** program IS renameable, unlike deletable: a delete removes money that was reported and
  paid, a rename moves the same money to a key that tells the truth.
  *`green-cross-test-202608` was NOT a test row* — it is the real Portland Heights fortnight, now
  **`portland-heights-2026-08-17-2026-08-30`**. Pinned by `tests/rename_program_id_test.js`.
  Hist: § Sync with the brain → "Re-key through".

- **An orphaned progress row is never payable** (2026-08-31). A cached `spiff_progress` row whose
  `program_id` is gone from `programs` is counted in `orphan_rows` and named in
  `orphan_program_ids`, and kept out of both `rows` and `by_employee`. Why: it cost real money once
  ($350 of `earned` shown as owed for a fortnight already paid, because Crew reads this route
  unfiltered). The converse is guarded too — an **empty** programs tab makes every row look
  orphaned, so that refuses rather than answering with silence shaped like zero.
  Hist: "An orphaned progress row is never payable".

- **Orphaned cache rows are swept, not left as a standing exclusion** (2026-09-06).
  `?action=sweepOrphanProgress` is deploy-secret gated, **dry by default**, `apply=1` to write, and
  what it removes is copied to a `swept_progress_rows` tab first. A permanent exclusion every
  consumer must remember is the trap. **It calls a row orphaned only when its `program_id` is
  absent from `programs`** — deliberately stricter than `spiffProgress_`, which drops a row when
  its resolved status is empty and so also catches a program that exists with a blank status
  cell. That is recoverable in a response and not in a delete. Same empty-programs refusal as the
  read path, and it matters more here. Pinned by `tests/orphan_sweep_test.js`.
  Hist: "Orphaned cache rows are swept".

- **Marketing is hidden behind one switch, and stores only what a person decided** (SPIFF 2.0, phase 1,
  Sky 2026-11-01; plan in `docs/plans/marketing-section.md`). `marketing.js` holds the menu and the
  rules; `VISIBLE_TO_EVERYONE` / `PREVIEW_USERS` at its top decide who sees anything, and only Sky, Mike and Tawny do
  until he approves the flip, plus `gx-dev`, the read-only dev viewer from `gxdevlogin.sh` (Sky,
  2026-11-06), so a session can check the section signed in; it cannot save anything. That is a curtain: `editProgram_`'s role check protects the save.
  **Task ids are the stored key**: reword a task freely, never rename its id, or its ticks are orphaned.
  Tasks, due dates, overdue and compliance are computed on read; `normalizeMarketing_` builds the
  `marketing_json` cell from a list of what may be kept, so nothing derived gets frozen. **Saves send
  only what changed** (`marketing_delta` through `editProgram`), because a whole plan can pass the
  ~10,000-character URL limit the live engine has; `applyOps` and `applyMarketingDelta_` must stay
  twins. **Nothing that pays anybody reads this column.** Before adding another column to `programs`:
  `migrateHeaders_` grows the grid and adds a trailing column in place. A tab past its grid throws, and
  `dataSheet_` runs on every read, so a mistake there stops every route and the hourly job. Pinned by
  `tests/marketing_tasks_test.js`, `tests/marketing_json_test.js` and
  `tests/marketing_pay_isolation_test.js`.
  **Phase 2 (2026-11-01): Calendar, Tasks and Deals page are views of the Programs panel, and brands
  can be penciled.** Since v2.011 (Sky, 2026-11-05) their buttons sit in the TOP BAR (`#mkViewSeg`
  inside `#tabs`, no `data-tab`, so showTab never treats them as places); Programs is the List view,
  and `mkLightNav` decides which top-bar button is lit. A pencil is brand + whole pay periods + note, in its **own `pencils` tab, never in
  `programs`**, because the hourly job turns a draft ACTIVE on its start date and active programs
  reach kiosks and pay. Nothing that pays, publishes or feeds a kiosk may read that tab; the
  isolation test pins it. Rows are never deleted (`status` is penciled / locked / released). A pencil
  whose start has passed stays penciled and says so. **Lock it in** goes through `createProgram_`
  and makes a DRAFT with a zero payout; no pencil route goes on `ENGINE_HEDGE_READS`. Pinned by
  `tests/pencils_engine_test.js` and `tests/marketing_calendar_test.js`.
  **Vendor days are a list** (Sky, 2026-11-02: Gron ran five): `marketing_json.vdays` =
  `[{store, date, time}]`, empty store = every store. Each dated day draws a one-day marker on the
  Calendar and its own "Vendor day held" tick (`vday.held@store`, `.2` for a second day at that
  store, keyed in LIST order so editing a date never moves a tick). A plan saved earlier holds one
  day in `d.vday`; it is read as a one-row list and retired on the first edit.
  **Items can carry their own list** (Sky, 2026-11-02): `marketing_json.rows[item]` =
  `[{date, text, stores}]` — social post dates (one "Publish posts" tick per date, keyed on the date),
  signs (text), featured cases (text + the stores that have that case; case tasks go only to those
  stores). The vendor files link is `d.files.url`, internal only. Cards show no compliance note —
  Sky's workflows carry those guardrails; `c` stays on each item as the record. The incentive has
  no Details card.
  **A task can be handed to Tawny, Mike or Sky — those three only** (Sky, 2026-11-02).
  `marketing_json.own` = `{task_id: person}`; picking the default owner clears it. After the save
  lands, `?action=marketingAssign` emails that person. It sends only if the STORED owner is them,
  never to someone who took the task themselves, and once per hand-off (`mktassigned:` property).
  Addresses are fixed in `MKT_PEOPLE_` (mirrored by `PEOPLE` in marketing.js), never read from the request.
  Pinned by `tests/marketing_vendor_plan_test.js` section 7 and `tests/marketing_tasks_test.js` section 12.
  **Email and text blasts follow the real cycle** (Sky, 2026-11-02; send day = Monday): Tawny
  locks the deal when its terms are set (`blast.deal`, -14; moved 2026-11-05) and hands final
  details to Mike Wednesday (`blast.handoff`, -5), Mike has copy and the Dutchie draft Thursday
  (`blast.copy`, -4), Mike's proof tasks (`email.review`, `sms.approve`, -3) are ticked when Sky
  approves at the Friday L10 (backup approver: Tawny) — Sky approves all customer copy. The one
  task Sky owns by default is the program's `core.gonogo` at that same L10.
  The three `blast.*` tasks come once however many channels are picked.
  **The Dutchie campaign name is computed, never stored** (Sky, 2026-11-05;
  `_handoffs/spiff-blast-name-at-lock.md`): `YYYY-MM-DD | SPIFF|PROMO | Who | Hook [stores] [SMS|Email]`
  from the earliest send date, the program's stores, the channels and `d.blast.hook` (the one stored
  piece, typed on `blast.deal`; a holiday keeps it too via `holidayPlan_`). Shown with Copy on
  `blast.copy`. No Dutchie integration, on purpose. Pinned by `tests/blast_name_test.js`.
  **The 360 schedule fixes** (Sky, 2026-11-05; `_handoffs/spiff-360-schedule-fixes.md`): stock is
  ordered at -14 and checked at `e -6` (`core.stock`, `core.midcheck`), a vendor-funded customer
  deal is its own item (`promo`), close-out lands on the L10 after the end (`core.wrapup` e+4,
  `core.results` e+5), and no default task falls on a Sunday — pinned by section 14 of
  `tests/marketing_tasks_test.js`. The team cheat sheet (claude.ai artifact KwVhMeWbfTbUpmCTADx2Jz)
  mirrors this schedule; change one, tell the other. On a `blast` item every
  before-start task counts back from that item's typed send date; the `blast.*` pair from the
  earliest one. `email.creative` drops out when "Who makes the creative" is "We do" (blank keeps
  it). Pinned by `tests/marketing_tasks_test.js` section 13. The section shows to sky, mike and
  tawny (their GX Core sign-in names) and the read-only `gx-dev` viewer until `VISIBLE_TO_EVERYONE` is flipped.
  **Holiday sends are not programs** (Sky, 2026-11-02): name + send date + channels (email/sms) +
  note, in their **own `holidays` tab, never in `programs`** — same reason as pencils. Rows are never
  deleted (`status` planned / canceled). The screen reads one as a program with only its blast
  items picked (`holidayProgram`), so it gets the blast cycle counted back from its send date, minus
  the vendor-only tasks (`vendor` flag: `email.creative`, `sms.cost`); only `done` / `due` / `own`
  are stored, in the row's `marketing_json`, through `saveHolidayPlan` (the same delta ops).
  `marketingAssign` takes `kind=holiday`. Nothing that pays, publishes or feeds a kiosk may read the
  tab; no holiday route on `ENGINE_HEDGE_READS`. Nothing is seeded. Pinned by
  `tests/marketing_holidays_test.js` and the isolation test's section 5b.
  **A vendor day with no program is its own record** (Sky, 2026-11-05): brand, stores (none = every
  store), date, time, note, in its **own `vendor_days` tab, never in `programs`** — same reason as pencils
  and holidays. Rows are never deleted (`status` planned / canceled). Read only by its own routes
  (`standaloneVdays`, `saveStandaloneVday`, `cancelStandaloneVday`), the Marketing Calendar source
  (`svday:<id>:<store>` events) and the deals page publisher. It goes on /deals when ticked (the default);
  its deal WORDING shows only once **approved by a signed-in Sky, Mike or Tawny** (the engine writes
  `approved_by` from the session; any other person's change to the brand or copy clears it) and passes
  the OLCC and length rules; its Wix
  rows are keyed `sv-<id>|<store>|<date>`. **Vendor days no longer wait for approval** (Sky, 2026-11-06:
  "vendor days, once entered into the app, should be automatically approved and published"): a program's
  days and a standalone day go up as soon as they are entered, signed `approvedBy` =
  `WIX_VDAY_AUTO_APPROVER_` (`'sky'`, his standing approval, for GX Core's gate). Only the DEAL needs a
  person: the Featured card still waits for `web.approve`, and a day's deal/offer wording rides on it
  only once approved and inside the copy rules, else the day goes up with it blank (reported in
  `skipped`). **A program's vendor-day wording is typed in the Vendor day section** (Sky, 2026-11-06),
  stored in `d.vday {deal, offer}` with its own tick `vday.approve` (`WIX_VDAY_APPROVE_TASK_`, signed and
  un-ticked by `wixSignDelta_` like `web.approve`). `wixVdayCopy_` reads the old `d.web.deal/offer` under
  `web.approve` only while `d.vday` holds none. `vdaysOps` retires only `d.vday`'s old date/time, never the wording. A standalone day's "Show on the deals page" is ticked by default and is now an opt-out.
  Pinned by `tests/wix_publish_test.js` section 2 and `tests/standalone_vendor_day_test.js`.
  **It must carry the brand's logo** (Sky, 2026-11-05): linked by
  `vendorRef` to the brand's Wix `Vendors` row, like a program's day, but unlike a program a day whose
  brand has no row or no logo is NOT sent (`wixVdayLogoProblem_`, reported in `skipped`). The form shows
  the logo or asks for one (`vdayLogoStatus` in marketing.js, read from the Deals page view's brand list)
  and "Add the logo" opens that view on the brand's card. No route on `ENGINE_HEDGE_READS`. Pinned by
  `tests/standalone_vendor_day_test.js` and the isolation test's section 5b2.
  **The Text blast card prices one send** (Sky, 2026-11-03): opted-in phones × Dutchie's per-text
  and with-image rates, a pass-through at Dutchie's cost added to the vendor's credit (no
  160-character note: Sky took it off the same day). The three numbers are **settings, never constants** (script properties
  `SMS_LIST_COUNT`, `SMS_RATE_TEXT`, `SMS_RATE_IMAGE`, `SMS_LIST_AS_OF`; edited in Settings by an
  editor via `saveSmsPricing`), because the count changes monthly (Dutchie's "SMS opted in"
  segment). Unset reads as null and the card says "not set yet", never $0. Pinned by
  `tests/sms_pricing_test.js`.
  **The Staff swag card counts staff sizes from Crew, through Core** (Sky, 2026-11-04: "6 M, 10 L").
  `?action=swagSizes` (signed-in only) reads `GXCore.publishedCrewSwagSizes(secret)` — COUNTS per
  store, never names — and passes on only store ids, size names and whole numbers. Live since v2.005
  on **GXCore v369+** (Crew publishes hourly and after a size save; Core contract test
  `tests/crew_swag_sizes_test.js` in the hub). An older pin, or Core failing, makes the card say "not
  connected to Crew yet" rather than show a count. Hats are one size (Sky, 2026-11-05): the card
  counts one per active staff member, so Crew has no hat field. No vendor page reads it. Pinned by
  `tests/swag_sizes_test.js`. Handoff: `../_handoffs/spiff-staff-swag-sizes.md`.
  **The vendor plan's artwork sizes are generic on purpose** (Sky, 2026-11-02, `MKT_SIZES_`): TV
  1920×1080 / 3840×2160 horizontal or vertical as image or MP4, standard social sizes, 8.5×11 print.
  **Saving the plan files it in the program's vendor files folder** (`d.files.url`) when that is a
  Drive folder link, else in SPIFF Reports.
  **Every vendor has an upload folder, made by the engine** (Sky, 2026-11-02): under Marketing ▸
  Vendors (`VENDOR_FOLDERS_PARENT`, a shared drive), found by folded name, shared "anyone with the
  link can edit" (Contributor on a shared drive: add, not delete). `createProgram_` makes the
  vendor's folder if missing and links it as `d.files.url`, inside a try so Drive never blocks a
  create. `?action=vendorFolders` (secret, dry unless `apply=1`) does every vendor from programs and
  Core's brand list and links programs that are not closed; it never overwrites a link already set.
  A plan holding only the link is not "planned" (`hasPlan`). Pinned by `tests/vendor_folders_test.js`.
  **The shared Marketing Calendar is filled from here, one way** (Sky, 2026-11-02): programs, penciled
  holds ("Spiff reserved - Brand") and vendor days, written by `calendarSync_` to the
  Google calendar in `MKT_CALENDAR_ID_`. Nothing is read back. **Holiday sends are NOT on it**
  (company-facing calendar; Sky, 2026-11-02): they stay on SPIFF's own Calendar view. Each event carries a private tag
  (`spiff_key`: `program:<id>`, `vday:<id>:<n>`, `pencil:<id>`), so an edit moves the
  same event; only tagged events are ever updated or removed, and Tawny's hand-made ones are left
  alone, and SPIFF makes no copy of anything a hand-made one already covers (same brand, overlapping
  days, same kind; reported as `skipped_duplicates`). Removals have brakes (empty programs tab, more than 10 an hour).
  It runs LAST in the hourly job in its own try/catch, behind script property `CAL_SYNC_ON=1`
  (off until Sky has seen a dry run: `?action=calendarSync`, secret, `apply=1` writes). Invites are
  off until `CAL_INVITE_VDAYS=1`, then Mike only, on create. Needs the `calendar` scope: after a deploy
  the owner runs `authorize()` once. Nothing that pays may call it. Pinned by `tests/calendar_sync_test.js`
  and the isolation test's section 5c.
  **The deals page (greencrosscanna.com/deals) fills itself, one way, through GX Core's Wix connector**
  (Sky, 2026-11-02; needs GXCore v365+). A program goes on it as one `VendorDays` row per vendor day (keyed
  `<program>|<street-slug>|<date>`) as soon as the days are entered (Sky, 2026-11-06; see the standalone
  vendor day bullet above), plus a Featured card (`FeaturedDeals`, keyed `programId`) only when
  it is active (or a draft starting within 60 days, Sky 2026-11-04, sent `live=false`), its plan picks the **Deals page**
  item (`web`: headline, image link, offer lines — the two-week featured deal), **Sky, Mike or Tawny has ticked
  `web.approve`** (`WIX_APPROVERS_`, Sky 2026-11-02) and the copy passes the OLCC word rules
  (`WIX_COPY_RULES_`, mirrored as `COPY_RULES` in marketing.js). The engine signs every marketing tick
  with the SESSION user (`wixSignDelta_`), refuses that tick from anyone else, and un-ticks it when anyone
  else changes the `web` copy. GX Core's approval gate (v365+) refuses any Wix write without
  `app: 'spiff'` and any row whose `approvedBy` (the signer's user_id, `WIX_APPROVER_FIELD_`) is not on
  kv `wixApprovers`; Core strips the field, so `wixSameItem_` leaves it out of the comparison. Only rows SPIFF put
  there (`WIX_PUBLISHED` property) are ever updated or removed; a hand-made Wix row is left alone and
  SPIFF makes no copy of it (`skipped_duplicates`) — except that ANY Featured card past its end date (LA
  day) is deleted, since GX Core clears none. Past days are pruned on the LA day. A failed hourly run is
  filed as an `app=spiff` bug, once a day per distinct failure (`wixReportFailure_`). Shop Now: once
  per LA day each store's Dutchie inventory says which stores stock the program's brand; those store ids
  ride as `shopStores` and `wix/gc-deals.js` lists only them (none: no button, Tawny emailed once).
  Vendors is hand-owned (connector read-only), so a Menu Slug that disagrees with Dutchie is reported
  (`menu_slug_fixes`), not written. The Featured image is checked against the spec (1200×1200 square,
  1080–2400, JPG/PNG, ≤2 MB) before import. Runs LAST in the hourly job, own try/catch, behind
  `WIX_PUBLISH_ON=1`; `?action=publishToWix` (secret, dry unless `apply=1`, `shop=1` re-reads inventory).
  Nothing that pays may call it. Pinned by `tests/wix_publish_test.js`.
  **The Featured image is picked, not pasted** (Sky, 2026-11-03): "Choose from vendor folder" lists the
  images in the program's vendor folder and one level of subfolders (`?action=webImages`, editor read,
  never makes a folder); a file breaking the spec is greyed with the reason. Pasting a link still works.
  **The image description fills itself** from the headline ("<headline>, through Nov 8"), and follows it
  only while blank or still its own text, so typed text is never overwritten (`webDetailOp`). Pinned by
  `tests/web_image_picker_test.js`.

- **The deals page's weekly lines and brand logos are edited here, not in Wix** (Sky, 2026-11-02;
  Code.gs "THE DEALS PAGE, PART 2"). The Programs tab's **Deals page** view (`site.js`, behind the
  marketing switch) edits the Tue–Sat schedule (Wix `Import1`, keyed `weekKey`) and the brands
  (`Vendors`, keyed `vendorKey`), stored in their **own `site_deals` tab, never in `programs`**;
  nothing that pays, publishes to Core or feeds a kiosk reads it. Published by `wixPublish_`'s hourly
  step through GX Core's gate (needs **GXCore v366+**). Approval = a session-signed tick by Sky, Mike
  or Tawny; anyone else's change un-approves; OLCC copy cannot be approved. **An un-approved row is
  never written or removed**, so the hand-made rows SPIFF adopted keep showing as they are until
  someone ticks them. `?action=adoptSite` (secret, dry unless `apply=1`) takes the hand-made Wix rows
  over ONCE by stamping the key onto the same row (same `_id`, so every card's logo link survives).
  A weekly line comes off as `status=removed`; **a brand is never removed** (cards point at it by
  `_id`). Pinned by `tests/wix_site_test.js`.

### Money: payout, cost, vendor send

- **Payout model.** Most programs are **flat**: a fixed dollar bounty to each budtender who hits their
  individual target (`SPIFF $25 × 17 BTs = $425`). But **`per_unit` is real and implemented** — Hapy
  Kitchen (2.16–3.1.26) paid "$1 for every unit sold", with "Unit Based"/"You Decide" where the goals
  normally sit. The Calculator flattened it, which is why the imported history looked uniformly flat.
  `tiered` remains schema'd and unimplemented. Read the payout model off the doc rather than
  assuming. Hist: "Payout model".
- **Cost, not payout, is where programs vary.** Multi-SKU programs blend it — the sheet's
  `Combined WS Cost` / `Average Cost` / `Combined Total for 20pc & 2pc`. `cost_json` supports
  `flat` and `blended`.
- **Nothing goes to a vendor without a human.** The app sends only on a person's click —
  `sendBrandEmail_` (Code.gs) runs only from the "Send to brand" button after a confirmation naming
  the recipient, never from a trigger. It goes out AS the Send-As alias `tawny@greencrosscanna.com`
  (`BRAND_FROM_DEFAULT`; script property `BRAND_EMAIL_FROM` overrides it; replies and a blind copy go
  there too). If Gmail does not know that alias the send FAILS loudly — it never falls back to sending
  from the account the script runs as. It refuses a second send of the same program to the same
  address unless `resend=1`, because writes ride on GET and a URL can be re-fetched. **What the
  brand gets is the brand page — no budtender names** (one builder, `brandPaperHtml_`, feeds the
  preview, the email body and the attached PDF); the staff copy with names stays the Drive save.
  Needs the `https://mail.google.com/` scope (GmailApp's `from` option needs it; `script.send_mail`
  cannot set a sender) — a scope change means the owner must run `authorize()` in the editor right
  after the deploy, or every route returns consent HTML. Pinned by `tests/closeout_money_test.js`
  section 5. Hist: "Nothing goes to a vendor without a human".

### Cross-app contracts

- **SPIFF reads the roster, never writes it.** `employees` and `stores` come from GX Core; don't
  re-hardcode store names — Command Center edits must flow through on the next load.
- **SPIFF publishes to Core.** After every
  hourly refresh SPIFF pushes its finished per-employee sell-through and payout into GX Core's
  **`spiff_publications`** tab, one publication per pay period, via
  `GXCore.publishSpiffProgress(secret, scope, payload)`. Leaderboard and Crew read it back with
  `publishedSpiffProgress` / `?action=published_spiff_progress` instead of calling this engine's
  `/exec` (**step 2 of 4** in the hub's `GX_CONSOLIDATION_MAP.md`). **Requires
  GXCore v306** — the routes exist only in that snapshot. Publish on demand with
  `?action=publishToCore` (deploy-secret gated, **dry by default**, `apply=1` to write).
  Hist: "SPIFF PUBLISHES TO CORE NOW".
  - **SPIFF still owns the numbers.** Core stores the payload verbatim and recomputes nothing; the
    vendor is paid SPIFF's figure, and a second computation would be a second answer. The payload is
    the same shape `?action=progress` already served, deliberately, so a consumer changes its source
    and not its parser.
  - **THE PUBLICATION IS THE CONSUMER, NOT `storeView` — check the pipe, not the route** (2026-09-17).
    Leaderboard's kiosk panel and Crew's incentive column read the PUBLICATION. `storeView` is the
    kiosk *page's* own route and is nobody else's source. **Before telling another app a field is
    available, grep for what THEY call**, not for what the field is on.
  - `last_programs` is a per-store map on every published scope, `last_programs[store_id]` →
    `{vendor, program_name, end_date, store_pct?}`, for the kiosk's "nothing running" chip. It is
    deliberately **not** on `?action=progress` — that route takes `pay_period` / `program` /
    `status` filters and a map computed from a filtered slice is quietly wrong rather than absent.
    A store appears only when nothing is running there, and `programRunsAt_` is shared by both
    pipes so the two can never disagree about what that means. Pinned by
    `tests/publish_to_core_test.js` (which also reads this file for this bullet and the one above).
  - **Silent staleness** is the new failure mode — nothing throws if publishing stops, the payload
    just ages — so every read must check `age_minutes`.
  - The **`pay_period` column is unusable as a scope**: live rows hold `"2026-08-17 - 2026-08-30"`
    (a range) and `"2026-09-18"` (a date after its own window), despite a schema comment claiming
    `YYYY-MM-DD`. The scope is **derived** from the program's `start_date` against
    `cfg.payPeriodAnchor` (read via `GXCore.getKv` — there is no `getConfig()`). The column is left
    alone on purpose.
  - **The documented exception:** Crew's `incentiveApprove_` and `incentiveSend_` keep reading SPIFF
    **live**, because they freeze vendor money into `crew_incentive_history` where it can never be
    recomputed — a stale figure frozen there is silent and permanent, where a live read that fails
    is loud and recoverable in front of the person who just clicked Approve. Not an oversight to tidy.
- **Do not document or assume a contract that does not exist.** There is no `spiff_payouts` tab — not
  in `GX_TABS`, nothing writes or reads it. A documented contract that does not exist invites a future
  session to "maintain" it.
- **Incentive lives in GX Crew** (decision 2026-08-16, moved out of Leaderboard), **and Crew fills
  the SPIFF dollar from what SPIFF measured.** Crew's `applySpiffEarnings_` sets `spiff_earned` per
  person: the incentive **screen** reads Core's publication; **approval and send** read this
  engine's `?action=progress` live (the documented exception above). A hand-typed figure is an
  **override only** — a typed value, even 0, beats the measurement; an absent one falls through to
  it. Any new hand-off still needs a real contract — designed, not assumed. Hist: "The underlying goal is still real".
- **Brand reps live in GX Core's shared brand registry, not on the program** (Sky, 2026-09-14/15;
  GXCore v330). `brands` + `brand_contacts`, keyed by **brand** — Sky chose that over a
  vendor/distributor layer. SPIFF edits reps on the program screen (`saveBrandContact`,
  `removeBrandContact`, `addBrand` — editor session, stamped `by` the signed-in user) and Core is the
  only writer. Inventory is a named consumer. Pinned by `tests/brand_contacts_test.js`.
  Hist: "Brand reps live in GX Core's shared brand registry".
  - **The vendor link is RETIRED** (Sky, 2026-11-05). `clientView_` refuses every request with
    "This link is no longer active. Ask Tawny for a progress report." and reads nothing; `client.html`
    is a static page saying the same (links were already emailed, so no 404), and `shareLink_` no
    longer mints (revoke still clears a stale token). The share button and the record panel's
    brand-link block are gone. The `share_token` column and the `CLIENT_VIEW_PASSWORD` property stay
    (names stay; the property can be removed later). **Do not rebuild a self-serve vendor view.**
    Brand reps still live in Core's registry (the close-out email goes to them); `contact_name` /
    `contact_email` stay out of `EDITABLE_FIELDS`. Pinned by `tests/client_view_test.js`.
  - **Tawny sends progress herself: "Download progress report (PDF)"** on Reports, editors only
    (`progressSnapshot`). It is the SAME brand page (`brandPaperHtml_`, no budtender names) built
    from the measurement so far, labeled "Progress as of <time>" and "Earned so far", from a COPY of
    the program (nothing written). It builds a PDF to download; it sends nothing. Emailing a vendor
    stays "Send to brand" (one click, confirmation naming the recipient, Tawny alias, resend guard).
    Pinned by `tests/progress_snapshot_test.js`.
  - **Core's library read is slow** — `getBrands` measured 6–30s. The engine caches it **for the
    screen only**: the hourly trigger re-reads it (`warmBrandsCache_`, 65-minute cache), and SPIFF's
    own writes **patch** the cached list from Core's answer (`applyBrandWrite_`, mirrored by
    `applyBrandWrite` in the browser) instead of re-reading it. An edit made outside SPIFF can take
    up to an hour to show. The sign-in never reads that cache, or a removed rep would keep access.
    Contact emails are half of a rep's login, so no route hands the list to an anonymous caller.
  - **Settings holds the brand directory** (Sky, 2026-09-15): every brand, searchable by brand or
    rep, with reps and website / notes / other spellings editable (`saveBrand`). It deliberately
    cannot rename a brand or turn one off — a program finds its brand by name, and turning a brand
    off locks out all its reps; both are rare enough to do on purpose, not from a list.
  - **Settings has two doors, one per context** (Sky, 2026-09-15). Standalone it is the chip menu's
    Settings row; **nested in Inventory** the shared theme hides the whole user tray, so a
    `data-gx-embed-only` gear at the end of SPIFF's own tab bar replaces it (the suite's outline
    gear). Same dialog, same editor-only rule as the menu. Tawny works through Inventory, so without
    it she had no way in. Pinned by `tests/nested_settings_test.js`.
  - **Its search autocompletes** (Sky, 2026-09-15): brands in the list, reps by name or email, and
    every brand Dutchie has **in stock** that is not in the list yet, added in **Dutchie's
    spelling**. A name Dutchie does not carry can still be added and says so. The Dutchie list is
    the Calculator picker's `catalog` cache, not a second fetch.
  - `?action=seedBrands` (secret-gated, dry by default, skips anything Core already resolves) seeded
    the 16 brands SPIFF had run programs on, with no reps.
- **A bug report carries its screenshot** (2026-09-15, v1.424). The browser uploads the image to
  Drive on its own call and puts the url on the payload as `screenshot_url`; `reportBug_` forwards
  a NAMED list of fields to `GXCore.gxIngestBug`. Add a field to the payload and it must be added
  to that list too; pinned by `tests/bug_report_test.js`. Hist: "A bug report carries its screenshot".
- **Dates are TEXT** (`YYYY-MM-DD`), never Date objects — a sheet/script timezone mismatch silently
  shifts them a day. See `gx-conventions.md` in the Command Center.
- **All GX Core traffic goes through `GXClient`** (`gx-client.js`) — its `/exec` second hop 404s on ~6%
  of rapid calls and needs the retry. Never hand-roll a JSONP call.

### Load and transport

- **Every GX app shares one 30-at-once execution ceiling — don't fan out** (2026-09-15, v1.422).
  All web apps and triggers run as sky@, and Google caps an account at 30 simultaneous executions.
  SPIFF's share: a signed-in call no longer re-asks GX Core about the token each time (`gxAuth_`
  caches a **yes only**, 5 min, keyed by a hash — so a removed grant or changed role takes up to
  5 min to bite); store pulls run **`PULL_LANES` (2) at a time** via `inLanes`, never `Promise.all`
  over stores; a **running program opens on the hourly figures**, labeled with their time, and only
  Refresh (or a store the cache lacks) pulls live, up to today rather than the end date; the hourly
  job holds a **lease** so two copies can't overlap, and `diag` reports `hourlyTriggerCopies`.
  Pinned by `tests/shared_account_load_test.js`. Hist: "30-at-once execution ceiling".

- **The screen opens with ONE call to this engine, not four** (2026-09-18, deployed v1.440).
  `?action=boot` (`bootAll_` in Code.gs) answers `programs`, `brands`, `progress` and `employees`
  from the SAME caches those routes already keep warm (the 5-minute programs cache,
  `BRANDS_CACHE_KEY`, the roster's 15-minute cache), behind one `guard_` check. Why: Apps Script
  serializes executions of one script, so four reads queued nose-to-tail (see the comment above
  `listProgramsCached_`), each paying its own `gxAuth_` round trip.
  - **Each part has its own try/catch** — a slow or broken brand list must never blank the program
    list a user is staring at, so a failed part comes back as its own `{ok:false, error}` in its
    own slot and the other three still arrive.
  - The four solo routes are unchanged and stay live, both as the fallback for an old cached client
    and for a future one-part refresh.
  - **`bootOnce()` on the client memoizes the one call** so `loadPrograms`, `loadBrandReps` and
    `loadProgressCache` (`loadRoster` too — see roster_names_test.js) all consume its slots instead
    of making their own request. **Falls back part-for-part to the solo route** if `boot` itself is
    missing or unrecognized (an undeployed engine answers "Unknown action" rather than throwing), so
    an old-cached client degrades to exactly the old behavior rather than breaking.
  - **Employees and brands also mirror to a 24h localStorage cache** (`BOOT_MIRROR_KEY`, same shape
    as `PG_CACHE_KEY`), painted by `paintBootMirror()` before `boot()` has even answered. Boot's
    real answer always replaces it. `brandCall` writes its own edit straight into the mirror so the
    next open sees it, never a stale copy.
  - Pinned by `tests/engine_boot_test.js` (the server route), `tests/client_boot_fanout_test.js`
    (the three-loader fan-out) and `tests/boot_mirror_test.js` (the 24h mirror).
  - **The next lever, not built here**: opening a single PROGRAM is still N stores × M windows of
    live Dutchie pulls (`loadProgress`, spiff.js `async function loadProgress`).

  Hist: "The screen opens with ONE call".

- **This engine hedges its OWN reads, and only reads** (2026-09-18, v1.440).
  `var ENG = GXClient(ENGINE, { hedgeReads: ENGINE_HEDGE_READS });` — with no `defaults.hedgeReads`,
  `ENG` silently inherits gx-client's DEFAULT list, which is **GX Core's** route names (`health`,
  `stores`, `config`, …), none of which this engine answers; a dropped first `boot` copy then waits
  out the whole attempt (measured as a ~1-minute landing page; gx-client.js's `HEDGE_MS` comment has
  the numbers). `ENGINE_HEDGE_READS` (spiff.js, above `ENG`) names `boot` and this engine's other
  read routes — every one checked against its own handler in `apps-script/Code.gs`, not copied
  from `index.html`'s `GX_DEV_READS` (which lists actions, like
  `config`/`version_history`/`productStats`, this engine does not even implement).
  **A hedged write runs twice** — the losing JSONP copy is never canceled, so hedging one of this
  engine's mutating actions (`editProgram`, `deleteProgram`, `saveBrand`, `publishToCore`, …) would
  fire it twice on a slow network. **Never add a mutating action to `ENGINE_HEDGE_READS`.**
  `bootOnce`'s budget is `{timeoutMs:20000, retries:2}`, cut from `{timeoutMs:45000, retries:1}`
  (cold start measures ~9s), and the `brands` fallback call in `loadBrandReps` got the same cut.
  `bootOnce` logs `[spiff] boot answered in Ns` on success and warns past 15s or on fallback, so a
  slow open says why in the console. Pinned by `tests/boot_hedge_test.js` — every hedged name is
  both a real Code.gs action and on a hand-vetted pure-read list, none of ~30 known
  write/session-mint actions appear, and `bootOnce`'s call-site budget is ≤20s / ≥2 retries / ≥2×
  the 6s hedge delay.

### Tests

- **A test RUNS the code, or says why it cannot** (2026-09-15, Sky's "flip the test ratio").
  `tests/_gas.js` is the shared harness — it lifts a function out of `Code.gs` by name and runs it
  with the sheet, the clock and GX Core stubbed at the edges, so what executes is the shipped path
  rather than a restatement of it. The five money routes (rename, delete, orphan sweep, publish to
  Core, the three vendor close-out documents) run for real; `progress_cache`, `payout_math`,
  `status_roll` and `window_and_goal` always did. **A source-text check is still right for two
  things**: an architecture guard with no other enforcement (this field is not editable, this route
  is not on the secret-only list, nothing calls a function that no longer exists), and screen
  markup and click wiring, which cannot run here — mark those in the file rather than replacing them
  with a regex that looks like coverage. What a regex must never stand in for is a number, an
  ordering of writes, or a refusal: `indexOf(a) < indexOf(b)` on source text is equally true of a
  route that moves the rows first and one whose loop never matches a row.
- **The rule is a ratchet, not a memo** (2026-09-15). `tests/suite_shape_test.js` fails if a test
  file neither runs code nor carries a `SOURCE-SHAPED:` line in its header saying why it cannot.

Hist: "A test RUNS the code".

## Sync with the brain — run `/gxbrain` (or say "brain sync")

**`/gxbrain`** loads the shared rules and reconciles this chat with GX Core — the sync protocol lives
in that one command. **"brain sync" / "sync brain"** = the reconcile-and-report step alone (skips
orientation). **`/gxwhatsnext`** pulls this app's next prioritized work from the Command Center's
build sequence; it reads the app key automatically.

Coordination is the **central brain-notes inbox** in GX Core: `/gxbrain` and the SessionStart hook read
notes addressed to **`to_app=spiff`**, resolve done ones (`resolve_note`), and write note-backs to any app
(`add_note`). **Bug reports file under SPIFF's own key: `app=spiff`, `tab=spiff`.** The engine
hardcodes both in `reportBug_` and ignores any client-sent `tab` (the panel rides in the context as
`panel`). Nested in Inventory, SPIFF hides its own report button; a report from the host's button
is Inventory's to route, not this engine's.

**Shared files** (`deploy.sh`, `.claude/gx-brain-notes.sh`) come from **gx-theme** via `./gx-sync.sh`,
filled from `.gx_app`. Edit them **there**, not here, then re-sync. `gx-theme.css` and `gx-client.js` load
by URL from gx-theme — this file (CLAUDE.md) is intentionally NOT synced.

### Versions and shipping

- **Version format is `vMAJOR.BBB`** — three-digit build, e.g. **`v1.280`**. One number for the whole
  app: `index.html`, `flyer.html` and `client.html` all carry the same `?v=`.
- **The pad is to the RIGHT.** The build is the fractional half of a decimal that has been counting up,
  so `1.28` is the 280s — left-padding to `1.028` would send the app *backwards* past everything it has
  already shipped. Widths that disagree don't sort: `v1.28` is above `v1.280` as a string and below
  it as a number. `deploy.sh` refuses a non-conforming version, and
  GX Core's `gxRecordVersion` enforces the same rule server-side — that one is the real gate, since any
  curl can bypass the script.
- **Auto-record on deploy:** `deploy.sh` POSTs `deploy_version` (app=spiff) to GX Core; `APP_VERSION` is
  single-sourced from the `?v=` cache-buster on the `spiff.js` tag in `index.html` (extracted from
  `HEAD:index.html`). Bump that number and run `./deploy.sh` after each ship, so releases show up in
  `version_history` (the route; the tab it reads is `app_versions`).
- **"Each ship" includes a BACKEND-ONLY ship** — an engine change, a GXCore re-pin, anything that never
  touches `index.html` (Sky, 2026-08-30). **Bump `?v=` and run `./deploy.sh` even when no frontend file
  changed.** The `?v=` is the **app's release number** that happens to be stored in a cache-buster.
  Without a bump `deploy.sh` records nothing, and **it says nothing while doing so**. Pass
  `GX_NOTES="…"` — for a backend ship the version number is all a reader gets otherwise.
- The two axes do not line up and are not meant to: `version_history` tracks the **app** version
  (`v1.320`), while the engine has its own **clasp deployment** version (`@71`), visible from
  `clasp list-deployments` and via `./gxpins.sh` for the library pin. Recording the app version is
  what ties a `git_sha` to what is live; the clasp number is not expressible in the `vMAJOR.BBB` format `gxRecordVersion` enforces, so don't try to file it as one.
- **Don't re-propose either rejected `deploy.sh` extractor fix.** Widening the second stage to
  `[0-9.]+` looks like the one-character answer and **is worse than the bug** — it matches the dot in
  `.js` before it reaches the version and returns `.` for *every* app. What shipped strips up to `?v=`
  with sed; `gx-theme/tests/deploy_version_test.js` re-runs both rejected patterns.
- **SPIFF is live and feeds payroll, so it ships like every other spoke:** a **feature** goes on a
  `feat/…` branch + PR, and **the session merges its own feature PR** once the full test suite and push
  gate are green and the PR matches what Sky asked for (say so in your reply); never merge a red, unrun,
  or beyond-the-ask PR. A small fix that is correct the moment it lands ships direct to `main`.
  **A merge is not a deploy:** `./deploy.sh` and any live push still need Sky's word in chat, since
  SPIFF moves vendor pay. `./deploy.sh` after each ship so `version_history` stays honest.

Hist: § Sync with the brain → "Version format", "BACKEND-ONLY ship", "Worth keeping".

### The Drive importers are GONE — cut 2026-08-30. This app is the system of record.

- There is no longer any code that reads the Calculator sheet or Tawny's SPIF docs; the `importCalc`,
  `previewCalc`, `importDocs`, `previewDocs`, `seedDocs` and `seedCleanup` routes, the "Import from
  Calculator sheet" button, and the whole `.docx` parser were removed together the day the seed
  finished.
- **Do not rebuild an importer.** Every Calculator-era row is gone, so re-running one would not top
  History up — it would add a second, worse copy beside the good one, keyed differently and windowed
  by calendar month. The last revision that still had all the machinery is commit `db7a4c5`
  (`git show db7a4c5:apps-script/Code.gs`, shipped as v1.322) — seed map included.
- **Known gaps, neither a bug.** `green-cross-2025-08-11-2025-08-17` is a real program Sky confirmed,
  but the Calculator never held it, so it has goals and **no `actual_json`** — no units sold, no
  ROI. *Sky, 2026-09-15: leave it as is.* Its close-out
  measurement found 0 units, so the hourly actuals recording logs it as "needs a person" every run —
  that line is expected, not a new problem. `hapy-kitchen` kept the Calculator's targets; its
  `per_unit` $1/unit payout came off the doc correctly.

Hist: § Sync with the brain → "The Drive importers are GONE", "What the seed did, once".

### Close the loop when you're done

When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that
should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping
(spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`) auto-completes
the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app)
when you need its id for the `curl` — but **refer to it by its `title`, never its id**.
`job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id
came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…`
and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** —
re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than
from memory.

## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. **So from SPIFF: `add_note` to `core-admin` with what you need and why, and stop.** Requests
are welcome and quick, and the hub session holds the repo alone while it works.

Why: two sessions cannot share a git checkout. These repos are Dropbox-synced, so two sessions share one
working tree and one HEAD; `git checkout -b` is not atomic against a second process.
Hist: § The HUB is core-admin's.

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
- **SPIFF's own engine and repo are still yours.** `./gxengine.sh --deploy` / `./deploy.sh` here touch
  only this app.
