# Plan — Marketing section on SPIFF programs

Status: **proposed, not built** (2026-10-14). Source: Mike and Tawny's "Green Cross 360" planner
artifact (https://claude.ai/artifact/HGe9vkYKRjqLguR6XQc9Sm).

## What it brings over

The planner treats one vendor engagement as a window plus a menu of opt-ins. Each opt-in produces
dated tasks, each with an owner.

- **17 menu items in four sections:**
  - **Customers:** vendor day, swag, raffle.
  - **Employees:** education, shirts, incentive (the SPIFF itself), prizes.
  - **Marketing:** email, SMS, social, e-commerce.
  - **In-Store:** case, signage, LED, counter, bags.
- **Per-item details.** Examples: training format, blast dates, vendor-day dates per store, signage types.
- **Tasks.**
  - Every item comes with a template of tasks: owner (Tawny / Mike / managers / vendor), the date the task is anchored to (start or end), an offset in days, and whether it is per store.
  - Six "core" tasks apply to every vendor, from menu complete at T−21 to sharing results at end+14.
  - Due dates are **derived** from the window and are never stored. Only the done state is stored.
- **Compliance notes per item**, under Oregon rules: no BOGO, no tiered thresholds, no cannabis gift-with-purchase, no health claims, nothing that appeals to minors.
- **Program standards:** a 14-day gap between blasts and 2 social posts a week, with warnings when either is broken.
- **Views:**
  - a calendar covering 3 months (windows, blasts, posts, vendor days, trainings)
  - a cross-vendor "open tasks" list grouped by owner
  - a past-SPIFFs list
- **Vendor overview** (printable). Sections: your team and ours, your plan, two weeks at a glance, what we need from you, incentive options, artwork specs.
- **Team email to Mike** when a form is submitted or reviewed, plus a summary email.
- **Results.** Gift cards, other prizes, and baseline vs. window sales typed in by hand, plus a "what worked" note.

## How it fits SPIFF

| Planner | SPIFF |
|---|---|
| vendor + start/end | the program record (vendor, window in whole pay periods) |
| "incentive" item | the SPIFF itself — auto-selected, its details are the existing payout/target |
| typed baseline / window sales | **dropped** — SPIFF measures these from Dutchie |
| its own store list (baseline, century, portland, river…) | `state.stores` from GX Core; ids mapped once on import |
| shared artifact database | one new `marketing_json` column on `programs` |
| email to a hardcoded mike@ | `sendMail_`, internal only, on a click |

### Data

Add the column `marketing_json` at the end of `PROGRAM_HEADERS`; the existing header migration handles a new trailing column. Add it to `EDITABLE_FIELDS` and give it a normalizer in `programToRow_`. Its shape:

```
{ v:1,
  stores:[store_id],            // where marketing runs (defaults to stores_json)
  sel:{item_id:true}, skip:{item_id:true},
  d:{item_id:{...details}},     // per-item fields
  done:{task_key:{by, at}},     // task_key = task_id or task_id@store_id
  due:{task_key:'YYYY-MM-DD'},  // manual overrides only
  events:[{name, date, time}],
  notes:'' }
```

Tasks, due dates, overdue flags and compliance notes are computed on read, not stored. This follows the same rule as the record warnings.

### Code

- **`marketing.js` (new, frontend):** the menu (ITEMS / CORE / SECTIONS / COMP / SPECS) ported as data, plus pure functions: `tasksOf(program)`, `eventsOf(program)`, `gapsOf(programs)`. It is kept separate so `spiff.js` doesn't grow by another 3,000 lines.
- **Record panel:** a new "Marketing" fold under "The program". It holds the picker ("What is <vendor> in for?"), the per-item detail cards, and the task list with done checkboxes. It saves through the existing `editProgram` patch path.
- **Programs tab:** two new sub-views:
  - **Calendar:** month view, color-coded by kind.
  - **Tasks:** open tasks across every program, grouped by owner.
- **Engine:**
  - `marketingOverview_(p)` builds the vendor plan, reusing the `brandPaperHtml_` styling. It is downloadable and can be saved to the SPIFF Reports folder.
  - `marketingNotify_(p, kind)` sends the internal team email through `sendMail_`.
  - Both run only on a click and are edit-role gated.
  - Nothing goes to a vendor automatically; the existing "Send to brand" rule applies.

### Tests (run code, not regexes)

- `marketing_tasks_test.js`: due-date math, per-store fan-out, the core tasks, and the "incentive" item following the program's payout.
- `marketing_json_test.js`: round-trip through `programToRow_` / `rowToProgram_`, a trailing-column migration on an old sheet, and a check that derived fields are stripped before a write.
- `marketing_standards_test.js`: the blast-gap and posts-per-week warnings.

## Phases (each its own feat/ branch + PR, Sky merges)

1. **Menu + tasks on the program record:** the data column, picker, details, task checklist and compliance notes.
2. **Calendar + cross-program task list**, on the Programs tab.
3. **Vendor overview PDF + internal team email.**

**Phase 3 built 2026-11-01 (v1.464).** `marketingOverview_` (vendor plan, built from an allow-list that never reads pay, cost or roster fields; `save=1` files a PDF in SPIFF Reports) and `marketingNotify_` (internal email via `sendMail_`; recipients come from the script property `MARKETING_NOTIFY_TO`, Green Cross addresses only; dry until `send=1`; a repeat needs `resend=1`). Both editor-only, neither hedged, neither on a trigger. Artwork guidance is non-numeric until someone confirms real sizes.

## Decisions (Sky)

- **Nothing is imported from the planner** (2026-10-14): it holds no real vendors, and this is all new.
- **No "no payout" programs** (2026-11-01): every program carries a payout. This reverses the 2026-10-14 yes, and nothing in this work touches the pay path.
- **Build in the live app, not a test copy** (2026-11-01): most of this is screens. Marketing stays hidden behind a switch that shows it only to Sky until it is ready, because merging to main puts screen changes live. Turning it on for everyone is a separate step Sky approves. The one engine change, the new column, needs Sky's go-ahead to deploy.
- **Phase 1 waits** on feedback from Tawny and Mike on the mockup.
- **Calendar bars run across the days** (2026-11-01), like Mike's planner: one bar per program, spanning each week of its window.
- **A brand can be penciled in** (2026-11-01): it holds a slot on the calendar and is not official until someone locks it in. It belongs in phase 2 with the calendar.

## Penciled brands

**Built 2026-11-01 (phase 2, v1.463).** Stored as `pencils` tab rows with a `status` (penciled, locked, released); locking in makes a draft program with a zero payout for the Calculator to fill.

A pencil is brand + first and last pay period + an optional note, plus who penciled it and when. It shows as a dashed bar on the calendar and in its own list on the Programs tab. Actions: **Lock it in** turns it into a draft program, and its tasks start from there. **Release the slot** removes it.

- **Pencils live in their own `pencils` tab, not in `programs`.** The hourly job turns a draft ACTIVE on its start date, and active programs reach kiosks and Crew pay, so a pencil stored as a program could go live by itself. In its own tab, nothing that reads programs can see it.
- **No tasks, no kiosk card, no pay** until it is locked in.
- **Overlap warns but does not block.** The form and the detail view name whatever else is in that period, since two programs can run at once.
- **A pencil whose start date passes stays put and says so.** It never activates; a person locks it in with new dates or releases it.

## Connections Sky asked for (2026-11-01, not designed yet)

### Tawny's vendor days calendar

It is the shared Google calendar **"Marketing Calendar"**, id `c_0ab9afb8ed309776b6293321191b4e8311b262eb9971bf436336d64d27792470@group.calendar.google.com`. What was on it, read 2026-11-01:

- **SPIFFs** are all-day events across the window ("Kaprikorn Spiff", Oct 12 to Oct 26).
- **Vendor days** are timed events, one per store, with Mike and that store's managers invited ("Hellavated Vendor Day - Hillsboro"). Those invites are how managers hear about them.
- **Tawny already pencils by hand:** "Spiff reserved", Nov 9 to Nov 23, is an all-day event with no brand on it. This is the job the pencil feature does.
- **Titles are typed by hand and vary:** "South" means Commercial, "Hillsboro" and "Bend" are city names rather than store names, and "Kaprikorn Vendor Day" names no store at all. An event that cannot be matched to a store must show as unmatched, never be guessed.

**Recommendation: SPIFF reads this calendar and does not write to it at first.** Tawny keeps working as she does, managers keep getting invites, and vendor days appear on SPIFF's calendar with no second copy to keep in step. This requires a new Google permission on the engine, so the owner must run `authorize()` right after that deploy or every route returns consent HTML. It should be its own ship, since a missed `authorize()` stops the whole app answering.

Adding events from SPIFF (a penciled slot, for example) can follow once reading has proven out.

### Website DEALS page

greencrosscanna.com/deals is a **Wix** page of hand-entered text: same deals at all six stores, by day of the week (Tuesday: Gron, $2 off 10-packs and chocolates), plus veteran and loyalty savings and fine print.

- **SPIFF does not hold customer deals today.** Program records hold internal goals, costs and payouts, and none of that is customer-facing. So this needs a new customer-facing deal field per program, and the site gets its own short public feed, never the program data.
- **"The current deal" is a featured block** (Sky, 2026-11-01): a "featured now" block above the weekly list, showing the running vendor's customer offer. The weekly deals stay as they are.
- **A person publishes it.** The copy needs the same Oregon compliance read as an email blast, so it does not go live on a date.
- **Wix side:** showing live data needs custom code on that page (Velo), which needs site-editor access. The simple fallback is a "copy for website" button in SPIFF.

## Open decisions

- **Who can tick tasks off.** The planner lets store managers check off their tasks. SPIFF lets only admin, editor and director edit. **Recommendation:** phase 1 stays editor-only. Later, add a narrow `markTask` route that managers can call, which can only flip a done flag.
