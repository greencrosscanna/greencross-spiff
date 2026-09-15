#!/usr/bin/env node
/* ─── SPIFF'S SHARE OF THE ONE GOOGLE ACCOUNT EVERY GX APP RUNS AS ────────────────────────────────
 *
 *   RUN:  node tests/shared_account_load_test.js
 *
 * WHAT HAPPENED (2026-09-15). Every GX web app and trigger executes as the same Google account, and
 * Google lets one account run 30 executions at once. Between 10:15 AM and 1:55 PM PT the suite
 * peaked at 114 simultaneous; everything past 30 waits. SPIFF's calls ran a median of 7.9s and up
 * to 184s, and its bursts lined up minute for minute with GX Core's. Three SPIFF causes:
 *
 *   1. Every signed-in call re-asked GX Core "is this token good?" — its own Core execution.
 *   2. Opening a running program fanned six stores of live sell-through out at once, each window
 *      a SPIFF execution plus a Core one.
 *   3. The hourly job ran 13 times in 4 hours, with nothing stopping two runs overlapping.
 *
 * This pins the three fixes. Each assertion names what would make it fail.
 *
 * SOURCE-SHAPED: the subject is how MANY calls this app makes and how often its triggers fire —
 * counted across the source, because the cost is the arrangement rather than any answer. Running
 * it would need the shared Google account under load, which is the condition being avoided.
 * Declared under the rule in suite_shape_test.js.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const line = (src, re) => (src.match(re) || [''])[0];

/* ── 1. the session check is cached across executions, yes-only ───────────────────────────────── */
console.log('\n1. a successful session check is remembered, a refusal is not');
{
  const store = new Map(), puts = [];
  let fetches = 0, answer = { ok: true, user: 'tawny', role: 'editor' };
  const CacheService = { getScriptCache: () => ({
    get: (k) => store.has(k) ? store.get(k) : null,
    put: (k, v, ttl) => { puts.push({ k, v, ttl }); store.set(k, v); },
  }) };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map(b => b > 127 ? b - 256 : b),
    sleep() {},
  };
  const UrlFetchApp = { fetch: () => { fetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(answer) }; } };
  const src = [
    "var APP = 'spiff', GXCORE_URL = 'https://core.example/exec';",
    line(gs, /^var AUTH_CACHE_TTL_S\s*=.*$/m), line(gs, /^var AUTH_CACHE_PREFIX\s*=.*$/m),
    (gs.match(/^var GXCORE_FETCH_[A-Z_]+\s*=.*$/gm) || []).join('\n'),
    grab(gs, 'scrubSecrets_'), grab(gs, 'gxCoreFetchJson_'),
    grab(gs, 'authCacheKey_'), grab(gs, 'authCacheTtl_'),
    'var _authMemo;',
    grab(gs, 'gxAuth_'),
    'return { gxAuth_: function (t) { _authMemo = Object.create(null); return gxAuth_(t); }, authCacheTtl_: authCacheTtl_ };',
  ].join('\n');
  // Each call resets the per-execution memo, so what is being tested is the CROSS-execution cache.
  const S = new Function('CacheService', 'Utilities', 'UrlFetchApp', 'console', src)(CacheService, Utilities, UrlFetchApp, console);

  const exp = Date.now() + 12 * 3600 * 1000;
  const token = 'tawny:' + exp + ':SIGNATURE-abc';

  S.gxAuth_(token); S.gxAuth_(token); S.gxAuth_(token);
  ok('three calls from one session ask GX Core once (fails if the cache is never read)', fetches === 1);
  ok('the cache key is a digest, never the raw token (fails if the token lands in the cache)',
     puts.length === 1 && puts[0].k.indexOf(token) < 0 && puts[0].k.indexOf('SIGNATURE') < 0);
  ok('the entry lives five minutes at most', puts[0].ttl === 300);

  const nearly = 'tawny:' + (Date.now() + 90 * 1000) + ':SIG2';
  S.gxAuth_(nearly);
  ok('…and never outlives the token itself (fails if the TTL ignores expiry)', puts[1] && puts[1].ttl <= 90);
  ok('a token with no readable expiry is not cached', S.authCacheTtl_('garbage', Date.now()) === 0);

  fetches = 0; answer = { ok: false, error: 'Access revoked', code: 'no_access' };
  const denied = 'sam:' + exp + ':SIG3';
  S.gxAuth_(denied); S.gxAuth_(denied);
  ok('a refusal is re-asked every time (fails if a no is cached)', fetches === 2);
  ok('…and nothing was written for it', !puts.some(p => JSON.parse(p.v).ok !== true));
}

/* ── 2. the hourly job cannot run twice at once ───────────────────────────────────────────────── */
console.log('\n2. the hourly job takes a lease, and the installer is locked');
{
  const props = new Map();
  const PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => props.has(k) ? props.get(k) : null,
    setProperty: (k, v) => props.set(k, v),
    deleteProperty: (k) => props.delete(k),
  }) };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  let ran = 0, inner = null;
  const src = [
    line(gs, /^var SWEEP_LEASE_PROP\s*=.*$/m), line(gs, /^var SWEEP_LEASE_MS\s*=.*$/m),
    grab(gs, 'takeSweepLease_'), grab(gs, 'releaseSweepLease_'),
    grab(gs, 'refreshSpiffProgressTrigger')
      // Replace the work with a probe that tries to start a SECOND run while the first is inside.
      .replace(/\{\n  var lease = takeSweepLease_\(\);\n  if \(!lease\) return;\n  try \{[\s\S]*\n  \} finally \{/,
               '{\n  var lease = takeSweepLease_();\n  if (!lease) return;\n  try { work(); } finally {'),
    'return refreshSpiffProgressTrigger;',
  ].join('\n');
  const quiet = { warn() {}, log() {} };
  let trig;
  const work = () => { ran++; if (!inner) { inner = true; trig(); } };
  trig = new Function('PropertiesService', 'LockService', 'console', 'work', src)(PropertiesService, LockService, quiet, work);

  trig();
  ok('a run that starts while another holds the lease does nothing (fails without the lease)', ran === 1);
  ok('the lease is released when the run finishes', !props.has('SWEEP_RUNNING_UNTIL'));
  trig();
  ok('…so the next hour runs normally', ran === 2);

  props.set('SWEEP_RUNNING_UNTIL', (Date.now() - 1000) + '|dead-run');
  trig();
  ok('an expired lease from a killed run does not wedge the job', ran === 3);

  props.set('SWEEP_RUNNING_UNTIL', (Date.now() + 60000) + '|someone-else');
  const before = ran;
  trig();
  ok('a live lease held by another run is left alone', ran === before && props.get('SWEEP_RUNNING_UNTIL').endsWith('|someone-else'));

  const inst = grab(gs, 'installSpiffProgressTrigger');
  ok('the installer takes the script lock around delete-then-create', /tryLock\(/.test(inst) && /releaseLock\(\)/.test(inst));
  ok('diag reports how many copies of the trigger exist, not just whether one does',
     /hourlyTriggerCopies/.test(grab(gs, 'diag_')));
}

/* ── 3. the browser never fans stores out six wide ───────────────────────────────────────────── */
console.log('\n3. store pulls run in lanes, and a running program opens on the hourly figures');
{
  const lp = grab(js, 'loadProgress'), pr = grab(js, 'pullReference');
  ok('loadProgress has no Promise.all over stores (fails if the six-wide fan-out comes back)',
     !/Promise\.all\(\s*stores\.map/.test(lp) && /inLanes\(/.test(lp));
  ok('a running program is pulled up to today, not through days that have not happened',
     /dateWindows\(prog\.start_date, until,/.test(lp) && /prog\.status === 'active'/.test(lp));
  ok('the reference pull runs in lanes too', !/Promise\.all\(/.test(pr) && /inLanes\(/.test(pr));

  const src = [
    line(js, /var PULL_LANES\s*=.*$/m), line(js, /var PG_HOURLY_MAX_AGE_MS\s*=.*$/m),
    'var progCache = null;',
    grab(js, 'inLanes'), grab(js, 'laStamp'), grab(js, 'hourlyResultsFor'),
    'return { inLanes: inLanes, laStamp: laStamp, hourlyResultsFor: hourlyResultsFor, set: function (c) { progCache = c; } };',
  ].join('\n');
  const B = new Function(src)();

  (async () => {
    let live = 0, peak = 0;
    await B.inLanes([1, 2, 3, 4, 5, 6], async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; });
    ok('inLanes never has more than PULL_LANES in flight (fails if it fans out)', peak === 2);

    const now = B.laStamp(Date.now()), stale = B.laStamp(Date.now() - 3 * 3600 * 1000);
    ok('laStamp writes the engine\'s refreshed_at shape', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(now));

    const prog = { program_id: 'p1', start_date: '2026-09-07', end_date: '2026-09-20',
                   payout_json: { amount: 25 }, target_json: { per_bt: { 'river-rd': 10 } } };
    const row = (store, name, units, extra) => Object.assign({ program_id: 'p1', store_id: store, name, units,
      target: 99, hit: false, start_date: '2026-09-07', end_date: '2026-09-20', refreshed_at: now }, extra || {});
    B.set({ p1: { rows: [
      row('river-rd', 'Ann', 12), row('river-rd', 'Bo', 4),
      row('bend', 'Cy', 7, { start_date: '2026-09-01' }),        // a window the program no longer has
      row('hillsboro', 'Di', 9, { refreshed_at: stale }),        // an hourly job that stopped
    ] } });
    const h = B.hourlyResultsFor(prog, ['river-rd', 'bend', 'hillsboro', 'century']);
    ok('a store with fresh rows for this window opens from the cache', !!(h && h.results['river-rd']));
    ok('…scored against TODAY\'s goal, not the one stored at the sweep (fails on target 99)',
       h.results['river-rd'].target === 10 && h.results['river-rd'].hit === 1 && h.results['river-rd'].units === 16);
    ok('rows for a different window are not used — that store is pulled live', !h.results['bend']);
    ok('rows older than two hours are not used — that store is pulled live', !h.results['hillsboro']);
    ok('a store with no cached rows is pulled live, never shown as zero', !h.results['century']);

    B.set(null);
    ok('no cache at all means pull live', B.hourlyResultsFor(prog, ['river-rd']) === null);

    console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
    process.exit(fail ? 1 : 0);
  })();
}
