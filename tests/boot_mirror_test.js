#!/usr/bin/env node
/* ─── A 24h local mirror paints before boot answers, and busts on our own writes ───────────────────
 *
 *   RUN:  node tests/boot_mirror_test.js
 *
 * WHY
 * Employees and brands change roughly weekly, if that, but boot() (see client_boot_fanout_test.js
 * and engine_boot_test.js) fetches both fresh on every open regardless. bootMirrorRead/Write keep a
 * 24h browser-local copy — same shape as PG_CACHE_KEY elsewhere in spiff.js — so paintBootMirror()
 * can paint a warm reopen from yesterday's list before boot's real answer lands, the same role
 * GXStores' 6h cache plays for `stores`.
 *
 * WHAT THIS FILE RUNS. bootMirrorRead, bootMirrorWrite, paintBootMirror, applyEmployeesResponse and
 * brandCall, pulled out of spiff.js and run against a fake localStorage and a stubbed transport —
 * the same technique the other boot_* test files use.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const BOOT_MIRROR_KEY = 'gx.spiff.boot_mirror.v1';
const BOOT_MIRROR_TTL_MS = 24 * 60 * 60 * 1000;

console.log('\n0. the constants this file assumes are the ones spiff.js actually declares');
ok('BOOT_MIRROR_KEY matches', js.indexOf("var BOOT_MIRROR_KEY = '" + BOOT_MIRROR_KEY + "';") >= 0);
ok('BOOT_MIRROR_TTL_MS matches', js.indexOf('var BOOT_MIRROR_TTL_MS = 24 * 60 * 60 * 1000;') >= 0);

function fakeStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

function sandbox(storage, o) {
  o = o || {};
  const asked = [];
  const ENG = { jsonp(action, params) {
    asked.push({ action: action, params: params });
    return Promise.resolve(o.brandWriteReply || { ok: true, brand: { brand_id: 'mule', display_name: 'Mule' } });
  } };
  const state = Object.assign({ brands: null, brandsLoading: false, brandsError: '' }, o.state || {});
  const calls = { repaint: 0 };
  const src = [
    'var state = __state;',
    'var rosterByDutchie = null, rosterByStore = Object.create(null), _rosterLoaded = false;',
    /* grabVar's `\nvar NAME =` anchor assumes Code.gs's flat top-level declarations; spiff.js
       indents everything inside its IIFE, so these two are declared by hand instead. The source
       check below (section 0) keeps this copy honest against a change to the real constants. */
    'var BOOT_MIRROR_KEY = ' + JSON.stringify(BOOT_MIRROR_KEY) + ';',
    'var BOOT_MIRROR_TTL_MS = ' + BOOT_MIRROR_TTL_MS + ';',
    'function nameKey(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, ""); }',
    G.grab('bootMirrorRead', js), G.grab('bootMirrorWrite', js),
    G.grab('applyEmployeesResponse', js),
    G.grab('paintBootMirror', js),
    G.grab('applyBrandWrite', js),
    'function repaintBrands() { __calls.repaint++; }',
    'function repMsg() {}',
    G.grab('brandCall', js),
    'return { bootMirrorRead: bootMirrorRead, bootMirrorWrite: bootMirrorWrite, paintBootMirror: paintBootMirror,',
    '         brandCall: brandCall, state: state,',
    '         rosterLoaded: function () { return _rosterLoaded; }, roster: function () { return rosterByDutchie; } };',
  ].join('\n');
  const api = new Function('ENG', 'session', 'console', 'localStorage', '__state', '__calls', src)(
    ENG, () => ({ token: 'TOKEN-123' }), { warn: () => {} }, storage, state, calls);
  return Object.assign(api, { asked: asked, calls: calls });
}

console.log('\n1. round trip: write, then read, same shape back');
let storage = fakeStorage();
let B = sandbox(storage);
B.bootMirrorWrite('employees', [{ full_name: 'A One' }]);
ok('a fresh write reads back exactly what was written',
   JSON.stringify(B.bootMirrorRead('employees')) === JSON.stringify([{ full_name: 'A One' }]));
ok('a key that was never written reads as null', B.bootMirrorRead('brands') === null);

console.log('\n2. the mirror expires at 24h, on the WRITE\'s own timestamp');
storage = fakeStorage();
const STALE_AT = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
storage.setItem('gx.spiff.boot_mirror.v1', JSON.stringify({
  brands: { at: STALE_AT, data: [{ brand_id: 'stale' }] },
}));
B = sandbox(storage);
ok('an entry older than 24h reads as a miss, not as stale data', B.bootMirrorRead('brands') === null);
storage = fakeStorage();
const FRESH_AT = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
storage.setItem('gx.spiff.boot_mirror.v1', JSON.stringify({
  brands: { at: FRESH_AT, data: [{ brand_id: 'fresh' }] },
}));
B = sandbox(storage);
ok('an entry within 24h is served', (B.bootMirrorRead('brands') || [])[0] && B.bootMirrorRead('brands')[0].brand_id === 'fresh');

console.log('\n3. a broken mirror degrades to \"nothing cached\", not to a thrown error');
const brokenStorage = { getItem: () => { throw new Error('quota / private mode'); },
                         setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
B = sandbox(brokenStorage);
let threw = false;
try { ok('a read that cannot access storage returns null rather than throwing', B.bootMirrorRead('brands') === null); }
catch (e) { threw = true; }
ok('  …and a write that cannot access storage does not throw either', (function () {
  try { B.bootMirrorWrite('brands', [1]); return true; } catch (e) { return false; }
})());
ok('  …(the read assertion itself did not throw)', !threw);

console.log('\n4. paintBootMirror fills a PREVIEW, and leaves the real load flag alone');
storage = fakeStorage();
B = sandbox(storage);
B.bootMirrorWrite('brands', [{ brand_id: 'mule' }]);
B.bootMirrorWrite('employees', [{ full_name: 'A One', display_name: 'Ace One', dutchie_employee_id: 'a', home_store: 'River Rd' }]);
B.paintBootMirror();
ok('state.brands is painted from the mirror before boot answers', B.state.brands && B.state.brands[0].brand_id === 'mule');
ok('the roster preview resolves a friendly name', B.roster() && B.roster().a === 'Ace One');
ok('  …but is NOT marked as a real load — loadRoster must still run and replace it',
   B.rosterLoaded() === false);

console.log('\n5. paintBootMirror never overwrites data that already arrived');
storage = fakeStorage();
B = sandbox(storage, { state: { brands: [{ brand_id: 'already-live' }] } });
B.bootMirrorWrite('brands', [{ brand_id: 'from-mirror' }]);
B.paintBootMirror();
ok('a brand list already in state wins over the mirror', B.state.brands[0].brand_id === 'already-live');

(async function () {

console.log('\n6. our own brand write busts the mirror — the NEXT open sees the edit, not yesterday\'s list');
storage = fakeStorage();
B = sandbox(storage, { brandWriteReply: { ok: true, brand: { brand_id: 'mule', display_name: 'Mule Extracts (renamed)' } } });
B.bootMirrorWrite('brands', [{ brand_id: 'mule', display_name: 'Mule' }]);
await B.brandCall('saveBrand', { brand: '{}' }, null, { disabled: false });
ok('the write landed in state', B.state.brands[0].display_name === 'Mule Extracts (renamed)');
ok('  …and the mirror was updated to match, not left holding the old name',
   B.bootMirrorRead('brands')[0].display_name === 'Mule Extracts (renamed)');
ok('  …without re-reading the whole brand list from Core', B.asked.length === 1 && B.asked[0].action === 'saveBrand');

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'boot mirror: all passed');
process.exit(fail ? 1 : 0);

})().catch(function (e) {
  console.log('  ✗ the async section threw: ' + (e && e.message || e));
  console.log('\n' + (fail + 1) + ' FAILED');
  process.exit(1);
});
