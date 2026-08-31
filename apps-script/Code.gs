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
 * It keeps payout data in ITS OWN sheet. It does NOT write a
 * `spiff_payouts` tab in GX Core — corrected 2026-08-22; no such tab
 * exists, nothing writes one, and nothing reads one. This header
 * previously claimed Leaderboard's Incentive tab consumed it; that
 * tab is about DISCOUNT RATE and is unrelated. If a cross-app payout
 * hand-off is ever built, add the tab to GX_TABS and a contract test
 * before writing it down as fact.
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

var PROGRAMS_TAB = 'programs';
var PROGRAM_HEADERS = [
  'program_id', 'vendor', 'program_name', 'title', 'status', 'start_date', 'end_date', 'pay_period',
  'match_json', 'stores_json', 'cost_json', 'payout_type', 'payout_json',
  'baseline_json', 'target_json', 'actual_json', 'source', 'updated_at',
  'edited_by', 'edited_at', 'share_token', 'contact_name', 'contact_email', 'doc_json'
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
//
// MANAGER IS EXCLUDED ON PURPOSE -- intent, not drift. Sky ruled it 2026-08-20, after
// pricecards flagged that Core's GX_EDIT_ROLES also counts `manager`. A SPIFF program is a
// vendor negotiation with real payout dollars behind it, so editing one is Tawny-and-above.
// The ~12 store managers are the audience for the READ-ONLY employee flyer, not for changing
// vendor terms. Deliberately narrower than Core, which is the safe direction: a local
// allowlist narrower than the canonical one can fail closed but never open.
var EDIT_ROLES = ['admin', 'editor', 'director'];

// Fields a human may change on an imported record. Everything else (ids, source,
// audit columns) is engine-owned.
var EDITABLE_FIELDS = [
  'vendor', 'program_name', 'status', 'start_date', 'end_date', 'pay_period',
  'payout_json', 'cost_json', 'target_json', 'baseline_json', 'actual_json',
  'contact_name', 'contact_email'
];

/* Which GXCore version THIS DEPLOYMENT is bound to, over HTTP. Requested by inventory, and it
   answers the question that cost us fifteen versions of drift: appsscript.json at HEAD, gx_core.gs
   as it reads today, and what the live deployment actually runs can all disagree, and pushing a pin
   without deploying looks identical to success from the push output.

   Ungated on purpose (it leaks one integer) and it REPORTS its errors rather than throwing: a
   pre-v153 pin has no libVersion(), and letting that blow up would break the diagnostic exactly
   when it matters most. Compare against GX Core's public ?action=health.lib_version. */
function libVersion_() {
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'GXCore not bound' };
    if (typeof GXCore.libVersion !== 'function') return { ok: false, error: 'pinned GXCore has no libVersion() - pre-v153' };
    return { ok: true, app: APP, gxcore: GXCore.libVersion() };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ------------------------- WHO MAY CALL WHAT -------------------------
 * These reads used to require NOTHING. The frontend's sign-in gate is real, but
 * the gate and the data live on different servers, so being signed in was never
 * a precondition for reading -- the same shape GX Core found in Price Cards'
 * writes, on our read side. With no token at all these returned the full roster,
 * per-budtender sell-through (names, dutchie ids, units, revenue, who hit) and
 * program payout totals to anyone holding the /exec URL, which ships in
 * index.html on public GitHub Pages. "You would need the URL" is not a control.
 *
 * `ping` and `diag` stay OPEN deliberately: they are the health checks the deploy
 * loop verifies a re-pin against, and they report counts and a library version,
 * never a person. `clientView` keeps its own two gates (per-program token +
 * passphrase) because vendors have no GX Core account. `flyer` authenticates
 * itself, because it also has to resolve WHICH employee is asking.
 */
/* PUBLIC is a SHORT CLOSED LIST; everything else needs a live GX Core session with a grant
   on spiff. This started life the other way round -- a list of what to PROTECT -- and
   pricecards' finding is what turned it around. Their bug was a lookup table used as a
   whitelist, but the transferable lesson is about which way a gate FAILS when someone
   forgets a line:

     list what to protect  -> forget one, and a new action is PUBLIC. Silent, and the
                              payload is whatever sits after the switch.
     list what is public   -> forget one, and a new action is merely UNREACHABLE, which
                              whoever added it reports within a minute.

   Only one of those failure modes shows up on its own. So: private by default.

   `ping`, `diag` and `libversion` are health checks the deploy loop verifies a re-pin
   against -- they report counts and a library version, never a person, and needing a
   session to ask "did my deploy land" is how a check stops being run. `clientView` keeps
   its own two gates (per-program token + passphrase) because vendors have no GX Core
   account. `flyer` authenticates itself, because it must resolve WHICH employee is asking.

   Spiff is NOT exposed to pricecards' actual bug -- the router is a switch with an explicit
   default, so ?action=toString and ?action=__proto__ answer "Unknown action" rather than
   falling through. Verified against live, all six inherited names. A switch is immune where
   a map lookup is not. */
var PUBLIC_ACTIONS = ['ping', 'diag', 'libversion', 'clientView', 'flyer'];

/* Actions that additionally need an editor role. The rest of the write surface checks its own
   role after this, because each has its own message about what the role cannot do.
   EMPTY since 2026-08-30: its only member was `importCalc`, and the Calculator-sheet import was
   removed with the rest of the seed machinery. The gate stays because the next editor-only write
   will want it, and re-deriving it from the auth flow is harder than leaving one empty list. */
var GATED_WRITES = [];

/* Returns null when the call may proceed, or the response to send when it may not. Forwards
   GX Core's stable `code` untouched so the browser can tell "no grant" from "expired". */
/* MACHINE ROUTES: a valid deploy secret instead of a session. Leaderboard's kiosk and GX Crew's
   engine both read the progress cache and neither has a browser to sign in with — and every route
   here is rejected as "Not signed in" before its handler runs, which is how the first attempt at
   this looked like a broken route rather than a missing gate.
   Deliberately NOT added to PUBLIC_ACTIONS: these handlers check the secret themselves, so listing
   them as public would work today and be one careless edit away from an open payroll read. This
   says what they actually are. */
/* `progress` READS the cache and is token-gated like every other read, so a signed-in browser
   can show it — it is the same sell-through the Progress tab renders live, just cheaper. The two
   that stay secret-only both COST something: refreshProgress walks every store's date windows
   (~57s measured) and installProgressTrigger changes the schedule. A deploy secret still opens
   all three; see guard_. */
var SECRET_ACTIONS = ['refreshProgress', 'installProgressTrigger', 'rollStatuses'];

function guard_(action, p) {
  if (PUBLIC_ACTIONS.indexOf(action) >= 0) return null;
  if (SECRET_ACTIONS.indexOf(action) >= 0) {
    var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
    if (!want) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' };
    if (String(p.secret || '') === want) return null;      // the handler re-checks; belt and braces
    return { ok: false, error: 'Unauthorized' };
  }
  /* A correct deploy secret satisfies a token-gated route too. The secret is strictly MORE
     privileged than a user session — server-only, never in the repo, and it already opens every
     SECRET_ACTION — so demanding a browser session on top of it buys nothing and makes these
     routes impossible to verify from a terminal without borrowing someone's password.
     Compared against the STORED value, never against a blank: a script with no GX_DEPLOY_SECRET
     set must not be openable by sending an empty `secret=`. */
  var deploySecret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (deploySecret && p.secret && String(p.secret) === deploySecret) return null;

  var auth = gxAuth_(p.token);
  if (!auth.ok) {
    return { ok: false, error: auth.error || 'Not signed in',
             code: auth.code || 'auth_required', needsAuth: true };
  }
  if (GATED_WRITES.indexOf(action) >= 0 && EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot import SPIFF programs' };
  }
  return null;
}

/* ---------------------------- ROUTER ---------------------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    var denied = guard_(p.action, p);
    if (denied) return reply_(denied, p.callback);
    switch (p.action) {
      case 'ping':        out = { ok: true, app: APP, ts: nowStamp_() };            break;
      case 'libversion': out = libVersion_();                                        break;
      case 'programs':    out = { ok: true, programs: listProgramsCached_() };      break;
      case 'program':     out = getProgram_(p.id);                                  break;
      /* Bug reports ride GET for the same reason. Signed in but NOT in GATED_WRITES —
         a viewer must be able to report. Files under app=spiff / tab=spiff; see reportBug_. */
      case 'bugreport':   out = reportBug_(p);                                      break;
      case 'editProgram': out = editProgram_(p);                                    break;
      case 'createProgram': out = createProgram_(p);                                break;
      case 'employees':   out = gxEmployees_();                                     break;
      case 'diag':        out = diag_();                                            break;
      case 'buildReport': out = buildReport_(p);                                    break;
      case 'emailDraft':  out = emailDraft_(p);                                     break;
      case 'giftCards':   out = giftCardList_(p);                                   break;
      case 'clientView':  out = clientView_(p);                                     break;
      case 'shareLink':   out = shareLink_(p);                                      break;
      case 'sellthrough': out = sellthrough_(p);                                    break;
      case 'catalog':     out = catalog_(p);                                        break;
      case 'refunits':    out = refUnits_(p);                                       break;
      // The progress cache — the fast read GX Crew's incentive column and Leaderboard's kiosk
      // ticks both use. Secret-gated: a kiosk holds no session and Crew's engine has no browser.
      case 'progress':    out = spiffProgress_(p);                                   break;
      /* ONE STORE PER CALL. A full sweep is ~9s per store and /exec is killed at 60s — asking for
         all of them timed out with nothing written and no error to read, which is the worst of both.
         Called WITHOUT a store this returns the PLAN (every program × store pair) so a caller can
         loop and watch it fill, exactly as the Progress grid already does. The hourly trigger still
         does the whole sweep, because a trigger gets six minutes. */
      case 'refreshProgress':
        out = (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP))
              ? { ok: false, error: 'Unauthorized' }
              : (p.store ? refreshSpiffProgress_(p.program || '', p.store)
                         : refreshProgressPlan_(p.program || ''));
        break;
      /* Manual run of the same roll the hourly trigger does. Secret-gated because it WRITES, and
         `dry=1` reports what it would change without touching a row -- the safe way to see what a
         date correction is about to do. */
      case 'rollStatuses':
        out = (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP))
              ? { ok: false, error: 'Unauthorized' }
              : rollProgramStatuses_({ dryRun: String(p.dry || '') === '1' });
        break;
      case 'installProgressTrigger':
        out = (String(p.secret || '') === PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP)
               && String(p.confirm || '') === 'yes')
              ? installSpiffProgressTrigger() : { ok: false, error: 'Unauthorized or missing confirm=yes' };
        break;
      case 'payouts':     out = notImplemented_('payouts');                         break;
      case 'history':     out = { ok: true, programs: listPrograms_('closed') };    break;
      case 'flyer':       out = flyer_(p);                                          break;
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
    /* Every doPost action is a write, and saveProgram / importCalc checked nobody at all.
       Nothing in the frontend uses doPost -- the browser calls this engine cross-origin via
       JSONP, which is GET-only -- so this path was an unauthenticated write surface reachable
       by anyone with curl and the URL, serving no caller. Gate the lot. */
    var auth = gxAuth_(body.token);
    if (!auth.ok) {
      return reply_({ ok: false, error: auth.error || 'Not signed in',
                      code: auth.code || 'auth_required', needsAuth: true }, null);
    }
    if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
      return reply_({ ok: false, error: 'Your role (' + auth.role + ') cannot write SPIFF records' }, null);
    }
    switch (body.action) {
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
  var seen = Object.create(null);   // keyed by joined actuals; null-proto so no key can inherit
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
    // patch is JSON.parse'd from the request: a key literally named "hasOwnProperty" would
    // shadow the method and turn this into a TypeError. Call it off the prototype instead.
    if (!Object.prototype.hasOwnProperty.call(patch, f)) return;
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

/* Validate a GX Core session token and resolve this user's role on `spiff`.
   Memoised for the life of ONE execution: guard_ now validates before the switch, and the
   write functions still check their own role afterwards, so without this every write would
   pay two ~1s round trips to Core to ask the same question twice.

   Object.create(null), not {} -- this is a map indexed by RAW USER INPUT, the exact shape
   pricecards got bitten by. With a plain object, token='toString' would hit the inherited
   function, return it as the cached answer, and `auth.ok` would read undefined. That happens
   to fail CLOSED here, but relying on which way an accident falls is not a control. */
var _authMemo = Object.create(null);
function gxAuth_(token) {
  if (!token) return { ok: false, error: 'Not signed in' };
  if (_authMemo[token]) return _authMemo[token];
  try {
    var url = GXCORE_URL + '?action=validate&app=' + encodeURIComponent(APP) + '&token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var parsed = JSON.parse(res.getContentText());
    _authMemo[token] = parsed;
    return parsed;
  } catch (e) {
    /* Deliberately NOT memoised: a transient Core hiccup must not pin this execution into a
       failure it would recover from on the next call. */
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
    p.contact_name || '', p.contact_email || '', JSON.stringify(p.doc_json || {})
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
    contact_name: r[21] || '', contact_email: r[22] || '', doc_json: parseJson_(r[23], {})
  };
}

/* ============================ PROGRESS CACHE ============================
 * Sky, 2026-08-27: SPIFF should track live data, and LB and Crew read it on request. On the kiosk
 * a budtender sees a tick appear per unit sold; in Crew, Mike sees the reward value land in the
 * SPIFF column the moment somebody crosses their threshold.
 *
 * NEITHER OF THOSE CAN CALL sellthrough_. It is one store per request at ~9 seconds — six stores is
 * ~54s against Google's 60s ceiling, which is exactly why the Progress grid loops stores in the
 * browser and fills in as it goes. A kiosk cannot do that, and a payroll screen cannot make Mike
 * wait a minute for one column.
 *
 * So the live-ness lives HERE: a trigger refreshes this cache, and everyone else reads it in one
 * fast call. That is the only arrangement where "live" and "readable by three apps" are both true.
 * The read always carries `refreshed_at`, so a consumer shows how fresh it is rather than implying
 * a number is to-the-second when it is not.
 *
 * A FAILED REFRESH LEAVES THE OLD ROWS ALONE. Writing zero units because GX Core was unreachable
 * looks exactly like a budtender who sold nothing, and on the kiosk it would wipe ticks somebody
 * earned. Same rule as GX Crew's nightly Dutchie scan.
 */
var PROGRESS_TAB = 'spiff_progress';
var PROGRESS_HEADERS = ['program_id', 'pay_period', 'store_id', 'employee_id', 'name',
                        'units', 'target', 'hit', 'earned', 'vendor', 'program_name',
                        'start_date', 'end_date', 'refreshed_at'];

/* A Date from the sheet, or a string already in shape, or junk — always the same sortable stamp. */
function stampOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
  var s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  var d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
}

/* The `programs` tab has forceTextDates_; this is the same brace for `spiff_progress`, and it was
   missing. Only pay_period was pinned, so Sheets coerced start_date and end_date to Date objects at
   write and they left the route as '2026-08-17T00:00:00.000Z' — an ISO timestamp in a field the
   whole suite treats as 'YYYY-MM-DD' TEXT, one timezone mismatch from shifting a day. Crew survived
   it only because applySpiffEarnings_ slices to 10 characters defensively. */
function forceProgressTextDates_(sh) {
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  ['pay_period', 'start_date', 'end_date'].forEach(function (h) {
    var i = PROGRESS_HEADERS.indexOf(h);
    if (i >= 0) sh.getRange(2, i + 1, rows, 1).setNumberFormat('@');
  });
}

function progressSheet_() {
  var ss = dataSheet_().getParent();
  var sh = ss.getSheetByName(PROGRESS_TAB);
  if (!sh) {
    sh = ss.insertSheet(PROGRESS_TAB);
    sh.getRange(1, 1, 1, PROGRESS_HEADERS.length).setValues([PROGRESS_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    forceProgressTextDates_(sh);          // pinned before the first write, not after
  }
  return sh;
}

/** What a program pays one person, given their units. Mirrors computePayouts_ exactly. */
function progEarned_(prog, units, hit) {
  var pay = prog.payout_json || {};
  var type = pay.type || 'flat';
  if (type === 'per_unit') return (Number(units) || 0) * (Number(pay.per_unit) || 0);
  return hit ? (Number(pay.amount) || 0) : 0;
}

/**
 * Refresh the cache for every ACTIVE program. Run from a TIME TRIGGER, not the web app: a full
 * sweep is ~9s per store per program and /exec dies at 60s, while a trigger gets six minutes.
 * `only` limits it to one program_id, which is what the on-demand refresh uses.
 */
function refreshSpiffProgress_(only, onlyStore) {
  /* The hourly sweep is ACTIVE-only, deliberately — closed programs do not move and re-measuring
     22 of them every hour is pure cost. But a program named EXPLICITLY is swept whatever its
     status: a vendor report is sent AFTER close, and the per-store breakdown on it has to come
     from somewhere. Without this the cache could never hold a closed program, so client.html had
     no per-store rows and printed 0 for every store under a headline of 117. */
  var programs = (only ? listPrograms_() : listPrograms_('active')).filter(function (p) {
    return !only || String(p.program_id) === String(only);
  });
  var now = nowStamp_();
  var written = [], failures = [];

  programs.forEach(function (prog) {
    var stores = prog.stores_json || [];
    stores.forEach(function (store) {
      var slug = slug_(store && store.store_id ? store.store_id : store);
      if (!slug) return;
      if (onlyStore && slug !== slug_(onlyStore)) return;
      var r;
      try { r = sellthrough_({ id: prog.program_id, store: slug }); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        /* Reported, not written. The previous rows for this program+store stay exactly as they
           were — a store whose read failed keeps yesterday's ticks rather than losing them. */
        failures.push({ program_id: prog.program_id, store: slug, error: (r && r.error) || 'failed' });
        return;
      }
      (r.rows || []).forEach(function (row) {
        written.push([prog.program_id, prog.pay_period || '', slug,
                      row.employee_id || '', row.name || '',
                      Number(row.units) || 0, Number(row.target) || 0,
                      row.hit ? 'yes' : '', progEarned_(prog, row.units, row.hit),
                      prog.vendor || '', prog.program_name || prog.title || '',
                      prog.start_date || '', prog.end_date || '', now]);
      });
    });
  });

  if (written.length) {
    /* Replace only the program+store pairs that actually came back. Anything not refreshed —
       a failed store, a program not in this sweep — is left in place. */
    var touched = Object.create(null);
    written.forEach(function (w) { touched[w[0] + '|' + w[2]] = 1; });
    var sh = progressSheet_();
    var all = sh.getDataRange().getValues();
    for (var i = all.length - 1; i >= 1; i--) {
      if (touched[String(all[i][0]) + '|' + String(all[i][2])]) sh.deleteRow(i + 1);  // bottom-up
    }
    sh.getRange(sh.getLastRow() + 1, 1, written.length, PROGRESS_HEADERS.length).setValues(written);
    forceProgressTextDates_(sh);        // pay_period AND the program window stay TEXT
  }
  /* WHY a sweep found nothing, not just that it did. `programs: 0` on its own cannot tell a
     genuinely quiet week from a program sitting in `draft`, or from one whose stores_json is empty
     — and those need completely different fixes. The counts make the answer one call instead of a
     session and a hunt through the sheet. */
  var byStatus = Object.create(null);
  listPrograms_().forEach(function (x) {
    var k = String(x.status || '(blank)');
    byStatus[k] = (byStatus[k] || 0) + 1;
  });
  var seen = programs.map(function (x) {
    return { program_id: x.program_id, vendor: x.vendor,
             name: x.program_name || x.title, pay_period: x.pay_period || '(none)',
             stores: (x.stores_json || []).length,
             window: (x.start_date || '?') + ' → ' + (x.end_date || '?') };
  });
  return { ok: true, programs: programs.length, rows: written.length,
           failures: failures, refreshed_at: now,
           swept: seen, all_programs_by_status: byStatus };
}

/* ===================== SCHEDULED STATUS ROLL =====================
 * A program's status was a thing somebody had to remember to change. Nothing moved a draft to
 * active on its start date and nothing closed a program when its window ran out, so the landing
 * page showed a hero reading "day 14 of 14 - ended" on a programme still filed as ACTIVE, and the
 * hourly sweep kept re-measuring it because the sweep is active-only.
 *
 * That status is not cosmetic. `?action=progress&status=active` is resolved from it, and GX Crew's
 * incentive column and the Leaderboard kiosk cards both read that route -- so a programme left
 * active past its end date keeps drawing on kiosk cards, which is the exact failure the `status`
 * field was added to catch in the first place.
 *
 * Sky, 2026-08-31: a draft DOES go active on its scheduled start date -- no human step. Nothing
 * pays out automatically (a vendor report is still Tawny's click), so the risk of an early start
 * is a screen showing a programme a day sooner, not money moving.
 *
 * THREE RULES, and the two omissions are the point:
 *   draft  + window has started  -> active
 *   active + window has ended    -> closed
 *   CLOSED IS TERMINAL. Never reopened by a date. A closed programme has recorded actuals and may
 *     already be on a vendor report; a fat-fingered end_date must not un-send that.
 *   A DRAFT WHOSE WINDOW HAS ENTIRELY PASSED IS LEFT ALONE, and reported as `stale`. Closing it
 *     would file a programme in History as though it ran, with no actuals, when the likelier truth
 *     is that it was drafted and never started. That is a judgement call for a human.
 *
 * Rows with no start/end date are skipped -- there is no schedule to act on.
 * Writes only the status and updated_at cells: `edited_by` records the HUMAN who last corrected a
 * row, and a clock tick is not an edit by that person.
 */
function rollProgramStatuses_(opts) {
  opts = opts || {};
  var dryRun = !!opts.dryRun;
  var sh = dataSheet_();
  if (sh.getLastRow() < 2) return { ok: true, dry_run: dryRun, scanned: 0, changed: [], stale: [], skipped: [] };

  var idCol = PROGRAM_HEADERS.indexOf('program_id');
  var stCol = PROGRAM_HEADERS.indexOf('status');
  var sdCol = PROGRAM_HEADERS.indexOf('start_date');
  var edCol = PROGRAM_HEADERS.indexOf('end_date');
  var upCol = PROGRAM_HEADERS.indexOf('updated_at');

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  var day = today_(), now = nowStamp_();
  var changed = [], stale = [], skipped = [];

  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i][idCol] || '');
    if (!id) continue;
    var was = String(rows[i][stCol] || '').trim().toLowerCase();
    if (was !== 'draft' && was !== 'active') continue;          // closed, or a status we don't own

    /* textDate_ because the sheet can hand back a Date despite forceTextDates_ -- an older row
       written before that brace existed is still in there. */
    var sd = textDate_(rows[i][sdCol]), ed = textDate_(rows[i][edCol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) {
      skipped.push({ program_id: id, status: was, why: 'no window' });
      continue;
    }

    var want = '';
    /* STRING comparison on YYYY-MM-DD, deliberately: it sorts identically to the dates and never
       constructs a Date, so there is no UTC-vs-Los-Angeles midnight to get wrong. The end date is
       INCLUSIVE -- a program ending the 30th is still running ON the 30th. */
    if (was === 'draft'  && day >= sd && day <= ed) want = 'active';
    else if (was === 'draft' && day > ed)           { stale.push({ program_id: id, window: sd + ' -> ' + ed }); continue; }
    else if (was === 'active' && day > ed)          want = 'closed';
    if (!want) continue;

    changed.push({ program_id: id, from: was, to: want, window: sd + ' -> ' + ed });
    if (dryRun) continue;
    sh.getRange(i + 2, stCol + 1).setValue(want);
    sh.getRange(i + 2, upCol + 1).setValue(now);
  }

  if (changed.length && !dryRun) invalidatePrograms_();
  return { ok: true, dry_run: dryRun, today: day, scanned: rows.length,
           changed: changed, stale: stale, skipped: skipped };
}

/** Installed once; hourly is well inside Dutchie's freshness and nowhere near the quota. */
function installSpiffProgressTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshSpiffProgressTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshSpiffProgressTrigger').timeBased().everyHours(1).create();
  return { ok: true, installed: 'refreshSpiffProgress hourly' };
}
/* Roll FIRST, then sweep. The sweep is active-only, so a program that starts today has to be
   flipped before the same run measures it -- otherwise its first hour of sales lands an hour late,
   and a program that ended yesterday gets measured one more time for nothing. */
function refreshSpiffProgressTrigger() {
  try { rollProgramStatuses_(); }
  catch (e) { console.warn('[spiff] status roll failed: ' + ((e && e.message) || e)); }
  refreshSpiffProgress_();
}

/* What a full refresh would do, without doing any of it. Lets a caller loop store by store and see
 * progress, instead of firing one request that dies silently at the 60-second ceiling. */
function refreshProgressPlan_(only) {
  var programs = listPrograms_('active').filter(function (p) {
    return !only || String(p.program_id) === String(only);
  });
  var plan = [];
  programs.forEach(function (prog) {
    (prog.stores_json || []).forEach(function (store) {
      var slug = slug_(store && store.store_id ? store.store_id : store);
      if (slug) plan.push({ program: prog.program_id, store: slug });
    });
  });
  var byStatus = Object.create(null);
  listPrograms_().forEach(function (x) {
    var k = String(x.status || '(blank)');
    byStatus[k] = (byStatus[k] || 0) + 1;
  });
  return { ok: true, plan: plan, programs: programs.length,
           all_programs_by_status: byStatus,
           note: 'nothing swept — call again with &store=<slug> per entry in `plan`. ' +
                 'A full sweep is ~9s per store and /exec is killed at 60s; the hourly trigger ' +
                 'does the whole thing because a trigger gets six minutes.' };
}

/**
 * ?action=progress&secret=…[&pay_period=YYYY-MM-DD][&program=ID][&status=active]
 *
 * The fast read, for GX Crew's incentive column and Leaderboard's kiosk ticks. Deploy-secret
 * gated, like every other machine route in the suite — a kiosk holds no session and Crew's engine
 * has no browser.
 *
 * Returns per-person rows AND a per-employee total, because the two consumers want different
 * shapes: the kiosk wants "this person, this program, 3 of 5", and Crew wants "this person, this
 * pay period, $25" across however many programs were running.
 *
 * EVERY ROW CARRIES `status` (draft | active | closed) — and `&status=active` filters to it
 * server-side, which also trims `by_employee` totals, since those are summed from the rows that
 * survive. It is the field Leaderboard asked for on 2026-08-30: without it a consumer can only
 * INFER whether a program is still running, and window-overlap is the wrong inference — a
 * closed program keeps its dates, so BeGoat (closed, dated 08-01→08-31) kept passing and drew
 * on 23 of 40 kiosk cards, inflating totalEarned with a payout nobody could still bank.
 */
/* Does this cached row belong to the pay period the caller asked for?
 *
 * `pay_period` USED TO BE A LIE. SPIFF stores it as a human-readable RANGE — "2026-08-17 -
 * 2026-08-30" — so a caller passing a start date, which is the only shape a pay period has in
 * every other app in the suite, matched nothing and got `rows: []`. Zero rows is indistinguishable
 * from a fortnight where nobody earned anything, so the failure was SILENT and read as data. GX
 * Crew hit it and worked around it by not passing the parameter at all; Leaderboard was told the
 * same thing when it built the kiosk ticks. A parameter two apps have to be warned away from is
 * worse than no parameter.
 *
 * So it now accepts either shape, and the DATE shape is matched against the window rather than the
 * formatting: a bare YYYY-MM-DD counts when it falls inside the program's start/end. That is the
 * fact the caller means; the stored string is one way of writing it and can change without
 * breaking anyone. */
function payPeriodMatches_(row, want) {
  if (String(row.pay_period || '').trim() === want) return true;      // exact stored string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) return false;               // not a date — no other shape
  var a = textDate_(row.start_date), b = textDate_(row.end_date);
  return !!(a && b && a <= want && want <= b);                        // inside the program window
}

function spiffProgress_(p) {
  /* guard_ has already authorised this call — either a valid session token or the deploy
     secret. Re-demanding the secret here would have made the route unreachable from a browser
     no matter what the router allowed. */
  var sh = progressSheet_();
  if (sh.getLastRow() < 2) {
    return { ok: true, rows: [], by_employee: [], refreshed_at: '',
             status: null, orphan_program_ids: [],
             note: 'the progress cache is empty — run refreshSpiffProgress_ or wait for the trigger' };
  }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRESS_HEADERS.length).getValues();
  var wantPP = String(p.pay_period || '').trim();
  var wantId = String(p.program || '').trim();

  /* STATUS IS RESOLVED AT READ TIME, and deliberately NOT stored on the cached row. A cached row
     is a snapshot from the last refresh, and the case that matters is a program CLOSED since then
     — a stored column would still read 'active' for exactly the rows a consumer needs to drop,
     and the hourly sweep is active-only, so a closed program is never rewritten to correct it.
     Joining to `programs` on the way out is the only version of this field that is true.
     listProgramsCached_ is a 5-minute cache that every write invalidates, so the join costs
     nothing and can never be behind an edit. */
  var statusOf = Object.create(null);
  listProgramsCached_().forEach(function (pr) {
    statusOf[String(pr.program_id)] = String(pr.status || '').toLowerCase();
  });
  var wantStatus = String(p.status || '').trim().toLowerCase();

  var rows = [], newest = '', orphans = Object.create(null);
  vals.forEach(function (v) {
    var o = {};
    PROGRESS_HEADERS.forEach(function (h, i) { o[h] = v[i]; });
    if (wantPP && !payPeriodMatches_(o, wantPP)) return;
    if (wantId && String(o.program_id) !== wantId) return;
    /* '' means the program row is gone from `programs` — an orphaned cache row. Reported by id in
       the response rather than dropped quietly: "no rows" and "the programs tab lost a row" need
       completely different fixes, and a filter is where that difference disappears. */
    o.status = statusOf[String(o.program_id)] || '';
    if (!o.status) orphans[String(o.program_id)] = 1;
    if (wantStatus && o.status !== wantStatus) return;
    o.units = Number(o.units) || 0; o.target = Number(o.target) || 0;
    o.earned = Number(o.earned) || 0; o.hit = !!o.hit;
    /* The sheet round-trips these cells as DATE OBJECTS, so they reached consumers as
       "Fri Aug 28 2026 06:20:52 GMT-0700" instead of the stamp that was written. Normalised on the
       way out — every reader wants a sortable string, and none of them should have to guess which
       of the two shapes they got. forceProgressTextDates_ now stops it at the source; this stays as
       the brace, because rows written before that fix are still Dates at rest. */
    o.refreshed_at = stampOf_(o.refreshed_at);
    o.start_date   = textDate_(o.start_date);
    o.end_date     = textDate_(o.end_date);
    rows.push(o);
    if (o.refreshed_at > newest) newest = o.refreshed_at;
  });

  /* One line per person, summed across programs — what Crew puts in the SPIFF column. Keyed on
     employee_id where the connector gave us one, and on name only as a fallback: two people can
     share a first name but not an id, and Crew joins on id everywhere else. */
  var by = Object.create(null);
  rows.forEach(function (r) {
    var key = String(r.employee_id || ('name:' + r.name));
    var e = by[key] || (by[key] = { employee_id: r.employee_id || '', name: r.name,
                                    earned: 0, programs: [] });
    e.earned += r.earned;
    e.programs.push({ program_id: r.program_id, vendor: r.vendor, name: r.program_name,
                      status: r.status,
                      units: r.units, target: r.target, hit: r.hit, earned: r.earned });
  });

  /* SAY SO rather than return an empty set. If the caller filtered and we matched nothing while
     the cache itself has rows, that is a bad filter, not a quiet fortnight — and the caller cannot
     tell those apart from `rows: []`. Naming the values that DO exist turns a silent wrong answer
     into a one-line fix at the call site. */
  if (wantPP && !rows.length && vals.length) {
    var have = Object.create(null);
    vals.forEach(function (v) {
      var pp = String(v[PROGRESS_HEADERS.indexOf('pay_period')] || '').trim();
      if (pp) have[pp] = 1;
    });
    return { ok: false, error: 'no rows for pay_period "' + wantPP + '". The cache holds: '
               + (Object.keys(have).join(' | ') || '(none)')
               + '. Pass one of those, or a YYYY-MM-DD date inside the program window.',
             pay_period: wantPP, available: Object.keys(have), rows: [], by_employee: [] };
  }

  /* Same rule as the pay_period branch above: a filter that matched nothing, against a cache that
     holds rows, is a bad filter and not a quiet fortnight. Name the statuses that DO exist. */
  if (wantStatus && !rows.length && vals.length) {
    var haveSt = Object.create(null);
    vals.forEach(function (v) {
      var st = statusOf[String(v[0])] || '(not in programs)';
      haveSt[st] = 1;
    });
    return { ok: false, error: 'no rows with status "' + wantStatus + '". The cache holds: '
               + Object.keys(haveSt).join(' | ') + '.',
             status: wantStatus, available_statuses: Object.keys(haveSt),
             rows: [], by_employee: [] };
  }

  return { ok: true, pay_period: wantPP || null, status: wantStatus || null, rows: rows,
           by_employee: Object.keys(by).map(function (k) { return by[k]; }),
           refreshed_at: newest,
           orphan_program_ids: Object.keys(orphans) };
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
  var type = (payout && payout.type) || 'flat';
  if (type !== 'flat' && type !== 'per_unit') {
    return { ok: false, error: 'payout type "' + type + '" not implemented yet' };
  }
  var amount  = Number(payout && payout.amount) || 0;
  var perUnit = Number(payout && payout.per_unit) || 0;
  var lines = [], hit = 0, totalUnits = 0;

  for (var i = 0; i < rows.length; i++) {
    var r      = rows[i];
    var target = Number(targets[r.store_id]) || 0;
    var units  = Number(r.units) || 0;
    var made   = target > 0 && units >= target;

    totalUnits += units;
    if (made) hit++;

    // per_unit pays on volume, so there is no target to clear — everyone who sold earns.
    var earned = type === 'per_unit' ? units * perUnit : (made ? amount : 0);
    lines.push({
      employee_id: r.employee_id, name: r.name, store_id: r.store_id,
      units: units, target: target, hit: type === 'per_unit' ? units > 0 : made, earned: earned
    });
  }
  var owed = lines.reduce(function (n, l) { return n + l.earned; }, 0);
  return { ok: true, type: type, lines: lines, hit: hit, total_owed: owed, total_units: totalUnits };
}

/* ---------------------------- GX CORE ---------------------------- */

/* ============================= PROGRESS =============================
 * The budtender matrix — units by budtender by store against target — that the
 * SPIFF_Sales Report builds by hand: export a Dutchie Excel per store, paste into six
 * tabs, filter, count. This replaces that loop entirely.
 *
 * Sell-through comes from GX Core's `sales_by_employee` connector (core-admin, 2026-08-16),
 * NOT from Dutchie directly — Sky's call, so one connector serves SPIFF and GX Crew and
 * the store API keys live in one place. It is secret-gated, so only the engine can call
 * it; the browser never sees the secret.
 *
 * Attribution is by NAME (Dutchie's completedByUser). That was forced when GX Core's
 * employees tab was empty; it is no longer empty (76 rows as of 2026-08-30), so the
 * sturdier id join this comment promised is now POSSIBLE but is deliberately NOT taken:
 * switching the aggregation key from name to id would silently collapse every seller
 * Core has no roster row for into one bucket keyed ''. The rows carry the id either way
 * — see the boundary below, which reads it off `dutchie_employee_id` — so moving the key
 * is a separate, testable change, not a side effect of the v248 re-pin.
 * ==================================================================== */

var GX_SECRET_PROP = 'GX_DEPLOY_SECRET';   // set in Script Properties; never in this repo

/* ─── One entry per PERSON, out of a sales_by_employee payload ────────────────────────────
 *
 * KEYED ON THE DUTCHIE ID, name only as a fallback. Name was the key until 2026-08-30
 * purely because GX Core's employees tab was empty; it is not any more, and a name is not
 * an identity — two budtenders can share one, and one budtender can be spelled two ways.
 * On a shared name the old key silently summed two people into a single row and paid the
 * SPIFF once; on a re-spelling it split one person in two and paid neither, because each
 * half fell short of the target.
 *
 * Read the id off `dutchie_employee_id`, NOT `employee_id`. GX Core v248 named the ids for
 * what they are and marked `employee_id` a DEPRECATED ALIAS of the Dutchie id — which is
 * what it always silently was. The fallback keeps us working against a Core older than
 * v248, where the alias is all that ships.
 *
 * Our OWN field stays `employee_id`: it is SPIFF's column name in `spiff_progress` and in
 * the `progress` payload GX Crew reads, so renaming it would break a live cross-app
 * consumer to cosmetically match an upstream name.
 *
 * TWO PASSES, and the first one is the whole point. Keying straight off the id would drop
 * every seller Core has no id for into one shared bucket — so the fallback is the NAME, not
 * ''. But a person can also arrive as a mix: one row carrying an id, another (a re-spelling,
 * a missing id) without. Pass 1 learns name -> id from whichever rows do carry one, so those
 * unidentified rows join their identified twin instead of splitting off. Without it, moving
 * the key from name to id would have FIXED the shared-name merge and simultaneously
 * introduced a new split — a net wash on a live payout number.
 *
 * Object.create(null) throughout: `name` is Dutchie's completedByUser, i.e. data we do not
 * control. On a plain object a budtender named "constructor" or "valueOf" would find the
 * INHERITED member truthy, skip the initialiser, and start adding units onto a function.
 * Absurd as a name, but it is the same class pricecards hit and the fix is free.
 */
function aggregateSellers_(rows, store) {
  var idByName = Object.create(null);
  (rows || []).forEach(function (row) {
    var nk = userKey_(row.employee_name);
    var id = String(row.dutchie_employee_id || row.employee_id || '').trim();
    if (nk && id && !idByName[nk]) idByName[nk] = id;
  });

  var people = Object.create(null);
  (rows || []).forEach(function (row) {
    var name = String(row.employee_name || '').trim();
    if (!name) return;
    var nk = userKey_(name);
    var id = String(row.dutchie_employee_id || row.employee_id || '').trim() || idByName[nk] || '';
    /* Prefixed so an id can never collide with a name that happens to be all digits. */
    var key = id ? ('id:' + id) : ('name:' + nk);
    var e = people[key] || (people[key] = {
      name: name, employee_id: id, store_id: store, units: 0, revenue: 0
    });
    e.units   += Number(row.units) || 0;
    e.revenue += Number(row.revenue) || 0;
  });

  return Object.keys(people).map(function (k) { return people[k]; });
}

function sellthrough_(p) {
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;

  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script — Progress cannot read sell-through.' };

  var from = p.from || prog.start_date;
  var to   = p.to   || prog.end_date;
  if (!from || !to) return { ok: false, error: 'This program has no date range. Set start and end dates on the record first.' };

  // ONE store per request. Measured: ~9s per store regardless of range length, so six
  // stores in a single call lands at ~54s and Google terminates /exec around 60s. The
  // client loops stores and stitches, which also lets the grid fill in as it goes.
  var store = slug_(p.store || '');
  if (!store) return { ok: false, error: 'store required' };

  var r = gxSalesByEmployee_(secret, from, to, store, prog.match_json || {});
  if (!r.ok) return { ok: false, error: r.error || 'sell-through fetch failed', store: store };

  var t     = prog.target_json || {};
  var perBt = Number((t.per_bt || {})[store]) || 0;
  var rate  = (prog.payout_json || {}).amount || 0;

  var list = aggregateSellers_(r.rows, store);

  // No per-budtender target recorded? Split the store's target across whoever sold,
  // rather than marking everyone as having hit.
  var target = perBt;
  if (!target) {
    var storeTarget = Number((t.by_store || {})[store]) || 0;
    target = list.length ? Math.round(storeTarget / list.length) : 0;
  }

  var hit = 0, units = 0;
  list.forEach(function (e) {
    e.target = target;
    e.hit    = target > 0 && e.units >= target;
    if (e.hit) hit++;
    units += e.units;
  });
  list.sort(function (a, b) { return b.units - a.units; });

  return {
    ok: true, program_id: prog.program_id, store_id: store,
    from: from, to: to, target: target, rate: rate,
    rows: list, units: units, hit: hit, budtenders: list.length,
    errors: r.errors || []
  };
}

/* ==================== EMPLOYEE FLYER (standalone) ====================
 * The budtender-facing view: what is running, what is my number, what do I have
 * coming. Sky's ruling is that a SPIFF user with NO Inventory access gets this,
 * not the operator app -- and once Send-to-Managers reaches ~12 managers, most
 * SPIFF users will be in exactly that position.
 *
 * SCOPED IS THE WHOLE POINT OF THE ROUTE. Progress returns the full matrix: every
 * budtender at a store, by name, with units and revenue. A budtender must not see
 * their coworkers' numbers, so this returns exactly ONE person -- the caller. Like
 * clientView_ it hand-builds its response instead of returning stored rows, so a
 * column added to `programs` later stays invisible here until someone deliberately
 * exposes it. Revenue is omitted on purpose: a flyer needs units and dollars owed,
 * not the store's takings.
 *
 * It REUSES sellthrough_ rather than re-deriving targets. If the flyer decided "did
 * I hit" its own way, a budtender's screen could disagree with the matrix Tawny pays
 * from -- and the budtender would be right to trust neither.
 * ==================================================================== */

/* Join key for user_id, and NOT slug_. spiff's slug_ rewrites '_' to '-' while GX Core's
   gxSlug_ only lowercases, so slug_('sam_keck') is 'sam-keck' against a stored 'sam_keck'
   and the join would miss EVERY row while looking perfectly reasonable. Strip to
   alphanumerics so either convention lands on the same key. */
function userKey_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function flyerEmployee_(user) {
  var want = userKey_(user);
  if (!want) return null;
  var rows;
  try { rows = GXCore.getEmployees() || []; } catch (e) { return null; }
  for (var i = 0; i < rows.length; i++) {
    if (userKey_(rows[i].user_id) === want) return rows[i];
  }
  return null;
}

function flyer_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) {
    return { ok: false, error: auth.error || 'Not signed in',
             code: auth.code || 'auth_required', needsAuth: true };
  }

  var emp = flyerEmployee_(auth.user);
  if (!emp) {
    /* Sam Keck's gap precisely: a real account whose employees.user_id was never set, so
       the join resolves to nothing. Say that, and name the fix. Do NOT fall back to
       matching on display name -- a near-miss there would show one person another
       person's earnings, which is worse than showing nothing. */
    return { ok: true, linked: false, user: auth.user,
             error: 'Your sign-in is not linked to an employee record, so SPIFF cannot tell '
                  + 'which numbers are yours. Ask Sky to set user_id on your row in the Command Center.' };
  }

  var store = slug_(emp.home_store || '');
  /* The DISPLAY name, not the slug. A budtender at Century should not be told they work at
     "Bend" — that is the store_id, and the two differ for four of the six stores. */
  var storeLabel = store;
  try {
    (gxStores_() || []).forEach(function (x) {
      if (slug_(x.store_id) === store && x.display_name) storeLabel = x.display_name;
    });
  } catch (e) { /* the slug is a poor label but better than none */ }
  var me = { name: emp.full_name || auth.user, home_store: store, home_store_name: storeLabel };
  if (!store) return { ok: true, linked: true, employee: me, program: null,
                       note: 'Your employee record has no home store, so there is nothing to measure you against yet.' };

  /* Dates are TEXT (YYYY-MM-DD) and compared as text. Lexicographic order IS chronological
     for that format, so this never coerces a Date and never trips the timezone shift. */
  var today = nowStamp_().slice(0, 10);
  var running = null, recent = null, alsoRunning = [];
  listPrograms_().forEach(function (pr) {
    var st = String(pr.status || '').toLowerCase(), s = pr.start_date || '', e = pr.end_date || '';
    if (!e) return;
    if (st !== 'closed' && s && s <= today && today <= e) {
      alsoRunning.push(pr);
      if (!running || e < running.end_date) running = pr;   // the one ending soonest
    }
    if (e <= today && (!recent || e > recent.end_date)) recent = pr;
  });

  /* No program running is a REAL state, not an error -- today every program on record is
     closed. Fall back to the most recently ended one so the page can still answer "what do
     I have coming", and flag which it is rather than letting the page guess. */
  /* ?id= targets ONE program. The flyer paints its headline program first and then asks for
     each "also running" figure separately, because each answer costs a sell-through call
     (~9s): fetching all of them up front would put a phone screen behind half a minute of
     nothing to look at. */
  var wantProg = String(p.id || '').trim();
  var prog = wantProg
    ? listPrograms_().filter(function (x) { return String(x.program_id) === wantProg; })[0]
    : (running || recent);
  if (!prog) return { ok: true, linked: true, employee: me, program: null,
                      note: wantProg ? 'That program is not on record.' : 'No SPIFF program on record yet.' };

  var st = sellthrough_({ id: prog.program_id, store: store });
  if (!st.ok) return { ok: false, error: st.error || 'Could not read sell-through' };

  /* Prefer the dutchie id: it is the join Crew reweighted their duplicate scorer to favour
     precisely because a name can be spelled two ways or belong to two people. Name is the
     fallback, and only when the id gives nothing. */
  var mine = null, wantId = String(emp.dutchie_employee_id || ''), wantName = userKey_(emp.full_name);
  (st.rows || []).forEach(function (r) {
    if (wantId && String(r.employee_id) === wantId) mine = r;
  });
  if (!mine && wantName) {
    (st.rows || []).forEach(function (r) { if (!mine && userKey_(r.name) === wantName) mine = r; });
  }

  var units = mine ? Number(mine.units) || 0 : 0;
  var hit   = mine ? !!mine.hit : false;
  /* per_unit is REAL and implemented -- Hapy Kitchen paid $1 a unit. Assuming flat here
     would quietly under-report what a budtender is owed on those programs. */
  var payout = String(prog.payout_type || 'flat').toLowerCase() === 'per_unit'
    ? units * (Number(st.rate) || 0)
    : (hit ? (Number(st.rate) || 0) : 0);

  return {
    ok: true, linked: true, is_current: !!running,
    employee: me,
    program: {
      vendor: prog.vendor || '', name: prog.program_name || prog.title || '',
      start_date: prog.start_date || '', end_date: prog.end_date || '',
      status: prog.status || '', payout_type: prog.payout_type || 'flat'
    },
    mine: { units: units, target: Number(st.target) || 0, hit: hit, payout: payout, rate: Number(st.rate) || 0 },
    /* IDENTITY ONLY — no sell-through, so this costs nothing. The flyer fetches each figure
       on its own once the main card is on screen. Excludes whichever program is being shown. */
    others: alsoRunning
      .filter(function (x) { return String(x.program_id) !== String(prog.program_id); })
      .map(function (x) {
        return { program_id: x.program_id, name: x.program_name || x.title || '',
                 vendor: x.vendor || '', payout_type: x.payout_type || 'flat',
                 rate: (x.payout_json && x.payout_json.amount) || 0,
                 end_date: x.end_date || '' };
      })
  };
}

function gxSalesByEmployee_(secret, from, to, store, match) {
  var url = GXCORE_URL + '?action=sales_by_employee'
    + '&secret='  + encodeURIComponent(secret)
    + '&from='    + encodeURIComponent(from)
    + '&to='      + encodeURIComponent(to)
    + (store             ? '&stores='      + encodeURIComponent(store)             : '')
    + (match.brand       ? '&brand='       + encodeURIComponent(match.brand)       : '')
    + (match.category    ? '&category='    + encodeURIComponent(match.category)    : '')
    + (match.filter_text ? '&filter_text=' + encodeURIComponent(match.filter_text) : '')
    + ((match.products && match.products.length) ? '&products=' + encodeURIComponent(match.products.join(',')) : '');

  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var body = resp.getContentText();
    if (body.indexOf('<') === 0) return { ok: false, error: 'GX Core returned HTML (auth or redirect issue)' };
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'GX Core unreachable: ' + (e && e.message || e) };
  }
}

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

/* Cached progress rows for one program. Reads the sheet the hourly trigger writes, so callers
   that only need per-store totals never pay for a live Dutchie pull. */
function progressRowsFor_(programId) {
  var sh = progressSheet_();
  if (sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRESS_HEADERS.length).getValues();
  var out = [];
  vals.forEach(function (v) {
    var o = {};
    PROGRESS_HEADERS.forEach(function (h, i) { o[h] = v[i]; });
    if (String(o.program_id) !== String(programId)) return;
    o.units = Number(o.units) || 0;
    o.hit = !!o.hit;
    /* Same normalisation as spiffProgress_ — this reader feeds the vendor view, and a Date here
       would print as an ISO timestamp on a document that goes to the vendor. */
    o.start_date = textDate_(o.start_date);
    o.end_date   = textDate_(o.end_date);
    out.push(o);
  });
  return out;
}

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
  var stores = gxStores_(), nameOf = Object.create(null);
  stores.forEach(function (s) { nameOf[s.store_id] = s.display_name || s.store_id; });

  /* Per-store RESULTS come from the progress cache, which is already refreshed hourly — so the
     vendor's table can show what each store actually sold without this page triggering six
     sell-through calls while a rep waits on it.
   *
   * "Absent cache means no result columns" was the intent and NOT what happened. The cache is only
   * ever swept for ACTIVE programs (refreshSpiffProgress_ reads listPrograms_('active')), so a
   * CLOSED one — which is exactly what a vendor is sent — has no rows in it, and byStore emitted
   * sold:0 for every store. The vendor then saw a table totalling 0 units directly beneath a
   * headline of 117. Reported by Sky 2026-08-29 on the BeGoat page.
   *
   * There is no per-store settled figure to fall back on: actual_json records program TOTALS only.
   * So the honest answer is to say we do not have the breakdown, not to print zeros — hence the
   * flag below, which the page uses to drop the columns entirely rather than fill them with a
   * number that is wrong. */
  var progByStore = Object.create(null);
  try {
    var pRows = progressRowsFor_(prog.program_id);
    pRows.forEach(function (row) {
      var g = progByStore[row.store_id] || (progByStore[row.store_id] = { sold: 0, hit: 0, budtenders: 0 });
      g.sold += Number(row.units) || 0;
      g.budtenders++;
      if (row.hit) g.hit++;
    });
  } catch (e) { /* no cache is not an error here */ }

  var byStore = (prog.stores_json || []).map(function (id) {
    var g = progByStore[id] || {};
    var tgt = (t.by_store || {})[id] || 0;
    var sold = g.sold || 0;

    /* HOW MANY BUDTENDERS THE STORE WAS PLAYING WITH.
     *
     * This used to be g.budtenders — a count of people who appear in the sell-through, i.e. who
     * sold AT LEAST ONE unit. So a store where only two staff ever touched the product read
     * "0 of 2", which flatters it: nobody hit, out of a denominator that had quietly shrunk to
     * the people who tried. Stores looked inconsistent for no reason a vendor could see (6, 2, 5,
     * 3, 7, 2 across one program) and the number understated how many staff the vendor's money
     * was actually put in front of.
     *
     * The PLAN knows the answer: a store's unit goal divided by its per-budtender goal is the
     * headcount the program was designed around — exactly 6 at every BeGoat store. That is the
     * denominator the vendor was sold and the one they should be shown.
     *
     * Never below the number who actually took part, though: at portland-rd seven people sold and
     * all seven hit, and "7 of 6" reads as a broken page rather than an overperforming store. */
    var perBt   = Number((t.per_bt || {})[id]) || 0;
    var planned = perBt > 0 ? Math.round(tgt / perBt) : 0;
    var took    = g.budtenders || 0;
    var roster  = Math.max(planned, took, g.hit || 0);

    var base = (b.by_store || {})[id] || 0;
    return { store: nameOf[id] || id,
             baseline: base,
             target: tgt,
             sold: sold,
             /* Both comparisons are computed HERE so a row and the totals cannot drift apart.
                `lift` answers the question the vendor actually came with — did the SPIFF move
                anything — which "vs goal" alone does not: a store can miss an ambitious goal and
                still have tripled. BeGoat's bend went 2 to 18 while finishing level with goal. */
             lift: sold - base,
             delta: sold - tgt,
             hit: g.hit || 0,
             budtenders: roster,
             /* Kept for anyone reconciling later: how many actually sold, before the floor. */
             sellers: took };
  });

  /* TRUE only when the cache actually carried per-store rows for this program. */
  var hasStoreResults = Object.keys(progByStore).length > 0;

  /* The planned headcount, and ONLY if we genuinely know it. The previous fallback summed
     `baseline.by_store` — which is baseline UNITS, not people — so a program without an explicit
     budtender count reported its prior-period unit total as a headcount. Better to return 0 and
     let the page omit the comparison than to state a confident wrong number to a vendor. */
  /* ONE SOURCE PER PAGE.
   *
   * The headline KPIs used to come from actual_json while the table came from the progress cache,
   * so a vendor could read "117 units sold" above a table totalling 122 and neither number
   * explained the other. Sky, 2026-08-29: measured data wins, the historical actuals get
   * recalibrated separately.
   *
   * So when per-store rows exist they drive EVERYTHING — units, hits, headcount and therefore the
   * credit — and actual_json is only the fallback for a program the cache has never held. The
   * credit is the number the vendor is invoiced, so it must come from the same measurement as the
   * table that justifies it: paying 18 hits under a table showing 14 is the version of this bug
   * that costs someone money. */
  var measured = hasStoreResults ? byStore.reduce(function (n, x) {
    n.units += x.sold; n.hit += x.hit; n.bts += x.budtenders; return n;
  }, { units: 0, hit: 0, bts: 0 }) : null;

  var rate_    = a && a.spiff_amount ? a.spiff_amount : rate;
  var soldTot  = measured ? measured.units : (a ? (a.units_sold || 0) : 0);
  var hitTot   = measured ? measured.hit   : (a ? (a.bts_hit || 0) : 0);
  var bts      = measured ? measured.bts   : (Number(t.budtenders) || 0);
  var invest   = (a || measured) ? hitTot * rate_ : 0;
  var revInc   = ((t.units || 0) - (b.units || 0)) * cost;

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
      budtenders: bts,
      has_store_results: hasStoreResults,
      investment: rate * (t.budtenders || 0),
      results: (a || measured) ? {
        units_sold: soldTot, budtenders_hit: hitTot, budtenders: bts,
        rate_paid: rate_, investment: invest,
        /* The vendor's own gain, in dollars, at the cost they charge us. It was computed in
           the browser before, from figures the page did not all have — so the sentence under
           the headline could disagree with the table above it. Derived from the SAME sold total
           as the table, for the same reason. */
        added_revenue: Math.round(((soldTot - (b.units || 0)) * cost) * 100) / 100,
        /* Which measurement the reader is looking at. Nothing renders it today; it is here so a
           later reconciliation can tell a measured page from a seeded one without guessing. */
        source: measured ? 'measured' : 'recorded'
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
  // A library call runs the version this app PINS, not gx_core.gs as it reads today, and a
  // pushed pin only takes effect once the deployment is updated. Report what we're actually
  // running so the pin is checkable from the live url instead of from the manifest.
  try { d.coreVersion = GXCore.libVersion(); } catch (e) { d.coreVersion = 'ERR ' + e.message; }
  try { d.stores    = (GXCore.getStores()    || []).length; } catch (e) { d.stores    = 'ERR ' + e.message; }
  try { d.employees = (GXCore.getEmployees() || []).length; } catch (e) { d.employees = 'ERR ' + e.message; }
  try { d.products  = (GXCore.getProducts()  || []).length; } catch (e) { d.products  = 'ERR ' + e.message; }
  // Reports write into a folder this script did not create, which needs the full drive
  // scope — drive.file would silently only cover our own files.
  try { d.reportFolder = DriveApp.getFolderById(REPORT_FOLDER_ID).getName(); }
  catch (e) { d.reportFolder = 'ERR ' + (e && e.message || e); }
  return d;
}

/* ============================== BUG REPORT ==============================
 * File a bug into GX Core's shared `bug_reports` log. The button, the modal and the context
 * snapshot are gx-theme's `gx-bugreport.js` — this is only the transport and the auth. Nothing
 * about the form lives in this repo, deliberately: six hand-rolled copies of one bug form is
 * exactly what that shared file was written to end.
 *
 * BUCKETING — app 'inventory', tab 'spiff', and BOTH ARE HARDCODED HERE.
 * SPIFF is an Inventory SUB-APP (same as Price Cards), so its bugs belong in Inventory's stream
 * with `spiff` as the tab discriminator — NOT under an `app=spiff` bucket, which is the notes key,
 * not the bug tab. Nothing is lost by that: GX Core's GX_TAB_OWNER maps 'inventory:spiff' → the
 * spiff chat, so the 🐞 brain note still lands in THIS app's inbox while the bug itself files where
 * Inventory triage looks. They are hardcoded rather than read off `p` because bucketing is a fact
 * about what this app IS; a browser must not be able to file into another app's stream, and a
 * caller that forgot the parameter would silently land in the wrong one.
 *
 * `p.tab` from the client is therefore IGNORED for routing. Which SPIFF panel the reporter was on
 * rides in the context snapshot as `panel` — sending 'history' or 'calculator' up as `tab` would
 * file the report against an Inventory tab that does not exist.
 *
 * SIGNED IN (guard_ already required it), BUT NOT EDIT-GATED. `bugreport` is deliberately absent
 * from GATED_WRITES: a viewer who cannot edit a program is still the person most likely to notice
 * something is wrong, and a reporter that refuses them produces silence — which reads as "no bugs"
 * rather than "no reporter".
 *
 * DO NOT SWALLOW A FAILURE HERE. Inventory wraps its gxIngestBug call in a bare catch because it
 * has an email fallback to fall back TO. SPIFF has none, so a swallowed throw would return ok:true
 * and the user would read "✓ Reported — thank you!" over a report that does not exist. That silent
 * success is precisely what gx-bugreport.js's `res.ok === false` check exists to prevent, so the
 * error must travel back to it rather than being converted into a success here.
 *
 * NOTE THE PIN. `context` only reaches the sheet from GXCore v211, where gxIngestBug began
 * self-installing the bug_reports.context header — gxWrite_ maps records onto the sheet's REAL
 * header row, so on an older pin the snapshot is DROPPED SILENTLY and the report still returns ok.
 * This engine pins 213 (appsscript.json); a pushed pin only takes effect on the next
 * `clasp update-deployment`, so check ?action=libversion, never the manifest.
 */
function reportBug_(p) {
  var auth = gxAuth_(p.token);   // memoised per execution — guard_ already paid for this call
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in',
                         code: auth.code || 'auth_required', needsAuth: true };

  var title = String(p.title || '').trim();
  var desc  = String(p.desc  || '').trim();
  if (!title && !desc) return { ok: false, error: 'Say what went wrong.' };

  var res;
  try {
    /* app='spiff', NOT 'inventory'. This filed into Inventory's stream until 2026-08-27, on the
       reasoning that SPIFF is an Inventory sub-app. That is true of the PRODUCT and false of the
       BUG BOARD: GX Core's getBugs filters strictly on `b.app === a` with no tab fallback, so
       ?action=bugs&app=spiff — what this app's own chat and /gxbrain inbox ask for — returned zero
       every time, forever. Meanwhile GX_TAB_OWNER routed the linked NOTE to the spiff chat, so this
       app was told about bugs it could not then see in its own list.

       Price Cards already files under its own key and is correct on both counts; this makes the two
       sub-apps consistent. `tab` stays 'spiff' as the sub-app label on the row, exactly as Price
       Cards keeps its own. Changed while bug_reports held no rows, so nothing needed migrating. */
    res = GXCore.gxIngestBug('spiff', auth.user, {
      title:    title,
      desc:     desc,
      priority: String(p.priority || 'normal'),
      tab:      'spiff',
      appVer:   String(p.appVer || ''),
      context:  String(p.context || '')
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach the central bug log: ' +
                              String((e && e.message) || e) };
  }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'GX Core refused the report' };
  return { ok: true, id: res.id };
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

  /* Null-prototype, and these are the ones I MISSED on the first sweep: pricecards found the
     same class in their live telemetry, where bucket[action] || 0 hit the inherited function and
     concatenated onto it -- "function Object() { [native code] }1" in a counter. `roles` here is
     keyed on role_title straight off the employees sheet, so a title of "constructor" does exactly
     that. A corrupted count is worse than no count: nobody doubts a number. */
  var out = [], byStore = Object.create(null), roles = Object.create(null);
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
  // Tawny's older SPIF docs say "South" where the newer ones (and GX Core) say
  // "Commercial" — the South Commercial St store. Without this every South doc becomes
  // its own orphan program.
  if (want === 'south') want = 'commercial';

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
   sneaks in later) reads back as 'YYYY-MM-DD' rather than an ISO timestamp.
 *
 * FORMATTED IN UTC, AND THAT IS THE WHOLE POINT. Every caller here is a DATE-ONLY field, and a
 * date-only literal that Sheets coerced into a Date sits at UTC MIDNIGHT — the live route was
 * observed returning exactly '2026-08-17T00:00:00.000Z'. Formatting that in America/Los_Angeles
 * reads it as 5pm the PREVIOUS day and returns '2026-08-16': the program window silently moves a
 * day, which is the precise corruption "dates are TEXT" exists to prevent. Verified against the
 * programs tab, which says 2026-08-17. Same doctrine as addDaysLocal_ below — build and format in
 * UTC, never via a local constructor. Do not "fix" this to a local timezone. */
function textDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
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
  try { report.stores = gxStores_().length + ' stores'; }
  catch (e) { report.stores = 'ERR ' + e.message; }
  Logger.log('Authorized. ' + JSON.stringify(report));
  return report;
}

/* ═══ THE DRIVE IMPORTERS ARE GONE — cut 2026-08-30 ═══════════════════════════════════════
 * This app is now the system of record. Both external readers lived here and were removed
 * together the day the seed finished:
 *
 *   the SPIF-doc importer   read Tawny's .docx program docs out of two Drive folders
 *                           (Current + Archived) and parsed the window from the filename.
 *   the Calculator importer read the "Green Cross SPIFF Calculator" spreadsheet's vendor tabs.
 *
 * WHAT THE SEED DID, once, on 2026-08-30. All 113 docs became 23 `programs` rows carrying
 * their REAL windows and real per-budtender goals. The 21 Calculator-era rows they replaced
 * had their cost / baseline / actuals merged forward onto the corrected window and were then
 * deleted. `programs` ended at 25 rows: those 23, plus `wyld-0626` (a Calculator program with
 * no doc — the docs were never a superset) and Sky`s `green-cross-test-202608`.
 *
 * WHY THE CODE IS NOT KEPT "just in case". The Calculator inferred each window from a tab
 * named MMYY, so its rows read 2025-08-01..08-31 where the doc says 08-18..08-31 — wrong
 * enough that BeGOAT`s live pull once missed a third of its units. Every one of those rows is
 * now gone, which means re-running either importer would not top up History, it would ADD a
 * second, worse copy of it beside the good one. A dormant button that silently undoes a
 * finished migration is a worse thing to leave behind than a gap in the git history.
 *
 * If it ever has to come back: `git show db7a4c5:apps-script/Code.gs` (shipped as v1.322) is the last revision
 * that had all of it, seed map included, and CLAUDE.md records what the seed could not
 * supply (green-cross-2025-08-11 has no actuals; hapy-kitchen kept the Calculator`s targets).
 * ═══════════════════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT CATALOG — the featured product a program is actually about.
 *
 * WHY THIS EXISTS: the Calculator had no way to say WHICH product the SPIFF is on.
 * Vendor, cost per unit and reference units were all typed from memory, which is
 * how a program gets modelled against the wrong sell-through and pitched to a
 * vendor with a number nobody can reproduce.
 *
 * THE SOURCE IS THE BOUND LIBRARY, NOT AN HTTP HOP. `dutchieProducts` has no
 * trailing underscore, so GX Core exposes it to binding scripts — SPIFF pins v220
 * and v220 has it (verified against the commit that stamped it). That matters: the
 * secret-gated sales_by_employee route costs a UrlFetch round trip per store, and
 * a type-ahead cannot afford one.
 *
 * CACHED HARD, ON PURPOSE: /products is ~1,100 rows per store and six stores is a
 * multi-second pull. The catalog changes on the timescale of a purchase order, not
 * a keystroke, so it is cached for six hours and refreshable on demand.
 * ═══════════════════════════════════════════════════════════════════════════ */

var CATALOG_CACHE_KEY  = 'spiff_catalog_v1';
var CATALOG_CACHE_SECS = 6 * 60 * 60;
/* CacheService caps ONE value at 100KB, and the conformed catalog runs past that. Split
   across numbered chunks with a small manifest rather than silently not caching — an
   uncached catalog means a multi-second Dutchie pull on every page load. */
var CATALOG_CHUNK = 90000;

function catalogPut_(obj) {
  var c = CacheService.getScriptCache();
  try {
    var body = JSON.stringify(obj), parts = [];
    for (var i = 0; i < body.length; i += CATALOG_CHUNK) parts.push(body.slice(i, i + CATALOG_CHUNK));
    var map = {};
    parts.forEach(function (s, i) { map[CATALOG_CACHE_KEY + '_' + i] = s; });
    map[CATALOG_CACHE_KEY + '_n'] = String(parts.length);
    c.putAll(map, CATALOG_CACHE_SECS);
  } catch (e) { /* a cache miss is slow, not wrong */ }
}

function catalogGet_() {
  var c = CacheService.getScriptCache();
  try {
    var n = Number(c.get(CATALOG_CACHE_KEY + '_n') || 0);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(CATALOG_CACHE_KEY + '_' + i);
    var got = c.getAll(keys), body = '';
    for (var j = 0; j < n; j++) {
      var part = got[CATALOG_CACHE_KEY + '_' + j];
      if (part == null) return null;          // a chunk expired — treat the whole thing as a miss
      body += part;
    }
    return JSON.parse(body);
  } catch (e) { return null; }
}

/* One Dutchie INVENTORY row → the few fields a picker needs.
   /reporting/inventory, not /products, and the difference is `unitCost`: the wholesale cost
   per unit, which is the single number the Calculator could never source and Tawny has been
   typing from memory. Probed live before committing to it — the field is real and populated.
   Inventory also gives quantityAvailable (so the picker offers what we actually stock) and
   pricingTierName (Dutchie's own notion of a price-tiered group).
   Deliberately NOT the whole row: 54 fields cross the wire otherwise, and the Calculator
   has no use for batchId or lab results. */
function conformProduct_(pr) {
  var name = String(pr.productName || pr.name || '').trim();
  if (!name) return null;
  return {
    n: name,
    b: String(pr.brandName || pr.brand || '').trim(),
    c: String(pr.masterCategory || pr.category || '').trim(),
    s: String(pr.size || pr.unitWeight || '').trim(),
    t: String(pr.pricingTierName || '').trim(),
    cost: num_(pr.unitCost),
    /* REC PRICE FIRST, and the order is the whole point. `unitPrice` is the MEDICAL price on
       these rows: it reported Green Cross gummies at $4.25 when the shelf price is $5 ($6 for
       the ratio ones). Rec is what a customer pays and therefore what a SPIFF tier means, and
       price is part of the picker's grouping key — so reading med silently grouped two tiers
       under the wrong headline number. Same precedence Price Cards uses. */
    price: num_(pr.recUnitPrice || pr.unitPrice || pr.medUnitPrice),
    medPrice: num_(pr.medUnitPrice),
    qty: num_(pr.quantityAvailable)
  };
}

/* The catalog, deduped across stores. A product carried at five stores is ONE row here —
   the Calculator asks "which product", not "which product at which store". */
function buildCatalog_() {
  var stores = [];
  try { stores = GXCore.getStores() || []; } catch (e) { return { ok: false, error: 'GX Core getStores failed: ' + (e && e.message || e) }; }

  var by = Object.create(null), errs = [], seen = 0;
  stores.forEach(function (s) {
    var dn = String(s.dutchie_name || '').trim();
    if (!dn) return;
    var rows;
    try { rows = GXCore.dutchieInventory(dn) || []; }
    catch (e) { errs.push(String(s.store_id) + ': ' + (e && e.message || e)); return; }
    rows.forEach(function (pr) {
      var x = conformProduct_(pr);
      if (!x) return;
      /* IN STOCK ONLY. A SPIFF is on something budtenders can actually sell this fortnight;
         offering a product with nothing on the shelf is how a program starts already short. */
      if (x.qty <= 0) return;
      if (/^sample\b/i.test(x.n)) return;
      seen++;
      var k = (x.b + '|' + x.n + '|' + x.s).toLowerCase();
      var hit = by[k];
      if (!hit) { by[k] = x; x.lots = 1; return; }
      /* Same product across stores and batches. Cost is averaged WEIGHTED BY QUANTITY --
         a straight mean would let a two-unit remainder at an old cost move the number the
         vendor gets quoted. costLo/costHi keep the spread visible rather than hiding it
         behind an average that looks more certain than it is. */
      var q0 = hit.qty || 0, q1 = x.qty || 0, tot = q0 + q1;
      if (tot > 0 && (hit.cost || x.cost)) hit.cost = ((hit.cost * q0) + (x.cost * q1)) / tot;
      hit.costLo = Math.min(hit.costLo == null ? hit.cost : hit.costLo, x.cost || hit.cost);
      hit.costHi = Math.max(hit.costHi == null ? hit.cost : hit.costHi, x.cost || hit.cost);
      hit.qty = tot;
      /* `lots`, not `stores`: /reporting/inventory is one row per BATCH, so a single store
         contributes several. Calling this a store count would have read as "carried at 16
         stores" for a chain with six. */
      hit.lots = (hit.lots || 1) + 1;
      if (!hit.price && x.price) hit.price = x.price;
      if (!hit.t && x.t) hit.t = x.t;
    });
  });

  var list = Object.keys(by).map(function (k) {
    var x = by[k];
    x.cost = Math.round((x.cost || 0) * 100) / 100;
    x.costLo = Math.round((x.costLo == null ? x.cost : x.costLo) * 100) / 100;
    x.costHi = Math.round((x.costHi == null ? x.cost : x.costHi) * 100) / 100;
    x.qty = Math.round(x.qty);
    /* A sub-cent unit cost is a data-entry artefact, not a bargain (seen live: a blunt at
       $0.01). Flagged rather than dropped — the product is real and sellable, but the
       Calculator must not quote a vendor an ROI built on it without saying so. */
    if (x.cost > 0 && x.cost < 0.05) x.costSuspect = true;
    return x;
  }).sort(function (a, b) { return (a.b + a.n).localeCompare(b.b + b.n); });

  /* Brands are derived here rather than in the browser so the vendor field and the product
     picker can never disagree about what we carry. */
  var brands = Object.create(null);
  list.forEach(function (x) { if (x.b) brands[x.b] = (brands[x.b] || 0) + 1; });
  var brandList = Object.keys(brands).sort().map(function (b) { return { name: b, count: brands[b] }; });

  return { ok: true, products: list, brands: brandList,
           stores_read: stores.length, rows_seen: seen, errors: errs, built_at: nowStamp_() };
}

function catalog_(p) {
  var cat = null;
  if (String(p && p.refresh) !== '1') cat = catalogGet_();
  var cached = !!cat;
  if (!cat) {
    cat = buildCatalog_();
    if (!cat.ok) return cat;
    catalogPut_(cat);
  }

  var brand = String((p && p.brand) || '').trim().toLowerCase();
  var out = {
    ok: true, cached: cached, built_at: cat.built_at,
    stores_read: cat.stores_read, rows_seen: cat.rows_seen, errors: cat.errors,
    brands: cat.brands
  };

  if (String(p && p.all) === '1') { out.products = cat.products; return out; }
  if (!brand) { out.products = []; out.brand = ''; return out; }

  /* Exact brand match, not substring: "Mule" must not drag in "Mule Extracts" rows and
     quietly widen the program's reference units to a brand the vendor does not own. */
  out.brand = brand;
  out.products = cat.products.filter(function (x) { return String(x.b || '').toLowerCase() === brand; });
  return out;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * REFERENCE UNITS — what this product actually sold, before we pay anyone.
 *
 * The Calculator's whole model hangs off the reference figure, and until now it
 * was typed in from memory. A target set against a half-remembered reference is
 * a target nobody can defend to a vendor.
 *
 * ONE STORE PER REQUEST, like Progress and for the same measured reason: the
 * sell-through pull runs ~9s per store and Google terminates /exec near 60s, so
 * six stores in one call does not return. The browser fans out and fills the
 * table in as answers land.
 *
 * GOES THROUGH sales_by_employee RATHER THAN A FRESH TRANSACTION PULL. That route
 * already does the productId→brand/category join, the Take-cap logging, and — the
 * part worth not reimplementing — the UTC-window padding and local-date trim that
 * stops a Pacific day range counting four days of UTC. Its helpers are private to
 * the library (trailing underscore), so a local reimplementation could not share
 * them and would drift the first time DST moved.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Sky's rule: 28 days, halved. A SPIFF window is a pay period (~2 weeks), so half of
   four weeks is the like-for-like figure to set a target against — and 28 days spans
   exactly four of each weekday, so it cannot be skewed by which days it happens to cover. */
var REF_DAYS    = 28;
var REF_DIVISOR = 2;

function refUnits_(p) {
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script — reference units cannot be read.' };

  var store = slug_(p.store || '');
  if (!store) return { ok: false, error: 'store required' };

  var match = {
    brand:       String(p.brand || '').trim(),
    category:    String(p.category || '').trim(),
    filter_text: String(p.filter_text || '').trim(),
    products:    String(p.products || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
  };
  if (!match.brand && !match.filter_text && !match.products.length && !match.category) {
    return { ok: false, error: 'pick a product first — an unfiltered reference is the whole store' };
  }

  var days = Math.max(1, Math.min(90, Number(p.days) || REF_DAYS));
  /* Ends YESTERDAY. Today is a partial day, and including it drags the average down by
     however early in the afternoon someone happens to open the Calculator. */
  var to   = addDaysLocal_(today_(), -1);
  var from = addDaysLocal_(to, -(days - 1));

  var r = gxSalesByEmployee_(secret, from, to, store, match);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'sell-through fetch failed', store: store };

  var units = Number((r.totals || {}).units) || 0;
  var revenue = Number((r.totals || {}).revenue) || 0;
  return {
    ok: true, store: store, from: from, to: to, days: days,
    units: Math.round(units * 1000) / 1000,
    revenue: Math.round(revenue * 100) / 100,
    /* The figure the Calculator seeds a store's reference with. Returned ALONGSIDE the raw
       28-day number, never instead of it — a halved figure with no visible provenance is
       exactly the kind of number that gets questioned in a vendor meeting and cannot be
       explained on the spot. */
    reference: Math.round(units / REF_DIVISOR),
    divisor: REF_DIVISOR,
    sellers: (r.rows || []).length,
    errors: r.errors || []
  };
}

/* Dates are TEXT (YYYY-MM-DD). Built in UTC and formatted back, never via a local Date
   constructor — the sheet/script timezone mismatch is what silently shifts a day. */
function addDaysLocal_(ymd, n) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
