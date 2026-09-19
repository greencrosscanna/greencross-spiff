#!/usr/bin/env node
/* ─── Boot hedges reads, never writes, and gives up sooner ─────────────────────────────────────────
 *
 *   RUN:  node tests/boot_hedge_test.js
 *
 * WHY
 * Measured live 2026-09-18: the landing page opens in ~6s when `boot` answers, but Apps Script's
 * /exec silently drops a few percent of JSONP responses on its first hop — a fact gx-client.js has
 * documented since the hedging feature landed there. bootOnce() asked for `boot` with
 * { timeoutMs: 45000, retries: 1 } and ENG was built as plain `GXClient(ENGINE)`, which falls back
 * to gx-client's DEFAULT hedge list — GX Core's own route names, none of which this engine answers.
 * So a dropped `boot` reply waited out the full 45s attempt before the retry ever fired: measured
 * as a ~1-minute landing page on a quiet afternoon.
 *
 * THE FIX has two parts and this file pins both:
 *   1. ENG now hedges its OWN read routes (ENGINE_HEDGE_READS in spiff.js), so a dropped first copy
 *      of `boot` gets a second copy around HEDGE_MS (6s) instead of waiting the whole budget.
 *   2. bootOnce's budget is cut from 45000/1 to 20000/2 — cold start measures ~9s, so 20s clears it,
 *      and the extra retry keeps a call that misses BOTH hedge copies from giving up after one more.
 *
 * THE ASSERTION THIS FILE EXISTS FOR: hedging a WRITE runs it twice (see gx-client.js's own
 * HEDGE_MS comment — "a hedged write runs twice"). ENGINE_HEDGE_READS must never grow to include
 * one of this engine's mutating actions. §2 checks every name in it is a pure read verified against
 * apps-script/Code.gs; §3 checks none of them is a name Code.gs's own switch statement uses for a
 * write.
 *
 * Runs bootOnce for real (via _gas.grab + new Function, same technique client_boot_fanout_test.js
 * uses) against a fake ENG.jsonp that records what options it was called with, so §1/§4 assert the
 * actual budget passed at the call site rather than a string a comment could drift from.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const engineSrc = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

/* grabVar's `\nvar NAME =` anchor assumes Code.gs's flat top-level declarations; spiff.js indents
   everything inside its IIFE (see the same note in boot_mirror_test.js), so ENGINE_HEDGE_READS
   needs its own scan — same brace/string-aware walk as _gas.js's, just without the column-0
   anchor. Reads the REAL value out of spiff.js rather than copying it, so an edit to the list
   there is what this test sees too. */
function grabIndentedVar(name, src) {
  const re = new RegExp('\\bvar\\s+' + name + '\\s*=');
  const m = re.exec(src);
  if (!m) throw new Error('boot_hedge_test: no such var in spiff.js: ' + name);
  let i = m.index + m[0].length;
  while (/\s/.test(src[i])) i++;
  const start = i;
  let depth = 0, inStr = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i) - 1; continue; }
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) depth--;
    else if (c === ';' && depth === 0) break;
  }
  return new Function('return (' + src.slice(start, i) + ');')();
}

/* Every action name this engine's doGet/doPost switch statements recognize, so §2 catches a typo
   in ENGINE_HEDGE_READS (a name hedged that Code.gs does not even answer) and §3 has the real
   write list to check against rather than a hand-copied one that could drift from Code.gs. */
function switchActions(src, fnStart) {
  const names = [];
  const re = /case\s+'([A-Za-z_]+)'\s*:/g;
  const body = src.slice(fnStart);
  const stop = body.search(/\n}\n/);            // end of the enclosing function
  const scoped = stop < 0 ? body : body.slice(0, stop);
  let m;
  while ((m = re.exec(scoped))) names.push(m[1]);
  return names;
}
const doGetStart = engineSrc.search(/\nfunction doGet\(/);
const doPostStart = engineSrc.search(/\nfunction doPost\(/);
if (doGetStart < 0 || doPostStart < 0) throw new Error('boot_hedge_test: could not find doGet/doPost in Code.gs');
const ALL_ACTIONS = Array.from(new Set(switchActions(engineSrc, doGetStart).concat(switchActions(engineSrc, doPostStart))));

/* Hand-vetted against each handler in apps-script/Code.gs on 2026-09-18 (see the file-header
   comment on ENGINE_HEDGE_READS in spiff.js for the same list with the reasoning). A name only
   belongs here if its Code.gs case computes and returns without a sheet write — CacheService
   puts are fine, SpreadsheetApp/.deleteRow/.setValue/.appendRow are not. */
const VETTED_PURE_READS = [
  'ping', 'libversion', 'boot', 'programs', 'program', 'employees', 'diag', 'emailDraft',
  'giftCards', 'brands', 'storeView', 'storeLinks', 'sellthrough', 'catalog', 'refunits',
  'progress', 'history', 'auditPayouts'
];
/* Everything else in ALL_ACTIONS is a write, a session-mint, or not-implemented — never hedgeable.
   Listed explicitly (rather than just "not in VETTED_PURE_READS") so a NEW action Code.gs grows
   defaults to unhedged until someone actively vets and adds it above. */
const KNOWN_WRITES_OR_UNSAFE = ALL_ACTIONS.filter(a => VETTED_PURE_READS.indexOf(a) < 0);

console.log('\n1. ENGINE_HEDGE_READS names this engine\'s own read routes, boot included');
const hedgeReads = grabIndentedVar('ENGINE_HEDGE_READS', js);
ok('boot is hedgeable', hedgeReads.boot === 1);
ok('at least the boot-composed reads are hedgeable (programs, brands, progress, employees)',
   hedgeReads.programs === 1 && hedgeReads.brands === 1 && hedgeReads.progress === 1 && hedgeReads.employees === 1);

console.log('\n2. every hedged name is a real action Code.gs answers, and a vetted pure read');
const hedgedNames = Object.keys(hedgeReads);
const unknown = hedgedNames.filter(n => ALL_ACTIONS.indexOf(n) < 0);
const unvetted = hedgedNames.filter(n => VETTED_PURE_READS.indexOf(n) < 0);
ok('no hedged name is missing from Code.gs\'s switch statement' + (unknown.length ? ' — ' + unknown.join(', ') : ''),
   unknown.length === 0);
ok('no hedged name is outside the vetted pure-read list' + (unvetted.length ? ' — ' + unvetted.join(', ') : ''),
   unvetted.length === 0);

console.log('\n3. THE ONE THAT MUST NOT REGRESS: no known write or session-mint is ever hedged');
const hedgedWrites = hedgedNames.filter(n => KNOWN_WRITES_OR_UNSAFE.indexOf(n) >= 0);
ok('none of ' + KNOWN_WRITES_OR_UNSAFE.length + ' known write/unsafe actions appear in ENGINE_HEDGE_READS' +
   (hedgedWrites.length ? ' — FOUND: ' + hedgedWrites.join(', ') : ''),
   hedgedWrites.length === 0);
/* Spot-check the highest-stakes ones by name, so this fails loudly and specifically rather than
   only through the generic scan above if the vetted list itself is ever edited wrong. */
['editProgram', 'createProgram', 'deleteProgram', 'renameProgramId', 'addBrand', 'saveBrand',
 'saveBrandContact', 'removeBrandContact', 'storeLinkMintAll', 'storeLinkRotate', 'publishToCore',
 'recordActuals', 'snapshotProgress', 'refreshProgress', 'rollStatuses', 'sweepOrphanProgress',
 'clientView', 'login', 'bugreport', 'buildReport', 'shareLink'
].forEach(w => ok('  "' + w + '" is not hedged', !hedgeReads[w]));

console.log('\n4. bootOnce asks for a shorter, more resilient budget than the old 45000/1');
function sandboxBoot(jsonpImpl) {
  const src = [
    'var _bootP = null;',
    G.grab('bootOnce', js),
    'return { bootOnce: bootOnce };',
  ].join('\n');
  const ENG = { jsonp: jsonpImpl };
  const api = new Function('ENG', 'session', 'console', src)(
    ENG, () => ({ token: 'TOKEN-123' }), { warn: () => {}, info: () => {} });
  return api;
}

let seenOpts = null;
let B = sandboxBoot(function (action, params, opts) { seenOpts = opts; return Promise.resolve({ ok: true }); });
B.bootOnce();
ok('boot asks with a timeout at or under 20s (was 45000)', seenOpts && seenOpts.timeoutMs <= 20000);
ok('boot asks for at least 2 retries (was 1), so missing both hedge copies still gets another try',
   seenOpts && seenOpts.retries >= 2);
ok('the budget is at least 2x HEDGE_MS (6000ms) or the hedge in gx-client.js never actually fires',
   seenOpts && seenOpts.timeoutMs >= 12000);

console.log('\n5. bootOnce logs timing — an operator can tell a slow open from a silent one');
let infoMsgs = [], warnMsgs = [];
const loggingConsole = { info: (...a) => infoMsgs.push(a.join(' ')), warn: (...a) => warnMsgs.push(a.join(' ')) };
(function () {
  const src = ['var _bootP = null;', G.grab('bootOnce', js), 'return { bootOnce: bootOnce };'].join('\n');
  const ENG = { jsonp: () => Promise.resolve({ ok: true }) };
  const api = new Function('ENG', 'session', 'console', src)(ENG, () => ({ token: 'T' }), loggingConsole);
  return api.bootOnce();
})().then(function () {
  ok('a successful boot logs one info line with a timing figure',
     infoMsgs.length === 1 && /boot answered in [\d.]+s/.test(infoMsgs[0]));

  console.log('\n6. a failed boot warns with how long it waited before falling back');
  let warnMsgs2 = [];
  const src = ['var _bootP = null;', G.grab('bootOnce', js), 'return { bootOnce: bootOnce };'].join('\n');
  const ENG = { jsonp: () => Promise.reject(new Error('jsonp timeout (likely Drive HTML page)')) };
  const api = new Function('ENG', 'session', 'console', src)(
    ENG, () => ({ token: 'T' }), { info: () => {}, warn: (...a) => warnMsgs2.push(a.join(' ')) });
  return api.bootOnce().then(function (r) {
    ok('a failed boot resolves to null (the four-call fallback path), not a rejection', r === null);
    ok('and warns naming the fallback, with a timing figure',
       warnMsgs2.length === 1 && /falling back to the four-call path/.test(warnMsgs2[0]) && /after [\d.]+s/.test(warnMsgs2[0]));

    console.log('\n' + '─'.repeat(30));
    console.log(fail ? fail + ' FAILED' : 'boot hedge: all passed');
    process.exit(fail ? 1 : 0);
  });
}).catch(function (e) {
  console.log('  ✗ the async section threw: ' + (e && e.message || e));
  console.log('\n' + (fail + 1) + ' FAILED');
  process.exit(1);
});
