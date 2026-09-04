#!/usr/bin/env node
/* ─── The boot path: one stores call, cache first, and a live pay-period grid ──────────────────────
 *
 *   RUN:  node tests/boot_path_test.js
 *
 * WHY
 * Apps Script serializes execution per script, so every call this app makes to GX Core at boot
 * queues behind whatever the rest of the suite is doing there. Two things were wrong on that path.
 *
 * TWO STORES CALLS, NOT ONE. startChrome fired GXStores.load() for the header colors and
 * loadShared separately awaited its own GX.jsonp('stores') for state.stores — the same endpoint,
 * the same payload, twice per boot, with the second one blocking first paint. GXStores already
 * keeps a 6h localStorage cache and applies it synchronously before its first await, so routing
 * through it means a warm visit never waits at all.
 *
 * A CONFIG LOADER NOTHING CALLED. loadPayPeriods existed, was correct, and was invoked from
 * nowhere — so payCfg.live was permanently false and every pay period came from the built-in
 * anchor instead of GX Core's. Nothing was wrong when it was found, because the fallback matched
 * Core exactly; that is why it survived, and why it mattered. The comment above it says hardcoding
 * the anchor would put SPIFF's fortnight on a different timeline from payroll's with nothing to
 * announce the drift. That was the live situation.
 *
 * NO HARDCODED STORE TABLE. The suite rule: a cache expires and refreshes itself, a local table
 * silently outlives a Command Center edit. This checks the app did not grow one.
 */
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
/* Comments in this file QUOTE the old code they replaced, on purpose — the reason a line changed is
   worth keeping next to it. So anything counting CALL SITES has to read code only, or a comment
   explaining "we used to call GX.jsonp('stores')" registers as still calling it. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* ── one call, shared ── */
console.log('\n1. stores are fetched once per boot, through the shared client');
ok('storesOnce memoizes the promise, so two callers share one request',
   /var _storesP = null;/.test(src) && /if \(_storesP\) return _storesP;/.test(src));
ok('startChrome goes through it rather than calling GXStores.load itself',
   /storesOnce\(\)\.catch/.test(code) && !/GXStores\.load\(GXCORE\)\.catch/.test(code));
ok('loadShared goes through it too',
   /var p = storesOnce\(opts\);/.test(src));
/* The old blocking fetch is the regression to catch: if it comes back, the duplicate call and the
   blocked first paint come back with it. */
const jsonpStores = (code.match(/GX\.jsonp\('stores'/g) || []).length;
ok('the only remaining GX.jsonp(\'stores\') is storesOnce\'s own fallback for a missing GXStores',
   jsonpStores === 1);

console.log('\n2. the cache is read BEFORE the network, not after');
const shared = (src.match(/async function loadShared[\s\S]*?\n  \}/) || [''])[0];
ok('loadShared reads GXStores.all() before awaiting anything',
   shared.indexOf('GXStores.all()') > 0
   && shared.indexOf('GXStores.all()') < shared.indexOf('await p'));
ok('a warm cache paints and says so, without waiting for the refresh',
   /if \(cached\.length\) \{[\s\S]*?state\.stores = cached;[\s\S]*?conn\('GX Core', 'cached'\)/.test(shared));
/* A failed refresh on top of a good cache is not an outage, and calling it one sends the user
   hunting for a problem that is not there. */
ok('a refresh that fails over a good cache does NOT report offline',
   /if \(state\.stores\.length\) \{[\s\S]*?conn\('GX Core', 'cached'\)[\s\S]*?return;/.test(shared));
ok('  …but a cold cache with no network still does',
   /conn\('offline', 'GX Core unreachable'\)/.test(shared));

/* The suite rule, and the thing the Command Center explicitly asked not to happen. */
console.log('\n3. no hardcoded store table crept in as a "fallback"');
const STORE_IDS = ['river-rd', 'commercial', 'bend', 'century'];
const hits = STORE_IDS.filter(id => new RegExp("store_id\\s*:\\s*['\"]" + id + "['\"]").test(code));
ok('no literal store_id rows in the source (' + (hits.join(', ') || 'none') + ')', hits.length === 0);

/* ── the pay-period grid ── */
console.log('\n4. the pay-period grid comes from GX Core, not from the built-in anchor');
ok('loadPayPeriods is actually CALLED — it never was until 2026-09-03',
   /loadPayPeriods\(\)\.then/.test(src));
ok('  …in the parallel boot wave, not blocking first paint',
   /var payP\s+= loadPayPeriods\(\)/.test(src)
   && /Promise\.all\(\[sharedP, programsP, cacheP, rosterP, payP\]\)/.test(src));
ok('it reports whether the grid actually MOVED, so a no-op boot repaints nothing',
   /payCfg\.moved = \(payCfg\.anchor \+ '\/' \+ payCfg\.days\) !== was;/.test(src));
ok('  …and a real move repaints what renders periods',
   /if \(!cfg\.moved\) return;[\s\S]*?fillProgramPickers\(\); renderPrograms\(\);/.test(src));
/* The fallback must stay: a Core hiccup should degrade to today's correct answer, not to none. */
ok('the built-in anchor survives as the degraded answer',
   /var payCfg = \{ anchor: '\d{4}-\d{2}-\d{2}', days: \d+, live: false \};/.test(src));

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'boot path: all passed');
process.exit(fail ? 1 : 0);
