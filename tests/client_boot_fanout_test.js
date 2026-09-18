#!/usr/bin/env node
/* ─── The screen's four opening reads fan out from ONE boot call ──────────────────────────────────
 *
 *   RUN:  node tests/client_boot_fanout_test.js
 *
 * WHY
 * See engine_boot_test.js for the server half (bootAll_). This is the browser half: loadPrograms,
 * loadBrandReps and loadProgressCache each used to make their own solo call to this app's /exec —
 * `programs`, `brands`, `progress` — every one of them queued behind the others on the engine's
 * single execution lane. bootOnce() (spiff.js) asks for all three (plus `employees`, covered in
 * roster_names_test.js) in one shot and memoizes the promise so whichever loader runs first is the
 * one that actually fires it; the rest just await the same answer.
 *
 * WHAT THIS FILE RUNS. The three loaders above, and bootOnce, pulled out of spiff.js with `new
 * Function` and run against a stubbed transport — same technique roster_names_test.js already uses
 * for loadRoster. Not run: the DOM-heavy render functions each loader calls on success
 * (renderPrograms, repaintBrands) — those are stubbed as no-ops that only record they were called,
 * which is enough to prove the FAN-OUT shape (one network call in, three slots consumed, the right
 * state set) without standing up a browser for painting nobody is asserting on here.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

/* A minimal DOM: exactly the selectors loadPrograms touches, nothing more. */
function makeDom() {
  const els = {
    '#programsList':   { hidden: false },
    '#programsEmpty':  { hidden: true },
    '#programsEmpty p': { textContent: '' },
  };
  return function $(sel) { return els[sel] || null; };
}

function sandbox(o) {
  const asked = [];
  const ENG = { jsonp(action, params, opts) {
    asked.push({ action: action, params: params, opts: opts });
    if (action === 'boot') return o.boot === undefined ? Promise.resolve(null) : Promise.resolve(o.boot);
    const solo = (o.solo || {})[action];
    if (solo && solo.throws) return Promise.reject(new Error(solo.throws));
    return Promise.resolve(solo !== undefined ? solo : { ok: true });
  } };
  const calls = { renderPrograms: 0, repaintBrands: 0, renderPrograms2: 0 };
  const state = { programs: [], brands: null, brandsLoading: false, brandsError: '' };
  let progCache = null, progCacheP = null;   // matches the module-level names loadProgressCache closes over

  const src = [
    'var state = __state;',
    'var progCache = null, progCacheP = null;',
    'var _bootP = null;',
    G.grab('bootOnce', js),
    'function renderPrograms() { __calls.renderPrograms++; }',
    'function repaintBrands() { __calls.repaintBrands++; }',
    G.grab('loadPrograms', js),
    G.grab('loadBrandReps', js),
    G.grab('loadProgressCache', js),
    'return { loadPrograms: loadPrograms, loadBrandReps: loadBrandReps, loadProgressCache: loadProgressCache,',
    '         state: state, progCache: function () { return progCache; } };',
  ].join('\n');

  const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const api = new Function('ENG', 'session', 'console', '$', 'clearSession', 'renderNoAccess', 'renderGate',
                            '__state', '__calls', 'localStorage', src)(
    ENG, () => ({ token: 'TOKEN-123' }), { error: () => {}, warn: () => {} }, makeDom(),
    () => {}, () => {}, () => {}, state, calls, noopStorage);
  return Object.assign(api, { asked, calls });
}

(async function () {

console.log('\n1. boot succeeds: ONE call feeds all three loaders');
let B = sandbox({ boot: { ok: true,
  programs: { ok: true, programs: [{ program_id: 'p1' }] },
  brands:   { ok: true, brands: [{ brand_id: 'b1' }] },
  progress: { ok: true, rows: [{ program_id: 'p1', units: 4, hit: true, store_id: 'river-rd', refreshed_at: 't1' }] },
} });
await Promise.all([B.loadPrograms(), B.loadBrandReps(), B.loadProgressCache()]);
ok('exactly one network call was made for all three', B.asked.length === 1 && B.asked[0].action === 'boot');
ok('programs landed in state from boot\'s slot', B.state.programs.length === 1 && B.state.programs[0].program_id === 'p1');
ok('brands landed in state from boot\'s slot', Array.isArray(B.state.brands) && B.state.brands[0].brand_id === 'b1');
ok('the progress cache was built from boot\'s slot', !!B.progCache() && B.progCache().p1.units === 4);
ok('each loader still repainted what it owns', B.calls.renderPrograms >= 1 && B.calls.repaintBrands === 1);

console.log('\n2. boot fails (old backend / network miss): each loader falls back to its own solo call');
B = sandbox({ boot: null, solo: {
  programs: { ok: true, programs: [{ program_id: 'p2' }] },
  brands:   { ok: true, brands: [{ brand_id: 'b2' }] },
  progress: { ok: true, rows: [{ program_id: 'p2', units: 1, hit: false, store_id: 'bend', refreshed_at: 't2' }] },
} });
await Promise.all([B.loadPrograms(), B.loadBrandReps(), B.loadProgressCache()]);
const actions = B.asked.map(a => a.action).sort();
ok('one boot attempt plus the three solo calls it used to make — four total, nothing lost',
   B.asked.length === 4 && actions.join(',') === 'boot,brands,programs,progress');
ok('the three loaders still got their data via the fallback',
   B.state.programs[0].program_id === 'p2' && B.state.brands[0].brand_id === 'b2'
   && B.progCache().p2.units === 1);

console.log('\n3. boot answers but ONE slot failed: the healthy two still land, the bad one behaves as it always did');
B = sandbox({ boot: { ok: true,
  programs: { ok: true, programs: [{ program_id: 'p3' }] },
  brands:   { ok: false, error: 'GX Core brand list unavailable' },
  progress: { ok: true, rows: [{ program_id: 'p3', units: 2, hit: true, store_id: 'century', refreshed_at: 't3' }] },
} });
await Promise.all([B.loadPrograms(), B.loadBrandReps(), B.loadProgressCache()]);
ok('still exactly one network call — a bad slot does not trigger a solo retry',
   B.asked.length === 1 && B.asked[0].action === 'boot');
ok('the two healthy parts landed', B.state.programs[0].program_id === 'p3' && B.progCache().p3.units === 2);
ok('the failed brand slot is reported exactly like a failed solo call would be',
   B.state.brands === null && /unavailable/.test(B.state.brandsError));

console.log('\n4. an auth failure on boot routes to the gate exactly like a solo needsAuth would');
let gated = null;
/* A one-off sandbox, not the shared one above: loadPrograms needs clearSession/renderNoAccess/
   renderGate wired to observe them, which the other three sections have no reason to carry. */
B = (function () {
  const asked = [];
  const ENG = { jsonp(action) { asked.push(action); return Promise.resolve({ needsAuth: true, code: 'no_access', error: 'no grant' }); } };
  const state = { programs: [] };
  const src = ['var state = __state;', 'var _bootP = null;', G.grab('bootOnce', js),
               'function renderPrograms() {}', G.grab('loadPrograms', js),
               'return { loadPrograms: loadPrograms };'].join('\n');
  const noopStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const api = new Function('ENG', 'session', 'console', '$', 'clearSession', 'renderNoAccess', 'renderGate',
                            '__state', 'localStorage', src)(
    ENG, () => ({ token: 'TOKEN-123', user: 'sky' }), { error: () => {}, warn: () => {} },
    (sel) => ({}), () => { gated = gated || {}; gated.cleared = true; },
    (who) => { gated = gated || {}; gated.noAccess = who; }, (msg) => { gated = gated || {}; gated.gate = msg; },
    state, noopStorage);
  return Object.assign(api, { asked: asked });
})();
await B.loadPrograms();
ok('the no_access reply from boot shows the no-grant panel, not a generic sign-in error',
   gated && gated.cleared && gated.noAccess === 'sky' && !gated.gate);

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'client boot fan-out: all passed');
process.exit(fail ? 1 : 0);

})().catch(function (e) {
  /* A throw anywhere above would otherwise exit non-zero with no summary line. */
  console.log('  ✗ the async section threw: ' + (e && e.message || e));
  console.log('\n' + (fail + 1) + ' FAILED');
  process.exit(1);
});
