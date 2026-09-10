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
  'pitch_json'
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
  'contact_name', 'contact_email', 'pitch_json'
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
                      'publishKioskTokens'];

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
      /* One-time correction of the pay-period column on rows that predate the derivation.
         Secret-gated, dry by default — see backfillPayPeriods_. */
      case 'backfillPayPeriods': out = backfillPayPeriods_(p);                      break;
      case 'employees':   out = gxEmployees_();                                     break;
      case 'diag':        out = diag_();                                            break;
      case 'buildReport': out = buildReport_(p);                                    break;
      case 'emailDraft':  out = emailDraft_(p);                                     break;
      case 'giftCards':   out = giftCardList_(p);                                   break;
      case 'clientView':  out = clientView_(p);                                     break;
      case 'shareLink':   out = shareLink_(p);                                      break;
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
      case 'deleteProgram': out = deleteProgram_(body);               break;
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
  // plan: 'Drops' was modeled at $25/BT but settled at $50/BT (26 BTs × $50 = the
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
    pay_period:    '',            // derived from start_date on write — see programToRow_
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
  if (names.some(function (n) { return n.toLowerCase().indexOf(lower) >= 0; })) return { checked: true, ok: true };

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
  EDITABLE_FIELDS.forEach(function (f) {
    // patch is JSON.parse'd from the request: a key literally named "hasOwnProperty" would
    // shadow the method and turn this into a TypeError. Call it off the prototype instead.
    if (!Object.prototype.hasOwnProperty.call(patch, f)) return;
    if (JSON.stringify(merged[f]) === JSON.stringify(patch[f])) return;
    merged[f] = patch[f];
    changed.push(f);
  });
  if (!changed.length) return { ok: true, program_id: p.id, unchanged: true };

  var res = saveProgram_(merged, { editedBy: auth.user, confirmBrand: String(p.confirm_brand || '') === '1' });
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

  var res = saveProgram_(draft, { editedBy: auth.user, confirmBrand: String(p.confirm_brand || '') === '1' });
  res.program_id = id;
  return res;
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
  deletedSheet_().appendRow(
    programToRow_(prog, { edited_by: prog.edited_by, edited_at: prog.edited_at })
      .concat([auth.user, nowStamp_(), 'renamed to ' + to]));

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
    return { ok: false, error: 'This program is closed — it ran, was reported to the vendor and was '
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
  deletedSheet_().appendRow(
    programToRow_(prog, { edited_by: prog.edited_by, edited_at: prog.edited_at })
      .concat([auth.user, nowStamp_(), String(p.reason || '').slice(0, 500)]));

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

/* Validate a GX Core session token and resolve this user's role on `spiff`.
   Memoized for the life of ONE execution: guard_ now validates before the switch, and the
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
    /* Deliberately NOT memoized: a transient Core hiccup must not pin this execution into a
       failure it would recover from on the next call. */
    return { ok: false, error: 'Could not reach GX Core to verify your session' };
  }
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
    JSON.stringify(normalizePitch_(p.pitch_json))
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
    pitch_json: normalizePitch_(parseJson_(r[25], null))
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
        refused[prog.program_id] = { fp: fp, at: nowStamp_(), reason: res.refused,
                                     error: String(res.error || '').slice(0, 200) };
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
             undated_program_ids: dedupe_(undated) };
  }

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
      refreshed_at: rows.reduce(function (n, r) {
        var t = String(r.refreshed_at || ''); return t > n ? t : n;
      }, ''),
      /* Carried through verbatim: they describe the whole cache, not this slice, and a consumer
         that wants to refuse a payload with orphans needs to see them. */
      orphan_rows: all.orphan_rows || 0,
      orphan_program_ids: all.orphan_program_ids || [],
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
           undated_program_ids: dedupe_(undated) };
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

function refreshSpiffProgressTrigger() {
  try { rollProgramStatuses_(); }
  catch (e) { console.warn('[spiff] status roll failed: ' + ((e && e.message) || e)); }
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
  refreshSpiffProgress_();
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

  var rows = [], newest = '', orphans = Object.create(null), orphanRows = 0;
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
           refreshed_at: newest,
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
    return { ok: false, error: 'GX Core unreachable: ' + scrubSecrets_(e && e.message || e) };
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

  return { ok: true, links: links,
           missing: links.filter(function (x) { return !x.token; }).length };
}

/* ═════════ PUBLISH THE KIOSK TOKEN TO GX CORE, AT MINT AND AT ROTATE ═════════
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
 * closed and the kiosk button silently stops appearing, so: leave it as the HTTP call.
 *
 * SENSITIVITY. These tokens open store.html, which carries no person, no cost and no margin by
 * construction. The per-employee earnings we already publish to Core are strictly more sensitive.
 *
 * AN EMPTY VALUE IS THE OFF SWITCH, and that is Leaderboard's contract, not our invention:
 * spiffKioskUrl_ returns '' for an empty token and no token means no button. So a revoke writes
 * '' rather than deleting the key — a revoked link whose key lingers is a kiosk button onto a dead
 * page, the same failure as a stale copy arriving a different way.
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
        'SPIFF kiosk link token for ' + id + '. Written by the SPIFF engine at mint/rotate and '
      + 'blanked on revoke; empty means no token and no kiosk button. Do not edit by hand — '
      + 'the value here must match the live row in SPIFF store_links or the button opens a dead page.');

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
 * presses is six chances to stop at five, and the store that gets missed shows a blank kiosk
 * nobody is standing next to. Idempotent — a store that already has a live link is skipped. */
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
       leaves a kiosk pointing at a token no store_links row will ever match — a live button onto a
       dead page, which is worse than no button. This order makes the failure recoverable instead:
       the link exists and works in SPIFF, and republishing is one call. */
    var r = gxPublishKioskToken_(id, tok);
    (r.ok ? published : failed).push(r.ok ? id : { store_id: id, error: r.error });
  });

  /* A PARTIAL PUBLISH IS REPORTED, NEVER SWALLOWED. If Core is unreachable the links are still
     minted and still correct here, but no kiosk will show a button — and the panel saying a
     cheerful "minted 6" over that is how a person concludes the job is done and stops looking. */
  return { ok: true, minted: made, published: published, publish_failed: failed,
           publish_note: failed.length
             ? 'Minted, but ' + failed.length + ' token(s) did not reach GX Core, so those kiosks '
               + 'will show no SPIFF button. Re-run ?action=publishKioskTokens&apply=1 once Core '
               + 'is reachable — nothing needs re-minting.'
             : '' };
}

/* Revoke one store's link and mint its replacement in the same call — a kiosk with no link is a
 * blank screen, so "revoke" in practice always means "rotate".
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

  /* REVOKE: blank the key rather than leaving it. Leaderboard treats an empty value as "no token,
     no button", so this takes the button off the kiosk instead of leaving one that opens the
     "ask Tawny for a new one" page. A revoked link whose kv key lingers is the same failure as a
     stale pasted copy, arriving a different way. */
  if (String(p.revoke || '') === '1') {
    var cleared = gxPublishKioskToken_(id, '');
    return { ok: true, store_id: id, token: '', revoked: true,
             published: cleared.ok,
             publish_error: cleared.ok ? '' : cleared.error,
             publish_note: cleared.ok ? ''
               : 'The link is revoked HERE, but GX Core still holds the old token, so that kiosk '
                 + 'will keep showing a SPIFF button that opens a dead page. Re-run '
                 + '?action=publishKioskTokens&apply=1 to clear it.' };
  }

  var tok = Utilities.getUuid().replace(/-/g, '');
  sh.appendRow([id, tok, auth.user, stamp, '']);

  var pub = gxPublishKioskToken_(id, tok);
  return { ok: true, store_id: id, token: tok,
           published: pub.ok,
           publish_error: pub.ok ? '' : pub.error,
           publish_note: pub.ok ? ''
             : 'The new link works HERE, but GX Core still holds the OLD token — which this call '
               + 'just revoked — so that kiosk shows a button onto a dead page until it is '
               + 'republished. Re-run ?action=publishKioskTokens&apply=1.' };
}

/* ═══ BACKFILL / REPAIR: push every live kiosk token to GX Core in one call ═══
 * Two jobs, and they are the same job.
 *
 * BACKFILL, once: six links already existed in store_links before any of this was written. They
 * were never waiting on Sky or Tawny to paste them anywhere — they simply never left this app,
 * which is why every kiosk shows no SPIFF button today. Nothing reaches Leaderboard until this runs.
 *
 * REPAIR, from then on: mint and rotate publish as they go, but a publish can fail while the sheet
 * write succeeds — Core unreachable, a lapsed authorization, a bad minute on the second hop. Those
 * paths say so rather than swallowing it, and this is what they tell you to run. It is idempotent,
 * so running it when nothing is wrong costs six writes and changes nothing.
 *
 * IT ALSO CLEARS REVOKED STORES, which is why it walks the STORE REGISTRY rather than the live
 * rows. Iterating live links alone would republish the good ones and leave a revoked store's stale
 * token sitting in Core forever — a kiosk button onto a dead page, and the one case where doing
 * nothing looks identical to success.
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
    var act = tok ? 'publish' : 'clear';   // clear covers revoked AND never-minted; both mean no button
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

  var store = hit.store_id, storeLabel = store;
  try {
    (gxStores_() || []).forEach(function (x) {
      if (slug_(x.store_id) === store && x.display_name) storeLabel = x.display_name;
    });
  } catch (e) { /* the slug is a poor label, but better than none */ }

  /* Dates are TEXT and compared as text — lexicographic order IS chronological for YYYY-MM-DD,
     so this never coerces a Date and never trips the timezone shift. Same rule as flyer_. */
  var today = nowStamp_().slice(0, 10);
  var out = [];
  listPrograms_().forEach(function (pr) {
    var st = String(pr.status || '').toLowerCase();
    var a = pr.start_date || '', b = pr.end_date || '';
    if (st === 'closed' || !a || !b) return;
    if (!(a <= today && today <= b)) return;
    var mine = (pr.stores_json || []).some(function (x) { return slug_(x && x.store_id ? x.store_id : x) === store; });
    if (!mine) return;

    var tgt = pr.target_json || {};
    var pitch = normalizePitch_(pr.pitch_json);
    out.push({
      program_id: pr.program_id,
      /* The joined label is built in the browser from vendor + name, exactly as the operator app
         does it — one rule, not two that agree by luck. */
      vendor: pr.vendor || '', program_name: pr.program_name || pr.title || '',
      start_date: a, end_date: b,
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
  return { ok: true, store_id: store, store_name: storeLabel, today: today, programs: out };
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
      byStore[st.store_id] = Number(st.units) || 0;
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
  return { rows: rows, by_store: byStore, source: source };
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
      + (showTarget ? '<td class="n">' + tgt + '</td>' : '')
      + '<td class="n">' + (act == null ? '&mdash;' : act) + '</td></tr>';
  }).join('');

  var matrixHtml = matrix && matrix.rows && matrix.rows.length
    ? '<h2>By budtender</h2><table><tr><th>Budtender</th><th>Store</th><th class="n">Units</th>'
      + (showTarget ? '<th class="n">Target</th><th>Hit</th>' : '<th class="n">Earned</th>')
      + '</tr>'
      + matrix.rows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td>'
            + '<td>' + esc(storeNameOf[slug_(r.store_id)] || r.store_id) + '</td>'
            + '<td class="n">' + r.units + '</td>'
            /* On per-unit, Target and Hit were a column of zeros and 38 blank cells. What the
               person actually earned is the fact that row is missing. */
            + (showTarget
                ? '<td class="n">' + r.target + '</td><td>' + (r.hit ? '✓' : '') + '</td>'
                : '<td class="n">' + money(r.earned) + '</td>')
            + '</tr>';
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
    + '<h2>By store</h2><table><tr><th>Store</th>'
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

/* The vendor email, as TEXT for a human to send. The engine has no send capability and
   should not get one — a vendor hears from Tawny, not from an app. */
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
      'Tawny\nGreen Cross Cannabis Emporium\n',
    attach_hint: 'Attach the PDF saved to the SPIFF close-out folder in Drive.',
    /* Surfaced, not buried in the body. Nothing sends from here — a human does — so the warning
       belongs where the UI can refuse to present the draft as ready. */
    warning: f.mismatch
      ? 'The recorded total (' + m(f.mismatch.stored) + ') does not match ' + f.basis + ' = '
        + m(f.mismatch.computed) + '. Verify the actuals before sending this.'
      : undefined
  };
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
  var prog = res.program;
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
    var installed = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'refreshSpiffProgressTrigger';
    });
    d.hourlyTrigger = installed ? 'installed'
      : 'MISSING - statuses will not roll and progress will not refresh';
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
      context:  String(p.context || '')
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
     why the branch below is kept rather than dropped as dead.

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
 * is for. A library call runs in the CALLING project, so Core's send spent THIS project's quota —
 * an exhausted quota refuses this send too. What it covers is everything else: a missing or bad
 * recipient (all of `mail_skipped`), a transient failure, a Core-side config problem. ?action=diag
 * reports the remaining quota so that case is visible rather than guessed at.
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
function bugNotify_(subject, lead, user, p, title, desc) {
  try {
    MailApp.sendEmail({
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

  var lastErr = '';
  for (var i = 0; i < 5; i++) {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
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
