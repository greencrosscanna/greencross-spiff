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
 *   pay_period     TEXT 'YYYY-MM-DD'   (pay-period START, derived from start_date on every write
 *                                       in programToRow_ — joins to Leaderboard's period_start.
 *                                       Held the PAY DATE, end+5, until 2026-09-08.)
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
 *   target_json    { units, revenue, budtenders, by_store:{}, per_bt:{}, bts_by_store:{} }
 *                  the goal. bts_by_store is the per-store HEADCOUNT and was added 2026-09-01 --
 *                  it used to be inferred by dividing last month's units by last month's per-BT
 *                  figure, both already rounded, and the inference was wrong for 20 of 26 live
 *                  programs. Rows written before that date do not carry it; the frontend derives
 *                  it from by_store / per_bt instead, which is exact wherever those two multiply.
 *   actual_json    { units_sold, revenue, bts_hit, investment, roi, roi_pct }
 *                  present only for programs that already ran
 *   marketing_json what the vendor is in for and what is done; see normalizeMarketing_. Nothing
 *                  that pays anybody reads it.
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
  'edited_by', 'edited_at', 'share_token', 'contact_name', 'contact_email', 'doc_json',
  /* WHAT ACTUALLY SOLD, PER BUDTENDER, FROZEN. Written once when a program stops moving — see
     snapshotProgram_. It is on the PROGRAM and deliberately not in the shared spiff_progress tab:
     Crew fetches that tab whole and unfiltered, so adding 23 closed programs to it would take one
     response from 23KB to ~343KB against a 95KB cache ceiling, and Crew would silently stop
     caching and re-fetch the lot on every page load. History is SPIFF's own business. */
  'progress_json',
  /* ── WHAT THE BUDTENDERS ARE TOLD (2026-09-08) ────────────────────────────────────────────
     Tawny's selling tips for the kiosk: { tips: [] }. PROSE ONLY, and that is
     the whole design. Sky listed six things he wanted her able to edit — bullets, active
     products, store goal, BT goal, incentive amount and type, three talking points — and four
     of them already exist as real data on this row: the featured product is match_json, the
     store and per-budtender goals are target_json, the bounty and its model are payout_json
     and payout_type. Sky, 2026-09-08, chose to read those LIVE rather than let her retype
     them, so the kiosk cannot drift from the program the vendor agreed to. Duplicating a goal
     into a display field is how the kiosk ends up promising $25 on a program that was
     re-modeled to $20.
     So this column holds only what has no other home: the words. */
  'pitch_json',
  /* ── WHAT THE VENDOR IS IN FOR (2026-11-01) ─────────────────────────────────────────────────
     The Marketing section: which add-ons, for which stores, what is done. See
     normalizeMarketing_. Nothing that pays anybody reads it. KEEP IT LAST: the tab is at 26 columns,
     the whole of a default Sheets grid, and migrateHeaders_ adds a trailing column in place. */
  'marketing_json'
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
/* WHAT A PATCH IS ALLOWED TO CHANGE. A key missing from this list is dropped in SILENCE:
   editProgram_ skips it, reports ok, and lists only the fields it did apply — so a caller that
   never reads `changed` sees a successful save that did nothing.

   match_json and stores_json were missing, and that is not a small omission: match_json is WHAT
   THE SPIFF IS ON. Sky changed Portland Heights from the Green Cross house brand to "all Portland
   Heights products" twice on 2026-09-02, the app said Updated both times, and the record kept
   measuring the wrong catalog — 3,514 units of house brand against a real 242. The Calculator
   is the only screen that can set either field, and its patch was the one the engine ignored.

   Both belong here for the same reason payout_json does: the Calculator owns them, and every
   other field it sends was already accepted. */
var EDITABLE_FIELDS = [
  /* `pay_period` is NOT here any more: it is derived from start_date in programToRow_, so
     accepting a patch for it would let a caller write a value the next save overwrites — the
     shape of bug that made this column meaningless in the first place. Move the window instead
     and the period follows. */
  'vendor', 'program_name', 'status', 'start_date', 'end_date',
  'match_json', 'stores_json', 'payout_type',
  'payout_json', 'cost_json', 'target_json', 'baseline_json', 'actual_json',
  /* contact_name / contact_email are NOT here any more (2026-09-15). A brand's reps live in GX
     Core's brand registry and are edited through saveBrandContact; accepting them here would give
     a program a second, private contact list that the vendor login no longer reads. The columns
     stay on the sheet because names are names, and they hold only test values. */
  'pitch_json', 'marketing_json'
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
    /* Scrubbed: the URLs this engine builds carry the deploy secret, and UrlFetchApp puts the
       whole URL in its exception message. See scrubSecrets_. */
    return { ok: false, error: scrubSecrets_(e && e.message || e) };
  }
}

/* Sign-in runs HERE, in-process, instead of the browser calling GX Core's /exec.

   WHY IT MOVED (core-admin, 2026-09-03; Sky approved the same night). Apps Script serializes
   execution per script, so a browser signing in at GX Core /exec queues behind everything GX Core
   is doing for the whole suite. Measured at GX Core with curl: plain JSON 2.5-2.8s, but the JSONP
   shape our frontend actually used ran 3.6-6.4s and spiked to 42s, and one attempt came back as
   Google's Drive HTML page instead of an answer. Worse, abandoning a JSONP attempt does NOT cancel
   the execution -- it keeps its slot -- so attempt N+1 queued behind the one we gave up on. The
   retry manufactured the queueing it existed to survive; that is "GX jsonp login failed after 5
   tries". Sales never had this because it signs in against its OWN deployment, exactly like this.

   GXCore.login is a LIBRARY call: it runs inside this execution, so there is no second hop, no
   JSONP, and no shared queue. What we do NOT escape is our own /exec's ~6% second-hop flake --
   that is the transport, and the browser's bounded retry covers it.

   UNGATED, and that is not an oversight. This runs BEFORE anyone is authenticated; the credentials
   ARE the credential. The deploy secret must stay nowhere near this route -- UrlFetchApp puts the
   whole URL into its exception message, which is how the live secret reached an on-screen error
   banner on 2026-09-02.

   Returns GXCore.login's payload WHOLE. It carries token, expiresAt, user (the SLUG), role,
   displayName and avatarConfig, and the frontend needs all of them: keeping only r.user is what
   once showed 'sky' and bare initials where the person's name and avatar belong. `code` rides
   along untouched too, so the browser can still tell no_access (right password, no grant on SPIFF)
   from a bad password. */
function login_(p) {
  var user = String(p.user || '').trim();
  var pass = String(p.pass || '');
  // Never reaches GXCore, and never reaches a log line either -- the password is in this frame.
  if (!user || !pass) return { ok: false, error: 'Enter your user and password.' };
  try {
    if (typeof GXCore === 'undefined' || !GXCore) return { ok: false, error: 'Sign-in unavailable: GXCore not bound' };
    if (typeof GXCore.login !== 'function')       return { ok: false, error: 'Sign-in unavailable: pinned GXCore has no login()' };
    var r = GXCore.login(user, pass, APP);
    /* A library call that returns nothing is not a failed password. Saying so plainly keeps a
       broken pin from being reported to the user as bad credentials they will retry forever. */
    if (!r) return { ok: false, error: 'Sign-in unavailable: GXCore.login returned nothing' };
    return r;
  } catch (e) {
    return { ok: false, error: 'Sign-in failed: ' + scrubSecrets_(e && e.message || e) };
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
/* `login` is public because it MUST be: it is what a user calls to become authenticated, so
   gating it on a session is a contradiction. See login_ for why sign-in lives on this engine. */
/* The Green Cross wordmark drawn for a LIGHT background — green "GREEN", black "CROSS". The
   vendor PDF is a white page, and gx-theme's shared gx-logo.png sets "CROSS" in WHITE because it
   was made for the dark topnav, so that one would print as half a name. Served from this app's own
   Pages site rather than gx-theme: shared assets are core-admin's to change and five other apps
   load that file. */
var LOGO_ONLIGHT = 'https://greencrosscanna.github.io/greencross-spiff/gx-logo-onlight.png';

/* `storeView` is public for the same reason `clientView` is: the caller has no GX Core account
   to sign in with. A kiosk is a shared screen on a shop floor and nobody signs into it, so its
   per-store URL token IS the credential — matched against a live, non-revoked row in
   store_links, and nothing else about the request is trusted. It answers with the program, the
   goals, the bounty and Tawny's selling tips and carries NO person, no cost and no ROI, so an
   open link cannot leak a budtender's numbers or our margin. That narrowness is what makes it
   safe to list here; see storeView_. Minting and rotating those links are separate routes and
   both need a real session with an editing role. */
var PUBLIC_ACTIONS = ['ping', 'diag', 'libversion', 'clientView', 'flyer', 'login', 'storeView'];

/* Actions that additionally need an editor role. The rest of the write surface checks its own
   role after this, because each has its own message about what the role cannot do.
   EMPTY since 2026-08-30: its only member was `importCalc`, and the Calculator-sheet import was
   removed with the rest of the seed machinery. The gate stays because the next editor-only write
   will want it, and re-deriving it from the auth flow is harder than leaving one empty list. */
/* Writes a signed-in EDITOR may make from the browser. Checked AFTER authentication, so a viewer
   is refused by role rather than by secret.

   `snapshotProgress` moved here from SECRET_ACTIONS on 2026-09-09, because it was the only way to
   measure a program and no browser can ever call a secret-gated route: the deploy secret is
   server-side and must stay that way. Re-measure was refused at the gate on every press since it
   shipped — guard_ answers SECRET_ACTIONS before it ever looks at a session — so the button could
   not work whatever the code behind it did. Sky, 2026-09-09: "i clicked measure now and got no
   results", on the release that had just fixed a DIFFERENT bug in the same button.

   IT IS NOT A LOOSENING OF THE RULE IT WAS UNDER. That rule guards COST, and the cost here is one
   store's sell-through — the very same Dutchie read `sellthrough` performs, which has always been
   token-gated and callable by anyone signed in. The write it adds is the result of that read,
   onto a program an editor may already edit by hand. What stays secret-only is what a person
   cannot supervise: refreshProgress walks every store (~57s), rollStatuses moves every program's
   status, installProgressTrigger changes the schedule.

   A deploy secret still opens it — guard_ accepts the secret for token-gated routes too — so the
   hourly trigger and the CLI are unaffected.

   Declared with its list inline. The first cut of this put the array in a separate `var` above and
   assigned it here, which reads fine and is broken: top-level statements run in order, so this
   line would have taken the value before the other had one, and every gated call would have
   thrown on undefined.indexOf. */
var GATED_WRITES = ['snapshotProgress'];

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
var SECRET_ACTIONS = ['refreshProgress', 'installProgressTrigger', 'rollStatuses',
                      'sweepOrphanProgress', 'publishToCore', 'backfillPayPeriods',
                      'publishKioskTokens', 'seedBrands', 'recordActuals', 'auditPayouts', 'calendarSync',
                      'publishToWix', 'propsReport', 'setSwitch', 'deleteOrphanProp', 'adoptSite',
                      'giftCardEmail'];

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
    return { ok: false, error: 'Your role (' + auth.role + ') cannot change SPIFF programs' };
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
      case 'login':       out = login_(p);                                          break;
      /* ONE CALL AT OPEN — see bootAll_. Same four cached reads as the routes below it, so a
         client that has not shipped this yet keeps working unchanged against them. */
      case 'boot':        out = bootAll_(p);                                        break;
      case 'programs':    out = { ok: true, programs: listProgramsCached_() };      break;
      case 'program':     out = getProgram_(p.id);                                  break;
      /* Bug reports ride GET for the same reason. Signed in but NOT in GATED_WRITES —
         a viewer must be able to report. Files under app=spiff / tab=spiff; see reportBug_. */
      case 'bugreport':   out = reportBug_(p);                                      break;
      case 'editProgram': out = editProgram_(p);                                    break;
      case 'createProgram': out = createProgram_(p);                                break;
      case 'deleteProgram': out = deleteProgram_(p);                                break;
      /* Re-key a program. Session-gated and name-confirmed like the delete, because program_id is
         a foreign key into spiff_progress and into Core's published payload — see
         renameProgramId_. Dry by default; apply=1 to move it. */
      case 'renameProgramId': out = renameProgramId_(p);                            break;
      /* Penciled brands: a signed-in read, and editor-only writes. Their own tab, read by nothing
         that pays anybody; none of these is hedged on the client. See PENCILED BRANDS. */
      case 'pencils':       out = pencilsRead_(p);                                  break;
      case 'savePencil':    out = savePencil_(p);                                   break;
      case 'releasePencil': out = releasePencil_(p);                                break;
      case 'lockPencil':    out = lockPencil_(p);                                   break;
      /* Holiday sends: the same shape. Their own tab, read by nothing that pays anybody or feeds a
         kiosk; none hedged on the client. See HOLIDAY SENDS. */
      case 'holidays':        out = holidaysRead_(p);                               break;
      case 'saveHoliday':     out = saveHoliday_(p);                                break;
      case 'cancelHoliday':   out = cancelHoliday_(p);                              break;
      case 'saveHolidayPlan': out = saveHolidayPlan_(p);                            break;
      /* What one text blast costs: list size and Dutchie's two rates, set in Settings. See TEXT
         BLAST PRICING. Read by the Text blast card only; nothing that pays anybody reads it. */
      case 'smsPricing':      out = smsPricingRead_(p);                             break;
      case 'saveSmsPricing':  out = saveSmsPricing_(p);                             break;
      /* Staff shirt / hat size counts per store, from GX Crew by way of GX Core. Signed-in only;
         read by the Staff swag card. See STAFF SWAG SIZES. */
      case 'swagSizes':       out = swagSizes_(p);                                  break;
      /* One-time correction of the pay-period column on rows that predate the derivation.
         Secret-gated, dry by default — see backfillPayPeriods_. */
      case 'backfillPayPeriods': out = backfillPayPeriods_(p);                      break;
      case 'employees':   out = gxEmployees_();                                     break;
      case 'diag':        out = diag_();                                            break;
      case 'buildReport': out = buildReport_(p);                                    break;
      case 'emailDraft':  out = emailDraft_(p);                                     break;
      /* Store-by-store breakdown + printable mid-week sheet. Read only; builds, never sends. */
      case 'storeReport': out = storeReport_(p);                                    break;
      /* EMAILS STAFF (store managers + Tawny). Editor session only, dry unless send=1, refuses a
         repeat in the same week without resend=1. Never hedged on the client: a second copy is a
         second email. See EMAILING THE STORE SHEETS. */
      case 'sendStoreReports': out = sendStoreReports_(p);                          break;
      /* SENDS AN EMAIL. Editor session only, and never hedged client-side — a second copy would be
         a second email. See sendBrandEmail_. */
      case 'sendBrandEmail': out = sendBrandEmail_(p);                              break;
      /* Marketing (phase 3). Editor sessions only, neither hedged on the client. marketingNotify
         EMAILS THE INTERNAL TEAM (never a brand) and refuses a repeat without resend=1. */
      case 'marketingOverview': out = marketingOverview_(p);                        break;
      case 'marketingNotify':   out = marketingNotify_(p);                          break;
      /* EMAILS ONE TEAMMATE that a task is now theirs, only if the stored owner is that person and
         they have not been told already. Editor session only, never hedged. */
      case 'marketingAssign':   out = marketingAssign_(p);                          break;
      case 'giftCards':   out = giftCardList_(p);                                   break;
      case 'clientView':  out = clientView_(p);                                     break;
      case 'shareLink':   out = shareLink_(p);                                      break;
      /* The brand registry lives in GX Core (v330+). These are SPIFF's doors onto it: a signed-in
         read, and editor-only writes that stamp the signed-in user as `by`. See BRAND CONTACTS. */
      case 'brands':      out = brandsRead_(p);                                     break;
      case 'addBrand':    out = addBrand_(p);                                       break;
      case 'saveBrand':   out = saveBrand_(p);                                      break;
      case 'saveBrandContact':   out = saveBrandContact_(p);                        break;
      case 'removeBrandContact': out = removeBrandContact_(p);                      break;
      case 'seedBrands':  out = seedBrands_(p);                                     break;
      /* ── THE KIOSK LINKS ───────────────────────────────────────────────────────────────────
         `storeView` is the only route in this app with NO credential of its own: the token in
         the URL is the credential, matched against a live row. It answers with the program,
         the goals and Tawny's tips and carries no person, no cost and no ROI — see storeView_.
         Minting and rotating them needs a real session, like every other write here. */
      case 'storeView':   out = storeView_(p);                                      break;
      case 'storeLinks':  out = storeLinks_(p);                                     break;
      case 'storeLinkMintAll': out = storeLinkMintAll_(p);                          break;
      case 'storeLinkRotate': out = storeLinkRotate_(p);                            break;
      /* Backfill/repair the kiosk tokens Leaderboard reads out of GX Core kv. Secret-gated and DRY
         BY DEFAULT; `apply=1` writes. A machine route on purpose — it is what a failed publish in
         mint/rotate tells you to run, and that can be from a terminal with no session. */
      case 'publishKioskTokens': out = publishKioskTokens_(p);                      break;
      /* The same repair from the Kiosk links panel: an editor's SESSION instead of the deploy
         secret, which a browser must never hold. See storeLinksRepublish_. */
      case 'storeLinksRepublish': out = storeLinksRepublish_(p);                    break;
      case 'sellthrough': out = sellthrough_(p);                                    break;
      case 'catalog':     out = catalog_(p);                                        break;
      case 'refunits':    out = refUnits_(p);                                       break;
      // The progress cache — the fast read GX Crew's incentive column and Leaderboard's kiosk
      // ticks both use. Secret-gated: a kiosk holds no session and Crew's engine has no browser.
      case 'progress':    out = spiffProgress_(p);                                   break;
      case 'sweepOrphanProgress': out = sweepOrphanProgress_(p);                    break;
      /* Publish now rather than waiting for the hour. Secret-gated and DRY BY DEFAULT: it reports
         the periods and row counts it would send without writing to Core, so the shape can be
         checked before a consumer is pointed at it. `apply=1` publishes. */
      case 'publishToCore': out = publishToCore_(p);                                break;
      /* Record a closed program's actuals from its close-out measurement. Secret-gated and DRY BY
         DEFAULT; `apply=1` writes. The hourly trigger does this on its own — see RECORDING ACTUALS. */
      case 'recordActuals': out = recordActualsWeb_(p);                             break;
      case 'giftCardEmail': out = giftCardEmailWeb_(p);                             break;
      /* Fill the shared Marketing Calendar. Secret-gated and DRY BY DEFAULT; `apply=1` writes. */
      case 'calendarSync': out = calendarSyncWeb_(p);                               break;
      /* Fill greencrosscanna.com/deals through GX Core's Wix connector. Secret-gated and DRY BY
         DEFAULT; `apply=1` writes, `shop=1` re-reads which stores stock each brand. See THE DEALS PAGE. */
      case 'publishToWix': out = publishToWixWeb_(p);                               break;
      /* The script property store: how full, the biggest keys (names and sizes only), and the
         on/off switches set without the editor. Secret-gated; setSwitch is dry unless apply=1. */
      case 'propsReport': out = propsReportWeb_(p);                                 break;
      case 'setSwitch':   out = setSwitchWeb_(p);                                   break;
      case 'deleteOrphanProp': out = deleteOrphanPropWeb_(p);                       break;
      /* The deals page's weekly lines and brands (THE DEALS PAGE, PART 2). A signed-in read and
         editor-only writes in their own tab; approval is signed by the session. None hedged on the
         client: the writes are writes, and siteImportLogo imports into Wix Media. adoptSite takes over
         the hand-made Wix rows once: secret-gated, dry unless apply=1. */
      case 'siteDeals':       out = siteDealsRead_(p);                              break;
      case 'saveSiteDeal':    out = saveSiteDeal_(p);                               break;
      case 'removeSiteDeal':  out = removeSiteDeal_(p);                             break;
      case 'approveSiteDeals': out = approveSiteDeals_(p);                          break;
      case 'siteMedia':       out = siteMediaSearch_(p);                            break;
      /* The Featured image picker: images in the program's vendor folder. Editor session, a read. */
      case 'webImages':       out = webImages_(p);                                  break;
      case 'siteImportLogo':  out = siteImportLogo_(p);                             break;
      case 'adoptSite':       out = adoptSite_(p);                                  break;
      /* ONE STORE PER CALL. A full sweep is ~9s per store and /exec is killed at 60s — asking for
         all of them timed out with nothing written and no error to read, which is the worst of both.
         Called WITHOUT a store this returns the PLAN (every program × store pair) so a caller can
         loop and watch it fill, exactly as the Progress grid already does. The hourly trigger still
         does the whole sweep, because a trigger gets six minutes. */
      /* Freeze finished programs onto their own rows. BOUNDED AND RESUMABLE: one program is six
         stores at ~9s, so `max` governs how many fit in a call and the reply says what is LEFT.
         The hourly trigger takes one per run; the 23-program backfill is this in a loop.
         `force=1` re-measures a program that already has a snapshot — the break-glass, never
         automatic, because a settled record must not change quietly under a vendor invoice. */
      case 'snapshotProgress':
        /* ONE STORE PER CALL when a store is named — a whole program is ~54s against a 60s
           ceiling, and the first cut of this route died at 60.15s without writing anything.
           Called without one it returns the PLAN of pairs still to do, so the caller can loop
           and watch it fill. The hourly trigger still does whole programs: a trigger gets six
           minutes. */
        out = p.store
          ? (function () {
              var g = getProgram_(p.program || '');
              return g.ok ? snapshotStore_(g.program, p.store) : g;
            })()
          : snapshotPlan_({ force: String(p.force || '') === '1', program: p.program || '' });
        break;
      /* ── A MANUAL RE-MEASURE PUBLISHES TOO ──────────────────────────────────────────────────
         Crew asked, 2026-09-09: its "Re-measure now" button sweeps SPIFF store by store and then
         clears Crew's own cache so the manager sees what they just re-measured. On the Core path
         that promise depends on THIS route publishing — and it did not. Only the hourly trigger
         published, so a manager could re-measure, watch Crew clear its cache, and still be shown
         the previously published figures for up to an hour with nothing looking wrong.

         Crew's age display made that visible rather than silent, which is why they raised it as a
         question and not a bug. Closing it here is the right side to fix it on: the app that owns
         the numbers should publish whenever the numbers move, not only on a clock.

         Published even for a SINGLE-STORE call. That is more Core writes than strictly needed for
         a six-store sweep, but this route is only ever driven by a human pressing a button, and
         correctness on a manual action beats saving five round trips. */
      case 'refreshProgress':
        if (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP)) {
          out = { ok: false, error: 'Unauthorized' };
          break;
        }
        out = p.store ? refreshSpiffProgress_(p.program || '', p.store)
                      : refreshProgressPlan_(p.program || '');
        /* Wrapped, and attached to the reply rather than thrown: the refresh itself succeeded and
           the caller asked for a refresh. A Core outage must not turn a good sweep into an error,
           and Crew checks age_minutes on every read, so an unpublished sweep degrades to a
           visibly stale figure rather than a wrong one. */
        try {
          var rpub = publishSpiffToCore_({ notes: 'after a manual re-measure' });
          out.published = rpub.ok ? (rpub.published || []) : null;
          if (!rpub.ok) out.publish_error = rpub.error || 'publish failed';
        } catch (e) {
          out.published = null;
          out.publish_error = scrubSecrets_(e && e.message || e);
        }
        break;
      /* Manual run of the same roll the hourly trigger does. Secret-gated because it WRITES, and
         `dry=1` reports what it would change without touching a row -- the safe way to see what a
         date correction is about to do. */
      case 'rollStatuses':
        out = (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP))
              ? { ok: false, error: 'Unauthorized' }
              : rollProgramStatuses_({ dryRun: String(p.dry || '') === '1' });
        break;
      /* Gives every known vendor an upload folder and links it on programs that are not closed.
         Secret-gated because it WRITES; dry unless apply=1. See vendorFoldersRun_. */
      case 'vendorFolders':
        out = (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP))
              ? { ok: false, error: 'Unauthorized' }
              : vendorFoldersRun_(String(p.apply || '') === '1');
        break;
      case 'installProgressTrigger':
        out = (String(p.secret || '') === PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP)
               && String(p.confirm || '') === 'yes')
              ? installSpiffProgressTrigger() : { ok: false, error: 'Unauthorized or missing confirm=yes' };
        break;
      case 'payouts':     out = notImplemented_('payouts');                         break;
      case 'history':     out = { ok: true, programs: listPrograms_('closed') };    break;
      case 'flyer':       out = flyer_(p);                                          break;
      /* Does every closed program still add up? Report-only — see auditClosedPayouts_. */
      case 'auditPayouts': out = auditPayoutsWeb_(p);                               break;
      default:            out = { ok: false, error: 'Unknown action: ' + (p.action || '(none)') };
    }
  } catch (err) {
    /* SCRUBBED, like every other place an exception becomes a reply (2026-09-15). A handler that
       THROWS a UrlFetchApp failure rather than catching it lands here, and Google's message is
       "Address unavailable: <the whole url>" — deploy secret and all, printed into an error banner
       on whatever screen made the call. Every named leak path scrubs at its own catch; this was the
       one that did not, and it is the catch that sees anything nobody else caught. */
    out = { ok: false, error: scrubSecrets_(err && err.message || err) };
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
      case 'deleteProgram': out = deleteProgram_(body);               break;
      case 'closeProgram':  out = notImplemented_('closeProgram');    break;
      case 'buildReport':   out = buildReport_(body);                 break;
      case 'draftEmail':    out = emailDraft_(body);                   break;
      case 'pushPayouts':   out = notImplemented_('pushPayouts');     break;
      default:              out = { ok: false, error: 'Unknown action: ' + (body.action || '(none)') };
    }
  } catch (err) {
    out = { ok: false, error: scrubSecrets_(err && err.message || err) };   // see doGet's catch
  }
  return reply_(out, null);
}

/* ==================== ONE-CALL BOOT ====================
 * The screen opens with four back-to-back reads against this same /exec -- `programs`, `brands`,
 * `progress`, `employees` (spiff.js `start()`). Apps Script serializes executions of one script, so
 * the four queued nose-to-tail rather than overlapping: 2.4s warm / 8.7s cold EACH (see the comment
 * above listProgramsCached_), and every one of the four paid its own gxAuth_ round trip to GX Core
 * on top, spared only by the 5-minute auth cache. `boot` is the same four reads, from the SAME
 * caches this file already keeps warm (listProgramsCached_'s 5-minute cache, BRANDS_CACHE_KEY, the
 * roster's 15-minute cache inside gxRosterFull_), behind ONE guard_ check instead of four.
 *
 * EACH PART IS ITS OWN TRY/CATCH, and that is the whole safety argument. This exists to make the
 * common case faster, not to make the failure case worse -- coupling four independent reads into
 * one point of failure would mean a slow or broken brand list blanks the program list a user is
 * already staring at. A failed part comes back as that part's own {ok:false, error:...}, in its own
 * slot, exactly the shape a solo call to that route would have returned; the other three still
 * arrive and the browser renders whatever it has, same as it always could.
 *
 * The four solo routes are UNCHANGED and stay live -- an old cached client, or a future one-part
 * refresh (an admin saving a brand, say), still works exactly as it does today. `boot` is additive. */
function bootAll_(p) {
  function safe(fn) {
    try { return fn(); }
    catch (e) { return { ok: false, error: scrubSecrets_(e && e.message || e) }; }
  }
  return {
    ok: true,
    programs:  safe(function () { return { ok: true, programs: listProgramsCached_() }; }),
    brands:    safe(function () { return brandsRead_(p); }),
    employees: safe(function () { return gxEmployees_(); }),
    progress:  safe(function () { return spiffProgress_(p); })
  };
}

/* ==================== DERIVED WARNING FLAGS ====================
 * `duplicate_of` and `rate_changed` are COMPUTED ON EVERY READ and never stored. That is the whole
 * point of this block, so read the next paragraph before "optimizing" it into a column.
 *
 * They used to be written onto the record by the Calculator importer. When the importers were cut
 * (2026-08-30) the code that computed them went with them -- but the values stayed in `actual_json`
 * on the sheet. So the red "actuals match X -- verify" banner became a frozen sentence: correcting
 * the numbers by hand, or pulling live actuals from Dutchie, left the warning sitting there
 * claiming a match that no longer existed, and there was no way to clear it short of hand-editing
 * the spreadsheet. Sky asked how to clear one on 2026-08-31; the honest answer was "you can't".
 *
 * A warning nobody can clear is a warning everybody learns to ignore, which costs more than not
 * having it. Deriving it at read time means the banner is true whenever it is on screen, and fixing
 * the numbers clears it on BOTH records at once -- a stored flag could only ever clear the one you
 * edited, leaving its partner still pointing at a program that no longer matches.
 *
 * Same reasoning as `status` on the progress rows: resolved at read, never stored, because a
 * snapshot of a comparison goes stale the moment either side of the comparison moves.
 *
 * The corollary is in programToRow_: these keys are STRIPPED before a record is written back, or a
 * routine edit would quietly re-persist the derived answer and we would be back where we started.
 */
var DERIVED_ACTUALS = ['duplicate_of', 'rate_changed'];

/* A copy of actual_json fit to store: whatever a reader computed is removed again. */
/* ── TAWNY'S SELLING TIPS, NORMALIZED ON THE WAY IN AND OUT ───────────────────────────────────
 * { tips: [string] } and nothing else. Both directions go through here, so a row read back is
 * the same shape a row was written from and no reader has to guess whether it got a string, an
 * array, a null, or the {} every pre-2026-09-08 row holds.
 *
 * ONE LIST, NOT TWO. The to-do asked for "bullets" and "3 bullet talking points" and this was
 * briefly built as two separate fields. Sky, 2026-09-08: "for Staff to be able to click a SPIFF
 * button from the Kiosk and see the details (payout out, goal, etc) plus a few Selling tips
 * writen by Tawny, hence the request for bullet points." They are the same thing said twice —
 * the details come from the program itself, and the bullets ARE the selling tips. Two boxes
 * would have made Tawny decide which kind of bullet each thought was, a question with no answer.
 *
 * THIS TEXT IS RENDERED ON A KIOSK, so it is bounded here rather than only in the browser: the
 * screen has no operator watching it and a pasted essay would push the goal off the display it
 * exists to show. Empty entries are dropped — a blank tip renders as a stray dot, and "she left
 * the last box empty" and "there is no last tip" are the same fact.
 */
var PITCH_MAX_TIPS = 5, PITCH_MAX_LEN = 240;

function normalizePitch_(v) {
  var src = v && typeof v === 'object' ? v : {};
  /* `bullets` and `talking_points` are read as fallbacks so a row written during the hour this
     shipped as two fields still renders, rather than losing whatever was typed into it. */
  var raw = Array.isArray(src.tips) ? src.tips
          : (Array.isArray(src.bullets) ? src.bullets : []).concat(
             Array.isArray(src.talking_points) ? src.talking_points : []);
  var out = [];
  for (var i = 0; i < raw.length && out.length < PITCH_MAX_TIPS; i++) {
    var t = String(raw[i] == null ? '' : raw[i]).replace(/\s+/g, ' ').trim();
    if (t) out.push(t.slice(0, PITCH_MAX_LEN));
  }
  return { tips: out };
}

/* ── THE MARKETING RECORD: ONLY WHAT A PERSON DECIDED ────────────────────────────────────────────
 * { v:1, stores:[store_id], sel:{item:true}, skip:{item:true}, d:{item:{field:value}},
 *   done:{task_key:{by,at}}, due:{task_key:'YYYY-MM-DD'}, events:[{name,date,time}],
 *   vdays:[{store,date,time}], rows:{item:[{date,text,stores}]}, own:{task_id:person}, notes:'' }
 *
 * Tasks, due dates, overdue flags and compliance notes are computed on read by marketing.js and
 * never stored, for the same reason as the record warnings: a stored due date stops agreeing the
 * moment the window moves. This builds the record from a list of what MAY be kept, so a derived
 * field a caller sends is dropped rather than frozen.
 *
 * Bounded, because every row travels in the 95KB programs cache. A program nobody has planned
 * returns null and costs the sheet an empty cell.
 */
function normalizeMarketing_(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  /* Keys are store slugs, item ids and `task@store`. The leading letter also refuses __proto__. */
  var KEY = /^[a-z][a-z0-9_.@-]{0,80}$/;
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  var text = function (x, max) { return String(x == null ? '' : x).trim().slice(0, max); };
  var flags = function (src) {
    var o = {};
    Object.keys(src && typeof src === 'object' ? src : {}).forEach(function (k) {
      if (KEY.test(k) && src[k]) o[k] = true;
    });
    return o;
  };
  var out = { v: 1 };

  out.stores = (Array.isArray(v.stores) ? v.stores : [])
    .map(function (s) { return text(s, 60); })
    .filter(function (s, i, a) { return KEY.test(s) && a.indexOf(s) === i; });
  /* An empty list means "the program's own stores", which is what a missing one means too. */
  if (!out.stores.length) delete out.stores;

  out.sel = flags(v.sel);
  out.skip = flags(v.skip);

  out.d = {};
  var src = v.d && typeof v.d === 'object' ? v.d : {};
  Object.keys(src).forEach(function (item) {
    if (!KEY.test(item) || !src[item] || typeof src[item] !== 'object') return;
    var fields = {};
    Object.keys(src[item]).forEach(function (f) {
      var val = src[item][f];
      if (KEY.test(f) && val !== '' && val != null && typeof val !== 'object') fields[f] = text(val, 500);
    });
    if (Object.keys(fields).length) out.d[item] = fields;
  });

  out.done = {};
  var done = v.done && typeof v.done === 'object' ? v.done : {};
  Object.keys(done).forEach(function (k) {
    if (!KEY.test(k) || !done[k]) return;
    out.done[k] = { by: text(done[k].by, 80), at: text(done[k].at, 40) };
  });

  out.due = {};
  var due = v.due && typeof v.due === 'object' ? v.due : {};
  Object.keys(due).forEach(function (k) {
    var day = text(due[k], 10);
    if (KEY.test(k) && ISO.test(day)) out.due[k] = day;
  });

  out.events = (Array.isArray(v.events) ? v.events : []).slice(0, 50)
    .filter(function (e) { return e && typeof e === 'object' && text(e.name, 120); })
    .map(function (e) {
      var day = text(e.date, 10);
      return { name: text(e.name, 120), date: ISO.test(day) ? day : '', time: text(e.time, 40) };
    });

  /* Vendor days: [{store, date, time}], an empty store meaning every store. A blank row is kept,
     because it is the one an editor just added and is about to fill in. */
  out.vdays = (Array.isArray(v.vdays) ? v.vdays : []).slice(0, 30)
    .filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); })
    .map(function (e) {
      var day = text(e.date, 10), store = text(e.store, 60);
      return { store: KEY.test(store) ? store : '', date: ISO.test(day) ? day : '', time: text(e.time, 40) };
    });
  if (!out.vdays.length) delete out.vdays;

  /* An item's own list (social post dates, signs, featured cases): {item:[{date, text, stores}]}. */
  out.rows = {};
  var rows = v.rows && typeof v.rows === 'object' && !Array.isArray(v.rows) ? v.rows : {};
  Object.keys(rows).forEach(function (item) {
    if (!KEY.test(item) || !Array.isArray(rows[item])) return;
    var list = rows[item].slice(0, 30).filter(function (r) { return r && typeof r === 'object' && !Array.isArray(r); })
      .map(function (r) {
        var day = text(r.date, 10);
        return { date: ISO.test(day) ? day : '', text: text(r.text, 300),
                 stores: (Array.isArray(r.stores) ? r.stores : []).map(function (s) { return text(s, 60); })
                   .filter(function (s, i, a) { return KEY.test(s) && a.indexOf(s) === i; }) };
      });
    if (list.length) out.rows[item] = list;
  });
  if (!Object.keys(out.rows).length) delete out.rows;

  /* A task handed to someone other than its default owner: {task_id: person}, one of MKT_PEOPLE_. */
  out.own = {};
  var own = v.own && typeof v.own === 'object' && !Array.isArray(v.own) ? v.own : {};
  Object.keys(own).forEach(function (k) {
    var who = text(own[k], 20).toLowerCase();
    if (KEY.test(k) && Object.prototype.hasOwnProperty.call(MKT_PEOPLE_, who)) out.own[k] = who;
  });
  if (!Object.keys(out.own).length) delete out.own;

  out.notes = text(v.notes, 2000);

  var planned = out.stores || out.notes || out.events.length || out.vdays || out.rows || out.own
    || ['sel', 'skip', 'd', 'done', 'due'].some(function (k) { return Object.keys(out[k]).length; });
  return planned ? out : null;
}

/* ONE CLICK, ONE SMALL CHANGE: [section, key, value], or [section, null, value] to replace a whole
   section, with a null value meaning remove. Applied to what is stored NOW, not to what a browser
   last saw, so two people ticking different tasks cannot undo each other. It also keeps a save short
   enough to ride on GET: the live engine refuses a URL past about 10,000 characters (measured
   2026-11-01), and a whole plan with every task ticked would pass that on a program's last day.
   marketing.js's applyOps mirrors this for the screen; marketing_json_test.js holds them together. */
function applyMarketingDelta_(current, ops) {
  var out = JSON.parse(JSON.stringify(current || {}));
  var sections = ['stores', 'sel', 'skip', 'd', 'done', 'due', 'events', 'vdays', 'rows', 'own', 'notes'];
  (Array.isArray(ops) ? ops : []).forEach(function (op) {
    if (!Array.isArray(op) || sections.indexOf(op[0]) < 0) return;
    var section = op[0], key = op[1], value = op[2];
    if (key === null || key === undefined) {
      if (value === null || value === undefined) delete out[section]; else out[section] = value;
      return;
    }
    if (!/^[a-z]/.test(String(key))) return;
    var map = out[section] && typeof out[section] === 'object' ? out[section] : (out[section] = {});
    if (value === null || value === undefined) delete map[key]; else map[key] = value;
  });
  return normalizeMarketing_(out);
}

function stripDerivedActuals_(a) {
  if (!a) return a;
  var out = {}, k;
  for (k in a) if (Object.prototype.hasOwnProperty.call(a, k) && DERIVED_ACTUALS.indexOf(k) < 0) out[k] = a[k];
  return out;
}

/* Duplicating a vendor tab copies its hard-typed ROI cells while the formula cells recalculate, so
   a stale panel looks plausible on its own. Two programs reporting the same units sold, budtenders
   hit AND investment is not a coincidence -- mark both, so a stale panel can't be mistaken for a
   real result.

   Pass the FULL set. Flagging within a filtered subset (History's closed-only read, say) would
   compare a program against some of its siblings and not others, and the same record would carry a
   different warning depending on which screen you opened it from. */
function annotateActuals_(programs) {
  var seen = Object.create(null);   // keyed by joined actuals; null-proto so no key can inherit

  function keyOf(a) {
    /* An all-zero or all-blank actuals block is not evidence of a copy -- it is a program nobody
       has settled yet. Keying on it would flag every unsettled record against every other one,
       which is noise wearing the costume of a warning. */
    var u = Number(a.units_sold) || 0, h = Number(a.bts_hit) || 0, i = Number(a.investment) || 0;
    if (!u && !h && !i) return '';
    return [a.units_sold, a.bts_hit, a.investment].join('|');
  }

  programs.forEach(function (p) {
    if (!p.actual_json) return;
    var k = keyOf(p.actual_json);
    if (!k) return;
    (seen[k] = seen[k] || []).push(p);
  });

  programs.forEach(function (p) {
    var a = p.actual_json;
    if (!a) return;

    /* Assigned unconditionally, so a value left in the sheet by the old importer is overwritten by
       today's answer rather than merged with it. */
    var k = keyOf(a);
    a.duplicate_of = !k ? [] : (seen[k] || [])
      .filter(function (q) { return q !== p; })
      .map(function (q) { return q.title || q.program_name || q.program_id; });

    /* Modeled rate vs the rate actually settled. Only a real disagreement counts: a program with
       no modeled payout (Hapy Kitchen states "You Decide" where the rate goes) has nothing to
       differ FROM, and calling that a changed rate would flag the schema, not a mistake. */
    var pay = (p.payout_json || {}).amount;
    var act = a.spiff_amount;
    a.rate_changed = pay != null && pay !== '' && act != null && act !== ''
                     && Number(act) !== Number(pay);
  });
}

/* ── WHY A PROGRAM WILL NEVER MEASURE, ON THE PROGRAM ITSELF ──────────────────────────────────
   DERIVED, NEVER STORED — same rule as `duplicate_of` and `rate_changed` above, and for the same
   reason. The refusal memory is keyed on a FINGERPRINT of the filter that caused it, so fixing the
   filter clears this on the next read. A stored column would keep claiming "unmeasurable" after
   the thing that made it so was corrected, and there would be no way to clear it.

   It needs no entry in DERIVED_ACTUALS: this hangs off the PROGRAM, not off actual_json, and
   programToRow_ builds its row from an explicit column list, so an extra top-level property is
   already unwritable. Do not "tidy" it into actual_json, which IS written back.

   WHAT IT IS FOR. Twelve closed programs carry prose Dutchie filters from the 2026-08-30 seed and
   can never match anything. The record panel was offering them a "Measure now" button: a minute of
   Dutchie calls across six stores, ending in the zero-vs-record refusal, with nothing on screen
   saying why. renderUnmeasured already withholds the button for a program with no window or no
   stores, on the stated principle that an offer that cannot work is worse than none. This is the
   same case — it just took a week of a stuck sweep to learn that it was one.

   IT FILLS IN AS THE SWEEP GOES. A program is only known-refused once the sweep has actually tried
   it, so this reads empty for a program the sweep has not reached yet. That is the honest state:
   "we have not tried" and "we tried and it cannot work" are different claims, and only the second
   one earns taking a button away. */
function snapshotRefusalFor_(prog, refusals) {
  var r = refusals && refusals[prog.program_id];
  /* The fingerprint must still match. A filter edited since the refusal deserves a fresh attempt,
     which is the whole point of keying the memory on the filter rather than on the id. */
  return (r && r.fp === snapshotFingerprint_(prog)) ? r : null;
}

function annotateUnmeasurable_(programs) {
  var refusals = snapshotRefusals_();   // one script-property read for the whole list
  programs.forEach(function (p) {
    var r = snapshotRefusalFor_(p, refusals);
    p.unmeasurable = r ? { reason: r.reason || 'refused', since: r.at || '' } : null;
  });
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
  /* THE GRID COMES FIRST. A new tab has 26 columns and this one uses all 26, so asking for a 27th
     throws "outside the dimensions of the sheet". dataSheet_ runs this on EVERY read, so that throw
     would stop every route and the hourly job, pay included, not just the new column. */
  ensureColumns_(sh, PROGRAM_HEADERS.length);

  var width = Math.max(sh.getLastColumn(), PROGRAM_HEADERS.length);
  var old   = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });

  var same = PROGRAM_HEADERS.every(function (h, i) { return old[i] === h; }) && old.length === PROGRAM_HEADERS.length;
  if (same) return;

  /* ONLY NEW COLUMNS ON THE END: write those header cells and touch nothing else. No row shifts, so
     there is nothing to remap. The full rewrite below clears the tab first, which also drops the
     plain-text format the dates rely on, and a second execution reading mid-clear sees no programs.
     Neither is worth risking for a column nothing has been written to yet. */
  var kept = 0;
  while (kept < PROGRAM_HEADERS.length && old[kept] === PROGRAM_HEADERS[kept]) kept++;
  var restBlank = old.slice(kept).every(function (h) { return !h; });
  if (kept && restBlank && sh.getLastColumn() <= kept) {
    sh.getRange(1, kept + 1, 1, PROGRAM_HEADERS.length - kept)
      .setValues([PROGRAM_HEADERS.slice(kept)]).setFontWeight('bold');
    return;
  }

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

/* Reading or writing past the grid throws, and appendRow is the only write that grows it. */
function ensureColumns_(sh, n) {
  var have = sh.getMaxColumns();
  if (have < n) sh.insertColumnsAfter(have, n - have);
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
  var all = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    all.push(rowToProgram_(rows[i]));
  }
  /* Annotate BEFORE filtering: the duplicate check compares a program against every other program,
     so narrowing to one status first would let History and Programs disagree about the same row. */
  annotateActuals_(all);
  annotateUnmeasurable_(all);
  if (!status) return all;
  return all.filter(function (p) { return p.status === status; });
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
/* ── A MEASUREMENT BELONGS TO THE PROGRAM IT MEASURED ─────────────────────────────────────────
 * Change WHAT a program is on, WHEN it ran, or WHERE — and every number already measured for it
 * describes a program that no longer exists. Nothing used to notice.
 *
 * Portland Heights, 2026-09-02: its match was corrected from the Green Cross house brand to "all
 * Portland Heights products". The cached rows stayed exactly as they were — 3,514 units of house
 * brand, measured the day before against the old filter — and three surfaces kept serving them:
 * ?action=progress (which GX Crew's incentive column reads), the vendor Report, and anything else
 * on progressRowsFor_. The live screen said 242. Crew reported the figure it was given and had no
 * way to know better; it was Crew who found it.
 *
 * The hourly sweep could never have healed this: it is ACTIVE-only by design, so a CLOSED
 * program's cache is frozen at whatever it held when it last ran — correction or no correction.
 *
 * So a save that moves any of these clears the measurements outright. An EMPTY cache is honest —
 * the route already reports a program with no rows, and every consumer treats that as "no data
 * yet" rather than as zero. A stale one is a confident wrong answer, and it outlived the edit that
 * invalidated it by a day.
 *
 * Not payout_json: the rate changes what a person EARNED, not what they SOLD, and progEarned_ is
 * applied at read time from the program, not baked into the rows. Re-measuring for a rate change
 * would throw away good unit counts to recompute a multiplication.
 */
var MEASURED_BY = ['match_json', 'start_date', 'end_date', 'stores_json'];

function measurementInvalidatedBy_(before, after) {
  if (!before) return [];
  var moved = [];
  MEASURED_BY.forEach(function (f) {
    var a = before[f], b = after[f];
    var same = (typeof a === 'object' || typeof b === 'object')
      ? JSON.stringify(a || null) === JSON.stringify(b || null)
      : String(a == null ? '' : a) === String(b == null ? '' : b);
    if (!same) moved.push(f);
  });
  return moved;
}

/* Drop every cached row for one program. Bottom-up, because deleting a row shifts the ones
   after it. */
function dropProgressRows_(programId) {
  var sh = progressSheet_();
  if (sh.getLastRow() < 2) return 0;
  var vals = sh.getDataRange().getValues();
  var gone = 0;
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === String(programId)) { sh.deleteRow(i + 1); gone++; }
  }
  return gone;
}


/* ── DOES THIS PROGRAM'S BRAND MATCH ANYTHING? ────────────────────────────────────────────────
 * A program is matched to products by EXACT brand name (see the filter in catalog_), and a brand
 * with no filter_text means that vendor's whole range. So one wrong character makes a program
 * match nothing, silently, and the first sign of it is a number that is wrong somewhere else.
 *
 * IT TESTS THE PAYOUT RULE, NOT THE PICKER'S. Two different matchers exist and they do not agree:
 * catalog_ above compares brands with === (deliberately, so picking "Mule" cannot drag in "Mule
 * Extracts"), while the rule that actually moves money — gxSalesByEmployee_ in GX Core's
 * gx_dutchie.gs — is a case-insensitive SUBSTRING: String(meta.brand).indexOf(brand) < 0. A guard
 * written against the stricter one would refuse programs that pay out perfectly well.
 *
 * That is not hypothetical. Checking all 25 programs on 2026-09-08 turned up "National Cannabis
 * SPIF" (Aug 2025) matching brand "National Cannabis Co" while the products read "National Cannabis
 * Co." with a trailing period. Against === that program looks broken; against the substring rule
 * that actually paid it, it matched fine and its 267 units were real. So the check below is
 * indexOf, same as the money path.
 *
 * WHY IT MATTERS AT ALL: SPIFF's numbers reach GX Crew's incentive column, which is what people are
 * PAID on, and a bad match has already published a wrong figure once — Portland Heights, 2026-09-02:
 * 3,514 units reported against a real 242, and Crew had no way to know better.
 *
 * WHY THIS WARNS RATHER THAN FORBIDS. A program written before its product lands is a real thing —
 * a new vendor, stock not yet received, brand not yet in the catalog. Refusing that outright would
 * block legitimate work to prevent a typo. So an unmatched brand stops the FIRST save and says what
 * it thinks you meant; saving again with confirm_brand=1 goes through.
 *
 * AND WHY IT FAILS OPEN. catalog_ reads Dutchie, which goes down — it 401'd on all six stores on
 * 2026-08-31. A guard that turned an outage into "no program can be saved" would be worse than the
 * bug it prevents, so anything short of a confident "that brand is not there" lets the save pass.
 */
function brandMatchCheck_(matchJson) {
  var match = matchJson;
  if (typeof match === 'string') { try { match = JSON.parse(match || 'null'); } catch (e) { match = null; } }
  var brand = String((match && match.brand) || '').trim();
  if (!brand) return { checked: false };            // no brand — other filters carry the match

  var cat;
  try { cat = catalog_({}); } catch (e) { return { checked: false, why: 'catalog threw: ' + e.message }; }
  if (!cat || !cat.ok) return { checked: false, why: (cat && cat.error) || 'catalog unavailable' };

  var names = (cat.brands || []).map(function (b) { return typeof b === 'string' ? b : String(b && b.name || ''); })
                                .filter(Boolean);
  if (!names.length) return { checked: false, why: 'catalog carried no brands' };

  /* Substring, case-insensitive — the same test gxSalesByEmployee_ applies when it counts units. */
  var lower = brand.toLowerCase();
  var hits = names.filter(function (n) { return n.toLowerCase().indexOf(lower) >= 0; });

  /* MORE THAN ONE BRAND IS THE WIDENING, and this is the one place it can be asked about.
     "Mule" is contained in both "Mule" and "Mule Extracts", so a program on it is measured and
     paid over both — and over any brand added later whose name happens to contain it. That can
     be exactly what was meant (a vendor with sister lines), so it asks rather than refuses, the
     same way an unmatched brand does. None of the 137 brands in the catalog on 2026-09-11 sits
     inside another's name, so today this never fires; it is here for the day one does. */
  if (hits.length > 1) return { checked: true, ok: false, code: 'brand_ambiguous', brand: brand, matches: hits };
  if (hits.length) return { checked: true, ok: true };

  /* Only punctuation/case near-misses are offered. That is the failure this guard is named after —
     a trailing period, a missing space — and it is the one case where naming a suggestion is safe.
     A fuzzier match would start proposing a different vendor's brand, which is worse than silence. */
  var squash = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var target = squash(brand);
  var near = names.filter(function (n) { return squash(n) === target; });

  return { checked: true, ok: false, brand: brand, suggest: near };
}

function saveProgram_(p, opts) {
  if (!p || !p.program_id) return { ok: false, error: 'program_id required' };
  opts = opts || {};

  /* An import is a replay of records that already exist; re-litigating their brands would block a
     restore over history nobody is editing. Only a human save is checked. */
  if (!opts.fromImport && !opts.confirmBrand) {
    var bm = brandMatchCheck_(p.match_json);
    if (bm.checked && !bm.ok && bm.code === 'brand_ambiguous') {
      return {
        ok: false,
        code: 'brand_ambiguous',
        brand: bm.brand,
        matches: bm.matches,
        error: 'Brand "' + bm.brand + '" matches more than one brand we carry: "'
             + bm.matches.join('", "') + '". This program would count sales of all of them. '
             + 'Use the full brand name to count only one, or save again to confirm all of them.'
      };
    }
    if (bm.checked && !bm.ok) {
      return {
        ok: false,
        code: 'brand_no_match',
        brand: bm.brand,
        suggest: bm.suggest,
        error: 'No product in the catalog has a brand containing "' + bm.brand + '", so this program '
             + 'would measure nothing.'
             + (bm.suggest.length ? ' Did you mean "' + bm.suggest.join('" or "') + '"?' : '')
             + ' If the brand is correct and not stocked yet, save again to confirm.'
      };
    }
  }
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

      /* Did this edit move something the measurements were taken against? Compared BEFORE the
         write, or the old values are gone and there is nothing to compare to. */
      var moved = measurementInvalidatedBy_(rowToProgram_(rows[i]), p);
      if (moved.length) p.progress_json = null;

      sh.getRange(i + 2, 1, 1, PROGRAM_HEADERS.length).setValues([programToRow_(p, rowAudit)]);
      invalidatePrograms_();

      var dropped = 0;
      if (moved.length) {
        try { dropped = dropProgressRows_(p.program_id); }
        catch (e) { /* the row is already saved; a stuck cache must not fail the save */ }
      }
      return { ok: true, program_id: p.program_id, updated: true,
               invalidated: moved.length ? moved : undefined,
               dropped_rows: moved.length ? dropped : undefined };
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
  var hasDelta = Object.prototype.hasOwnProperty.call(patch, 'marketing_delta');
  if (hasDelta) {
    /* Ticks are signed by the SESSION, not by whatever name the browser sent, because one tick
       (Sky's deals-page approval) publishes to the public website. See wixSignDelta_. */
    patch.marketing_json = applyMarketingDelta_(merged.marketing_json,
      wixSignDelta_(patch.marketing_delta, auth.user, merged.marketing_json));
  }
  EDITABLE_FIELDS.forEach(function (f) {
    // patch is JSON.parse'd from the request: a key literally named "hasOwnProperty" would
    // shadow the method and turn this into a TypeError. Call it off the prototype instead.
    if (!Object.prototype.hasOwnProperty.call(patch, f)) return;
    if (JSON.stringify(merged[f]) === JSON.stringify(patch[f])) return;
    merged[f] = patch[f];
    changed.push(f);
  });
  /* The browser takes this as the truth after a tick, in place of what it guessed. */
  if (!changed.length) {
    return hasDelta ? { ok: true, program_id: p.id, unchanged: true, marketing_json: merged.marketing_json }
                    : { ok: true, program_id: p.id, unchanged: true };
  }

  var res = saveProgram_(merged, { editedBy: auth.user, confirmBrand: String(p.confirm_brand || '') === '1' });
  res.changed = changed;
  res.edited_by = auth.user;
  if (hasDelta) res.marketing_json = merged.marketing_json;
  return res;
}

/* Create a program from the Calculator. Same role gate as editing — a new program is a
   commitment to a vendor, not a scratch calculation. */
/* ── CANONICAL JSON, FOR COMPARING A CANDIDATE AGAINST WHAT'S ON THE SHEET ───────────────────
 * Same idea as spiff.js's canonJson: sorted keys, so two structurally identical values compare
 * equal however they were assembled — a value that came back out of the datastore and one just
 * built from a request body will never agree on key order otherwise. Used only by the create
 * replay guard below; nothing else here needed it.
 */
function canonJson_(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonJson_).join(',') + ']';
  return '{' + Object.keys(v).sort().map(function (k) {
    return JSON.stringify(k) + ':' + canonJson_(v[k]);
  }).join(',') + '}';
}

/* Fields that describe what the program IS — the same shape createProgram_ builds a draft from.
   Not start_date/end_date: gx-client's retry can legitimately race a slow clock tick across a
   pay-period boundary, and the window is what the FIRST reply already committed, not something
   a second send should be allowed to silently overrule. */
var CREATE_REPLAY_FIELDS = [
  'program_name', 'vendor', 'match_json', 'stores_json', 'cost_json',
  'payout_type', 'payout_json', 'target_json'
];

/* ── A RETRIED CREATE IS NOT A SECOND PROGRAM ─────────────────────────────────────────────────
 * gx-client's jsonp() retries a call by default (RETRIES=4) whenever the first reply is slow or
 * dropped — that is what it is FOR, everywhere else on this engine. createProgram_ is the one
 * write it cannot safely retry blind: the id is derived from the name and month, not handed
 * back, so a retry after a dropped reply lands on the SAME id the first attempt already used and
 * got refused outright. The first call had already saved everything; Tawny just saw "Saved, but
 * the model failed" for a program that was sitting on the sheet, correct, the whole time
 * (bug_mulu4dfk_4x9j, 2026-09-28 — verified live: sodas-tictures-all-products-202609 saved in
 * full on the first send).
 *
 * So a same-id collision is now two different questions, not one refusal:
 *   · Is this the SAME create landing twice? — same user, same model content. Say so and hand
 *     back the id that already exists; nothing is written twice.
 *   · Is this a DIFFERENT program that happens to slug to the same id? — refuse exactly as
 *     before. A second, genuinely different program must never be silently dropped in favor of
 *     the first one that got there.
 * Checking the USER matters as much as the content: two different editors independently naming
 * a program the same thing in the same month is a collision worth a human's attention, not a
 * retry to wave through.
 */
function createProgram_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot create SPIFF programs' };
  }

  var draft = parseJson_(p.program, null);
  if (!draft || !draft.program_name) return { ok: false, error: 'program_name required' };
  /* Filled BEFORE the collision check, not after, so a replay compares against the same
     normalized shape the first call actually saved — otherwise every replay would see a
     mismatch on match_json alone and fall through to a refusal. */
  draft.match_json = draft.match_json || { brand: draft.vendor || '', category: '', filter_text: '', products: [] };

  var id = slug_(draft.program_name) + '-' + today_().slice(0, 7).replace('-', '');
  var existing = getProgram_(id);
  if (existing.ok) {
    if (createIsReplay_(existing.program, draft, auth.user)) {
      return { ok: true, program_id: id, created: false, replay: true, changed: [] };
    }
    /* ── THE SAME NAME FOR A DIFFERENT VENDOR IS A DIFFERENT PROGRAM ────────────────────────────
       Tawny, 2026-10-12: "I can't save the Kaprikorn Spiff." The id is the NAME plus the month, and
       she names programs for what they cover — "All products" — so the second vendor to run one in
       a month slugged to the first vendor's id and was refused. Nothing was saved, and the screen
       said only "Saved, but the model failed".

       So a different vendor takes its own id, with the vendor in front. Only on a collision: every
       id minted before this keeps its shape, and an id is never re-derived after creation.

       The SAME vendor and name in one month is still refused. That is either the program somebody
       meant to open and edit, or two editors describing one deal — a person should look, and the
       refusal now says so in words rather than quoting an id nobody on the screen has ever seen. */
    var taken = function (prog) {
      return {
        ok: false, code: 'name_taken',
        error: '"' + (prog.program_name || draft.program_name) + '" already exists for '
             + (prog.vendor || 'this vendor') + ' this month. Open that program to change it, '
             + 'or give this one a different name.'
      };
    };
    var vslug = slug_(draft.vendor);
    if (!vslug || vslug === slug_(existing.program.vendor)) return taken(existing.program);
    id = vslug + '-' + id;
    var again = getProgram_(id);
    if (again.ok) {
      if (createIsReplay_(again.program, draft, auth.user)) {
        return { ok: true, program_id: id, created: false, replay: true, changed: [] };
      }
      return taken(again.program);
    }
  }

  draft.program_id = id;
  draft.title      = draft.program_name;
  draft.status     = 'draft';       // becomes active when Tawny starts it
  draft.source     = 'calculator-app:' + auth.user;

  /* The vendor's upload folder: made if it is missing and linked on the new program. Never in the
     way of creating the program: a Drive hiccup leaves the link empty for the backfill to fill. */
  try {
    var vf = vendorFolderFor_(draft.vendor, true);
    var withLink = vf && vf.url ? withVendorFolder_(draft.marketing_json, vf.url) : null;
    if (withLink) draft.marketing_json = withLink;
  } catch (e) { /* see above */ }

  var res = saveProgram_(draft, { editedBy: auth.user, confirmBrand: String(p.confirm_brand || '') === '1' });
  res.program_id = id;
  return res;
}

function createIsReplay_(existing, draft, user) {
  if (!existing || String(existing.source || '') !== 'calculator-app:' + user) return false;
  return CREATE_REPLAY_FIELDS.every(function (f) {
    return canonJson_(draft[f] !== undefined ? draft[f] : null)
        === canonJson_(existing[f] !== undefined ? existing[f] : null);
  });
}

/* ── DELETING A PROGRAM ───────────────────────────────────────────────────────────────────────
 * Sky, 2026-09-06: "need a way to delete a program, specifically the Wyld 10pc. it never
 * happened so we can delete it."
 *
 * The obvious answer — open the sheet and delete the row — is the one that has already cost real
 * money here. A program is not one row. Its MEASUREMENTS live in `spiff_progress`, keyed on
 * program_id, and ?action=progress is read by GX Crew's incentive column and the Leaderboard
 * kiosks. Delete the program and leave those behind and every one of them is an orphan carrying
 * `earned` dollars for a program that no longer exists. That is exactly the BeGOAT failure of
 * 2026-08-31: 25 stranded rows, $350 of earnings, fourteen people showing as owed $25 for a
 * fortnight that had already been paid. `orphan_rows` was added to CATCH that; a hand-delete
 * manufactures it on purpose.
 *
 * So deletion is a route, not a spreadsheet gesture, and it does the whole job at once: unfile the
 * program, drop its measurements, clear the cache.
 *
 * NOTHING IS DESTROYED. The row moves to `deleted_programs` with who removed it and when. Gone
 * from every surface, still recoverable by a human who deleted the wrong one — which matters
 * because this is reachable over GET, and a URL is a thing that gets pasted, bookmarked and
 * re-fetched. For the same reason the typed confirmation is checked HERE and not only in the
 * browser: a dialog is a claim about a screen, this is the control.
 *
 * A CLOSED PROGRAM IS NOT DELETABLE. Closed means it ran, was measured, was reported to the vendor
 * and was paid — the same reasoning that makes closed terminal in the status roll and locks its
 * goals in the Calculator. Draft and active are fair game: a draft never ran, and an active one
 * can only have been created by mistake if it is being deleted at all. Wyld 10pc is a draft.
 */
var DELETED_TAB = 'deleted_programs';

function deletedSheet_() {
  var sh = dataSheet_().getParent().getSheetByName(DELETED_TAB);
  if (!sh) {
    sh = dataSheet_().getParent().insertSheet(DELETED_TAB);
    sh.getRange(1, 1, 1, DELETED_HEADERS.length).setValues([DELETED_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

var DELETED_HEADERS = PROGRAM_HEADERS.concat(['deleted_by', 'deleted_at', 'deleted_reason']);

/* A TOMBSTONE IS WRITTEN BY HEADER NAME. The live tab's columns end in deleted_by / deleted_at /
   deleted_reason, and a program column added since belongs after those on that tab: appended by
   position, every later tombstone's "who deleted it" would land under the wrong heading, beside
   older rows that are right. Nothing reads this tab but a person recovering a mistake, so nothing
   would ever notice. */
function writeTombstone_(prog, by, reason) {
  var sh = deletedSheet_();
  var row = programToRow_(prog, { edited_by: prog.edited_by, edited_at: prog.edited_at })
    .concat([by, nowStamp_(), reason]);
  var width = sh.getLastColumn();
  var have = (width ? sh.getRange(1, 1, 1, width).getValues()[0] : [])
    .map(function (h) { return String(h || '').trim(); });
  var missing = DELETED_HEADERS.filter(function (h) { return have.indexOf(h) < 0; });
  if (missing.length) {
    ensureColumns_(sh, have.length + missing.length);
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    have = have.concat(missing);
  }
  sh.appendRow(have.map(function (h) {
    var i = DELETED_HEADERS.indexOf(h);
    return i < 0 ? '' : row[i];
  }));
}

/* ── BACKFILLING THE PAY-PERIOD COLUMN ────────────────────────────────────────────────────────
 * programToRow_ derives it on every write from 2026-09-08, so anything saved after that is right.
 * The 25 rows already on the sheet are not, and nothing rewrites a row that nobody edits — so a
 * closed program from last September would carry its pay date forever.
 *
 * ONLY THE ONE CELL, on both sheets. Re-saving each program through programToRow_ would pick up
 * the derivation and also rewrite every other column and stamp updated_at, on 24 settled records,
 * to fix one field. The rename route takes the same care for the same reason.
 *
 * THE PROGRESS CACHE HOLDS ITS OWN COPY, written from the program at snapshot time, and
 * payPeriodMatches_ compares against it — so fixing `programs` alone would leave the filter
 * matching nothing for exactly the rows a consumer asks about. Both or neither.
 *
 * Dry by default. It touches 25 money-adjacent records and the correct first move is to read what
 * it would do.
 */
function backfillPayPeriods_(p) {
  if (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP)) {
    return { ok: false, error: 'Unauthorized' };
  }
  var apply = String(p.apply || '') === '1';

  var sh = dataSheet_(), last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'no programs' };
  var idCol = PROGRAM_HEADERS.indexOf('program_id');
  var sdCol = PROGRAM_HEADERS.indexOf('start_date');
  var ppCol = PROGRAM_HEADERS.indexOf('pay_period');
  var vals = sh.getRange(2, 1, last - 1, PROGRAM_HEADERS.length).getValues();

  var changes = [], already = 0, noWindow = [];
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][idCol]);
    var sd = textDate_(vals[i][sdCol]);
    var was = String(vals[i][ppCol] == null ? '' : vals[i][ppCol]).trim();
    var want = periodStartFor_(sd);
    if (!want) { if (id) noWindow.push(id); continue; }
    if (was === want) { already++; continue; }
    changes.push({ program_id: id, from: was, to: want, start_date: sd, row: i + 2 });
  }

  /* The cached copies, keyed by program so the two sheets cannot disagree. */
  var psh = progressSheet_(), pvals = psh.getLastRow() < 2 ? [] : psh.getDataRange().getValues();
  var wantBy = Object.create(null);
  changes.forEach(function (c) { wantBy[c.program_id] = c.to; });
  vals.forEach(function (v) {
    var id = String(v[idCol]), w = periodStartFor_(textDate_(v[sdCol]));
    if (id && w) wantBy[id] = w;                      // every program, not only the changed ones
  });
  var rowFixes = [];
  for (var j = 1; j < pvals.length; j++) {
    var pid = String(pvals[j][0]);
    var cur = String(pvals[j][1] == null ? '' : pvals[j][1]).trim();
    var tgt = wantBy[pid];
    if (!tgt || cur === tgt) continue;
    rowFixes.push({ row: j + 1, program_id: pid, from: cur, to: tgt });
  }

  if (!apply) {
    return { ok: true, dry: true,
             programs_to_fix: changes.length, programs_already_correct: already,
             progress_rows_to_fix: rowFixes.length,
             programs_with_no_window: noWindow,
             changes: changes.map(function (c) {
               return { program_id: c.program_id, from: c.from || '(blank)', to: c.to }; }),
             note: 'Nothing was changed. Re-run with apply=1.' };
  }

  changes.forEach(function (c) { sh.getRange(c.row, ppCol + 1).setValue(c.to); });
  rowFixes.forEach(function (r) { psh.getRange(r.row, 2).setValue(r.to); });
  /* Both sheets pin these columns to text; re-assert it, because setValue on a date-looking
     string is exactly where Sheets coerces one back into a Date object. */
  /* forceTextDates_ — the programs sheet's own pinner. An earlier draft called a
     forceProgramTextDates_ that does not exist, behind a `&&` guard, which would have quietly
     skipped the pinning: the same silent-no-op shape as the getConfig() slip earlier today. Both
     were caught by checking the symbol rather than trusting the name it ought to have had. */
  if (changes.length) forceTextDates_(sh);
  if (rowFixes.length) forceProgressTextDates_(psh);
  invalidatePrograms_();

  return { ok: true, dry: false, programs_fixed: changes.length,
           progress_rows_fixed: rowFixes.length,
           programs_with_no_window: noWindow };
}

/* ── RENAMING A PROGRAM'S ID ──────────────────────────────────────────────────────────────────
 * Sky, 2026-09-08: "update id green-cross-test-202608 to reflect the Portland Heights program."
 *
 * WHY THIS IS A ROUTE AND NOT A CELL EDIT, which is the same reason deleting is. `program_id` is a
 * FOREIGN KEY, not a label:
 *
 *   · `spiff_progress` keys every measurement row on it — 38 rows for this program alone.
 *   · `?action=progress` drops any cached row whose program_id is absent from `programs`, and
 *     counts it in `orphan_rows`.
 *   · GX Crew's incentive column and the Leaderboard kiosks read that route.
 *   · Core's `spiff_publications` now carries the id INSIDE the published payload, in rows[] and
 *     in by_employee[].programs[].
 *
 * So editing the cell in `programs` and stopping there would strand 38 measurement rows carrying
 * $181.50 — which is the BeGOAT failure of 2026-08-31 reproduced exactly (25 stranded rows, $350,
 * fourteen people showing as owed $25 for a fortnight already paid). The whole point of having a
 * delete route was that a program is not one row; the same is true of a rename.
 *
 * THIS ONE IS ALLOWED ON A CLOSED PROGRAM, unlike a delete, and the distinction is the point. A
 * delete removes money that was reported and paid; a rename moves the same money to a key that
 * says what it is. Nothing about the figures, the window, the vendor or the payout changes — and
 * `green-cross-test-202608` is a CLOSED, PAID program whose id is the one thing about it that is
 * wrong, because ids are minted from the name at creation and it was created while named "Green
 * Cross test". Refusing here would leave the misleading id permanent.
 *
 * WHAT IT DOES NOT DO: renumber history for its own sake. The id is not shown to anyone — the UI
 * names programs through programLabel() — so this is worth running when an id actively misleads a
 * reader of the sheet or a consumer's payload, and not otherwise.
 *
 * ORDER MATTERS. The progress rows move FIRST. If the run dies between the two halves, the cache
 * points at an id that does not exist yet and those rows read as orphans — visible, counted, and
 * fixed by re-running. The other order would unfile the program while its measurements still
 * pointed at the old key, which reads as a successful rename with the money silently gone.
 */
function renameProgramId_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot rename SPIFF programs' };
  }
  var from = String(p.id || '').trim();
  var to   = slug_(String(p.to || '').trim());
  if (!from || !to) return { ok: false, error: 'id and to are both required' };
  if (from === to)  return { ok: false, error: 'the new id is the same as the old one' };

  var current = getProgram_(from);
  if (!current.ok) return current;
  var prog = current.program;

  /* A COLLISION WOULD MERGE TWO PROGRAMS' MEASUREMENTS. There is already a
     portland-heights-2026-03-30-2026-04-12; landing on an id in use would silently pool two
     fortnights of earnings under one key. */
  if (getProgram_(to).ok) {
    return { ok: false, error: 'a program with id "' + to + '" already exists — pick another' };
  }

  /* Confirm by NAME, server-side, exactly as the delete does: the caller has to have read the
     record it is changing, and a bare id in a re-fetched URL cannot satisfy that. Writes ride on
     GET here and a URL is a thing that gets pasted, bookmarked and re-fetched. */
  var want = String(prog.program_name || prog.title || '').trim();
  if (String(p.confirm || '').trim() !== want) {
    return { ok: false, error: 'Type the program name exactly to confirm: ' + want };
  }

  var idCol = PROGRAM_HEADERS.indexOf('program_id');
  var progressRows = countProgressRows_(from);

  if (String(p.apply || '') !== '1') {
    return { ok: true, dry: true, from: from, to: to, program_name: want,
             status: prog.status, window: [prog.start_date, prog.end_date],
             progress_rows_to_move: progressRows,
             note: 'Nothing was changed. Re-run with apply=1 to rename.' };
  }

  /* Tombstone the row as it stands, before anything moves. A copy is recoverable; a half-moved
     program is not. Reuses the deleted_programs tab deliberately — it is the audit trail for "this
     id no longer exists", which is true of a rename too, and a second near-identical tab would be
     a second place to look. */
  writeTombstone_(prog, auth.user, 'renamed to ' + to);

  /* 1. THE MEASUREMENTS FIRST — see the header. */
  var moved = 0;
  try { moved = repointProgressRows_(from, to); }
  catch (e) {
    /* Scrubbed: a GXCore call can wrap a UrlFetchApp underneath, and that puts the whole URL —
       secret included — into its exception message. The rule is blanket for exactly that reason. */
    return { ok: false, error: 'Could not move the cached progress rows ('
               + scrubSecrets_(e && e.message || e)
               + '). NOTHING was renamed — the program still answers to ' + from + '.' };
  }

  /* 2. THEN THE PROGRAM ROW. */
  var sh = dataSheet_(), last = sh.getLastRow(), renamed = false;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, PROGRAM_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][idCol]) !== from) continue;
      sh.getRange(i + 2, idCol + 1).setValue(to);
      renamed = true;
      break;
    }
  }
  if (!renamed) {
    return { ok: false, error: 'The progress rows were moved to ' + to + ' but the program row was '
               + 'not found to rename — those rows now read as orphans. Re-run with id=' + to
               + ' and to=' + from + ' to put them back, or fix the programs row by hand.' };
  }
  /* Only `programs` is cached — the spiff_progress sheet is read directly, so there is nothing
     else to clear. An earlier draft of this called an invalidateProgressCache_() that does not
     exist; it would have thrown here, AFTER both halves had already moved. */
  invalidatePrograms_();

  /* 3. REPUBLISH, so Core's copy stops carrying the old id inside its payload. Core upserts on
     (producer, scope), so this overwrites the affected period rather than adding to it. Reported
     rather than thrown: the rename itself is done and correct, and the hourly trigger would
     republish anyway within the hour. */
  var republished = null, pubError = '';
  try {
    var pub = publishSpiffToCore_({ notes: 'republish after renaming ' + from + ' to ' + to });
    if (pub && pub.ok) republished = pub.published;
    else pubError = (pub && (pub.error || JSON.stringify(pub.failed))) || 'unknown';
  } catch (e) { pubError = scrubSecrets_(e && e.message || e); }

  return { ok: true, dry: false, from: from, to: to, program_name: want,
           progress_rows_moved: moved, republished: republished,
           renamed_by: auth.user,
           warning: pubError
             ? 'Renamed, but the republish to Core failed (' + pubError + ') — Core still holds the '
               + 'old id inside its payload until the hourly trigger republishes.' : undefined };
}

/* How many cached rows a program has, without touching them. */
function countProgressRows_(programId) {
  var sh = progressSheet_();
  if (sh.getLastRow() < 2) return 0;
  var vals = sh.getDataRange().getValues();
  var n = 0;
  for (var i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(programId)) n++;
  return n;
}

/* Move every cached row from one program id to another. Writes the id COLUMN only — the
 * measurements themselves are untouched, which is the whole point: this is a re-key, not a
 * re-measure, and a settled program's numbers must not change because its id did. */
function repointProgressRows_(from, to) {
  var sh = progressSheet_();
  if (sh.getLastRow() < 2) return 0;
  var vals = sh.getDataRange().getValues();
  var moved = 0;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(from)) continue;
    sh.getRange(i + 1, 1).setValue(to);
    moved++;
  }
  return moved;
}

function deleteProgram_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot delete SPIFF programs' };
  }
  if (!p.id) return { ok: false, error: 'id required' };

  var current = getProgram_(p.id);
  if (!current.ok) return current;
  var prog = current.program;

  if (String(prog.status || '').toLowerCase() === 'closed') {
    return { ok: false, error: 'This program is closed — it ran, was reported to the brand and was '
                             + 'paid, so it stays in History. Only a draft or an active program can be deleted.' };
  }

  /* Confirm by NAME, compared server-side. The caller has to have read the record it is deleting;
     a bare id in a re-fetched URL cannot satisfy this. */
  var want = String(prog.program_name || prog.title || '').trim();
  if (String(p.confirm || '').trim() !== want) {
    return { ok: false, error: 'Type the program name exactly to confirm: ' + want };
  }

  /* Tombstone BEFORE the row goes, so a failure between the two leaves a duplicate rather than
     nothing at all. A copy is recoverable; a gap is not. */
  writeTombstone_(prog, auth.user, String(p.reason || '').slice(0, 500));

  var sh = dataSheet_(), last = sh.getLastRow(), idCol = PROGRAM_HEADERS.indexOf('program_id');
  var removed = false;
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, PROGRAM_HEADERS.length).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i][idCol]) !== String(p.id)) continue;
      sh.deleteRow(i + 2);
      removed = true;
    }
  }
  invalidatePrograms_();

  /* The measurements go with it. Failing here would leave exactly the orphans this route exists to
     avoid, so it is reported rather than swallowed — but the program is already unfiled, and
     re-running the delete is harmless. */
  var dropped = 0, dropError = '';
  try { dropped = dropProgressRows_(p.id); }
  catch (e) { dropError = String(e && e.message || e); }

  return { ok: true, program_id: p.id, deleted: removed, dropped_rows: dropped,
           deleted_by: auth.user, program_name: want,
           warning: dropError ? 'Program removed, but its cached progress rows could not be '
                              + 'dropped (' + dropError + ') — re-run the delete.' : undefined };
}

/* ── PENCILED BRANDS (SPIFF 2.0, phase 2) ─────────────────────────────────────────────────────
 * A pencil holds a slot on the calendar for a brand that has not signed up yet: brand, first and last
 * pay period, an optional note, who and when. Sky, 2026-11-01.
 *
 * THEY LIVE IN THEIR OWN TAB, NEVER IN `programs`, and that is the whole safety argument. The hourly
 * job turns a draft ACTIVE on its start date, and an active program reaches the kiosks and Crew's pay.
 * A pencil stored as a program could go live by itself. In its own tab nothing that reads programs
 * can see one: no status roll, no progress sweep, no publication to Core, no kiosk card, no pay. Do
 * not read this tab from any of those, and do not add a pencil route to the client's
 * ENGINE_HEDGE_READS (a hedged write runs twice). tests/marketing_pay_isolation_test.js holds both.
 *
 * Rows are never deleted. `status` is penciled | locked | released, and every read serves only
 * `penciled`, so releasing a slot or locking it in takes it off the screen and leaves the record.
 *
 * A pencil whose start date has passed stays exactly where it is. Nothing here looks at the clock;
 * the screen says it has started, and a person locks it in with new dates or releases it. */
var PENCILS_TAB = 'pencils';
var PENCIL_HEADERS = ['pencil_id', 'brand', 'start_date', 'end_date', 'note', 'status',
                      'created_by', 'created_at', 'closed_by', 'closed_at', 'program_id'];

function pencilSheet_() {
  var book = dataSheet_().getParent();
  var sh = book.getSheetByName(PENCILS_TAB);
  if (!sh) {
    sh = book.insertSheet(PENCILS_TAB);
    sh.getRange(1, 1, 1, PENCIL_HEADERS.length).setValues([PENCIL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    /* Dates are TEXT at rest; pinned before the first row is written. */
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    sh.getRange(2, 3, rows, 2).setNumberFormat('@');
    sh.getRange(2, 8, rows, 1).setNumberFormat('@');
    sh.getRange(2, 10, rows, 1).setNumberFormat('@');
  }
  return sh;
}

function rowToPencil_(r) {
  return {
    pencil_id: String(r[0] || ''), brand: String(r[1] || ''),
    start_date: textDate_(r[2]), end_date: textDate_(r[3]), note: String(r[4] || ''),
    status: String(r[5] || ''), created_by: String(r[6] || ''), created_at: textDate_(r[7]),
    closed_by: String(r[8] || ''), closed_at: textDate_(r[9]), program_id: String(r[10] || '')
  };
}

function readPencils_() {
  var sh = pencilSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, PENCIL_HEADERS.length).getValues()
    .filter(function (r) { return r[0]; }).map(rowToPencil_);
}

/* Signed-in read. Served from the sheet each time: the tab is tiny and a slot that was just released
   must not reappear from a cache. */
function pencilsRead_() {
  return { ok: true, pencils: readPencils_().filter(function (x) { return x.status === 'penciled'; }) };
}

/* The last day of the pay period that STARTS on `start`. */
function periodEndOf_(start) {
  var a = String(start).split('-'), days = payPeriodCfg_().days;
  var d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2] + days - 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
       + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* A pencil's window is whole pay periods, first start to last end. Returns '' when it is, else why not. */
function pencilWindowError_(start, end) {
  var iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(start || '')) || !iso.test(String(end || ''))) return 'Pick a first and a last pay period.';
  if (periodStartFor_(start) !== start) return 'The first date must be the start of a pay period.';
  if (periodEndOf_(periodStartFor_(end)) !== end) return 'The last date must be the end of a pay period.';
  if (end < start) return 'The last pay period comes before the first.';
  return '';
}

function pencilEditor_(p, verb) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { fail: { ok: false, error: auth.error || 'Not signed in', needsAuth: true } };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { fail: { ok: false, error: 'Your role (' + auth.role + ') cannot ' + verb + ' penciled brands' } };
  }
  return { auth: auth };
}

function findPencilRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  var rows = sh.getRange(2, 1, last - 1, PENCIL_HEADERS.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function closePencil_(sh, rowNo, status, by, programId) {
  var cur = sh.getRange(rowNo, 1, 1, PENCIL_HEADERS.length).getValues()[0];
  cur[PENCIL_HEADERS.indexOf('status')] = status;
  cur[PENCIL_HEADERS.indexOf('closed_by')] = by;
  cur[PENCIL_HEADERS.indexOf('closed_at')] = nowStamp_();
  cur[PENCIL_HEADERS.indexOf('program_id')] = programId || '';
  sh.getRange(rowNo, 1, 1, PENCIL_HEADERS.length).setValues([cur]);
}

function savePencil_(p) {
  var who = pencilEditor_(p, 'pencil');
  if (who.fail) return who.fail;
  var brand = String(p.brand || '').trim().slice(0, 80);
  if (!brand) return { ok: false, error: 'Add a brand name to pencil it in.' };
  var start = String(p.start_date || '').trim(), end = String(p.end_date || '').trim();
  var bad = pencilWindowError_(start, end);
  if (bad) return { ok: false, error: bad };
  var note = String(p.note || '').trim().slice(0, 300);

  /* A retried call is not a second pencil: writes ride on GET and gx-client retries a slow reply. */
  var same = readPencils_().filter(function (x) {
    return x.status === 'penciled' && x.created_by === who.auth.user && x.brand.toLowerCase() === brand.toLowerCase()
        && x.start_date === start && x.end_date === end;
  })[0];
  if (same) return { ok: true, pencil: same, created: false, replay: true };

  var id = 'pen-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36);
  var pencil = { pencil_id: id, brand: brand, start_date: start, end_date: end, note: note,
                 status: 'penciled', created_by: who.auth.user, created_at: nowStamp_(),
                 closed_by: '', closed_at: '', program_id: '' };
  pencilSheet_().appendRow(PENCIL_HEADERS.map(function (h) { return pencil[h]; }));
  return { ok: true, pencil: pencil, created: true };
}

function releasePencil_(p) {
  var who = pencilEditor_(p, 'release');
  if (who.fail) return who.fail;
  var sh = pencilSheet_(), rowNo = findPencilRow_(sh, p.id);
  if (!rowNo) return { ok: false, error: 'That penciled slot is not there any more.' };
  var cur = rowToPencil_(sh.getRange(rowNo, 1, 1, PENCIL_HEADERS.length).getValues()[0]);
  if (cur.status !== 'penciled') return { ok: true, pencil_id: cur.pencil_id, released: false, status: cur.status };
  closePencil_(sh, rowNo, 'released', who.auth.user, '');
  return { ok: true, pencil_id: cur.pencil_id, released: true };
}

/* LOCK IT IN: the pencil becomes a DRAFT program through createProgram_, so the id, the collision
   rules, the role check and the brand check are the ones every program gets. It is a draft with a
   zero payout and no goals: nothing is owed to anybody until a person sets them in the Calculator.
   Optional start_date / end_date replace the pencil's window (the way out for a slot whose start
   has passed). The pencil is closed only once the program exists, so a failed create leaves the slot. */
function lockPencil_(p) {
  var who = pencilEditor_(p, 'lock in');
  if (who.fail) return who.fail;
  var sh = pencilSheet_(), rowNo = findPencilRow_(sh, p.id);
  if (!rowNo) return { ok: false, error: 'That penciled slot is not there any more.' };
  var cur = rowToPencil_(sh.getRange(rowNo, 1, 1, PENCIL_HEADERS.length).getValues()[0]);
  if (cur.status !== 'penciled') {
    return { ok: false, error: 'That slot was already ' + cur.status + '.', status: cur.status, program_id: cur.program_id };
  }
  var start = String(p.start_date || cur.start_date).trim(), end = String(p.end_date || cur.end_date).trim();
  var bad = pencilWindowError_(start, end);
  if (bad) return { ok: false, error: bad };

  var stores = parseJson_(p.stores, []);
  stores = (Array.isArray(stores) ? stores : []).filter(function (s) { return /^[a-z0-9-]{1,40}$/.test(String(s)); });
  var draft = {
    program_name: 'All products', vendor: cur.brand,
    start_date: start, end_date: end, stores_json: stores,
    cost_json: { mode: 'flat', per_unit: 0, source_label: 'penciled' },
    payout_type: 'flat', payout_json: { model: 'flat', amount: 0 },
    target_json: { units: 0, budtenders: 0, by_store: {}, per_bt: {}, bts_by_store: {} }
  };
  var made = createProgram_({ token: p.token, program: JSON.stringify(draft), confirm_brand: '1' });
  if (!made || !made.ok) return made || { ok: false, error: 'Could not make the program.' };
  closePencil_(sh, rowNo, 'locked', who.auth.user, made.program_id);
  return { ok: true, pencil_id: cur.pencil_id, program_id: made.program_id, locked: true };
}

/* ── HOLIDAY SENDS (SPIFF 2.0, Sky 2026-11-02) ─────────────────────────────────────────────────
 * A holiday blast (Thanksgiving, Christmas, New Year's Eve) is an email and/or text send of our own:
 * name, send date, channels, note. It runs the same blast cycle as a vendor program's email and text
 * (deal locked, copy ready, proofs to Sky, send, stats), counted back from its send date, and its
 * ticks, hand-moved dates and hand-offs are kept in its own `marketing_json` cell.
 *
 * IT IS NOT A PROGRAM, and lives in its own tab for the same reason pencils do: nothing that reads
 * `programs` can see one, so no status roll, no progress sweep, no publication to Core, no kiosk
 * card and no pay. Do not read this tab from any of those, and do not add a holiday route to the
 * client's ENGINE_HEDGE_READS. tests/marketing_pay_isolation_test.js holds both.
 *
 * Rows are never deleted: `status` is planned | canceled, and every read serves only `planned`.
 * Nothing is seeded; Sky adds the holidays himself. */
var HOLIDAYS_TAB = 'holidays';
var HOLIDAY_HEADERS = ['holiday_id', 'name', 'send_date', 'channels', 'note', 'status', 'marketing_json',
                       'created_by', 'created_at', 'closed_by', 'closed_at'];
var HOLIDAY_CHANNELS = ['email', 'sms'];

function holidaySheet_() {
  var book = dataSheet_().getParent();
  var sh = book.getSheetByName(HOLIDAYS_TAB);
  if (!sh) {
    sh = book.insertSheet(HOLIDAYS_TAB);
    sh.getRange(1, 1, 1, HOLIDAY_HEADERS.length).setValues([HOLIDAY_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    /* Dates are TEXT at rest; pinned before the first row is written. */
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    sh.getRange(2, 3, rows, 1).setNumberFormat('@');
    sh.getRange(2, 9, rows, 1).setNumberFormat('@');
    sh.getRange(2, 11, rows, 1).setNumberFormat('@');
  }
  return sh;
}

function holidayChannels_(v) {
  var list = Array.isArray(v) ? v : String(v || '').split(',');
  return HOLIDAY_CHANNELS.filter(function (c) {
    return list.some(function (x) { return String(x).trim().toLowerCase() === c; });
  });
}

/* What a holiday's plan may keep: ticks, hand-moved dates and hand-offs. Its channels and send date
   are columns, so nothing in the cell can disagree with them. */
function holidayPlan_(v) {
  var n = normalizeMarketing_(v) || {};
  var out = { v: 1 };
  ['done', 'due', 'own'].forEach(function (k) { if (n[k] && Object.keys(n[k]).length) out[k] = n[k]; });
  return out;
}

function rowToHoliday_(r) {
  return {
    holiday_id: String(r[0] || ''), name: String(r[1] || ''), send_date: textDate_(r[2]),
    channels: holidayChannels_(r[3]), note: String(r[4] || ''), status: String(r[5] || ''),
    marketing_json: holidayPlan_(parseJson_(r[6], {})),
    created_by: String(r[7] || ''), created_at: textDate_(r[8]),
    closed_by: String(r[9] || ''), closed_at: textDate_(r[10])
  };
}

function holidayToRow_(h) {
  return HOLIDAY_HEADERS.map(function (k) {
    if (k === 'channels') return h.channels.join(',');
    if (k === 'marketing_json') return JSON.stringify(h.marketing_json || { v: 1 });
    return h[k] == null ? '' : h[k];
  });
}

function readHolidays_() {
  var sh = holidaySheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HOLIDAY_HEADERS.length).getValues()
    .filter(function (r) { return r[0]; }).map(rowToHoliday_);
}

/* Signed-in read, from the sheet each time: the tab is tiny, and a canceled send must not reappear
   from a cache. */
function holidaysRead_() {
  return { ok: true, holidays: readHolidays_().filter(function (h) { return h.status === 'planned'; }) };
}

function findHolidayRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function getHoliday_(id) {
  var sh = holidaySheet_(), rowNo = findHolidayRow_(sh, id);
  if (!rowNo) return { ok: false, error: 'That holiday send is not there any more.' };
  return { ok: true, holiday: rowToHoliday_(sh.getRange(rowNo, 1, 1, HOLIDAY_HEADERS.length).getValues()[0]), sh: sh, rowNo: rowNo };
}

/* Create (no id) or change name / send date / channels / note (with id). */
function saveHoliday_(p) {
  var who = mktEditor_(p, 'plan holiday sends');
  if (who.fail) return who.fail;
  var name = String(p.name || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Name the holiday send.' };
  var day = String(p.send_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'Pick a send date.' };
  var channels = holidayChannels_(p.channels);
  if (!channels.length) return { ok: false, error: 'Pick email, text, or both.' };
  var note = String(p.note || '').trim().slice(0, 300);

  if (p.id) {
    var got = getHoliday_(p.id);
    if (!got.ok) return got;
    if (got.holiday.status !== 'planned') return { ok: false, error: 'That holiday send was ' + got.holiday.status + '.' };
    var h = got.holiday;
    h.name = name; h.send_date = day; h.channels = channels; h.note = note;
    got.sh.getRange(got.rowNo, 1, 1, HOLIDAY_HEADERS.length).setValues([holidayToRow_(h)]);
    return { ok: true, holiday: h, created: false };
  }

  /* A retried call is not a second send: writes ride on GET and gx-client retries a slow reply. */
  var same = readHolidays_().filter(function (x) {
    return x.status === 'planned' && x.created_by === who.auth.user && x.name.toLowerCase() === name.toLowerCase()
        && x.send_date === day;
  })[0];
  if (same) return { ok: true, holiday: same, created: false, replay: true };

  var made = { holiday_id: 'hol-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36),
               name: name, send_date: day, channels: channels, note: note, status: 'planned',
               marketing_json: { v: 1 }, created_by: who.auth.user, created_at: nowStamp_(),
               closed_by: '', closed_at: '' };
  holidaySheet_().appendRow(holidayToRow_(made));
  return { ok: true, holiday: made, created: true };
}

function cancelHoliday_(p) {
  var who = mktEditor_(p, 'cancel holiday sends');
  if (who.fail) return who.fail;
  var got = getHoliday_(p.id);
  if (!got.ok) return got;
  if (got.holiday.status !== 'planned') return { ok: true, holiday_id: got.holiday.holiday_id, canceled: false, status: got.holiday.status };
  var h = got.holiday;
  h.status = 'canceled'; h.closed_by = who.auth.user; h.closed_at = nowStamp_();
  got.sh.getRange(got.rowNo, 1, 1, HOLIDAY_HEADERS.length).setValues([holidayToRow_(h)]);
  return { ok: true, holiday_id: h.holiday_id, canceled: true };
}

/* A tick, a moved date or a hand-off: the same [section, key, value] operations a program's plan
   takes (applyMarketingDelta_), applied to what is stored NOW under the script lock, so two people
   ticking different tasks cannot undo each other. */
function saveHolidayPlan_(p) {
  var who = mktEditor_(p, 'change holiday sends');
  if (who.fail) return who.fail;
  var ops = parseJson_(p.patch, {});
  ops = ops && Array.isArray(ops.marketing_delta) ? ops.marketing_delta : null;
  if (!ops) return { ok: false, error: 'Nothing to save.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another save is in progress. Try again in a moment.' };
  try {
    var got = getHoliday_(p.id);
    if (!got.ok) return got;
    if (got.holiday.status !== 'planned') return { ok: false, error: 'That holiday send was ' + got.holiday.status + '.' };
    var h = got.holiday;
    h.marketing_json = holidayPlan_(applyMarketingDelta_(h.marketing_json, ops));
    got.sh.getRange(got.rowNo, 1, 1, HOLIDAY_HEADERS.length).setValues([holidayToRow_(h)]);
    return { ok: true, holiday_id: h.holiday_id, marketing_json: h.marketing_json };
  } finally {
    lock.releaseLock();
  }
}

/* Validate a GX Core session token and resolve this user's role on `spiff`.
   Memoized for the life of ONE execution: guard_ now validates before the switch, and the
   write functions still check their own role afterwards, so without this every write would
   pay two ~1s round trips to Core to ask the same question twice.

   Object.create(null), not {} -- this is a map indexed by RAW USER INPUT, the exact shape
   pricecards got bitten by. With a plain object, token='toString' would hit the inherited
   function, return it as the cached answer, and `auth.ok` would read undefined. That happens
   to fail CLOSED here, but relying on which way an accident falls is not a control. */
var _authMemo = Object.create(null);

/* ── A SUCCESSFUL SESSION CHECK IS REMEMBERED FOR FIVE MINUTES, ACROSS EXECUTIONS (2026-09-15) ──
   Every call from a signed-in browser used to cost a SECOND execution in GX Core to ask "is this
   token still good?" — four on every page load, and one per date window per store while Progress
   pulled. Every GX web app and trigger runs as the same Google account, and Google lets that
   account run 30 things at once; on 2026-09-15 the suite peaked at 114, and SPIFF's bursts lined
   up with Core's (62 Core starts in one minute beside 22 of ours). The per-execution memo above
   could not help, because each of those calls is its own execution.

   What makes this safe:
   · ONLY A YES IS CACHED. A refusal, an expiry or a Core hiccup is re-asked every time, so a
     newly granted person is let in at once and a transient failure never sticks.
   · Keyed by a SHA-256 of the token, never the token — the cache is readable by anything in this
     project, and a raw token there is a session anyone with the editor could lift.
   · Never outlives the token. The expiry is the middle field of `user:exp:sig`, signed by Core;
     reading it here only SHORTENS the cache, and the signature is still Core's to check on a miss.
   · THE COST, stated: a grant REMOVED or a role CHANGED in Command Center takes up to five minutes
     to reach SPIFF, where it took up to one (Core caches grants for 60s itself). */
var AUTH_CACHE_TTL_S = 300;
var AUTH_CACHE_PREFIX = 'auth1_';

function authCacheKey_(token) {
  try {
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, APP + '|' + String(token));
    var hex = '';
    for (var i = 0; i < d.length; i++) hex += ('0' + (d[i] & 0xFF).toString(16)).slice(-2);
    return AUTH_CACHE_PREFIX + hex;
  } catch (e) { return ''; }
}

/* Seconds this token may still be cached for: the lesser of the TTL and its own remaining life.
   0 means do not cache — a token with no readable expiry is Core's question, not ours. */
function authCacheTtl_(token, nowMs) {
  var exp = Number(String(token).split(':')[1] || 0);
  if (!exp || !isFinite(exp)) return 0;
  var left = Math.floor((exp - nowMs) / 1000);
  if (left < 30) return 0;
  return Math.min(AUTH_CACHE_TTL_S, left);
}

function gxAuth_(token) {
  if (!token) return { ok: false, error: 'Not signed in' };
  if (_authMemo[token]) return _authMemo[token];

  var cache = null, ckey = '';
  try { cache = CacheService.getScriptCache(); ckey = authCacheKey_(token); } catch (e) { cache = null; }
  if (cache && ckey && authCacheTtl_(token, Date.now()) > 0) {
    try {
      var hit = cache.get(ckey);
      if (hit) {
        var v = JSON.parse(hit);
        if (v && v.ok === true) { _authMemo[token] = v; return v; }
      }
    } catch (e) { /* an unreadable entry is not an answer — ask Core */ }
  }

  var url = GXCORE_URL + '?action=validate&app=' + encodeURIComponent(APP) + '&token=' + encodeURIComponent(token);
  /* RETRIED, because /exec bounces and the cost of not retrying here is a person being told they
     are signed out in the middle of a save. A READ — it asks Core a question and changes nothing —
     so a repeat is free. */
  var r = gxCoreFetchJson_(url, 'session check');
  if (r.ok) {
    _authMemo[token] = r.data;
    var ttl = (r.data && r.data.ok === true) ? authCacheTtl_(token, Date.now()) : 0;
    if (cache && ckey && ttl > 0) {
      try { cache.put(ckey, JSON.stringify(r.data), ttl); } catch (e) { /* cache full — just ask again next time */ }
    }
    return r.data;
  }
  /* Deliberately NOT memoized: a transient Core hiccup must not pin this execution into a
     failure it would recover from on the next call. */
  return { ok: false, error: 'Could not reach GX Core to verify your session — ' + scrubSecrets_(r.error) };
}

function programToRow_(p, audit) {
  var by = audit ? (audit.edited_by || '') : '';
  var at = audit ? (audit.edited_at || '') : '';
  return [
    p.program_id, p.vendor || '', p.program_name || '', p.title || '', p.status || 'draft',
    p.start_date || '', p.end_date || '',
    /* ── DERIVED, NOT TAKEN FROM THE CALLER (2026-09-08) ────────────────────────────────────
       Enforced here for the same reason stripDerivedActuals_ is a few lines down: every write
       funnels through this function, and a rule enforced in one place cannot be forgotten by the
       next writer. Which is exactly how the column got into the state it was in.

       WHAT IT HELD. All 23 seeded programs stored their window's END + 5 days — consistently, to
       the day. That is the PAY DATE, when payroll for the fortnight runs. Real data, in a column
       whose name, whose schema comment ("pay-period start — joins to Leaderboard") and whose only
       consumers all mean the period START. It joined to nothing: Leaderboard keys periods on
       `period_start`, so every join on this column missed by a fortnight and five days. The one
       app-created program held the range string "2026-08-17 - 2026-08-30" instead, which is not a
       date at all.

       That is why spiffProgress_ already carries a note saying Crew found the pay_period filter
       unusable and passes nothing, taking the whole payload. This is the cause.

       THE PAY DATE IS NOT LOST — it is end_date + 5, derivable whenever anybody wants it, and
       nothing in the suite reads it today. Keeping a second column for a value nothing consumes
       would be the worse trade.

       Blank start_date leaves this blank rather than guessing a period for a program that has no
       window yet. */
    periodStartFor_(textDate_(p.start_date)) || '',
    JSON.stringify(p.match_json    || {}),
    JSON.stringify(p.stores_json   || []),
    JSON.stringify(p.cost_json     || {}),
    p.payout_type || 'flat',
    JSON.stringify(p.payout_json   || {}),
    JSON.stringify(p.baseline_json || {}),
    JSON.stringify(p.target_json   || {}),
    /* Derived flags are stripped here, not at the call site. Every write funnels through this
       function, and a rule enforced in one place cannot be forgotten by the next writer -- which is
       exactly how these ended up stored in the first place. */
    p.actual_json ? JSON.stringify(stripDerivedActuals_(p.actual_json)) : '',
    p.source || '', nowStamp_(), by, at, p.share_token || '',
    p.contact_name || '', p.contact_email || '', JSON.stringify(p.doc_json || {}),
    p.progress_json ? JSON.stringify(p.progress_json) : '',
    JSON.stringify(normalizePitch_(p.pitch_json)),
    /* Same funnel, same reason: whatever a caller computed is dropped here. */
    (function (m) { return m ? JSON.stringify(m) : ''; })(normalizeMarketing_(p.marketing_json))
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
    contact_name: r[21] || '', contact_email: r[22] || '', doc_json: parseJson_(r[23], {}),
    progress_json: parseJson_(r[24], null),
    pitch_json: normalizePitch_(parseJson_(r[25], null)),
    marketing_json: normalizeMarketing_(parseJson_(r[26], null))
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
/* WHAT A PROGRAM PAYS, AND HOW — read from every shape this datastore actually holds.
 *
 * There are three, because the payout has been written by three different things:
 *   { amount }                the 22 flat programs, seeded and Calculator-written alike
 *   { amount, model }         what the Calculator writes today
 *   { per_unit }              what the SPIF-doc seed wrote for Hapy Kitchen
 * plus a `payout_type` COLUMN beside the JSON, which the Calculator also fills.
 *
 * progEarned_ used to read `payout_json.type` and `payout_json.per_unit` — a fourth shape, which
 * nothing has ever written. So every per_unit program fell through to the flat branch and paid
 * `hit ? amount : 0`; and since a per_unit program has no per-budtender target to clear, nobody
 * was ever `hit`. BOTH per-unit programs in the datastore therefore paid EVERY budtender $0.
 *
 * Found 2026-09-01 by Sky, on a live $0.75/unit program covering 3,514 units across six stores:
 * "the new spiff Portland Heights should create a spiff reward for almost every employee." It
 * created one for nobody. Hapy Kitchen, $1/unit in February, has the same hole in its history.
 *
 * Read the model from the places that are written, in the order they are trustworthy. */
function payoutModelOf_(prog) {
  var pay = prog.payout_json || {};
  var m = String(pay.model || prog.payout_type || pay.type || '').toLowerCase();
  /* per_unit is the only non-flat model the engine implements; `tiered` is schema'd and is not,
     so it must resolve to flat rather than silently paying nothing. */
  return m === 'per_unit' ? 'per_unit' : 'flat';
}

/* The money, in the unit the model implies: dollars-per-unit for per_unit, dollars-per-budtender
   for flat. `per_unit` is checked before `amount` because a row that carries BOTH means the seed
   wrote the rate and something later added a headline figure beside it. */
function payoutRateOf_(prog) {
  var pay = prog.payout_json || {};
  if (payoutModelOf_(prog) === 'per_unit') {
    var r = pay.per_unit != null ? pay.per_unit : pay.amount;
    return Number(r) || 0;
  }
  return Number(pay.amount) || 0;
}

function progEarned_(prog, units, hit) {
  if (payoutModelOf_(prog) === 'per_unit') {
    return (Number(units) || 0) * payoutRateOf_(prog);
  }
  return hit ? payoutRateOf_(prog) : 0;
}

/**
 * Refresh the cache for every ACTIVE program. Run from a TIME TRIGGER, not the web app: a full
 * sweep is ~9s per store per program and /exec dies at 60s, while a trigger gets six minutes.
 * `only` limits it to one program_id, which is what the on-demand refresh uses.
 */
function refreshSpiffProgress_(only, onlyStore, opts) {
  /* The hourly sweep is ACTIVE-only, deliberately — closed programs do not move and re-measuring
     22 of them every hour is pure cost. But a program named EXPLICITLY is swept whatever its
     status: a vendor report is sent AFTER close, and the per-store breakdown on it has to come
     from somewhere. Without this the cache could never hold a closed program, so client.html had
     no per-store rows and printed 0 for every store under a headline of 117. */
  var programs = (only ? listPrograms_() : listPrograms_('active')).filter(function (p) {
    return !only || String(p.program_id) === String(only);
  });
  var now = nowStamp_();
  var written = [], failures = [], skipped = [];

  /* ── STOP ON THE CLOCK (2026-09-16) ──────────────────────────────────────────────────────────
     Each store below is one HTTP call to GX Core, made one at a time, and the sweep does nothing
     but wait for it. So this loop's duration is not a measure of how much work there is — it is a
     readout of how slow Core is this hour. A week of hourly runs published the IDENTICAL result
     (38 / 35 / 20 rows) in anywhere from 50s to 636.6s: same work, twelve times the wall clock.
     Core is slowest exactly when the shared 30-execution account is busiest, so an unbounded sweep
     made SPIFF hold its slot longest at the worst possible moment, firing more Core calls while it
     waited. Two runs outlived the lease that is meant to keep one copy running (Sep 14 at 636.6s,
     Sep 16 at 526.4s).

     `deadline` is an ABSOLUTE stamp measured from the START OF THE RUN, not from the start of this
     loop — the freeze phase ahead of it has its own budget, and what has to be bounded is the run.
     The hourly trigger is the only caller that passes one; the manual single-store refresh is one
     read that a human is waiting on, and truncating that would be a bug rather than a mercy.

     WHAT A SKIPPED STORE COSTS, and it is the reason this is safe: nothing is deleted for it. The
     replace below is scoped to the program+store pairs that actually came back, so a store this
     loop never reaches keeps the rows it already had — exactly what a FAILED store has always
     done. A store that did not answer is not a store that sold nothing. The price is a figure an
     hour staler, which every consumer already reads off `age_minutes`. */
  var deadline = Number((opts || {}).deadline) || 0;

  programs.forEach(function (prog) {
    var stores = prog.stores_json || [];
    stores.forEach(function (store) {
      var slug = slug_(store && store.store_id ? store.store_id : store);
      if (!slug) return;
      if (onlyStore && slug !== slug_(onlyStore)) return;
      /* Checked before the call rather than after, so the budget bounds what the run STARTS. The
         loop still runs to the end — it costs nothing without a fetch, and finishing it is what
         makes `skipped` a list of what was missed instead of a count that stops at the first one. */
      if (deadline && Date.now() > deadline) {
        skipped.push({ program_id: prog.program_id, store: slug });
        return;
      }
      var r;
      try { r = sellthrough_({ id: prog.program_id, store: slug }); }
      catch (e) { r = { ok: false, error: scrubSecrets_((e && e.message) || e) }; }
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
           /* Kept apart from `failures` on purpose. A failure is a store that answered badly and
              will be retried next hour; a skip is a store that was never asked because the run ran
              out of clock. They need different reactions, and a count that merges them would hide
              a Core outage inside a busy afternoon. */
           skipped: skipped, out_of_budget: skipped.length > 0,
           swept: seen, all_programs_by_status: byStatus };
}

/* ══════════════════════ FROZEN PROGRESS ══════════════════════
 * A program's results stop changing the moment it stops running, and from then on recomputing them
 * costs six stores of Dutchie calls (~9s each) to arrive at the same answer. So they are measured
 * ONCE and written to the program's own row, and History and the record read them instantly.
 *
 * WHICH PROGRAMS QUALIFY, and the second one is Sky's (2026-09-02):
 *   closed                     — settled. Reported to the vendor, paid, done.
 *   draft whose window PASSED  — "plausible that a draft sits for a while, and should be re-calc'd
 *                                if past the proposed window." The status roll deliberately leaves
 *                                these alone because "drafted and never run" and "ran and finished"
 *                                are different facts only a human can tell apart — but the sales
 *                                either happened or they did not, and measuring them is what makes
 *                                that call answerable instead of a guess.
 *
 * An ACTIVE program is never frozen: its numbers are still moving, and the live grid is the point.
 *
 * WHY IT IS NOT THE shared spiff_progress TAB. Crew fetches that tab WHOLE and unfiltered — it
 * filters by window itself — so adding the 23 closed programs to it would take one response from
 * 23KB to about 343KB against Crew's 95KB cache ceiling. Crew would stop caching and re-fetch
 * everything on every page load. Measured 2026-09-02. The shared tab stays the live feed; this is
 * the archive, and it belongs to SPIFF alone.
 */

/* Has this program stopped moving? Returns the reason, or '' when it is still live. */
function snapshotReasonFor_(prog) {
  var st = String(prog.status || '').trim().toLowerCase();
  if (st === 'closed') return 'closed';
  if (st === 'draft') {
    var end = textDate_(prog.end_date);
    if (end && end < today_()) return 'draft whose window has passed';
  }
  return '';
}

/* Measure one program across every store it ran in and return the frozen shape. ~9s per store, so
 * this is for a TRIGGER or a bounded backfill, never for a /exec call that a browser is waiting on.
 *
 * A store that refuses is NAMED in `partial` and its rows are omitted — never written as zeros. A
 * snapshot that quietly undercounts is worse than no snapshot, because nothing downstream can tell
 * the difference between "this store sold nothing" and "this store did not answer".
 */
function snapshotProgram_(prog) {
  var stores = prog.stores_json || [];
  if (!stores.length) return { ok: false, error: 'program has no stores' };
  var from = textDate_(prog.start_date), to = textDate_(prog.end_date);
  if (!from || !to) return { ok: false, error: 'program has no window' };

  var rate = payoutRateOf_(prog), perUnit = payoutModelOf_(prog) === 'per_unit';
  var out = { at: nowStamp_(), from: from, to: to, rate: rate,
              model: perUnit ? 'per_unit' : 'flat',
              units: 0, earners: 0, earned: 0, stores: [], partial: [] };

  stores.forEach(function (raw) {
    var slug = slug_(raw && raw.store_id ? raw.store_id : raw);
    if (!slug) return;
    var r;
    try { r = sellthrough_({ id: prog.program_id, store: slug }); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!r || r.ok === false) { out.partial.push(slug); return; }

    var rows = (r.rows || []).map(function (e) {
      var earned = progEarned_(prog, e.units, e.hit);
      return { name: e.name, employee_id: e.employee_id || '',
               units: Number(e.units) || 0, hit: !!e.hit,
               earned: Math.round(earned * 100) / 100 };
    });
    out.stores.push({ store_id: slug, units: Number(r.units) || 0,
                      target: Number(r.target) || 0, rows: rows });
    out.units   += Number(r.units) || 0;
    out.earned  += rows.reduce(function (n, x) { return n + x.earned; }, 0);
    /* Who EARNED, which is not who hit: a per-unit program pays from the first unit and sets no
       individual target, so `hit` is false for everyone however much was sold. */
    out.earners += rows.filter(function (x) { return perUnit ? x.units > 0 : x.hit; }).length;
  });

  out.earned = Math.round(out.earned * 100) / 100;
  if (!out.stores.length) return { ok: false, error: 'no store answered', partial: out.partial };
  /* Same refusal as snapshotStore_, so the hourly sweep cannot write what the web path won't. */
  var rec = Number((prog.actual_json || {}).units_sold) || 0;
  if (out.units === 0 && rec > 0) {
    return { ok: false, refused: 'zero_vs_record', recorded: rec,
             error: 'measured 0 units but this program records ' + rec
                  + ' — its filter matches nothing. Not written.' };
  }
  return { ok: true, snapshot: out };
}

/* ONE STORE, MERGED INTO WHAT IS ALREADY THERE.
 *
 * snapshotProgram_ below measures a whole program, which is ~54s for six stores — fine inside a
 * six-minute trigger and DEAD in a web call, which Google kills at 60s. Measured 2026-09-02: the
 * backfill route timed out at 60.15s without writing a thing.
 *
 * So the web path does what every other expensive path in this app already does — one store per
 * request, merged — and the caller loops. Same shape as refreshProgress, and as the Progress grid
 * that loops stores in the browser.
 *
 * The merge is by store_id, so re-running one store corrects it without disturbing the other five,
 * and a partial snapshot is a real state rather than an error: it says which stores it has.
 */
function snapshotStore_(prog, slug) {
  slug = slug_(slug);
  if (!slug) return { ok: false, error: 'store required' };
  var from = textDate_(prog.start_date), to = textDate_(prog.end_date);
  if (!from || !to) return { ok: false, error: 'program has no window' };

  var r;
  try { r = sellthrough_({ id: prog.program_id, store: slug }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'sell-through failed' };

  var perUnit = payoutModelOf_(prog) === 'per_unit';
  var rows = (r.rows || []).map(function (e) {
    return { name: e.name, employee_id: e.employee_id || '',
             units: Number(e.units) || 0, hit: !!e.hit,
             earned: Math.round(progEarned_(prog, e.units, e.hit) * 100) / 100 };
  });

  var snap = prog.progress_json && prog.progress_json.stores
    ? prog.progress_json
    : { from: from, to: to, rate: payoutRateOf_(prog),
        model: perUnit ? 'per_unit' : 'flat', stores: [], partial: [] };
  /* The window and rate are refreshed with every store, so a snapshot half-built before an edit
     cannot end up describing itself with two different windows. */
  snap.from = from; snap.to = to;
  snap.rate = payoutRateOf_(prog);
  snap.model = perUnit ? 'per_unit' : 'flat';
  snap.at = nowStamp_();

  snap.stores = (snap.stores || []).filter(function (x) { return x.store_id !== slug; });
  snap.stores.push({ store_id: slug, units: Number(r.units) || 0,
                     target: Number(r.target) || 0, rows: rows });
  snap.partial = (prog.stores_json || [])
    .map(function (x) { return slug_(x && x.store_id ? x.store_id : x); })
    .filter(function (id) {
      return id && !snap.stores.some(function (x) { return x.store_id === id; });
    });

  snap.units   = snap.stores.reduce(function (n, x) { return n + (Number(x.units) || 0); }, 0);
  snap.earned  = Math.round(snap.stores.reduce(function (n, x) {
    return n + (x.rows || []).reduce(function (m, e) { return m + (Number(e.earned) || 0); }, 0);
  }, 0) * 100) / 100;
  snap.earners = snap.stores.reduce(function (n, x) {
    return n + (x.rows || []).filter(function (e) { return perUnit ? e.units > 0 : e.hit; }).length;
  }, 0);

  /* ── A ZERO THAT CONTRADICTS THE RECORD IS NOT A MEASUREMENT ──────────────────────────────
     Found 2026-09-02 while backfilling: Hellavated measured 0 units against 649 recorded, Hapy
     Kitchen 0 against 289. Not quiet fortnights — broken filters. The SPIF-doc seed copied
     Tawny's PROSE into fields Dutchie has to match literally:

         category "Inhalable Cannabanoid w/ Non-Cannabis Additives"   <- typo, 'a' for 'i'
         category "Edible Solid, Tinctures, Concentrates"             <- a list, not a category
         category "Extracts"  /  "Extracts(Liquid)"                   <- plural, missing space
         products ["All Disposables"]                                 <- no product is called that

     Fifteen of twenty-six programs carry a category that cannot match anything, and category is
     AND-ed, so those measure zero however much sold. Writing that would have filled History with
     empty grids that look authoritative — and the overnight sweep was about to do it to fifteen
     programmes at once.

     So a zero is REFUSED when the record says otherwise, and the reason is returned rather than
     stored. The same rule the rest of this app already follows: a source that could not be read
     is not a measurement of zero. A program with no recorded actuals is left alone — there, zero
     is simply unproven either way and the human has nothing to contradict. */
  var recorded = Number((prog.actual_json || {}).units_sold) || 0;
  if (snap.units === 0 && recorded > 0) {
    return { ok: false, program_id: prog.program_id, store: slug, refused: 'zero_vs_record',
             recorded: recorded,
             error: 'measured 0 units but this program records ' + recorded
                  + '. Its filter matches nothing — check match_json (category and products are '
                  + 'AND-ed, and must be values Dutchie actually uses). Not written.' };
  }

  writeSnapshot_(prog.program_id, snap);
  return { ok: true, program_id: prog.program_id, store: slug,
           units: snap.units, earned: snap.earned, earners: snap.earners,
           stores_done: snap.stores.length, still_missing: snap.partial };
}

/* One cell, found by id. edited_by records the human who last corrected a record, and a
   measurement is not an edit by that person — the same rule the status roll follows. */
function writeSnapshot_(programId, snap) {
  var sh = dataSheet_();
  var pCol = PROGRAM_HEADERS.indexOf('progress_json');
  var ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(programId)) {
      sh.getRange(i + 2, pCol + 1).setValue(JSON.stringify(snap));
      /* BUST THE PROGRAMS CACHE, or the measurement just written is invisible for five minutes.
         Every OTHER writer on this sheet calls invalidatePrograms_; this one did not, because it
         writes a single cell directly rather than going through saveProgram_. The cost was not
         theoretical — Hellavated March measured 650 units, wrote them, and the record still
         showed an empty grid on reload. Two reloads and a JSONP probe later it was still empty,
         which reads exactly like a failed write. The data was on the sheet the whole time.
         Worse during a backfill: 89 pairs written over an evening, each one invisible until a
         cache it never touches happens to expire — so the screen you would use to watch the
         backfill work is the one guaranteed to be behind it. */
      invalidatePrograms_();
      return true;
    }
  }
  return false;
}

/* Every (program, store) pair still needing a measurement. The caller loops it — one request each,
 * ~9s — exactly as the Progress grid does. Writes nothing. */
function snapshotPlan_(opts) {
  opts = opts || {};
  var force = !!opts.force, only = String(opts.program || '').trim();
  var plan = [], skipped = 0;
  listPrograms_().forEach(function (prog) {
    if (only && String(prog.program_id) !== only) return;
    if (!snapshotReasonFor_(prog)) return;
    var have = (prog.progress_json && prog.progress_json.stores) || [];
    (prog.stores_json || []).forEach(function (raw) {
      var slug = slug_(raw && raw.store_id ? raw.store_id : raw);
      if (!slug) return;
      var done = have.some(function (x) { return x.store_id === slug; });
      if (done && !force) { skipped++; return; }
      plan.push({ program: prog.program_id, store: slug, reason: snapshotReasonFor_(prog) });
    });
  });
  return { ok: true, plan: plan, pairs: plan.length, already_done: skipped,
           note: 'one store per call — a whole program is ~54s against a 60s /exec ceiling. '
               + 'Call snapshotProgress with program= and store= for each pair.' };
}

/* Freeze up to `max` programs that qualify and have no snapshot yet.
 *
 * BOUNDED AND RESUMABLE, because the work does not fit anywhere it could be done in one go: six
 * stores at ~9s is ~54s for ONE program, against a 60s /exec ceiling and a 6-minute trigger. The
 * 23-program backfill is roughly twenty minutes of measuring. So this does a little, says what is
 * left, and is safe to call again — the hourly trigger takes one per run and the backfill is the
 * same call in a loop.
 *
 * `force` re-measures programs that already carry a snapshot. That is the break-glass Sky asked
 * for: not the norm, and never automatic, because a settled record should not quietly change after
 * a vendor has been invoiced against it.
 */
/* ── A REFUSAL THAT WILL NOT CHANGE MUST NOT BE RETRIED FOREVER ────────────────────────────────
 * snapshotProgram_ refuses a program that measures 0 against a non-zero record, because that is a
 * broken Dutchie filter and not a fortnight nobody sold anything in. That guard is right and stays.
 * What was wrong is that the refusal is DETERMINISTIC — the same program refuses identically the
 * next hour, and the hour after — while the sweep counted it against the run's budget. Twelve such
 * programs sat at the head of the queue and the sweep did not write a single snapshot between
 * 2026-09-02 and 2026-09-09, with nothing but a console.warn to say so.
 *
 * So a refusal is REMEMBERED, against a fingerprint of everything that decides whether the program
 * can be measured at all. Edit the filter, the window or the store list and the fingerprint moves,
 * the memory no longer applies, and the program is tried again on the next sweep with no one having
 * to remember to clear anything. That is the whole point of fingerprinting it rather than storing a
 * bare "skip me" flag.
 *
 * ScriptProperties rather than a column: this is scheduler bookkeeping, not a fact about the
 * program, and a `programs` column would travel to every consumer of a row and invite a second
 * meaning for "measured". One JSON blob, a dozen small entries, far inside the 9KB value limit.
 */
var SNAPSHOT_REFUSALS_PROP = 'SNAPSHOT_REFUSALS';

function snapshotFingerprint_(prog) {
  var m = prog.match_json || {};
  /* JSON, not join('|'). REAL DUTCHIE PRODUCT NAMES CONTAIN A PIPE — "Disposable AIO | 1g",
     "Live Resin Dank Tank | 2g" — so joining on one lets ["Carts","Dabs"] and ["Carts|Dabs"]
     produce the same fingerprint. The cost of that collision is a program silently still counted
     as unmeasurable after its filter was fixed, which is the exact failure this memory exists to
     avoid. Caught by tests/snapshot_queue_test.js on the first run. */
  return JSON.stringify([
    String(m.brand || ''), String(m.category || ''), String(m.filter_text || ''),
    (m.products || []).map(String),
    textDate_(prog.start_date), textDate_(prog.end_date),
    (prog.stores_json || []).map(function (x) {
      return slug_(x && x.store_id ? x.store_id : x);
    })
  ]);
}

function snapshotRefusals_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties()
      .getProperty(SNAPSHOT_REFUSALS_PROP) || '{}') || {};
  } catch (e) { return {}; }
}

function saveSnapshotRefusals_(map) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(SNAPSHOT_REFUSALS_PROP, JSON.stringify(map || {}));
  } catch (e) {
    console.warn('[spiff] could not persist snapshot refusals: ' + ((e && e.message) || e));
  }
}

/* What the sweep is carrying, for anything that wants to REPORT rather than measure. Cheap: reads
   the sheet, calls no Dutchie. This is the number whose absence let a stuck sweep run for a week —
   snapshotPending_ has always returned `failed` and `remaining` and nothing ever read either. */
function snapshotBacklog_() {
  var out = { eligible: 0, measured: 0, never_measured: 0, refused: 0, programs: [] };
  var refused = snapshotRefusals_();
  listPrograms_().forEach(function (prog) {
    if (!snapshotReasonFor_(prog)) return;
    out.eligible++;
    if (prog.progress_json && prog.progress_json.stores && prog.progress_json.stores.length) {
      out.measured++; return;
    }
    out.never_measured++;
    var r = snapshotRefusalFor_(prog, refused);
    var stuck = !!r;
    if (stuck) out.refused++;
    out.programs.push({ program_id: prog.program_id, refused: stuck,
                        reason: stuck ? (r.reason || 'refused') : 'not reached yet',
                        since: stuck ? r.at : '' });
  });
  return out;
}

function snapshotPending_(opts) {
  opts = opts || {};
  var max = Math.max(1, Math.min(20, Number(opts.max) || 1));
  var force = !!opts.force;
  var only = String(opts.program || '').trim();

  var sh = dataSheet_();
  if (sh.getLastRow() < 2) return { ok: true, done: [], remaining: 0, skipped: [] };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  var pCol = PROGRAM_HEADERS.indexOf('progress_json');

  /* ── TIME, NOT ATTEMPTS, IS THE REAL BUDGET ──────────────────────────────────────────────────
     A trigger gets six minutes and a program is ~54s, so the run has to stop on the clock however
     the attempts went. The old guard `done.length + failed.length >= max` made a FAILURE cost a
     success's worth of budget, which is how twelve unmeasurable programs held the head of the
     queue for a week: max is 1 in working hours, so the first refusal ended every run. Now `max`
     counts what was actually WRITTEN, and the clock stops the run. */
  var t0 = Date.now();
  var BUDGET_MS = 4 * 60 * 1000;

  var refused = snapshotRefusals_(), refusalsMoved = false;
  var done = [], failed = [], eligible = 0, stuck = 0, ranOut = false;
  for (var i = 0; i < vals.length; i++) {
    var prog = rowToProgram_(vals[i]);
    if (only && String(prog.program_id) !== only) continue;
    var why = snapshotReasonFor_(prog);
    if (!why) continue;
    if (prog.progress_json && !force) continue;

    /* Known unmeasurable, and nothing about it has changed since — skip without spending a
       Dutchie call on an answer we already have. `force` and an edited fingerprint both override,
       so correcting a filter re-arms it with nobody having to remember to clear anything. */
    var fp = snapshotFingerprint_(prog);
    var prior = refused[prog.program_id];
    if (prior && prior.fp === fp && !force) { stuck++; continue; }

    eligible++;
    if (done.length >= max || Date.now() - t0 > BUDGET_MS) { ranOut = true; continue; }

    var res = snapshotProgram_(prog);
    if (!res.ok) {
      failed.push({ program_id: prog.program_id, error: res.error, refused: res.refused || '' });
      /* Only a DETERMINISTIC refusal is remembered. A store that would not answer is a transient
         failure and must be retried next hour — writing it off here would turn one bad afternoon
         at Dutchie into a program that is never measured again. */
      if (res.refused) {
        /* SCRUBBED AT THE WRITE, not at whatever reads it back. snapshotProgram_ can fail with a
           UrlFetchApp exception carrying the whole URL, deploy secret included, and this parks that
           text in the refusals memory. Nothing reads it out to a person TODAY — which is exactly
           the reasoning that cost crew: it had this identical shape, "no reader", and a health
           check turned out to fold the stored error into a reason a weekly recap rendered into an
           email. The exit test cannot see a store, only an escape, so a store has to be scrubbed on
           the way in or it is waiting for its first reader. */
        refused[prog.program_id] = { fp: fp, at: nowStamp_(), reason: res.refused,
                                     error: scrubSecrets_(String(res.error || '')).slice(0, 200) };
        refusalsMoved = true;
      }
      continue;
    }
    if (prior) { delete refused[prog.program_id]; refusalsMoved = true; }
    /* Writes ONE cell. edited_by records the human who last corrected a record, and a measurement
       is not an edit by that person — the same rule the status roll follows. */
    sh.getRange(i + 2, pCol + 1).setValue(JSON.stringify(res.snapshot));
    done.push({ program_id: prog.program_id, reason: why, units: res.snapshot.units,
                earned: res.snapshot.earned, earners: res.snapshot.earners,
                partial: res.snapshot.partial });
  }
  /* ONCE, after the loop rather than per row: the sweep can write several programs in a run and
     the cache is one key, so busting it per write would just be the same work repeated. Same
     reason as writeSnapshot_ — without this the overnight backfill fills the sheet while every
     screen watching it keeps showing the empty grids it is there to fix. */
  if (done.length) invalidatePrograms_();
  if (refusalsMoved) saveSnapshotRefusals_(refused);
  return { ok: true, done: done, failed: failed,
           /* `remaining` is what a further run would still TRY. `refused_skipped` is what it never
              will until a human changes something — kept apart, because a backlog that shrinks to a
              floor and stops is the shape this whole bug hid behind. */
           remaining: Math.max(0, eligible - done.length - failed.length),
           refused_skipped: stuck, out_of_budget: ranOut };
}

/* ═════════════ RECORDING ACTUALS FROM THE CLOSE-OUT MEASUREMENT ═════════════
 * Sky, 2026-09-15: "we should automate the pull from dutchie after a program has closed, we shouldn't
 * rely on a human to remember that." The Mule Dank Tank program closed on Sep 13, was measured that
 * night (168 units, 20 budtenders, $500), and sat with NO recorded actuals — so History, the vendor
 * report and every total read zero until somebody opened it and pressed Pull live, then Save.
 *
 * The measurement IS the pull: snapshotProgram_ calls the same per-store sell-through route over
 * the program's own window that "Pull live from Dutchie" does. So once a closed program has been
 * measured, its actuals are written from that measurement, by the same arithmetic pullActuals uses.
 *
 * WHAT IT WILL NOT DO, and each one is a rule that has already cost money here:
 *  - OVERWRITE recorded actuals. A closed program's actuals may already be on a vendor report;
 *    changing them is a person's decision (Correct by hand).
 *  - Record from a PARTIAL measurement. A store that did not answer is not a store that sold
 *    nothing — the Buddies undercount came from exactly that.
 *  - Record ZERO units. On a program that ran, zero almost always means a filter that matches
 *    nothing; it is reported as needing a person instead.
 *  - Touch a DRAFT whose window passed. "Drafted and never run" vs "ran and finished" is a human's
 *    call (see the status roll).
 * edited_by is not changed — a measurement is not an edit by a person. The actuals carry
 * `source: 'measured'` and `recorded_at`, so it is always visible that no human typed them. */
function actualsFromSnapshot_(prog) {
  if (String(prog.status || '').trim().toLowerCase() !== 'closed') return { skip: 'not closed' };
  var a = prog.actual_json;
  if (a && (a.units_sold != null || a.bts_hit != null || a.roi != null)) return { skip: 'already recorded' };
  var s = prog.progress_json;
  if (!s || !s.stores || !s.stores.length) return { skip: 'not measured yet' };
  if ((s.partial || []).length) return { person: 'measurement is missing ' + s.partial.join(', ') + ' — re-measure it' };
  var units = Number(s.units) || 0;
  if (units <= 0) return { person: 'measured zero units — check the product filter' };

  var cost = Number((prog.cost_json || {}).per_unit) || 0;
  var base = Number((prog.baseline_json || {}).units) || 0;
  var rate = Number(s.rate) || payoutRateOf_(prog);
  var invest = Math.round((Number(s.earned) || 0) * 100) / 100;     // flat: rate × hit; per unit: rate × units
  var roi = Math.round(((units - base) * cost - invest) * 100) / 100;
  return { actual: {
    units_sold: units,
    revenue: Math.round(units * cost * 100) / 100,
    bts_hit: Number(s.earners) || 0,
    spiff_amount: rate,
    investment: invest,
    roi: roi,
    roi_pct: invest ? Math.round((roi / invest) * 10000) / 10000 : 0,
    source: 'measured',
    recorded_at: nowStamp_(),
    measured_at: String(s.at || '')
  } };
}

function recordMeasuredActuals_(opts) {
  opts = opts || {};
  var apply = !!opts.apply, only = String(opts.program || '').trim();
  var out = { ok: true, dry: !apply, recorded: [], needs_person: [] };
  var sh = dataSheet_();
  if (sh.getLastRow() < 2) return out;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  var aCol = PROGRAM_HEADERS.indexOf('actual_json');
  for (var i = 0; i < vals.length; i++) {
    var prog = rowToProgram_(vals[i]);
    if (only && String(prog.program_id) !== only) continue;
    var r = actualsFromSnapshot_(prog);
    if (r.person) { out.needs_person.push({ program_id: prog.program_id, why: r.person }); continue; }
    if (!r.actual) continue;
    // ONE cell, like the freeze: the rest of the row, and who last edited it, stay exactly as they were.
    if (apply) sh.getRange(i + 2, aCol + 1).setValue(JSON.stringify(r.actual));
    out.recorded.push({ program_id: prog.program_id, units_sold: r.actual.units_sold,
                        bts_hit: r.actual.bts_hit, investment: r.actual.investment, roi: r.actual.roi });
  }
  if (apply && out.recorded.length) invalidatePrograms_();
  return out;
}

function recordActualsWeb_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  return recordMeasuredActuals_({ apply: String(p.apply || '') === '1', program: p.program });
}

/* ═════════════════ DOES A CLOSED PROGRAM STILL ADD UP? ═════════════════════════════════════════
 * Sky, 2026-09-09: "nothing checks whether SPIFF's numbers still agree with each other. The hourly
 * trigger measures and publishes; it never asks whether what it published reconciles."
 *
 * The three things that sat for weeks and would each have been one line of this:
 *   · the vendor email, PDF and gift-card list computing a per-unit program's credit with the FLAT
 *     formula — $28.50 against $181.50 owed, on a document headed "Credit due Green Cross"
 *   · a flat program's report ticking 18 people as hitting a target of zero
 *   · programs whose measured units still disagree with what the vendor was told
 *
 * WHAT IT DOES. For each CLOSED program it recomputes the payout INDEPENDENTLY — the sum of what
 * each person earned, off the frozen snapshot — and compares it against the figure on the record.
 * It does the same for units. That is a second opinion from the measurement itself, which is the
 * only thing in this app that can disagree with `actual_json` in a useful way.
 *
 * IT REPORTS AND NEVER CORRECTS. These are settled records that went to a vendor; a job that
 * quietly rewrites one is worse than the drift it fixes. Sky's own standing rule on the copied-
 * actuals group is that the numbers are a business judgement and a human checks them.
 *
 * WHAT IT REFUSES TO JUDGE, which is most of History. Thirteen of the twenty-four closed programs
 * on 2026-09-15 cannot be compared at all: nine were never measured (they predate the snapshot),
 * and four measured zero because stores refused. Those are a closed decision — see the note on not
 * retrofitting the historical records — so they are COUNTED and named, never flagged. Comparing
 * against a measurement that does not exist would produce thirteen findings a day, forever, and a
 * daily report nobody can act on is how the one real finding gets missed.
 *
 * THE THRESHOLDS (Sky, 2026-09-15). Money: any gap over a cent, because a cent is not a rounding
 * story on a figure a vendor was invoiced. Units: over 2% AND at least 5 units, which catches
 * Grön's 13 and ignores Hellavated's 1. The two are independent, so a payout error cannot hide
 * under the unit threshold.
 */
var AUDIT_STATE_PROP = 'PAYOUT_AUDIT_STATE';     // { on: 'YYYY-MM-DD', fp: '<findings>' }
var AUDIT_UNIT_PCT = 0.02, AUDIT_UNIT_MIN = 5;

function auditClosedPayouts_() {
  var out = { ok: true, at: nowStamp_(), closed: 0, compared: 0,
              findings: [], not_comparable: [] };
  var progs;
  try { progs = listPrograms_('closed'); }
  catch (e) { return { ok: false, error: 'could not read the programs tab: ' + scrubSecrets_(e && e.message || e) }; }
  out.closed = progs.length;

  progs.forEach(function (p) {
    var snap = p.progress_json && p.progress_json.stores ? p.progress_json : null;
    var skip = function (why) { out.not_comparable.push({ program_id: p.program_id, why: why }); };
    if (!snap) return skip('never measured');
    if ((snap.partial || []).length) {
      /* A REFUSED STORE IS NOT A ZERO — the same rule the snapshot and the actuals recorder
         follow. A five-store total compared against a six-store record is a manufactured gap. */
      return skip('measurement incomplete — ' + snap.partial.join(', ') + ' did not answer');
    }
    var stores = snap.stores || [];
    var measuredUnits = 0, measuredEarned = 0, people = 0;
    stores.forEach(function (st) {
      measuredUnits += Number(st.units) || 0;
      (st.rows || []).forEach(function (r) {
        measuredEarned += Number(r.earned) || 0;
        if ((Number(r.earned) || 0) > 0) people++;
      });
    });
    measuredEarned = Math.round(measuredEarned * 100) / 100;
    if (!measuredUnits) return skip('measured zero units — its filter matches nothing');

    var a = p.actual_json || {};
    var recUnits = Number(a.units_sold) || 0, recPaid = Number(a.investment) || 0;
    if (!recUnits && !recPaid) return skip('no recorded actuals to compare against');

    out.compared++;
    var flags = [];
    var payGap = Math.round((measuredEarned - recPaid) * 100) / 100;
    if (Math.abs(payGap) > 0.01) {
      flags.push({ kind: 'payout', measured: measuredEarned, recorded: recPaid, gap: payGap });
    }
    var unitGap = measuredUnits - recUnits;
    if (Math.abs(unitGap) > Math.max(AUDIT_UNIT_MIN, AUDIT_UNIT_PCT * recUnits)) {
      flags.push({ kind: 'units', measured: measuredUnits, recorded: recUnits, gap: unitGap });
    }
    if (flags.length) {
      out.findings.push({ program_id: p.program_id,
                          program_name: p.program_name || p.title || p.program_id,
                          vendor: p.vendor || '', window: [p.start_date, p.end_date],
                          measured_at: String(snap.at || '').slice(0, 10),
                          earners: people, flags: flags });
    }
  });
  return out;
}

/* A stable identity for a set of findings, so "the same disagreement as yesterday" can be told
 * from "a new one". The GAPS are in it, rounded: correcting a record clears its finding, and
 * changing one re-raises it rather than passing as already-reported. */
function auditFingerprint_(findings) {
  return (findings || []).map(function (f) {
    return f.program_id + ':' + f.flags.map(function (x) {
      return x.kind + '=' + (Math.round(Number(x.gap) * 100) / 100);
    }).sort().join(',');
  }).sort().join('|');
}

/* The daily run. ONCE a day off the hourly trigger, and it writes a brain note only when the set
 * of disagreements has CHANGED (Sky, 2026-09-15). A note every day would put today's Grön line in
 * the inbox until it is dealt with, and a line you have already decided about teaches you to skim
 * the inbox — which is the failure mode that let a stuck sweep run for a week. A clean run logs.
 */
function runPayoutAuditDaily_(opts) {
  opts = opts || {};
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  var state = {};
  try { state = JSON.parse(props.getProperty(AUDIT_STATE_PROP) || '{}'); } catch (e) {}
  if (!opts.force && state.on === today) return { ok: true, skipped: 'already ran today' };

  var rep = auditClosedPayouts_();
  if (!rep.ok) return rep;
  var fp = auditFingerprint_(rep.findings);
  rep.noted = false;
  rep.unchanged = (fp === (state.fp || '')) && !!fp;

  if (fp && !rep.unchanged) {
    try {
      GXCore.gxAddNote('spiff', 'spiff', auditNoteTitle_(rep), auditNoteBody_(rep), '', 'ask');
      rep.noted = true;
    } catch (e) {
      /* A note that could not be written must not be recorded as written, or the change is
         swallowed and the next run calls it unchanged. Leave the fingerprint alone and say so. */
      rep.note_error = scrubSecrets_(e && e.message || e);
      console.warn('[spiff] payout audit could not write its note: ' + rep.note_error);
    }
  }
  /* The DATE always moves, so a failed note is retried tomorrow rather than every hour. The
     FINGERPRINT moves only when the note landed — and an empty one clears it, so a disagreement
     that comes back is reported again instead of being remembered as already told. */
  var save = { on: today, fp: rep.note_error ? (state.fp || '') : fp };
  try { props.setProperty(AUDIT_STATE_PROP, JSON.stringify(save)); } catch (e) {}

  if (!rep.findings.length) {
    console.log('[spiff] payout audit: ' + rep.compared + ' of ' + rep.closed
                + ' closed programs reconcile; ' + rep.not_comparable.length + ' not comparable.');
  } else {
    console.warn('[spiff] payout audit: ' + rep.findings.length + ' disagreement(s) — '
                 + rep.findings.map(function (f) { return f.program_id; }).join(', ')
                 + (rep.noted ? ' (noted)' : rep.unchanged ? ' (unchanged since the last note)' : ''));
  }
  return rep;
}

function auditNoteTitle_(rep) {
  var n = rep.findings.length;
  return n === 1
    ? 'A closed program does not add up: ' + rep.findings[0].program_name
    : n + ' closed programs do not add up';
}

/* The note is what a human reads, so it states the numbers and what to do with them — not a count
 * and a route to go and run. */
function auditNoteBody_(rep) {
  var lines = [];
  lines.push('The daily reconciliation recomputed every closed program\'s payout from its own frozen '
           + 'measurements and compared it against the record. These disagree:');
  lines.push('');
  rep.findings.forEach(function (f) {
    lines.push('• ' + f.program_name + (f.vendor && f.vendor !== f.program_name ? ' (' + f.vendor + ')' : '')
               + '  ' + (f.window[0] || '?') + ' → ' + (f.window[1] || '?'));
    f.flags.forEach(function (x) {
      if (x.kind === 'payout') {
        lines.push('    payout: the measurements add up to ' + moneyStr_(x.measured)
                 + ', the record says ' + moneyStr_(x.recorded)
                 + ' (' + (x.gap > 0 ? '+' : '') + moneyStr_(x.gap) + ')');
      } else {
        lines.push('    units: measured ' + x.measured + ', recorded ' + x.recorded
                 + ' (' + (x.gap > 0 ? '+' : '') + x.gap + ')');
      }
    });
    lines.push('    measured ' + (f.measured_at || 'unknown') + ' · ' + f.earners + ' people earned');
    lines.push('    id: ' + f.program_id);
  });
  lines.push('');
  lines.push('NOTHING WAS CHANGED. These records were reported to a vendor and paid, so the figures '
           + 'are yours to settle, not the job\'s. Fix the record and this clears itself.');
  lines.push('');
  lines.push(rep.compared + ' of ' + rep.closed + ' closed programs were comparable. '
           + rep.not_comparable.length + ' could not be judged (never measured, an incomplete '
           + 'measurement, or a filter that matches nothing) and are deliberately not flagged.');
  lines.push('Run it yourself any time: ?action=auditPayouts');
  return lines.join('\n');
}

function auditPayoutsWeb_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  /* Plain read by default. `run=1` is the daily pass with its once-a-day gate and its note;
     `force=1` runs that pass even if today's has already gone. */
  if (String(p.run || '') === '1') return runPayoutAuditDaily_({ force: String(p.force || '') === '1' });
  return auditClosedPayouts_();
}

/* ===================== SCHEDULED STATUS ROLL =====================
 * A program's status was a thing somebody had to remember to change. Nothing moved a draft to
 * active on its start date and nothing closed a program when its window ran out, so the landing
 * page showed a hero reading "day 14 of 14 - ended" on a program still filed as ACTIVE, and the
 * hourly sweep kept re-measuring it because the sweep is active-only.
 *
 * That status is not cosmetic. `?action=progress&status=active` is resolved from it, and GX Crew's
 * incentive column and the Leaderboard kiosk cards both read that route -- so a program left
 * active past its end date keeps drawing on kiosk cards, which is the exact failure the `status`
 * field was added to catch in the first place.
 *
 * Sky, 2026-08-31: a draft DOES go active on its scheduled start date -- no human step. Nothing
 * pays out automatically (a vendor report is still Tawny's click), so the risk of an early start
 * is a screen showing a program a day sooner, not money moving.
 *
 * THREE RULES, and the two omissions are the point:
 *   draft  + window has started  -> active
 *   active + window has ended    -> closed
 *   CLOSED IS TERMINAL. Never reopened by a date. A closed program has recorded actuals and may
 *     already be on a vendor report; a fat-fingered end_date must not un-send that.
 *   A DRAFT WHOSE WINDOW HAS ENTIRELY PASSED IS LEFT ALONE, and reported as `stale`. Closing it
 *     would file a program in History as though it ran, with no actuals, when the likelier truth
 *     is that it was drafted and never started. That is a judgment call for a human.
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
  var ptCol = PROGRAM_HEADERS.indexOf('payout_type');
  var pjCol = PROGRAM_HEADERS.indexOf('payout_json');

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  var day = today_(), now = nowStamp_();
  var changed = [], stale = [], skipped = [], noPayout = [];

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

    /* A draft with no payout set waits (Sky, 2026-11-01). A program can be created at $0 for the
       Calculator to fill in; left alone it would reach kiosk cards on its start date offering
       nothing. It goes active on the first hourly run after someone sets the payout. */
    if (want === 'active' && !(payoutRateOf_({ payout_type: rows[i][ptCol], payout_json: parseJson_(rows[i][pjCol], {}) }) > 0)) {
      noPayout.push({ program_id: id, window: sd + ' -> ' + ed });
      continue;
    }

    changed.push({ program_id: id, from: was, to: want, window: sd + ' -> ' + ed });
    if (dryRun) continue;
    sh.getRange(i + 2, stCol + 1).setValue(want);
    sh.getRange(i + 2, upCol + 1).setValue(now);
  }

  if (changed.length && !dryRun) invalidatePrograms_();
  return { ok: true, dry_run: dryRun, today: day, scanned: rows.length,
           changed: changed, stale: stale, skipped: skipped, no_payout: noPayout };
}

/** Installed once; hourly is well inside Dutchie's freshness and nowhere near the quota. */
/* LOCKED, and it says how many it removed (2026-09-15). The hourly job ran 13 times in four hours
   that day — the shape of several copies installed side by side, each one another six stores of
   sell-through against the account's 30-at-once ceiling. Delete-then-create is two steps, so two
   installs landing together can each delete nothing and each create one. The lock makes it one
   step; `removed` says whether there had been duplicates to clear. */
function installSpiffProgressTrigger() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'another install is running — try again in a minute' };
  try {
    var removed = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'refreshSpiffProgressTrigger') { ScriptApp.deleteTrigger(t); removed++; }
    });
    ScriptApp.newTrigger('refreshSpiffProgressTrigger').timeBased().everyHours(1).create();
    return { ok: true, installed: 'refreshSpiffProgress hourly', removed: removed };
  } finally {
    lock.releaseLock();
  }
}
/* Roll FIRST, then sweep. The sweep is active-only, so a program that starts today has to be
   flipped before the same run measures it -- otherwise its first hour of sales lands an hour late,
   and a program that ended yesterday gets measured one more time for nothing. */
/* ═══════════════ PUBLISHING TO CORE — SPIFF STOPS BEING A DEPENDENCY ═══════════════
 * Step 2 of 4 in GX_CONSOLIDATION_MAP.md, unblocked by the GXCore v306 re-pin.
 *
 * WHAT THIS REPLACES. Leaderboard's spiff.gs and Crew's spiffProgressFor_ both call THIS engine's
 * /exec for per-employee sell-through and payout. Both files say in their own comments that it is
 * app-to-app and temporary; Leaderboard's asks to be deleted when Core exposes the slice. The cost
 * was measured: SPIFF's uptime was the kiosk's uptime, and Crew paid ~4s per load of the incentive
 * screen re-fetching numbers that had not moved.
 *
 * SPIFF STILL OWNS THE ANSWER. It sets the targets, counts the units and decides the payout, and
 * the vendor is paid SPIFF's figure. Core stores the payload VERBATIM and recomputes nothing —
 * gxPublishPayload_ parses only to reject non-JSON and then writes the raw string. A second
 * computation would be a second answer to "what does this person earn".
 *
 * THE PAYLOAD IS THE SAME SHAPE ?action=progress ALREADY SERVES, deliberately. Steps 3 and 4 are
 * then "read Core instead of SPIFF, and check age_minutes" rather than "rewrite the parser". A
 * new shape here would spend both consumers' budget on plumbing and give them nothing.
 *
 * ── SCOPE IS DERIVED, NOT READ OFF THE ROW, and this is the part worth reading ──
 * Core keys a publication on (producer, scope) and documents scope as the pay-period START as
 * YYYY-MM-DD. The obvious source is each cached row's `pay_period` column. IT WAS NOT USABLE when
 * this was written, and
 * this was checked against live data on 2026-09-08 rather than assumed:
 *
 *     38 rows  pay_period "2026-08-17 - 2026-08-30"   <- a RANGE, not a date
 *     34 rows  pay_period "2026-09-18"               <- a date AFTER its own window (Aug 31–Sep 13)
 *
 * The column's own schema comment says TEXT 'YYYY-MM-DD' (pay-period start). Neither live value
 * honors it: it is free text on the program that nothing validates. This also explains a remark
 * already in spiffProgress_ — "the pay_period parameter was unusable when Crew built against it,
 * so Crew passes nothing and takes the whole payload." Now confirmed: unusable because the data
 * is inconsistent, not because the filter was wrong.
 *
 * FIXED 2026-09-08, one commit later: the column held the PAY DATE (window end + 5 days, across
 * all 23 seeded programs) in a field named and documented as the period start. It is now derived
 * from start_date on every write and the existing rows were backfilled, so it agrees with the
 * scope this function computes. The derivation below STAYS anyway: it is the same computation from
 * the same source, it does not depend on a backfill having been run, and a publish that derives
 * its own key cannot be broken by a bad value arriving in a column.
 *
 * So the scope is computed from the program's START DATE against the chain's pay-period grid,
 * which the record panel already enforces as whole pay periods. Building a MONEY contract on a
 * column that holds a range string in one row and a wrong date in the next is how the wrong
 * fortnight gets paid. `pay_period` is left alone rather than quietly rewritten — correcting
 * program records is a separate, visible job.
 *
 * ONE PUBLICATION PER PERIOD. That is the unit Crew's incentive screen works in (a SPIFF dollar
 * per employee per pay period) and the unit Core asks for. A consumer wanting "now" reads with no
 * scope and gets the newest; Crew naming a fortnight passes it — which is strictly better than
 * today, where it takes every row and filters client-side.
 *
 * STALENESS IS THE FAILURE MODE, and it is silent by construction: nothing throws when this stops
 * running, the payload just gets older. Core returns age_minutes on every read so a consumer can
 * refuse. That is the consumer's half; ours is to publish on every refresh, which is why this is
 * called from the hourly trigger rather than left to a human.
 */

/* The chain's pay-period grid, from Core's config — never a local constant. Leaderboard, Crew and
 * this app must agree on where a fortnight starts, and the anchor lives in exactly one place.
 * Cached for the run: the trigger publishes several periods in one pass. */
var PP_CFG = null;

function payPeriodCfg_() {
  if (PP_CFG) return PP_CFG;
  var anchor = '2026-05-11', days = 14;          // last-resort fallback; see below
  /* getKv, NOT a getConfig() that does not exist. The first cut of this called
     GXCore.getConfig() behind a `typeof` guard, which meant it would have fallen through to the
     built-in anchor forever while claiming in this very comment to read Core — the silent-no-op
     shape this app has already shipped once. getKv is the accessor Core documents for exactly
     this (it is what Leaderboard was told to read cfg.payPeriodAnchor from on a kiosk hot path),
     it caches for 60s, and all three writers invalidate it. */
  try {
    var a = String(GXCore.getKv('cfg.payPeriodAnchor') || '').slice(0, 10);
    var d = Number(GXCore.getKv('cfg.payPeriodDays'));
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) anchor = a;
    if (d > 0) days = d;
  } catch (e) {
    /* The built-in values are the ones live today, so a Core hiccup does not stop a publish. It
       WOULD be wrong if the chain ever moved its anchor while Core was unreachable — hence the
       log, rather than a silent default. */
    console.warn('[spiff] pay-period config unavailable, using the built-in anchor: '
                 + scrubSecrets_(e && e.message || e));
  }
  PP_CFG = { anchor: anchor, days: days };
  return PP_CFG;
}

/* Which pay period a date falls in, as that period's START. Day arithmetic in UTC and formatted
 * back, the same rule as everywhere else here: a local Date constructor shifts the day across a
 * DST boundary, and an anchor an hour before PT midnight formats as the day before. */
function periodStartFor_(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  var c = payPeriodCfg_();
  var a = String(c.anchor).split('-'), b = String(ymd).split('-');
  var diff = Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / 864e5);
  var idx = Math.floor(diff / c.days);           // floor, so dates BEFORE the anchor go backwards
  var d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2] + idx * c.days));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
       + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* Publish every pay period the cache currently covers. Returns what it did, per period, so the
 * trigger log and the manual route say the same thing. */
/* The manual entry point. DRY BY DEFAULT, like rollStatuses and sweepOrphanProgress: this writes
 * per-employee money into a tab two other apps are about to read, so "show me what you would send"
 * has to be the cheap default and publishing the deliberate one. */
function publishToCore_(p) {
  if (String(p.secret || '') !== PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP)) {
    return { ok: false, error: 'Unauthorized' };
  }
  if (String(p.apply || '') !== '1') {
    var preview = previewSpiffPublish_();
    preview.dry = true;
    preview.note = 'Nothing was published. Re-run with apply=1 to send these to Core.';
    return preview;
  }
  var res = publishSpiffToCore_({ notes: String(p.notes || 'manual publish') });
  res.dry = false;
  return res;
}

/* What publishSpiffToCore_ WOULD send, computed by the same grouping so the preview cannot
 * disagree with the write. */
function previewSpiffPublish_() {
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  var all = spiffProgress_({ secret: secret });
  if (!all || !all.ok) {
    return { ok: false, error: 'progress unavailable, nothing to publish: '
                             + ((all && all.error) || 'unknown') };
  }
  var byPeriod = Object.create(null), undated = [];
  (all.rows || []).forEach(function (r) {
    var scope = periodStartFor_(textDate_(r.start_date));
    if (!scope) { undated.push(r.program_id); return; }
    (byPeriod[scope] || (byPeriod[scope] = [])).push(r);
  });
  return {
    ok: true,
    would_publish: Object.keys(byPeriod).sort().map(function (scope) {
      var rows = byPeriod[scope];
      return { scope: scope, rows: rows.length,
               people: byEmployee_(rows).length,
               earned: rows.reduce(function (n, r) { return n + (Number(r.earned) || 0); }, 0),
               /* The window each row CLAIMS, so a scope that looks wrong can be traced back to the
                  program that produced it rather than to this function. */
               programs: dedupe_(rows.map(function (r) { return r.program_id; })) };
    }),
    /* Named, not silently dropped — a program with no usable window is a record to fix, and it is
       the one case where this cannot decide which fortnight the money belongs to. */
    undated_program_ids: dedupe_(undated),
    orphan_rows: all.orphan_rows || 0,
    orphan_program_ids: all.orphan_program_ids || []
  };
}

function publishSpiffToCore_(opts) {
  opts = opts || {};
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' };

  /* Read through the SAME function every consumer reads, unfiltered. Publishing a separately
     assembled payload would be a second code path to the same numbers, and the two would drift
     the first time one was edited. */
  var all = spiffProgress_({ secret: secret });
  /* A REFUSAL IS NOT AN EMPTY FORTNIGHT. spiffProgress_ returns ok:false when it could not read
     the programs tab, precisely so a failure cannot be mistaken for "nobody earned anything" —
     publishing that would freeze the mistake into Core for every consumer. */
  if (!all || !all.ok) {
    return { ok: false, error: 'progress unavailable, nothing published: '
                             + ((all && all.error) || 'unknown') };
  }

  /* Group by DERIVED period start — see the header. A row whose window gives no usable date is
     counted and named rather than filed under a guessed period. */
  var byPeriod = Object.create(null), undated = [];
  (all.rows || []).forEach(function (r) {
    var scope = periodStartFor_(textDate_(r.start_date));
    if (!scope) { undated.push(r.program_id); return; }
    (byPeriod[scope] || (byPeriod[scope] = [])).push(r);
  });

  var scopes = Object.keys(byPeriod).sort();
  if (!scopes.length) {
    return { ok: true, published: [], skipped: 'the cache holds no rows with a usable window',
             undated_program_ids: dedupe_(undated),
             heartbeat: publishNoProgramHeartbeat_(secret, opts.notes) };
  }

  /* ONE COMPUTATION FOR EVERY SCOPE. The per-store chip is a now-fact, not a slice of any period's
     rows, so it is identical on each payload — see lastProgramsByStore_ for why it rides here at all
     and why presence means "nothing running". Computed from the UNFILTERED read above. */
  var lastByStore = lastProgramsByStore_(all.rows || [], listProgramsCached_(),
                                         nowStamp_().slice(0, 10));

  var done = [], failed = [];
  scopes.forEach(function (scope) {
    var rows = byPeriod[scope];
    var payload = {
      /* Same keys ?action=progress returns, so a consumer can switch source without a rewrite.
         `pay_period` carries the DERIVED scope — the one field that is more trustworthy here than
         on the row it came from. */
      ok: true, pay_period: scope, status: null,
      rows: rows,
      by_employee: byEmployee_(rows),
      /* Scoped to THIS period's rows, so a consumer holding one publication is never told about a
         program it has no rows for. */
      programs: programsFor_(rows),
      refreshed_at: rows.reduce(function (n, r) {
        var t = String(r.refreshed_at || ''); return t > n ? t : n;
      }, ''),
      /* The floor, scoped to this period's rows the same way the ceiling above is. It has to be
         computed again here rather than copied off `all`, because `all` spans every period and a
         consumer holding ONE publication would otherwise be told about staleness in a fortnight it
         has no rows for. Present because the payload's promise is "the same keys ?action=progress
         returns" — a field on one and not the other breaks exactly that, and this is the path the
         kiosk board actually reads. */
      oldest_refreshed_at: rows.reduce(function (o, r) {
        /* Active only, for the same reason as the route: a closed program's rows are frozen on
           purpose and can only get older, so counting them makes the floor a clock that never
           stops running backwards. A period holding nothing active reports blank — nothing in it
           is expected to move. */
        if (String(r.status || '') !== 'active') return o;
        var t = String(r.refreshed_at || '');
        return t && (!o || t < o) ? t : o;
      }, ''),
      /* Carried through verbatim: they describe the whole cache, not this slice, and a consumer
         that wants to refuse a payload with orphans needs to see them. */
      orphan_rows: all.orphan_rows || 0,
      orphan_program_ids: all.orphan_program_ids || [],
      /* THE EMPTY-BOARD CHIP, one entry per store with nothing running — the same shape and the
         same presence rule as `storeView`'s `last_program`. Whole-cache like the orphan fields
         above, not scoped to this period, for the reason lastProgramsByStore_ sets out. */
      last_programs: lastByStore,
      /* WHO said so and WHEN, inside the payload as well as on Core's row. A consumer holding a
         payload out of context should not have to trust the envelope it arrived in. */
      published_by: 'spiff', published_at: nowStamp_()
    };
    try {
      var r = GXCore.publishSpiffProgress(secret, scope, payload, {
        by: 'spiff', notes: opts.notes || 'hourly refresh'
      });
      if (r && r.ok) done.push({ scope: scope, rows: rows.length, bytes: r.bytes });
      else failed.push({ scope: scope, error: (r && r.error) || 'unknown' });
    } catch (e) {
      /* publishSpiffProgress goes through the bound library to Core; scrub, for the same reason
         gxSalesByEmployee_ does. */
      failed.push({ scope: scope, error: scrubSecrets_(e && e.message || e) });
    }
  });

  return { ok: !failed.length, published: done, failed: failed,
           undated_program_ids: dedupe_(undated),
           heartbeat: publishNoProgramHeartbeat_(secret, opts.notes) };
}

/* ── THE "NO PROGRAM STARTS THIS PERIOD" HEARTBEAT ────────────────────────────────────────────────
 * Core's watchdog alerts when SPIFF's newest published pay period is not the current one. SPIFF only
 * publishes a period it has measured rows for, so in a fortnight where NO program starts, the newest
 * period is honestly the previous one, forever, and the watchdog would cry stale after its 48 h
 * rollover grace. Core cannot see the program list. This can, so it says so: a separate
 * `spiff-heartbeat` publication for the current period (GXCore.publishSpiffHeartbeat, library v359+).
 * It never touches the `spiff` rows the kiosk and Crew read.
 *
 * WHAT IT REFUSES TO SAY, because the other reading is "the check could not run":
 *   - an empty or unreadable program list is NOT "no programs" (a failed read looks exactly like it);
 *   - any program whose start date will not parse blocks it: this app cannot claim none start;
 *   - any program starting in the current period or later blocks it. Then the normal rows carry the
 *     period, and a SPIFF that has programs but failed to roll must still alert.
 * Pure on purpose: the caller reads the programs, this decides. */
function noProgramHeartbeatPayload_(programs, today) {
  if (!programs || !programs.length) {
    return { ok: false, reason: 'program list empty or unreadable: not claiming "no programs"' };
  }
  var cur = periodStartFor_(today);
  if (!cur) return { ok: false, reason: 'no current pay period' };
  var last = '';
  for (var i = 0; i < programs.length; i++) {
    var sp = periodStartFor_(textDate_(programs[i] && programs[i].start_date));
    if (!sp) return { ok: false, reason: 'program ' + (programs[i] && programs[i].program_id) +
                                         ' has no usable start date: cannot say none start' };
    if (sp >= cur) return { ok: false, reason: 'a program starts in ' + sp + ': normal rows carry it' };
    if (sp > last) last = sp;
  }
  return { ok: true, scope: cur, payload: {
    heartbeat: true, pay_period: cur, no_programs_starting: true,
    last_program_period: last, programs_read: programs.length, checked_at: nowStamp_() } };
}

function publishNoProgramHeartbeat_(secret, notes) {
  var programs;
  try { programs = listPrograms_(); }       // fresh, not the 5-minute cache: this is a claim about NOW
  catch (e) { return { ok: false, skipped: 'program list unreadable: ' + scrubSecrets_(e && e.message || e) }; }
  var hb = noProgramHeartbeatPayload_(programs, today_());
  if (!hb.ok) return { ok: true, sent: false, skipped: hb.reason };
  /* A GXCore pin from before the heartbeat existed has no such function. That must degrade to "not
     sent", not throw into the money path. */
  if (typeof GXCore.publishSpiffHeartbeat !== 'function') {
    return { ok: false, sent: false, skipped: 'pinned GXCore predates publishSpiffHeartbeat' };
  }
  try {
    var r = GXCore.publishSpiffHeartbeat(secret, hb.scope, hb.payload, { by: 'spiff', notes: notes || 'hourly refresh' });
    return r && r.ok ? { ok: true, sent: true, scope: hb.scope }
                     : { ok: false, sent: false, error: (r && r.error) || 'unknown' };
  } catch (e) {
    return { ok: false, sent: false, error: scrubSecrets_(e && e.message || e) };
  }
}

/* ── THE PROGRAM SIDECAR — what a row cannot say about the program it belongs to ─────────────────
 * Asked for by Leaderboard 2026-09-11, Sky's call: the kiosk popup stops framing SPIFF's store page
 * and gets drawn natively, so Leaderboard needs the four things only the `programs` tab holds —
 * the product in words, the store's goal, what it pays, and Tawny's tips. Without them it was
 * INFERRING the reward from what everyone had been paid so far, which is a guess about money.
 *
 * A SIDECAR, NOT REPEATED COLUMNS. Both were offered; this is one entry per program rather than
 * the same tips array copied onto every employee row, and the rows stay exactly the shape Crew and
 * the kiosks already parse — nothing existing has to change to ignore it.
 *
 * BUILT FROM THE PROGRAM RECORD, not from the cached rows, because that is the only place these
 * live — and read through the same helpers the operator screen and the kiosk page use
 * (productLabelOf_, normalizePitch_, payoutRateOf_, payoutModelOf_), so a program cannot be
 * described one way here and another way on screen.
 *
 * NO PER-PERSON MONEY IN HERE. `payout` is the program's rate, which is on the vendor's own
 * proposal; what an individual earned stays on the row where it already was. */
function programsFor_(rows) {
  var want = Object.create(null);
  (rows || []).forEach(function (r) { if (r && r.program_id) want[String(r.program_id)] = 1; });
  var ids = Object.keys(want);
  if (!ids.length) return [];

  var out = [];
  listProgramsCached_().forEach(function (pr) {
    if (!want[String(pr.program_id)]) return;
    var tgt = pr.target_json || {};
    out.push({
      program_id: pr.program_id,
      vendor: pr.vendor || '',
      program_name: pr.program_name || pr.title || '',
      status: String(pr.status || '').toLowerCase(),
      start_date: textDate_(pr.start_date), end_date: textDate_(pr.end_date),
      /* The words a kiosk can show — "All Mule Extracts products" for a brand-wide SPIFF. A filter
         is not readable on a wall screen. */
      product: productLabelOf_(pr),
      payout: payoutRateOf_(pr),
      payout_type: payoutModelOf_(pr),
      /* Maps keyed on store_id: a program runs at six stores with six different goals, and a
         consumer rendering one store must not have to guess which number is theirs. */
      store_goals: tgt.by_store || {},
      bt_goals: tgt.per_bt || {},
      tips: normalizePitch_(pr.pitch_json).tips
    });
  });
  return out;
}

/* One line per person for a slice of rows. Same rule as spiffProgress_: keyed on employee_id where
 * the connector gave us one, on name only as a fallback — two people can share a first name but
 * not an id, and Crew joins on id everywhere else. */
function byEmployee_(rows) {
  var by = Object.create(null);
  rows.forEach(function (r) {
    var key = String(r.employee_id || ('name:' + r.name));
    var e = by[key] || (by[key] = { employee_id: r.employee_id || '', name: r.name,
                                    display_name: r.display_name || '',
                                    earned: 0, programs: [] });
    e.earned += Number(r.earned) || 0;
    e.programs.push({ program_id: r.program_id, vendor: r.vendor, name: r.program_name,
                      status: r.status, units: r.units, target: r.target,
                      hit: r.hit, earned: r.earned });
  });
  return Object.keys(by).map(function (k) { return by[k]; });
}

function dedupe_(a) {
  var seen = Object.create(null), out = [];
  (a || []).forEach(function (x) { var k = String(x); if (!seen[k]) { seen[k] = 1; out.push(x); } });
  return out;
}

/* ONE RUN AT A TIME (2026-09-15). A run takes up to ~4 minutes, and nothing stopped a second copy
   of the trigger — or a slow run overlapping the next hour — from sweeping the same stores at the
   same time: double the Dutchie reads, double the GX Core executions, and two writers deleting and
   re-adding the same progress rows. A run that finds one already going simply stops; the one in
   flight is doing the same work.

   A LEASE IN A PROPERTY, NOT A SCRIPT LOCK HELD FOR THE RUN. The script lock is one lock for the
   whole project, so holding it for four minutes would block anything else that ever takes it (the
   bug-mail dedupe does today). And a lease has an expiry, so a run that dies without releasing
   cannot wedge the job for good: after SWEEP_LEASE_MS the next hour takes over.

   THE LEASE MUST OUTLIVE THE LONGEST RUN THAT IS STILL WORKING, and for a week it did not
   (corrected 2026-09-16). It was 7 minutes, chosen against "a run takes up to ~4 minutes". Two runs
   then took 636.6s (Sep 14) and 526.4s (Sep 16) — both finished normally, both outlived the lease,
   and for those minutes the one-run-at-a-time guarantee was simply not held. Nothing collided,
   because the runs are an hour apart and releaseSweepLease_ only ever clears its own; the guarantee
   lapsed quietly rather than failing loudly, which is the kind of wrong you only find by looking.

   The reasoning had a hole worth naming: it assumed the worst case was bounded by "a run killed at
   Google's six-minute limit". THAT LIMIT DOES NOT APPLY HERE — this account gets thirty minutes for
   a trigger, which is exactly why a 636-second run completed instead of being cut off. Nothing was
   going to stop a slow sweep on its own, so the sweep now stops itself (SWEEP_WORK_MS, read by
   refreshSpiffProgressTrigger) and the lease is set from that bound rather than from a guess:

     SWEEP_WORK_MS   the sweep starts no NEW store read past this point into the run.
     + one in-flight read   a single Core call is itself capped (GXCORE_FETCH_BUDGET_MS, 3 attempts)
     + the publish          one more Core call at the end of the run
     = SWEEP_LEASE_MS, with headroom, and comfortably under the hour between runs so a hung run is
       still taken over by the next one.

   Derived, not typed twice: widening the work bound without widening the lease would put the
   lapse straight back. Pinned by tests/shared_account_load_test.js. */
var SWEEP_LEASE_PROP = 'SWEEP_RUNNING_UNTIL';
var SWEEP_WORK_MS = 6 * 60 * 1000;
var SWEEP_LEASE_MS = SWEEP_WORK_MS + 6 * 60 * 1000;

function takeSweepLease_() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  /* The lease check-and-set is itself two steps, so it takes the script lock for the instant it
     needs — milliseconds, never the minutes of the sweep. */
  if (!lock.tryLock(10000)) { console.warn('[spiff] sweep skipped: could not take the lease lock'); return ''; }
  try {
    var held = String(props.getProperty(SWEEP_LEASE_PROP) || '');
    var until = Number(held.split('|')[0] || 0);
    if (until > Date.now()) {
      console.warn('[spiff] sweep skipped: another run holds the lease until '
                   + new Date(until).toISOString() + ' — likely a duplicate trigger; see ?action=diag');
      return '';
    }
    var mine = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
    props.setProperty(SWEEP_LEASE_PROP, (Date.now() + SWEEP_LEASE_MS) + '|' + mine);
    return mine;
  } finally {
    lock.releaseLock();
  }
}

/* Release only OUR lease. If this run overran and a later one took over, deleting here would open
   the door to a third. */
function releaseSweepLease_(mine) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty(SWEEP_LEASE_PROP) || '').split('|')[1] === mine) props.deleteProperty(SWEEP_LEASE_PROP);
  } catch (e) {}
}

function refreshSpiffProgressTrigger() {
  /* Taken BEFORE the lease, so the sweep's deadline is measured from the start of the whole run —
     the freeze and the audit ahead of it spend from the same budget. */
  var runStart = Date.now();
  var lease = takeSweepLease_();
  if (!lease) return;
  try {
    try { rollProgramStatuses_(); }
    catch (e) { console.warn('[spiff] status roll failed: ' + ((e && e.message) || e)); }
    // Keep the brand list warm so Settings and the program screen never wait on Core's slow read.
    try { warmBrandsCache_(); }
    catch (e) { console.warn('[spiff] brand cache warm failed: ' + ((e && e.message) || e)); }
    /* Freeze finished programs, deliberately BEFORE the sweep — a program that just closed in the
       roll above is measured while this hour's numbers are still the last word on it.
       HOW MANY depends on whether anyone is likely to be looking. Apps Script runs one thing at a
       time per project, so every second spent measuring is a second the app cannot answer a page
       load: a 20-minute backfill made SPIFF unusable this afternoon and had to be killed twice.
       Overnight nobody is competing, so it drains the backlog four at a time (~216s, comfortably
       inside the trigger's six minutes) and a 23-program backlog is gone by morning. In working
       hours it takes ONE, ~54s an hour, which nobody notices. */
    try {
      var snap = snapshotPending_({ max: quietHours_() ? 4 : 1 });
      if (snap.done.length) {
        console.log('[spiff] froze ' + snap.done.length + ' program(s), '
                    + snap.remaining + ' still to freeze'
                    + (quietHours_() ? ' (quiet hours)' : ''));
      }
      /* SAY IT EVEN WHEN NOTHING WAS DONE. The old line logged only successes, so a sweep that
         wrote nothing for a week logged nothing for a week — the silence read exactly like "no work
         to do". A refusal that will not clear on its own is the one thing here a human must act on. */
      if (snap.refused_skipped) {
        console.warn('[spiff] ' + snap.refused_skipped + ' program(s) SKIPPED as unmeasurable — '
                   + 'their filter matches nothing and will not fix itself. See ?action=diag.');
      }
      if (!snap.done.length && !snap.failed.length && snap.remaining) {
        console.warn('[spiff] froze nothing this run with ' + snap.remaining + ' still eligible.');
      }
    } catch (e) { console.warn('[spiff] snapshot failed: ' + ((e && e.message) || e)); }
    /* Straight after the freeze, so a program measured this hour is recorded this hour. No Dutchie
       calls — it reads the measurement already on the row. */
    try {
      var rec = recordMeasuredActuals_({ apply: true });
      if (rec.recorded.length) {
        console.log('[spiff] recorded actuals for ' + rec.recorded.map(function (x) { return x.program_id; }).join(', '));
      }
      if (rec.needs_person.length) {
        console.warn('[spiff] closed but NOT auto-recorded (needs a person): '
                     + rec.needs_person.map(function (x) { return x.program_id + ' — ' + x.why; }).join('; '));
      }
    } catch (e) { console.warn('[spiff] recording actuals failed: ' + ((e && e.message) || e)); }
    /* Gift-card order email to Mike: by noon the first Monday after close, once per program. Its own
       try/catch so a mail failure cannot cost the refresh and the publish below. */
    try {
      var gm = sendGiftCardEmails_({ apply: true });
      if (gm.sent.length) console.log('[spiff] gift-card email sent for ' + gm.sent.map(function (x) { return x.program_id; }).join(', '));
      if (gm.failed.length) console.warn('[spiff] gift-card email FAILED: ' + gm.failed.map(function (x) { return x.program_id + ' — ' + x.error; }).join('; '));
    } catch (e) { console.warn('[spiff] gift-card email failed: ' + ((e && e.message) || e)); }
    /* ONCE A DAY, and AFTER the recorder: a program measured and recorded this hour should be
       reconciled against the figure that was just written, not against the blank it had an hour
       ago. Reads the rows already on the sheet — no Dutchie calls, no Core calls unless it has
       something to say. Its own try/catch, because a reconciliation that throws must not cost the
       refresh and the publish below it. */
    try { runPayoutAuditDaily_(); }
    catch (e) { console.warn('[spiff] payout audit failed: ' + ((e && e.message) || e)); }
    /* SAY IT WHEN THE CLOCK BIT. A truncated sweep is invisible from the outside — the rows it
       skipped still hold last hour's figures, which is the whole point of stopping this way, and
       the publish below still succeeds. So the only trace it leaves is this line, and without it a
       sweep that had been running out of time for weeks would read exactly like a healthy one. */
    var swept = refreshSpiffProgress_('', '', { deadline: runStart + SWEEP_WORK_MS });
    if (swept && swept.out_of_budget) {
      console.warn('[spiff] sweep ran out of time after '
                   + Math.round((Date.now() - runStart) / 1000) + 's — '
                   + swept.skipped.length + ' store read(s) not made, keeping the previous hour: '
                   + swept.skipped.map(function (x) { return x.program_id + '/' + x.store; }).join(', '));
    }
    /* SAY WHICH STORES DID NOT ANSWER (2026-09-16, Sky). refreshSpiffProgress_ has always collected
       `failures` — a store whose read threw or came back not-ok — and the hourly job has always
       thrown the list away. So a store failing EVERY hour left no trace anywhere: its rows quietly
       keep last week's numbers, the sweep reports success because the other stores wrote, and the
       payload's `refreshed_at` reads as the newest row. Three independent layers, each individually
       correct, adding up to a store that stops updating and never says so.

       Distinct from the budget skip above, and worth keeping distinct: a skip means SPIFF chose not
       to ask, and clears on its own the next quiet hour. A failure means SPIFF asked and Dutchie or
       Core would not answer, and repeats until someone looks. The error text is included because
       "which store" without "what went wrong" just moves the hunt somewhere else. */
    if (swept && swept.failures && swept.failures.length) {
      console.warn('[spiff] ' + swept.failures.length + ' store read(s) FAILED — those stores keep '
                   + 'their previous rows and will read stale until this clears: '
                   + swept.failures.map(function (f) {
                       return f.program_id + '/' + f.store + ' (' + (f.error || 'failed') + ')';
                     }).join('; '));
    }
    /* PUBLISH LAST, after the cache has this hour's numbers in it. Wrapped so a Core outage costs
       the publish and not the refresh: the cache is this app's own source of truth and must land
       even when the hand-off cannot. A consumer sees the age go up, which is exactly what
       age_minutes is for. */
    try {
      var pub = publishSpiffToCore_({ notes: 'hourly refresh' });
      if (pub.ok) {
        console.log('[spiff] published ' + pub.published.length + ' pay period(s) to Core: '
                    + pub.published.map(function (x) { return x.scope + ' (' + x.rows + ' rows)'; }).join(', '));
      } else {
        console.warn('[spiff] publish to Core failed: '
                     + (pub.error || JSON.stringify(pub.failed || [])));
      }
    } catch (e) { console.warn('[spiff] publish to Core threw: ' + ((e && e.message) || e)); }
    /* THE CALENDAR IS LAST and its own try/catch: it writes only to Google Calendar, and nothing
       above may wait on it or fail because of it. */
    try { runCalendarSyncHourly_(); }
    catch (e) { console.warn('[spiff] calendar sync FAILED: ' + ((e && e.message) || e)); }
    /* THE DEALS PAGE AFTER IT, same terms: it writes only to the public website, through GX Core,
       and nothing that pays may wait on it or fail because of it. */
    try { runWixPublishHourly_(); }
    catch (e) { console.warn('[spiff] deals page publish FAILED: ' + ((e && e.message) || e)); }
  } finally {
    releaseSweepLease_(lease);
  }
}

/* Is anybody likely to be using the app? Los Angeles, not UTC and not the script's idea of local
   time — the stores are in Oregon and the answer has to mean 10pm THERE. Same rule as every other
   date in this app: a calendar hour is Los Angeles.
   The window is deliberately generous at the late end and stops before opening: Tawny is in the
   app in the morning, and a store that opens at 9 has managers in before it. */
function quietHours_() {
  var h = Number(Utilities.formatDate(new Date(), 'America/Los_Angeles', 'H'));
  return h >= 22 || h < 6;
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

/* THE NAME A BUDTENDER IS ACTUALLY CALLED, resolved from the GX Core roster.

   Dutchie only knows the legal name it was onboarded with, so sell-through comes back as "Andrew
   Phillips", "Christopher Carney", "Jennifer Alexander". Nineteen people on this roster go by
   something else -- Drew, Chris, Jayce, Rose, Sunshine -- and Progress is a screen those people
   read about themselves. GX Core already computes display_name (preferred name + surname), so
   this is a lookup, not a new source of truth.

   RESOLVED AT READ TIME, never stored on the cached row -- the same rule `status` follows two
   functions up, for the same reason. The cache is a snapshot; a name corrected in Command Center
   today would otherwise stay wrong on every row until that program happened to be re-measured,
   and a closed program is never re-measured at all.

   JOIN ON THE DUTCHIE ID FIRST, name second. 52 of 76 roster rows carry a dutchie_employee_id and
   that is the only key that survives a legal-name change; the normalized-name fallback exists for
   the rest, and catches the one preferred-name person the connector has no id for. Names are
   normalized through userKey_ because the two systems disagree on punctuation and case.

   Object.create(null): the keys are names from Dutchie, i.e. data we do not control, and a
   budtender named "constructor" would otherwise find an inherited member truthy. Same class of bug
   aggregateSellers_ documents.

   FAILURE IS SILENT AND SAFE. A roster we cannot read returns an empty map, every row keeps the
   name Dutchie gave it, and nothing else on the screen changes. A friendlier label is not worth
   failing a payout read over. */
/* ── THE NAME SOMEBODY IS ACTUALLY CALLED ─────────────────────────────────────────────────────
   Dutchie reports the legal name ("Andrew Phillips"); staff are called something else ("Drew").
   19 of the 76 roster people go by a different name, so any surface rendering full_name is
   showing staff their legal name unknowingly.

   THE ANSWER COMES FROM CORE, DERIVED THERE, NOT COMPUTED HERE. gxDisplayName_ exists precisely
   because a name living in two places drifted — Crew corrected a record while another row kept
   the old spelling, and apps read the source of truth and still showed the wrong name. A second
   copy of that rule here would agree with Core by luck rather than by construction.

   Corrected 2026-09-08, and this is the whole history worth keeping. This function used to be a
   deploy-secret HTTP fetch of Core's ?action=employees route, carrying a comment that said the
   BOUND LIBRARY returns undecorated rows and a "REMOVE THIS once getEmployees() decorates"
   marker. Both were false by the time they were written: getEmployees() has mapped through
   gxDisplayName_ and gxShortName_ since commit fad5bac on 2026-08-19, shipped as library @133,
   and this engine pins v305. The marker was waiting for something that had already happened, and
   core-admin said so on 2026-09-07 after checking it against live data (76 employees, 19 with a
   preferred_name, all 19 correctly derived).

   So the workaround is gone and the library call is the whole implementation. What went with it:
   a script-property secret used for a read that needed no secret, a second Apps Script hop with
   its own ~6% bounce rate, an HTML-bounce guard, and error scrubbing that existed only because
   UrlFetchApp puts the whole URL — secret included — into its exception message.

   THE CACHE STAYS, and it is the one thing that was load-bearing rather than compensatory. This
   sits under ?action=progress, which GX Crew's incentive column and the Leaderboard kiosks poll;
   names change about never, so 15 minutes of them costs nothing and saves a spreadsheet read on
   every one of those calls.

   WHAT WAS REAL IN THE OLD COMMENT, and worth carrying forward: v1.360 shipped friendly names as
   a silent no-op with a full green test suite, because the tests MOCK getEmployees — a mock
   returns whatever you tell it to, so it can never catch the real projection being wrong. It was
   found by probing the live engine after deploying. No test in this repo would have caught it;
   the habit did. Do that.

   A failure here returns [] and every row keeps the name Dutchie reported. Failing to a worse
   LABEL is fine; failing the read is not. */
function gxRosterFull_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gx_roster_names');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  try {
    var rows = GXCore.getEmployees() || [];
    if (rows.length) cache.put('gx_roster_names', JSON.stringify(rows), 900);
    return rows;
  } catch (e) {
    Logger.log('[spiff] roster names unavailable: ' + (e && e.message || e));
    return [];
  }
}

function displayNameMap_() {
  /* NO SECOND SOURCE ANY MORE. There used to be a fallback here from the HTTP fetch to the
     library, written when the library was believed not to decorate — so the fallback was
     documented as degrading to no friendly names at all. The library IS the primary now, and a
     fallback to the route it already reads would be the same answer fetched a slower way.
     gxRosterFull_ returns [] on failure and every row keeps the name Dutchie reported. */
  var rows;
  try { rows = gxRosterFull_() || []; } catch (e) { return Object.create(null); }
  var byId = Object.create(null), byName = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var friendly = String(r.display_name || '').trim();
    /* Only when it actually DIFFERS from the legal name. Mapping a name onto itself is noise, and
       it would make the response claim a substitution happened where none did. */
    if (!friendly || userKey_(friendly) === userKey_(r.full_name)) continue;
    var id = String(r.dutchie_employee_id || '').trim();
    if (id) byId[id] = friendly;
    var nk = userKey_(r.full_name);
    if (nk && !byName[nk]) byName[nk] = friendly;
  }
  return { byId: byId, byName: byName };
}

/* Returns the friendly name, or '' when there is nothing better than what Dutchie gave us. The
   caller decides what to do with '' -- these rows keep `name` either way, so a consumer that has
   never heard of display_name is unaffected. */
function friendlyName_(map, employeeId, dutchieName) {
  if (!map || !map.byId) return '';
  var id = String(employeeId || '').trim();
  if (id && map.byId[id]) return map.byId[id];
  var nk = userKey_(dutchieName);
  return (nk && map.byName[nk]) || '';
}

/* ── SWEEPING ORPHANED CACHE ROWS ────────────────────────────────────────────────────────────────
 * The delete route drops a program's rows as it goes, so nothing new strands. This is for the
 * debris that predates it: rows whose program was removed, or re-keyed, before anything cleaned up
 * after itself. On 2026-09-06 that was 26 rows — 25 under `begoat-0826`, the pre-seed key the
 * SPIF-doc seed replaced with `begoat-2026-07-20-2026-08-03`, plus one row with no program_id at
 * all.
 *
 * They are already kept out of `rows` and `by_employee`, so this is not a correctness fix — it is
 * removing a trap. Every consumer has to keep remembering to exclude them, and the day one forgets
 * is the day fourteen people show as owed $25 again.
 *
 * ORPHANED MEANS THE PROGRAM ROW IS GONE — nothing subtler. spiffProgress_ decides what to serve on
 * a resolved STATUS being empty, which catches a genuine orphan and also a program that exists with
 * a blank status cell. Dropping a row from a response on that basis is recoverable by fixing the
 * cell; DELETING it is not. So this asks the stricter question, and the two are allowed to disagree
 * precisely because one of them is irreversible. (No live program has a blank status today. That is
 * a reason this has never bitten, not a reason to lean on it.)
 *
 * The empty-programs guard is the same one spiffProgress_ carries, for the same reason and with
 * more at stake: a momentary failure to read `programs` makes every cached row look orphaned, and
 * here that would delete the lot. A source that could not be read is not a list of orphans.
 *
 * DRY BY DEFAULT. It reports the plan and writes nothing unless `apply=1`, and what it removes is
 * copied to `swept_progress_rows` first. These rows carry `earned` dollars for programs that were
 * really paid — they are not authoritative about money any more, since the payout they were
 * computed from no longer exists in the system of record, but that is a reason not to SERVE them,
 * not a reason to make them unrecoverable.
 */
var SWEPT_TAB = 'swept_progress_rows';

function sweepOrphanProgress_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want) return { ok: false, error: 'GX_DEPLOY_SECRET is not set on this script' };
  if (String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };

  /* Uncached, like getProgram_: a delete reads the truth, not a five-minute-old copy of it. */
  var known = listPrograms_();
  if (!known.length) {
    return { ok: false, error: 'could not read the programs tab, so nothing can be called an '
               + 'orphan. This is a failure to read, NOT a cache where every row is stranded.' };
  }
  var live = Object.create(null);
  known.forEach(function (pr) { live[String(pr.program_id)] = 1; });

  var sh = progressSheet_();
  if (sh.getLastRow() < 2) return { ok: true, swept: 0, rows: 0, note: 'the progress cache is empty' };

  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRESS_HEADERS.length).getValues();
  var idCol = PROGRESS_HEADERS.indexOf('program_id');
  var earnCol = PROGRESS_HEADERS.indexOf('earned');

  var plan = Object.create(null), doomed = [];
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][idCol] || '');
    if (live[id]) continue;
    doomed.push(i);                                   // index into vals; sheet row is i + 2
    var k = id || '(no program_id)';
    if (!plan[k]) plan[k] = { program_id: id, rows: 0, earned: 0 };
    plan[k].rows++;
    plan[k].earned += Number(vals[i][earnCol]) || 0;
  }
  var summary = Object.keys(plan).map(function (k) { return plan[k]; });

  if (!doomed.length) return { ok: true, swept: 0, rows: 0, note: 'no orphaned rows' };
  if (String(p.apply || '') !== '1') {
    return { ok: true, dry: true, would_sweep: doomed.length, programs: summary,
             note: 'nothing was written — re-run with apply=1' };
  }

  /* Copy first. A failure between the two leaves the rows in both places, which is noise; the
     other order loses them. */
  var ss = sh.getParent(), keep = ss.getSheetByName(SWEPT_TAB);
  if (!keep) {
    keep = ss.insertSheet(SWEPT_TAB);
    keep.getRange(1, 1, 1, PROGRESS_HEADERS.length + 1)
        .setValues([PROGRESS_HEADERS.concat(['swept_at'])]).setFontWeight('bold');
    keep.setFrozenRows(1);
  }
  var stamp = nowStamp_();
  var copies = doomed.map(function (i) { return vals[i].slice(0, PROGRESS_HEADERS.length).concat([stamp]); });
  keep.getRange(keep.getLastRow() + 1, 1, copies.length, PROGRESS_HEADERS.length + 1).setValues(copies);

  // Bottom-up: deleting a row shifts every row after it.
  for (var j = doomed.length - 1; j >= 0; j--) sh.deleteRow(doomed[j] + 2);

  return { ok: true, swept: doomed.length, programs: summary, kept_in: SWEPT_TAB, swept_at: stamp };
}

function spiffProgress_(p) {
  /* guard_ has already authorized this call — either a valid session token or the deploy
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
  var known = listProgramsCached_();
  known.forEach(function (pr) {
    statusOf[String(pr.program_id)] = String(pr.status || '').toLowerCase();
  });
  /* An EMPTY programs list would make every cached row look orphaned, and the orphan rule below
     drops what it cannot vouch for — so a momentary failure to read `programs` would return
     "nobody earned anything" to Crew and the kiosks. Refuse instead. A source that could not be
     read is not a measurement of zero. */
  if (!known.length) {
    return { ok: false, error: 'could not read the programs tab, so no cached row can be vouched '
               + 'for. This is a failure to read, NOT a fortnight where nobody earned anything.',
             rows: [], by_employee: [] };
  }
  var wantStatus = String(p.status || '').trim().toLowerCase();

  /* One roster read for the whole response, not one per row. See displayNameMap_. */
  var nameMap = displayNameMap_();

  /* `oldest` beside `newest` (2026-09-16). `refreshed_at` is a MAXIMUM across the rows, so it
     answers "when was any of this last touched" while reading like "how fresh is this". One store
     that did not refresh hides behind five that did: the summary says just now, and the stale
     store's own row carries the truth that nobody looks at. That was survivable while a store only
     went unrefreshed by accident, but the sweep now skips stores DELIBERATELY when it runs out of
     clock (SWEEP_WORK_MS), so the quiet case is the expected one. Additive on purpose — nothing
     reads `oldest_refreshed_at` yet, no consumer has to change, and the honest floor is finally
     available to the ones that want it. Pinned by tests/progress_cache_test.js. */
  var rows = [], newest = '', oldest = '', orphans = Object.create(null), orphanRows = 0;
  vals.forEach(function (v) {
    var o = {};
    PROGRESS_HEADERS.forEach(function (h, i) { o[h] = v[i]; });
    if (wantPP && !payPeriodMatches_(o, wantPP)) return;
    if (wantId && String(o.program_id) !== wantId) return;
    /* '' means the program row is gone from `programs` — an orphaned cache row. Named by id in
       the response, never counted in it: "no rows" and "the programs tab lost a row" need
       completely different fixes, and a filter is where that difference disappears.
       WHY THEY ARE NOT SERVED (2026-08-31). They used to be, and 25 rows of BeGOAT — a program
       that closed on 2026-08-02, was reported to the vendor and paid — sat in the cache under
       `begoat-0826` after the SPIF-doc seed re-keyed it to begoat-2026-07-20-2026-08-03. They
       carried $350 of `earned` between them, and `by_employee` summed it, so any consumer reading
       this route without a filter saw fourteen people owed $25 for a fortnight already settled.
       GX Crew reads it exactly that way: the pay_period parameter was unusable when Crew built
       against it, so Crew passes nothing and takes the whole payload.
       An orphan's `earned` was computed from a payout that no longer exists in the system of
       record; it cannot be authoritative about money. So it is counted in `orphan_rows`, its id
       is named in `orphan_program_ids`, and it stays out of both `rows` and `by_employee`. */
    o.status = statusOf[String(o.program_id)] || '';
    if (!o.status) { orphans[String(o.program_id)] = 1; orphanRows++; return; }
    if (wantStatus && o.status !== wantStatus) return;
    o.units = Number(o.units) || 0; o.target = Number(o.target) || 0;
    o.earned = Number(o.earned) || 0; o.hit = !!o.hit;
    /* The sheet round-trips these cells as DATE OBJECTS, so they reached consumers as
       "Fri Aug 28 2026 06:20:52 GMT-0700" instead of the stamp that was written. Normalized on the
       way out — every reader wants a sortable string, and none of them should have to guess which
       of the two shapes they got. forceProgressTextDates_ now stops it at the source; this stays as
       the brace, because rows written before that fix are still Dates at rest. */
    o.refreshed_at = stampOf_(o.refreshed_at);
    o.start_date   = textDate_(o.start_date);
    o.end_date     = textDate_(o.end_date);
    /* ADDED, never substituted. `name` stays exactly what Dutchie reported, because GX Crew and
       the Leaderboard kiosks already read this payload and at least one of them may be joining on
       it; display_name is a new field a consumer opts into. It is only present when it differs
       from the legal name, so `display_name || name` is the whole rendering rule. */
    var friendly = friendlyName_(nameMap, o.employee_id, o.name);
    if (friendly) o.display_name = friendly;
    rows.push(o);
    if (o.refreshed_at > newest) newest = o.refreshed_at;
    /* ACTIVE ROWS ONLY, and this is the whole difference between a useful field and a permanent
       false alarm. The hourly sweep is active-only by design: a closed program's rows are frozen
       the day it closed and are never touched again, correctly. Measured on the live route the
       moment this shipped — a floor taken over ALL rows read 2026-09-02, two weeks back, and would
       have read further back every day forever, because the closed Portland Heights rows can only
       age. A consumer asking "is any of this stale" would have been told yes for the rest of time,
       which is worse than not asking: an alarm that is always on is an alarm nobody reads.
       So the floor answers the question worth asking — how stale is the stalest row that is
       SUPPOSED to be fresh. No active rows means nothing is expected to move, and it stays blank.

       Guarded on truthiness, unlike `newest`: a blank stamp sorts below every real one, so an
       unguarded minimum would latch on '' and call the payload infinitely stale — the same lie in
       the other direction. */
    if (o.status === 'active' && o.refreshed_at && (!oldest || o.refreshed_at < oldest)) {
      oldest = o.refreshed_at;
    }
  });

  /* One line per person, summed across programs — what Crew puts in the SPIFF column. Keyed on
     employee_id where the connector gave us one, and on name only as a fallback: two people can
     share a first name but not an id, and Crew joins on id everywhere else. */
  var by = Object.create(null);
  rows.forEach(function (r) {
    var key = String(r.employee_id || ('name:' + r.name));
    var e = by[key] || (by[key] = { employee_id: r.employee_id || '', name: r.name,
                                    display_name: r.display_name || '',
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
           /* The program sidecar — see programsFor_. Carried HERE as well as on the published
              payload, because the publication's whole promise is "the same keys ?action=progress
              returns, so a consumer can switch source without a rewrite". A field on one and not
              the other breaks exactly that. */
           programs: programsFor_(rows),
           refreshed_at: newest,
           /* The floor. `refreshed_at` stays the newest row so no consumer changes meaning under
              them; this is the one to read to answer "is ANY of this stale". */
           oldest_refreshed_at: oldest,
           orphan_program_ids: Object.keys(orphans), orphan_rows: orphanRows };
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
 * INHERITED member truthy, skip the initializer, and start adding units onto a function.
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

  /* Prefer the dutchie id: it is the join Crew reweighted their duplicate scorer to favor
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

/* ── NEVER LET A SECRET OUT IN AN ERROR ───────────────────────────────────────────────────────
 * UrlFetchApp puts the WHOLE URL in its exception message — "Address unavailable: https://…" —
 * and the URLs this engine builds carry GX_DEPLOY_SECRET as a query parameter. So a transient
 * network failure rendered the deploy secret into an error banner in the app, in front of whoever
 * was looking at the screen, and into anything they pasted it into afterwards.
 *
 * Reported by Sky 2026-09-02: a reference pull failed on one store and the message printed the
 * secret in full. That secret opens every secret-gated route in GX Core — sales_by_employee,
 * dev_claim, dev_update, the payroll-shaped reads — so this is not cosmetic.
 *
 * Redacts by PATTERN rather than by comparing against the known value: the message may contain a
 * URL-encoded form, and an error raised before the secret was read would compare against nothing
 * and pass a live one through. Anything that looks like a credential parameter goes. */
function scrubSecrets_(msg) {
  return String(msg == null ? '' : msg)
    .replace(/(secret|token|key|pass|password)=[^&\s"']*/gi, '$1=[redacted]');
}

/* ── ONE BOUNDED RETRY FOR EVERY GX CORE READ OVER HTTP ───────────────────────────────────────
 *
 * GX Core's `/exec` bounces. Measured 2026-09-11/12: the SAME request either answers in ~2s or
 * stalls and comes back as Google's HTML error page — five or six failures in ten consecutive
 * calls during a bad spell. It is Google's second hop, not our code and not our auth; gx-client.js
 * has carried the browser-side retry for exactly this since the Drive-HTML incident, and the
 * server side never got one.
 *
 * WHAT THAT COST. gxSalesByEmployee_ — the call behind every vendor payout number — already
 * DETECTED the bounce and then gave up on the first one, reporting "auth or redirect issue". So a
 * payout calculation failed during a bad spell and sent whoever was standing there to check a
 * deploy secret that was never wrong. One more call, half a second later, usually worked.
 *
 * READS ONLY — and this is the constraint, not a caveat. Retrying a read is free: the worst case
 * is the same answer twice. Retrying a WRITE re-sends it, and nothing in GX Core's secret-gated
 * routes is idempotent by contract — gxWrite_ replaces whole rows and the append path had a race
 * fixed only last night. Do not wrap a write in this without deciding, per route, what a duplicate
 * does. The kiosk-token set_config call below is a write and is deliberately left at one attempt.
 *
 * RETRY TRANSPORT, NEVER AN ANSWER. A thrown fetch, a non-200, an HTML body, a body that will not
 * parse — nothing at the far end formed an opinion, so ask again. A parsed {ok:false} IS GX Core
 * answering: retrying "bad deploy secret" burns three times the wait, fails anyway, and buries the
 * one message that would have explained it. dutchieInventoryViaGXCore_ has drawn that line right
 * since 2026-08-31 ("A refusal is final"); this makes it the rule instead of one function's habit.
 *
 * THE ELAPSED BUDGET IS NOT DECORATION. A bounce sometimes STALLS rather than failing fast, and
 * Google terminates /exec around 60s — so three stalled attempts would turn a recoverable failure
 * into a dead page. Once the budget is spent the loop stops and says that is why, rather than
 * spending the caller's last seconds on an attempt that cannot finish.
 *
 * Returns { ok:true, data } when GX Core answered at all — the caller decides what data.ok means —
 * or { ok:false, error, attempts } when it never did. Errors are scrubbed: the URLs handed to this
 * function carry GX_DEPLOY_SECRET, and UrlFetchApp puts the whole URL in its exception message.
 */
var GXCORE_FETCH_ATTEMPTS   = 3;
var GXCORE_FETCH_BACKOFF_MS = [500, 1500];   // long enough to miss the bad instance, short enough
                                             // that a person waiting on a payout does not give up
var GXCORE_FETCH_BUDGET_MS  = 40000;         // stop starting attempts once /exec's ~60s is in sight

function gxCoreFetchJson_(url, label) {
  var t0 = Date.now();
  var attempts = 0, last = '', ranOut = false;

  for (var i = 0; i < GXCORE_FETCH_ATTEMPTS; i++) {
    attempts++;
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      var code = resp.getResponseCode();
      /* ONCE. getContentText() decodes the whole blob on each call, and a sell-through payload is
         every budtender at a store for a fortnight — not a thing to decode twice to null-check it. */
      var raw  = resp.getContentText();
      var body = String(raw == null ? '' : raw);
      if (code !== 200) {
        last = 'HTTP ' + code + ' from GX Core';
      } else if (body.replace(/^\uFEFF/, '').trim().indexOf('<') === 0) {
        /* Google's error page, or Apps Script's consent page. Both are HTML where JSON belongs,
           and both are worth one more ask — the consent case will keep returning HTML and land on
           the give-up message, which is honest about not knowing which it was. */
        last = 'GX Core returned an HTML page where JSON belongs';
      } else {
        /* A sentinel, not `parsed !== null` — JSON.parse('null') is a legitimate parse and must
           not be mistaken for a failure to parse. */
        var parsed = null, parsedOk = false;
        try { parsed = JSON.parse(body); parsedOk = true; }
        catch (e) { last = 'GX Core returned a body that is not JSON'; }
        if (parsedOk) return { ok: true, data: parsed, attempts: attempts };
      }
    } catch (e) {
      last = scrubSecrets_((e && e.message) || e);
    }

    if (i >= GXCORE_FETCH_ATTEMPTS - 1) break;
    if (Date.now() - t0 >= GXCORE_FETCH_BUDGET_MS) { ranOut = true; break; }
    /* The last backoff repeats if someone raises ATTEMPTS past the list. Sleeping `undefined`
       throws, and a helper that dies in its own retry takes the real error down with it. */
    var wait = GXCORE_FETCH_BACKOFF_MS[i];
    Utilities.sleep(wait == null ? GXCORE_FETCH_BACKOFF_MS[GXCORE_FETCH_BACKOFF_MS.length - 1] : wait);
  }

  return {
    ok: false, attempts: attempts,
    error: (label ? label + ' failed: ' : '')
         + 'GX Core did not answer after ' + attempts + ' attempt' + (attempts === 1 ? '' : 's')
         + (ranOut ? ' (stopped early — the attempts were taking too long to keep trying)' : '')
         + '. The last one was a transport bounce, not a credentials problem — GX Core\'s /exec '
         + 'endpoint intermittently drops requests. Nothing is misconfigured; try again in a '
         + 'minute. Last failure: ' + scrubSecrets_(last),
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

  /* THREE ATTEMPTS, and the error no longer blames auth. This is a READ, so a repeat costs nothing
     but the wait; see gxCoreFetchJson_ for why a write may not do the same. */
  var r = gxCoreFetchJson_(url, 'sell-through for ' + String(store || 'all stores'));
  if (!r.ok) return { ok: false, error: scrubSecrets_(r.error), attempts: r.attempts };
  return r.data;
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
    /* Same normalization as spiffProgress_ — this reader feeds the vendor view, and a Date here
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
  if (!expected) return { ok: false, error: 'Brand access is not set up yet.' };

  // One generic failure for a wrong password OR an unknown email — telling them apart
  // would let someone confirm which reps we work with.
  var deny = function () {
    cache.put(key, String(fails + 1), 900);
    return { ok: false, error: 'That email and password combination does not match an active proposal.' };
  };
  if (pass !== expected) return deny();

  /* WHO MAY OPEN A PROPOSAL IS DECIDED BY THE BRAND REGISTRY IN GX CORE (Sky, 2026-09-14/15).
     It used to be one contact_email typed onto each program. Now any ACTIVE rep on the program's
     brand may sign in, on an ACTIVE brand — so adding a rep in one place opens every proposal for
     that brand, and removing one (or retiring the brand) closes them all at once. getBrands and
     resolveBrand already omit removed reps; the active checks here are belt and braces, so a
     missed filter upstream fails closed rather than letting someone back in.

     A Core outage is NOT a wrong password. It gets its own message, which still names no rep. */
  var repOn = function (brand) {
    if (!brand || !brand.active) return null;
    return (brand.contacts || []).filter(function (c) { return c.active && norm_(c.email) === email; })[0] || null;
  };
  var shared = listProgramsCached_().filter(function (x) { return x.share_token; });
  var unavailable = { ok: false, error: 'Brand sign-in is unavailable right now — please try again in a few minutes.' };

  var prog = null, rep = null;
  if (token) {
    // The link scopes to one program, and the email must be an active rep on THAT program's brand.
    // resolveBrand is Core's own answer to "which brand is this", so the gate never forms a second one.
    prog = shared.filter(function (x) { return x.share_token === token; })[0] || null;
    if (!prog) return deny();
    var brand;
    try { brand = GXCore.resolveBrand(brandNameOf_(prog)); } catch (e) { return unavailable; }
    rep = repOn(brand);
    if (!rep) return deny();
  } else {
    /* No link: show what this rep is on. The shortlist matches each shared program's brand name
       against the names of the brands this rep is on, folded the way Core folds. Core refuses two
       brands sharing a folded name, so this agrees with resolveBrand for every registry-written
       row — and it only offers CHOICES: opening one comes back through the token branch above,
       which asks Core directly. */
    var brands;
    try { brands = GXCore.getBrands() || []; } catch (e) { return unavailable; }
    var mine = brands.filter(function (b) { return repOn(b); });
    if (!mine.length) return deny();
    var names = Object.create(null);
    mine.forEach(function (b) { brandFoldedNames_(b).forEach(function (n) { names[n] = b; }); });
    var onMine = shared.filter(function (x) { return names[brandFold_(brandNameOf_(x))]; });
    if (!onMine.length) return deny();
    if (onMine.length > 1) {
      return { ok: true, choices: onMine.map(function (x) {
        return { token: x.share_token, name: x.program_name || x.title, period: x.start_date || '' };
      }) };
    }
    prog = onMine[0];
    rep = repOn(names[brandFold_(brandNameOf_(prog))]);
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
   * sold:0 for every store. The vendor then saw a table totaling 0 units directly beneath a
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
   * so a vendor could read "117 units sold" above a table totaling 122 and neither number
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
      contact_name: (rep && rep.name) || '',        // the rep who signed in, not a per-program field
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

/* Mint (or reuse) a program's share token. Admin-gated — creating a link that exposes
   a program to an outside party is a write, not a read. */
/* ═══════════════════ THE KIOSK LINK, ONE PER STORE ═══════════════════
 * Sky, 2026-09-07: "We need unique store links for each store. We will then wire these to
 * Leaderboard so that BTs can open a window with the SPIFF details from their Kiosk."
 *
 * ONE PERMANENT LINK PER STORE, NOT PER PROGRAM, and that is the load-bearing decision. A link
 * minted against a program would have to be re-minted and re-pasted into six kiosks every time a
 * SPIFF ends — which means the day somebody forgets, a kiosk shows a finished program as though
 * it were running. Keyed on the STORE, the link is a fact about a screen on a wall: it resolves at
 * read time to whatever is running there today, and to a plain "nothing running" when nothing is.
 *
 * NO SESSION, BY DESIGN. A kiosk is a shared screen in a shop; nobody signs into it. So this route
 * is deliberately the narrowest thing that answers "what should this store be selling": the
 * program, its window, this store's goal, the per-budtender goal, the bounty, and Tawny's copy.
 *
 * IT CARRIES NO PERSON. No names, no per-budtender sell-through, no earnings, no cost and no ROI —
 * a shared screen must not show one budtender's numbers to the room, and a customer standing at
 * the counter must not see what we pay for the product. `flyer` remains the personal view and
 * keeps its sign-in. The two answer different questions and it would be a mistake to merge them.
 *
 * The token is an unguessable per-store uuid (Sky's choice over a passphrase: a kiosk that has to
 * be typed into on every reload is a kiosk showing a login screen). Revocable, and revoking mints
 * nothing — a revoked store simply has no link until somebody makes a new one.
 */
var STORE_LINK_TAB = 'store_links';
var STORE_LINK_HEADERS = ['store_id', 'token', 'created_by', 'created_at', 'revoked_at'];

function storeLinkSheet_() {
  var sh = dataSheet_().getParent().getSheetByName(STORE_LINK_TAB);
  if (!sh) {
    sh = dataSheet_().getParent().insertSheet(STORE_LINK_TAB);
    sh.getRange(1, 1, 1, STORE_LINK_HEADERS.length).setValues([STORE_LINK_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function storeLinkRows_() {
  var sh = storeLinkSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, STORE_LINK_HEADERS.length).getValues()
    .map(function (r, i) {
      return { row: i + 2, store_id: String(r[0] || ''), token: String(r[1] || ''),
               created_by: String(r[2] || ''), created_at: textDate_(r[3]),
               revoked_at: String(r[4] || '') };
    });
}

/* LIST, AND ONLY LIST. This minted for any store that had none, which made merely OPENING the
 * panel write to the sheet — and the dev guard caught it, correctly, by refusing an undeclared
 * write from localhost. A read that mutates is wrong regardless of how convenient it is: it
 * cannot be declared as a read, it cannot be run against production to look, and "I only opened
 * it to check" stops being true. Minting is storeLinkMintAll_ and takes a deliberate press.
 */
function storeLinks_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot manage kiosk links' };
  }

  var stores = [];
  try { stores = gxStores_() || []; } catch (e) { stores = []; }
  /* A REGISTRY THAT DID NOT ANSWER IS NOT AN EMPTY CHAIN. Returning [] would render as "this
     company has no stores", which is never the true answer. Same refusal the progress read makes
     for an empty programs tab. */
  if (!stores.length) {
    return { ok: false, error: 'The store registry did not answer, so this cannot tell which '
                             + 'stores exist. Nothing was changed — try again.' };
  }

  var live = Object.create(null), ever = Object.create(null);
  storeLinkRows_().forEach(function (r) {
    ever[r.store_id] = 1;                                  // it has had one at some point
    if (!r.revoked_at) live[r.store_id] = r;
  });

  var links = stores.map(function (st) {
    var id = slug_(st.store_id || '');
    /* `ever` separates "never set up" from "deliberately revoked". Without it the panel called
       every linkless store revoked, which is a claim that somebody took its link away — sending
       a reader to look for a decision that was never made. */
    return { store_id: id, display_name: st.display_name || id,
             token: (live[id] || {}).token || '', ever: !!ever[id] };
  }).filter(function (x) { return x.store_id; });

  /* Rides on this read rather than being a second request: the panel opens with one call either
     way, and the answer is about exactly the rows just listed. See storeLinksCoreCheck_. */
  var tokens = Object.create(null);
  links.forEach(function (x) { tokens[x.store_id] = x.token; });

  return { ok: true, links: links,
           missing: links.filter(function (x) { return !x.token; }).length,
           core_check: storeLinksCoreCheck_(tokens) };
}

/* ═══ DID EACH STORE'S LINK REACH GX CORE? — a read, and it never says what the link is ═══
 * (2026-10-10.) The Kiosk links warning used to be page memory: reload and it forgot which
 * stores' links had not reached the Command Center, while Core went on holding the wrong thing.
 * This asks. Per store it compares the token store_links holds with the one GX Core holds at
 * cfg.spiffKiosk.<store_id> — the same key gxPublishKioskToken_ writes and Leaderboard's
 * spiffKioskUrl_ reads, keyed on the GX Core store_id — and answers with a STATE:
 *
 *     in_sync     the two match. BOTH EMPTY IS A MATCH: a store with no link on either side is
 *                 not out of step, and '' is what a revoke writes and what "never minted" reads as.
 *     differs     SPIFF has a link and Core holds a different one, or none.
 *     core_only   Core still holds a link and SPIFF has none for that store (a revoke that did
 *                 not land). Republish clears it.
 *     unchecked   Core could not be asked. ITS OWN STATE ON PURPOSE — not in_sync (that would
 *                 hide a real mismatch) and not differs (that would blame links that may be fine).
 *                 The suite has paid for folding an unknown into a falsy five times.
 *
 * IT RETURNS NO TOKEN AND NO PART OF ONE, from either side — store ids and one of four words.
 * The comparison happens here and only the verdict leaves. tests/kiosk_token_publish_test.js
 * asserts neither side's value appears anywhere in the answer.
 *
 * THE LIBRARY, NOT HTTP, AND IN THIS ONE EXECUTION. GXCore.getKv reads one key per call and has no
 * prefix or whole-config form (there is no getConfig()), so this is one read per registry store,
 * SEQUENTIAL — never fanned out, because every GX app shares one 30-at-once execution ceiling and a
 * library call costs no extra execution where a UrlFetch to Core's /exec would. The library keeps
 * each answer for 60 seconds on its own; nothing here caches a verdict.
 *
 * The same trim-and-empty rule as both writers: String(value || '').trim(). */
function storeLinksCoreCheck_(tokensByStore) {
  var out = Object.create(null);
  Object.keys(tokensByStore || {}).forEach(function (id) {
    var mine = String(tokensByStore[id] || '').trim();
    var theirs;
    try { theirs = String(GXCore.getKv('cfg.spiffKiosk.' + id) || '').trim(); }
    catch (e) { out[id] = 'unchecked'; return; }
    out[id] = mine === theirs ? 'in_sync' : (mine ? 'differs' : 'core_only');
  });
  return out;
}

/* ═════════ PUBLISH THE KIOSK TOKEN TO GX CORE, AT MINT AND AT ROTATE ═════════
 * WHAT THE TOKEN DECIDES TODAY (corrected 2026-10-10). The kiosk's SPIFF button is decided ONLY by
 * Leaderboard's Settings → Include SPIFF switch. A store's token decides one thing: whether the
 * per-store link somebody opens BY HAND (store.html?t=<token>, from Settings → Kiosk links here)
 * works. Revoking a token kills that link and changes nothing on the kiosk. Leaderboard stopped
 * tying the button to the token on 2026-09-10, deleted the frame that loaded store.html on
 * 2026-09-17 (v1.879), and since v1.919 (2026-10-09) its engine no longer sends the link to the
 * kiosk at all. This block and the comments below it used to say "no token means no button" and
 * to describe a stale token as "a kiosk button onto a dead page"; the history that follows is
 * kept because it explains why the publish exists, not because the kiosk still works that way.
 *
 * Leaderboard asked for this on 2026-09-09 and it is the right shape, so it is worth writing down
 * WHY rather than just doing it.
 *
 * Their first cut had Sky paste six tokens into a settings form. He asked why a human is involved
 * in one app handing keys to another, and they threw the form away. The deeper reason is that a
 * COPY of a rotatable credential goes stale silently: rotate a token here and the pasted copy still
 * points at the old one, so that kiosk quietly falls back to "This SPIFF board is unavailable — ask
 * Tawny for a new one", on a screen facing the sales floor, discovered by a budtender rather than
 * by us. Writing the key at mint/rotate time means there is no copy to go stale.
 *
 * DIRECTION: this goes through GX Core, not app-to-app. Leaderboard considered asking us to expose
 * storeLinks to SECRET_ACTIONS so their kiosk could read it directly — which would work, and which
 * is the exact app-to-app coupling the publish-to-Core step just unwound. Core is the one hop.
 *
 * set_config, NOT GXCore.setKv. The library's setKv enforces GX_LIB_WRITABLE_KV and
 * cfg.spiffKiosk.* is not on it, so a library call is REFUSED ("not a library-writable kv key").
 * The HTTP route has no allowlist. Anyone tidying this into a library call will find it fails
 * closed and the token silently stops reaching Core, so Leaderboard can no longer compose the
 * per-store link (its spiffKioskUrl_): leave it as the HTTP call. (Corrected 2026-10-10: this said
 * "the kiosk button silently stops appearing". The button does not depend on the token.)
 *
 * SENSITIVITY. These tokens open store.html, which carries no person, no cost and no margin by
 * construction. The per-employee earnings we already publish to Core are strictly more sensitive.
 *
 * AN EMPTY VALUE MEANS "NO LINK", and that is Leaderboard's contract, not our invention:
 * spiffKioskUrl_ returns '' for an empty token, so Leaderboard composes no per-store link. So a
 * revoke writes '' rather than deleting the key — a revoked link whose key lingers is a dead link
 * Leaderboard would still hand out, the same failure as a stale copy arriving a different way.
 * (Corrected 2026-10-10: this said an empty value "IS THE OFF SWITCH", that "no token means no
 * button", and that a lingering key is "a kiosk button onto a dead page". It switches off the
 * link only; the kiosk button is Leaderboard's Include SPIFF setting.)
 */
function gxPublishKioskToken_(storeId, token) {
  var id = slug_(storeId || '');
  if (!id) return { ok: false, store_id: String(storeId || ''), error: 'store required' };

  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret) {
    return { ok: false, store_id: id,
             error: 'GX_DEPLOY_SECRET is not set on this script — the kiosk token cannot reach GX Core.' };
  }

  /* notes= is sent on purpose. gxWrite_ replaces the whole kv row and Core backfills a missing note
     from its own allowlist, which does not cover this key — so without one, the row that explains a
     bare 32-character hex string to the next person reading the kv tab would be blank. */
  var url = GXCORE_URL + '?action=set_config'
    + '&secret=' + encodeURIComponent(secret)
    + '&key='    + encodeURIComponent('cfg.spiffKiosk.' + id)
    + '&value='  + encodeURIComponent(String(token == null ? '' : token))
    + '&notes='  + encodeURIComponent(
        'SPIFF per-store link token for ' + id + '. Written by the SPIFF engine at mint/rotate and '
      + 'blanked on revoke; empty means no link. It does not control the kiosk SPIFF button — that '
      + 'is Leaderboard Settings, Include SPIFF. Do not edit by hand — '
      + 'the value here must match the live row in SPIFF store_links or the link opens a dead page.');

  /* NOT gxCoreFetchJson_, and this is the one exception worth stating out loud: set_config is a
     WRITE. That helper retries transport failures, which is free for a read and is a decision per
     route for a write — a bounce can land AFTER Core has already applied the change, so a retry can
     be a second write. Here that is probably harmless (the same token, written twice) but "probably"
     is not the standard for something a kiosk opens on, and the failure mode of a single attempt is
     a visible error next to a button, not a wrong value. Single attempt, on purpose. */
  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    var body = resp.getContentText();
    /* Apps Script serves the consent page as HTML when authorization has lapsed; JSON.parse on it
       throws something unreadable, so name the real cause. */
    if (body.indexOf('<') === 0) {
      return { ok: false, store_id: id, error: 'GX Core returned HTML (auth or redirect issue)' };
    }
    var j = JSON.parse(body);
    if (!j || !j.ok) return { ok: false, store_id: id, error: (j && j.error) || 'GX Core refused the write' };
    return { ok: true, store_id: id, published: String(token || '') !== '' };
  } catch (e) {
    /* scrubSecrets_ because UrlFetchApp puts the WHOLE url — deploy secret included — into its
       exception message, and this one is rendered into the kiosk-links panel. */
    return { ok: false, store_id: id, error: 'GX Core unreachable: ' + scrubSecrets_(e && e.message || e) };
  }
}

/* Mint for every store that has none, in ONE call. One press rather than one per store: six
 * presses is six chances to stop at five, and the store that gets missed has no link and nobody
 * notices. Idempotent — a store that already has a live link is skipped.
 * (Corrected 2026-10-10: this said the missed store "shows a blank kiosk nobody is standing next
 * to". A missing link leaves the kiosk untouched.) */
function storeLinkMintAll_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot manage kiosk links' };
  }

  var stores = [];
  try { stores = gxStores_() || []; } catch (e) { stores = []; }
  if (!stores.length) {
    return { ok: false, error: 'The store registry did not answer, so this cannot tell which '
                             + 'stores need a link. Nothing was minted — try again.' };
  }

  var sh = storeLinkSheet_();
  var live = Object.create(null);
  storeLinkRows_().forEach(function (r) { if (!r.revoked_at) live[r.store_id] = r; });

  var made = [], published = [], failed = [];
  stores.forEach(function (st) {
    var id = slug_(st.store_id || '');
    if (!id || live[id]) return;
    var tok = Utilities.getUuid().replace(/-/g, '');
    sh.appendRow([id, tok, auth.user, nowStamp_(), '']);
    made.push(id);

    /* PUBLISH AFTER THE SHEET WRITE, NOT BEFORE. The sheet is the system of record; Core's kv is a
       copy of it kept for Leaderboard's benefit. Publishing first would mean a failed appendRow
       leaves Core holding a token no store_links row will ever match — a link that opens a dead
       page, which is worse than no link. This order makes the failure recoverable instead:
       the link exists and works in SPIFF, and republishing is one call.
       (Corrected 2026-10-10: this said "a kiosk pointing at a token" and "a live button onto a
       dead page, which is worse than no button". No kiosk button depends on the token.) */
    var r = gxPublishKioskToken_(id, tok);
    (r.ok ? published : failed).push(r.ok ? id : { store_id: id, error: r.error });
  });

  /* A PARTIAL PUBLISH IS REPORTED, NEVER SWALLOWED. If Core is unreachable the links are still
     minted and still correct here, but Core does not hold them — and the panel saying a
     cheerful "minted 6" over that is how a person concludes the job is done and stops looking.
     (Corrected 2026-10-10: this said "no kiosk will show a button". The kiosk button does not
     depend on the token; the publish_note below was reworded to match the same day.) */
  return { ok: true, minted: made, published: published, publish_failed: failed,
           publish_note: failed.length
             ? 'Minted, but ' + failed.length + ' store link(s) did not reach GX Core, so '
               + 'Leaderboard cannot build the link for those stores. The links work when opened '
               + 'from here, and nothing changes on the kiosk. '
               + 'Re-run ?action=publishKioskTokens&apply=1 once Core '
               + 'is reachable — nothing needs re-minting.'
             : '' };
}

/* Revoke one store's link and mint its replacement in the same call — a store with no link has
 * nothing to open by hand, so "revoke" in practice always means "rotate".
 * (Corrected 2026-10-10: this said "a kiosk with no link is a blank screen". The kiosk never
 * depends on the link now.)
 *
 * EVERYTHING BELOW THIS LINE IS HISTORY, NOT CURRENT BEHAVIOR (corrected 2026-10-10). It describes
 * how a rotated link reached a kiosk when the kiosk button opened store.html. Leaderboard deleted
 * that frame on 2026-09-17 (v1.879) and since v1.919 (2026-10-09) no longer sends the link to the
 * kiosk, so a rotation has nothing to propagate to a wall screen and no reload is needed. What
 * still holds is the decision it records: rotation is ATOMIC, with no grace period for the old
 * token.
 *
 * ── A ROTATION DOES NOT REACH A PARKED KIOSK UNTIL IT RELOADS ────────────────────────────────
 * ROTATE, THEN RELOAD THAT STORE'S SCREEN. Leaderboard traced this for us on 2026-09-09 when we
 * asked how fast a rotation propagates, and the answer decided the design here:
 *
 *     Core          effectively immediate — set_config invalidates its own config cache
 *     their server  up to ~55s — the composed URL rides a 55s CacheService entry
 *     their client  up to the NEXT 04:00 PT — worst case ~24h
 *
 * The kiosk header is built only during a FULL render, and their 60s poll is a delta that updates
 * numbers in place without rebuilding it. What saves it is a nightly reload armed on every page
 * load, which fires once per day after 04:00 PT and rebuilds everything. So a parked kiosk
 * self-heals overnight rather than staying wrong forever — but a whole TRADING DAY fits inside the
 * window. Rotate at 10am Tuesday and that screen is wrong until 4am Wednesday, most of it in front
 * of customers. (A slideshow kiosk repaints on every store rotation, which is why this looks fine
 * wherever it gets tested and lingers on the single-store screens.)
 *
 * WE DELIBERATELY DID NOT PAPER OVER IT. The obvious accommodation is to keep the old token alive
 * alongside the new one for a grace period, and we offered to. It is the wrong trade at 24h just as
 * it was at "forever": no overlap anyone would be willing to build covers a trading day, and
 * weakening a revocation to compensate for a stale render leaves a credential we were asked to
 * retire usable while it is still on the wall. Rotation stays ATOMIC — the old token dies the
 * instant the new one is minted, which is what revoking a credential has to mean.
 *
 * The real fix is Leaderboard's and they own it (carry the kiosk URL on the delta response, which
 * bounds it at one ~60s poll). Until that lands: after rotating, reload that store's screen from
 * Leaderboard's Settings tray — "Reload all kiosk screens", or one store at a time.
 */
function storeLinkRotate_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot manage kiosk links' };
  }
  var id = slug_(p.store || '');
  if (!id) return { ok: false, error: 'store required' };

  var sh = storeLinkSheet_(), rows = storeLinkRows_();
  var stamp = nowStamp_();
  rows.forEach(function (r) {
    if (r.store_id === id && !r.revoked_at) sh.getRange(r.row, 5).setValue(stamp);
  });

  /* REVOKE: blank the key rather than leaving it. Leaderboard treats an empty value as "no
     link", so this stops it composing a per-store link that would open the "ask Tawny for a new
     one" page. A revoked link whose kv key lingers is the same failure as a stale pasted copy,
     arriving a different way.
     (Corrected 2026-10-10: this said Leaderboard treats an empty value as "no token, no button"
     and that a revoke "takes the button off the kiosk". Revoking kills the hand-opened link and
     changes nothing on the kiosk; the publish_note strings below were reworded the same day.) */
  if (String(p.revoke || '') === '1') {
    var cleared = gxPublishKioskToken_(id, '');
    return { ok: true, store_id: id, token: '', revoked: true,
             published: cleared.ok,
             publish_error: cleared.ok ? '' : cleared.error,
             publish_note: cleared.ok ? ''
               : 'The link is revoked HERE, but GX Core still holds the old token, so the copy of '
                 + 'the link Leaderboard holds opens a dead page. Nothing changes on the kiosk. '
                 + 'Re-run ?action=publishKioskTokens&apply=1 to clear it.' };
  }

  var tok = Utilities.getUuid().replace(/-/g, '');
  sh.appendRow([id, tok, auth.user, stamp, '']);

  var pub = gxPublishKioskToken_(id, tok);
  return { ok: true, store_id: id, token: tok,
           published: pub.ok,
           publish_error: pub.ok ? '' : pub.error,
           publish_note: pub.ok ? ''
             : 'The new link works HERE, but GX Core still holds the OLD token — which this call '
               + 'just revoked — so the copy of the link Leaderboard holds opens a dead page '
               + 'until it is republished. Nothing changes on the kiosk. '
               + 'Re-run ?action=publishKioskTokens&apply=1.' };
}

/* ═══ BACKFILL / REPAIR: push every live kiosk token to GX Core in one call ═══
 * Two jobs, and they are the same job.
 *
 * BACKFILL, once: six links already existed in store_links before any of this was written. They
 * were never waiting on Sky or Tawny to paste them anywhere — they simply never left this app,
 * which is why every kiosk showed no SPIFF button on the day this was written (2026-09-09).
 * Nothing reaches Leaderboard until this runs. (Corrected 2026-10-10: this read "shows no SPIFF
 * button today". The button has not depended on a token since 2026-09-10.)
 *
 * REPAIR, from then on: mint and rotate publish as they go, but a publish can fail while the sheet
 * write succeeds — Core unreachable, a lapsed authorization, a bad minute on the second hop. Those
 * paths say so rather than swallowing it, and this is what they tell you to run. It is idempotent,
 * so running it when nothing is wrong costs six writes and changes nothing.
 *
 * IT ALSO CLEARS REVOKED STORES, which is why it walks the STORE REGISTRY rather than the live
 * rows. Iterating live links alone would republish the good ones and leave a revoked store's stale
 * token sitting in Core forever — a link onto a dead page, and the one case where doing
 * nothing looks identical to success. (Corrected 2026-10-10: this said "a kiosk button onto a
 * dead page".)
 *
 * DRY BY DEFAULT, like sweepOrphanProgress and publishToCore. It reports exactly what it would
 * write, per store, without writing — because the honest way to check this is to look first, and
 * because writes ride on GET here, so a URL gets pasted and re-fetched.
 */
function publishKioskTokens_(p) {
  var apply = String((p && p.apply) || '') === '1';

  var stores = [];
  try { stores = gxStores_() || []; } catch (e) { stores = []; }
  /* Same refusal as storeLinks_ and the progress read: a registry that did not answer is not an
     empty company. Walking [] here would report "nothing to publish" — which reads as success and
     is the one answer that must never be produced by a failed lookup. */
  if (!stores.length) {
    return { ok: false, error: 'The store registry did not answer, so this cannot tell which '
                             + 'stores exist. Nothing was published — try again.' };
  }

  var live = Object.create(null);
  storeLinkRows_().forEach(function (r) { if (!r.revoked_at) live[r.store_id] = r; });

  var plan = [], failed = [];
  stores.forEach(function (st) {
    var id = slug_(st.store_id || '');
    if (!id) return;
    var tok = (live[id] || {}).token || '';
    var act = tok ? 'publish' : 'clear';   // clear covers revoked AND never-minted; both mean no link (corrected 2026-10-10: said "no button")
    var row = { store_id: id, display_name: st.display_name || id, action: act,
                has_link: !!tok, key: 'cfg.spiffKiosk.' + id };

    if (apply) {
      var r = gxPublishKioskToken_(id, tok);
      row.ok = r.ok;
      if (!r.ok) { row.error = r.error; failed.push(row); }
    }
    plan.push(row);
  });

  /* The token VALUES are deliberately not in this response. It is reachable with the deploy secret
     and gets read in a terminal and pasted into chats; the store and the action are what a person
     checking this needs, and the value adds nothing they cannot get from the links panel. */
  return {
    ok: !failed.length,
    dry: !apply,
    stores: plan.length,
    publishing: plan.filter(function (x) { return x.action === 'publish'; }).length,
    clearing:   plan.filter(function (x) { return x.action === 'clear'; }).length,
    failed: failed,
    plan: plan,
    note: apply
      ? (failed.length
          ? failed.length + ' store(s) did not reach GX Core; those kiosks are unchanged. Re-run once Core is reachable.'
          : 'Published. Leaderboard reads cfg.spiffKiosk.<store_id> and needs no change.')
      : 'DRY RUN — nothing was written. Add &apply=1 to publish.'
  };
}

/* ═══ THE SAME REPAIR, FROM THE PANEL: an editor's session instead of the deploy secret ═══
 * (2026-10-10.) The warning on Settings → Kiosk links told a person to re-run
 * ?action=publishKioskTokens&apply=1 — a route no browser can call, because it is in SECRET_ACTIONS
 * and guard_ answers those before it looks at a session. The deploy secret stays server-side, and
 * the secret gate is NOT loosened: publishKioskTokens is still secret-only and still refuses a
 * session token. This is a second door onto the same function, for a signed-in editor.
 *
 * AUTH IS storeLinkMintAll_'s, LINE FOR LINE — a real session (gxAuth_) and an editing role
 * (EDIT_ROLES) — plus GXCore.roleCanEdit, so a role GX Core itself calls read-only cannot get in
 * even if this file's list ever drifts. Both must say yes; an unreachable library fails closed.
 * Like Create and Replace, the handler wants a SESSION: guard_ lets a deploy secret through to any
 * token-gated route, and this then refuses it for having no session, exactly as those two do.
 *
 * NO SECOND IMPLEMENTATION. It calls publishKioskTokens_ with apply=1 and reshapes the answer into
 * the field names storeLinkMintAll_ already uses (`published`, `publish_failed`), so the panel
 * reads one shape from all three buttons.
 *
 * REPLAY. Writes ride on GET, so this URL can be re-fetched. That is harmless here and needs no
 * typed confirmation: it writes, per store, the token store_links ALREADY holds (or blank where
 * there is none), so a second run rewrites the same values. Create is safe the same way (it skips
 * a store that has a link). It mints nothing and revokes nothing.
 *
 * A REGISTRY THAT DID NOT ANSWER is passed through as the refusal publishKioskTokens_ made of it —
 * ok:false with its own words — never as "nothing needed republishing". */
function storeLinksRepublish_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot manage kiosk links' };
  }
  var coreSaysEdit = false;
  try { coreSaysEdit = GXCore.roleCanEdit(auth.role) === true; } catch (e) { coreSaysEdit = false; }
  if (!coreSaysEdit) {
    return { ok: false, error: 'Your role (' + auth.role + ') cannot manage kiosk links' };
  }

  var res = publishKioskTokens_({ apply: '1' });
  if (!res || !res.plan) return res || { ok: false, error: 'republish failed' };

  var failed = (res.failed || []).map(function (x) {
    return { store_id: x.store_id, error: String(x.error || '') };
  });
  return { ok: true, stores: res.stores,
           published: res.plan.filter(function (x) { return x.ok === true; })
                              .map(function (x) { return x.store_id; }),
           publish_failed: failed,
           publish_note: failed.length ? String(res.note || '') : '' };
}

/* ── THE PEOPLE ON THE BOARD AT ONE STORE ────────────────────────────────────────────────────────
 * Sky, 2026-09-11, asked for via Leaderboard: the kiosk's SPIFF button now opens store.html
 * directly, so this page went from a secondary view to the whole feature, and the per-person
 * progress bars that lived in Leaderboard's own panel move here.
 *
 * THIS REVERSES WHAT THIS PAGE WAS FOR, so the reasoning is worth keeping. store.js said: a kiosk
 * faces the room, and one budtender's numbers are not the room's business. What changed is that the
 * Leaderboard board on the SAME wall screen already carries every person's SPIFF units and target on
 * their staff card, all day — so on that screen this adds nothing new. Sky confirmed it directly
 * here, not through the peer request.
 *
 * WHAT STAYS OUT, and this is the half that reads worst over a counter: EARNINGS. No `earned`, no
 * payout per person, no cost or ROI. Progress toward a goal is what was asked for and all that is
 * returned — a consumer cannot render what the route does not send.
 *
 * IDs stay out too. A kiosk page needs a name and two numbers; `employee_id` would be one more
 * thing riding on a credential-free URL for nobody's benefit.
 *
 * FROM THE CACHE, never a live Dutchie pull. Six kiosks polling ~9s-per-store sell-through would be
 * both slow and pointless: the hourly refresh is what every other consumer reads, and a kiosk that
 * disagreed with Crew's column would be a second answer. `measured_at` rides along so the page can
 * say how old the figures are rather than implying they are live.
 *
 * EVERYONE AT THE STORE, including the people at zero — same rule the operator grid got the same
 * day. A budtender missing from the board cannot tell whether they sold nothing or were left out.
 */
function storePeople_(programId, store) {
  var rows = [];
  try { rows = progressRowsFor_(programId) || []; } catch (e) { return { people: [], measured_at: '' }; }

  var nameMap = displayNameMap_();
  var out = [], seenId = Object.create(null), seenName = Object.create(null), newest = '';
  rows.forEach(function (r) {
    if (slug_(r.store_id) !== store) return;
    var id = String(r.employee_id || '').trim();
    var friendly = friendlyName_(nameMap, id, r.name) || String(r.name || '').trim();
    if (!friendly) return;
    if (id) seenId[id] = 1;
    seenName[userKey_(r.name)] = 1;
    seenName[userKey_(friendly)] = 1;
    out.push({ name: friendly, units: Number(r.units) || 0,
               target: Number(r.target) || 0, hit: !!r.hit });
    var st = stampOf_(r.refreshed_at);
    if (st > newest) newest = st;
  });

  /* The roster fills in whoever the cache has no row for. A read that fails adds nobody, which is
     the board exactly as it was — never a reason to show no one. */
  var roster = [];
  try { var e = gxEmployees_(); roster = (e && e.ok && e.employees) || []; } catch (e2) { roster = []; }
  roster.forEach(function (emp) {
    if (slug_(emp.home_store || '') !== store) return;
    var id = String(emp.dutchie_employee_id || '').trim();
    if (id && seenId[id]) return;
    var full = String(emp.full_name || '').trim();
    var friendly = String(emp.display_name || full).trim();
    if (!friendly) return;
    if (seenName[userKey_(full)] || seenName[userKey_(friendly)]) return;
    out.push({ name: friendly, units: 0, target: 0, hit: false, unmeasured: true });
  });

  /* Most sold first, then alphabetical, so the board reads as a board and a zero row is not a
     random position that looks like a ranking. */
  out.sort(function (a, b) {
    if (b.units !== a.units) return b.units - a.units;
    return String(a.name).localeCompare(String(b.name));
  });
  return { people: out, measured_at: newest };
}

/* THE KIOSK READ. No token in the GX sense and no session — the URL token IS the credential, so
 * it is matched against a live row and nothing else is trusted from the caller. */
function storeView_(p) {
  var tok = String(p.t || '').trim();
  if (!tok) return { ok: false, error: 'This link is missing its code.' };

  var hit = null;
  storeLinkRows_().forEach(function (r) { if (r.token === tok && !r.revoked_at) hit = r; });
  /* Says the link is dead, not that the store is — a kiosk showing "no such store" would send
     somebody looking for a problem with the shop rather than with the URL. */
  if (!hit) return { ok: false, error: 'This link is no longer active. Ask Tawny for a new one.' };

  var store = hit.store_id, storeLabel = store, storeColor = '';
  try {
    (gxStores_() || []).forEach(function (x) {
      if (slug_(x.store_id) !== store) return;
      if (x.display_name) storeLabel = x.display_name;
      /* The store's own color, read from the SAME registry row the name comes from. The page
         draws its store track in it, and a seventh store inherits its own without either file
         being opened. The alternative was loading gx-stores.js on the kiosk page, which is a
         second GX Core call from six shop screens for a value already in hand here. */
      if (x.color) storeColor = String(x.color);
    });
  } catch (e) { /* the slug is a poor label, but better than none */ }

  /* Dates are TEXT and compared as text — lexicographic order IS chronological for YYYY-MM-DD,
     so this never coerces a Date and never trips the timezone shift. Same rule as flyer_. */
  var today = nowStamp_().slice(0, 10);
  var out = [];
  listPrograms_().forEach(function (pr) {
    if (!programRunsAt_(pr, store, today)) return;

    var tgt = pr.target_json || {};
    var pitch = normalizePitch_(pr.pitch_json);
    var crew = storePeople_(pr.program_id, store);
    /* The per-budtender target is the program's per_bt for this store. The cached row carries one
       too, but it can be the split-across-sellers fallback sellthrough_ computes when no per_bt is
       set, which changes as people sell — a bar whose goal moves under the person reading it. */
    var perBt = Number((tgt.per_bt || {})[store]) || 0;
    crew.people.forEach(function (x) { x.target = perBt; x.hit = perBt > 0 && x.units >= perBt; });
    out.push({
      program_id: pr.program_id,
      people: crew.people,
      measured_at: crew.measured_at,
      /* The joined label is built in the browser from vendor + name, exactly as the operator app
         does it — one rule, not two that agree by luck. */
      vendor: pr.vendor || '', program_name: pr.program_name || pr.title || '',
      start_date: pr.start_date || '', end_date: pr.end_date || '',
      product: productLabelOf_(pr),
      store_goal: Number((tgt.by_store || {})[store]) || 0,
      bt_goal:    Number((tgt.per_bt   || {})[store]) || 0,
      payout:     Number((pr.payout_json || {}).amount) || 0,
      payout_type: payoutModelOf_(pr),
      tips: pitch.tips
    });
  });

  /* Soonest to end first — the one closest to its deadline is the one worth pushing today. */
  out.sort(function (x, y) { return String(x.end_date).localeCompare(String(y.end_date)); });

  var res = { ok: true, store_id: store, store_name: storeLabel, store_color: storeColor,
              today: today, programs: out };
  /* NOTHING RUNNING IS STILL A SCREEN. How the store finished the last one is the one thing worth
     saying to a room with no SPIFF on today, and only the engine knows it — the page cannot infer
     it and must not fake it. Computed ONLY on the empty path: it costs a progress read, and on any
     normal day there is a program and this never runs. */
  if (!out.length) {
    var last = lastClosedFor_(store, today);
    if (last) res.last_program = last;
  }
  return res;
}

/* IS THIS PROGRAM AT THIS STORE, and IS IT RUNNING TODAY. Extracted 2026-09-17 so the two places
 * that answer "nothing is running here" cannot drift: the kiosk route, and the per-store chip now
 * carried on the publication. The chip's whole contract is that its PRESENCE means nothing is
 * running, so a second copy of this predicate would eventually draw a finished program beside a
 * live board.
 *
 * Dates are TEXT and compared as text — lexicographic order IS chronological for YYYY-MM-DD, so
 * this never coerces a Date and never trips the timezone shift.
 *
 * NOT-CLOSED rather than active-only, deliberately, and unchanged from what storeView_ did inline:
 * a draft whose window covers today is a program a budtender can sell into, and the status roll
 * activates it within the hour anyway. Hiding it would take a live program off a shop floor to
 * satisfy a status column. */
function programCoversStore_(pr, store) {
  return ((pr && pr.stores_json) || []).some(function (x) {
    return slug_(x && x.store_id ? x.store_id : x) === store;
  });
}
function programRunsAt_(pr, store, today) {
  var st = String((pr && pr.status) || '').toLowerCase();
  var a = (pr && pr.start_date) || '', b = (pr && pr.end_date) || '';
  if (st === 'closed' || !a || !b) return false;
  if (!(a <= today && today <= b)) return false;
  return programCoversStore_(pr, store);
}

/* The most recently finished program at one store, and how the store did on it.
 *
 * Attainment is measured the same way the live board measures it — the store's cached progress
 * rows against the program's per-store goal — rather than from `actual_json`, whose `units_sold`
 * is the whole chain. Two answers to "how did this store do" is the failure this app keeps paying
 * for. No percentage rather than a wrong one when the program carried no store goal.
 *
 * `src` (added 2026-09-17) lets a caller that ALREADY HOLDS the programs list and the cached rows
 * hand them in rather than making this read the sheets again — the publisher computes one chip per
 * store and would otherwise do two reads per store for data it is holding. Omitted, it reads for
 * itself exactly as before, which is what the kiosk route does. Injecting data is not a second
 * implementation; a second `lastClosedFor_` written for the publisher would have been. */
function lastClosedFor_(store, today, src) {
  var best = null;
  ((src && src.programs) || listPrograms_()).forEach(function (pr) {
    if (String(pr.status || '').toLowerCase() !== 'closed') return;
    var end = pr.end_date || '';
    if (!end || end > today) return;
    if (!programCoversStore_(pr, store)) return;
    if (!best || end > best.end_date) best = pr;
  });
  if (!best) return null;

  var goal = Number(((best.target_json || {}).by_store || {})[store]) || 0;
  var pct = null;
  if (goal > 0) {
    var sold = 0;
    try {
      var rows = (src && src.rowsFor)
        ? src.rowsFor(best.program_id)
        : progressRowsFor_(best.program_id);
      (rows || []).forEach(function (r) {
        if (slug_(r.store_id) === store) sold += Number(r.units) || 0;
      });
      pct = Math.round((sold / goal) * 100);
    } catch (e) { pct = null; }
  }
  /* Name and vendor separately, so the page joins them with the ONE rule both screens share. No
     units, no payout, no cost — a finished program is even less a kiosk's business than a live
     one, and this chip exists to say the board is not broken, not to report on it. */
  var chip = { vendor: best.vendor || '', program_name: best.program_name || best.title || '',
               end_date: best.end_date || '' };
  if (pct != null) chip.store_pct = pct;
  return chip;
}

/* ═════════ THE SAME CHIP, FOR EVERY STORE, ON THE PUBLICATION ═════════
 * Leaderboard asked for this on 2026-09-17 and the request is worth writing down properly, because
 * the obvious reading of it was wrong and cost a round trip.
 *
 * THE MISTAKE. `last_program` shipped on `storeView` in v1.429 and we told Leaderboard the work was
 * done. It was not: THEY DO NOT READ `storeView`. Since Sky's 2026-09-16 decision their kiosk panel
 * reads the PUBLICATION — `GXCore.publishedSpiffProgress(secret, scope)` — which is the whole point
 * of the consolidation, and the published payload had no such key and never had. Checking the route
 * and reporting on the consumer is the second time in one week a fact about `storeView` was read as
 * a fact about the publication. They caught it; we did not.
 *
 * WHY IT IS NOT SIMPLY "ADD THE FIELD". The publication's unit is A PAY PERIOD'S ROWS, grouped by
 * period derived from each row's start date. "How did this store finish its last one" is a PER-STORE
 * fact that outlives every period, and the empty board exists exactly when that store contributes no
 * rows. Mirroring the storeView shape onto one period's payload would put a field on a payload whose
 * existence depends on the field being unnecessary — so it goes on as its OWN per-store map, keyed by
 * store, carried by every scope rather than belonging to any of them.
 *
 * PRESENCE IS THE SIGNAL, exactly as on `storeView`: a store appears here only when NOTHING IS
 * RUNNING there today. That is why `programRunsAt_` was extracted rather than re-typed — a consumer's
 * rule is then identical on both pipes (key present → draw the chip), and no reader can end up
 * drawing a finished program beside a live board.
 *
 * THE ONE CASE IT DOES NOT COVER, stated rather than discovered later: when the cache holds no rows
 * with a usable window at all, `publishSpiffToCore_` publishes nothing, so there is no payload to
 * carry this and no chip anywhere. Loosening that early return would mean publishing a rows-empty
 * payload under a live scope, and Crew reads this pipe for money — blanking a period that Core
 * already holds rows for is a far worse failure than a plainer empty screen. It is also close to
 * unreachable: a closed program's rows stay in the cache, so the chain would have to have no
 * measured history whatsoever.
 *
 * NOT ON `?action=progress`, and this is a departure from that payload's "same keys" promise, made
 * on purpose. That route takes `pay_period`, `program` and `status` FILTERS, and a map computed from
 * a filtered slice is quietly wrong rather than absent — `?status=active` holds no closed rows, so
 * every percentage would come back null and read as "no goal was set". A field that is right only
 * when nobody passed an argument is worse than a field that is somewhere else. The publisher reads
 * unfiltered, which is the one caller that can compute this honestly. */
function lastProgramsByStore_(rows, programs, today) {
  var out = Object.create(null);
  var list = programs || [];

  /* The store set comes from the PROGRAMS' own stores, not from the GX Core registry. A store with
     no finished program gets no entry either way, so asking Core would be a call per publish for a
     list that cannot change the answer — and this runs on the hourly trigger, on the shared 30-at-once
     account. */
  var stores = Object.create(null);
  list.forEach(function (pr) {
    ((pr && pr.stores_json) || []).forEach(function (x) {
      var id = slug_(x && x.store_id ? x.store_id : x);
      if (id) stores[id] = 1;
    });
  });

  /* One pass over the cached rows, bucketed by program, rather than a sheet read per store —
     `lastClosedFor_` would otherwise read the progress sheet once for every store on the chain. */
  var byProgram = Object.create(null);
  (rows || []).forEach(function (r) {
    var id = String((r && r.program_id) || '');
    if (!id) return;
    (byProgram[id] || (byProgram[id] = [])).push(r);
  });
  var src = { programs: list, rowsFor: function (id) { return byProgram[String(id)] || []; } };

  Object.keys(stores).forEach(function (store) {
    var running = list.some(function (pr) { return programRunsAt_(pr, store, today); });
    if (running) return;
    var last = lastClosedFor_(store, today, src);
    if (last) out[store] = last;
  });
  return out;
}

/* What the SPIFF is ON, in words, for a screen that cannot show a filter. Mirrors the operator
 * app's productFromMatch: brand alone means the vendor's whole range. */
function productLabelOf_(pr) {
  var m = pr.match_json || {};
  var prods = (m.products || []).filter(Boolean);
  if (prods.length) return prods.join(' + ');
  if (m.filter_text) return (m.brand ? m.brand + ' ' : '') + m.filter_text;
  if (m.brand) return 'All ' + m.brand + ' products';
  return '';
}

/* ════ BRAND CONTACTS — the reps live in GX Core, not on the program ══════════════════════════════
 * Sky, 2026-09-14: "we only have a few dozen vendors, is it better to bake their profiles in?"
 * Tawny was typing a contact onto every program, and Inventory needs the same list. So the reps
 * moved to GX Core's brand registry (library v330): `brands` + `brand_contacts`, keyed by BRAND —
 * Sky's choice over a vendor/distributor layer. SPIFF reads it and edits it; Core is the only
 * writer, and every write here passes the signed-in user as `by`.
 *
 * What a program knows is its BRAND NAME (match_json.brand, else vendor). Which registry brand
 * that is, is Core's call — resolveBrand folds case and punctuation, so "National Cannabis Co."
 * and "National Cannabis Co" are one brand. Nothing brand-related is stored on the program.
 *
 * Contact emails are half of a vendor rep's sign-in, so every read here is session-gated (guard_
 * default) and no route hands the list to an anonymous caller. */
function brandNameOf_(prog) {
  var m = prog && prog.match_json;
  if (typeof m === 'string') m = parseJson_(m, {});
  return String((m && m.brand) || (prog && prog.vendor) || '').trim();
}

// Core's fold, mirrored for the no-link shortlist and the seed's grouping only. Access itself is
// decided by GXCore.resolveBrand; see clientView_.
function brandFold_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function brandFoldedNames_(b) {
  return [b.brand_id, b.display_name].concat(b.aliases || []).map(brandFold_).filter(Boolean);
}

function brandEditor_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { denied: { ok: false, error: auth.error || 'Not signed in', needsAuth: true } };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) {
    return { denied: { ok: false, error: 'Your role (' + auth.role + ') cannot change brand contacts' } };
  }
  return { user: String(auth.user || '') };
}

/* Every brand, removed reps and retired brands included, so the program screen can show and restore them.
 *
 * CACHED FOR THE SCREEN ONLY. GXCore.getBrands answers in 6–30s through the library (measured
 * 2026-09-15), and a screen that waits that long reads as broken. So:
 *  - the hourly trigger re-reads it into the cache (warmBrandsCache_), which lives a little longer
 *    than an hour, so a person opening the screen almost never pays for the read;
 *  - SPIFF's own writes PATCH the cached list from what Core returns (applyBrandWrite_) instead of
 *    throwing it away — throwing it away is what made every add sit for half a minute re-reading
 *    all of it, with nothing on screen saying why (Sky, 2026-09-15);
 *  - an edit made OUTSIDE SPIFF (Inventory, or Core's sheet by hand) can take up to an hour to show.
 * The VENDOR SIGN-IN never reads this — clientView_ asks Core directly, so removing a rep closes
 * their access immediately, not an hour later. */
var BRANDS_CACHE_KEY = 'gx_brands_all';
var BRANDS_CACHE_TTL = 3900;   // 65 min: outlives the hourly warm, so the cache does not lapse between runs
function brandsRead_(p) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(BRANDS_CACHE_KEY);
  if (hit) { try { return { ok: true, brands: JSON.parse(hit), cached: true }; } catch (e) {} }
  var brands;
  try { brands = GXCore.getBrands({ all: true }) || []; }
  catch (e) { return { ok: false, error: 'GX Core brand list unavailable: ' + scrubSecrets_(e && e.message || e) }; }
  try { cache.put(BRANDS_CACHE_KEY, JSON.stringify(brands), BRANDS_CACHE_TTL); } catch (e) {}   // >100KB just skips caching
  return { ok: true, brands: brands };
}
function warmBrandsCache_() {
  var brands = GXCore.getBrands({ all: true }) || [];
  try { CacheService.getScriptCache().put(BRANDS_CACHE_KEY, JSON.stringify(brands), BRANDS_CACHE_TTL); } catch (e) {}
  return brands.length;
}

/* Fold one successful Core write into a brand list, from the write's OWN result — no re-read.
   gxUpsertBrand returns the whole brand (contacts included); gxUpsertBrandContact and
   gxDeactivateBrandContact return the contact plus the ids whose primary flag it demoted. Contacts
   keep Core's order (primary first, then name, then email) so "the main contact is [0]" still holds.
   The browser runs the same rule as applyBrandWrite in spiff.js. */
function applyBrandWrite_(brands, r) {
  brands = brands || [];
  if (!r || !r.ok) return brands;
  if (r.brand && r.brand.brand_id) {
    var i = -1;
    brands.forEach(function (b, k) { if (b.brand_id === r.brand.brand_id) i = k; });
    if (i >= 0) brands[i] = r.brand; else brands.push(r.brand);
    brands.sort(function (a, b) { return String(a.display_name).localeCompare(String(b.display_name)); });
  }
  if (r.contact && r.contact.contact_id) {
    var brand = brands.filter(function (b) { return b.brand_id === (r.brand_id || r.contact.brand_id); })[0];
    if (brand) {
      var cs = brand.contacts || (brand.contacts = []), j = -1;
      cs.forEach(function (c, k) { if (c.contact_id === r.contact.contact_id) j = k; });
      if (j >= 0) cs[j] = r.contact; else cs.push(r.contact);
      (r.demoted || []).forEach(function (id) { cs.forEach(function (c) { if (c.contact_id === id) c.is_primary = false; }); });
      cs.sort(function (a, c) {
        return (Number(!!c.is_primary) - Number(!!a.is_primary)) || String(a.name || '').localeCompare(String(c.name || ''))
            || String(a.email || '').localeCompare(String(c.email || ''));
      });
    }
  }
  return brands;
}

function brandsChanged_(r) {
  if (!r || !r.ok) return r;
  try {
    var cache = CacheService.getScriptCache(), hit = cache.get(BRANDS_CACHE_KEY);
    if (hit) cache.put(BRANDS_CACHE_KEY, JSON.stringify(applyBrandWrite_(JSON.parse(hit), r)), BRANDS_CACHE_TTL);
  } catch (e) {
    try { CacheService.getScriptCache().remove(BRANDS_CACHE_KEY); } catch (e2) {}   // a patch that fails must not leave a wrong list
  }
  return r;
}

// Add a brand to the shared list. Core refuses a name another brand already answers to, and says which.
function addBrand_(p) {
  var who = brandEditor_(p);
  if (who.denied) return who.denied;
  var name = String(p.display_name || '').trim();
  if (!name) return { ok: false, error: 'display_name required' };
  try { return brandsChanged_(GXCore.gxUpsertBrand({ display_name: name, create: 1, by: who.user })); }
  catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_(e && e.message || e) }; }
}

/* Edit a brand's own details from the Settings directory: website, notes, and other spellings.
   NOT the display name, and not on/off. A program finds its brand BY NAME, so renaming "Gron" to
   "Grön" without keeping the old spelling would quietly unhook every Gron program from its reps —
   and turning a brand off locks all its reps out at once. Both are real, rare, and not this screen. */
var BRAND_FIELDS = ['brand_id', 'website', 'notes', 'aliases', 'clear'];
function saveBrand_(p) {
  var who = brandEditor_(p);
  if (who.denied) return who.denied;
  var b = parseJson_(p.brand, null);
  if (!b || !b.brand_id) return { ok: false, error: 'brand_id required' };
  var out = { by: who.user };
  BRAND_FIELDS.forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(b, f) && b[f] != null) out[f] = b[f];
  });
  try { return brandsChanged_(GXCore.gxUpsertBrand(out)); }   // no create: an unknown brand_id is refused
  catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_(e && e.message || e) }; }
}

/* Add or edit one rep. Only the fields Core's contract names are passed through, so a stray key in
   the request cannot ride along into a shared tab. Without contact_id Core adds — or reactivates the
   brand's existing row for that email, which is what "add a rep" after "remove a rep" should do. */
var BRAND_CONTACT_FIELDS = ['contact_id', 'brand_id', 'email', 'name', 'phone', 'role', 'is_primary', 'active', 'clear'];
function saveBrandContact_(p) {
  var who = brandEditor_(p);
  if (who.denied) return who.denied;
  var c = parseJson_(p.contact, null);
  if (!c || typeof c !== 'object') return { ok: false, error: 'contact required' };
  var out = { by: who.user };
  BRAND_CONTACT_FIELDS.forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(c, f) && c[f] != null) out[f] = c[f];
  });
  try { return brandsChanged_(GXCore.gxUpsertBrandContact(out)); }
  catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_(e && e.message || e) }; }
}

// Soft: the row stays in Core with active=false, so "who could sign in, and when" survives.
function removeBrandContact_(p) {
  var who = brandEditor_(p);
  if (who.denied) return who.denied;
  if (!p.contact_id) return { ok: false, error: 'contact_id required' };
  try { return brandsChanged_(GXCore.gxDeactivateBrandContact({ contact_id: String(p.contact_id), by: who.user })); }
  catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_(e && e.message || e) }; }
}

/* ONE-TIME SEED: every brand SPIFF has run a program on, with no contacts — Tawny adds reps as she
 * works. Deliberately not all of Dutchie's ~137 brands. Secret-gated and DRY BY DEFAULT; apply=1
 * writes. Re-runnable: a spelling Core already resolves is skipped rather than patched, so a re-run
 * can never rename a brand someone has since edited.
 *
 * Spellings that fold together become ONE brand. The display name is the spelling most programs
 * use (ties: the most recent program's), and the rest become aliases. */
function seedBrands_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  var apply = String(p.apply || '') === '1';

  var groups = Object.create(null);
  listPrograms_().forEach(function (prog) {
    var name = brandNameOf_(prog), k = brandFold_(name);
    if (!k) return;
    var g = groups[k] || (groups[k] = { spellings: Object.create(null) });
    var sp = g.spellings[name] || (g.spellings[name] = { n: 0, latest: '' });
    sp.n++;
    if (String(prog.start_date || '') > sp.latest) sp.latest = String(prog.start_date || '');
  });

  var plan = Object.keys(groups).sort().map(function (k) {
    var names = Object.keys(groups[k].spellings);
    names.sort(function (a, b) {
      var x = groups[k].spellings[a], y = groups[k].spellings[b];
      return (y.n - x.n) || y.latest.localeCompare(x.latest) || a.localeCompare(b);
    });
    return { display_name: names[0], aliases: names.slice(1),
             brand_id: names[0].toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') };
  });

  var results = plan.map(function (b) {
    var found = null;
    try { found = GXCore.resolveBrand(b.display_name, { all: true }); }
    catch (e) { return { brand_id: b.brand_id, action: 'error', error: scrubSecrets_(e && e.message || e) }; }
    if (found) return { brand_id: found.brand_id, action: 'exists', display_name: found.display_name };
    if (!apply) return { brand_id: b.brand_id, action: 'would_create', display_name: b.display_name, aliases: b.aliases };
    var r = GXCore.gxUpsertBrand({ brand_id: b.brand_id, display_name: b.display_name,
                                   aliases: b.aliases, create: 1, by: String(p.by || 'spiff:seedBrands') });
    return r && r.ok ? { brand_id: r.brand_id, action: r.created ? 'created' : 'unchanged', aliases: b.aliases }
                     : { brand_id: b.brand_id, action: 'refused', error: r && r.error };
  });
  if (apply) { try { CacheService.getScriptCache().remove(BRANDS_CACHE_KEY); } catch (e) {} }
  return { ok: true, dry: !apply, count: results.length, brands: results };
}

function shareLink_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) return { ok: false, error: 'Your role cannot create brand links' };

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

/* ── WHAT EACH PERSON SOLD, IN ONE PLACE ──────────────────────────────────────────────────────
 * Found 2026-09-08, and it is the FOURTH output in this family wired to nothing. buildReport_
 * called reportHtml_(prog, null) unconditionally, so the vendor PDF printed
 *
 *     "Per-budtender breakdown is not included: this program's sell-through was recorded in
 *      aggregate. Programs tracked in SPIFF carry the full budtender matrix."
 *
 * …on programs that carry exactly that matrix. Portland Heights has 38 budtenders measured across
 * six stores, frozen on its own record since 2026-09-02, and its per-store "Sold" column printed
 * an em dash for every store. The report format this app exists to replace — "SPIFF_Sales Report -
 * Gron - 092925.pdf" — IS the budtender matrix; that is the document, not an appendix to it.
 *
 * Same shape of miss as the gift-card list: written when per-budtender detail genuinely did not
 * exist, left alone after it arrived in August. So the source selection lives here once rather
 * than a third time, for the same reason payoutFactsOf_ exists.
 *
 * THE FROZEN SNAPSHOT WINS. It is the measurement the vendor was invoiced against; re-deriving
 * from today's cache could put different numbers on a report than the one already sent. The live
 * cache is the fallback for a program still running.
 */
function measuredRowsFor_(prog) {
  var snap = prog.progress_json && prog.progress_json.stores ? prog.progress_json : null;
  var rows = [], byStore = Object.create(null), source = '';

  if (snap) {
    source = 'frozen snapshot, measured ' + String(snap.at || '').slice(0, 10);
    var nameMap = displayNameMap_();
    /* ── THE PER-BUDTENDER TARGET IS ON THE PROGRAM, NOT ON THE ROW ────────────────────────
       A snapshot row is {name, employee_id, units, hit, earned} — it never stored a target,
       because `hit` was already resolved against one when the measurement ran. So the vendor
       report printed "TARGET 0" beside 18 ticked HIT cells: eighteen people shown as having hit
       a target of zero, on the document asking the vendor for $450.

       The real figure is target_json.per_bt, per store, which is what the Calculator computed and
       what the record holds — 5 units at Commercial and 3 everywhere else on BeGOAT. Read from
       there rather than re-derived, so the report cannot disagree with the goals the vendor
       agreed to. */
    var perBt = (prog.target_json || {}).per_bt || {};
    (snap.stores || []).forEach(function (st) {
      /* ABSENT IS NOT ZERO (Sky, 2026-11-03): a store snapshot with no usable units figure, or a 0 with
         no budtender rows behind it, was never measured. Writing 0 made the vendor email say every
         store was down 100% while the chain total was up. Leave the store out of byStore instead. */
      var stUnits = (st.units == null || st.units === '') ? NaN : Number(st.units);
      if (isFinite(stUnits) && (stUnits !== 0 || (st.rows || []).length)) byStore[st.store_id] = stUnits;
      var goal = Number(perBt[st.store_id]) || 0;
      (st.rows || []).forEach(function (e) {
        var legal = String(e.name || '').trim();
        rows.push({ name: friendlyName_(nameMap, e.employee_id, legal) || legal,
                    legal_name: legal, store_id: st.store_id,
                    units: Number(e.units) || 0,
                    /* The row's own value wins if a future snapshot ever carries one. */
                    target: Number(e.target) || goal,
                    hit: !!e.hit, earned: Number(e.earned) || 0 });
      });
    });
  } else {
    var live = spiffProgress_({ program: prog.program_id,
                                secret: PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP) });
    if (live && live.ok) {
      source = 'live cache, refreshed ' + String(live.refreshed_at || '').slice(0, 16);
      (live.rows || []).forEach(function (r) {
        byStore[r.store_id] = (byStore[r.store_id] || 0) + (Number(r.units) || 0);
        rows.push({ name: r.display_name || r.name, legal_name: r.name, store_id: r.store_id,
                    units: Number(r.units) || 0, target: Number(r.target) || 0,
                    hit: !!r.hit, earned: Number(r.earned) || 0 });
      });
    }
  }
  /* Most sold first — the vendor reads the top of this table. */
  rows.sort(function (a, b) { return b.units - a.units || String(a.name).localeCompare(String(b.name)); });
  return { rows: rows, by_store: byStore, source: source,
           /* When the figures were taken, so a mid-week sheet can say "as of" rather than imply
              they are live. A frozen snapshot carries its own time; a running program uses the
              hourly cache's. Empty when neither is known. */
           as_of: snap ? String(snap.at || '') : (live && live.ok ? String(live.refreshed_at || '') : '') };
}

/* ── STORE BY STORE (Sky's asks 2026-11-03: "break down by store like old reports" and "send mid
 * week store by store reports (printable)") ────────────────────────────────────────────────────
 * The old report, SPIFF_Sales Report - Gron - 092925.pdf, was one block per store: the store's
 * total, then each budtender's units against the target. The staff copy had flattened that into one
 * long table across all six stores. These three builders put the blocks back, and the SAME blocks
 * feed the staff PDF and the mid-week sheet so the two cannot disagree.
 *
 * STAFF EYES ONLY. These carry budtender names. The brand page (brandPaperHtml_) is a different
 * builder and never calls these. Nothing here sends anything: storeReport_ only builds.
 *
 * FIGURES COME FROM measuredRowsFor_: the frozen snapshot for a closed program, the hourly cache for
 * a running one -- never a live Dutchie pull, so opening this costs the account no executions. */
function storeSectionsOf_(prog, measured) {
  var t = prog.target_json || {};
  var perBt = t.per_bt || {};
  var f = payoutFactsOf_(prog);
  var names = Object.create(null);
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { /* slugs are a poor label, not a blank one */ }
  var rows = (measured && measured.rows) || [];

  /* The program's stores first, in its order; then any store that has rows but is not listed, so
     the flat table this replaces never loses a budtender. */
  var ids = (prog.stores_json || []).slice(), seen = Object.create(null);
  ids.forEach(function (s) { seen[slug_(s)] = 1; });
  rows.forEach(function (r) { var k = slug_(r.store_id); if (!seen[k]) { seen[k] = 1; ids.push(r.store_id); } });

  return ids.map(function (s) {
    var key = slug_(s);
    var goalPer = Number(perBt[s]) || 0;
    var mine = rows.filter(function (r) { return slug_(r.store_id) === key; });
    mine.sort(function (a, b) { return (Number(b.units) || 0) - (Number(a.units) || 0) || String(a.name).localeCompare(String(b.name)); });
    var bts = mine.map(function (r) {
      var units = Number(r.units) || 0, target = Number(r.target) || goalPer;
      var earned = Number(r.earned) || 0;
      return { name: r.name, units: units, target: target,
               hit: !!r.hit || (f.per_unit && earned > 0), earned: earned };
    });
    var byStore = measured && measured.by_store ? measured.by_store[key] : null;
    var sold = (byStore != null && byStore !== '' && isFinite(Number(byStore))) ? Number(byStore)
             : (bts.length ? bts.reduce(function (n, b) { return n + b.units; }, 0) : null);
    return { store_id: s, name: names[key] || s, sold: sold,
             goal: Number((t.by_store || {})[s]) || 0, per_bt: goalPer,
             hit: bts.filter(function (b) { return b.hit; }).length,
             earned: bts.reduce(function (n, b) { return n + b.earned; }, 0),
             bts: bts };
  });
}

/* One store's block: heading line plus the budtender table. `o.togo` adds a "To go" column (the
   mid-week sheet: how many more units until each person hits). Inline styles only, because the PDF
   converter and a browser print of an injected fragment both ignore a stylesheet we don't ship. */
function storeBlockHtml_(sec, f, o) {
  o = o || {};
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var FONT = 'font-family:Helvetica,Arial,sans-serif;';
  var showTarget = !f.per_unit;
  var th = function (x, right) {
    return '<th style="' + FONT + 'text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#5a635f;border-bottom:1px solid #d7dedb">' + x + '</th>';
  };
  var td = function (x, right, bold) {
    return '<td style="' + FONT + 'text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;font-size:' + (o.big ? '14' : '12') + 'px;color:#1a1f1d;font-weight:' + (bold ? '700' : '400') + ';border-bottom:1px solid #eef2f0">' + x + '</td>';
  };
  var soldTxt = sec.sold == null ? '—' : sec.sold.toLocaleString();
  var head = '<div style="' + FONT + 'font-size:15px;font-weight:800;color:#1a1f1d;border-bottom:2px solid #1a1f1d;padding:0 0 5px;margin:0 0 4px">'
    + esc(sec.name)
    + '<span style="font-weight:400;font-size:12px;color:#5a635f"> &middot; '
    + soldTxt + ' units sold'
    + (showTarget && sec.goal ? ' of ' + sec.goal.toLocaleString() + ' goal' : '')
    + (showTarget && sec.bts.length ? ' &middot; ' + sec.hit + ' of ' + sec.bts.length + ' hit' : '')
    + '</span></div>';
  if (!sec.bts.length) {
    return '<div style="margin:0 0 18px">' + head
      + '<p style="' + FONT + 'font-size:12px;color:#5a635f;margin:6px 0">No budtender sales recorded for this store yet.</p></div>';
  }
  var body = sec.bts.map(function (b) {
    var togo = (b.target > 0 && b.units < b.target) ? (b.target - b.units) : 0;
    return '<tr>' + td(esc(b.name))
      + td(b.units.toLocaleString(), true, true)
      + (showTarget
          ? td(b.target ? b.target.toLocaleString() : '—', true)
            + (o.togo ? td(b.hit ? 'Hit' : (b.target ? String(togo) : '—'), true) : td(b.hit ? '✓' : '', true))
          : td(moneyStr_(b.earned), true))
      + '</tr>';
  }).join('');
  return '<div style="margin:0 0 18px;page-break-inside:avoid">' + head
    + '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse"><tr>'
    + th('Budtender') + th('Units', 1)
    + (showTarget ? th('Target', 1) + th(o.togo ? 'To go' : 'Hit', 1) : th('Earned', 1))
    + '</tr>' + body + '</table></div>';
}

/* The days of a running program, as text-date arithmetic (both sides parsed the same way, so no
   timezone can shift the answer). Returns null for a program with no usable window. */
function programDayInfo_(prog, today) {
  var d = function (s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; };
  var a = d(prog.start_date), b = d(prog.end_date), n = d(today);
  if (a == null || b == null || n == null || b < a) return null;
  var total = b - a + 1, day = Math.min(Math.max(n - a + 1, 0), total);
  return { day: day, total: total, left: Math.max(b - n, 0), over: n > b, before: n < a };
}

/* The mid-week sheet: one PAGE per store, light, meant to be printed and handed to that store. */
function storeReportHtml_(prog, sections, info) {
  info = info || {};
  var f = payoutFactsOf_(prog);
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var FONT = 'font-family:Helvetica,Arial,sans-serif;';
  var label = brandProgramLabel_(prog);
  var period = prog.start_date ? prettyDay_(prog.start_date) + ' – ' + prettyDay_(prog.end_date || '') : '';
  var di = info.days;
  var dayLine = !di ? '' : (di.before ? 'Starts ' + prettyDay_(prog.start_date)
    : (di.over ? 'Program ended' : 'Day ' + di.day + ' of ' + di.total + ' · ' + di.left + ' day' + (di.left === 1 ? '' : 's') + ' left'));
  var asOf = info.as_of ? 'Figures as of ' + String(info.as_of).slice(0, 16).replace('T', ' ') + ' (updated hourly)' : 'Figures from the most recent hourly update';
  var rate = f.per_unit ? moneyStr_(f.rate) + ' per unit sold' : moneyStr_(f.rate) + ' each for hitting target';

  return '<div style="' + FONT + 'color:#1a1f1d;background:#fff">' + sections.map(function (sec, i) {
    var pct = (!f.per_unit && sec.goal && sec.sold != null) ? Math.round(sec.sold / sec.goal * 100) + '% of goal' : '';
    return '<div style="' + (i < sections.length - 1 ? 'page-break-after:always;' : '') + 'padding:6px 4px 24px">'
      + '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid #1a1f1d;border-bottom:2px solid #1a1f1d;margin:0 0 14px"><tr>'
      + '<td style="padding:12px 0"><img src="' + LOGO_ONLIGHT + '" alt="Green Cross" height="22" style="height:22px;width:auto;display:block;margin:0 0 8px">'
      +   '<div style="' + FONT + 'font-size:18px;font-weight:800">' + esc(sec.name) + ' &mdash; SPIFF check-in</div>'
      +   '<div style="' + FONT + 'font-size:12px;color:#5a635f">' + esc(label) + (period ? ' &middot; ' + esc(period) : '') + '</div></td>'
      + '<td style="padding:12px 0;text-align:right;vertical-align:top">'
      +   '<div style="' + FONT + 'font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#5a635f">' + esc(dayLine) + '</div>'
      +   '<div style="' + FONT + 'font-size:26px;font-weight:800">' + (sec.sold == null ? '—' : sec.sold.toLocaleString()) + '</div>'
      +   '<div style="' + FONT + 'font-size:11px;color:#5a635f">units sold' + (pct ? ' &middot; ' + esc(pct) : '') + '</div></td></tr></table>'
      + '<p style="' + FONT + 'font-size:12px;color:#5a635f;margin:0 0 12px">SPIFF: ' + esc(rate) + '. '
      +   (f.per_unit ? '' : 'Each budtender’s target is ' + (sec.per_bt ? sec.per_bt.toLocaleString() + ' units' : 'set on the program') + '. ') + '</p>'
      + storeBlockHtml_(sec, f, { togo: true, big: true })
      + '<p style="' + FONT + 'font-size:10.5px;color:#5a635f;margin:14px 0 0">' + esc(asOf) + ' &middot; Green Cross SPIFF &middot; for store staff, not for brands.</p>'
      + '</div>';
  }).join('') + '</div>';
}

/* ── EMAILING THE STORE SHEETS (Sky, 2026-11-03: recipients "both", delivery "email") ──────────────
 * Each store's manager(s) get THEIR store's sheet; Tawny gets one email with every store. A person
 * decides: storeReportPlan_ only works out who, sendStoreReports_ runs only from an editor's click
 * (dry unless send=1), never from a trigger, and refuses a repeat for the same ISO week unless
 * resend=1 (writes ride on GET and a URL gets re-fetched).
 *
 * ADDRESSES COME LIVE FROM GX CORE, never from here: GXCore.getEmployeeContacts joins
 * employees.user_id to users.email and says `contactable:false` when there is no address. A manager
 * with no address is NAMED in `missing` so the screen can say so; their store is not silently dropped
 * and no address is ever guessed. Tawny's address is the fixed one in MKT_PEOPLE_. */
function weekStartOf_(ymd) {
  var m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  var back = (new Date(t).getUTCDay() + 6) % 7;           // Monday = 0
  var d = new Date(t - back * 86400000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

function storeReportPlan_(prog, sections) {
  var contacts = [], err = '';
  try { contacts = GXCore.getEmployeeContacts({ role: 'manager' }) || []; }
  catch (e) { err = 'Could not read the managers from GX Core: ' + scrubSecrets_(e && e.message || e); }
  var units = [], missing = [];
  sections.forEach(function (sec) {
    /* MANAGERS ONLY (Sky, 2026-11-03): an Assistant Manager does not get the sheet unless Tawny asks
       for it. GX Core's "manager" match is a substring, so assistants arrive in the list and are
       filtered out here, by title. */
    var mine = contacts.filter(function (c) {
      return slug_(c.home_store) === slug_(sec.store_id) && !/assistant|asst/i.test(String(c.role_title || ''));
    });
    var withMail = mine.filter(function (c) { return c.contactable && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(c.email || '').trim()); });
    if (withMail.length) {
      units.push({ key: 'store:' + slug_(sec.store_id), kind: 'store', store_id: sec.store_id, store_name: sec.name,
                   to: withMail.map(function (c) { return String(c.email).trim().toLowerCase(); }),
                   names: withMail.map(function (c) { return c.preferred_name || c.full_name; }) });
    }
    mine.filter(function (c) { return withMail.indexOf(c) < 0; }).forEach(function (c) {
      missing.push({ store_id: sec.store_id, store_name: sec.name, name: c.preferred_name || c.full_name, reason: 'no email on file' });
    });
    if (!mine.length) missing.push({ store_id: sec.store_id, store_name: sec.name, name: '', reason: 'no manager listed for this store' });
  });
  units.push({ key: 'all', kind: 'all', store_name: 'All stores', to: [MKT_PEOPLE_.tawny], names: ['Tawny'] });
  return { units: units, missing: missing, week: weekStartOf_(today_()), error: err };
}

function storeReportSubject_(prog, unit, info) {
  var di = info && info.days;
  return 'SPIFF check-in — ' + unit.store_name + ' — ' + brandProgramLabel_(prog)
    + (di && !di.before && !di.over ? ' (day ' + di.day + ' of ' + di.total + ')' : '');
}

function sendStoreReports_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) return { ok: false, error: 'Your role cannot send reports' };
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;
  var measured = measuredRowsFor_(prog);
  var sections = storeSectionsOf_(prog, measured);
  var info = { as_of: measured.as_of, days: programDayInfo_(prog, today_()) };
  var plan = storeReportPlan_(prog, sections);
  if (plan.error) return { ok: false, error: plan.error };

  var props = PropertiesService.getScriptProperties();
  var key = 'storesent:' + prog.program_id + ':' + plan.week;
  var sent = {};
  try { sent = JSON.parse(props.getProperty(key) || '{}') || {}; } catch (e) { sent = {}; }
  var resend = String(p.resend) === '1';
  var todo = plan.units.filter(function (u) { return resend || !sent[u.key]; });
  var already = plan.units.filter(function (u) { return !resend && sent[u.key]; }).map(function (u) { return u.store_name; });

  if (String(p.send) !== '1') {                         // DRY: say who, send nothing
    return { ok: true, dry: true, week: plan.week, would_send: todo.map(function (u) { return { store: u.store_name, to: u.to }; }),
             already: already, missing: plan.missing };
  }
  if (!todo.length) return { ok: false, already: true, error: 'This week\'s store sheets were already sent (' + already.join(', ') + '). Send again only if you mean to.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another send is in progress. Try again in a moment.' };
  var done = [], failed = [];
  try {
    todo.forEach(function (u) {
      var secs = u.kind === 'all' ? sections : sections.filter(function (s) { return slug_(s.store_id) === slug_(u.store_id); });
      var html = storeReportHtml_(prog, secs, info);
      var text = 'SPIFF check-in for ' + u.store_name + ' — ' + brandProgramLabel_(prog) + '. Open this email in a mail app that shows HTML to see the sheet.';
      try {
        sendMail_({ to: u.to.join(','), subject: storeReportSubject_(prog, u, info), body: text, htmlBody: html,
                    replyTo: MKT_PEOPLE_.tawny, name: 'Green Cross SPIFF' });
        sent[u.key] = nowStamp_();
        done.push({ store: u.store_name, to: u.to });
      } catch (e) {
        failed.push({ store: u.store_name, error: scrubSecrets_(e && e.message || e) });
      }
    });
    props.setProperty(key, JSON.stringify(sent));      // what DID go out stays recorded even if another failed
  } finally {
    lock.releaseLock();
  }
  return { ok: failed.length === 0, sent: done, failed: failed, missing: plan.missing, by: auth.user, week: plan.week,
           error: failed.length ? 'Some did not send: ' + failed.map(function (f) { return f.store; }).join(', ') : undefined };
}

/* `?action=storeReport&id=` -- the breakdown as data plus the printable HTML. READ ONLY, builds
   and returns, never sends. Any signed-in role may read it (the editor-only gate is on sending, and
   nothing here sends); names are on it, so it needs a real session or the deploy secret. */
function storeReport_(p) {
  var deploySecret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  var viaSecret = !!(deploySecret && p.secret && String(p.secret) === deploySecret);
  if (!viaSecret) {
    var auth = gxAuth_(p.token);
    if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  }
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;
  var measured = measuredRowsFor_(prog);
  var sections = storeSectionsOf_(prog, measured);
  var info = { as_of: measured.as_of, days: programDayInfo_(prog, today_()) };
  return { ok: true, program_id: prog.program_id, label: brandProgramLabel_(prog), status: prog.status,
           per_unit: payoutFactsOf_(prog).per_unit, as_of: measured.as_of, source: measured.source,
           days: info.days, stores: sections, html: storeReportHtml_(prog, sections, info),
           /* Who WOULD get it, so the screen can show recipients (and the stores with no manager
              address) before anybody clicks. Names and addresses of staff: same gate as the names. */
           plan: (function () { var pl = storeReportPlan_(prog, sections);
             return { week: pl.week, error: pl.error, missing: pl.missing,
                      units: pl.units.map(function (u) { return { key: u.key, store: u.store_name, to: u.to, names: u.names }; }) }; })() };
}

/* ── WHAT THE VENDOR IS OWED, IN ONE PLACE ────────────────────────────────────────────────────
 * Found 2026-09-08 by running the close-out against a real closed program. All three outputs —
 * the vendor PDF, the drafted email and the gift-card buy list — computed the credit as
 *
 *     owed = bts_hit × rate
 *
 * which is the FLAT formula, applied unconditionally. Portland Heights is per_unit: 242 units at
 * $0.75 is $181.50, and it is $181.50 in the record, on the screen and in what Core publishes.
 * The three close-out paths said $28.50 — 38 earners × $0.75. Tawny would have asked the vendor
 * for $153 less than we were owed, on a document titled "Credit due Green Cross", and the buy
 * list would have been short by the same amount.
 *
 * THE SAME BUG WAS ALREADY FOUND AND FIXED TWICE, in the progress stats strip and in pullActuals,
 * both of which carry a comment about it. It survived here because the formula was written out by
 * hand in three more places, and fixing the two that were noticed did not touch them. That is the
 * argument for this function existing at all: the rule now has ONE home, and a fourth output
 * cannot get it wrong by being written later.
 *
 * THE RECONCILED FIGURE WINS. `actual_json.investment` is the number a human verified — pulled
 * from Dutchie or corrected by hand — and it is what every screen already shows. The model
 * computation is the fallback for a record that has no investment recorded yet.
 *
 * A DISAGREEMENT IS REPORTED, NEVER SILENTLY RESOLVED. If the stored figure and the model
 * computation differ, something is wrong with one of them, and this is a document that goes to a
 * vendor. The callers surface it rather than printing whichever number happened to win.
 */
function payoutFactsOf_(prog) {
  var a = prog.actual_json || {};
  var perUnit = payoutModelOf_(prog) === 'per_unit';
  /* The SETTLED rate first — a program can be modeled at one rate and settle at another, which is
     what the record's rate_changed warning is about. */
  var rate    = Number(a.spiff_amount) || payoutRateOf_(prog);
  var units   = Number(a.units_sold) || 0;
  var earners = Number(a.bts_hit) || 0;

  /* PER-UNIT PAYS ON VOLUME. `earners` counts people who cleared an individual target, and a
     per-unit program sets none — everyone who sold anything earned — so rate × earners is not a
     smaller version of the right answer, it is a different quantity. */
  var computed = perUnit ? rate * units : rate * earners;

  var hasStored = a.investment != null && a.investment !== '';
  var stored = Number(a.investment) || 0;
  var owed = hasStored ? stored : computed;

  return {
    per_unit: perUnit, rate: rate, units: units, earners: earners, owed: owed,
    /* HOW the total was arrived at, in words, so a vendor document can show its working and a
       reader can check it without knowing the payout model. */
    basis: perUnit
      ? units.toLocaleString() + ' units × ' + moneyStr_(rate) + ' a unit'
      : earners + ' budtender' + (earners === 1 ? '' : 's') + ' × ' + moneyStr_(rate),
    /* Labels follow the model. "SPIFF per budtender" on a per-unit program is wrong twice over:
       it is per unit, and there is no per-budtender bonus to name. */
    rate_label:   perUnit ? 'SPIFF per unit sold' : 'SPIFF per budtender',
    earner_label: perUnit ? 'Budtenders who earned' : 'Budtenders who hit their target',
    /* Rounded to the cent before comparing — floating point makes 181.5 and 181.49999 the same
       number in every sense a vendor cares about. */
    mismatch: hasStored && Math.round(stored * 100) !== Math.round(computed * 100)
      ? { stored: stored, computed: computed } : null
  };
}

function moneyStr_(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Budtenders per store on every report: the suite's norm, hardcoded (Sky, 2026-09-30). Mirrors
   BTS_PER_STORE in spiff.js. */
var BTS_PER_STORE = 6;

function reportHtml_(p, matrix) {
  var a    = p.actual_json || {};
  var t    = p.target_json || {};
  var f    = payoutFactsOf_(p);
  var rate = f.rate, owed = f.owed;
  var esc  = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  var money = function (n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  /* ── DISPLAY NAMES, NOT SLUGS ────────────────────────────────────────────────────────────
     This printed the internal store_id, so a document sent to a vendor listed "bend",
     "hillsboro", "portland-rd" and "river-rd" — four of the six differ from what anybody calls
     the shop. giftCardList_ and the kiosk both resolve them; the one output that leaves the
     building did not. Falls back to the slug when the registry cannot be read, which is a poor
     label but better than a blank row. */
  var storeNameOf = Object.create(null);
  try {
    (gxStores_() || []).forEach(function (x) {
      storeNameOf[slug_(x.store_id)] = x.display_name || x.store_id;
    });
  } catch (e) { /* fall through to slugs */ }

  /* A PER-UNIT PROGRAM HAS NO TARGET, so printing 0 is not a smaller number — it is a claim that
     one existed and was zero. "242 UNITS SOLD / 0 TARGET" on a vendor report reads as a miss
     against a goal nobody set. Same reasoning as the payout labels: the column follows the
     model, and on per-unit it is dropped rather than zeroed. */
  var showTarget = !f.per_unit;

  /* "Portland Heights · Portland Heights · 2026-08-17 to 2026-08-30" — the program name and the
     vendor are the same string on several programs, and printing both is a stutter on the title
     line of a document going to that vendor. Same rule programLabel() follows in the browser. */
  var heading = String(p.program_name || p.title || '').trim();
  var vend = String(p.vendor || '').trim();
  var titleLine = (!vend || heading.toLowerCase().indexOf(vend.toLowerCase()) === 0)
    ? (heading || vend) : (vend + ' · ' + heading);

  var storeRows = (p.stores_json || []).map(function (s) {
    var key = slug_(s);
    var tgt = (t.by_store || {})[s] || 0;
    var act = matrix && matrix.by_store ? (matrix.by_store[key] || 0) : null;
    return '<tr><td>' + esc(storeNameOf[key] || s) + '</td>'
      + '<td class="n">' + BTS_PER_STORE + '</td>'
      + (showTarget ? '<td class="n">' + tgt + '</td>' : '')
      + '<td class="n">' + (act == null ? '&mdash;' : act) + '</td></tr>';
  }).join('');

  /* ONE BLOCK PER STORE, like the old reports (Sky, 2026-11-03): the store's total, then each
     budtender against the target. This was one flat table across every store. Same builder as the
     mid-week sheet. The heading text is unchanged on purpose. */
  var matrixHtml = matrix && matrix.rows && matrix.rows.length
    ? '<h2>By budtender</h2>' + storeSectionsOf_(p, matrix).map(function (sec) {
        return storeBlockHtml_(sec, f, {});
      }).join('')
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
    /* The masthead, matching the on-screen preview the operator approves before saving.
       gx-logo-onlight.png, NOT gx-theme's gx-logo.png: the shared asset sets "CROSS" in white for
       the dark topnav, and on this white page half the company name would be invisible on the one
       document a vendor actually receives. Height drives it so the wordmark cannot be squashed. */
    + '.mark{display:block;height:26px;width:auto;margin:0 0 14px}'
    + '</style></head><body>'
    + '<img class="mark" src="' + LOGO_ONLIGHT + '" alt="Green Cross">'
    + '<h1>Green Cross SPIFF Performance Report</h1>'
    + '<p class="sub">' + esc(titleLine)
    +   (p.start_date ? ' &middot; ' + esc(p.start_date) + ' to ' + esc(p.end_date || '') : '') + '</p>'
    + '<div class="stats">'
    +   '<div class="stat"><b>' + (a.units_sold || 0).toLocaleString() + '</b><span>Units sold</span></div>'
    +   (showTarget
            ? '<div class="stat"><b>' + (t.units || 0).toLocaleString() + '</b><span>Target</span></div>'
            : '')
    +   '<div class="stat"><b>' + f.earners + '</b><span>' + esc(f.earner_label) + '</span></div>'
    +   '<div class="stat"><b>' + money(rate) + '</b><span>'
    +     esc(f.per_unit ? 'SPIFF per unit' : 'SPIFF each') + '</span></div>'
    + '</div>'
    /* THE BASIS IS PRINTED BESIDE THE TOTAL. This line used to read "38 budtenders × $0.75" under
       a total of $28.50 on a program that owed $181.50 — the working was as wrong as the figure,
       so it confirmed itself. It now comes from payoutFactsOf_, which knows the payout model. */
    + '<div class="owed"><span>Credit due Green Cross</span><br><b>' + money(owed) + '</b>'
    +   '<br><span>' + esc(f.basis) + '</span></div>'
    /* A stored figure that disagrees with the model computation is shown ON the document rather
       than resolved behind it. This is what the vendor is being asked to credit. */
    + (f.mismatch
        ? '<p class="note" style="color:#b00">The recorded total (' + money(f.mismatch.stored)
          + ') does not match ' + esc(f.basis) + ' = ' + money(f.mismatch.computed)
          + '. Verify before sending.</p>'
        : '')
    /* THE HEADER HAS TO DROP THE COLUMN TOO. Making only the <td> conditional left a TARGET
       heading over two cells, so every store's SOLD figure rendered underneath it — a vendor
       document labelling 242 units of sell-through as targets, which is worse than the zeros it
       replaced. Caught by reading the generated PDF, not the diff. */
    + '<h2>By store</h2><table><tr><th>Store</th><th class="n">BTs</th>'
    +   (showTarget ? '<th class="n">Target</th>' : '')
    +   '<th class="n">Sold</th></tr>' + storeRows + '</table>'
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
    /* The matrix, not null. See measuredRowsFor_: this argument was hardcoded null, so every
       vendor PDF printed "per-budtender breakdown is not included" and an em dash per store on
       programs that had both. */
    var measured = measuredRowsFor_(prog);
    var blob   = Utilities.newBlob(reportHtml_(prog, measured), 'text/html', 'r.html').getAs('application/pdf').setName(name);
    var folder = DriveApp.getFolderById(REPORT_FOLDER_ID);
    var file   = folder.createFile(blob);
    return { ok: true, name: name, file_id: file.getId(), url: file.getUrl(), by: auth.user,
             /* What went ON the document, so a caller can tell a full report from one that had
                no measurements to include — the PDF says so too, but silently. */
             budtenders: measured.rows.length, measured_from: measured.source };
  } catch (e) {
    return { ok: false, error: 'Could not write to the reports folder: ' + scrubSecrets_(e && e.message || e) };
  }
}

/* The vendor email DRAFT: text for a human to copy, an HTML preview in the brand page's layout, and
   whether the app can send it (see sendBrandEmail_). This function only builds — it never sends. */
function emailDraft_(p) {
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program, a = prog.actual_json || {}, t = prog.target_json || {};
  var f    = payoutFactsOf_(prog);
  var rate = f.rate, owed = f.owed;
  var m    = moneyStr_;

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
      '  ' + f.earner_label + ': ' + f.earners + '\n' +
      '  ' + f.rate_label + ': ' + m(rate) + '\n' +
      '  Total credit due:  ' + m(owed) + '  (' + f.basis + ')\n\n' +
      'The full report is attached. Please apply ' + m(owed) + ' as a credit against our next order.\n\n' +
      'Thanks for supporting the team —\n\n' +
      'Tawny Vierra\nInventory Manager\nGreenCrossCanna.com\n',
    attach_hint: 'Attach the PDF saved to the SPIFF close-out folder in Drive.',
    /* The preview the screen shows and "Send to brand" sends — the same builder, so what you read
       is what goes. A failure here must never take the plain-text draft down with it. */
    html: (function () {
      try { return brandPaperHtml_(prog, measuredRowsFor_(prog), { greeting: String(p.first_name || '').trim(), closing: 'Tawny' }); }
      catch (e) { return ''; }
    })(),
    send_from: brandFromAddress_(),
    send_ready: !!brandFromAddress_(),
    /* Surfaced, not buried in the body. Nothing sends from here — a human does — so the warning
       belongs where the UI can refuse to present the draft as ready. */
    warning: f.mismatch
      ? 'The recorded total (' + m(f.mismatch.stored) + ') does not match ' + f.basis + ' = '
        + m(f.mismatch.computed) + '. Verify the actuals before sending this.'
      : undefined
  };
}

/* ── SENDING THE BRAND EMAIL FROM THE APP (Sky, 2026-09-30) ────────────────────────────────────
 * Until today this engine had no send capability on purpose ("a vendor hears from Tawny, not from an
 * app"). Sky reversed that, with the rule it protected kept intact: a PERSON still decides. The
 * route runs only from an editor's click on "Send to brand" after a confirmation naming the
 * recipient — never from a trigger, never on its own. It refuses a second send of the same program
 * to the same address unless `resend=1`, because writes ride on GET here and a pasted URL gets
 * re-fetched.
 *
 * WHO IT COMES FROM. The script runs as the deploying account (Sky), so the message goes out
 * "as" the Send-As alias in script property BRAND_EMAIL_FROM (Tawny's address), configured in that
 * account's Gmail. Replies and a blind copy go to the same address, so the thread lives in Tawny's
 * inbox. With the property unset or the alias missing, the route refuses — it never falls back to
 * sending from the account itself, which is the thing this was built to avoid.
 *
 * WHAT THE BRAND GETS is the brand page, not the staff record: no budtender names. That is the
 * document attached, and it is the same layout as the email body — one builder, brandPaperHtml_,
 * feeds the preview, the email and the PDF so they cannot disagree. The staff copy with names
 * stays in Drive via buildReport_. */
var BRAND_FROM_PROP = 'BRAND_EMAIL_FROM';
var BRAND_SENT_PREFIX = 'brandsent:';

function prettyDay_(ymd) {
  var m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return mons[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
}

function brandProgramLabel_(p) {
  var heading = String(p.program_name || p.title || '').trim();
  var vend = String(p.vendor || '').trim();
  return (!vend || heading.toLowerCase().indexOf(vend.toLowerCase()) === 0)
    ? (heading || vend) : (vend + ' · ' + heading);
}

/* ACTUAL UNIT LIFT (Sky, 2026-11-03): units sold during the program against the pre-program
   baseline, in units whatever the payout model. Returns null — and the caller prints NO line — unless
   both numbers are usable: `sold` must be a recorded/measured figure (null/''/NaN means "not
   known", never zero) and `before` must be above zero (a lift against nothing is not a lift). A drop
   is returned honestly, with a real minus sign. Mirrored by `unitLift` in spiff.js. */
function unitLiftOf_(sold, before) {
  if (sold == null || sold === '' || !isFinite(Number(sold))) return null;
  var s = Number(sold), b = Number(before);
  if (!(b > 0)) return null;
  var d = s - b, pct = Math.round((d / b) * 100);
  var sign = function (n) { return n > 0 ? '+' : (n < 0 ? '−' : ''); };
  var absU = Math.abs(d).toLocaleString();
  var verb = d > 0 ? 'up ' + absU : (d < 0 ? 'down ' + absU : 'no change');
  return { sold: s, before: b, delta: d, pct: pct,
           short: sign(d) + absU + ' units (' + sign(pct) + Math.abs(pct) + '%)',
           line: s.toLocaleString() + ' units sold, ' + verb + (d ? ' (' + sign(pct) + Math.abs(pct) + '%)' : '')
                 + ' from the period before.' };
}

/* The brand page as inline-styled HTML (email clients and the PDF converter both ignore a
   stylesheet). `opts.greeting` / `opts.closing` wrap it as an email; without them it is the
   document alone, which is what gets attached. */
function brandPaperHtml_(p, measured, opts) {
  opts = opts || {};
  var a = p.actual_json || {}, t = p.target_json || {}, base = p.baseline_json || {};
  var f = payoutFactsOf_(p);
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var FONT = 'font-family:Helvetica,Arial,sans-serif;';
  var INK = '#1a1f1d', MUTE = '#5a635f', LINE = '#d7dedb';

  var names = Object.create(null);
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { /* slugs are a poor label, not a blank one */ }

  var rows = (measured && measured.rows) || [];
  var sold   = Number(a.units_sold) || 0;
  var goal   = Number(t.units) || 0;
  var before = Number(base.units) || 0;
  var extra  = sold - before;
  var cost   = Number((p.cost_json || {}).per_unit) || 0;
  var added  = extra * cost;
  var owed   = f.owed;
  var net    = added - owed;
  var growth = before ? (extra >= 0 ? '+' : '') + Math.round((extra / before) * 100) + '%' : '—';

  var stores = (p.stores_json || []).map(function (s) {
    var key = slug_(s);
    var mine = rows.filter(function (r) { return slug_(r.store_id) === key; });
    var hit = mine.filter(function (r) { return r.hit || (f.per_unit && (Number(r.earned) || 0) > 0); }).length;
    return { name: names[key] || s, before: Number((base.by_store || {})[s]) || 0,
             goal: Number((t.by_store || {})[s]) || 0,
             sold: (measured && measured.by_store && measured.by_store[key] != null && measured.by_store[key] !== '' && isFinite(Number(measured.by_store[key])))
                     ? Number(measured.by_store[key]) : null,
             hit: mine.length ? hit : null };
  });
  var totalBts = stores.length * BTS_PER_STORE;
  var period = p.start_date ? prettyDay_(p.start_date) + ' – ' + prettyDay_(p.end_date || '') : 'the program period';
  var label = brandProgramLabel_(p);

  var stat = function (l, v, sub) {
    return '<td style="padding:0 18px 0 0;vertical-align:top">'
      + '<div style="' + FONT + 'font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:' + MUTE + '">' + esc(l) + '</div>'
      + '<div style="' + FONT + 'font-size:22px;font-weight:800;color:' + INK + '">' + esc(v) + '</div>'
      + '<div style="' + FONT + 'font-size:11px;color:' + MUTE + '">' + esc(sub) + '</div></td>';
  };
  var th = function (x, right) {
    return '<th style="' + FONT + 'text-align:' + (right ? 'right' : 'left') + ';padding:7px 9px;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:' + MUTE + ';border-bottom:1px solid ' + LINE + '">' + x + '</th>';
  };
  var td = function (x, right, bold, top) {
    return '<td style="' + FONT + 'text-align:' + (right ? 'right' : 'left') + ';padding:7px 9px;font-size:13px;color:' + INK
      + ';font-weight:' + (bold ? '700' : '400') + ';border-bottom:1px solid #eef2f0' + (top ? ';border-top:1px solid ' + INK : '') + '">' + x + '</td>';
  };
  var dash = '—';
  var body = stores.map(function (s) {
    return '<tr>' + td(esc(s.name)) + td(BTS_PER_STORE, true) + td(s.before.toLocaleString(), true)
      + td(s.goal.toLocaleString(), true) + td(s.sold == null ? dash : s.sold.toLocaleString(), true, true)
      + td(s.hit == null ? dash : s.hit + ' / ' + BTS_PER_STORE, true) + '</tr>';
  }).join('');
  var total = '<tr>' + td('Total', false, true, true) + td(totalBts, true, true, true)
    + td(before.toLocaleString(), true, true, true) + td(goal.toLocaleString(), true, true, true)
    + td(sold.toLocaleString(), true, true, true) + td(f.earners + ' / ' + totalBts, true, true, true) + '</tr>';

  var paper = '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid ' + INK + ';border-bottom:2px solid ' + INK + ';margin:14px 0">'
    + '<tr><td style="padding:14px 0"><img src="' + LOGO_ONLIGHT + '" alt="Green Cross" height="22" style="height:22px;width:auto;display:block;margin:0 0 10px">'
    +   '<div style="' + FONT + 'font-size:16px;font-weight:800;color:' + INK + '">' + esc(label) + ' — SPIFF results</div>'
    +   '<div style="' + FONT + 'font-size:12px;color:' + MUTE + '">Green Cross Cannabis Emporium · ' + esc(period) + '</div></td>'
    + '<td style="padding:14px 0;text-align:right;vertical-align:top">'
    +   '<div style="' + FONT + 'font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:' + MUTE + '">Credit requested</div>'
    +   '<div style="' + FONT + 'font-size:26px;font-weight:800;color:' + INK + '">' + esc(moneyStr_(owed)) + '</div></td></tr></table>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr>'
    +   stat('Units sold', sold.toLocaleString(), goal ? (sold - goal >= 0 ? '+' : '') + (sold - goal).toLocaleString() + ' vs. goal' : '')
    +   stat('Growth', growth, before ? 'vs. ' + before.toLocaleString() + ' before' : '')
    +   stat('Added sell-through', moneyStr_(added), extra.toLocaleString() + ' extra units')
    +   stat('Return on SPIFF', owed ? Math.round((net / owed) * 100) + '%' : dash, 'net ' + moneyStr_(net))
    + '</tr></table>'
    + (stores.length
        ? '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px"><tr>'
          + th('Store') + th('BTs', 1) + th('Before', 1) + th('Goal', 1) + th('Sold', 1) + th('Hit', 1) + '</tr>'
          + body + total + '</table>'
        : '');

  /* The lift line: chain total always (when usable), plus per-store only where that store has both a
     baseline and a measured figure. Store NAMES only — no budtender names reach this page. */
  var lift = unitLiftOf_(a.units_sold, base.units);
  var liftParts = lift ? stores.map(function (s) {
    var l = (s.sold == null) ? null : unitLiftOf_(s.sold, s.before);
    return l ? esc(s.name) + ' ' + esc(l.short) : '';
  }).filter(Boolean) : [];
  var liftHtml = lift
    ? '<p style="' + FONT + 'font-size:14px;font-weight:700;color:' + INK + ';margin:0 0 ' + (liftParts.length ? '4' : '16') + 'px">' + esc(lift.line) + '</p>'
      + (liftParts.length ? '<p style="' + FONT + 'font-size:12px;color:' + MUTE + ';margin:0 0 16px">By store: ' + liftParts.join(' · ') + '</p>' : '')
    : '';
  paper += liftHtml;

  var P = '<p style="' + FONT + 'font-size:14px;line-height:1.55;color:' + INK + ';margin:0 0 12px">';
  var html = opts.greeting === undefined
    ? '<div style="' + FONT + 'max-width:640px;color:' + INK + '">' + paper + '</div>'
    : '<div style="' + FONT + 'max-width:640px;color:' + INK + '">'
      + P + 'Hi' + (opts.greeting ? ' ' + esc(opts.greeting) : '') + ',</p>'
      + P + 'Here are the final numbers for the ' + esc(label) + ' SPIFF, ' + esc(period) + '. The full report is attached.</p>'
      + paper
      + P + 'Please apply ' + esc(moneyStr_(owed)) + ' as a credit against our next order.</p>'
      + P + 'Thanks for supporting the team —</p>'
      + brandSignatureHtml_() + '</div>';
  return html;
}

/* TAWNY'S OWN SIGNATURE, from her signature file (Tawny_Vierra_Signature.html in Drive, which Sky
   pointed at 2026-09-30): same logo, same layout, same LOCATIONS button image, same green link —
   minus the phone line, which Sky said to leave off. Earlier today this was hand-built from a
   screenshot and a guess at the stacked logo, and it squeezed the logo. Her title is Inventory Manager
   (Sky, 2026-09-30) — her signature FILE still says Regional Intake & Inventory Manager, which is out of date. The images are the company's own, hosted on Wix
   and already in use in her real emails. The email always goes out as her (BRAND_FROM_DEFAULT), so
   name and title are constants. */
var BRAND_SIGNER_NAME = 'Tawny Vierra';
var BRAND_SIGNER_TITLE = 'Inventory Manager';
var BRAND_SIG_LOGO = 'https://static.wixstatic.com/media/7dfb22_d10ced5eb2c24223a6391cd90c9254fb~mv2.png';
var BRAND_SIG_LOCATIONS = 'https://static.wixstatic.com/media/7dfb22_497f9b6a05c64362a1cad81812938380~mv2.png';

function brandSignatureHtml_() {
  var F = "font-family:'Lucida Grande','Lucida Sans Unicode',Helvetica,Arial,Sans-Serif;";
  var RULE = 'padding:0px;border-top:1px solid #CCCECE;margin:0 0 ';
  return '<table width="100%" border="0" cellspacing="1" cellpadding="0" style="max-width:420px"><tr><td width="100%">'
    + '<div style="' + RULE + '2px"></div></td></tr></table>'
    + '<table width="100%" border="0" cellspacing="1" cellpadding="6" style="max-width:500px"><tr>'
    +   '<td width="10%"><a href="https://greencrosscanna.com/" target="_blank"><img src="' + BRAND_SIG_LOGO + '" alt="Green Cross" width="125" style="float:left;padding:0px 10px 0px 0"></a></td>'
    +   '<td width="77%"><div style="line-height:16px;margin:3px 0;padding:0 10px 0 0;' + F + 'font-size:11px;color:#475660">'
    +     '<strong style="color:#231F20;padding-right:8px">' + BRAND_SIGNER_NAME + '</strong><br>' + BRAND_SIGNER_TITLE
    +   '</div></td></tr></table>'
    + '<table width="100%" border="0" cellspacing="1" cellpadding="4" style="max-width:420px"><tr><td width="100%">'
    +   '<div style="' + RULE + '10px"></div>'
    +   '<div style="float:left;margin:0;padding:8px 0 0 8px;' + F + 'font-size:10px;color:#019592"><a href="https://www.greencrosscanna.com/" style="color:#93d500;text-decoration:none"><b>GreenCrossCanna.com</b></a></div>'
    +   '<div style="float:right;margin:0;padding:0 10px 0 0;' + F + 'font-size:10px;color:#019592"><a href="https://www.greencrosscanna.com/#locations" target="_blank"><img src="' + BRAND_SIG_LOCATIONS + '" width="124" height="26" alt="Locations"></a></div>'
    + '</td></tr></table>';
}

/* The brand's copy of the report as a PDF — the paper above, nothing else. */
function brandPdfBlob_(p, measured) {
  var doc = '<html><head><meta charset="utf-8"></head><body style="margin:36px">'
    + brandPaperHtml_(p, measured) + '</body></html>';
  var stamp = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMddyy');
  var name = 'Green Cross SPIFF Results - ' + (p.vendor || p.title || 'Brand') + ' - ' + stamp + '.pdf';
  return Utilities.newBlob(doc, 'text/html', 'r.html').getAs('application/pdf').setName(name);
}

/* Tawny's address is the default (Sky, 2026-09-30); the BRAND_EMAIL_FROM script property overrides
   it without a deploy. It is an address, not a secret, so it lives in the repo. It is still only
   ever used as a Send-As alias — if Gmail does not know it, the send fails loudly. */
var BRAND_FROM_DEFAULT = 'tawny@greencrosscanna.com';

function brandFromAddress_() {
  return String(PropertiesService.getScriptProperties().getProperty(BRAND_FROM_PROP) || BRAND_FROM_DEFAULT).trim();
}

function sendBrandEmail_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0) return { ok: false, error: 'Your role cannot send reports' };

  var from = brandFromAddress_();
  if (!from) return { ok: false, error: 'Sending is not set up yet: the sender address (BRAND_EMAIL_FROM) is not configured.' };

  var to = String(p.to || '').trim().toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return { ok: false, error: 'Enter one valid email address to send to.' };
  var subject = String(p.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!subject) return { ok: false, error: 'The subject is empty.' };

  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another send is in progress. Try again in a moment.' };
  try {
    var props = PropertiesService.getScriptProperties();
    var key = BRAND_SENT_PREFIX + prog.program_id;
    var sent = {};
    try { sent = JSON.parse(props.getProperty(key) || '{}') || {}; } catch (e) { sent = {}; }
    if (sent[to] && String(p.resend) !== '1') {
      return { ok: false, already: true, sent_at: sent[to],
               error: 'Already sent to ' + to + ' on ' + String(sent[to]).slice(0, 10) + '. Send again only if you mean to.' };
    }

    var measured = measuredRowsFor_(prog);
    var pdf  = brandPdfBlob_(prog, measured);
    var html = brandPaperHtml_(prog, measured, { greeting: String(p.first_name || '').trim(), closing: 'Tawny' });
    var text = emailDraft_({ id: prog.program_id }).body;
    try {
      GmailApp.sendEmail(to, subject, text, {
        htmlBody: html, attachments: [pdf], from: from, replyTo: from, bcc: from,
        name: 'Green Cross Cannabis Emporium'
      });
    } catch (e) {
      return { ok: false, error: 'Could not send: ' + scrubSecrets_(e && e.message || e)
        + ' (the sender address must be a Send-As alias on the account this app runs as)' };
    }
    sent[to] = nowStamp_();
    props.setProperty(key, JSON.stringify(sent));
    return { ok: true, to: to, from: from, attachment: pdf.getName(), by: auth.user, sent_at: sent[to] };
  } finally {
    lock.releaseLock();
  }
}

/* ── THE MARKETING VENDOR PLAN AND THE TEAM EMAIL (SPIFF 2.0, phase 3) ───────────────────────────
 * Two routes, both an editor's click, neither on a trigger and neither on ENGINE_HEDGE_READS:
 *
 *   marketingOverview_  builds the vendor-facing plan in the brand page's styling. It returns the
 *                       HTML for a download and, with save=1, files a PDF in the SPIFF Reports folder
 *                       (REPORT_FOLDER_ID) and nowhere else. It SENDS NOTHING: a vendor only hears
 *                       from us through "Send to brand".
 *   marketingNotify_    emails the INTERNAL team through sendMail_. Dry by default (it returns the
 *                       draft for a confirmation); send=1 sends. A repeat is refused without
 *                       resend=1, because writes ride on GET and a URL gets re-fetched.
 *
 * WHAT THE VENDOR PLAN MAY HOLD. It is built from an allow-list of fields: the vendor's name, the
 * window, the stores, which add-ons were picked, their typed DATES and menu choices, and calendar
 * events. It never reads payout_json, cost_json, actual_json, target_json, progress or the roster,
 * so no budtender name, payout dollar or cost and margin figure can reach it. Free-text fields
 * (details, notes) are internal chatter and are left out too. tests/marketing_vendor_plan_test.js
 * runs this builder on a program stuffed with all of those and looks for them in the output.
 *
 * The menu ids below mirror marketing.js's ITEMS; the same test fails if the two drift apart. The
 * artwork sizes are the generic set Sky chose on 2026-11-02 (MKT_SIZES_): from those three families
 * the team can make just about any screen, post or print piece work. */
var MKT_SIZES_ = {
  screen: 'TV screens: 1920×1080 (HD) or 3840×2160 (4K), horizontal or vertical, as JPG/PNG images or MP4 video.',
  social: 'Social: 1080×1080 square, 1080×1350 portrait and 1080×1920 stories/reels, as JPG/PNG or MP4.',
  print:  'Print: 8.5×11 in, print-ready PDF.'
};
var MKT_NOTIFY_PROP = 'MARKETING_NOTIFY_TO';
var MKT_NOTIFY_DOMAIN = '@greencrosscanna.com';
var MKT_NOTIFIED_PREFIX = 'mktnotified:';

var MKT_MENU_ = {
  edu:      { t: 'Budtender education', need: 'A training video or talking points, and product samples for the team.', spec: 'Video link or file, plus a one-page product summary.' },
  shirts:   { t: 'Staff swag (shirts / hats)', need: 'Branded apparel for staff, with sizes confirmed.', spec: 'Logo files in vector form (EPS, AI or PDF).' },
  incentive:{ t: 'Budtender incentive', need: 'Written sign-off on the incentive structure.', spec: '' },
  prizes:   { t: 'Other employee prizes', need: 'The prize, and how it is won.', spec: '' },
  email:    { t: 'Email blast', need: 'Email creative and the offer, for our review.', spec: 'Web-ready image files (JPG or PNG) and the link they should point to.', dated: 'date', datedLabel: 'Email goes out' },
  sms:      { t: 'Text blast', need: 'Text copy, for our review and approval.', spec: 'Plain text only. Include the offer and any opt-out wording.', dated: 'date', datedLabel: 'Text goes out' },
  social:   { t: 'Social media', need: 'Your handles, tags and any media you want used.', spec: '1080×1080 square, 1080×1350 portrait or 1080×1920 stories/reels, as JPG/PNG or MP4, plus your preferred tags.', datedLabel: '' },
  ecom:     { t: 'Online menu feature', need: 'Product images and descriptions for the featured spot.', spec: 'Clean product images on a plain background.' },
  web:      { t: 'Deals page (website)', need: 'One featured image and the offer, for our deals page at greencrosscanna.com/deals.', spec: 'Featured image: 1200×1200 px square (1080 to 2400 accepted), JPG or PNG, 2 MB max, with text, prices and logos inside the center 1080×1080.' },
  vday:     { t: 'Vendor day', need: 'Your rep’s name, and the games or discounts you plan to run.', spec: '', dated: 'date', datedLabel: 'Vendor day' },
  raffle:   { t: 'Customer raffle', need: 'The prize. It cannot be cannabis.', spec: '', dated: 'date', datedLabel: 'Raffle drawing' },
  swag:     { t: 'Customer swag', need: 'Giveaway items, counted and shipped to us.', spec: '' },
  'case':   { t: 'Featured case', need: 'Display material for the featured case.', spec: '8.5×11 in print-ready PDF, or ship the physical display.' },
  signage:  { t: 'Signage & readerboard', need: 'Printed signage and readerboard copy.', spec: '8.5×11 in print-ready PDF.' },
  led:      { t: 'LED sign board', need: 'Artwork for the LED board.', spec: '1920×1080 or 3840×2160, horizontal or vertical, as JPG/PNG or MP4.' },
  counter:  { t: 'Countertop ads', need: 'Artwork for checkout and countertop ads.', spec: '8.5×11 in print-ready PDF.' },
  bags:     { t: 'Branded exit bags', need: 'Bags, counted, shipped to us.', spec: '' }
};

var MKT_OREGON_RULES_ = 'Everything we run follows Oregon rules: no buy-one-get-one offers, no tiered spend thresholds, '
  + 'no cannabis gift-with-purchase, no health claims, and nothing that appeals to minors.';

function mktEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function mktPickedIds_(plan) {
  var sel = (plan && plan.sel) || {};
  return Object.keys(MKT_MENU_).filter(function (id) { return id === 'incentive' || sel[id]; });
}

/* The facts the plan is made of, already stripped to the allow-list. Everything the vendor sees goes
   through here, so adding a field to the document starts with adding it to this list. */
function mktPlanFacts_(p) {
  var plan = normalizeMarketing_(p.marketing_json) || {};
  var names = Object.create(null);
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { /* slugs are a poor label, not a blank one */ }
  var storeIds = p.stores_json || [];   /* the program's own stores; no item-level picker (v2.000) */
  var ids = mktPickedIds_(plan);
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  /* Vendor days, each with its store; a plan saved before the list existed holds one in d.vday. */
  var oldDay = (plan.d && plan.d.vday) || {};
  var vdays = (plan.vdays && plan.vdays.length ? plan.vdays : (oldDay.date ? [{ store: '', date: oldDay.date, time: oldDay.time || '' }] : []))
    .filter(function (v) { return ids.indexOf('vday') >= 0 && ISO.test(String(v.date || '')); })
    .map(function (v) {
      return { name: 'Vendor day at ' + (v.store ? (names[slug_(v.store)] || v.store) : 'all stores'), date: v.date, time: v.time || '' };
    });
  var items = ids.map(function (id) {
    var m = MKT_MENU_[id], d = (plan.d && plan.d[id]) || {};
    /* Dates only from an item's list: sign and case text is internal and stays off the vendor plan. */
    var listDates = ((plan.rows && plan.rows[id]) || []).map(function (r) { return r.date; })
      .filter(function (x, i, a) { return ISO.test(String(x || '')) && a.indexOf(x) === i; }).sort();
    var daysLine = id === 'vday' && vdays.length
      ? vdays.map(function (v) { return prettyDay_(v.date) + ' ' + v.name.replace('Vendor day at ', '') + (v.time ? ' (' + v.time + ')' : ''); }).join('; ')
      : listDates.map(function (x) { return prettyDay_(x); }).join('; ');
    return { id: id, title: m.t, need: m.need, spec: m.spec,
             date: id !== 'vday' && m.dated && ISO.test(String(d[m.dated] || '')) ? d[m.dated] : '',
             days: daysLine,
             dateLabel: m.datedLabel || '',
             choice: [d.format, d.cost, d.maker].filter(function (x) { return x; }).join(', ') };
  });
  return {
    vendor: String(p.vendor || '').trim(),
    label: brandProgramLabel_(p),
    start: p.start_date || '', end: p.end_date || '',
    stores: storeIds.map(function (s) { return names[slug_(s)] || s; }),
    items: items,
    events: (plan.events || []).filter(function (e) { return e.date; })
      .map(function (e) { return { name: e.name, date: e.date, time: e.time }; }).concat(vdays)
  };
}

function marketingOverviewHtml_(p, opts) {
  opts = opts || {};
  var f = mktPlanFacts_(p), esc = mktEsc_;
  var FONT = 'font-family:Helvetica,Arial,sans-serif;';
  var INK = '#1a1f1d', MUTE = '#5a635f', LINE = '#d7dedb';
  var H = function (t) {
    return '<div style="' + FONT + 'font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:' + MUTE
      + ';border-bottom:1px solid ' + LINE + ';padding:0 0 5px;margin:20px 0 8px">' + esc(t) + '</div>';
  };
  var P = function (t) {
    return '<p style="' + FONT + 'font-size:13px;line-height:1.5;color:' + INK + ';margin:0 0 8px">' + t + '</p>';
  };
  var LI = function (t) { return '<li style="' + FONT + 'font-size:13px;line-height:1.5;color:' + INK + ';margin:0 0 4px">' + t + '</li>'; };
  var UL = function (rows) { return rows.length ? '<ul style="margin:0 0 8px;padding-left:20px">' + rows.join('') + '</ul>' : ''; };

  var period = f.start ? prettyDay_(f.start) + ' – ' + prettyDay_(f.end || '') : 'dates to be confirmed';

  /* Two weeks at a glance: the window's first fourteen days. */
  var glance = [];
  if (f.start) {
    var last = addDaysLocal_(f.start, 13);
    glance.push({ day: f.start, text: 'The program starts' });
    f.items.forEach(function (i) { if (i.date && i.date >= f.start && i.date <= last) glance.push({ day: i.date, text: i.dateLabel }); });
    f.events.forEach(function (e) { if (e.date >= f.start && e.date <= last) glance.push({ day: e.date, text: e.name + (e.time ? ' (' + e.time + ')' : '') }); });
    if (f.end && f.end <= last) glance.push({ day: f.end, text: 'The program ends' });
    glance.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
  }

  var needs = f.items.filter(function (i) { return i.need; });
  var specs = f.items.filter(function (i) { return i.spec; });

  var head = '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid ' + INK + ';border-bottom:2px solid ' + INK + ';margin:14px 0">'
    + '<tr><td style="padding:14px 0"><img src="' + LOGO_ONLIGHT + '" alt="Green Cross" height="22" style="height:22px;width:auto;display:block;margin:0 0 10px">'
    + '<div style="' + FONT + 'font-size:16px;font-weight:800;color:' + INK + '">' + esc(f.label) + ' — marketing plan</div>'
    + '<div style="' + FONT + 'font-size:12px;color:' + MUTE + '">Green Cross Cannabis Emporium · ' + esc(period) + '</div></td></tr></table>';

  var body =
    H('Your team and ours')
    + P('<b>' + esc(f.vendor || 'Your team') + '</b> — your rep is our main contact for everything below.')
    + P('<b>Green Cross:</b> Tawny (inventory and buying) and Mike (marketing).')
    + H('Your plan')
    + P(esc(period) + (f.stores.length ? ' · ' + esc(f.stores.join(', ')) : ''))
    + UL(f.items.map(function (i) {
        return LI('<b>' + esc(i.title) + '</b>' + (i.choice ? ' — ' + esc(i.choice) : '')
          + (i.date ? ' · ' + esc(prettyDay_(i.date)) : '') + (i.days ? ' · ' + esc(i.days) : ''));
      }))
    + H('Two weeks at a glance')
    + (glance.length ? UL(glance.map(function (g) { return LI('<b>' + esc(prettyDay_(g.day)) + '</b> — ' + esc(g.text)); }))
                     : P('Dates will be added as they are set.'))
    + H('What we need from you')
    + (needs.length ? UL(needs.map(function (i) { return LI('<b>' + esc(i.title) + ':</b> ' + esc(i.need)); }))
                    : P('Nothing yet.'))
    + H('Incentive options')
    + P('We can reward our budtenders for hitting a goal on your product. Two common ways: a set amount for each '
        + 'budtender who reaches their goal, or an amount for every unit sold. We will confirm the structure with you in writing before staff hear about it.')
    + H('Artwork specs')
    + P('Standard sizes we work from:')
    + UL([MKT_SIZES_.screen, MKT_SIZES_.social, MKT_SIZES_.print].map(function (s) { return LI(esc(s)); }))
    + (specs.length ? UL(specs.map(function (i) { return LI('<b>' + esc(i.title) + ':</b> ' + esc(i.spec)); })) : '')
    + P(esc(MKT_OREGON_RULES_) + ' We review all copy and artwork before it runs.');

  return '<div style="' + FONT + 'max-width:640px;color:' + INK + '">' + head + body
    + P('<span style="color:' + MUTE + ';font-size:11px">Prepared ' + esc(today_()) + '.</span>') + '</div>';
}

/* ── TEXT BLAST PRICING ──────────────────────────────────────────────────────────────────────────
 * What one SMS send costs the vendor (Sky, 2026-11-03): opted-in phones × Dutchie's per-message rate,
 * a pass-through at Dutchie's cost added to the vendor's credit. Three numbers and the day the count
 * was taken, as SETTINGS rather than constants, because the count moves every month (Dutchie's "SMS
 * opted in" segment, logged in claude/status/sms-optout-log.md). Script properties: four short values,
 * nowhere near the 9 KB per-value cap, and no tab for a table of one row.
 *
 * Unset reads as null, never 0: "nobody has entered the list size" is a different fact from "the list
 * is empty", and a card that said "$0 per text" would be quoted to a vendor. Nothing that pays,
 * publishes or feeds a kiosk reads these. */
var SMS_PRICING_PROPS_ = { count: 'SMS_LIST_COUNT', rate_text: 'SMS_RATE_TEXT', rate_image: 'SMS_RATE_IMAGE', as_of: 'SMS_LIST_AS_OF' };

function smsPricingRead_() {
  var props = PropertiesService.getScriptProperties();
  function num(k) {
    var v = props.getProperty(SMS_PRICING_PROPS_[k]);
    var n = v == null || v === '' ? NaN : Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  return { ok: true, pricing: { count: num('count'), rate_text: num('rate_text'), rate_image: num('rate_image'),
           as_of: String(props.getProperty(SMS_PRICING_PROPS_.as_of) || '') } };
}

/* Editors only. Every field is sent every time; a blank clears that setting. The list size is whole
   phones and the rates are dollars per message, bounded so a typo (3 for 0.03) is refused rather than
   quoted to a vendor as $15,000 a text. */
function saveSmsPricing_(p) {
  var who = mktEditor_(p, 'change text blast pricing');
  if (who.fail) return who.fail;
  function parse(v, isCount) {
    var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (!s) return { blank: true };
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return { bad: true };
    if (isCount ? (n !== Math.floor(n) || n > 1000000) : n > 1) return { bad: true };
    return { n: n };
  }
  var count = parse(p.count, true), rt = parse(p.rate_text), ri = parse(p.rate_image);
  if (count.bad) return { ok: false, error: 'The list size must be a whole number of phones.' };
  if (rt.bad || ri.bad) return { ok: false, error: 'A rate is dollars per message, e.g. 0.03.' };
  var asOf = String(p.as_of || '').trim();
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { ok: false, error: 'The count date must be YYYY-MM-DD.' };
  var props = PropertiesService.getScriptProperties();
  function put(key, parsed) {
    if (parsed.blank) props.deleteProperty(key); else props.setProperty(key, String(parsed.n));
  }
  put(SMS_PRICING_PROPS_.count, count);
  put(SMS_PRICING_PROPS_.rate_text, rt);
  put(SMS_PRICING_PROPS_.rate_image, ri);
  if (asOf) props.setProperty(SMS_PRICING_PROPS_.as_of, asOf); else props.deleteProperty(SMS_PRICING_PROPS_.as_of);
  return smsPricingRead_();
}

/* ── STAFF SWAG SIZES ────────────────────────────────────────────────────────────────────────────
 * The Staff swag card says how many of each shirt size to order (Sky's to-do, 2026-11-04: "6 M,
 * 10 L"). GX Crew owns shirt_size; it publishes COUNTS per store to GX Core and SPIFF reads Core,
 * never Crew (cross-app data goes through Core). Requested from core-admin and crew 2026-11-04 as
 * GXCore.publishedCrewSwagSizes(secret) -> { ok, payload, published_at, age_minutes }.
 *
 * Until that function exists in the pinned GXCore the route answers `connected: false` and the card
 * says so; nothing throws. Sizes are staff data: a signed-in session is required, the answer is
 * rebuilt from a list of what may pass (store ids, size names, whole counts), so a name or id that
 * reached the payload by mistake is never relayed, and no vendor-facing page calls this. Nothing
 * that pays, publishes or feeds a kiosk reads it. Cached 15 minutes. */
var SWAG_SIZES_CACHE_KEY_ = 'swagSizes:v1';

function swagCounts_(c) {
  var out = {};
  if (!c || typeof c !== 'object') return out;
  Object.keys(c).forEach(function (k) {
    var key = String(k).trim().toUpperCase();
    var n = Number(c[k]);
    if (/^[0-9]?X{0,3}[SML]$|^ONE SIZE$/.test(key) && isFinite(n) && n > 0) out[key] = Math.floor(n);
  });
  return out;
}
function swagWhole_(v) { var n = Number(v); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }
function swagGroup_(g) {
  g = g || {};
  return { shirt: swagCounts_(g.shirt), hat: swagCounts_(g.hat), not_set: swagWhole_(g.not_set), active: swagWhole_(g.active) };
}
function swagSizesClean_(env) {
  var pl = env && env.payload;
  if (typeof pl === 'string') { try { pl = JSON.parse(pl); } catch (e) { pl = null; } }
  if (!pl || typeof pl !== 'object') return null;
  var by = {};
  Object.keys(pl.by_store || {}).forEach(function (s) {
    if (/^[a-z0-9-]{1,40}$/.test(s)) by[s] = swagGroup_(pl.by_store[s]);
  });
  var sizes = (Array.isArray(pl.sizes) ? pl.sizes : []).map(function (x) { return String(x).trim().toUpperCase(); })
    .filter(function (x) { return /^[0-9]?X{0,3}[SML]$/.test(x); });
  var age = Number(env.age_minutes);
  return { sizes: sizes, by_store: by, total: swagGroup_(pl.total),
           as_of: /^\d{4}-\d{2}-\d{2}$/.test(String(pl.as_of || '')) ? String(pl.as_of) : '',
           age_minutes: isFinite(age) ? Math.round(age) : null };
}

function swagSizes_(p) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { ok: false, error: auth.error || 'Not signed in', needsAuth: true };
  var cache = CacheService.getScriptCache();
  var hit = cache.get(SWAG_SIZES_CACHE_KEY_);
  if (hit && !p.force) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  var out;
  if (typeof GXCore === 'undefined' || !GXCore || typeof GXCore.publishedCrewSwagSizes !== 'function') {
    out = { ok: true, connected: false, sizes: null };
  } else {
    var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
    var env;
    try { env = GXCore.publishedCrewSwagSizes(secret); } catch (e) { env = { ok: false, error: String(e && e.message || e) }; }
    if (!env || env.ok === false) return { ok: false, error: 'Could not read staff sizes from GX Core: ' + ((env && env.error) || 'no answer') };
    out = { ok: true, connected: true, sizes: swagSizesClean_(env) };
  }
  try { cache.put(SWAG_SIZES_CACHE_KEY_, JSON.stringify(out), 900); } catch (e) { /* too big to cache is fine */ }
  return out;
}

function mktEditor_(p, verb) {
  var auth = gxAuth_(p.token);
  if (!auth.ok) return { fail: { ok: false, error: auth.error || 'Not signed in', needsAuth: true } };
  var coreSaysEdit = false;
  try { coreSaysEdit = GXCore.roleCanEdit(auth.role) === true; } catch (e) { coreSaysEdit = false; }
  if (EDIT_ROLES.indexOf(String(auth.role)) < 0 || !coreSaysEdit) {
    return { fail: { ok: false, error: 'Your role (' + auth.role + ') cannot ' + verb } };
  }
  return { auth: auth };
}

function marketingOverview_(p) {
  var who = mktEditor_(p, 'build marketing plans');
  if (who.fail) return who.fail;
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;
  var html = marketingOverviewHtml_(prog);
  var stamp = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMddyy');
  var name = 'Green Cross Marketing Plan - ' + (prog.vendor || prog.title || 'Brand') + ' - ' + stamp + '.pdf';
  var out = { ok: true, name: name, html: html, by: who.auth.user };
  if (String(p.save) === '1') {
    /* Into the program's own vendor files folder when one is linked (Sky, 2026-11-02), else SPIFF Reports. */
    var vendorFolder = mktVendorFolderId_(prog);
    try {
      var doc = '<html><head><meta charset="utf-8"></head><body style="margin:36px">' + html + '</body></html>';
      var blob = Utilities.newBlob(doc, 'text/html', 'p.html').getAs('application/pdf').setName(name);
      var file = DriveApp.getFolderById(vendorFolder || REPORT_FOLDER_ID).createFile(blob);
      out.saved = true; out.file_id = file.getId(); out.url = file.getUrl();
      out.folder = vendorFolder ? 'vendor' : 'reports';
    } catch (e) {
      return { ok: false, error: 'Could not write to the ' + (vendorFolder ? 'vendor files' : 'reports') + ' folder: '
        + scrubSecrets_(e && e.message || e) };
    }
  }
  return out;
}

/* ── ONE UPLOAD FOLDER PER VENDOR ──────────────────────────────────────────────────────────────
 * Sky, 2026-11-02: each vendor gets a folder under Marketing ▸ Vendors (a shared drive), shared so
 * anyone with the link can add files, and that link sits on the vendor's programs so the plan is
 * saved there and the rep can be sent it. A new program makes its vendor's folder if there is none;
 * ?action=vendorFolders (secret, dry by default) does the same for every vendor already known.
 *
 * Found by NAME, folded (case and punctuation ignored), so "National Cannabis Co." and "National
 * Cannabis Co" are one folder. "Anyone with the link can edit" on a shared drive is the Contributor
 * role: add and edit, not delete. The vendors' link gives them their own folder and nothing else. */
var VENDOR_FOLDERS_PARENT = '13BwoZ6Brt0d-vM-Z-ca_KSIMPyCG6eaW';

function vendorFold_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/* Returns {id, url, name, created, shared} or null for a blank vendor. With make=false it never
   creates or changes anything, and reports what it would do. */
function vendorFolderFor_(vendor, make) {
  var name = String(vendor || '').trim().replace(/[.\s]+$/, '');
  if (!vendorFold_(name)) return null;
  var parent = DriveApp.getFolderById(VENDOR_FOLDERS_PARENT), it = parent.getFolders(), hit = null;
  while (it.hasNext()) {
    var f = it.next();
    if (vendorFold_(f.getName()) === vendorFold_(name)) { hit = f; break; }
  }
  var out = { name: hit ? hit.getName() : name, created: false, shared: false };
  if (!hit) {
    if (!make) return Object.assign(out, { id: '', url: '', created: true, shared: true, dry: true });
    hit = parent.createFolder(name);
    out.created = true;
  }
  out.id = hit.getId();
  if (!anyoneCanAdd_(out.id)) {
    if (make) shareAnyoneCanAdd_(out.id);
    out.shared = true;
  }
  out.url = 'https://drive.google.com/drive/folders/' + out.id;
  return out;
}

/* Sharing goes through the Drive REST API, not DriveApp: DriveApp.setSharing answers "Access
   denied" on a shared-drive item (measured 2026-11-02, every folder refused), while the API with
   supportsAllDrives does it under the drive scope the engine already holds. */
var DRIVE_PERMS_URL_ = 'https://www.googleapis.com/drive/v3/files/';
function driveApi_(method, path, body) {
  var res = UrlFetchApp.fetch(DRIVE_PERMS_URL_ + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: body ? JSON.stringify(body) : undefined
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Drive said ' + code + ': ' + String(text).slice(0, 200));
  return text ? JSON.parse(text) : {};
}
function anyoneCanAdd_(id) {
  var r = driveApi_('get', id + '/permissions?supportsAllDrives=true&fields=permissions(type,role)');
  return (r.permissions || []).some(function (x) {
    return x.type === 'anyone' && ['writer', 'fileOrganizer', 'organizer'].indexOf(x.role) >= 0;
  });
}
function shareAnyoneCanAdd_(id) {
  driveApi_('post', id + '/permissions?supportsAllDrives=true',
            { type: 'anyone', role: 'writer', allowFileDiscovery: false });
}

/* The plan with its vendor files link set, unless one is set already. */
function withVendorFolder_(plan, url) {
  var m = JSON.parse(JSON.stringify(plan || {}));
  m.d = m.d && typeof m.d === 'object' ? m.d : {};
  if (m.d.files && m.d.files.url) return null;
  m.d.files = { url: url };
  return normalizeMarketing_(m);
}

/* Every vendor SPIFF knows (its programs and GX Core's brand list), each given a folder; programs
   that are not closed get the link. Closed programs are left as they were reported. */
function vendorFoldersRun_(apply) {
  var skip = Object.create(null);
  skip[vendorFold_('Green Cross')] = true;
  /* A store's old name, filed as the vendor on its own 2026-08 fortnight; the live store list no
     longer carries it, so it is named here. */
  skip[vendorFold_('Portland Heights')] = true;
  try { (gxStores_() || []).forEach(function (s) { skip[vendorFold_(s.display_name)] = true; skip[vendorFold_(s.store_id)] = true; }); }
  catch (e) { /* a store name slipping through costs one empty folder */ }
  var names = Object.create(null), order = [];
  var add = function (n) {
    var k = vendorFold_(n);
    if (!k || skip[k] || names[k]) return;
    names[k] = String(n).trim().replace(/[.\s]+$/, '');
    order.push(k);
  };
  var programs = listPrograms_();
  programs.forEach(function (p) { add(p.vendor); });
  var br = brandsRead_({});
  if (br.ok) (br.brands || []).forEach(function (b) {
    if (b && b.active !== false && String(b.active).toLowerCase() !== 'false') add(b.display_name || b.brand_id);
  });

  var folders = [], linked = [], errors = [];
  order.forEach(function (k) {
    try { folders.push(vendorFolderFor_(names[k], apply)); }
    catch (e) { errors.push(names[k] + ': ' + scrubSecrets_(e && e.message || e)); }
  });
  var byName = Object.create(null);
  folders.forEach(function (f) { if (f) byName[vendorFold_(f.name)] = f; });
  programs.forEach(function (p) {
    if (p.status === 'closed') return;
    var f = byName[vendorFold_(String(p.vendor || '').trim().replace(/[.\s]+$/, ''))];
    if (!f) return;
    var plan = withVendorFolder_(p.marketing_json, f.url || '(new folder)');
    if (!plan) return;
    linked.push(p.program_id);
    if (apply && f.url) {
      var cur = getProgram_(p.program_id);
      if (!cur.ok) return;
      var fresh = withVendorFolder_(cur.program.marketing_json, f.url);
      if (!fresh) return;
      cur.program.marketing_json = fresh;
      var r = saveProgram_(cur.program, { editedBy: 'vendor-folders', confirmBrand: true });
      if (!r.ok) errors.push(p.program_id + ': ' + r.error);
    }
  });
  return { ok: !errors.length, dry: !apply, brands_read: br.ok,
           folders: folders.filter(Boolean).map(function (f) { return { name: f.name, url: f.url, created: f.created, shared: f.shared }; }),
           linked: linked, errors: errors };
}

/* The folder id in the program's vendor files link (d.files.url), or '' when there is none. */
function mktVendorFolderId_(prog) {
  var plan = normalizeMarketing_(prog && prog.marketing_json) || {};
  var url = String(((plan.d || {}).files || {}).url || '');
  var m = url.match(/^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : '';
}

/* The internal recipients, or a refusal that says what to set. Nothing is hardcoded: a team address
   in the code would be a person's inbox decided by whoever last edited this file. Every address must
   be a Green Cross one, so a typo in the property can never point this at a vendor. */
function mktRecipients_() {
  var raw = String(PropertiesService.getScriptProperties().getProperty(MKT_NOTIFY_PROP) || '');
  var list = raw.split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  if (!list.length) {
    return { error: 'The team email is not set up yet: set the script property ' + MKT_NOTIFY_PROP
      + ' to the internal address(es) that should get it.' };
  }
  var bad = list.filter(function (a) {
    return !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(a) || a.slice(-MKT_NOTIFY_DOMAIN.length) !== MKT_NOTIFY_DOMAIN;
  });
  if (bad.length) {
    return { error: MKT_NOTIFY_PROP + ' holds an address that is not a ' + MKT_NOTIFY_DOMAIN + ' one (' + bad.join(', ')
      + '). The team email goes to Green Cross addresses only.' };
  }
  return { to: list };
}

function marketingNotify_(p) {
  var who = mktEditor_(p, 'email the marketing team');
  if (who.fail) return who.fail;
  var kind = String(p.kind || 'plan');
  if (kind !== 'plan' && kind !== 'summary') return { ok: false, error: 'Unknown kind: ' + kind };
  var rcpt = mktRecipients_();
  if (rcpt.error) return { ok: false, error: rcpt.error };

  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program;
  var f = mktPlanFacts_(prog);
  var period = f.start ? prettyDay_(f.start) + ' – ' + prettyDay_(f.end || '') : 'dates not set';
  var subject = (kind === 'plan' ? 'Marketing plan ready for review — ' : 'Marketing summary — ') + f.label;
  var lines = [
    kind === 'plan' ? 'The marketing plan for ' + f.label + ' is ready for review.' : 'Where the marketing for ' + f.label + ' stands.',
    '', 'Window : ' + period,
    'Stores : ' + (f.stores.join(', ') || '(program stores)'),
    'Signed up for:'
  ].concat(f.items.map(function (i) { return '  - ' + i.title + (i.date ? ' (' + i.date + ')' : ''); }))
   .concat(['', 'Sent from SPIFF by ' + who.auth.user + ' on ' + nowStamp_() + '.']);
  var body = lines.join('\n');

  if (String(p.send) !== '1') {
    return { ok: true, preview: true, to: rcpt.to, subject: subject, body: body, kind: kind };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another send is in progress. Try again in a moment.' };
  try {
    var props = PropertiesService.getScriptProperties();
    var key = MKT_NOTIFIED_PREFIX + prog.program_id + ':' + kind;
    var before = props.getProperty(key);
    if (before && String(p.resend) !== '1') {
      return { ok: false, already: true, sent_at: before,
               error: 'The team was already emailed this on ' + String(before).slice(0, 10) + '. Send again only if you mean to.' };
    }
    try {
      sendMail_({ to: rcpt.to.join(','), subject: subject, body: body, name: 'Green Cross SPIFF' });
    } catch (e) {
      return { ok: false, error: 'Could not send: ' + scrubSecrets_(e && e.message || e) };
    }
    var stamp = nowStamp_();
    props.setProperty(key, stamp);
    return { ok: true, sent: true, to: rcpt.to, subject: subject, sent_at: stamp, by: who.auth.user };
  } finally {
    lock.releaseLock();
  }
}

/* ── A TASK HANDED TO SOMEONE ─────────────────────────────────────────────────────────────────
 * The screen saves the new owner through editProgram, then calls this. It emails that person only
 * when the STORED owner of the task is them, and only once per hand-off: the last person told is
 * kept per program and task, so a re-fetched URL sends nothing, and handing it A → B → A tells A
 * again. Nobody is emailed about a task they handed to themselves. The addresses are fixed here,
 * never taken from the request, so this can only ever reach these three. */
var MKT_PEOPLE_ = { tawny: 'tawny@greencrosscanna.com', mike: 'mike@greencrosscanna.com', sky: 'sky@greencrosscanna.com' };
var MKT_ASSIGNED_PREFIX = 'mktassigned:';
var MKT_APP_URL = 'https://greencrosscanna.github.io/greencross-spiff/';

function marketingAssign_(p) {
  var who = mktEditor_(p, 'assign marketing tasks');
  if (who.fail) return who.fail;
  var person = String(p.person || '').toLowerCase(), task = String(p.task || '');
  if (!Object.prototype.hasOwnProperty.call(MKT_PEOPLE_, person)) return { ok: false, error: 'Unknown person: ' + person };
  if (!/^[a-z][a-z0-9_.-]{0,80}$/.test(task)) return { ok: false, error: 'Unknown task' };
  /* A holiday send keeps its hand-offs the same way, in its own tab (see HOLIDAY SENDS). */
  var holiday = String(p.kind || '') === 'holiday';
  var res = holiday ? getHoliday_(p.id) : getProgram_(p.id);
  if (!res.ok) return res;
  var prog = holiday ? res.holiday : res.program;
  var plan = normalizeMarketing_(prog.marketing_json) || {};
  if (((plan.own || {})[task] || '') !== person) {
    return { ok: false, error: 'That task is not assigned to ' + person + ' in what is saved.' };
  }
  if (String(who.auth.user || '').toLowerCase() === person) return { ok: true, sent: false, why: 'self' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another send is in progress. Try again in a moment.' };
  try {
    var props = PropertiesService.getScriptProperties();
    var key = MKT_ASSIGNED_PREFIX + (holiday ? prog.holiday_id : prog.program_id) + ':' + task;
    if (props.getProperty(key) === person) return { ok: true, sent: false, why: 'already told' };
    var label = holiday ? 'Holiday send: ' + prog.name + ' (' + prettyDay_(prog.send_date) + ')' : brandProgramLabel_(prog);
    var text = String(p.text || '').trim().slice(0, 200) || task;
    var item = String(p.item || '').trim().slice(0, 80);
    var due = /^\d{4}-\d{2}-\d{2}$/.test(String(p.due || '')) ? prettyDay_(p.due) : 'no date yet';
    var to = MKT_PEOPLE_[person];
    var body = [
      who.auth.user + ' assigned you a marketing task in SPIFF.', '',
      'Task    : ' + text + (item ? ' (' + item + ')' : ''),
      'Program : ' + label,
      'Due     : ' + due, '',
      'Open SPIFF: ' + MKT_APP_URL
    ].join('\n');
    try {
      sendMail_({ to: to, subject: 'Assigned to you: ' + text + ' — ' + label, body: body, name: 'Green Cross SPIFF' });
    } catch (e) {
      return { ok: false, error: 'Could not send: ' + scrubSecrets_(e && e.message || e) };
    }
    props.setProperty(key, person);
    return { ok: true, sent: true, to: to };
  } finally {
    lock.releaseLock();
  }
}

/* Who gets a gift card, and for how much. Needs per-budtender sell-through, so for
   aggregate-only historical programs it reports the total and says what is missing
   rather than inventing a split. */
/* ── THE GIFT-CARD BUY LIST ───────────────────────────────────────────────────────────────────
 * This returned `lines: []` with a note saying per-budtender names "require sell-through detail
 * (Progress)". That detail has existed since 2026-08-27 — it is on the program's own frozen
 * snapshot and in the spiff_progress cache — and the list was simply never wired to it. So the
 * one output whose entire job is "who do we buy a gift card for, and for how much" named nobody,
 * and its total used the flat formula on a per-unit program besides (see payoutFactsOf_).
 *
 * NAMES COME FROM THE FROZEN SNAPSHOT FIRST. A closed program was measured once, when it stopped
 * moving, and that is the measurement the vendor was invoiced against — re-deriving the list from
 * today's cache could hand a different set of people a different set of amounts than the report
 * already sent. The live cache is the fallback for a program with no snapshot yet.
 *
 * IT LISTS WHO EARNED, not who sold. On a flat program that is whoever cleared their target; on
 * per-unit it is everyone with a unit, because there is no target to clear. `earned` on the row
 * is already computed per person by the measurement, so this sums rather than re-deriving.
 */
function giftCardList_(p) {
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  return giftCardListFor_(res.program);
}

/* The list itself, for a program already in hand — so the email to Mike and the Reports panel
   are the same calculation, not two. */
function giftCardListFor_(prog) {
  var f = payoutFactsOf_(prog);

  /* Through measuredRowsFor_ — the same source selection the vendor PDF uses, so a buy list and
     the report sent alongside it can never name different people or different amounts. */
  var measured = measuredRowsFor_(prog);
  var people = measured.rows
    .filter(function (r) { return (Number(r.earned) || 0) > 0; })   // who EARNED, not who sold
    .map(function (r) {
      return { name: r.name, legal_name: r.legal_name, store: r.store_id,
               units: r.units, amount: Number(r.earned) || 0 };
    });
  /* Biggest first — it is a shopping list, and the amounts are what someone loads onto cards. */
  people.sort(function (x, y) { return y.amount - x.amount || String(x.name).localeCompare(String(y.name)); });
  var listed = people.reduce(function (n, x) { return n + x.amount; }, 0);

  return {
    ok: true,
    program: prog.program_name || prog.title,
    vendor: prog.vendor || '',
    per_unit: f.per_unit, rate: f.rate,
    count: people.length,
    /* The AUTHORITATIVE total stays the record's — the same figure the vendor is invoiced. */
    total: f.owed,
    listed_total: Math.round(listed * 100) / 100,
    lines: people,
    source: measured.source || 'no measurements found',
    /* SAY SO WHEN THE LIST DOES NOT ADD UP TO THE TOTAL, rather than letting someone buy cards
       against one number and bill the vendor another. A gap means the measurement behind the list
       is not the one the record was reconciled from. */
    warning: (!people.length && f.owed > 0)
      ? 'This program owes ' + moneyStr_(f.owed) + ' but no per-person measurement was found, so '
        + 'nobody can be named. Re-measure the program before buying cards.'
      : (people.length && Math.round(listed * 100) !== Math.round(f.owed * 100)
          ? 'The names below add up to ' + moneyStr_(listed) + ', but the record says '
            + moneyStr_(f.owed) + '. Reconcile before buying cards.'
          : undefined)
  };
}


/* ═════════ THE GIFT-CARD ORDER EMAIL TO MIKE ═════════════════════════════════════════════════════
 * Sky, 2026-11-03: when a program closes, Mike gets the buy list so he does not have to be told by
 * hand. Sky's timing: NOT the moment it closes — by noon (LA) on the first Monday after the end
 * date, "that way any last minute fixes can be made".
 *
 *  - SAME NUMBERS AS REPORTS: the lines and totals come from giftCardListFor_, the builder behind
 *    the Reports panel's buy list. There is no second calculation here.
 *  - ONCE PER PROGRAM: the `giftmail:<program_id>` script property, set only after a send succeeds
 *    (the `mktassigned:` pattern). The hourly job and the route both honor it; only force=1 resends.
 *  - ONLY ONCE ACTUALS ARE RECORDED, and never on zero units. The recorder never records a partial
 *    or zero measurement, so a program stuck there stays quiet until a person fixes it.
 *  - GIFTMAIL_FROM: programs that ended before this day are never mailed, so turning this on does
 *    not email Mike about every program closed in the past.
 *  - Internal mail, sent as the script account. Mike's address is the fixed MKT_PEOPLE_ entry, never
 *    taken from a request. This is not the vendor path (sendBrandEmail_ is untouched).
 *  - Nothing that pays reads or writes anything here but the one property. */
var GIFTMAIL_PREFIX = 'giftmail:';
var GIFTMAIL_FROM = '2026-11-01';

/* First Monday strictly after the end date, as YYYY-MM-DD. Pure text/UTC math, no timezone drift. */
function giftMailDueDay_(endYmd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(endYmd || ''));
  if (!m) return '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  return d.toISOString().slice(0, 10);
}

/* Has noon LA on the due Monday arrived? `now` is injectable for tests. */
function giftMailIsDue_(endYmd, now) {
  var due = giftMailDueDay_(endYmd);
  if (!due) return false;
  var stamp = Utilities.formatDate(now || new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH');
  var day = stamp.slice(0, 10), hour = Number(stamp.slice(11, 13));
  return day > due || (day === due && hour >= 12);
}

/* Copied on every gift-card email (Sky, 2026-11-03): Tawny, Shawn and Sky. Fixed here, never taken
   from a request. */
var GIFTMAIL_CC = 'tawny@greencrosscanna.com,shawn@greencrosscanna.com,sky@greencrosscanna.com';

/* The same list as giftMailText_, in the Ops Board look (black band, green accent, square blocks).
   Inline styles only: email clients ignore stylesheets. Everyone is listed, because this is an
   order sheet. */
function giftMailHtml_(prog, list) {
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var names = {};
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { names = {}; }
  var pretty = function (s) {
    return names[slug_(s)] || String(s).split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  };
  var byStore = {}, order = [];
  list.lines.forEach(function (x) {
    var s = x.store || 'unknown';
    if (!byStore[s]) { byStore[s] = []; order.push(s); }
    byStore[s].push(x);
  });
  order.sort();
  var DISPLAY = "font-family:'Archivo Black','Arial Black',Arial,sans-serif;";
  var LINE = 'border-bottom:1px solid #d5d9d2;';
  var rows = order.map(function (s) {
    var sub = byStore[s].reduce(function (n, x) { return n + x.amount; }, 0);
    var h = '<tr><td colspan="2" style="padding:18px 0 6px;font-weight:700;">' + esc(pretty(s))
      + ' <span style="color:#5b636b;font-weight:500;font-size:12px;">· ' + byStore[s].length + ' card'
      + (byStore[s].length === 1 ? '' : 's') + ' · ' + esc(moneyStr_(sub)) + '</span></td></tr>';
    byStore[s].forEach(function (x) {
      h += '<tr><td style="padding:6px 0;' + LINE + '">' + esc(x.name) + '</td>'
        + '<td align="right" style="padding:6px 0;' + LINE + '">' + esc(moneyStr_(x.amount)) + '</td></tr>';
    });
    return h;
  }).join('');
  var closed = prog.end_date ? 'Program closed ' + esc(prettyDay_(prog.end_date)) + '. ' : '';
  return '<!doctype html><html><head><meta charset="utf-8"></head>'
    + '<body style="margin:0;padding:0;background:#eef0ec;font-family:\'Work Sans\',Helvetica,Arial,sans-serif;color:#090d11;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0ec;"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">'
    + '<tr><td style="background:#090d11;padding:18px 24px;"><span style="' + DISPLAY + 'font-size:20px;letter-spacing:1px;color:#ffffff;">'
    + '<span style="color:#95c93d;">GREEN</span>CROSS</span>'
    + '<span style="font-size:11px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:#ffffff;margin-left:12px;">SPIFF</span></td></tr>'
    + '<tr><td style="background:#090d11;padding:6px 24px 24px;"><div style="' + DISPLAY + 'font-size:28px;line-height:1.05;color:#ffffff;">Gift cards to order: <span style="color:#95c93d;">'
    + esc(brandProgramLabel_(prog)) + '</span></div>'
    + '<div style="font-size:14px;color:#ffffff;padding-top:10px;">' + closed + 'Results are final. Order these for the budtenders who hit their number.</div></td></tr>'
    + '<tr><td style="background:#ffffff;padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td width="50%" style="padding:20px 24px;' + LINE + 'border-right:1px solid #d5d9d2;"><div style="' + DISPLAY + 'font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#5b636b;">Cards to order</div>'
    + '<div style="' + DISPLAY + 'font-size:36px;line-height:1.1;padding-top:4px;">' + list.count + '</div></td>'
    + '<td width="50%" style="padding:20px 24px;' + LINE + 'background:#95c93d;"><div style="' + DISPLAY + 'font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#090d11;">Total to load</div>'
    + '<div style="' + DISPLAY + 'font-size:36px;line-height:1.1;padding-top:4px;color:#090d11;">' + esc(moneyStr_(list.total)) + '</div></td></tr></table></td></tr>'
    + (list.warning ? '<tr><td style="background:#fdf1d8;border-left:6px solid #8a5a00;padding:12px 18px;font-size:13px;"><b>Check before buying:</b> ' + esc(list.warning) + '</td></tr>' : '')
    + '<tr><td style="background:#ffffff;padding:20px 24px 4px;"><div style="' + DISPLAY + 'font-size:16px;letter-spacing:1.2px;text-transform:uppercase;border-bottom:2px solid #090d11;padding-bottom:6px;">By store</div></td></tr>'
    + '<tr><td style="background:#ffffff;padding:0 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">' + rows + '</table></td></tr>'
    + '<tr><td style="background:#ffffff;padding:16px 24px 28px;"><a href="' + MKT_APP_URL + '" style="display:inline-block;background:#090d11;color:#ffffff;text-decoration:none;'
    + DISPLAY + 'font-size:12px;letter-spacing:1.2px;text-transform:uppercase;padding:12px 18px;">Open in SPIFF</a></td></tr>'
    + '<tr><td style="padding:14px 24px;font-size:12px;color:#5b636b;">Sent automatically by SPIFF the first Monday after a program closes. Amounts come from the same list as Reports &rarr; Buy the gift cards. Source: ' + esc(list.source) + '.</td></tr>'
    + '</table></td></tr></table></body></html>';
}

function giftMailText_(prog, list) {
  var byStore = {}, order = [];
  list.lines.forEach(function (x) {
    var s = x.store || 'unknown';
    if (!byStore[s]) { byStore[s] = []; order.push(s); }
    byStore[s].push(x);
  });
  order.sort();
  var names = {};
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { names = {}; }
  var pretty = function (s) {
    return names[slug_(s)] || String(s).split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  };
  var out = [
    'Gift cards to order for: ' + brandProgramLabel_(prog), '',
    'Cards to order : ' + list.count,
    'Total to load  : ' + moneyStr_(list.total), ''
  ];
  order.forEach(function (s) {
    var sub = byStore[s].reduce(function (n, x) { return n + x.amount; }, 0);
    out.push(pretty(s) + ' — ' + byStore[s].length + ' card' + (byStore[s].length === 1 ? '' : 's') + ', ' + moneyStr_(sub));
    byStore[s].forEach(function (x) { out.push('   ' + x.name + '  ' + moneyStr_(x.amount)); });
    out.push('');
  });
  if (list.warning) out.push('CHECK BEFORE BUYING: ' + list.warning, '');
  out.push('Source: ' + list.source, 'Open SPIFF: ' + MKT_APP_URL);
  return out.join('\n');
}

function sendGiftCardEmails_(opts) {
  opts = opts || {};
  var apply = !!opts.apply, force = !!opts.force, only = String(opts.program || '').trim();
  var out = { ok: true, dry: !apply, sent: [], would_send: [], waiting: [], skipped: [], failed: [] };
  var sh = dataSheet_();
  if (sh.getLastRow() < 2) return out;
  var props = PropertiesService.getScriptProperties();
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, PROGRAM_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var prog = rowToProgram_(vals[i]);
    var id = String(prog.program_id);
    if (only && id !== only) continue;
    if (String(prog.status || '').trim().toLowerCase() !== 'closed') continue;
    if (String(prog.end_date || '') < GIFTMAIL_FROM && !force) continue;
    if (props.getProperty(GIFTMAIL_PREFIX + id) && !force) { out.skipped.push({ program_id: id, why: 'already sent' }); continue; }
    var a = prog.actual_json || {};
    if (a.units_sold == null || a.units_sold === '' || !(Number(a.units_sold) > 0)) {
      out.skipped.push({ program_id: id, why: 'actuals not recorded yet' }); continue;
    }
    if (!force && !giftMailIsDue_(prog.end_date, opts.now)) {
      out.waiting.push({ program_id: id, send_after: giftMailDueDay_(prog.end_date) + ' 12:00 PT' }); continue;
    }
    try {
      var list = giftCardListFor_(prog);
      if (!list.count) { out.skipped.push({ program_id: id, why: 'nobody earned a card' }); continue; }
      var item = { program_id: id, cards: list.count, total: list.total, to: MKT_PEOPLE_.mike, cc: GIFTMAIL_CC };
      if (!apply) { item.body = giftMailText_(prog, list); out.would_send.push(item); continue; }
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(15000)) { out.failed.push({ program_id: id, error: 'busy' }); continue; }
      try {
        if (props.getProperty(GIFTMAIL_PREFIX + id) && !force) { out.skipped.push({ program_id: id, why: 'already sent' }); continue; }
        sendMail_({ to: MKT_PEOPLE_.mike, subject: 'Gift cards to order — ' + brandProgramLabel_(prog) + ' (' + list.count + ' cards, ' + moneyStr_(list.total) + ')',
                    body: giftMailText_(prog, list), htmlBody: giftMailHtml_(prog, list),
                    cc: GIFTMAIL_CC, name: 'Green Cross SPIFF' });
        props.setProperty(GIFTMAIL_PREFIX + id, nowStamp_());
        out.sent.push(item);
      } finally { lock.releaseLock(); }
    } catch (e) {
      out.failed.push({ program_id: id, error: scrubSecrets_(e && e.message || e) });
    }
  }
  return out;
}

function giftCardEmailWeb_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  return sendGiftCardEmails_({ apply: String(p.apply || '') === '1', force: String(p.force || '') === '1', program: p.program });
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
  /* THE ONE CASE THE BUG-MAIL FALLBACK CANNOT COVER. A library call runs in the CALLING project,
     so GX Core's bug email spends THIS project's mail quota — if that is exhausted, the fallback
     notice cannot get through either, and the failure looks identical to everything working. This
     reads the quota WITHOUT sending anything, which also makes it the standing check that the
     send_mail scope is actually granted: SPIFF declared it from the scaffold commit and did not
     call MailApp once until 2026-09-10, so "declared" had never been tested against "granted". */
  try { d.mailQuota = MailApp.getRemainingDailyQuota(); }
  catch (e) { d.mailQuota = 'ERR ' + ((e && e.message) || e); }
  // Reports write into a folder this script did not create, which needs the full drive
  // scope — drive.file would silently only cover our own files.
  try { d.reportFolder = DriveApp.getFolderById(REPORT_FOLDER_ID).getName(); }
  catch (e) { d.reportFolder = 'ERR ' + scrubSecrets_(e && e.message || e); }
  /* Does the clock actually run? The status roll and the progress sweep both ride ONE hourly
     trigger, and whether it is installed was answerable only from the script editor -- so a trigger
     deleted by hand looked exactly like a program that simply had not moved yet. Reported as a
     verdict rather than a handler list: this route is ANYONE_ANONYMOUS. */
  try {
    var copies = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === 'refreshSpiffProgressTrigger';
    }).length;
    /* HOW MANY, not just whether (2026-09-15). Two copies still read "installed" and doubled the
       sweep's load on the shared account; ?action=installProgressTrigger collapses them to one. */
    d.hourlyTrigger = copies === 1 ? 'installed'
      : copies > 1 ? 'DUPLICATED x' + copies + ' - run ?action=installProgressTrigger to collapse to one'
      : 'MISSING - statuses will not roll and progress will not refresh';
    d.hourlyTriggerCopies = copies;
  } catch (e) { d.hourlyTrigger = 'ERR ' + ((e && e.message) || e); }
  /* ── WHETHER IT IS INSTALLED IS NOT WHETHER IT IS GETTING ITS WORK DONE ──────────────────────
     `hourlyTrigger: installed` answers whether the trigger EXISTS and reads as whether it RUNS.
     Between 2026-09-02 and 2026-09-09 both were true and the sweep still wrote nothing: it was
     stuck on twelve programs it can never measure, and the only trace was a console.warn nobody
     reads. So the backlog is reported HERE, beside the trigger, where the question is asked.
     `refused` is the number that matters — a backlog that stops shrinking and never empties.
     Counts only, no program ids: this route is ANYONE_ANONYMOUS. */
  try {
    var b = snapshotBacklog_();
    d.snapshotBacklog = { measured: b.measured, never_measured: b.never_measured,
                          refused: b.refused, eligible: b.eligible };
    if (b.refused) {
      d.snapshotStuck = b.refused + ' program(s) cannot be measured and are being skipped — '
                      + 'their Dutchie filter matches nothing. Fix the filter to re-arm them.';
    }
  } catch (e) { d.snapshotBacklog = 'ERR ' + ((e && e.message) || e); }
  /* THE DEALS PAGE: is the switch on, and what did its last hourly run do (Sky, 2026-11-02)? The
     switch is a Script Property only the editor shows, so "is it on" had no answer outside it.
     Counts and a time only, no program ids or error text: this route is ANYONE_ANONYMOUS. */
  try { d.dealsPage = wixDiag_(); } catch (e) { d.dealsPage = 'ERR ' + ((e && e.message) || e); }
  return d;
}

/* ============================== BUG REPORT ==============================
 * File a bug into GX Core's shared `bug_reports` log. The button, the modal and the context
 * snapshot are gx-theme's `gx-bugreport.js` — this is only the transport and the auth. Nothing
 * about the form lives in this repo, deliberately: six hand-rolled copies of one bug form is
 * exactly what that shared file was written to end.
 *
 * BUCKETING — app 'spiff', tab 'spiff', and BOTH ARE HARDCODED HERE.
 *
 * This paragraph used to argue the opposite: that as an Inventory sub-app, SPIFF's bugs belonged in
 * Inventory's stream under app='inventory'. That was corrected in the CODE on 2026-08-27 and the
 * reasoning is at the call site below — getBugs filters strictly on `b.app`, so app=spiff returned
 * zero forever while the linked note still reached this chat. The comment was left describing the
 * old arrangement, directly above the line doing the new one, until 2026-09-01.
 *
 * Price Cards files under its own key too, so both sub-apps are consistent. Sub-app is a fact about
 * the PRODUCT; the bug board is a fact about who triages it, and those are different questions.
 *
 * Hardcoded rather than read off `p` because bucketing is a fact about what this app IS: a browser
 * must not be able to file into another app's stream, and a caller that forgot the parameter would
 * silently land in the wrong one.
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
 * NO VERSION NAMED HERE, DELIBERATELY. This line used to read "this engine pins 213" and was still
 * saying so while the manifest said 306 — a stale number in a comment whose whole point is that the
 * manifest cannot be trusted either. A pushed pin takes effect only on the next deploy, so the only
 * honest answer is the live one: ask ?action=libversion.
 */
function reportBug_(p) {
  var auth = gxAuth_(p.token);   // memoized per execution — guard_ already paid for this call
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
      context:  String(p.context || ''),
      /* THE SCREENSHOT, which this dropped one line short of the board (2026-09-15, found by
         core-admin: 140 reports across seven apps and not one carried an image). The browser
         uploads the picture to Drive on its own call and puts the url on the payload as
         `screenshot_url`; this forwarded six named fields and that was not among them, so the
         upload succeeded, the url arrived here, and the board never saw it. Leaderboard fixed its
         own copy in v1.841 and is the shape this follows. */
      screenshot_url: String(p.screenshot_url || '')
    });
  } catch (e) {
    bugUnfiled_(auth.user, p, title, desc,
                'GX Core could not be reached: ' + String((e && e.message) || e));
    return { ok: false, error: 'Could not reach the central bug log: ' +
                              String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    bugUnfiled_(auth.user, p, title, desc,
                'GX Core refused the report: ' + ((res && res.error) || 'no reason given'));
    return { ok: false, error: (res && res.error) || 'GX Core refused the report' };
  }

  /* FILED, BUT WAS ANYBODY TOLD? Core owns the email as of v310 and swallows its own mail failure
     on purpose — a filed report HAS succeeded, and failing the call would throw away a good row
     over a notification. So nothing else anywhere mentions it, and `mail_error` / `mail_skipped`
     (v312) are the only trace. Reading them is a reason this engine is pinned to v315.

     `mail_skipped` is the one that reads as fine and is not: no watch address configured AND a
     reporter with no address on file means nothing FAILED and nobody was mailed. Still silent.

     IT CANNOT FIRE FOR SPIFF TODAY, and the reason is worth writing down because it is not obvious
     and it will change. Core takes `to = reporterEmail || watchEmail`, and gxBugWatchEmail_ falls
     back to a HARDCODED default when cfg.bugWatchEmail is unset — checked live 2026-09-10, the key
     is unset, so the watch address is never empty and there is always a recipient. Leaderboard
     warned us on 2026-09-10 that mail_skipped would be our NORMAL path rather than an edge case,
     reasoning that SPIFF reporters are user_id slugs (`tawny`) and not addresses. That half is
     true — gxAuth_ returns Core's `validate` payload, whose `user` is the slug — but it takes BOTH
     halves to skip, and the second cannot happen while the default stands. Setting
     cfg.bugWatchEmail to `off` is what would make their warning correct overnight, which is exactly
     why the branch below is kept rather than dropped as dead. Leaderboard withdrew the warning the
     same day after reading gxBugWatchEmail_ themselves; it is recorded here because the reasoning
     behind it was sound and will be reached again.

     AND THE SLUG RESOLVES, so the REPORTER RECEIPT works too — checked rather than assumed, because
     the alternative was a silent suite-wide gap in something Sky asked for on 2026-09-09. Core's
     secret-gated `?action=contacts` joins employees to users.email and marks each row contactable.
     Swept across roles on 2026-09-10 with include_inactive=1:

         role=manager   17 rows   13 hold a user_id   13 contactable   0 gaps
         role=admin      5 rows    4 hold a user_id    4 contactable   0 gaps
         viewer / editor / director — no rows at all

     THE TWO SLICES ARE DISJOINT and union to exactly 17 distinct user_ids, all contactable:
     chris, dean, drew, mariana, mike, noah, pamela, samuel, scott, shawn, sky, skyler, tawny, tj,
     tyler, tyson, zach. Holding a user_id is what it takes to sign in and file at all, so everyone
     who can reach this function is covered and there are no gaps.

     BEWARE THE TWO SEVENTEENS, because one of them cost a wrong correction. `role=manager` returns
     17 ROWS carrying 13 user_ids; the union across roles is 17 USER_IDS. Same number, different
     things, and they are unrelated — the row count is Assistant Manager 10 + Store Manager 7, since
     getEmployeeContacts substring-matches role_title and "manager" catches both. Leaderboard
     reported 17 contactable user_ids from a different sweep entirely (single-letter needles unioned
     by employee_id, 76 distinct rows); this file briefly recorded that as a row count misread for a
     user count, which was wrong. Reconciled by taking the union above and finding their list exactly.
     Anyone re-deriving this should union the SLICES and compare NAMES, never compare a 17 to a 17.

     TRUTHINESS, NEVER `in`. The fields are ABSENT when they do not apply, not empty. */
  bugUnannounced_(auth.user, p, title, desc, res);
  return { ok: true, id: res.id };
}

/* ─── THE TWO WAYS A BUG REPORT GOES QUIET, AND THE ONLY NOTICE THAT WILL MENTION EITHER ──────────
 *
 * SPIFF HAD NEVER SENT AN EMAIL AT ALL before this — no MailApp call anywhere in the file. The
 * scope was declared in the manifest from the scaffold commit, so this needs no re-authorize; that
 * is luck rather than planning, and worth stating so nobody removes an "unused" scope.
 *
 * WHAT IS AND IS NOT SHARED WITH LEADERBOARD'S VERSION, because copying it wholesale would be wrong
 * here. Leaderboard returns ok:true no matter what happens, so a refused report there reaches no
 * board AND tells the reporter it worked — its unfiled notice is the only record that anyone tried.
 * SPIFF has always returned the failure to the browser, and gx-bugreport.js shows it, so OUR
 * reporter is not misled. That is a real difference and the wording below reflects it: this notice
 * does not tell Sky to re-file something the reporter thinks succeeded.
 *
 * SO WHY SEND IT AT ALL. The typed report exists in exactly one place — a browser modal — and the
 * likeliest response to "could not reach the central bug log" is to close it and get on with the
 * job. The text is then gone and nobody ever knew a problem was hit. This preserves the content and
 * the fact that somebody tried; acting on it is Sky's call, not an instruction.
 *
 * `deduped` IS RELIABLE IN THIS APP. A caveat reached us on 2026-09-10 saying SPIFF files through
 * BOTH the library call and HTTP ingest_bug, which take DIFFERENT locks — a library call takes the
 * CALLING script's, an HTTP ingest takes Core's — so Core's de-dupe would not cover us. It is a real
 * property and it belongs to PRICE CARDS, not to us: that app has its own secret-gated ingest_bug
 * route over HTTP as well as the library call Inventory makes on its behalf. SPIFF has exactly one
 * transport, the GXCore.gxIngestBug call above, and no `ingest_bug` route anywhere in the repo.
 *
 * WORTH KEEPING RATHER THAN JUST DELETING, because a caveat pinned to the wrong app does not merely
 * fail to help — it argues against the rule it exists to protect. Believing it here would have led
 * to treating `deduped` as unsafe and reading a missing `mailed` field as a mail failure, which IS
 * the three-copies bug the caveat was written to prevent. The check is automated in
 * tests/bug_mail_fallback_test.js rather than left to this paragraph: it greps every source file
 * for a second transport on each run, so if one is ever added here this stops being true loudly
 * instead of silently.
 *
 * WHETHER THIS MAIL CAN SUCCEED WHERE CORE'S FAILED is not guaranteed, and saying so shapes what it
 * is for. A library call runs in the CALLING project, so Core's send already came out of the same
 * pool this one draws on — an exhausted quota refuses this send too.
 *
 * AND THE POOL IS WIDER THAN "THIS SCRIPT". Apps Script meters mail per USER ACCOUNT per day, not
 * per project, and every GX engine deploys as the same owner — so Inventory, Sales, Leaderboard and
 * Core itself all drain the same allowance. Observed 2026-09-10: diag read 1447 and then 1417
 * within the hour, with SPIFF having sent nothing at all in between. Do not read a falling number
 * as evidence this app is mailing.
 *
 * What the fallback DOES cover is everything short of exhaustion: a missing or bad recipient (all
 * of `mail_skipped`), a transient failure, a Core-side config problem. ?action=diag reports the
 * remaining quota so the one uncovered case is visible rather than guessed at.
 *
 * MAIL IS THE ENHANCEMENT; THE REPORT IS THE THING. Every send here is wrapped and non-fatal, and
 * none of it may change what reportBug_ returns to the browser. */
var BUG_WATCH_EMAIL = 'sky@greencrosscanna.com';

function bugUnfiled_(user, p, title, desc, why) {
  if (!bugMailOnce_(user, title, desc, 'unfiled')) return;
  bugNotify_('⚠️ UNFILED SPIFF bug [' + String(p.priority || 'normal') + ']: ' + title, [
    'THIS REPORT IS NOT ON THE BUG BOARD. ' + why + ',',
    'so nothing was recorded anywhere and this email is the only copy of it.',
    '',
    'The reporter WAS shown the error — unlike Leaderboard, SPIFF returns the failure rather',
    'than a receipt — so they may retry on their own. This is here so the text below is not',
    'lost if they simply close the box instead.',
  ], user, p, title, desc);
}

function bugUnannounced_(user, p, title, desc, res) {
  /* A DEDUPED REPEAT CARRIES NO MAIL FIELDS AT ALL. gxIngestBug returns at its `priorBug` branch
     ABOVE the send, so a repeat inside Core's dedupe window has neither `mailed` nor an error —
     and reading "no mailed field" as a failure would turn every /exec redirect chain (measured
     re-executing one request up to three times) into three mail-failure notices. That is the exact
     bug this kind of fix has caused elsewhere. Check `deduped` FIRST. */
  if (!res || res.deduped) return;
  var why = res.mail_error || res.mail_skipped;
  if (!why) return;
  if (!bugMailOnce_(user, title, desc, 'unannounced')) return;
  bugNotify_('🔕 UNANNOUNCED SPIFF bug [' + String(p.priority || 'normal') + ']: ' + title, [
    'THIS REPORT IS ON THE BUG BOARD — do NOT re-file it — but GX Core could not email anyone',
    'about it, so this notice is standing in. The reporter got no receipt either.',
    '',
    'Bug id     : ' + String(res.id || '(none returned)'),
    'Mail ' + (res.mail_error ? 'failed  : ' : 'skipped : ') + why,
  ], user, p, title, desc);
}

/* The body both notices share — same fields, same order, in one place. They differ only in the
   paragraph at the top saying which failure this was and what to do about it. */
/* ── THE ONE DOOR MAIL LEAVES BY ────────────────────────────────────────────────────────────────
 *
 * MAIL IS THE WORSE EXIT. A screen shows an error once, to whoever was standing there; an email is
 * forwarded, quoted, and stays searchable in an inbox forever. The message that lands here is built
 * from a caught exception — `bugUnfiled_` is handed String(e.message) off a failed GXCore call, and
 * a GXCore call wraps UrlFetchApp, which puts the WHOLE URL into its exception text. So a transient
 * network failure while filing a bug report mailed GX_DEPLOY_SECRET to a person's inbox. That
 * secret opens every secret-gated route in GX Core, the payroll-shaped reads included.
 *
 * ONE SEND SITE, SCRUBBED HERE, rather than a scrub at each caller. SPIFF has exactly one send
 * today and the temptation is to fix it where it is — crew is the argument against that: it had
 * SEVEN sends and exactly ONE scrubbed, the one somebody had happened to look at. A funnel makes
 * the second send inherit the fix instead of needing to remember it. Every field is scrubbed, not
 * just the body, because a subject carries the bug title and a title is typed by a person.
 *
 * Copies the message rather than mutating the caller's object: a caller that logs what it sent
 * should not find its own fields rewritten underneath it. Scrubbing is idempotent, so a caller that
 * already scrubbed loses nothing by coming through here. */
function sendMail_(msg) {
  var out = {};
  for (var k in msg) { if (Object.prototype.hasOwnProperty.call(msg, k)) out[k] = msg[k]; }
  if (out.subject   != null) out.subject   = scrubSecrets_(out.subject);
  if (out.body      != null) out.body      = scrubSecrets_(out.body);
  if (out.htmlBody  != null) out.htmlBody  = scrubSecrets_(out.htmlBody);
  MailApp.sendEmail(out);
}

function bugNotify_(subject, lead, user, p, title, desc) {
  try {
    sendMail_({
      to: BUG_WATCH_EMAIL,
      subject: subject,
      body: lead.concat([
        '',
        'Reporter : ' + String(user || ''),
        'Priority : ' + String(p.priority || 'normal'),
        'Screen   : spiff',
        'Version  : ' + String(p.appVer || ''),
        'Time     : ' + nowStamp_() + ' (America/Los_Angeles)',
        '',
        title || '(no title)',
        '',
        desc || '(no details provided)',
        '',
        /* The captured JS errors and route, exactly as gx-bugreport.js snapshotted them. Sales's
           defer bug was reported three times before anyone diagnosed it, and the cause was a single
           boot ReferenceError sitting in this field. Truncated because it can be long, and a mail
           nobody finishes reading is its own failure. */
        '--- context ---',
        String(p.context || '(none captured)').slice(0, 4000),
      ]).join('\n'),
    });
  } catch (e) { /* non-fatal, on purpose — see the header */ }
}

/* True the FIRST time a given report asks to be emailed AS `kind`, false for a repeat inside three
 * minutes — the same window gxIngestBug dedupes on, so the email and the board agree about what
 * "the same report" is. A fourth minute is somebody filing again because nothing happened, which
 * SHOULD mail.
 *
 * `kind` NAMESPACES THE MARK because the two notices carry contradictory instructions ("this is not
 * on the board" vs "this IS on the board, do not re-file"). One report can legitimately raise both
 * — a submit that never reaches Core, then a retry that files and cannot mail — and one shared key
 * would drop whichever came second, leaving the earlier, now-wrong instruction standing alone.
 *
 * FAILS OPEN, deliberately: a cache or lock that is unavailable must never be the reason a bug
 * report goes unread. Better a duplicate email than a silent one. */
function bugMailOnce_(user, title, desc, kind) {
  var lock = null;
  try {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
      String(user || '') + '\u0000' + String(title || '') + '\u0000' + String(desc || ''),
      Utilities.Charset.UTF_8);
    var key = 'bugmail:' + kind + ':' + Utilities.base64EncodeWebSafe(digest);
    lock = LockService.getScriptLock();
    /* Atomic check-and-set. A redirect chain can re-enter fast enough that three executions read an
       empty cache at once, and three simultaneous misses is precisely the duplicate-email bug. */
    try { lock.waitLock(5000); } catch (e) { lock = null; }   // busy → fall through and send
    var cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, '1', 180);   // seconds — 3 min, matching gxIngestBug's dedupe window
    return true;
  } catch (e) {
    return true;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

/* The roster. GX Core exposes NO public `employees` HTTP action — it lives behind the
   bound GXCore library, so only an engine can read it (the browser cannot). SPIFF reads
   it and never writes it; the Command Center owns the roster.

   Returns the active staff plus a per-store headcount, which is what the Calculator needs
   for per-budtender targets and what payouts will need for attribution. */
function gxEmployees_(opts) {
  opts = opts || {};
  /* ONE SOURCE, CACHED. This used to read the HTTP roster first and fall back to the bound
     library, on the belief that the library returned undecorated rows — false since 2026-08-19,
     see gxRosterFull_. Both branches now resolve to the same library call, so the fallback was
     retrying an identical request: if getEmployees() throws it throws twice, and the only thing
     the second attempt added was a second failure to report. */
  var rows;
  try {
    rows = gxRosterFull_() || [];
  } catch (e0) { rows = []; }
  if (!rows.length) {
    return { ok: false, error: 'The GX Core roster is unavailable, so employee names cannot be '
                             + 'resolved right now.' };
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
      /* display_name is what the person is actually CALLED — GX Core's preferred name plus
         surname, so "Andrew Phillips" ships as "Drew Phillips". Sent alongside full_name, never
         instead of it: the roster's legal name is still the right thing for a record, and the
         caller decides which one the screen wants. Present on every row (falling back to the
         legal name) so a consumer can read it unconditionally. */
      display_name: String(r.display_name || r.full_name || '').trim(),
      dutchie_employee_id: r.dutchie_employee_id || '', role_title: role
    });
    if (store) byStore[store] = (byStore[store] || 0) + 1;
  }
  return { ok: true, employees: out, by_store: byStore, roles: roles, count: out.length };
}

/* Stores are shared truth — pulled, never hardcoded, so Command Center edits flow through.
 *
 * THE LIBRARY, NOT THE WEB ROUTE (2026-09-12). This used to fetch ?action=stores over HTTP, which
 * put the store registry — read on the vendor flyer, the kiosk-link panel, the close-out report and
 * every sell-through grid — behind the same bouncing /exec hop that was failing payout calculations.
 * There was never a reason for it: this app BINDS the GXCore library, getStores() opens the GX Core
 * spreadsheet BY ID, and a library call runs inside this execution. No second hop, nothing to bounce.
 *
 * THE RULE THAT DECIDES THIS, from GX Core's own source: a library function may be called from a
 * spoke IF it only touches things opened by id; the moment it needs one of GX CORE's ScriptProperties
 * it has to be a web route, because getScriptProperties() scopes to the CALLING project. getStores
 * qualifies. getSalesByEmployee explicitly does NOT — it reads Dutchie keys from Core's properties —
 * which is why gxSalesByEmployee_ stays an HTTP call with a retry and must not be "improved" into a
 * library call. dutchieInventoryViaGXCore_ is the same story, written up where it lives.
 *
 * THE SHAPES DIFFER, so this was checked rather than assumed. The route returns {stores:[…]} and the
 * library returns the array itself; the route also slugs store_id and sorts by sort_order, which the
 * library does not. Both are reproduced here — callers compare against 'river-rd' and several iterate
 * to render, so neither is cosmetic.
 *
 * SHORT_CODE IS RAW HERE, AND NOTHING IN THIS APP READS IT. The web route DERIVES short_code from
 * display_name because the stored codes collide — Century and Center were both CEN — and that
 * derivation is private to GX Core; the library hands back the sheet cell. So if you ever reach for
 * s.short_code, you are reading the colliding value, not Core's disambiguated one. Match on store_id
 * instead. Do not copy Core's derivation down here: that rule already has a home, and a second copy
 * is the thing that rots.
 */
function gxStores_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('gx_stores');
  if (hit) return JSON.parse(hit);

  var stores = (GXCore.getStores() || [])
    .map(function (s) { s.store_id = slug_(s.store_id || ''); return s; })
    .sort(function (a, b) { return (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999); });

  cache.put('gx_stores', JSON.stringify(stores), 900);
  return stores;
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

function parseJson_(s, fallback) {
  if (s === '' || s == null) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// Dates are TEXT everywhere (YYYY-MM-DD); a sheet/script timezone mismatch silently
// shifts real Date objects by a day. Learned the hard way — see gx-conventions.md.
function today_()    { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }
function nowStamp_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss'); }

/* ── EVERY REPLY LEAVES THROUGH THE SCRUB, AND IT IS THE SERIALIZED BODY THAT GOES THROUGH IT ────
 *
 * Scrubbing the whole JSON rather than each catch is the point. Every named leak path in this file
 * already scrubs at its own catch — libVersion_, the router, publishSpiffToCore_, the store pulls —
 * and that is exactly the arrangement that keeps failing: a scrub at one exit says nothing about
 * the next one somebody adds. Four apps were audited by hand on 2026-09-17 and every one had an
 * exit nobody had counted. Doing it here makes "no reply field may carry a raw credential" true by
 * CONSTRUCTION, so a route added next month that returns an exception from somewhere new cannot
 * reintroduce the leak, whatever its author remembered.
 *
 * The per-catch scrubs stay. They shape the message a human reads ("GX Core unreachable: …") and
 * they are what the executing tests pin; this is the floor underneath them, not a replacement.
 * scrubSecrets_ is idempotent — `secret=[redacted]` re-scrubs to itself — so running both is free.
 *
 * SAFE ON THE SERIALIZED FORM because the pattern needs a literal `name=value`, and JSON writes its
 * own fields as `"name":"value"`. The only `=` in a reply is inside a string, which in practice
 * means a URL somebody's exception dragged in. The kiosk and vendor links this app hands the
 * browser are built browser-side from a bare `token` FIELD (`store.html?t=` / `client.html?t=`), so
 * nothing legitimate in a payload is shaped like a credential parameter. A vendor note someone
 * typed containing `key=…` would be redacted; that is the trade, and it is the right way round. */
function reply_(obj, callback) {
  var json = scrubSecrets_(JSON.stringify(obj));
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
  /* TOUCHES GMAIL ON PURPOSE. Running this is what makes Google ask for the mail permission that
     "Send to brand" needs — an authorize() that never calls a Gmail service finished without asking
     (2026-09-30), so the send failed with "does not have permission". A read only: it lists the
     Send-As addresses, which also shows whether BRAND_FROM_DEFAULT is usable before anyone sends. */
  try { report.sendAs = GmailApp.getAliases(); report.brandFrom = brandFromAddress_();
        report.brandFromUsable = report.sendAs.indexOf(report.brandFrom) >= 0; }
  catch (e) { report.sendAs = 'ERR ' + e.message; }
  /* TOUCHES CALENDAR ON PURPOSE, for the same reason as Gmail above: this is what makes Google ask
     for the calendar permission the Marketing Calendar sync needs. A read only. */
  try { report.calendar = CalendarApp.getCalendarById(MKT_CALENDAR_ID_).getName(); }
  catch (e) { report.calendar = 'ERR ' + e.message; }
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
 *
 * THE PARSER OUTLIVED THE BUTTON BY THIRTEEN DAYS. Cutting `importCalc` on 2026-08-30 removed the
 * only CALLER of the Calculator parser but left the parser itself compiling quietly: parseCalcTab_
 * and, reachable only through it, storeTable_ → matchStore_, plus findBlendedCost_, findCellCol_,
 * findVal_, maxCols_, periodOf_ → mmyy_ / pad2_ / cleanVendor_. Eleven functions, 235 lines, zero
 * ways to reach any of them. Removed 2026-09-12.
 *
 * IT WAS NOT INERT WHILE IT SAT THERE. matchStore_ was the only reader of a store's `short_code`,
 * and that single dead reference was load-bearing in a COMMENT: when gxStores_ moved off the web
 * route to the bound library (see it above), the route's derived short_code stopped being
 * reproduced, and the justification for not reproducing it was "nothing live reads it — only
 * matchStore_, which is dead." True, but it made a live design decision depend on a fact about
 * unreachable code, which the next reader has to go and re-verify. Deleting the parser is what let
 * that comment become a plain statement instead of a chain of reasoning. Dead code is not free; it
 * shows up as a caveat somewhere else.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT CATALOG — the featured product a program is actually about.
 *
 * WHY THIS EXISTS: the Calculator had no way to say WHICH product the SPIFF is on.
 * Vendor, cost per unit and reference units were all typed from memory, which is
 * how a program gets modeled against the wrong sell-through and pitched to a
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

/* ─── Live inventory for one store, THROUGH GX Core ──────────────────────────────────────────────
 *
 * Replaced GXCore.dutchieInventory() on 2026-08-31. That library call could never have worked, and
 * had not: PropertiesService.getScriptProperties() scopes to the CALLING project, so the library
 * looked for DUTCHIE_STORE_KEYS_JSON in THIS project, which has never held one. Every call threw,
 * the throw went into `errs`, and nobody read `errs` — so the vendor Calculator has been building
 * its catalog from nothing since the day it was wired up. GX Core's own gx_core.gs:187 documents
 * the same constraint (it hardcodes a spreadsheet id because openById is caller-independent and
 * getScriptProperties is not); GX_DUTCHIE_CACHE_SCOPE.md asserted the opposite and was wrong.
 *
 * The web route executes AS GX Core, so it reads Core's properties — the thing a library call
 * cannot do. This app therefore holds no Dutchie credential, and never needs one.
 *
 * Takes a GX Core store_id. GX Core resolves the Dutchie label itself, so the two-spelling split
 * that caused the August incident cannot reach this app at all.
 * ------------------------------------------------------------------------------------------------ */
function dutchieInventoryViaGXCore_(storeId) {
  var secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!secret) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach GX Core');

  // fields= trims the payload to what conformProduct_ actually reads. An inventory pull is thousands
  // of rows per store and this adds a hop, so moving sixty columns to use eleven is worth avoiding.
  var url = GXCORE_URL + '?action=dutchie_inventory'
          + '&store=' + encodeURIComponent(storeId)
          + '&secret=' + encodeURIComponent(secret)
          // EXACTLY what conformProduct_ reads, fallbacks included — it accepts either spelling of
          // three of these, and dropping the fallback is how a vendor rename empties the catalog
          // silently. Keep this list and that function in step; nothing else may be trimmed away.
          + '&fields=' + encodeURIComponent([
              'productName', 'name',                       // n
              'brandName', 'brand',                        // b
              'masterCategory', 'category',                // c
              'size', 'unitWeight',                        // s
              'pricingTierName',                           // t
              'unitCost',                                  // cost
              'recUnitPrice', 'unitPrice', 'medUnitPrice', // price / medPrice
              'quantityAvailable'                          // qty
            ].join(','));

  /* Its OWN loop, not gxCoreFetchJson_: five attempts at 400ms rather than three at 500/1500, tuned
     for a thousands-of-rows pull across six stores where the shared budget would be spent on one.
     Same rule underneath, though — a refusal is final, transport is retried.

     THE FETCH IS INSIDE THE TRY as of 2026-09-12. It was outside, so a THROWN fetch — the exact
     shape /exec takes when it stalls — escaped the loop on attempt one and burned the other four.
     The retry was there for the bounce and did not cover the bounce's commonest form. (It reached
     buildCatalog_'s catch, which scrubs, so no secret ever rode out; the loop just never ran.) */
  var lastErr = '';
  for (var i = 0; i < 5; i++) {
    var resp = null, data = null;
    try { resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
    catch (e) { lastErr = scrubSecrets_((e && e.message) || e); }
    if (resp) {
      try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
    }
    if (data && data.ok === true && Array.isArray(data.rows)) return data.rows;
    // A refusal is final. Retrying a bad secret or an unknown store burns the budget and buries
    // the message that would have explained it.
    if (data && data.ok === false) throw new Error(data.error || 'dutchie_inventory refused');
    lastErr = lastErr || 'no rows in response';
    Utilities.sleep(400);   // the /exec second hop 404s on ~6% of rapid calls
  }
  throw new Error('GX Core dutchie_inventory unreachable after 5 tries — ' + scrubSecrets_(lastErr));
}

/* The catalog, deduped across stores. A product carried at five stores is ONE row here —
   the Calculator asks "which product", not "which product at which store". */
function buildCatalog_() {
  var stores = [];
  try { stores = GXCore.getStores() || []; } catch (e) { return { ok: false, error: 'GX Core getStores failed: ' + scrubSecrets_(e && e.message || e) }; }

  var by = Object.create(null), errs = [], seen = 0;
  stores.forEach(function (s) {
    var id = String(s.store_id || '').trim();
    if (!id) return;
    var rows;
    try { rows = dutchieInventoryViaGXCore_(id); }
    catch (e) { errs.push(id + ': ' + scrubSecrets_(e && e.message || e)); return; }
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

  /* AN EMPTY CATALOG WITH ERRORS IS A FAILURE, NOT AN EMPTY CATALOG.
     This returned ok:true with zero products and a populated `errors` for as long as
     GXCore.dutchieInventory has existed — which was always, because that library call could never
     read GX Core's properties. The Calculator rendered "no products" and looked merely quiet. A
     partial failure stays ok:true (four stores of six is still a usable catalog, and the errors
     ride along); every store failing is reported as what it is. */
  if (!list.length && errs.length) {
    return { ok: false, error: 'no products from any store — ' + errs.length + ' of '
             + stores.length + ' failed', errors: errs, stores_read: stores.length,
             rows_seen: seen, built_at: nowStamp_() };
  }

  return { ok: true, products: list, brands: brandList,
           stores_read: stores.length, rows_seen: seen, errors: errs, built_at: nowStamp_() };
}

function catalog_(p) {
  var cat = null;
  if (String(p && p.refresh) !== '1') cat = catalogGet_();
  /* AN EMPTY CATALOG IN THE CACHE IS A MISS, NOT A CATALOG. The guard below stops a failed
     build from being cached going forward, but a cache poisoned before it existed would still
     be served for the rest of its six hours -- which is exactly what happened here: forcing a
     refresh during the 401 wrote a zero-product catalog at 14:10 that would have emptied the
     vendor picker until 20:10. Refusing to serve it costs one rebuild attempt; serving it costs
     an afternoon of a picker with nothing in it and no reason given. */
  if (cat && !(cat.products || []).length) cat = null;
  var cached = !!cat, stale = false;
  if (!cat) {
    var built = buildCatalog_();
    if (!built.ok) return built;
    /* A BUILD THAT READ NOTHING MUST NOT BECOME THE CATALOG. buildCatalog_ reports a store
       that would not answer in `errors` and carries on, so a chain-wide Dutchie outage
       produces a perfectly well-formed catalog of zero products -- ok:true, and cached for
       six hours over the good one that was there. That is how a refresh during an outage
       empties the vendor picker until long after the outage is over.
       Verified live 2026-08-31: forcing refresh=1 while Dutchie was 401ing on all six stores
       replaced an 8,480-row catalog with an empty one.
       Every store failing is the only case treated this way. A partial read still caches --
       it is a real catalog, just short a store, and refusing it would leave the picker
       empty over one store's outage. */
    if (!built.rows_seen && (built.errors || []).length) {
      /* Same emptiness test as above, and it has to be repeated here: falling back to the
         cache without it hands back the very zero-product catalog the guard just rejected,
         relabelled `stale` — which is how this fix failed its own first live check. */
      var keep = catalogGet_();          // the refresh=1 path above deliberately skipped this
      if (keep && !(keep.products || []).length) keep = null;
      if (!keep) {
        return { ok: false, error: 'no products could be read from any store \u2014 '
                 + (built.errors || [])[0], errors: built.errors,
                 stores_read: built.stores_read, rows_seen: 0 };
      }
      cat = keep; cached = true; stale = true;
      cat.errors = built.errors;
    } else {
      cat = built;
      catalogPut_(cat);
    }
  }

  var brand = String((p && p.brand) || '').trim().toLowerCase();
  var out = {
    ok: true, cached: cached, built_at: cat.built_at,
    /* `stale` means: this is the last catalog that read cleanly, and the rebuild that would
       have replaced it could not reach a single store. The products are real but may be out
       of date, and the caller should say which. */
    stale: stale,
    stores_read: cat.stores_read, rows_seen: cat.rows_seen, errors: cat.errors,
    brands: cat.brands
  };

  if (String(p && p.all) === '1') { out.products = cat.products; return out; }
  if (!brand) { out.products = []; out.brand = ''; return out; }

  /* THE SAME RULE THE PAYOUT USES — case-insensitive substring — and on purpose (2026-09-11).
     This used to be exact (===), to stop "Mule" dragging in "Mule Extracts". But the money path,
     GX Core's sales_by_employee, has always matched by substring, and so has the reference-units
     pull, which goes through it. So the exact rule never stopped the widening; it only HID it:
     a program on "Mule" would be pitched over Mule's products and paid over both brands. And it
     broke the other way on a real program — "National Cannabis Co" against products branded
     "National Cannabis Co." showed an empty picker for a program that measured 267 units.
     Now the picker shows the vendor the products they will actually be charged for, and the
     widening itself is caught where it can be answered: brandMatchCheck_ asks before saving a
     brand that matches more than one brand in the catalog. */
  out.brand = brand;
  out.products = cat.products.filter(function (x) { return String(x.b || '').toLowerCase().indexOf(brand) >= 0; });
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

/* The reference window, as its own function so the rule has one home and a test can execute it
 * rather than grep for it. Returns the 28 (or `days`) day span the baseline is measured over.
 *
 * ANCHORED to the day before `before` when that is a real date — see the long note in refUnits_
 * for why a program's baseline has to be the run-up to that program and not the last four weeks.
 * Falls back to `today` for a program with no window yet, where the recent period IS the honest
 * reference and refusing would block modeling a new program.
 *
 * ENDS THE DAY BEFORE in both branches. Unanchored that excludes today, a partial day that drags
 * the average down by however early someone opened the Calculator. Anchored it excludes the
 * program's own first day, whose sales belong to the program rather than to its baseline.
 */
function refWindow_(before, days, today) {
  var n = Math.max(1, Math.min(90, Number(days) || REF_DAYS));
  var b = textDate_(before || '');
  var anchored = /^\d{4}-\d{2}-\d{2}$/.test(b);
  var to = addDaysLocal_(anchored ? b : textDate_(today), -1);
  return { anchored: anchored, from: addDaysLocal_(to, -(n - 1)), to: to, days: n };
}

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

  /* ── THE REFERENCE ENDS WHERE THE PROGRAM BEGINS ────────────────────────────────────────────
     `before` is the program's start date, and the 28 days are counted back from the day before
     it. Sky, 2026-09-09: "the re-measure function should pull the sales from the 28 days before
     the period in which the program is set to run."

     It used to always end yesterday, which is right for modeling a program that starts
     tomorrow and wrong for every other case. Reconciling Hapy Kitchen's February window, or
     Buddies' June one, compared them against the last four weeks of trade — months after the
     program ended, a different season, and for a brand we may not even carry now (Hapy Kitchen
     is absent from the live catalog today). That figure is the baseline: it sets ROI, the
     per-store targets and the per-budtender goals, so an unanchored reference does not just
     mislabel a caption, it re-prices the whole model against the wrong period.

     ANCHORED IS OPTIONAL, not required. A brand-new program being modelled may have no window
     yet, and there the honest reference IS the most recent four weeks. So no `before` keeps the
     old behavior rather than refusing.

     ENDS THE DAY BEFORE, in both branches, and for the same reason each time: a partial day
     drags the average down. Unanchored that partial day is today; anchored it is the program's
     own first day, whose sales belong to the program and not to its baseline. */
  var win = refWindow_(p.before, days, today_());
  var anchored = win.anchored, from = win.from, to = win.to;

  var r = gxSalesByEmployee_(secret, from, to, store, match);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'sell-through fetch failed', store: store };

  var units = Number((r.totals || {}).units) || 0;
  var revenue = Number((r.totals || {}).revenue) || 0;
  var errs = r.errors || [];

  /* AN ERROR IS NOT A ZERO, and this is the one place the difference is knowable.
     gxSalesByEmployee_ reports a store that would not answer in `errors` and still returns
     totals of 0 -- so with Dutchie refusing every store (HTTP 401 across all six, seen live
     2026-08-31) this route was replying ok:true, reference:0. The Calculator has no way to
     tell that apart from "this product sold nothing", so it seeded every store at 0, called
     the pull a success, and captioned it "0 in 28d / 2" as though it were measured. Every
     figure below is arithmetic on that number.
     A genuine zero -- the product really did not sell -- has NO errors beside it, and still
     comes back as a zero. It is only the silent kind that is refused. Reported by Sky
     2026-08-31 as "when i select a product it's coming up as 0s for last month". */
  if (errs.length && !units) {
    return { ok: false, store: store, from: from, to: to, days: days, errors: errs,
             error: 'no sell-through for ' + store + ' \u2014 ' + errs[0] };
  }

  return {
    /* `anchored` travels back so the caption can say WHICH 28 days it measured. A reference is
       argued over in front of a vendor; "1,234 in 28d" that silently means a different month
       than the one on screen is the kind of number that cannot be defended on the spot. */
    ok: true, store: store, from: from, to: to, days: days, anchored: anchored,
    units: Math.round(units * 1000) / 1000,
    revenue: Math.round(revenue * 100) / 100,
    /* The figure the Calculator seeds a store's reference with. Returned ALONGSIDE the raw
       28-day number, never instead of it — a halved figure with no visible provenance is
       exactly the kind of number that gets questioned in a vendor meeting and cannot be
       explained on the spot. */
    reference: Math.round(units / REF_DIVISOR),
    divisor: REF_DIVISOR,
    sellers: (r.rows || []).length,
    /* Kept even on the success path: a pull where SOME stores answered is a real figure
       measured over an incomplete chain, and the caller has to be able to say so. */
    errors: errs
  };
}

/* Dates are TEXT (YYYY-MM-DD). Built in UTC and formatted back, never via a local Date
   constructor — the sheet/script timezone mismatch is what silently shifts a day. */
function addDaysLocal_(ymd, n) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/* ═════════════════ THE MARKETING CALENDAR ══════════════════════════════════════════════════════
 * Sky, 2026-11-02: SPIFF fills Tawny's shared Google "Marketing Calendar" so the team has ONE
 * calendar. ONE WAY: SPIFF writes, nothing is read back into SPIFF. Four kinds of event, each keyed:
 *   program:<id>        the program's window, all day (drafts say "(draft)")
 *   vday:<id>:<n>       a vendor day, n = its place in the plan's list, so editing a date MOVES it
 *   pencil:<id>         "Spiff reserved - Brand", while the hold is penciled
 * HOLIDAY SENDS ARE NOT ON IT (Sky, 2026-11-02): that calendar is company-facing, and a holiday send
 * is internal marketing. They stay on SPIFF's own Calendar view. Do not add them here.
 * NO DUPLICATES: SPIFF will not CREATE an event when a hand-made one of the same kind already covers
 * that brand and those dates (a vendor day matches a hand-made vendor day on the same date, anything
 * else matches a hand-made non-vendor-day). It is reported as skipped_duplicates instead. Delete the
 * hand-made one and the next run makes SPIFF's.
 * The key rides on the event as a private tag (CAL_TAG_). Only a tagged event is ever updated or
 * removed; Tawny's hand-made events carry no tag and are never touched. A possible duplicate is
 * left alone, and SPIFF skips its own copy of anything one already covers (skipped_duplicates).
 *
 * IT IS NOT A PAY PATH. It reads programs, pencils and holidays and writes only to Google Calendar.
 * It runs LAST in the hourly job, in its own try/catch, behind the CAL_SYNC_ON script property, so a
 * Calendar outage, a missing permission or a bug costs the calendar and nothing else. Nothing that
 * pays, publishes or feeds a kiosk may call it (pinned by tests/calendar_sync_test.js and the
 * isolation test). Vendor-day invites are OFF until CAL_INVITE_VDAYS = 1, and then go to Mike only,
 * once, when the event is created. */
var MKT_CALENDAR_ID_ = 'c_0ab9afb8ed309776b6293321191b4e8311b262eb9971bf436336d64d27792470@group.calendar.google.com';
var CAL_TAG_ = 'spiff_key';
var CAL_LOOKBACK_DAYS_ = 30;
var CAL_LOOKAHEAD_DAYS_ = 420;
var CAL_MAX_REMOVES_ = 10;
var CAL_NOTE_ = 'Managed by SPIFF. Edit it there; changes made here are overwritten on the next hourly sync.';

/* "12-2", "3:00 PM - 6:00 PM", "11am to 1pm", "12–2pm", "4pm" -> {start:'HH:mm', end:'HH:mm'}, else
   null (the event goes all day and the text rides in its title). One time alone runs two hours. */
function calParseTime_(text) {
  var t = String(text == null ? '' : text).toLowerCase().replace(/[–—]/g, '-').trim();
  var one = '(\\d{1,2})(?::(\\d{2}))?\\s*([ap])?\\.?m?\\.?';
  var m = t.match(new RegExp('^' + one + '\\s*(?:-|to)\\s*' + one + '$'));
  var single = !m && t.match(new RegExp('^' + one + '$'));
  if (!m && !single) return null;
  var a = m ? { h: +m[1], mi: m[2], ap: m[3] } : { h: +single[1], mi: single[2], ap: single[3] };
  var b = m ? { h: +m[4], mi: m[5], ap: m[6] } : null;
  var fix = function (x, other) {
    var ap = x.ap || (other && other.ap) || '';
    if (x.h > 12 || (x.mi && +x.mi > 59) || x.h < 0) return null;
    var h = x.h;
    if (!ap) ap = (h >= 9 && h <= 11) ? 'a' : 'p';        // 9-11 morning; 12 and 1-8 afternoon
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return h * 60 + (x.mi ? +x.mi : 0);
  };
  var s = fix(a, b), e;
  if (s == null) return null;
  if (b) { e = fix(b, a); if (e == null) return null; if (e <= s && !a.ap && !b.ap) return null; }
  else e = s + 120;
  if (e <= s || e >= 24 * 60) return null;
  var hhmm = function (n) { return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); };
  return { start: hhmm(s), end: hhmm(e) };
}

/* WHAT THE CALENDAR SHOULD HOLD, as plain data. `src` = {programs, pencils, storeNames}
   (pencils already limited to penciled). Only events that touch the sync
   window are returned: an event outside it could never be found again next hour, and would be made
   again every hour. */
function calendarDesired_(src, today) {
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  var from = addDaysLocal_(today, -CAL_LOOKBACK_DAYS_), to = addDaysLocal_(today, CAL_LOOKAHEAD_DAYS_);
  var names = src.storeNames || {};
  var out = [];
  var span = function (key, summary, first, last, desc, brand) {
    if (!ISO.test(String(first || '')) || !ISO.test(String(last || '')) || last < first) return;
    out.push({ key: key, summary: summary, allDay: true, date: first, endDate: addDaysLocal_(last, 1),
               start: '', end: '', description: desc, brand: brand, kind: key.split(':')[0] });
  };
  (src.programs || []).forEach(function (p) {
    var vendor = String(p.vendor || '').trim() || 'Unnamed brand';
    var draft = p.status === 'draft' ? ' (draft)' : '';
    span('program:' + p.program_id, vendor + ' Spiff' + draft, p.start_date, p.end_date,
         CAL_NOTE_ + '\n' + brandProgramLabel_(p) + ' · ' + p.status, vendor);
    var plan = normalizeMarketing_(p.marketing_json) || {};
    var oldDay = (plan.d && plan.d.vday) || {};
    var days = plan.vdays && plan.vdays.length ? plan.vdays
             : (oldDay.date ? [{ store: '', date: oldDay.date, time: oldDay.time || '' }] : []);
    if (mktPickedIds_(plan).indexOf('vday') < 0) return;
    days.forEach(function (v, i) {
      if (!ISO.test(String(v.date || ''))) return;
      var where = v.store ? (names[slug_(v.store)] || v.store) : 'All stores';
      var t = calParseTime_(v.time);
      var title = vendor + ' Vendor Day - ' + where + (!t && v.time ? ' (' + v.time + ')' : '');
      var ev = { key: 'vday:' + p.program_id + ':' + i, summary: title, allDay: !t, date: v.date,
                 endDate: t ? v.date : addDaysLocal_(v.date, 1), start: t ? t.start : '', end: t ? t.end : '',
                 description: CAL_NOTE_ + '\n' + brandProgramLabel_(p), vday: true, brand: vendor, kind: 'vday' };
      out.push(ev);
    });
  });
  (src.pencils || []).forEach(function (x) {
    span('pencil:' + x.pencil_id, 'Spiff reserved - ' + x.brand, x.start_date, x.end_date,
         CAL_NOTE_ + (x.note ? '\n' + x.note : ''), x.brand);
  });
  return out.filter(function (e) { return e.endDate > from && e.date < to; });
}

function calSame_(a, b) {
  return a.summary === b.summary && !!a.allDay === !!b.allDay && a.date === b.date
      && (a.allDay ? a.endDate === b.endDate : (a.start === b.start && a.end === b.end))
      && String(a.description || '') === String(b.description || '');
}

/* The real Calendar, behind five small calls so the sync logic can be run against a stand-in. Dates
   go in and out as text; a Date is built in the script's zone (Los Angeles) only at this edge. */
function calendarAdapter_() {
  var cal = CalendarApp.getCalendarById(MKT_CALENDAR_ID_);
  if (!cal) throw new Error('Marketing Calendar not reachable by this account');
  var TZ = 'America/Los_Angeles';
  var at = function (ymd, hhmm) { return Utilities.parseDate(ymd + ' ' + (hhmm || '00:00'), TZ, 'yyyy-MM-dd HH:mm'); };
  var day = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  var clock = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm').slice(11, 16); };
  return {
    list: function (from, to) {
      return cal.getEvents(at(from), at(to)).map(function (e) {
        var all = e.isAllDayEvent();
        return { ref: e, id: e.getId(), key: e.getTag(CAL_TAG_) || '', summary: e.getTitle(), allDay: all,
                 date: day(all ? e.getAllDayStartDate() : e.getStartTime()),
                 endDate: all ? day(e.getAllDayEndDate()) : day(e.getEndTime()),
                 start: all ? '' : clock(e.getStartTime()), end: all ? '' : clock(e.getEndTime()),
                 description: e.getDescription() || '' };
      });
    },
    create: function (ev, opts) {
      var o = { description: ev.description };
      var made;
      if (ev.allDay) made = cal.createAllDayEvent(ev.summary, at(ev.date), at(ev.endDate), o);
      else {
        if (opts && opts.guests) { o.guests = opts.guests; o.sendInvites = true; }
        made = cal.createEvent(ev.summary, at(ev.date, ev.start), at(ev.date, ev.end), o);
      }
      made.setTag(CAL_TAG_, ev.key);
      return made.getId();
    },
    update: function (existing, ev) {
      var e = existing.ref;
      e.setTitle(ev.summary);
      e.setDescription(ev.description);
      if (ev.allDay) e.setAllDayDates(at(ev.date), at(ev.endDate));
      else e.setTime(at(ev.date, ev.start), at(ev.date, ev.end));
    },
    remove: function (existing) { existing.ref.deleteEvent(); }
  };
}

function calendarSource_() {
  var names = Object.create(null);
  try { (gxStores_() || []).forEach(function (x) { names[slug_(x.store_id)] = x.display_name || x.store_id; }); }
  catch (e) { /* a slug is a poor label, not a blank one */ }
  return {
    programs: listPrograms_(),
    pencils: readPencils_().filter(function (x) { return x.status === 'penciled'; }),
    storeNames: names
  };
}

/* A hand-made event that already says what `ev` would say: same brand in the title, overlapping days,
   and the same KIND (a vendor day only matches a hand-made "vendor day"; a program or hold only
   matches one that is not). Sky, 2026-11-02: "don't put duplicates out". Untagged events only. */
function calHandMadeTwin_(ev, handMade) {
  var brand = String(ev.brand || '').toLowerCase().trim();
  if (!brand) return null;
  var last = function (e) { return e.allDay ? addDaysLocal_(e.endDate, -1) : (e.endDate || e.date); };
  for (var i = 0; i < handMade.length; i++) {
    var h = handMade[i], title = String(h.summary || '').toLowerCase();
    if (title.indexOf(brand) < 0) continue;
    if (/vendor day/.test(title) !== (ev.kind === 'vday')) continue;
    if (h.date <= last(ev) && last(h) >= ev.date) return h;
  }
  return null;
}

/* One pass. Dry unless opts.apply. Never throws for one bad event: each write has its own try. */
function calendarSync_(opts) {
  opts = opts || {};
  var apply = !!opts.apply;
  var today = opts.today || Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  var out = { ok: true, apply: apply, created: [], updated: [], removed: [], unchanged: 0,
              refused: '', failed: [], skipped_duplicates: [] };
  var src = opts.source || calendarSource_();
  var desired = calendarDesired_(src, today);
  var cal = opts.cal || calendarAdapter_();
  var existing = cal.list(addDaysLocal_(today, -CAL_LOOKBACK_DAYS_), addDaysLocal_(today, CAL_LOOKAHEAD_DAYS_));
  var mine = Object.create(null), stale = [], handMade = [];
  existing.forEach(function (e) {
    if (!e.key) handMade.push(e);
    else if (mine[e.key]) stale.push(e);          // a second copy of one key: the extra is ours to drop
    else mine[e.key] = e;
  });
  var want = Object.create(null);
  desired.forEach(function (ev) { want[ev.key] = ev; });
  Object.keys(mine).forEach(function (k) { if (!want[k]) stale.push(mine[k]); });

  var guests = String(opts.invite || '') === '1' ? MKT_PEOPLE_.mike : '';
  desired.forEach(function (ev) {
    var have = mine[ev.key];
    try {
      if (!have) {
        var twin = calHandMadeTwin_(ev, handMade);
        if (twin) { out.skipped_duplicates.push({ spiff: ev.summary, hand_made: twin.summary, date: ev.date }); return; }
        if (apply) cal.create(ev, ev.vday && guests ? { guests: guests } : null);
        out.created.push({ key: ev.key, summary: ev.summary, date: ev.date });
      } else if (!calSame_(have, ev)) {
        if (apply) cal.update(have, ev);
        out.updated.push({ key: ev.key, summary: ev.summary, date: ev.date });
      } else out.unchanged++;
    } catch (e) { out.failed.push({ key: ev.key, error: String((e && e.message) || e) }); }
  });

  /* Removals are the one thing here that can lose a person's view of the plan, so they have brakes:
     an empty programs tab makes every event look orphaned (same trap as the progress cache), and a
     big sweep in one hour is more likely a bug than an editing session. */
  if (stale.length) {
    if (!(src.programs || []).length) out.refused = 'programs tab read empty; would have removed ' + stale.length;
    else if (stale.length > CAL_MAX_REMOVES_) out.refused = 'would remove ' + stale.length + ' (limit ' + CAL_MAX_REMOVES_ + ')';
    else stale.forEach(function (e) {
      try { if (apply) cal.remove(e); out.removed.push({ key: e.key, summary: e.summary, date: e.date }); }
      catch (err) { out.failed.push({ key: e.key, error: String((err && err.message) || err) }); }
    });
  }

  return out;
}

function calendarSyncWeb_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  try {
    return calendarSync_({ apply: String(p.apply || '') === '1',
                           invite: PropertiesService.getScriptProperties().getProperty('CAL_INVITE_VDAYS') });
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* The hourly step. OFF until Sky sets CAL_SYNC_ON = 1 (after authorize() and a dry run he has
   looked at). Says what it did either way, so a calendar that stopped updating leaves a line. */
function runCalendarSyncHourly_() {
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('CAL_SYNC_ON') || '') !== '1') return { skipped: true };
  var r = calendarSync_({ apply: true, invite: props.getProperty('CAL_INVITE_VDAYS') });
  var line = 'created ' + r.created.length + ', updated ' + r.updated.length + ', removed ' + r.removed.length
           + ', unchanged ' + r.unchanged;
  if (r.failed.length) console.warn('[spiff] calendar sync: ' + r.failed.length + ' event(s) FAILED — ' + line + ' — '
    + r.failed.map(function (f) { return f.key + ' (' + f.error + ')'; }).join('; '));
  else console.log('[spiff] calendar sync: ' + line);
  if (r.refused) console.warn('[spiff] calendar sync REFUSED removals: ' + r.refused);
  return r;
}

/* ═════════════════ THE DEALS PAGE (greencrosscanna.com/deals) ══════════════════════════════════════
 * Sky, 2026-11-02: deals publish themselves. A program planned for the website becomes one Featured
 * card (Wix collection FeaturedDeals, keyed on programId) and one row per vendor day (VendorDays, keyed
 * on dayKey). GX Core holds the Wix key and does the writing (its connector, GXCore v364+); SPIFF only
 * builds the payload. Field map and design: mockups/deals-wix-handover.md.
 *
 * WHAT GOES OUT. A program is on the page only when ALL of these hold:
 *   · it is active, or a draft starting within WIX_LOOKAHEAD_DAYS_ (sent with live=false, so the
 *     page does not show it until it is running)
 *   · its marketing plan picks the Deals page item (`web`) and has a headline
 *   · SKY has ticked "Approve the deals page copy" (WIX_APPROVE_TASK_). The engine signs every tick with
 *     the session's user (wixSignDelta_), refuses that tick from anyone else, and un-ticks it when
 *     anyone else changes the copy afterwards. Sky approves all customer copy; this is how.
 * Its vendor days go out only when the plan also picks Vendor day. Only customer copy crosses: brand,
 * typed copy, dates, store, time, image. The connector refuses any other field anyway.
 *
 * WHAT COMES OFF. Only rows SPIFF put there itself (their keys are kept in WIX_PUBLISHED_PROP_). A
 * program that closes, is deleted, loses its approval or drops the item comes off on the next run; a
 * vendor day whose LA date has passed is pruned. Rows typed by hand in Wix are never touched, and SPIFF
 * makes no copy of anything a hand-made row already covers (same brand and overlapping dates for a
 * card; same brand, date and store for a day), reported as skipped_duplicates. Delete the hand-made
 * one and the next run puts SPIFF's up. Removals have the calendar's brakes.
 *
 * SHOP NOW. The card's button opens each store's online menu at /brands/<slug>, and a wrong slug shows
 * "no products" rather than an error. So the slug comes from the brand name DUTCHIE uses for the
 * program's products, slugged the menu's way ("Bobsled Extracts" → bobsled-extracts), and once per LA
 * day SPIFF asks each store's live inventory which stores stock that brand. Those store ids go on the
 * card as `shopStores`; the block lists only them, and hides the button when there are none, in which
 * case Tawny gets one email. A store whose inventory could not be read keeps yesterday's answer: a
 * refused source is not a zero. A Menu Slug that disagrees with Dutchie is REPORTED in menu_slug_fixes
 * for a person to change on the Deals page screen (PART 2, below), which owns the Vendors rows.
 *
 * IT IS NOT A PAY PATH. It reads programs and inventory and writes only to the public website. It runs
 * LAST in the hourly job in its own try/catch, behind script property WIX_PUBLISH_ON=1. Nothing that
 * pays may call it. ?action=publishToWix (secret, dry unless apply=1) shows exactly what it would send.
 * Pinned by tests/wix_publish_test.js. */
var WIX_PUBLISHED_PROP_ = 'WIX_PUBLISHED';
var WIX_SHOP_PROP_ = 'WIX_SHOP_STORES';
var WIX_NOSHOP_PREFIX_ = 'wixnoshop:';
var WIX_IMAGE_PREFIX_ = 'wiximg:';
var WIX_LOOKAHEAD_DAYS_ = 60;   // Sky, 2026-11-04: future vendor days must show, not just active programs
var WIX_MAX_REMOVES_ = 40;
var WIX_ITEM_ = 'web';
var WIX_APPROVE_TASK_ = 'web.approve';
/* Who may switch a program onto the page (Sky, 2026-11-02: "Sky, Mike and Tawny only", not every
   editor). Sign-in names as GX Core holds them. GX Core's approval gate checks the same three. */
var WIX_APPROVERS_ = ['sky', 'mike', 'tawny'];
/* The field each row carries naming its approver (a GX Core user_id), for GX Core's approval gate
   (GXCore v365+). Core checks it against kv wixApprovers and STRIPS it, so Wix never holds it, which
   is why wixSameItem_ leaves it out of the comparison. Every write also says app 'spiff'. */
var WIX_APPROVER_FIELD_ = 'approvedBy';
var WIX_PUBLISHER_APP_ = 'spiff';
/* OLCC copy rules (handoff deals-page.md): straight discounts only, no superlatives, no em-dashes.
   Copy that trips one is not published, and the screen warns while it is typed. marketing.js holds
   the same list (COPY_RULES); tests/wix_publish_test.js holds the two together. */
var WIX_COPY_RULES_ = [['bogo', '\\bbogo\\b'], ['free', '\\bfree\\b'], ['with purchase', '\\bwith (?:any |a |your )?purchase'],
  ['buy one', '\\bbuy one\\b'], ['best', '\\bbest\\b'], ['#1', '#\\s*1\\b|\\bnumber one\\b'], ['lowest', '\\blowest\\b'], ['em-dash', '—']];
/* How much copy each website box holds before it breaks the page's layout (Sky, 2026-11-03). Copy
   over a limit is not published or approved; marketing.js holds the same numbers (COPY_LIMITS) and
   stops the typing there. The weekly line's 40 is from Sky: "OFF Freshy & Strainz carts + dispos"
   (35) had to be reworded to fit, and the longest live line is 39. */
var WIX_COPY_LIMITS_ = { headline: 40, alt: 125, note: 120, deal: 12, offer: 60, fine: 200, line: 160, lines: 4,
  week_brand: 30, week_text: 40 };
var WIX_LIMIT_NAMES_ = { headline: 'The headline', alt: 'The image description', note: 'The vendor days note', deal: 'The vendor day deal',
  offer: 'The vendor day offer details', fine: 'The fine print' };
var WIX_FAIL_PROP_ = 'WIX_FAIL_FILED';
var WIX_LAST_RUN_PROP_ = 'WIX_LAST_RUN';
var WIX_FEATURED_SPEC_ = { min: 1080, max: 2400, bytes: 2097152, types: ['image/jpeg', 'image/png'] };
var WIX_SPEC_TEXT_ = '1200 × 1200 px square (1080 to 2400 accepted), JPG or PNG, 2 MB max';
var WIX_DOW_ = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
var WIX_MON_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Accents off, then letters and digits only: "Grön", "Gron" and "GRON" are one brand. */
function wixFold_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* The online menu's brand slug: "Bobsled Extracts" -> bobsled-extracts, "Grön" -> gron. */
function wixMenuSlug_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function wixEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/* The website names a store by its street ("Commercial St", "Baseline St"), not by GX Core's short
   display name, so the label comes from the store's own address in GX Core: "1695 Center St NE" ->
   "Center St". Read live, never typed here. No address: the display name. */
function wixStoreLabel_(store) {
  var street = String((store && store.address) || '').split(',')[0].trim()
    .replace(/^\d+[A-Za-z]?\s+/, '').split(/\s+/)
    .filter(function (w) { return w && !/^(N|S|E|W|NE|NW|SE|SW)$/.test(w); }).join(' ');
  return street || String((store && (store.display_name || store.store_id)) || '');
}

/* "1-3:30" -> {label: "1 to 3:30 PM", minute: 780}. Text calParseTime_ cannot read goes out as typed,
   sorted first. A single time stays a single time ("4 PM"), not the calendar's two-hour block. */
function wixTimeOf_(text) {
  var raw = String(text == null ? '' : text).trim();
  var t = calParseTime_(raw);
  if (!t) return { label: raw, minute: 0 };
  var mins = function (hhmm) { var a = hhmm.split(':'); return +a[0] * 60 + +a[1]; };
  var s = mins(t.start), e = mins(t.end);
  var part = function (n) { var h = Math.floor(n / 60) % 12 || 12, m = n % 60; return h + (m ? ':' + (m < 10 ? '0' : '') + m : ''); };
  var ap = function (n) { return n < 720 ? 'AM' : 'PM'; };
  if (!/-|–|—|\bto\b/i.test(raw)) return { label: part(s) + ' ' + ap(s), minute: s };
  return { label: part(s) + (ap(s) === ap(e) ? '' : ' ' + ap(s)) + ' to ' + part(e) + ' ' + ap(e), minute: s };
}

/* 2026-11-03 -> {dayLabel: "TUE", dateLabel: "11/3", long: "Tue Nov 3"}. The date is the LA day as
   typed; built in UTC so no clock can move it. */
function wixDayLabels_(ymd) {
  var a = String(ymd).split('-'), d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2]));
  var dow = WIX_DOW_[d.getUTCDay()];
  return { dayLabel: dow, dateLabel: (+a[1]) + '/' + (+a[2]),
           long: dow.charAt(0) + dow.slice(1).toLowerCase() + ' ' + WIX_MON_[+a[1] - 1] + ' ' + (+a[2]) };
}

function wixThroughLabel_(ymd) {
  var a = String(ymd).split('-');
  return 'Through ' + WIX_MON_[+a[1] - 1] + ' ' + (+a[2]);
}

/* One offer per line. A line that starts with a price ("$4 off…", "30% off…") gets the price in bold,
   which is how the card shows it big and lime. Everything else is escaped text. */
function wixOfferHtml_(lines) {
  return (lines || []).map(function (l) {
    var t = String(l == null ? '' : l).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var m = t.match(/^(\$\d+(?:\.\d{2})?|\d+%(?:\s+off)?)\s+(.+)$/i);
    return '<p>' + (m ? '<strong>' + wixEsc_(m[1]) + '</strong> ' + wixEsc_(m[2]) : wixEsc_(t)) + '</p>';
  }).join('');
}

/* Who approved the page copy, as stored ('' = nobody who may). The engine signs ticks with the
   session's user (wixSignDelta_), so this is a signed-in approver, not a name a browser typed. */
function wixApprover_(plan) {
  var d = plan && plan.done && plan.done[WIX_APPROVE_TASK_];
  var by = d ? String(d.by || '').toLowerCase() : '';
  return WIX_APPROVERS_.indexOf(by) >= 0 ? by : '';
}

/* The first OLCC copy rule this text breaks, or ''. */
function wixCopyProblem_(texts) {
  var all = (texts || []).map(function (t) { return String(t == null ? '' : t); }).join('\n');
  for (var i = 0; i < WIX_COPY_RULES_.length; i++) {
    if (new RegExp(WIX_COPY_RULES_[i][1], 'i').test(all)) return WIX_COPY_RULES_[i][0];
  }
  return '';
}

/* '' when the deals page card's copy fits the layout, else what is too long. Mirrors marketing.js
   lengthProblem; tests/wix_publish_test.js runs both on the same copy. */
function wixLengthProblem_(web, lines) {
  web = web || {};
  var L = WIX_COPY_LIMITS_, keys = Object.keys(WIX_LIMIT_NAMES_);
  for (var i = 0; i < keys.length; i++) {
    var n = String(web[keys[i]] == null ? '' : web[keys[i]]).trim().length;
    if (n > L[keys[i]]) return WIX_LIMIT_NAMES_[keys[i]] + ' is ' + n + ' characters; the most is ' + L[keys[i]] + '.';
  }
  var ls = (lines || []).filter(function (t) { return String(t == null ? '' : t).trim(); });
  if (ls.length > L.lines) return 'There are ' + ls.length + ' offer lines; the most is ' + L.lines + '.';
  for (var j = 0; j < ls.length; j++) {
    var m = String(ls[j]).trim().length;
    if (m > L.line) return 'Offer line ' + (j + 1) + ' is ' + m + ' characters; the most is ' + L.line + '.';
  }
  return '';
}

/* ── SIGNING A MARKETING DELTA WITH THE SESSION ──────────────────────────────────────────────────
 * A tick used to carry whatever `by` the browser sent. Harmless while ticks were only a to-do list;
 * not once one of them publishes to the public website. So, on the way in:
 *   · every tick's `by` is the signed-in user (the browser's value is ignored)
 *   · the deals-page approval can only be ticked by an approver, WIX_APPROVERS_ (anyone may un-tick it)
 *   · a change to the deals-page copy by anyone else un-ticks the approval, so what goes live is
 *     always what an approver approved; an approver changing approved copy re-signs it as their own.
 *     Vendor-day dates and times are not copy and do not touch it. */
function wixSignDelta_(ops, user, current) {
  var who = String(user || '').toLowerCase();
  var approver = WIX_APPROVERS_.indexOf(who) >= 0;
  var cur = current && typeof current === 'object' ? current : {};
  var copyChanged = false;
  var out = (Array.isArray(ops) ? ops : []).filter(function (op) {
    return Array.isArray(op) && !(op[0] === 'done' && op[1] === WIX_APPROVE_TASK_ && op[2] && !approver);
  }).map(function (op) {
    if (op[0] === 'done' && op[2] && typeof op[2] === 'object') {
      return ['done', op[1], { by: who, at: String(op[2].at || '') || nowStamp_() }];
    }
    if ((op[0] === 'd' || op[0] === 'rows') && op[1] === WIX_ITEM_) {
      var before = ((cur[op[0]] || {})[WIX_ITEM_]);
      if (JSON.stringify(before == null ? null : before) !== JSON.stringify(op[2] == null ? null : op[2])) copyChanged = true;
    }
    return op;
  });
  var ticked = cur.done && cur.done[WIX_APPROVE_TASK_];
  var setsIt = out.some(function (op) { return op[0] === 'done' && op[1] === WIX_APPROVE_TASK_; });
  if (copyChanged && ticked && !setsIt) {
    out.push(approver ? ['done', WIX_APPROVE_TASK_, { by: who, at: nowStamp_() }] : ['done', WIX_APPROVE_TASK_, null]);
  }
  return out;
}

/* The Dutchie spelling of a program's brand, out of the brand names the stores actually stock. Same
   rule as the payout (substring of match_json.brand, else the vendor), with accents folded, and
   narrowed to the exact name when there is one. Two candidates and no exact one is ambiguous: no slug
   is guessed. */
function wixDutchieBrand_(prog, names) {
  var want = wixFold_((prog.match_json && prog.match_json.brand) || prog.vendor);
  if (!want) return { name: '', candidates: [] };
  var hits = (names || []).filter(function (n, i, a) { return wixFold_(n).indexOf(want) >= 0 && a.indexOf(n) === i; });
  var exact = hits.filter(function (n) { return wixFold_(n) === want; });
  if (exact.length === 1) return { name: exact[0], candidates: hits };
  if (hits.length === 1) return { name: hits[0], candidates: hits };
  return { name: '', candidates: hits };
}

/* Vendors by folded title and alias. */
function wixVendorIndex_(vendors) {
  var idx = Object.create(null);
  (vendors || []).forEach(function (v) {
    [v.title].concat(Array.isArray(v.aliases) ? v.aliases : []).forEach(function (n) {
      var k = wixFold_(n);
      if (k && !idx[k]) idx[k] = v;
    });
  });
  return idx;
}

/* WHAT THE PAGE SHOULD HOLD, as plain data. src = {programs, vendors, storeLabels:{id:label},
   shop: {stores:{id:[brand]}} | null, sendShopBrand}. Returns the items, plus why each planned program
   is NOT going out, and anything a person should fix. `images` maps programId -> the typed image link,
   which wixPublish_ resolves (it needs Drive and Wix, this does not). */
function wixDesired_(src, today) {
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  var out = { featured: [], days: [], images: {}, skipped: [], problems: [], shop: [] };
  var horizon = addDaysLocal_(today, WIX_LOOKAHEAD_DAYS_);
  var idx = wixVendorIndex_(src.vendors);
  var labels = src.storeLabels || {};
  var shop = src.shop && src.shop.stores ? src.shop : null;
  var brandNames = [];
  if (shop) Object.keys(shop.stores).forEach(function (s) { brandNames = brandNames.concat(shop.stores[s] || []); });
  var text = function (x, max) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max || 500); };

  var picked = [];
  (src.programs || []).forEach(function (p) {
    if (!ISO.test(String(p.start_date || '')) || !ISO.test(String(p.end_date || '')) || p.end_date < today) return;
    if (!(p.status === 'active' || (p.status === 'draft' && p.start_date <= horizon))) return;
    var plan = normalizeMarketing_(p.marketing_json) || {};
    if (mktPickedIds_(plan).indexOf(WIX_ITEM_) < 0) return;          // not planned for the website
    var web = (plan.d && plan.d[WIX_ITEM_]) || {};
    if (!text(web.headline)) { out.skipped.push({ program_id: p.program_id, why: 'no headline yet' }); return; }
    var approver = wixApprover_(plan);
    if (!approver) { out.skipped.push({ program_id: p.program_id, why: 'waiting for Sky, Mike or Tawny to approve the deals page copy' }); return; }
    var broken = wixCopyProblem_([web.headline, web.note, web.deal, web.offer, web.fine, web.alt]
      .concat(((plan.rows && plan.rows[WIX_ITEM_]) || []).map(function (r) { return r.text; })));
    if (broken) { out.skipped.push({ program_id: p.program_id, why: 'the copy breaks the OLCC copy rules ("' + broken + '"); fix it on the program' }); return; }
    var long = wixLengthProblem_(web, ((plan.rows && plan.rows[WIX_ITEM_]) || []).map(function (r) { return r.text; }));
    if (long) { out.skipped.push({ program_id: p.program_id, why: long + ' Too much copy breaks the layout; shorten it on the program' }); return; }
    picked.push({ p: p, plan: plan, web: web, approver: approver });
  });
  /* Soonest-ending first, which is the card order on the page. */
  picked.sort(function (a, b) {
    return a.p.end_date < b.p.end_date ? -1 : a.p.end_date > b.p.end_date ? 1 : (a.p.program_id < b.p.program_id ? -1 : 1);
  });

  picked.forEach(function (x, i) {
    var p = x.p, plan = x.plan, web = x.web, id = p.program_id;
    var vendor = text(p.vendor, 120) || text((p.match_json || {}).brand, 120);
    var v = idx[wixFold_(vendor)] || idx[wixFold_((p.match_json || {}).brand)] || null;
    if (!v) out.problems.push({ program_id: id, problem: 'no Vendors item in Wix matches "' + vendor + '", so the page shows the name on a black tile. Add the brand to Vendors.' });

    var days = [];
    if (mktPickedIds_(plan).indexOf('vday') >= 0) {
      var oldDay = (plan.d && plan.d.vday) || {};
      days = (plan.vdays && plan.vdays.length ? plan.vdays : (oldDay.date ? [{ store: '', date: oldDay.date, time: oldDay.time || '' }] : []))
        .filter(function (d) { return ISO.test(String(d.date || '')) && d.date >= today; })
        .map(function (d) {
          var label = d.store ? (labels[slug_(d.store)] || d.store) : '';
          return { store: label, storeKey: label ? wixMenuSlug_(label) : 'all', date: d.date, time: wixTimeOf_(d.time) };
        })
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.time.minute - b.time.minute; });
    }

    var item = {
      programId: id, title: vendor, headline: text(web.headline, 200),
      offerLines: wixOfferHtml_(((plan.rows && plan.rows[WIX_ITEM_]) || []).map(function (r) { return r.text; })),
      vendorDaysNote: text(web.note), finePrint: text(web.fine),
      imageAltText: text(web.alt) || text(web.headline, 200),
      throughLabel: wixThroughLabel_(p.end_date), startDate: p.start_date, endDate: p.end_date,
      sortOrder: i + 1, live: p.status === 'active' && p.start_date <= today,
      vendorDays: days.map(function (d) {
        return '<p><strong>' + wixEsc_(wixDayLabels_(d.date).long) + '</strong> · ' + wixEsc_(d.store || 'All stores')
          + (d.time.label ? ' · ' + wixEsc_(d.time.label) : '') + '</p>';
      }).join(''),
      vendorDaysData: days.map(function (d) { return { store: d.store, date: d.date, time: d.time.label }; })
    };
    if (v) item.vendorRef = v._id;
    if (WIX_APPROVER_FIELD_) item[WIX_APPROVER_FIELD_] = x.approver;
    if (text(web.image)) out.images[id] = text(web.image);

    /* Shop Now. Without a day's inventory read, shopStores is left as it is on the card. */
    var b = wixDutchieBrand_(p, brandNames);
    var slug = wixMenuSlug_(b.name || vendor);
    if (shop) {
      if (!b.name && b.candidates.length) {
        out.problems.push({ program_id: id, problem: 'Dutchie has several brands that match "' + vendor + '": ' + b.candidates.join(', ') + '. Narrow the program\'s brand filter.' });
      } else {
        var stores = Object.keys(shop.stores).filter(function (s) { return b.name && (shop.stores[s] || []).indexOf(b.name) >= 0; }).sort();
        item.shopStores = stores;
        var have = v ? (v.menuSlug || wixMenuSlug_(v.title)) : '';
        out.shop.push({ program_id: id, vendor: vendor, dutchie_brand: b.name, slug: slug, stores: stores,
                        vendors_menu_slug: v ? (v.menuSlug || '') : '', fix: !!(v && b.name && have !== slug) });
      }
    }
    if (src.sendShopBrand && b.name) item.shopBrand = slug;
    out.featured.push(item);

    var seen = Object.create(null);
    days.forEach(function (d) {
      var base = id + '|' + d.storeKey + '|' + d.date;
      seen[base] = (seen[base] || 0) + 1;
      var L = wixDayLabels_(d.date);
      var row = { dayKey: base + (seen[base] > 1 ? '|' + seen[base] : ''), programId: id, title: vendor,
                  date: d.date, dayLabel: L.dayLabel, dateLabel: L.dateLabel, store: d.store,
                  time: d.time.label, sortTime: d.time.minute, deal: text(web.deal, 40), offer: text(web.offer, 200) };
      if (v) row.vendorRef = v._id;
      if (WIX_APPROVER_FIELD_) row[WIX_APPROVER_FIELD_] = x.approver;
      out.days.push(row);
    });
  });
  return out;
}

/* Does a Wix row already hold every field of this item, as sent? Fields the item does not carry are
   not compared: the connector merges, so they are left alone. */
function wixSameItem_(row, item) {
  return Object.keys(item).every(function (f) {
    if (f === WIX_APPROVER_FIELD_) return true;      // checked and stripped by GX Core, never stored
    var a = row[f], b = item[f];
    if (a && typeof a === 'object' && a.$date) a = String(a.$date).slice(0, 10);
    return wixCanon_(a) === wixCanon_(b);
  });
}

/* JSON with every object's keys sorted. Wix hands objects back with their keys in ITS order
   (alphabetical: vendorDaysData comes back {date, store, time} though SPIFF sends {store, date, time}),
   so a plain JSON.stringify called the same card different every hour and rewrote it (2026-11-03,
   the Grön card). Key order carries no meaning; array order does, and is kept. */
function wixCanon_(v) {
  if (v === undefined) v = null;
  if (Array.isArray(v)) return '[' + v.map(wixCanon_).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + wixCanon_(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v);
}

/* WHAT TO SEND, given what Wix holds now. Pure: desired + rows + published keys in, the plan out. */
function wixPlan_(desired, rows, published, programCount, today) {
  var out = { featured: [], days: [], remove_featured: [], remove_days: [], unchanged: 0,
              skipped_duplicates: [], refused: '', keep_featured: [], keep_days: [] };
  var fold = wixFold_;
  var overlap = function (a, b) { return String(a.startDate || '') <= String(b.endDate || '') && String(b.startDate || '') <= String(a.endDate || ''); };
  var dayOf = function (r) { var d = r.date; if (d && typeof d === 'object' && d.$date) d = d.$date; return String(d || '').slice(0, 10); };
  var side = function (want, have, keyField, mine, twinOf, sendTo, removeTo, keepTo) {
    var byKey = Object.create(null), handMade = [];
    (have || []).forEach(function (r) {
      var k = String(r[keyField] == null ? '' : r[keyField]);
      (byKey[k] = byKey[k] || []).push(r);
      if (mine.indexOf(k) < 0) handMade.push(r);
    });
    var wanted = Object.create(null);
    want.forEach(function (item) {
      var k = item[keyField], rowsNow = byKey[k] || [];
      wanted[k] = true;
      if (rowsNow.length === 1 && wixSameItem_(rowsNow[0], item)) { out.unchanged++; keepTo.push(k); return; }
      if (!rowsNow.length) {
        var twin = handMade.filter(function (h) { return twinOf(h, item); })[0];
        if (twin) { out.skipped_duplicates.push({ key: k, hand_made: twin[keyField] || twin._id || '' }); return; }
      }
      sendTo.push(item);
    });
    mine.forEach(function (k) { if (!wanted[k] && byKey[k]) removeTo.push(k); });
  };
  side(desired.featured, rows.featured, 'programId', (published && published.featured) || [],
       function (h, it) { return fold(h.title) === fold(it.title) && overlap(h, it); },
       out.featured, out.remove_featured, out.keep_featured);
  side(desired.days, rows.days, 'dayKey', (published && published.days) || [],
       function (h, it) { return fold(h.title) === fold(it.title) && dayOf(h) === it.date && fold(h.store) === fold(it.store); },
       out.days, out.remove_days, out.keep_days);
  /* EXPIRED CARDS COME OFF WHOEVER MADE THEM. GX Core does not clear Featured Deals and nothing else
     runs on a schedule, so a card whose end date (LA day) has passed is deleted here, a hand-made one
     included: "item deleted after end" is the page's rule, not SPIFF's. The page hides them anyway. */
  out.expired_featured = [];
  if (today) (rows.featured || []).forEach(function (r) {
    var end = r.endDate; if (end && typeof end === 'object' && end.$date) end = end.$date;
    end = String(end || '').slice(0, 10);
    var k = String(r.programId == null ? '' : r.programId);
    if (k && /^\d{4}-\d{2}-\d{2}$/.test(end) && end < today && out.remove_featured.indexOf(k) < 0) {
      out.remove_featured.push(k); out.expired_featured.push(k);
    }
  });
  /* Brakes, as on the calendar: an empty programs tab makes everything look gone, and a big sweep in
     one run is likelier a bug than an editing session. Refused removals stay published. */
  var n = out.remove_featured.length + out.remove_days.length;
  if (n && !programCount) out.refused = 'programs tab read empty; would have removed ' + n;
  else if (n > WIX_MAX_REMOVES_) out.refused = 'would remove ' + n + ' (limit ' + WIX_MAX_REMOVES_ + ')';
  if (out.refused) {
    out.keep_featured = out.keep_featured.concat(out.remove_featured.filter(function (k) { return out.expired_featured.indexOf(k) < 0; }));
    out.expired_featured = [];
    out.keep_days = out.keep_days.concat(out.remove_days);
    out.remove_featured = []; out.remove_days = [];
  }
  return out;
}

/* GX Core's Wix connector, behind small calls so the publisher can run against a stand-in. Each read
   that comes back not-ok THROWS: a failed read must never look like an empty collection. */
function wixAdapter_() {
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach GX Core');
  var must = function (r, what) {
    if (!r || r.ok === false) throw new Error(what + ' failed: ' + scrubSecrets_((r && r.error) || 'no answer'));
    return r;
  };
  return {
    vendors: function () { return must(GXCore.wixVendors(secret), 'wix_vendors').vendors || []; },
    read: function (coll) { return must(GXCore.wixRead(secret, coll, { limit: 1000 }), 'wix_read ' + coll).items || []; },
    upsert: function (coll, items) { return GXCore.wixUpsert(secret, coll, items, { apply: true, app: WIX_PUBLISHER_APP_, by: 'spiff' }); },
    remove: function (coll, keys) { return GXCore.wixDelete(secret, coll, keys, { apply: true, app: WIX_PUBLISHER_APP_, by: 'spiff' }); },
    prune: function () { return GXCore.wixPrunePastVendorDays(secret, { apply: true, app: WIX_PUBLISHER_APP_, by: 'spiff' }); },
    importImage: function (url, name, mime) { return GXCore.wixImportImage(secret, url, { display_name: name, mime_type: mime, apply: true, app: WIX_PUBLISHER_APP_, by: 'spiff' }); },
    mediaStatus: function (fileId) { return GXCore.wixMediaStatus(secret, fileId); },
    /* Other spellings for the Vendors rows; the screen's cached list, never a reason to stop. */
    brands: function () { var r = brandsRead_(); return r && r.ok ? r.brands || [] : []; },
    driveMeta: function (id) {
      return driveApi_('get', encodeURIComponent(id) + '?supportsAllDrives=true&fields=' + encodeURIComponent('name,mimeType,size,imageMediaMetadata(width,height)'));
    }
  };
}

/* The Featured image spec (mockups/deals-wix-handover.md): '' when it passes, else what is wrong. */
function wixImageProblem_(meta) {
  var S = WIX_FEATURED_SPEC_;
  var mime = String((meta && meta.mimeType) || ''), bytes = Number(meta && meta.size) || 0;
  var im = (meta && meta.imageMediaMetadata) || {}, w = Number(im.width) || 0, h = Number(im.height) || 0;
  if (S.types.indexOf(mime) < 0) return 'is not a JPG or PNG (' + (mime || 'unknown type') + ')';
  if (bytes > S.bytes) return 'is ' + (Math.round(bytes / 104857.6) / 10) + ' MB; the limit is 2 MB';
  if (!w || !h) return 'has no readable size yet (Drive may still be processing it)';
  if (w !== h) return 'is ' + w + ' × ' + h + ', and it must be square';
  if (w < S.min || w > S.max) return 'is ' + w + ' × ' + h + '; a side must be 1080 to 2400 px';
  return '';
}

function wixDriveFileId_(url) {
  var m = String(url || '').match(/\/d\/([-\w]{20,})/) || String(url || '').match(/[?&]id=([-\w]{20,})/);
  return m ? m[1] : '';
}

/* A typed image link -> the wix:image:// value the card's Image field stores. A wix:image value is
   used as it is. A Drive file is checked against the spec FIRST, imported once (on apply), and the
   answer remembered by file id, so an unchanged image is never imported twice. */
function wixImageFor_(url, apply, w, props) {
  var u = String(url || '').trim();
  if (/^wix:image:\/\//.test(u)) return { uri: u };
  var id = wixDriveFileId_(u);
  if (!id) return { problem: 'the featured image link is not a Google Drive file link' };
  var known = props.getProperty(WIX_IMAGE_PREFIX_ + id) || '';
  if (/^wix:image:\/\//.test(known)) return { uri: known };
  if (/^pending:/.test(known)) {
    if (!apply) return { pending: 'still processing in Wix Media' };
    var st = w.mediaStatus(known.slice(8));
    if (st && st.wix_image) { props.setProperty(WIX_IMAGE_PREFIX_ + id, st.wix_image); return { uri: st.wix_image }; }
    if (st && st.status === 'PENDING') return { pending: 'still processing in Wix Media' };
    props.deleteProperty(WIX_IMAGE_PREFIX_ + id);
    return { problem: 'Wix could not process the featured image' };
  }
  var meta;
  try { meta = w.driveMeta(id); }
  catch (e) { return { problem: 'the featured image could not be read from Drive (' + String((e && e.message) || e).slice(0, 120) + ')' }; }
  var bad = wixImageProblem_(meta);
  if (bad) return { problem: 'the featured image ' + bad + '. It must be ' + WIX_SPEC_TEXT_ + '.' };
  if (!apply) return { pending: 'would import ' + (meta.name || id) + ' into Wix Media' };
  var r = w.importImage('https://lh3.googleusercontent.com/d/' + id, meta.name || (id + '.png'), meta.mimeType);
  if (r && r.wix_image) { props.setProperty(WIX_IMAGE_PREFIX_ + id, r.wix_image); return { uri: r.wix_image }; }
  if (r && r.ok !== false && r.file_id) { props.setProperty(WIX_IMAGE_PREFIX_ + id, 'pending:' + r.file_id); return { pending: 'importing into Wix Media' }; }
  return { problem: 'Wix could not import the featured image: ' + scrubSecrets_((r && r.error) || 'no answer') + '. Is the file shared "anyone with the link"?' };
}

/* WHICH STORES STOCK WHICH BRAND, read from each store's live inventory once per LA day (and again
   when a new brand needs asking about). Only brands that match a program's brand are kept, so the
   answer fits in a script property. A store that cannot be read keeps yesterday's answer; every store
   failing keeps yesterday's whole answer. Without `read`, only the stored answer is used. */
function wixShopStores_(opts) {
  var props = PropertiesService.getScriptProperties();
  var prev = parseJson_(props.getProperty(WIX_SHOP_PROP_), null) || {};
  var wanted = (opts.wanted || []).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).sort();
  var have = prev.wanted || [];
  var fresh = prev.day === opts.today && wanted.every(function (x) { return have.indexOf(x) >= 0; });
  if (fresh || !opts.read) return prev.stores ? prev : null;
  var next = { day: opts.today, at: nowStamp_(), wanted: wanted, stores: {}, failed: [] };
  var match = function (b) { var f = wixFold_(b); return wanted.some(function (x) { return f.indexOf(x) >= 0; }); };
  (opts.stores || []).forEach(function (s) {
    var id = slug_(s.store_id || '');
    if (!id) return;
    try {
      var set = Object.create(null);
      (opts.inventory(id) || []).forEach(function (pr) {
        var b = String(pr.brandName || pr.brand || '').trim();
        if (b && num_(pr.quantityAvailable) > 0 && !/^sample\b/i.test(String(pr.productName || pr.name || '')) && match(b)) set[b] = 1;
      });
      next.stores[id] = Object.keys(set).sort();
    } catch (e) {
      next.failed.push(id);
      if (prev.stores && prev.stores[id]) next.stores[id] = prev.stores[id];
    }
  });
  if (next.failed.length && next.failed.length === (opts.stores || []).length) return prev.stores ? prev : null;
  try { props.setProperty(WIX_SHOP_PROP_, JSON.stringify(next)); } catch (e) { /* too big to keep: re-read next run */ }
  return next;
}

/* One pass. Dry unless opts.apply. Never throws for one bad write: each has its own try. */
function wixPublish_(opts) {
  opts = opts || {};
  var apply = !!opts.apply;
  var today = opts.today || today_();
  var props = PropertiesService.getScriptProperties();
  var w = opts.wix || wixAdapter_();
  var programs = opts.programs || listPrograms_();
  var stores = opts.stores || gxStores_() || [];
  var out = { ok: true, apply: apply, today: today, send: { featured: [], days: [] }, remove: { featured: [], days: [] },
              unchanged: 0, skipped: [], skipped_duplicates: [], problems: [], shop: [], menu_slug_fixes: [],
              pruned_past_days: 0, expired_featured: [], refused: '', failed: [], notified: [] };

  var labels = Object.create(null);
  stores.forEach(function (s) { labels[slug_(s.store_id || '')] = wixStoreLabel_(s); });

  var wanted = programs.filter(function (p) { return p.status === 'active' || p.status === 'draft'; })
    .map(function (p) { return wixFold_((p.match_json && p.match_json.brand) || p.vendor); });
  var shop = null;
  try {
    shop = wixShopStores_({ today: today, wanted: wanted, read: !!opts.readShop, stores: stores,
                            inventory: opts.inventory || dutchieInventoryViaGXCore_ });
  } catch (e) { out.problems.push({ problem: 'could not read which stores stock each brand: ' + scrubSecrets_((e && e.message) || e) }); }
  if (!shop) out.problems.push({ problem: 'no inventory read yet today, so Shop Now keeps its current store list (run with shop=1 to read it)' });
  else if (shop.failed && shop.failed.length) out.problems.push({ problem: 'inventory could not be read at ' + shop.failed.join(', ') + '; those stores keep yesterday\'s answer' });

  var vendors = w.vendors();
  var d = wixDesired_({ programs: programs, vendors: vendors, storeLabels: labels, shop: shop,
                        sendShopBrand: String(props.getProperty('WIX_SEND_SHOP_BRAND') || '') === '1' }, today);
  out.skipped = d.skipped; out.problems = out.problems.concat(d.problems); out.shop = d.shop;
  out.menu_slug_fixes = d.shop.filter(function (s) { return s.fix; }).map(function (s) {
    return { vendor: s.vendor, menu_slug_now: s.vendors_menu_slug || '(blank)', should_be: s.slug };
  });

  d.featured.forEach(function (item) {
    var url = d.images[item.programId];
    if (!url) return;
    var r;
    try { r = wixImageFor_(url, apply, w, props); }
    catch (e) { r = { problem: 'featured image: ' + scrubSecrets_((e && e.message) || e) }; }
    if (r.uri) item.image = r.uri;
    else if (r.problem) out.problems.push({ program_id: item.programId, problem: r.problem });
    else if (r.pending) out.problems.push({ program_id: item.programId, problem: 'featured image ' + r.pending });
  });

  var rows = { featured: w.read('FeaturedDeals'), days: w.read('VendorDays') };
  var published = parseJson_(props.getProperty(WIX_PUBLISHED_PROP_), null) || { featured: [], days: [] };
  var plan = wixPlan_(d, rows, published, programs.length, today);
  out.expired_featured = plan.expired_featured;
  out.send.featured = plan.featured; out.send.days = plan.days;
  out.remove.featured = plan.remove_featured; out.remove.days = plan.remove_days;
  out.unchanged = plan.unchanged; out.skipped_duplicates = plan.skipped_duplicates; out.refused = plan.refused;
  var past = rows.days.filter(function (r) {
    var x = r.date; if (x && typeof x === 'object' && x.$date) x = x.$date;
    x = String(x || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(x) && x < today;
  }).length;
  out.pruned_past_days = past;
  /* The weekly lines and brands (PART 2 below). Its own try: a problem there never stops the cards. */
  var site = function (doIt) {
    try {
      out.site = sitePublish_(w, vendors, doIt, opts.siteEntries);
      out.failed = out.failed.concat(out.site.failed);
      if (out.site.refused) out.refused = (out.refused ? out.refused + '; ' : '') + out.site.refused;
    } catch (e) { out.failed.push({ collection: 'Import1/Vendors', error: String((e && e.message) || e) }); }
  };
  if (!apply) { site(false); out.note = 'dry run — nothing written. Send apply=1 to write.'; return out; }

  /* Writes. A key counts as published once Wix has it; a refused removal stays published. */
  var keepF = plan.keep_featured.slice(), keepD = plan.keep_days.slice();
  var send = function (coll, items, keyField, keep) {
    if (!items.length) return;
    try {
      var r = w.upsert(coll, items);
      if (!r || (r.ok === false && !r.results)) throw new Error(scrubSecrets_((r && r.error) || 'no answer'));
      (r.results || []).forEach(function (x) {
        if (x.op === 'inserted' || x.op === 'updated' || x.op === 'unchanged') keep.push(x.key);
        else out.failed.push({ collection: coll, key: x.key, error: x.error || x.op });
      });
    } catch (e) { out.failed.push({ collection: coll, error: String((e && e.message) || e) }); }
  };
  send('FeaturedDeals', plan.featured, 'programId', keepF);
  send('VendorDays', plan.days, 'dayKey', keepD);
  var drop = function (coll, keys, keep) {
    if (!keys.length) return;
    try {
      var r = w.remove(coll, keys);
      if (!r || r.ok === false) { keys.forEach(function (k) { keep.push(k); }); throw new Error(scrubSecrets_((r && (r.error || JSON.stringify(r.errors || []))) || 'no answer')); }
    } catch (e) { out.failed.push({ collection: coll, error: String((e && e.message) || e) }); }
  };
  drop('FeaturedDeals', plan.remove_featured, keepF);
  drop('VendorDays', plan.remove_days, keepD);
  if (past) {
    try { var pr = w.prune(); if (!pr || pr.ok === false) throw new Error(scrubSecrets_((pr && pr.error) || 'no answer')); }
    catch (e) { out.failed.push({ collection: 'VendorDays', error: 'prune: ' + String((e && e.message) || e) }); }
  }
  site(true);
  try {
    props.setProperty(WIX_PUBLISHED_PROP_, JSON.stringify({
      featured: keepF.filter(function (k, i, a) { return a.indexOf(k) === i; }),
      days: keepD.filter(function (k, i, a) { return a.indexOf(k) === i; }) }));
  } catch (e) { out.failed.push({ error: 'could not remember what was published: ' + String((e && e.message) || e) }); }

  /* No store stocks the brand: the card hides Shop Now, and Tawny hears about it once, until a store
     has it again. */
  d.shop.forEach(function (s) {
    var k = WIX_NOSHOP_PREFIX_ + s.program_id;
    if (s.stores.length) { if (props.getProperty(k)) props.deleteProperty(k); return; }
    if (props.getProperty(k)) return;
    try {
      sendMail_({ to: MKT_PEOPLE_.tawny, subject: 'Deals page: no store has ' + s.vendor + ' in stock',
        body: 'The ' + s.vendor + ' card on greencrosscanna.com/deals has no store to send customers to: '
            + 'none of our stores shows ' + (s.dutchie_brand || s.vendor) + ' in stock in Dutchie today, so the card\'s '
            + 'Shop Now button is hidden. It comes back on its own once a store has the brand in stock.\n\n'
            + 'If the brand is on the shelf, check its name in Dutchie and the brand on the SPIFF program.\n\n'
            + 'Sent once by SPIFF (' + MKT_APP_URL + ').' });
      props.setProperty(k, today);
      out.notified.push(s.program_id);
    } catch (e) { out.failed.push({ error: 'could not email Tawny about ' + s.vendor + ': ' + String((e && e.message) || e) }); }
  });
  out.ok = !out.failed.length;
  return out;
}

/* A FAILURE REACHES SKY, not only GX Core's health board (handoff item 2): it is filed as a bug on
   SPIFF's own board (app=spiff), which Sky reads. Once per LA day per distinct set of failures, so a
   failure that repeats every hour is one report, and a new one is a new report. Never throws. */
function wixReportFailure_(lines) {
  if (!lines || !lines.length) return null;
  try {
    var props = PropertiesService.getScriptProperties();
    var day = today_(), fp = lines.slice().sort().join('|').replace(/\d{4}-\d{2}-\d{2}/g, '').slice(0, 300);
    var prev = parseJson_(props.getProperty(WIX_FAIL_PROP_), null) || {};
    if (prev.day === day && prev.fp === fp) return null;
    var res = GXCore.gxIngestBug('spiff', 'spiff-engine', {
      title: 'Deals page publish failed: ' + String(lines[0]).slice(0, 90),
      desc: 'The hourly SPIFF → greencrosscanna.com/deals publish hit a problem. What is already on the page '
          + 'stays as it was; the next hour tries again.\n\n' + lines.map(function (l) { return '• ' + l; }).join('\n')
          + '\n\nSee ?action=publishToWix (dry) for the full picture.',
      priority: 'high', tab: 'spiff' });
    props.setProperty(WIX_FAIL_PROP_, JSON.stringify({ day: day, fp: fp }));
    return res;
  } catch (e) { console.warn('[spiff] could not file the deals page failure: ' + ((e && e.message) || e)); return null; }
}

/* ── THE SCRIPT PROPERTY STORE: how full it is, and the on/off switches (Sky, 2026-11-02) ──────────
 * Sky set WIX_PUBLISH_ON=1 in the editor twice and it did not stick. GX Core had the same symptom the
 * same day: its property store was full, and an editor save over a full store fails without a word.
 * Apps Script caps the store (about 500 KB in all, 9 KB a value), and every write in this file is
 * wrapped so a full store fails quietly too. Two secret-gated routes:
 *   ?action=propsReport  key count, total bytes, the biggest keys and the totals per key prefix.
 *                        Names and sizes only, never a value (some are secrets).
 *   ?action=setSwitch    name=<one of PROP_SWITCHES_> value=1|0, dry unless apply=1. Writes, then
 *                        reads back, so "saved" means the store really holds it. */
var PROPS_STORE_LIMIT_ = 500000;
var PROP_SWITCHES_ = ['WIX_PUBLISH_ON', 'CAL_SYNC_ON', 'CAL_INVITE_VDAYS'];
/* Keys nothing reads any more, which ?action=deleteOrphanProp may remove (dry unless apply=1).
   SPIF_DOC_INDEX was the Drive importers' index, cut 2026-08-30. At 14.4 KB it is over the 9 KB
   per-value cap, and the editor saves every property in one call, which is the likeliest reason
   editor saves stopped sticking (2026-11-02). A NAMED list: this route never deletes anything else. */
var PROP_ORPHANS_ = ['SPIF_DOC_INDEX'];

function propsReport_(all) {
  var keys = Object.keys(all || {});
  var size = function (k) { return String(k).length + String(all[k] == null ? '' : all[k]).length; };
  var total = keys.reduce(function (n, k) { return n + size(k); }, 0);
  var byPrefix = Object.create(null);
  keys.forEach(function (k) {
    var m = String(k).match(/^([^:]+:|[A-Za-z]+_)/), p = m ? m[1] : k;
    var b = byPrefix[p] || (byPrefix[p] = { prefix: p, keys: 0, bytes: 0 });
    b.keys++; b.bytes += size(k);
  });
  return {
    ok: true, keys: keys.length, bytes: total, limit_bytes: PROPS_STORE_LIMIT_,
    percent_full: Math.round(total / PROPS_STORE_LIMIT_ * 1000) / 10,
    biggest: keys.map(function (k) { return { key: k, bytes: size(k) }; })
      .sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 15),
    by_prefix: Object.keys(byPrefix).map(function (p) { return byPrefix[p]; })
      .sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 15),
    switches: PROP_SWITCHES_.reduce(function (o, k) { o[k] = all[k] == null ? null : String(all[k]); return o; }, {})
  };
}

function propsReportWeb_(p) {
  var props = PropertiesService.getScriptProperties();
  var want = props.getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  return propsReport_(props.getProperties());
}

function setSwitchWeb_(p) {
  var props = PropertiesService.getScriptProperties();
  var want = props.getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  var name = String(p.name || '');
  if (PROP_SWITCHES_.indexOf(name) < 0) return { ok: false, error: 'not a switch: ' + name + ' (switches: ' + PROP_SWITCHES_.join(', ') + ')' };
  var value = String(p.value == null ? '' : p.value).trim();
  if (value !== '1' && value !== '0') return { ok: false, error: 'value must be 1 (on) or 0 (off)' };
  var before = props.getProperty(name);
  if (String(p.apply || '') !== '1') return { ok: true, dry: true, name: name, now: before, would_set: value, note: 'dry run — nothing written. Send apply=1 to write.' };
  try { props.setProperty(name, value); }
  catch (e) { return { ok: false, name: name, error: 'the store refused the write: ' + scrubSecrets_((e && e.message) || e) }; }
  var after = props.getProperty(name);
  return { ok: after === value, dry: false, name: name, was: before, now: after,
           error: after === value ? undefined : 'written but did not read back as ' + value + ' — the store may be full; see ?action=propsReport' };
}

function deleteOrphanPropWeb_(p) {
  var props = PropertiesService.getScriptProperties();
  var want = props.getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  var name = String(p.name || '');
  if (PROP_ORPHANS_.indexOf(name) < 0) return { ok: false, error: 'not an orphaned key: ' + name + ' (deletable: ' + PROP_ORPHANS_.join(', ') + ')' };
  var cur = props.getProperty(name);
  if (cur == null) return { ok: true, name: name, already_gone: true };
  if (String(p.apply || '') !== '1') return { ok: true, dry: true, name: name, bytes: name.length + cur.length, note: 'dry run — nothing deleted. Send apply=1 to delete.' };
  try { props.deleteProperty(name); }
  catch (e) { return { ok: false, name: name, error: 'the store refused the delete: ' + scrubSecrets_((e && e.message) || e) }; }
  var gone = props.getProperty(name) == null;
  return { ok: gone, dry: false, name: name, deleted: gone, error: gone ? undefined : 'still there after the delete' };
}

/* The last hourly run's outcome, as counts, for ?action=diag. Never throws. */
function wixRememberRun_(summary) {
  try { PropertiesService.getScriptProperties().setProperty(WIX_LAST_RUN_PROP_, JSON.stringify(summary)); } catch (e) {}
}

/* What diag says about the deals page: the switch, and the last run (counts and a time only). */
function wixDiag_() {
  var props = PropertiesService.getScriptProperties();
  var on = String(props.getProperty('WIX_PUBLISH_ON') || '') === '1';
  var last = parseJson_(props.getProperty(WIX_LAST_RUN_PROP_), null);
  return { publishing: on ? 'on' : 'off (WIX_PUBLISH_ON is not 1)',
           lastRun: last || (on ? 'none yet: the next hourly run will record one' : 'none') };
}

function publishToWixWeb_(p) {
  var want = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!want || String(p.secret || '') !== want) return { ok: false, error: 'Unauthorized' };
  var apply = String(p.apply || '') === '1';
  try { return wixPublish_({ apply: apply, readShop: apply || String(p.shop || '') === '1' }); }
  catch (e) { return { ok: false, error: scrubSecrets_((e && e.message) || e) }; }
}

/* The hourly step. OFF until Sky sets WIX_PUBLISH_ON = 1 (after a dry run he has looked at). Says what
   it did either way, so a page that stopped updating leaves a line. */
function runWixPublishHourly_() {
  var props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('WIX_PUBLISH_ON') || '') !== '1') return { skipped: true };
  var r;
  try { r = wixPublish_({ apply: true, readShop: true }); }
  catch (e) {
    var msg = scrubSecrets_((e && e.message) || e);
    wixRememberRun_({ at: nowStamp_(), ok: false, stopped: true });
    wixReportFailure_(['the run stopped: ' + msg]);
    throw e;
  }
  wixRememberRun_({ at: nowStamp_(), ok: !r.failed.length && !r.refused, stopped: false,
    sent_cards: r.send.featured.length, sent_days: r.send.days.length,
    removed: r.remove.featured.length + r.remove.days.length, unchanged: r.unchanged,
    pruned_past_days: r.pruned_past_days, failed: r.failed.length, removals_refused: !!r.refused,
    waiting_for_approval: r.skipped.length, problems: r.problems.length });
  wixReportFailure_(r.failed.map(function (f) { return (f.collection ? f.collection + ' ' : '') + (f.key ? f.key + ': ' : '') + f.error; })
    .concat(r.refused ? ['removals refused: ' + r.refused] : []));
  var line = 'sent ' + r.send.featured.length + ' card(s) and ' + r.send.days.length + ' day(s), removed '
           + (r.remove.featured.length + r.remove.days.length) + ', unchanged ' + r.unchanged
           + (r.pruned_past_days ? ', pruned ' + r.pruned_past_days + ' past day(s)' : '');
  if (r.failed.length) console.warn('[spiff] deals page: ' + r.failed.length + ' write(s) FAILED — ' + line + ' — '
    + r.failed.map(function (f) { return (f.key || f.collection || '') + ' (' + f.error + ')'; }).join('; '));
  else console.log('[spiff] deals page: ' + line);
  if (r.refused) console.warn('[spiff] deals page REFUSED removals: ' + r.refused);
  if (r.menu_slug_fixes.length) console.warn('[spiff] deals page: Vendors Menu Slug disagrees with Dutchie for '
    + r.menu_slug_fixes.map(function (f) { return f.vendor + ' (' + f.menu_slug_now + ' → ' + f.should_be + ')'; }).join(', '));
  if (r.site && (r.site.send_week.length || r.site.send_vendors.length || r.site.remove_week.length))
    console.log('[spiff] deals page: weekly ' + r.site.send_week.length + ' sent, ' + r.site.remove_week.length
      + ' removed; vendors ' + r.site.send_vendors.length + ' sent');
  return r;
}

/* ═════════════ THE DEALS PAGE, PART 2: WEEKLY DEALS AND VENDORS (Sky, 2026-11-02) ════════════════
 * Goal: nobody edits /deals in Wix. Featured cards and vendor days already come from programs (above).
 * This is the rest: the Tue–Sat schedule (Wix collection Import1, "Weekly Deals", keyed weekKey) and
 * the brand tiles (Vendors, keyed vendorKey), edited on SPIFF's Deals page screen and published by the
 * same hourly step, through the same GX Core gate (GXCore v366+: app=spiff, approvedBy on the list).
 *
 * WHERE IT LIVES. The `site_deals` tab, one row per weekly line (kind=week) or brand (kind=vendor).
 * NOT `programs`: a weekly line has no window, pays nobody and must never reach a kiosk. Nothing that
 * pays, publishes to Core or feeds a kiosk reads this tab (tests/marketing_pay_isolation_test.js).
 * Rows are never deleted: a weekly line taken off the page is status=removed. A brand is never
 * removed at all, because every Featured card and vendor day points at its Vendors row by _id.
 *
 * APPROVAL, as for a program's page copy: only Sky, Mike or Tawny (WIX_APPROVERS_) can approve, signed
 * by the session, never by what the browser says. Anyone else changing a line un-approves it; an
 * approver changing it re-signs it. A line whose copy breaks an OLCC rule cannot be approved, and is
 * not published if it somehow is.
 *
 * TAKING OVER THE HAND-MADE ROWS. ?action=adoptSite (secret, dry unless apply=1) lists every Wix row
 * with no key and the key it would get, then GX Core's wix_adopt stamps that key onto the SAME row (so
 * its _id, and every logo link, survive) and the row is copied in here UN-approved. An un-approved
 * row is never written or removed: Wix keeps showing it exactly as it is until someone ticks it here,
 * from which point SPIFF owns it. A Wix row with no key is never touched, and GX Core refuses to insert
 * a second one beside it.
 *
 * Publishing runs inside wixPublish_, so it shares its switch (WIX_PUBLISH_ON), its dry run
 * (?action=publishToWix shows `site`), its failure report and its place last in the hourly job. */
var SITE_TAB = 'site_deals';
var SITE_HEADERS = ['key', 'kind', 'day', 'row', 'brand', 'amount', 'text', 'logo', 'logo_wide', 'menu_slug', 'status',
                    'approved_by', 'approved_at', 'wix_id', 'updated_by', 'updated_at'];
/* The page's week starts on Tuesday: daySort is the position here, as on the hand-made rows (TUE = 1). */
var SITE_DAYS_ = ['TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'MON'];
var SITE_MAX_REMOVES_ = 10;
/* amount, approved_at, updated_at (1-based columns). */
var SITE_TEXT_COLS_ = [6, 13, 16];
var SITE_LOGO_SPEC_ = { bytes: 512000, types: ['image/png', 'image/jpeg', 'image/svg+xml'] };

function siteSheet_() {
  var book = dataSheet_().getParent();
  var sh = book.getSheetByName(SITE_TAB);
  if (!sh) {
    sh = book.insertSheet(SITE_TAB);
    sh.getRange(1, 1, 1, SITE_HEADERS.length).setValues([SITE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    /* "$2" and "15%" are text; so are the stamps. Pinned before the first row is written. */
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    SITE_TEXT_COLS_.forEach(function (c) { sh.getRange(2, c, rows, 1).setNumberFormat('@'); });
  }
  return sh;
}

/* Write one entry (at = its index in readSite_, or -1 for a new row). appendRow parses what it is
   given like typing and ignores the column's text format: the takeover's "$2" was stored as the
   number 2 in a currency format (2026-11-03), and Approve all then refused every weekly line. So the
   row is re-pinned to text first, every time, and never appended. */
function siteWrite_(sh, at, s) {
  var rowNo = at >= 0 ? at + 2 : sh.getLastRow() + 1;
  if (rowNo > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 1);
  SITE_TEXT_COLS_.forEach(function (c) { sh.getRange(rowNo, c).setNumberFormat('@'); });
  sh.getRange(rowNo, 1, 1, SITE_HEADERS.length).setValues([siteToRow_(s)]);
}

function rowToSite_(r) {
  var o = {};
  SITE_HEADERS.forEach(function (h, i) { o[h] = r[i] == null ? '' : String(r[i]); });
  o.row = Number(o.row) || 0;
  return o;
}
function siteToRow_(s) { return SITE_HEADERS.map(function (h) { return s[h] == null ? '' : s[h]; }); }

function readSite_() {
  var sh = siteSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  var range = sh.getRange(2, 1, last - 1, SITE_HEADERS.length), vals = range.getValues();
  /* An amount the sheet turned into a number (see siteWrite_) is read as the sheet shows it: 2 in a
     "$" format reads "$2", 0.15 in a percent format "15%". The next write stores it as text again. */
  var shown = range.getDisplayValues(), a = SITE_HEADERS.indexOf('amount');
  vals.forEach(function (r, i) { if (typeof r[a] === 'number') r[a] = shown[i][a]; });
  return vals.filter(function (r) { return r[0]; }).map(rowToSite_);
}

/* What a person typed, as one comparable value: a change to any of it un-approves the line. */
function siteContent_(s) {
  return JSON.stringify(s.kind === 'vendor'
    ? [s.brand, s.logo, s.logo_wide, s.menu_slug]
    : [s.day, Number(s.row) || 0, s.brand, s.amount, s.text]);
}

/* Why this line cannot go on the page, or ''. */
function siteProblem_(s) {
  if (s.kind === 'vendor') {
    if (!String(s.brand || '').trim()) return 'the brand needs a name';
    var bad = [s.logo, s.logo_wide].filter(function (u) { return u && !/^wix:image:\/\//.test(u); });
    if (bad.length) return 'a logo must be picked from or imported into Wix Media';
    return wixCopyProblem_([s.brand]) ? 'the brand name breaks the copy rules ("' + wixCopyProblem_([s.brand]) + '")' : '';
  }
  if (SITE_DAYS_.indexOf(s.day) < 0) return 'pick a day';
  if (!String(s.brand || '').trim()) return 'pick a brand';
  if (!/^(\$\d+(\.\d{2})?|\d{1,2}%)$/.test(String(s.amount || ''))) return 'the amount must be a straight discount, like $2 or 15%';
  if (!String(s.text || '').trim()) return 'say what it is off';
  var nb = String(s.brand).trim().length, nt = String(s.text).trim().length;
  if (nb > WIX_COPY_LIMITS_.week_brand) return 'the brand is ' + nb + ' characters; the most is ' + WIX_COPY_LIMITS_.week_brand;
  if (nt > WIX_COPY_LIMITS_.week_text) return 'what it is off is ' + nt + ' characters; the most is ' + WIX_COPY_LIMITS_.week_text;
  var broken = wixCopyProblem_([s.brand, s.amount, s.text]);
  return broken ? 'the copy breaks the OLCC copy rules ("' + broken + '")' : '';
}

/* The approval after a save. `approve` is the tick as the screen shows it. Returns {by, at} or {error}. */
function siteSign_(before, after, user, approve) {
  var who = String(user || '').toLowerCase();
  var approver = WIX_APPROVERS_.indexOf(who) >= 0;
  var changed = !before || siteContent_(before) !== siteContent_(after);
  var had = before && WIX_APPROVERS_.indexOf(String(before.approved_by || '').toLowerCase()) >= 0
    ? { by: before.approved_by, at: before.approved_at } : { by: '', at: '' };
  if (!approver) return changed ? { by: '', at: '' } : had;
  if (!approve) return { by: '', at: '' };
  var problem = siteProblem_(after);
  if (problem) return { error: 'Not approved: ' + problem + '.' };
  return changed || !had.by ? { by: who, at: nowStamp_() } : had;
}

/* Signed-in read, from the sheet each time (the tab is tiny, and a removed line must not reappear
   from a cache). */
function siteDealsRead_() {
  var rows = readSite_();
  return { ok: true, weekly: rows.filter(function (s) { return s.kind === 'week' && s.status !== 'removed'; }),
           vendors: rows.filter(function (s) { return s.kind === 'vendor'; }),
           days: SITE_DAYS_, approvers: WIX_APPROVERS_ };
}

/* Create or change one line or brand. p.item = {key?, kind, day, row, brand, amount, text, logo,
   logo_wide, menu_slug, approve}. Under the script lock, against what is stored NOW. */
function saveSiteDeal_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var it = parseJson_(p.item, null);
  if (!it || (it.kind !== 'week' && it.kind !== 'vendor')) return { ok: false, error: 'Nothing to save.' };
  var t = function (x, n) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n); };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another save is in progress. Try again in a moment.' };
  try {
    var sh = siteSheet_(), rows = readSite_();
    var key = t(it.key, 60);
    if (!key && it.kind === 'vendor') key = wixMenuSlug_(it.brand);
    var at = -1;
    rows.forEach(function (s, i) { if (s.key === key && key) at = i; });
    var before = at >= 0 ? rows[at] : null;
    if (before && before.kind !== it.kind) return { ok: false, error: 'That key belongs to a ' + before.kind + ' row.' };
    if (!before && it.key) return { ok: false, error: 'That line is not there any more. Reload.' };
    if (!key && it.kind === 'vendor') return { ok: false, error: 'Name the brand.' };
    if (!key) key = 'wk-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36);
    var s = Object.assign({}, before || { key: key, kind: it.kind, status: 'live', wix_id: '' });
    if (it.kind === 'week') {
      s.day = t(it.day, 3).toUpperCase(); s.row = Math.max(1, Math.min(9, Number(it.row) || 1));
      s.brand = t(it.brand, 60); s.amount = t(it.amount, 8); s.text = t(it.text, 120);
    } else {
      s.brand = t(it.brand, 60) || (before && before.brand) || '';
      ['logo', 'logo_wide'].forEach(function (f) { if (it[f] != null) s[f] = t(it[f], 400); });
      if (it.menu_slug != null) s.menu_slug = wixMenuSlug_(it.menu_slug);
    }
    var sign = siteSign_(before, s, who.auth.user, !!it.approve);
    if (sign.error) return { ok: false, error: sign.error };
    s.approved_by = sign.by; s.approved_at = sign.at;
    s.updated_by = who.auth.user; s.updated_at = nowStamp_();
    siteWrite_(sh, at, s);
    return { ok: true, item: s, created: at < 0, problem: siteProblem_(s) };
  } finally {
    lock.releaseLock();
  }
}

/* Take a weekly line off the page: status=removed, and the next hourly run deletes it from Wix. */
function removeSiteDeal_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another save is in progress. Try again in a moment.' };
  try {
    var rows = readSite_(), at = -1;
    rows.forEach(function (s, i) { if (s.key === String(p.key || '')) at = i; });
    if (at < 0) return { ok: false, error: 'That line is not there any more.' };
    var s = rows[at];
    if (s.kind !== 'week') return { ok: false, error: 'A brand stays: every card on the page points at its logo.' };
    s.status = 'removed'; s.updated_by = who.auth.user; s.updated_at = nowStamp_();
    siteWrite_(siteSheet_(), at, s);
    return { ok: true, key: s.key, removed: true };
  } finally {
    lock.releaseLock();
  }
}

/* Approve every live line and brand that is waiting, in one press (Sky, 2026-11-02: sixteen tick-and-
   saves after the takeover). Approvers only, signed by the session like a single tick. A row whose
   copy breaks a rule is skipped and named, never approved. Changes no content, so nothing that was
   approved before is re-signed. */
function approveSiteDeals_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var user = String(who.auth.user || '').toLowerCase();
  if (WIX_APPROVERS_.indexOf(user) < 0) return { ok: false, error: 'Only Sky, Mike or Tawny can approve the deals page.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Another save is in progress. Try again in a moment.' };
  try {
    var sh = siteSheet_(), rows = readSite_(), approved = [], skipped = [];
    rows.forEach(function (s, i) {
      if (s.status !== 'live' || WIX_APPROVERS_.indexOf(String(s.approved_by || '').toLowerCase()) >= 0) return;
      var problem = siteProblem_(s);
      if (problem) { skipped.push({ key: s.key, problem: problem }); return; }
      s.approved_by = user; s.approved_at = nowStamp_(); s.updated_by = user; s.updated_at = s.approved_at;
      siteWrite_(sh, i, s);
      approved.push(s.key);
    });
    return { ok: true, approved: approved, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

/* THE FEATURED IMAGE PICKER (Sky, 2026-11-03: "make the image box a selection tool, so that it's
   easier for the user to click & select"; source: the vendor's Drive folder). The images in the
   program's vendor files folder (d.files.url when it is a Drive folder, else the vendor's folder under
   Marketing ▸ Vendors, never created here) and one level of subfolders, newest first, each checked
   against the Featured image spec so the screen can grey out a file the publisher would refuse.
   A read: editor session, nothing written. Vendors upload there, and the folder is shared "anyone with
   the link", so the screen's thumbnails load the same way the existing preview does. */
var WEB_IMAGES_MAX_ = 60;
var WEB_IMAGES_SUBFOLDERS_ = 20;
function webFolderId_(url) {
  var m = String(url || '').match(/\/folders\/([-\w]{10,})/);
  return m ? m[1] : '';
}
function driveList_(q, fields) {
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true'
    + '&corpora=allDrives&pageSize=200&orderBy=' + encodeURIComponent('modifiedTime desc')
    + '&q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(' + fields + ')'), {
    method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Drive said ' + code + ': ' + String(text).slice(0, 200));
  return (JSON.parse(text || '{}').files) || [];
}
function webImages_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var res = getProgram_(p.id);
  if (!res.ok) return res;
  var prog = res.program, plan = normalizeMarketing_(prog.marketing_json) || {};
  var url = String(((plan.d || {}).files || {}).url || '');
  var folder = webFolderId_(url);
  if (!folder) {
    var v = null;
    try { v = vendorFolderFor_(prog.vendor, false); } catch (e) { v = null; }
    if (v && v.id) { folder = v.id; url = v.url; }
  }
  if (!folder) return { ok: true, folder_url: '', files: [], why: 'no_folder' };
  try {
    var subs = driveList_("'" + folder + "' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'", 'id')
      .slice(0, WEB_IMAGES_SUBFOLDERS_).map(function (f) { return f.id; });
    var parents = [folder].concat(subs).map(function (id) { return "'" + id + "' in parents"; }).join(' or ');
    var files = driveList_('(' + parents + ") and trashed = false and mimeType contains 'image/'",
                           'id,name,mimeType,size,modifiedTime,imageMediaMetadata(width,height)');
  } catch (e) {
    return { ok: false, error: 'Could not read the vendor folder: ' + scrubSecrets_((e && e.message) || e) };
  }
  return { ok: true, folder_url: url, files: files.slice(0, WEB_IMAGES_MAX_).map(function (f) {
    var im = f.imageMediaMetadata || {};
    return { id: f.id, name: f.name, width: Number(im.width) || 0, height: Number(im.height) || 0,
             url: 'https://drive.google.com/file/d/' + f.id + '/view', problem: wixImageProblem_(f) };
  }) };
}

/* Logos already in Wix Media, by name, for the picker. A read: editor session, nothing written. */
function siteMediaSearch_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  try { return GXCore.wixMediaSearch(secret, String(p.q || '').slice(0, 60), { limit: 40 }); }
  catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_((e && e.message) || e) }; }
}

/* A logo from Drive (the brand's own folder under Marketing ▸ Vendors) into Wix Media. Checked against
   the logo spec first; the answer is a wix:image value for the screen to save on the brand. An image
   in Wix Media shows nowhere until an approved brand points at it. */
function siteImportLogo_(p) {
  var who = mktEditor_(p, 'edit the deals page');
  if (who.fail) return who.fail;
  var id = wixDriveFileId_(p.url);
  if (!id) return { ok: false, error: 'Paste a Google Drive file link.' };
  var meta;
  try { meta = driveApi_('get', encodeURIComponent(id) + '?supportsAllDrives=true&fields=' + encodeURIComponent('name,mimeType,size')); }
  catch (e) { return { ok: false, error: 'Drive could not read that file: ' + String((e && e.message) || e).slice(0, 120) }; }
  if (SITE_LOGO_SPEC_.types.indexOf(String(meta.mimeType || '')) < 0) return { ok: false, error: 'A logo must be a PNG, JPG or SVG.' };
  if (Number(meta.size) > SITE_LOGO_SPEC_.bytes) return { ok: false, error: 'That file is over 500 KB.' };
  var name = wixMenuSlug_(p.brand || 'brand') + (String(p.which) === 'logo_wide' ? '-logo-wide' : '-logo')
           + (meta.mimeType === 'image/jpeg' ? '.jpg' : meta.mimeType === 'image/svg+xml' ? '.svg' : '.png');
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  try {
    var r = GXCore.wixImportImage(secret, 'https://lh3.googleusercontent.com/d/' + id,
      { display_name: name, mime_type: meta.mimeType, apply: true, app: WIX_PUBLISHER_APP_, by: who.auth.user });
    if (r && r.wix_image) return { ok: true, wix_image: r.wix_image, name: name };
    if (r && r.file_id) return { ok: true, pending: true, file_id: r.file_id, note: 'Wix is still processing it. Search for ' + name + ' in a minute.' };
    return { ok: false, error: 'Wix could not import it: ' + scrubSecrets_((r && r.error) || 'no answer') + '. Is the file shared "anyone with the link"?' };
  } catch (e) { return { ok: false, error: 'GX Core unavailable: ' + scrubSecrets_((e && e.message) || e) }; }
}

function siteFoldDay_(d) { var x = String(d == null ? '' : d).trim().toUpperCase().slice(0, 3); return SITE_DAYS_.indexOf(x) >= 0 ? x : ''; }

/* THE ADOPTION PLAN. Pure: the Wix rows and what this tab already holds in, the keys and the rows to
   copy in out. Weekly: <day>-<row> ("tue-1"), as the page orders them. Vendors: the brand's slug in
   GX Core's registry (matched by name or other spelling), else the Wix title slugged. */
function siteAdoptPlan_(week, vendors, brands, entries) {
  var have = Object.create(null), haveWix = Object.create(null);
  (entries || []).forEach(function (s) { have[s.key] = 1; if (s.wix_id) haveWix[s.wix_id] = 1; });
  var out = { week: [], vendors: [], problems: [] };
  var used = Object.create(null);
  Object.keys(have).forEach(function (k) { used[k] = 1; });
  (week || []).filter(function (r) { return !String(r.weekKey || '').trim(); })
    .sort(function (a, b) { return (a.daySort || 0) - (b.daySort || 0) || (a.rowSort || 0) - (b.rowSort || 0); })
    .forEach(function (r) {
      if (haveWix[r._id]) return;
      var day = siteFoldDay_(r.day);
      if (!day) { out.problems.push({ wix_id: r._id, problem: 'Weekly Deals row "' + (r.title || '') + '" has no readable day (' + r.day + '); fix or delete it in Wix' }); return; }
      var n = Number(r.rowSort) || 1, key = day.toLowerCase() + '-' + n;
      while (used[key]) key = day.toLowerCase() + '-' + (++n);
      used[key] = 1;
      out.week.push({ wix: { _id: r._id, weekKey: key },
        entry: { key: key, kind: 'week', day: day, row: Number(r.rowSort) || 1, brand: String(r.title || ''),
                 amount: String(r.amount || ''), text: String(r.text || ''), status: 'live', wix_id: r._id } });
    });
  var reg = Object.create(null);
  (brands || []).forEach(function (b) {
    [b.display_name].concat(Array.isArray(b.aliases) ? b.aliases : []).forEach(function (n) { var f = wixFold_(n); if (f && !reg[f]) reg[f] = b; });
  });
  (vendors || []).filter(function (v) { return !String(v.vendorKey || '').trim(); }).forEach(function (v) {
    if (haveWix[v._id]) return;
    var b = reg[wixFold_(v.title)] || [].concat(v.aliases || []).map(function (a) { return reg[wixFold_(a)]; }).filter(Boolean)[0];
    var key = wixMenuSlug_(b ? b.display_name : v.title);
    if (!key) { out.problems.push({ wix_id: v._id, problem: 'Vendors row with no title; fix or delete it in Wix' }); return; }
    if (used[key]) { out.problems.push({ wix_id: v._id, problem: 'Vendors "' + v.title + '" would take key ' + key + ', which is already in use; two Vendors rows for one brand? Delete the extra one in Wix' }); return; }
    used[key] = 1;
    if (!b) out.problems.push({ wix_id: v._id, problem: '"' + v.title + '" is not in GX Core\'s brand list; adopted under ' + key + ', add the brand in Settings so its other spellings come along' });
    out.vendors.push({ wix: { _id: v._id, vendorKey: key },
      entry: { key: key, kind: 'vendor', brand: String(v.title || ''), logo: String(v.logo || ''), logo_wide: String(v.logoWide || ''),
               menu_slug: String(v.menuSlug || ''), status: 'live', wix_id: v._id } });
  });
  return out;
}

function adoptSite_(p) {
  var secret = PropertiesService.getScriptProperties().getProperty(GX_SECRET_PROP);
  if (!secret || String(p.secret || '') !== secret) return { ok: false, error: 'Unauthorized' };
  var apply = String(p.apply || '') === '1';
  try {
    var must = function (r, what) { if (!r || r.ok === false) throw new Error(what + ' failed: ' + scrubSecrets_((r && r.error) || 'no answer')); return r; };
    var week = must(GXCore.wixRead(secret, 'Import1', { limit: 1000 }), 'wix_read Import1').items || [];
    var vendors = must(GXCore.wixVendors(secret), 'wix_vendors').vendors || [];
    var brands = GXCore.getBrands({ all: true }) || [];
    var plan = siteAdoptPlan_(week, vendors, brands, readSite_());
    var out = { ok: true, apply: apply, week: plan.week.map(function (x) { return x.entry; }),
                vendors: plan.vendors.map(function (x) { return x.entry; }), problems: plan.problems };
    if (!apply) { out.note = 'dry run — nothing adopted. Every row comes in un-approved; Wix keeps showing it as it is until it is ticked in SPIFF. Send apply=1 to adopt.'; return out; }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return { ok: false, error: 'Another save is in progress.' };
    try {
      [['Import1', plan.week], ['Vendors', plan.vendors]].forEach(function (c) {
        if (!c[1].length) return;
        var r = GXCore.wixAdopt(secret, c[0], c[1].map(function (x) { return x.wix; }), { apply: true, app: WIX_PUBLISHER_APP_, by: 'spiff' });
        if (!r || r.ok === false) throw new Error('GX Core refused to adopt ' + c[0] + ': ' + scrubSecrets_((r && r.error) || JSON.stringify((r && r.results) || [])));
        var sh = siteSheet_();
        c[1].forEach(function (x) { x.entry.updated_by = 'spiff'; x.entry.updated_at = nowStamp_(); siteWrite_(sh, -1, x.entry); });
      });
    } finally { lock.releaseLock(); }
    return out;
  } catch (e) { return { ok: false, error: scrubSecrets_((e && e.message) || e) }; }
}

/* WHAT TO SEND for the weekly lines and brands, given what Wix holds. Pure. */
function sitePlan_(entries, week, vendors, brands) {
  var out = { send_week: [], remove_week: [], send_vendors: [], waiting: [], problems: [], unchanged: 0, hand_made: 0, refused: '' };
  var byKey = function (rows, f) { var m = Object.create(null); (rows || []).forEach(function (r) { var k = String(r[f] || ''); if (k) m[k] = r; else out.hand_made++; }); return m; };
  var wk = byKey(week, 'weekKey'), vk = byKey(vendors, 'vendorKey');
  var reg = Object.create(null);
  (brands || []).forEach(function (b) { var f = wixFold_(b.display_name); if (f && !reg[f]) reg[f] = b; });
  (entries || []).forEach(function (s) {
    var label = s.kind === 'vendor' ? s.brand : s.day + ' ' + s.brand + ' ' + s.amount;
    if (s.kind === 'week' && s.status === 'removed') { if (wk[s.key]) out.remove_week.push(s.key); return; }
    if (s.status !== 'live') return;
    var by = String(s.approved_by || '').toLowerCase();
    if (WIX_APPROVERS_.indexOf(by) < 0) { out.waiting.push({ key: s.key, what: label }); return; }
    var problem = siteProblem_(s);
    if (problem) { out.problems.push({ key: s.key, what: label, problem: problem }); return; }
    var item;
    if (s.kind === 'week') {
      item = { weekKey: s.key, title: s.brand, day: s.day, daySort: SITE_DAYS_.indexOf(s.day) + 1, rowSort: Number(s.row) || 1,
               amount: s.amount, text: s.text };
      if (wk[s.key] && wixSameItem_(wk[s.key], item)) { out.unchanged++; return; }
      item[WIX_APPROVER_FIELD_] = by; out.send_week.push(item);
    } else {
      item = { vendorKey: s.key, title: s.brand };
      var b = reg[wixFold_(s.brand)];
      if (b && Array.isArray(b.aliases) && b.aliases.length) item.aliases = b.aliases.slice();
      if (s.logo) item.logo = s.logo;
      if (s.logo_wide) item.logoWide = s.logo_wide;
      if (s.menu_slug) item.menuSlug = s.menu_slug;
      if (vk[s.key] && wixSameItem_(vk[s.key], item)) { out.unchanged++; return; }
      item[WIX_APPROVER_FIELD_] = by; out.send_vendors.push(item);
    }
  });
  if (out.remove_week.length > SITE_MAX_REMOVES_) { out.refused = 'would take ' + out.remove_week.length + ' weekly lines off (limit ' + SITE_MAX_REMOVES_ + ')'; out.remove_week = []; }
  return out;
}

/* One pass for the weekly lines and brands. `vendors` is the Vendors read wixPublish_ already made. */
function sitePublish_(w, vendors, apply, entries) {
  var week = w.read('Import1');
  var brands = [];
  try { brands = w.brands ? w.brands() : []; } catch (e) { brands = []; }
  var plan = sitePlan_(entries || readSite_(), week, vendors, brands);
  plan.failed = [];
  if (!apply) return plan;
  var send = function (coll, items) {
    if (!items.length) return;
    try {
      var r = w.upsert(coll, items);
      if (!r || (r.ok === false && !r.results)) throw new Error(scrubSecrets_((r && r.error) || 'no answer'));
      (r.results || []).forEach(function (x) {
        if (['inserted', 'updated', 'unchanged'].indexOf(x.op) < 0) plan.failed.push({ collection: coll, key: x.key, error: x.error || x.op });
      });
    } catch (e) { plan.failed.push({ collection: coll, error: String((e && e.message) || e) }); }
  };
  send('Vendors', plan.send_vendors);
  send('Import1', plan.send_week);
  if (plan.remove_week.length) {
    try { var r = w.remove('Import1', plan.remove_week); if (!r || r.ok === false) throw new Error(scrubSecrets_((r && (r.error || JSON.stringify(r.errors || []))) || 'no answer')); }
    catch (e) { plan.failed.push({ collection: 'Import1', error: 'remove: ' + String((e && e.message) || e) }); }
  }
  return plan;
}
