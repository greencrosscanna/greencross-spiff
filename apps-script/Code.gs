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
 * A program, as stored (one row per program):
 *
 *   program_id     slug, e.g. 'wyld-10pc-2026-08'
 *   vendor         'Wyld'
 *   title          'Wyld 10pc'
 *   status         draft | active | closed
 *   start_date     TEXT 'YYYY-MM-DD'   (dates are TEXT, never Date objects)
 *   end_date       TEXT 'YYYY-MM-DD'
 *   pay_period     TEXT 'YYYY-MM-DD'   (pay-period start — joins to Leaderboard)
 *   match_json     { brand, category, filter_text, products[] }  ← mirrors the
 *                  Sales Report's Brand + Category + Filter Text + up to 4 Products
 *   stores_json    [store_id, …]        participating stores (GX Core store_ids)
 *   cost_json      { mode: 'flat'|'blended', per_unit, skus:[{sku, cost}] }
 *                  blended covers the sheet's "Combined WS Cost" / "Average Cost" cases
 *   payout_type    flat | per_unit | tiered
 *   payout_json    flat:     { amount }                     ← every historical program
 *                  per_unit: { per_unit }                   ← declared, not yet implemented
 *                  tiered:   { tiers: [{units, amount}] }   ← declared, not yet implemented
 *   baseline_json  { units, revenue, by_store: { store_id: units } }  pre-SPIFF period
 *   target_json    { units, revenue, by_store: { store_id: units } }  goal
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

/* ---------------------------- ROUTER ---------------------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    switch (p.action) {
      case 'ping':        out = { ok: true, app: APP, ts: nowStamp_() };        break;
      case 'programs':    out = notImplemented_('programs');                    break;
      case 'program':     out = notImplemented_('program');                     break;
      case 'sellthrough': out = notImplemented_('sellthrough');                 break;
      case 'payouts':     out = notImplemented_('payouts');                     break;
      case 'history':     out = notImplemented_('history');                     break;
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
      case 'saveProgram':   out = notImplemented_('saveProgram');   break;
      case 'closeProgram':  out = notImplemented_('closeProgram');  break;
      case 'importCalc':    out = notImplemented_('importCalc');    break;
      case 'buildReport':   out = notImplemented_('buildReport');   break;
      case 'draftEmail':    out = notImplemented_('draftEmail');    break;
      case 'pushPayouts':   out = notImplemented_('pushPayouts');   break;
      default:              out = { ok: false, error: 'Unknown action: ' + (body.action || '(none)') };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return reply_(out, null);
}

/* ---------------------------- PAYOUTS ---------------------------- *
 * The one rule the whole app turns on, lifted from the Calculator:
 * a budtender who reaches their individual target earns the flat SPIFF
 * amount. Total owed = amount × (budtenders who hit). In the sheet that
 * is "BT's = SPIFF 17" × "SPIFF $25" = "Investment $425".
 *
 * A budtender's target is their store's target divided across the
 * budtenders working that store, rounded up — the sheet's
 * "Target Sales Budtender" column.
 * ----------------------------------------------------------------- */

/**
 * @param {Array} rows      [{ employee_id, name, store_id, units }]
 * @param {Object} targets  { store_id: targetUnitsPerBudtender }
 * @param {Object} payout   { type: 'flat', amount: 25 }
 * @return {Object} { ok, lines:[…], hit, total_owed, total_units }
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
      employee_id: r.employee_id,
      name:        r.name,
      store_id:    r.store_id,
      units:       units,
      target:      target,
      hit:         made,
      earned:      made ? amount : 0
    });
  }

  return {
    ok:          true,
    lines:       lines,
    hit:         hit,
    total_owed:  hit * amount,
    total_units: totalUnits
  };
}

/* ----------------------------- HELPERS ---------------------------- */

// Actions that are scoped and routed but not yet built. Explicit beats a silent
// empty response — the front end can say what is missing instead of blanking.
function notImplemented_(action) {
  return { ok: false, error: 'NOT_IMPLEMENTED', action: action,
           hint: 'Scoped but not built — see /gxwhatsnext for the build order.' };
}

// Dates are TEXT everywhere (YYYY-MM-DD); a sheet/script timezone mismatch silently
// shifts real Date objects by a day. Learned the hard way — see gx-conventions.md.
function today_() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
}

function reply_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* One-time authorize: run in the editor once to grant scopes. Safe to re-run,
   and required again after any scope change. */
function authorize() {
  var report = { app: APP, ts: nowStamp_() };
  try {
    report.reportFolder = DriveApp.getFolderById(REPORT_FOLDER_ID).getName();
  } catch (e) { report.reportFolder = 'ERR ' + e.message; }
  try {
    var r = UrlFetchApp.fetch(GXCORE_URL + '?action=stores', { muteHttpExceptions: true });
    report.gxcore = 'HTTP ' + r.getResponseCode();
  } catch (e) { report.gxcore = 'ERR ' + e.message; }
  Logger.log('Authorized. ' + JSON.stringify(report));
  return report;
}
