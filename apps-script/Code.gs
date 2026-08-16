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
  'program_id', 'vendor', 'title', 'status', 'start_date', 'end_date', 'pay_period',
  'match_json', 'stores_json', 'cost_json', 'payout_type', 'payout_json',
  'baseline_json', 'target_json', 'actual_json', 'source', 'updated_at'
];

/* ---------------------------- ROUTER ---------------------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    switch (p.action) {
      case 'ping':        out = { ok: true, app: APP, ts: nowStamp_() };            break;
      case 'programs':    out = { ok: true, programs: listPrograms_() };            break;
      case 'program':     out = getProgram_(p.id);                                  break;
      case 'previewCalc': out = importCalculator_({ save: false });                 break;
      // Writes ride on GET because the browser calls this cross-origin via JSONP —
      // Apps Script serves no CORS headers for POST. Same pattern GX Core uses.
      case 'importCalc':  out = importCalculator_({ save: true });                  break;
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
      case 'closeProgram':  out = notImplemented_('closeProgram');    break;
      case 'buildReport':   out = notImplemented_('buildReport');     break;
      case 'draftEmail':    out = notImplemented_('draftEmail');      break;
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

  if (opts.save) out.forEach(function (p) { saveProgram_(p); });

  return { ok: true, imported: out.length, saved: !!opts.save, skipped: skipped, programs: out };
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

  return {
    program_id:    slug_(name),
    vendor:        vendorOf_(name),
    title:         name,
    status:        actual ? 'closed' : 'draft',
    start_date:    '',            // the Calculator carries no dates — set on activation
    end_date:      '',
    pay_period:    '',
    match_json:    { brand: vendorOf_(name), category: '', filter_text: '', products: [] },
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
  return sh;
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
  var all = listPrograms_();
  for (var i = 0; i < all.length; i++) if (all[i].program_id === id) return { ok: true, program: all[i] };
  return { ok: false, error: 'not found: ' + id };
}

/* Upsert by program_id — re-running the import updates rows instead of duplicating them. */
function saveProgram_(p) {
  if (!p || !p.program_id) return { ok: false, error: 'program_id required' };
  var sh   = dataSheet_();
  var row  = programToRow_(p);
  var last = sh.getLastRow();

  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === p.program_id) {
        sh.getRange(i + 2, 1, 1, PROGRAM_HEADERS.length).setValues([row]);
        return { ok: true, program_id: p.program_id, updated: true };
      }
    }
  }
  sh.appendRow(row);
  return { ok: true, program_id: p.program_id, created: true };
}

function programToRow_(p) {
  return [
    p.program_id, p.vendor || '', p.title || '', p.status || 'draft',
    p.start_date || '', p.end_date || '', p.pay_period || '',
    JSON.stringify(p.match_json    || {}),
    JSON.stringify(p.stores_json   || []),
    JSON.stringify(p.cost_json     || {}),
    p.payout_type || 'flat',
    JSON.stringify(p.payout_json   || {}),
    JSON.stringify(p.baseline_json || {}),
    JSON.stringify(p.target_json   || {}),
    p.actual_json ? JSON.stringify(p.actual_json) : '',
    p.source || '', nowStamp_()
  ];
}

function rowToProgram_(r) {
  return {
    program_id: r[0], vendor: r[1], title: r[2], status: r[3],
    start_date: r[4], end_date: r[5], pay_period: r[6],
    match_json:    parseJson_(r[7],  {}),
    stores_json:   parseJson_(r[8],  []),
    cost_json:     parseJson_(r[9],  {}),
    payout_type:   r[10],
    payout_json:   parseJson_(r[11], {}),
    baseline_json: parseJson_(r[12], {}),
    target_json:   parseJson_(r[13], {}),
    actual_json:   parseJson_(r[14], null),
    source: r[15], updated_at: r[16]
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

// 'Gron Chocolate - Ratio 10pks' → 'Gron';  'Wyld 10pc' → 'Wyld'
function vendorOf_(title) {
  var t = String(title).split(/\s+[-–]\s+/)[0];
  return t.replace(/\s+(all skus|all products|\d+\s*p(c|k)s?|carts?.*|joints?.*)$/i, '').trim() || t.trim();
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
