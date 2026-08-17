/*****************************************************************
 * GX SPIFF — DATA ENGINE (Apps Script Web App)
 * -------------------------------------------------------------
 * Backend for the SPIFF app (GitHub Pages front end). Owns:
 *   • program definitions   (vendor, SKUs, dates, stores, targets, payout)
 *   • sell-through          (Dutchie units by budtender / store / SKU)
 *   • payout calculation    (who hit their target, what we owe)
 *   • vendor reporting      (PDF → Drive, drafted email, gift-card list)
 *   • history               (closed programs, by pay period)
 *
 * It replaces a manual loop: exporting a Dutchie Excel per store and
 * select-all-delete-pasting it into six tabs of "SPIFF_Sales Report".
 * We pull Dutchie directly instead — same connector pattern the
 * Inventory / Sales / Leaderboard engines already use.
 *
 *   GET  /exec?action=<name>&…   -> { ok, … }   (JSONP when &callback=)
 *   POST /exec  body: { action, … }
 *
 * SPIFF *reads* the employee roster from GX Core and never writes it.
 * It *writes* `spiff_payouts` — the column contract Leaderboard's
 * Incentive tab and Performance read (see gx-conventions.md). Don't
 * change those columns without updating both sides in one change.
 *
 * ------------------------- DEPLOY -----------------------------
 *   clasp push && clasp deploy        (rootDir: apps-script)
 * Then set ENGINE in spiff.js to the /exec URL.
 * Re-deploy as a NEW VERSION of the SAME deployment so /exec holds.
 *****************************************************************/

/* ============================== SCHEMA ==============================
 * One row per program in the `programs` tab of this script's sheet:
 *
 *   program_id     slug, e.g. 'wyld-10pc'
 *   vendor         'Wyld'
 *   title          'Wyld 10pc'
 *   status         draft | active | closed
 *   start_date     TEXT 'YYYY-MM-DD'   (dates are TEXT, never Date objects)
 *   end_date       TEXT 'YYYY-MM-DD'
 *   pay_period     TEXT 'YYYY-MM-DD'   (pay-period start — joins to Leaderboard)
 *   match_json     { brand, category, filter_text, products[] }  ← mirrors the
 *                  Sales Report's Brand + Category + Filter Text + up to 4 Products
 *   stores_json    [store_id, …]        participating stores (GX Core store_ids)
 *   cost_json      { mode:'flat'|'blended', per_unit, source_label }
 *                  blended covers "Combined WS Cost" / "Average Cost" cases
 *   payout_type    flat | per_unit | tiered
 *   payout_json    flat:     { amount }                     ← every historical program
 *                  per_unit: { per_unit }                   ← declared, not yet implemented
 *                  tiered:   { tiers: [{units, amount}] }   ← declared, not yet implemented
 *   baseline_json  { units, revenue, by_store:{}, per_bt:{} }   pre-SPIFF period
 *   target_json    { units, revenue, by_store:{}, per_bt:{} }   goal
 *   actual_json    { units_sold, revenue, bts_hit, investment, roi, roi_pct }
 *                  present only for programs that already ran
 *   source         where the row came from, e.g. 'calculator:Wyld 10pc'
 *   updated_at     TEXT timestamp
 *
 * Every one of the 19 historical vendor tabs in the Calculator sheet is
 * payout_type 'flat': a fixed dollar bounty to each budtender who hits
 * their individual target. per_unit and tiered are wired into the schema
 * so adding one later is a handler, not a migration.
 * ==================================================================== */

var APP        = 'spiff';
var GXCORE_URL = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

// Vendor close-out reports land here (Drive folder Sky owns).
var REPORT_FOLDER_ID = '1c8Yj23OkEusskHylLKYzHsqPYIgAHP1t';

// Seed sources — the two sheets this app replaces.
var CALCULATOR_SHEET_ID   = '1ZtgWU9e5Dq3OPZlrf_cihbIMQnZfYaf7R5JfD0u8SHY';
var SALES_REPORT_SHEET_ID = '1aYWKC5QTkgIK3I8DSMZR6o2yHRO8vGZiQUBcvshfNn8';

var PROGRAMS_TAB = 'programs';
var PROGRAM_HEADERS = [
  'program_id', 'vendor', 'program_name', 'title', 'status', 'start_date', 'end_date', 'pay_period',
  'match_json', 'stores_json', 'cost_json', 'payout_type', 'payout_json',
  'baseline_json', 'target_json', 'actual_json', 'source', 'updated_at',
  'edited_by', 'edited_at', 'share_token', 'contact_name', 'contact_email'
];

// Shared passphrase for vendor-facing links. Set it from the script editor:
//   PropertiesService.getScriptProperties().setProperty('CLIENT_VIEW_PASSWORD', '…')
// Never hardcode it here — this file is a public GitHub repo.
var CLIENT_PASS_PROP = 'CLIENT_VIEW_PASSWORD';

// Who may edit a historical record. Role comes from GX Core app_access for app 'spiff';
// the check runs server-side on every write, so hiding the UI is not the control.
//
// These are the suite's own role names (gx-conventions.md: admin · editor · viewer) —
// `editor` is by definition the role that can edit, so leaving it out would let someone
// sign in and then be refused on save. `director` is included because Leaderboard and
// Performance grant it to the same people. `viewer` stays read-only.
var EDIT_ROLES = ['admin', 'editor', 'director'];

// Fields a human may change on an imported record. Everything else (ids, source,
// audit columns) is engine-owned.
var EDITABLE_FIELDS = [
  'vendor', 'program_name', 'status', 'start_date', 'end_date', 'pay_period',
  'payout_json', 'cost_json', 'target_json', 'baseline_json', 'actual_json',
  'contact_name', 'contact_email'
];

/* ---------------------------- ROUTER ---------------------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    switch (p.action) {
      case 'ping':        out = { ok: true, app: APP, ts: nowStamp_() };            break;
      case 'programs':    out = { ok: true, programs: listProgramsCached_() };      break;
      case 'program':     out = getProgram_(p.id);                                  break;
      case 'previewCalc': out = importCalculator_({ save: false });                 break;
      // Writes ride on GET because the browser calls this cross-origin via JSONP —
      // Apps Script serves no CORS headers for POST. Same pattern GX Core uses.
      case 'importCalc':  out = importCalculator_({ save: true });                  break;
      case 'editProgram': out = editProgram_(p);                                    break;
      case 'createProgram': out = createProgram_(p);                                break;
      case 'employees':   out = gxEmployees_();                                     break;
      case 'diag':        out = diag_();                                            break;
      case 'buildReport': out = buildReport_(p);                                    break;
      case 'emailDraft':  out = emailDraft_(p);                                     break;
      case 'giftCards':   out = giftCardList_(p);                                   break;
      case 'clientView':  out = clientView_(p);                                     break;
      case 'shareLink':   out = shareLink_(p);                                      break;
      case 'sellthrough': out = notImplemented_('sellthrough');                     break;
      case 'payouts':     out = notImplemented_('payouts');                         break;
      case 'history':     out = { ok: true, programs: listPrograms_('closed') };    break;
      default:            out = { ok: false, error: 'Unknown action: ' + (p.action || '(none)') };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return reply_(out, p.callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) {}
  var out;
  try {
    switch (body.action) {
      case 'importCalc':    out = importCalculator_({ save: true });  break;
      case 'saveProgram':   out = saveProgram_(body.program);         break;
      case 'editProgram':   out = editProgram_(body);                 break;
      case 'closeProgram':  out = notImplemented_('closeProgram');    break;
      case 'buildReport':   out = buildReport_(body);                 break;
      case 'draftEmail':    out = emailDraft_(body);                   break;
      case 'pushPayouts':   out = notImplemented_('pushPayouts');     break;
      default:              out = { ok: false, error: 'Unknown action: ' + (body.action || '(none)') };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return reply_(out, null);
}

/* ========================= CALCULATOR IMPORT ========================
 * "Use google sheet as framework" — the 19 vendor tabs of the SPIFF
 * Calculator become program definitions.
 *
 * Parsing is by LABEL, not by cell address. The tabs drift: some carry
 * extra columns, multi-SKU programs add "Combined WS Cost" / "Average
 * Cost" rows, and one is spelled "Combioned Cost of all products". A
 * positional parser would silently mis-read those; a label scan doesn't.
 *
 * Each tab has two regions:
 *   • left  — the PLAN  (what we modelled with the vendor)
 *   • right — "SPIFF ROI", the ACTUALS (what the program did)
 * They share label names ('SPIFF', 'Investment', 'Unit Increase'), so
 * reads are scoped to a column window split at the 'SPIFF ROI' header.
 * ==================================================================== */

function importCalculator_(opts) {
  opts = opts || {};
  var ss      = SpreadsheetApp.openById(CALCULATOR_SHEET_ID);
  var stores  = gxStores_();
  var sheets  = ss.getSheets();
  var out = [], skipped = [];

  for (var i = 0; i < sheets.length; i++) {
    var parsed;
    try {
      parsed = parseCalcTab_(sheets[i], stores);
    } catch (err) {
      skipped.push({ tab: sheets[i].getName(), why: String(err && err.message || err) });
      continue;
    }
    if (!parsed) { skipped.push({ tab: sheets[i].getName(), why: 'no SPIFF amount found — not a program tab' }); continue; }
    out.push(parsed);
  }

  flagDuplicateActuals_(out);

  var preserved = [];
  if (opts.save) out.forEach(function (p) {
    var r = saveProgram_(p, { fromImport: true });
    if (r.preserved) preserved.push({ title: p.title, edited_by: r.edited_by });
  });

  return {
    ok: true, imported: out.length, saved: !!opts.save, skipped: skipped,
    preserved: preserved,   // hand-corrected rows the import deliberately left alone
    suspect: out.filter(function (p) { return p.actual_json && p.actual_json.duplicate_of.length; })
                .map(function (p) { return { title: p.title, shares_with: p.actual_json.duplicate_of }; }),
    programs: out
  };
}

function parseCalcTab_(sheet, stores) {
  var grid = sheet.getDataRange().getValues();
  var name = String(sheet.getName()).trim();

  // Split plan (left) from actuals (right) at the 'SPIFF ROI' header.
  var roiCol  = findCellCol_(grid, 'SPIFF ROI');
  var planMax = roiCol > 0 ? roiCol - 1 : 7;
  var actMax  = maxCols_(grid) - 1;

  var spiff = num_(findVal_(grid, 'SPIFF', 0, planMax));
  if (!spiff) return null;           // not a program tab (index/notes/etc.)

  var costPerUnit = num_(findVal_(grid, 'Cost Per Unit', 0, planMax));
  var blended     = findBlendedCost_(grid, planMax);

  var baseline = {
    units:    num_(findVal_(grid, 'Current Sales Units',   0, planMax)),
    revenue:  num_(findVal_(grid, 'Current Sales Revenue', 0, planMax))
  };
  var target = {
    units:    num_(findVal_(grid, 'Sales Target Units',   0, planMax)),
    revenue:  num_(findVal_(grid, 'Sales Target Revenue', 0, planMax))
  };

  var baseTable = storeTable_(grid, 'AVG Sales Store',    stores);
  var tgtTable  = storeTable_(grid, 'Target Sales Store', stores);
  baseline.by_store = baseTable.by_store;
  baseline.per_bt   = baseTable.per_bt;
  target.by_store   = tgtTable.by_store;
  target.per_bt     = tgtTable.per_bt;

  // Participating stores = those carrying a target. Falls back to the
  // baseline table when a tab only filled the "current" side.
  var storeIds = Object.keys(tgtTable.by_store);
  if (!storeIds.length) storeIds = Object.keys(baseTable.by_store);

  // Actuals, if this program already ran.
  //
  // The actuals panel carries its OWN SPIFF rate, and it does not always match the
  // plan: 'Drops' was modelled at $25/BT but settled at $50/BT (26 BTs × $50 = the
  // recorded $1,300 investment). Record both — the plan rate is what we pitched, the
  // actual rate is what we paid — and self-audit the arithmetic so a bad import is
  // visible instead of silent.
  var actual = null;
  if (roiCol > 0) {
    var sold = num_(findVal_(grid, 'Units Sold', roiCol, actMax));
    if (sold) {
      var actSpiff  = num_(findVal_(grid, 'SPIFF',      roiCol, actMax)) || spiff;
      var btsHit    = num_(findVal_(grid, "BT's = SPIFF", roiCol, actMax));
      var investment = num_(findVal_(grid, 'Investment',  roiCol, actMax));
      actual = {
        units_sold:   sold,
        revenue:      num_(findVal_(grid, 'Sales Revenue', roiCol, actMax)),
        bts_hit:      btsHit,
        spiff_amount: actSpiff,
        investment:   investment,
        roi:          num_(findVal_(grid, 'ROI $', roiCol, actMax)),
        roi_pct:      num_(findVal_(grid, 'ROI %', roiCol, actMax)),
        rate_changed: actSpiff !== spiff,
        balances:     Math.abs(btsHit * actSpiff - investment) < 0.5
      };
    }
  }

  var period = periodOf_(name);

  // A3 carries the descriptive program name — 'Hellavated 0326' (the tab) is
  // 'Hellavated Joints' (the program). Some tabs put only the vendor there; going
  // forward Tawny names the program, so A3 wins and the tab name is the fallback.
  var programName = String(grid[2] && grid[2][0] || '').trim() || name;

  return {
    program_id:    slug_(name),
    vendor:        period.vendor,
    program_name:  programName,
    title:         name,
    status:        actual ? 'closed' : 'draft',
    start_date:    period.start_date,
    end_date:      period.end_date,
    pay_period:    '',            // set when a program is tied to a Leaderboard pay period
    match_json:    { brand: period.vendor, category: '', filter_text: '', products: [] },
    stores_json:   storeIds,
    cost_json:     { mode: blended ? 'blended' : 'flat', per_unit: costPerUnit, source_label: blended || 'Cost Per Unit' },
    payout_type:   'flat',
    payout_json:   { amount: spiff },
    baseline_json: baseline,
    target_json:   target,
    actual_json:   actual,
    source:        'calculator:' + name,
    unmatched_stores: baseTable.unmatched.concat(tgtTable.unmatched)
  };
}

/* Duplicating a vendor tab copies its hard-typed ROI cells while the formula cells
   recalculate, so a stale panel looks plausible on its own. Two programs reporting the
   same units sold, budtenders hit AND investment is not a coincidence — mark both so a
   stale panel can't be mistaken for a real result. */
function flagDuplicateActuals_(programs) {
  var seen = {};
  programs.forEach(function (p) {
    if (!p.actual_json) return;
    var a = p.actual_json;
    var key = [a.units_sold, a.bts_hit, a.investment].join('|');
    (seen[key] = seen[key] || []).push(p);
  });
  programs.forEach(function (p) {
    if (!p.actual_json) return;
    var a = p.actual_json;
    var group = seen[[a.units_sold, a.bts_hit, a.investment].join('|')] || [];
    a.duplicate_of = group.filter(function (q) { return q !== p; }).map(function (q) { return q.title; });
  });
}

/* Multi-SKU programs blend the cost. Return the label used, so the import is
   auditable — you can see WHICH blended figure a program was priced on. */
function findBlendedCost_(grid, cMax) {
  var re = /(combined|combioned|average).*(cost|total)|cost.*average/i;
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c <= Math.min(cMax, grid[r].length - 1); c++) {
      var s = String(grid[r][c] || '').trim();
      if (s && re.test(s)) return s;
    }
  }
  return null;
}

/* Read a per-store table that sits under `headerLabel`. Layout is
   [store] [units per store] [units per budtender] …, so offsets are taken
   relative to the header cell rather than assumed to be column B. */
function storeTable_(grid, headerLabel, stores) {
  var out = { by_store: {}, per_bt: {}, unmatched: [] };
  var want = norm_(headerLabel);
  var hr = -1, hc = -1;

  for (var r = 0; r < grid.length && hr < 0; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      if (norm_(grid[r][c]) === want) { hr = r; hc = c; break; }
    }
  }
  if (hr < 0 || hc < 1) return out;

  var labelCol = hc - 1, unitsCol = hc, btCol = hc + 1;

  for (var i = hr + 1; i < grid.length; i++) {
    var label = String(grid[i][labelCol] || '').trim();
    if (!label) break;                                   // table ended
    var low = norm_(label);
    if (low === 'total') break;                          // summary row — stop
    if (low === 'average') continue;                     // summary row — skip

    var id = matchStore_(label, stores);
    if (!id) { out.unmatched.push(label); continue; }
    out.by_store[id] = num_(grid[i][unitsCol]);
    out.per_bt[id]   = num_(grid[i][btCol]);
  }
  return out;
}

/* ============================= STORAGE ============================= */

function dataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SPIFF_DATA_SHEET_ID');
    if (!id) throw new Error('No datastore: bind this script to a sheet or set SPIFF_DATA_SHEET_ID.');
    ss = SpreadsheetApp.openById(id);
  }
  var sh = ss.getSheetByName(PROGRAMS_TAB);
  if (!sh) {
    sh = ss.insertSheet(PROGRAMS_TAB);
    sh.getRange(1, 1, 1, PROGRAM_HEADERS.length).setValues([PROGRAM_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  migrateHeaders_(sh);
  forceTextDates_(sh);
  return sh;
}

/* Adding a column shifts every later one, so existing rows must be remapped BY NAME
   rather than trusted to line up. Re-importing would repair machine-written rows, but
   not a record Tawny hand-corrected — so this migrates in place instead of clearing. */
function migrateHeaders_(sh) {
  var width = Math.max(sh.getLastColumn(), PROGRAM_HEADERS.length);
  var old   = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });

  var same = PROGRAM_HEADERS.every(function (h, i) { return old[i] === h; }) && old.length === PROGRAM_HEADERS.length;
  if (same) return;

  var last = sh.getLastRow();
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, width).getValues() : [];

  var remapped = rows.map(function (r) {
    return PROGRAM_HEADERS.map(function (h) {
      var i = old.indexOf(h);
      return i >= 0 ? r[i] : '';
    });
  });

  sh.clear();
  sh.getRange(1, 1, 1, PROGRAM_HEADERS.length).setValues([PROGRAM_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (remapped.length) sh.getRange(2, 1, remapped.length, PROGRAM_HEADERS.length).setValues(remapped);
}

/* Writing '2025-08-01' into a default-formatted cell does NOT store text — Sheets
   coerces it to a Date, which reads back as an ISO timestamp and is one timezone
   mismatch away from shifting a day. Pin the date columns to plain-text format so the
   convention ("dates are TEXT") actually holds at rest, not just in our variables. */
function forceTextDates_(sh) {
  var cols = [
    PROGRAM_HEADERS.indexOf('start_date'),
    PROGRAM_HEADERS.indexOf('end_date'),
    PROGRAM_HEADERS.indexOf('pay_period'),
    PROGRAM_HEADERS.indexOf('updated_at')
  ];
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  cols.forEach(function (i) { sh.getRange(2, i + 1, rows, 1).setNumberFormat('@'); });
}

/* Trims the sheet read out of the request. Worth having, but keep the cost in
   proportion: a no-op action still costs ~2.4s of Apps Script /exec round trip, and a
   COLD start was measured at 8.7s — which alone blew GXClient's old 8s timeout and is
   why the vendor view failed intermittently rather than always. The generous client
   timeout is the actual fix; this just stops us spending budget we don't need to.
   Every write clears the cache, so a correction is visible immediately, not after a TTL. */
var PROGRAMS_CACHE_KEY = 'spiff_programs_v1';

function listProgramsCached_() {
  var c = CacheService.getScriptCache();
  try {
    var hit = c.get(PROGRAMS_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  var all = listPrograms_();
  // CacheService caps a value at 100KB; skip the cache rather than throw if we outgrow it.
  try {
    var body = JSON.stringify(all);
    if (body.length < 95000) c.put(PROGRAMS_CACHE_KEY, body, 300);
  } catch (e) {}
  return all;
}

function invalidatePrograms_() {
  try { CacheService.getScriptCache().remove(PROGRAMS_CACHE_KEY); } catch (e) {}
}

function listPrograms_(status) {
  var sh = dataSheet_();
  if (sh.getLastRow() < 2) return [];
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var p = rowToProgram_(rows[i]);
    if (!status || p.status === status) out.push(p);
  }
  return out;
}

function getProgram_(id) {
  if (!id) return { ok: false, error: 'id required' };
  var all = listPrograms_();   // uncached: edits read-modify-write and must see the truth
  for (var i = 0; i < all.length; i++) if (all[i].program_id === id) return { ok: true, program: all[i] };
  return { ok: false, error: 'not found: ' + id };
}

/* Upsert by program_id — re-running the import updates rows instead of duplicating them.
   opts.fromImport marks a machine write: those never overwrite a record a human has
   corrected, because the Calculator is exactly the source those corrections fix. */
function saveProgram_(p, opts) {
  if (!p || !p.program_id) return { ok: false, error: 'program_id required' };
  opts = opts || {};
  var sh   = dataSheet_();
  var last = sh.getLastRow();

  var audit = opts.editedBy ? { edited_by: opts.editedBy, edited_at: nowStamp_() } : null;

  if (last >= 2) {
    var rows  = sh.getRange(2, 1, last - 1, PROGRAM_HEADERS.length).getValues();
    var idCol = PROGRAM_HEADERS.indexOf('program_id');
    var byCol = PROGRAM_HEADERS.indexOf('edited_by');
    var atCol = PROGRAM_HEADERS.indexOf('edited_at');

    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]) !== p.program_id) continue;

      var priorBy = String(rows[i][byCol] || '').trim();
      if (opts.fromImport && priorBy) {
        return { ok: true, program_id: p.program_id, preserved: true, edited_by: priorBy };
      }
      // An import must not erase who corrected this row; an edit stamps itself.
      var rowAudit = audit || (priorBy ? { edited_by: priorBy, edited_at: textDate_(rows[i][atCol]) } : null);
      sh.getRange(i + 2, 1, 1, PROGRAM_HEADERS.length).setValues([programToRow_(p, rowAudit)]);
      invalidatePrograms_();
      return { ok: true, program_id: p.program_id, updated: true };
    }
  }
  sh.appendRow(programToRow_(p, audit));
  invalidatePrograms_();
  return { ok: true, program_id: p.program_id, created: true };
}

/* Apply a human edit. The role check is here, server-side — the modal hiding its Save
   button is convenience, not the control. */
function editProgram_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot edit SPIFF records' };
  }

  var patch = parseJson_(p.patch, null);
  if (!patch || !p.id) return { ok: false, error: 'id and patch required' };

  var current = getProgram_(p.id);
  if (!current.ok) return current;

  var merged = current.program, changed = [];
  EDITABLE_FIELDS.forEach(function (f) {
    if (!patch.hasOwnProperty(f)) return;
    if (JSON.stringify(merged[f]) === JSON.stringify(patch[f])) return;
    merged[f] = patch[f];
    changed.push(f);
  });
  if (!changed.length) return { ok: true, program_id: p.id, unchanged: true };

  var res = saveProgram_(merged, { editedBy: auth.user });
  res.changed = changed;
  res.edited_by = auth.user;
  return res;
}

/* Create a program from the Calculator. Same role gate as editing — a new program is a
   commitment to a vendor, not a scratch calculation. */
function createProgram_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot create SPIFF programs' };
  }

  var draft = parseJson_(p.program, null);
  if (!draft || !draft.program_name) return { ok: false, error: 'program_name required' };

  var id = slug_(draft.program_name) + '-' + today_().slice(0, 7).replace('-', '');
  if (getProgram_(id).ok) return { ok: false, error: 'A program with id "' + id + '" already exists' };

  draft.program_id = id;
  draft.title      = draft.program_name;
  draft.status     = 'draft';       // becomes active when Tawny starts it
  draft.source     = 'calculator-app:' + auth.user;
  draft.match_json = draft.match_json || { brand: draft.vendor || '', category: '', filter_text: '', products: [] };

  var res = saveProgram_(draft, { editedBy: auth.user });
  res.program_id = id;
  return res;
}

/* Validate a GX Core session token and resolve this user's role on `spiff`. */
function gxAuth_(token) {
  if (!token) return { ok: false, error: 'Not signed in' };
  try {
    var url = GXCORE_URL + '?action=validate&app=' + encodeURIComponent(APP) + '&token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return JSON.parse(res.getContentText());
  } catch (e) {
    return { ok: false, error: 'Could not reach GX Core to verify your session' };
  }
}

function programToRow_(p, audit) {
  var by = audit ? (audit.edited_by || '') : '';
  var at = audit ? (audit.edited_at || '') : '';
  return [
    p.program_id, p.vendor || '', p.program_name || '', p.title || '', p.status || 'draft',
    p.start_date || '', p.end_date || '', p.pay_period || '',
    JSON.stringify(p.match_json    || {}),
    JSON.stringify(p.stores_json   || []),
    JSON.stringify(p.cost_json     || {}),
    p.payout_type || 'flat',
    JSON.stringify(p.payout_json   || {}),
    JSON.stringify(p.baseline_json || {}),
    JSON.stringify(p.target_json   || {}),
    p.actual_json ? JSON.stringify(p.actual_json) : '',
    p.source || '', nowStamp_(), by, at, p.share_token || '',
    p.contact_name || '', p.contact_email || ''
  ];
}

function rowToProgram_(r) {
  return {
    program_id: r[0], vendor: r[1], program_name: r[2], title: r[3], status: r[4],
    start_date: textDate_(r[5]), end_date: textDate_(r[6]), pay_period: textDate_(r[7]),
    match_json:    parseJson_(r[8],  {}),
    stores_json:   parseJson_(r[9],  []),
    cost_json:     parseJson_(r[10], {}),
    payout_type:   r[11],
    payout_json:   parseJson_(r[12], {}),
    baseline_json: parseJson_(r[13], {}),
    target_json:   parseJson_(r[14], {}),
    actual_json:   parseJson_(r[15], null),
    source: r[16], updated_at: textDate_(r[17]),
    edited_by: r[18] || '', edited_at: textDate_(r[19]), share_token: r[20] || '',
    contact_name: r[21] || '', contact_email: r[22] || ''
  };
}

/* ---------------------------- PAYOUTS ---------------------------- *
 * The one rule the whole app turns on, lifted from the Calculator:
 * a budtender who reaches their individual target earns the flat SPIFF
 * amount. Total owed = amount × (budtenders who hit). In the sheet that
 * is "BT's = SPIFF 17" × "SPIFF $25" = "Investment $425".
 *
 * A budtender's target is their store's target divided across the
 * budtenders working that store — the sheet's "Target Sales Budtender".
 * ----------------------------------------------------------------- */

/**
 * @param {Array}  rows     [{ employee_id, name, store_id, units }]
 * @param {Object} targets  { store_id: targetUnitsPerBudtender }
 * @param {Object} payout   { type: 'flat', amount: 25 }
 * @return {Object} { ok, lines, hit, total_owed, total_units }
 */
function computePayouts_(rows, targets, payout) {
  if (!payout || payout.type !== 'flat') {
    return { ok: false, error: 'payout type "' + (payout && payout.type) + '" not implemented yet (flat only)' };
  }
  var amount = Number(payout.amount) || 0;
  var lines = [], hit = 0, totalUnits = 0;

  for (var i = 0; i < rows.length; i++) {
    var r      = rows[i];
    var target = Number(targets[r.store_id]) || 0;
    var units  = Number(r.units) || 0;
    var made   = target > 0 && units >= target;

    totalUnits += units;
    if (made) hit++;

    lines.push({
      employee_id: r.employee_id, name: r.name, store_id: r.store_id,
      units: units, target: target, hit: made, earned: made ? amount : 0
    });
  }
  return { ok: true, lines: lines, hit: hit, total_owed: hit * amount, total_units: totalUnits };
}

/* ---------------------------- GX CORE ---------------------------- */

/* ========================== VENDOR CLIENT VIEW =======================
 * A read-only link Tawny sends a vendor so they can see the proposal themselves.
 *
 * TWO gates, deliberately:
 *   1. an unguessable per-program token in the URL — so a link opens exactly ONE
 *      program. A shared password alone would mean Wyld's credentials open Grön's
 *      numbers, which is a competitor seeing another brand's costs and targets.
 *   2. the shared passphrase, so a forwarded link is not self-serving.
 *
 * The response is a hand-built subset. It never returns the stored row, so internal
 * fields (source, edited_by, other programs) cannot leak by accident when the schema
 * grows — a new column is invisible here until someone deliberately adds it.
 * ==================================================================== */

function clientView_(p) {
  var token = String(p.t || '').trim();
  var pass  = String(p.pass || '');
  var email = norm_(p.email || '');

  if (!email || !pass) return { ok: false, error: 'Enter your email and the password.' };

  // Cheap brute-force brake: a shared passphrase is guessable given time, and Apps
  // Script has no rate limiting of its own.
  var cache = CacheService.getScriptCache();
  var key   = 'cv_fail_' + (token || email);
  var fails = Number(cache.get(key) || 0);
  if (fails >= 8) return { ok: false, error: 'Too many attempts — try again later.' };

  var expected = PropertiesService.getScriptProperties().getProperty(CLIENT_PASS_PROP);
  if (!expected) return { ok: false, error: 'Vendor access is not set up yet.' };

  // One generic failure for a wrong password OR an unknown email — telling them apart
  // would let someone confirm which reps we work with.
  var deny = function () {
    cache.put(key, String(fails + 1), 900);
    return { ok: false, error: 'That email and password combination does not match an active proposal.' };
  };
  if (pass !== expected) return deny();

  var all = listProgramsCached_().filter(function (x) { return norm_(x.contact_email) === email; });

  var prog = null;
  if (token) {
    // The link scopes to one program AND the email must be that program's contact.
    for (var i = 0; i < all.length; i++) if (all[i].share_token === token) prog = all[i];
    if (!prog) return deny();
  } else {
    // No link: show what this rep is on. More than one, let them pick.
    var shared = all.filter(function (x) { return x.share_token; });
    if (!shared.length) return deny();
    if (shared.length > 1) {
      return { ok: true, choices: shared.map(function (x) {
        return { token: x.share_token, name: x.program_name || x.title, period: x.start_date || '' };
      }) };
    }
    prog = shared[0];
  }

  var t = prog.target_json || {}, b = prog.baseline_json || {}, a = prog.actual_json;
  var cost = (prog.cost_json || {}).per_unit || 0;
  var rate = (prog.payout_json || {}).amount || 0;

  // Store-level detail uses display names, not internal ids.
  var stores = gxStores_(), nameOf = {};
  stores.forEach(function (s) { nameOf[s.store_id] = s.display_name || s.store_id; });

  var byStore = (prog.stores_json || []).map(function (id) {
    return { store: nameOf[id] || id, baseline: (b.by_store || {})[id] || 0, target: (t.by_store || {})[id] || 0 };
  });

  var bts     = Object.keys(t.per_bt || {}).length ? sumVals_(b.by_store) : 0;
  var invest  = a ? (a.bts_hit || 0) * (a.spiff_amount || rate) : 0;
  var revInc  = ((t.units || 0) - (b.units || 0)) * cost;

  return {
    ok: true,
    program: {
      name: prog.program_name || prog.title,
      vendor: prog.vendor,
      contact_name: prog.contact_name || '',
      status: prog.status,
      start_date: prog.start_date,
      end_date: prog.end_date,
      cost_per_unit: cost,
      spiff_per_budtender: rate,
      baseline_units: b.units || 0,
      target_units: t.units || 0,
      unit_lift: (t.units || 0) - (b.units || 0),
      revenue_increase: revInc,
      by_store: byStore,
      // Results only once the program has actually closed.
      results: a ? {
        units_sold: a.units_sold, budtenders_hit: a.bts_hit,
        rate_paid: a.spiff_amount || rate, investment: invest
      } : null
    }
  };
}

function sumVals_(o) {
  var n = 0;
  Object.keys(o || {}).forEach(function (k) { n += Number(o[k]) || 0; });
  return n;
}

/* Mint (or reuse) a program's share token. Admin-gated — creating a link that exposes
   a program to an outside party is a write, not a read. */
function shareLink_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) return { ok: false, error: 'Your role cannot create vendor links' };

  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;

  if (p.revoke === '1') {
    prog.share_token = '';
    saveProgram_(prog, { editedBy: auth.user });
    return { ok: true, revoked: true };
  }

  if (!prog.share_token) {
    prog.share_token = Utilities.getUuid().replace(/-/g, '');
    saveProgram_(prog, { editedBy: auth.user });
  }
  return { ok: true, token: prog.share_token, program_id: prog.program_id };
}

/* ============================ CLOSE-OUT =============================
 * Tawny sends the vendor a report; the vendor credits us against the next buy; we turn
 * that credit into gift cards for the budtenders who hit their number.
 *
 * NOTHING IS SENT FROM HERE. The PDF is saved to Drive and the email is returned as
 * text for a human to send — that is a rule in CLAUDE.md, not an oversight.
 *
 * Format follows the precedent in the Drive folder ("SPIFF_Sales Report - Gron -
 * 092925.pdf"): header stats, then the per-budtender matrix. The matrix needs
 * per-budtender sell-through, which lands with Progress; until then the report renders
 * everything else and says plainly that the breakdown is missing rather than shipping a
 * vendor a blank grid.
 * ==================================================================== */

function reportHtml_(p, matrix) {
  var a    = p.actual_json || {};
  var t    = p.target_json || {};
  var rate = a.spiff_amount || (p.payout_json || {}).amount || 0;
  var owed = (a.bts_hit || 0) * rate;
  var esc  = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  var money = function (n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  var storeRows = (p.stores_json || []).map(function (s) {
    var tgt = (t.by_store || {})[s] || 0;
    var act = matrix && matrix.by_store ? (matrix.by_store[s] || 0) : null;
    return '<tr><td>' + esc(s) + '</td><td class="n">' + tgt + '</td><td class="n">'
      + (act == null ? '&mdash;' : act) + '</td></tr>';
  }).join('');

  var matrixHtml = matrix && matrix.rows && matrix.rows.length
    ? '<h2>By budtender</h2><table><tr><th>Budtender</th><th>Store</th><th class="n">Units</th><th class="n">Target</th><th>Hit</th></tr>'
      + matrix.rows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.store_id) + '</td><td class="n">' + r.units
            + '</td><td class="n">' + r.target + '</td><td>' + (r.hit ? '✓' : '') + '</td></tr>';
        }).join('') + '</table>'
    : '<p class="note">Per-budtender breakdown is not included: this program\'s sell-through was '
      + 'recorded in aggregate. Programs tracked in SPIFF carry the full budtender matrix.</p>';

  return '<html><head><meta charset="utf-8"><style>'
    + 'body{font-family:Helvetica,Arial,sans-serif;color:#111;margin:36px}'
    + 'h1{font-size:18px;margin:0 0 2px} h2{font-size:13px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:#555}'
    + '.sub{color:#666;font-size:12px;margin:0 0 18px}'
    + '.stats{display:flex;gap:28px;margin:0 0 8px} .stat{}'
    + '.stat b{display:block;font-size:22px} .stat span{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}'
    + 'table{border-collapse:collapse;width:100%;font-size:12px} th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}'
    + 'th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#666} .n{text-align:right}'
    + '.owed{margin-top:18px;padding:12px 14px;border:2px solid #111;display:inline-block}'
    + '.owed b{font-size:20px} .note{font-size:11px;color:#666;font-style:italic}'
    + '</style></head><body>'
    + '<h1>Green Cross SPIFF Performance Report</h1>'
    + '<p class="sub">' + esc(p.program_name || p.title) + ' &middot; ' + esc(p.vendor)
    +   (p.start_date ? ' &middot; ' + esc(p.start_date) + ' to ' + esc(p.end_date || '') : '') + '</p>'
    + '<div class="stats">'
    +   '<div class="stat"><b>' + (a.units_sold || 0).toLocaleString() + '</b><span>Units sold</span></div>'
    +   '<div class="stat"><b>' + (t.units || 0).toLocaleString() + '</b><span>Target</span></div>'
    +   '<div class="stat"><b>' + (a.bts_hit || 0) + '</b><span>Budtenders hit</span></div>'
    +   '<div class="stat"><b>' + money(rate) + '</b><span>SPIFF each</span></div>'
    + '</div>'
    + '<div class="owed"><span>Credit due Green Cross</span><br><b>' + money(owed) + '</b>'
    +   '<br><span>' + (a.bts_hit || 0) + ' budtenders × ' + money(rate) + '</span></div>'
    + '<h2>By store</h2><table><tr><th>Store</th><th class="n">Target</th><th class="n">Sold</th></tr>' + storeRows + '</table>'
    + matrixHtml
    + '<p class="note">Generated by Green Cross SPIFF on ' + today_() + '.</p>'
    + '</body></html>';
}

/* Save the vendor PDF to the close-out folder. Filename follows the precedent already in
   that folder: "SPIFF_Sales Report - <Vendor> - MMDDYY.pdf". */
function buildReport_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) return { ok: false, error: 'Your role cannot file reports' };

  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;

  var d    = new Date();
  var mmddyy = Utilities.formatDate(d, 'America/Los_Angeles', 'MMddyy');
  var name = 'SPIFF_Sales Report - ' + (prog.vendor || prog.title) + ' - ' + mmddyy + '.pdf';

  try {
    var blob   = Utilities.newBlob(reportHtml_(prog, null), 'text/html', 'r.html').getAs('application/pdf').setName(name);
    var folder = DriveApp.getFolderById(REPORT_FOLDER_ID);
    var file   = folder.createFile(blob);
    return { ok: true, name: name, file_id: file.getId(), url: file.getUrl(), by: auth.user };
  } catch (e) {
    return { ok: false, error: 'Could not write to the reports folder: ' + (e && e.message || e) };
  }
}

/* The vendor email, as TEXT for a human to send. The engine has no send capability and
   should not get one — a vendor hears from Tawny, not from an app. */
function emailDraft_(p) {
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program, a = prog.actual_json || {}, t = prog.target_json || {};
  var rate = a.spiff_amount || (prog.payout_json || {}).amount || 0;
  var owed = (a.bts_hit || 0) * rate;
  var m    = function (n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  var period = prog.start_date ? prog.start_date + ' through ' + (prog.end_date || '') : 'the program period';
  var hitPct = t.units ? Math.round((a.units_sold || 0) / t.units * 100) : null;

  return {
    ok: true,
    subject: 'SPIFF results — ' + (prog.program_name || prog.title) + ' (' + (prog.vendor || '') + ')',
    body:
      'Hi,\n\n' +
      'Here are the final numbers for the ' + (prog.program_name || prog.title) + ' SPIFF, ' + period + '.\n\n' +
      '  Units sold:        ' + (a.units_sold || 0).toLocaleString() +
        (t.units ? '  (target ' + t.units.toLocaleString() + (hitPct != null ? ', ' + hitPct + '% of goal' : '') + ')' : '') + '\n' +
      '  Budtenders who hit their target: ' + (a.bts_hit || 0) + '\n' +
      '  SPIFF per budtender: ' + m(rate) + '\n' +
      '  Total credit due:  ' + m(owed) + '\n\n' +
      'The full report is attached. Please apply ' + m(owed) + ' as a credit against our next order.\n\n' +
      'Thanks for supporting the team —\n\n' +
      'Tawny\nGreen Cross Cannabis Emporium\n',
    attach_hint: 'Attach the PDF saved to the SPIFF close-out folder in Drive.'
  };
}

/* Who gets a gift card, and for how much. Needs per-budtender sell-through, so for
   aggregate-only historical programs it reports the total and says what is missing
   rather than inventing a split. */
function giftCardList_(p) {
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program, a = prog.actual_json || {};
  var rate = a.spiff_amount || (prog.payout_json || {}).amount || 0;

  return {
    ok: true,
    program: prog.program_name || prog.title,
    rate: rate,
    count: a.bts_hit || 0,
    total: (a.bts_hit || 0) * rate,
    lines: [],   // filled from Progress once per-budtender sell-through is available
    note: 'Per-budtender names require sell-through detail (Progress). This program recorded '
        + (a.bts_hit || 0) + ' budtenders at ' + rate + ' each.'
  };
}

/* Is the GXCore library reachable, and what does it actually see from here? Libraries run
   in the CALLER's context, so this distinguishes "we can't read GX Core" from "the tab is
   empty" — two failures that look identical from the outside. */
function diag_() {
  var d = { app: APP, ts: nowStamp_() };
  try { d.stores    = (GXCore.getStores()    || []).length; } catch (e) { d.stores    = 'ERR ' + e.message; }
  try { d.employees = (GXCore.getEmployees() || []).length; } catch (e) { d.employees = 'ERR ' + e.message; }
  try { d.products  = (GXCore.getProducts()  || []).length; } catch (e) { d.products  = 'ERR ' + e.message; }
  // Reports write into a folder this script did not create, which needs the full drive
  // scope — drive.file would silently only cover our own files.
  try { d.reportFolder = DriveApp.getFolderById(REPORT_FOLDER_ID).getName(); }
  catch (e) { d.reportFolder = 'ERR ' + (e && e.message || e); }
  return d;
}

/* The roster. GX Core exposes NO public `employees` HTTP action — it lives behind the
   bound GXCore library, so only an engine can read it (the browser cannot). SPIFF reads
   it and never writes it; the Command Center owns the roster.

   Returns the active staff plus a per-store headcount, which is what the Calculator needs
   for per-budtender targets and what payouts will need for attribution. */
function gxEmployees_(opts) {
  opts = opts || {};
  var rows;
  try {
    rows = GXCore.getEmployees() || [];
  } catch (e) {
    return { ok: false, error: 'GXCore library unavailable: ' + (e && e.message || e) };
  }

  var out = [], byStore = {}, roles = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var status = String(r.status || 'active').toLowerCase();
    if (status !== 'active' && status !== 'true' && status !== '') continue;

    var store = slug_(r.home_store || '');
    var role  = String(r.role_title || '').trim();
    roles[role || '(blank)'] = (roles[role || '(blank)'] || 0) + 1;

    out.push({
      employee_id: r.employee_id, full_name: r.full_name, home_store: store,
      dutchie_employee_id: r.dutchie_employee_id || '', role_title: role
    });
    if (store) byStore[store] = (byStore[store] || 0) + 1;
  }
  return { ok: true, employees: out, by_store: byStore, roles: roles, count: out.length };
}

// Stores are shared truth — pulled, never hardcoded, so Command Center edits flow through.
function gxStores_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gx_stores');
  if (hit) return JSON.parse(hit);

  var res  = UrlFetchApp.fetch(GXCORE_URL + '?action=stores', { muteHttpExceptions: true, followRedirects: true });
  var data = JSON.parse(res.getContentText());
  var stores = data.stores || [];
  cache.put('gx_stores', JSON.stringify(stores), 900);
  return stores;
}

/* The sheets label stores inconsistently — the Calculator says "Portland" and
   "River", the Sales Report shouts "BASELINE"/"CENTURY". Match against every
   name GX Core knows (store_id, display_name, dutchie_name, short_code) so both
   spellings resolve to one canonical store_id. */
function matchStore_(label, stores) {
  var want = norm_(label);
  if (!want) return null;

  for (var i = 0; i < stores.length; i++) {
    var s = stores[i];
    if ([s.store_id, s.display_name, s.dutchie_name, s.short_code].some(function (n) { return norm_(n) === want; })) {
      return s.store_id;
    }
  }
  // "Portland" → "Portland Rd", "River" → "River Rd"
  for (var j = 0; j < stores.length; j++) {
    var t = stores[j];
    if ([t.store_id, t.display_name, t.dutchie_name].some(function (n) {
      var v = norm_(n);
      return v && (v.indexOf(want) === 0 || want.indexOf(v) === 0);
    })) return t.store_id;
  }
  return null;
}

/* ----------------------------- HELPERS ---------------------------- */

// Actions that are scoped and routed but not yet built. Explicit beats a silent
// empty response — the front end can say what is missing instead of blanking.
function notImplemented_(action) {
  return { ok: false, error: 'NOT_IMPLEMENTED', action: action,
           hint: 'Scoped but not built — see /gxwhatsnext for the build order.' };
}

function norm_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }

function num_(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/[$,%\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return isNaN(n) ? 0 : n;
}

function slug_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* Tab names carry the program's period as an MMYY suffix — 'National 0825' ran in
   Aug 2025, 'Buddies 0626-0726' spans Jun–Jul 2026. That is the only date the
   Calculator records, and History ("what did we run 9 pay periods ago", "last time
   we did Wyld") is built on it, so it gets parsed rather than discarded.
   Returns { vendor, start_date, end_date } with dates as TEXT. */
function periodOf_(title) {
  var t = String(title).trim();
  var m = t.match(/\s(\d{4})(?:\s*[-–]\s*(\d{4}))?\s*$/);
  if (!m) return { vendor: cleanVendor_(t), start_date: '', end_date: '' };

  var from = mmyy_(m[1]);
  var to   = m[2] ? mmyy_(m[2]) : from;
  if (!from || !to) return { vendor: cleanVendor_(t), start_date: '', end_date: '' };

  return {
    vendor:     cleanVendor_(t.slice(0, m.index)),
    start_date: from.y + '-' + pad2_(from.m) + '-01',
    end_date:   to.y + '-' + pad2_(to.m) + '-' + pad2_(new Date(to.y, to.m, 0).getDate())
  };
}

// '0825' → Aug 2025. Rejects anything whose month isn't 01–12 (so a SKU count
// like '10pc' or a stray year never gets read as a period).
function mmyy_(s) {
  var mo = parseInt(s.slice(0, 2), 10), yr = parseInt(s.slice(2), 10);
  if (!(mo >= 1 && mo <= 12)) return null;
  return { m: mo, y: 2000 + yr };
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/* Belt to forceTextDates_'s braces: any Date that already made it into the sheet (or
   sneaks in later) reads back as 'YYYY-MM-DD' rather than an ISO timestamp. */
function textDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}

// 'Gron Chocolate - Ratio 10pks' → 'Gron';  'Mule Extracts -' → 'Mule Extracts'
function cleanVendor_(s) {
  var t = String(s).split(/\s+[-–]\s+/)[0];
  t = t.replace(/\s+(all skus|all products|\d+\s*p(c|k)s?|carts?.*|joints?.*)$/i, '');
  return t.replace(/[\s\-–]+$/, '').trim() || String(s).trim();
}

function findCellCol_(grid, label) {
  var want = norm_(label);
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c < grid[r].length; c++) if (norm_(grid[r][c]) === want) return c;
  }
  return -1;
}

/* Value for `label` = first non-empty cell to its right, searched only within
   [cMin, cMax] so a plan label never picks up its actuals twin. */
function findVal_(grid, label, cMin, cMax) {
  var want = norm_(label);
  for (var r = 0; r < grid.length; r++) {
    var lim = Math.min(cMax, grid[r].length - 1);
    for (var c = cMin; c <= lim; c++) {
      if (norm_(grid[r][c]) !== want) continue;
      for (var k = c + 1; k <= Math.min(lim + 2, grid[r].length - 1); k++) {
        if (grid[r][k] !== '' && grid[r][k] != null) return grid[r][k];
      }
    }
  }
  return null;
}

function maxCols_(grid) {
  var m = 0;
  for (var r = 0; r < grid.length; r++) m = Math.max(m, grid[r].length);
  return m;
}

function parseJson_(s, fallback) {
  if (s === '' || s == null) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// Dates are TEXT everywhere (YYYY-MM-DD); a sheet/script timezone mismatch silently
// shifts real Date objects by a day. Learned the hard way — see gx-conventions.md.
function today_()    { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }
function nowStamp_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss'); }

function reply_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* One-time authorize: run in the editor once to grant scopes. Safe to re-run,
   and required again after any scope change. */
function authorize() {
  var report = { app: APP, ts: nowStamp_() };
  try { report.reportFolder = DriveApp.getFolderById(REPORT_FOLDER_ID).getName(); }
  catch (e) { report.reportFolder = 'ERR ' + e.message; }
  try { report.calculator = SpreadsheetApp.openById(CALCULATOR_SHEET_ID).getName(); }
  catch (e) { report.calculator = 'ERR ' + e.message; }
  try { report.stores = gxStores_().length + ' stores'; }
  catch (e) { report.stores = 'ERR ' + e.message; }
  Logger.log('Authorized. ' + JSON.stringify(report));
  return report;
}
