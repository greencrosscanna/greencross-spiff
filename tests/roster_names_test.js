#!/usr/bin/env node
/* ─── The friendly name comes from Core, once ─────────────────────────────────────────────────────
 *
 *   RUN:  node tests/roster_names_test.js
 *
 * Dutchie reports the legal name ("Andrew Phillips"); staff are called something else ("Drew").
 * 19 of 76 roster people go by a different name, so any surface rendering full_name shows staff
 * their legal name unknowingly.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING, which is not the feature but the SHAPE of the fix:
 *
 *   1. THE RULE STAYS IN CORE. gxDisplayName_ exists because a name living in two places drifted
 *      — Crew corrected a record while another row kept the old spelling, and apps read the
 *      source of truth and still showed the wrong name. A copy of that derivation in this repo
 *      would agree with Core by luck rather than by construction, so deriving a name locally
 *      from preferred_name is the thing to refuse.
 *
 *   2. THE WORKAROUND MUST NOT COME BACK. This app spent five days fetching Core's
 *      ?action=employees route over HTTP with a deploy secret, because a comment here claimed the
 *      bound library returned undecorated rows. It was false when written: getEmployees() has
 *      mapped through gxDisplayName_ since fad5bac on 2026-08-19 (library @133), and this engine
 *      pins far past that. The comment even carried a "REMOVE THIS once getEmployees() decorates"
 *      marker — waiting for something that had already happened.
 *
 *   3. THE CACHE IS LOAD-BEARING, unlike the fetch it used to wrap. This sits under
 *      ?action=progress, which GX Crew's incentive column and the Leaderboard kiosks poll.
 *
 * AND THE HABIT THAT FOUND THE ORIGINAL BUG, stated because no test can replace it: v1.360
 * shipped this feature as a silent no-op with a full green suite, because the tests MOCK
 * getEmployees — a mock returns whatever you tell it to, so it can never catch the real
 * projection being wrong. It was found by probing the live engine after deploying.
 *
 * REWRITTEN 2026-09-15. The paragraph above used to end "Everything below is a shape check; none of
 * it would have caught that" — a file admitting in its own header that it would not catch the
 * regression it describes. Most of it now RUNS, and the split is deliberate:
 *
 *   · gxRosterFull_, displayNameMap_, friendlyName_ and gxEmployees_ are assembled from Code.gs and
 *     executed, with only the edges stubbed — the script cache and the bound GXCore library. The
 *     cache assertions were `/900\)/` and `/if \(rows\.length\) cache\.put/`, which say a line of
 *     source exists; they are now a second call that either did or did not reach the library, and a
 *     recorded TTL. "Falls back to the identical library call" was `indexOf(...) < 0` — absence of a
 *     spelling — and is now a CALL COUNT on an empty roster, which is the only version of that
 *     claim that can fail for the right reason.
 *   · loadRoster and personName run too, against a stubbed transport. `/console\.warn/` proved a
 *     word was in the file; the roster route now throws and the assertions read what came back.
 *
 * UPDATED 2026-09-17 for the one-call boot (see the engine_boot_test.js header). loadRoster's FIRST
 * move is now `await bootOnce()` — a solo `employees` call only happens when boot did not answer,
 * exactly the SAME fallback shape loadPrograms/loadBrandReps/loadProgressCache use. bootOnce is
 * stubbed to resolve null here, so this file still proves the original claim (a solo employees call,
 * asked once, reused on a second call) — plus one new case below for the boot-fed path, where
 * loadRoster must consume boot's `employees` slot and make NO solo call at all.
 *
 *   WHAT IS DELIBERATELY STILL SOURCE-SHAPED, each marked where it sits: the architecture guards
 *   (no second HTTP hop, no local derivation from preferred_name, no stale comment, no leftover
 *   marker) and the index.html dev-guard declaration. Absence of a thing across a whole file cannot
 *   be executed, and nothing else enforces any of them.
 *
 *   The mock caveat above still stands and is the reason none of this is a substitute for probing
 *   the live engine: every assertion here feeds the roster in, so none of them can tell you what
 *   GX Core's getEmployees() actually returns today.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs   = G.GS;
const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));

/* ── The engine slice, assembled and runnable ────────────────────────────────────────────────────
   The roster read, the map, the lookup and the employees route are all REAL. Stubbed: the script
   cache (which records its TTL, because 15 minutes on a route three apps poll is a decision), the
   bound library (which counts how many times it was asked), and Logger. */
function engine(opts) {
  const o = opts || {};
  let calls = 0;
  const store = {}, puts = [];
  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (k in store ? store[k] : null),
      put: (k, v, ttl) => { store[k] = v; puts.push({ key: k, ttl: ttl }); },
      remove: (k) => { delete store[k]; },
    }),
  };
  const GXCore = {
    getEmployees() {
      calls++;
      if (o.throws) throw new Error('GXCore is down');
      return typeof o.roster === 'function' ? o.roster(calls) : o.roster;
    },
  };
  const logged = [];
  const api = G.load({
    real: ['gxRosterFull_', 'displayNameMap_', 'friendlyName_', 'userKey_', 'gxEmployees_', 'slug_'],
    globals: { CacheService, GXCore, Logger: { log: (m) => logged.push(String(m)) } },
  });
  return Object.assign({}, api, { calls: () => calls, store, puts, logged });
}

/* Three people with a friendly name, one called by their legal name, one inactive.
   `dutchie_employee_id` is the join Dutchie's sell-through rows carry; C Three has none, which is
   the fallback bucket. E Five has NO display_name at all — Core sends that for anyone whose
   preferred name is blank, and it is the row that proves the route fills the field in rather than
   shipping it empty. */
const ROSTER = () => ([
  { employee_id: '01', full_name: 'A One',   display_name: 'Ace One',   dutchie_employee_id: 'a',
    home_store: 'River Rd', role_title: 'Budtender', status: 'active' },
  { employee_id: '02', full_name: 'B Two',   display_name: 'B Two',     dutchie_employee_id: 'b',
    home_store: 'River Rd', role_title: 'Budtender', status: 'active' },
  { employee_id: '03', full_name: 'C Three', display_name: 'Cee Three', dutchie_employee_id: '',
    home_store: 'Bend',     role_title: 'Manager',   status: 'active' },
  { employee_id: '04', full_name: 'D Four',  display_name: 'Dee Four',  dutchie_employee_id: 'd',
    home_store: 'Bend',     role_title: 'Budtender', status: 'terminated' },
  { employee_id: '05', full_name: 'E Five',  display_name: '',          dutchie_employee_id: 'e',
    home_store: 'Bend',     role_title: 'Budtender', status: 'active' },
]);

/* ══════════════════ 1. THE LIBRARY IS THE SOURCE, AND IT IS ASKED ONCE ══════════════════ */
let E = engine({ roster: ROSTER() });
let rows = E.gxRosterFull_();
ok('the roster comes back from the bound library', rows.length === 5 && E.calls() === 1);
ok('  …and a second read is served from the cache, not from a second library call',
   E.gxRosterFull_().length === 5 && E.calls() === 1);
ok('  …cached for 15 minutes, which is the whole reason the cache survived the rewrite',
   E.puts.length === 1 && E.puts[0].ttl === 900);

/* A bad minute must not be remembered for fifteen. */
E = engine({ roster: (n) => (n === 1 ? [] : ROSTER()) });
ok('an EMPTY read is not cached', E.gxRosterFull_().length === 0 && E.puts.length === 0);
ok('  …so the very next call asks again and gets the roster',
   E.gxRosterFull_().length === 5 && E.calls() === 2);

/* Failing to a worse LABEL is fine; failing the read is not. */
E = engine({ throws: true });
let threw = false;
let out;
try { out = E.gxRosterFull_(); } catch (e) { threw = true; }
ok('a library that throws costs the friendlier label and nothing else',
   !threw && Array.isArray(out) && out.length === 0);
ok('  …and says so in the log rather than silently', E.logged.some(m => /roster names unavailable/.test(m)));

/* ── ARCHITECTURE GUARD, SOURCE-SHAPED ON PURPOSE ────────────────────────────────────────────────
   The workaround coming back is an ADDITION to this function, and no execution can assert the
   absence of a branch it never takes: a reinstated UrlFetchApp hop behind `if (!rows.length)` would
   run every assertion above green. Nothing else forbids it, so it is checked by reading. */
const roster = G.grab('gxRosterFull_');
ok('[source] no second HTTP hop with a secret has crept back in',
   roster.indexOf('UrlFetchApp') < 0 && roster.indexOf('GX_SECRET_PROP') < 0);
ok('[source] …so there is no HTML-bounce guard or secret scrubbing left to maintain',
   roster.indexOf("charAt(0) !== '{'") < 0 && roster.indexOf('scrubSecrets_') < 0);
/* The marker that outlived its own condition. A comment, so: read, not run. */
ok('[source] the "REMOVE THIS once getEmployees() decorates" marker is gone',
   !/REMOVE THIS once getEmployees/.test(gs.replace(/"REMOVE THIS once getEmployees\(\) decorates"/g, '')));
/* The false claim was written twice — gxRosterFull_ and gxEmployees_ — which is how a wrong comment
   survives being corrected: somebody fixes the copy they were looking at. The only mentions left
   are the two history notes explaining the retraction; a third is a new live claim. */
ok('[source] no live comment still claims the library returns undecorated rows',
   (gs.match(/undecorated rows/g) || []).length <= 2);

/* ══════════════════ 2. AND THE PIN CAN ACTUALLY SUPPLY IT ══════════════════ */
/* A library call is only correct if the PINNED version has the code. Decoration landed at @133;
   anything below that would compile, run, and quietly hand back legal names — the exact silent
   failure this whole episode was. */
const pinned = Number((manifest.dependencies.libraries.find(l => l.userSymbol === 'GXCore') || {}).version);
ok('GXCore is pinned at or past @133, where the decoration landed',
   Number.isFinite(pinned) && pinned >= 133);
ok('  …and not in developmentMode, which would make the pin a fiction',
   manifest.dependencies.libraries.every(l => l.developmentMode === false));

/* ══════════════════ 3. THE EMPLOYEES ROUTE READS THE ONE CACHED SOURCE ══════════════════ */
E = engine({ roster: ROSTER() });
let emp = E.gxEmployees_({});
const one = (n) => emp.employees.filter(e => e.full_name === n)[0];
ok('the route answers from the roster', emp.ok === true && emp.count === 4);
ok('  …dropping anyone not active', !emp.employees.some(e => e.full_name === 'D Four'));
ok('  …carrying the friendly name where there is one', one('A One').display_name === 'Ace One');
/* The row with no preferred name is the one that matters here: the field is documented as present
   on EVERY row so a consumer can read it unconditionally, which means falling back to the legal
   name rather than shipping an empty string for a caller to trip over. */
ok('  …and falling back to the legal name where there is not',
   one('E Five').display_name === 'E Five' && emp.employees.every(e => !!e.display_name));
ok('  …and full_name still there beside it, never instead of it',
   emp.employees.every(e => !!e.full_name));
ok('  …and the store headcount is slugged, so it joins to store_id',
   emp.by_store['river-rd'] === 2 && emp.by_store.bend === 2);
ok('  …asking the library once for the whole route', E.calls() === 1);

/* THE FALLBACK THAT WAS RETRYING AN IDENTICAL REQUEST. An empty roster is the path that used to
   have a second attempt on it. Counting the calls is the only form of this claim that fails when
   somebody reinstates it — `indexOf('GXCore.getEmployees()') < 0` passes for a fallback written
   through any other spelling, and fails for a comment mentioning it. */
E = engine({ roster: [] });
emp = E.gxEmployees_({});
ok('an unreadable roster reports the outage rather than an empty staff list',
   emp.ok === false && /roster is unavailable/.test(emp.error));
ok('  …having asked exactly once — no fallback retrying the request that already came back empty',
   E.calls() === 1);

/* ══════════════════ 4. THE RULE IS NOT COPIED HERE — THE MAP ONLY REPORTS DIFFERENCES ══════════ */
E = engine({ roster: ROSTER() });
let map = E.displayNameMap_();
ok('someone who goes by another name is in the map, under their Dutchie id',
   map.byId.a === 'Ace One');
ok('  …and someone whose friendly name IS their legal name is not in it at all',
   !('b' in map.byId) && !(E.userKey_('B Two') in map.byName));
ok('  …so friendlyName_ offers nothing better and the caller keeps what Dutchie said',
   E.friendlyName_(map, 'b', 'B Two') === '');
ok('a person the connector has no id for is reachable by their legal name instead',
   E.friendlyName_(map, '', 'C Three') === 'Cee Three' && !('' in map.byId));
ok('  …matched loosely enough to survive punctuation and case from Dutchie',
   E.friendlyName_(map, '', 'c. THREE') === 'Cee Three');
ok('the id wins over the name when both are known',
   E.friendlyName_(Object.assign({}, map, { byName: { [E.userKey_('A One')]: 'Wrong' } }),
                   'a', 'A One') === 'Ace One');
ok('an unknown person gets nothing rather than a guess', E.friendlyName_(map, 'zz', 'Nobody Here') === '');

/* "Differs" is decided by userKey_, not by string equality: Core spelling a name back with a
   middle initial or different case is the same name, and claiming a substitution there would put a
   fake rename on a payroll screen. */
E = engine({ roster: [{ full_name: 'Andrew Phillips', display_name: 'andrew  phillips',
                        dutchie_employee_id: 'x' }] });
ok('a respelling of the same name is not a substitution', Object.keys(E.displayNameMap_().byId).length === 0);

/* Degrading to legal names, not to no rows — the map has to stay usable when Core is down. */
E = engine({ throws: true });
map = E.displayNameMap_();
ok('an unreadable roster leaves an empty map rather than throwing',
   !!map && Object.keys(map.byId || {}).length === 0);
ok('  …and friendlyName_ on it returns nothing, so every name stays as Dutchie reported it',
   E.friendlyName_(map, 'a', 'A One') === '');
ok('  …and a missing map is handled too', E.friendlyName_(null, 'a', 'A One') === '');

/* ── ARCHITECTURE GUARD, SOURCE-SHAPED ON PURPOSE ────────────────────────────────────────────────
   The thing being refused is a local DERIVATION of the name — anywhere in either file, in code
   nothing here calls. That is a property of the whole source and cannot be executed. */
ok('[source] nothing in the engine builds a display name from preferred_name',
   !/preferred_name[^\n]*\+/.test(gs) && !/nickname[^\n]*\+[^\n]*last/i.test(gs));
ok('[source] …nor does the frontend', !/preferred_name/.test(js));

/* ══════════════════ 5. THE DEV GUARD KNOWS IT IS A READ ══════════════════ */
/* Undeclared, every LOCAL session showed legal names and logged a BLOCKED warning that read like
   a roster outage. Production was always fine; only dev lied — which is the worst place for a
   false signal, because dev is where you go to check.
   Source-shaped because it is a declaration in markup: index.html builds this list before any of
   the app's JS exists to be run. */
ok('[source] `employees` is declared to the dev guard as a read',
   /GX_DEV_READS[\s\S]{0,400}'employees'/.test(html));

/* ══════════════════ 6. THE FRONTEND SIDE, RUN ══════════════════
   loadRoster and personName out of spiff.js, with the transport stubbed and nothing else. They are
   assembled together because loadRoster fills the closure variable personName reads — which is the
   only reason the screen ever shows a friendly name. */
function browser(o) {
  const asked = [];
  const ENG = { jsonp(action, params) {
    asked.push({ action: action, params: params });
    if (action === 'boot') {
      /* bootOnce()'s own transport call. Defaults to null (boot unavailable), the same as an old
         engine's "Unknown action" reply once bootOnce's catch has folded it away — which is what
         makes loadRoster fall back to its own solo `employees` call, exactly as before this
         existed. Passing o.boot exercises the fed path instead. */
      return o.boot === undefined ? Promise.resolve(null) : Promise.resolve(o.boot);
    }
    if (o.throws) return Promise.reject(new Error('the /exec hop bounced'));
    return Promise.resolve({ ok: true, employees: o.employees });
  } };
  const warned = [];
  const src = [
    'var rosterByDutchie = null, rosterByStore = Object.create(null), _rosterLoaded = false;',
    'var _bootP = null;',
    G.grab('bootOnce', js),
    G.grab('applyEmployeesResponse', js), G.grab('loadRoster', js),
    G.grab('nameKey', js), G.grab('personName', js),
    'return { loadRoster: loadRoster, personName: personName, byStore: function () { return rosterByStore; } };',
  ].join('\n');
  const api = new Function('ENG', 'session', 'console', src)(
    ENG, () => ({ token: 'TOKEN-123' }), { warn: (...a) => warned.push(a.join(' ')), info: () => {} });
  return Object.assign(api, { asked, warned });
}

(async function () {
  /* The route's own shape, as gxEmployees_ returns it above — not a hand-written one, so a change
     to the payload breaks this rather than sliding past it. */
  const payload = engine({ roster: ROSTER() }).gxEmployees_({}).employees;
  let B = browser({ employees: payload });
  await B.loadRoster();

  ok('the frontend tries boot first, then falls back to a solo employees call, carrying the token',
     B.asked.length === 2 && B.asked[0].action === 'boot' && B.asked[1].action === 'employees'
     && B.asked[1].params.token === 'TOKEN-123');
  ok('a friendly name reaches the screen for someone who goes by one',
     B.personName({ employee_id: 'a', name: 'A One' }) === 'Ace One');
  ok('  …and someone called by their legal name is shown exactly what Dutchie said',
     B.personName({ employee_id: 'b', name: 'B Two' }) === 'B Two');
  ok('  …and a person with no Dutchie id is matched on their name',
     B.personName({ employee_id: '', name: 'C Three' }) === 'Cee Three');
  ok('a display_name the ENGINE already resolved wins over the local lookup',
     B.personName({ employee_id: 'a', name: 'A One', display_name: 'From The Row' }) === 'From The Row');
  ok('somebody nobody knows keeps the name on the sale',
     B.personName({ employee_id: 'zz', name: 'New Hire' }) === 'New Hire');
  ok('the roster is also bucketed by store, for the zero-seller rows Progress adds',
     (B.byStore()['river-rd'] || []).length === 2 && (B.byStore().bend || []).length === 2);

  await B.loadRoster();
  ok('a second caller reuses the loaded roster rather than re-fetching', B.asked.length === 2);

  /* THE ONE-CALL BOOT PATH. When `boot` answers, loadRoster must consume its `employees` slot and
     make NO solo call at all — that is the entire point of the change: four opens becoming one. */
  B = browser({ boot: { ok: true, employees: { ok: true, employees: payload } } });
  await B.loadRoster();
  ok('fed by boot, loadRoster makes the ONE boot call and nothing else',
     B.asked.length === 1 && B.asked[0].action === 'boot');
  ok('  …and still resolves the same friendly names from boot\'s employees slot',
     B.personName({ employee_id: 'a', name: 'A One' }) === 'Ace One');

  /* Logged, not surfaced: the screen is fully usable with legal names. Caught here rather than
     awaited bare, so a version that lets the rejection through fails as an assertion instead of
     killing the file with an unhandled rejection and printing no summary at all. */
  B = browser({ throws: true });
  let m = null, blew = false;
  try { m = await B.loadRoster(); } catch (e) { blew = true; }
  ok('a roster route that fails still resolves, with an empty map',
     !blew && !!m && Object.keys(m).length === 0);
  ok('  …warns rather than surfacing it', B.warned.some(w => /roster unavailable/.test(w)));
  ok('  …and every name on screen falls back to what Dutchie reported',
     B.personName({ employee_id: 'a', name: 'A One' }) === 'A One');

  console.log(fail ? '\n' + fail + ' FAILED' : '\nroster names: all passed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  /* A throw anywhere in the async section would otherwise exit non-zero with no summary line,
     which reads like the runner broke rather than like a test failed. */
  console.log('  ✗ the frontend section threw: ' + (e && e.message || e));
  console.log('\n' + (fail + 1) + ' FAILED');
  process.exit(1);
});
