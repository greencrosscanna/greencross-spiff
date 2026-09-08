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
 * projection being wrong. It was found by probing the live engine after deploying. Everything
 * below is a shape check; none of it would have caught that.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs   = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));

function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. THE LIBRARY IS THE SOURCE ══════════════════ */
const roster = grab(gs, 'gxRosterFull_');
ok('the roster comes from the bound library', /GXCore\.getEmployees\(\)/.test(roster));
ok('  …and not from a second HTTP hop with a secret',
   roster.indexOf('UrlFetchApp') < 0 && roster.indexOf('GX_SECRET_PROP') < 0);
ok('  …so there is no HTML-bounce guard or secret scrubbing left to maintain',
   roster.indexOf("charAt(0) !== '{'") < 0 && roster.indexOf('scrubSecrets_') < 0);
/* The marker that outlived its own condition. */
ok('the "REMOVE THIS once getEmployees() decorates" marker is gone',
   !/REMOVE THIS once getEmployees/.test(gs.replace(/"REMOVE THIS once getEmployees\(\) decorates"/g, '')));

/* ══════════════════ 2. AND THE PIN CAN ACTUALLY SUPPLY IT ══════════════════ */
/* A library call is only correct if the PINNED version has the code. Decoration landed at @133;
   anything below that would compile, run, and quietly hand back legal names — the exact silent
   failure this whole episode was. */
const pinned = Number((manifest.dependencies.libraries.find(l => l.userSymbol === 'GXCore') || {}).version);
ok('GXCore is pinned at or past @133, where the decoration landed',
   Number.isFinite(pinned) && pinned >= 133);
ok('  …and not in developmentMode, which would make the pin a fiction',
   manifest.dependencies.libraries.every(l => l.developmentMode === false));

/* ── AND ONLY ONE PLACE STILL SAYS IT ─────────────────────────────────────────────────────────
   The false claim was written twice — gxRosterFull_ and gxEmployees_ — which is how a wrong
   comment survives being corrected: somebody fixes the copy they were looking at. The only
   remaining mention is the history note explaining the retraction. */
ok('no live comment still claims the library returns undecorated rows',
   (gs.match(/undecorated rows/g) || []).length <= 2);
const emp = grab(gs, 'gxEmployees_');
ok('the employees route reads the one cached source',
   /gxRosterFull_\(\) \|\| \[\]/.test(emp));
ok('  …and no longer "falls back" to the identical library call',
   emp.indexOf('GXCore.getEmployees()') < 0);
ok('  …reporting the outage instead of retrying a request that already threw',
   /roster is unavailable/.test(emp));

/* ══════════════════ 3. THE RULE IS NOT COPIED HERE ══════════════════ */
const map = grab(gs, 'displayNameMap_');
ok('the map reads display_name rather than deriving one',
   /r\.display_name/.test(map) && map.indexOf('preferred_name') < 0);
ok('  …and never maps a name onto itself, which would claim a substitution that did not happen',
   /userKey_\(friendly\) === userKey_\(r\.full_name\)/.test(map));
ok('nothing in the engine builds a display name from preferred_name',
   !/preferred_name[^\n]*\+/.test(gs) && !/nickname[^\n]*\+[^\n]*last/i.test(gs));
ok('  …nor does the frontend', !/preferred_name/.test(js));
const lr = grab(js, 'loadRoster');
ok('the frontend reads display_name off the route too',
   /e\.display_name/.test(lr) && /nameKey\(friendly\) !== nameKey\(e\.full_name\)/.test(lr));

/* ══════════════════ 4. THE CACHE, AND FAILING TO A WORSE LABEL ══════════════════ */
ok('the roster is cached — this sits under a route Crew and the kiosks poll',
   /CacheService\.getScriptCache\(\)/.test(roster) && /900\)/.test(roster));
ok('  …and only a non-empty read is cached, so a bad minute is not remembered for 15',
   /if \(rows\.length\) cache\.put/.test(roster));
ok('a failed read returns nothing rather than throwing',
   /return \[\];/.test(roster));
ok('  …and the map degrades to legal names rather than to no rows',
   /return Object\.create\(null\)/.test(map));
ok('the frontend logs a roster failure rather than surfacing it',
   /console\.warn/.test(lr) && /fully usable with legal names/.test(js));

/* ══════════════════ 5. THE DEV GUARD KNOWS IT IS A READ ══════════════════ */
/* Undeclared, every LOCAL session showed legal names and logged a BLOCKED warning that read like
   a roster outage. Production was always fine; only dev lied — which is the worst place for a
   false signal, because dev is where you go to check. */
ok('`employees` is declared to the dev guard as a read',
   /GX_DEV_READS[\s\S]{0,400}'employees'/.test(html));

console.log(fail ? '\n' + fail + ' FAILED' : '\nroster names: all passed');
process.exit(fail ? 1 : 0);
