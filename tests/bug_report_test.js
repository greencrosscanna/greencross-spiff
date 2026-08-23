#!/usr/bin/env node
/* ─── SPIFF bug reporter — routing, bucketing and failure tests ───────────────────────────────────
 *
 *   RUN:  node tests/bug_report_test.js        (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE TESTS EXIST
 * A bug reporter is the one feature whose failures are invisible by construction. If it buckets to the
 * wrong app the report is not lost, it is just filed where nobody triages it; if it swallows an error
 * the user reads "✓ Reported — thank you!" over a report that does not exist. Neither shows up in
 * normal use, and neither can be checked by opening the app. So they get checked here.
 *
 * THE TWO THINGS THAT MUST NOT DRIFT
 *   1. app='inventory', tab='spiff'. SPIFF is an Inventory SUB-APP, so its bugs bucket to Inventory
 *      with 'spiff' as the discriminator — GX Core's GX_TAB_OWNER maps 'inventory:spiff' back to the
 *      spiff chat for the 🐞 brain note, so nothing is lost by filing under the parent. Price Cards
 *      hardcodes the identical pair. The notes key and the bug tab are NOT the same thing, and the
 *      easy mistake — passing SPIFF's own key, or letting the client's panel name through as `tab` —
 *      is exactly what test 1 and test 2 pin down.
 *   2. A failed ingest must surface as ok:false. There is no email fallback in this app.
 *
 * HOW IT LOADS THE REAL CODE
 * Reads apps-script/Code.gs as text and evaluates it with the Apps Script globals stubbed, so it tests
 * the SHIPPED source rather than a copy that can drift — same pattern as payout_math_test.js.
 */
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

// What the fake GX Core library recorded on the last call, and what it should do next.
let ingest = null;         // { app, reporter, payload }
let ingestBehaviour = () => ({ ok: true, id: 'bug_test1' });

const stubs = {
  SpreadsheetApp: {}, DriveApp: {}, DocumentApp: {}, Utilities: {},
  // gxAuth_ validates the token by fetching GX Core. Every token that reaches here is "valid" and
  // resolves to a VIEWER — the lowest role — because the reporter must work for one.
  UrlFetchApp: {
    fetch: () => ({ getContentText: () => JSON.stringify({ ok: true, user: 'tawny', role: 'viewer' }) }),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => '', setProperty: () => {} }) },
  ScriptApp: {}, Session: {}, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  HtmlService: {},
  ContentService: {
    MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
    createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
  },
  CacheService: {}, MailApp: {}, GmailApp: {}, Logger: { log: () => {} },
  GXCore: {
    gxIngestBug: (app, reporter, payload) => {
      ingest = { app, reporter, payload };
      return ingestBehaviour();
    },
  },
};
const names = Object.keys(stubs);
const load = new Function(...names,
  src + '\n; return { reportBug_, doGet, guard_, PUBLIC_ACTIONS, GATED_WRITES };');
const S = load(...names.map(n => stubs[n]));

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS  ' + label); } else { fail++; console.log('  FAIL  ' + label); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label + (JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

// gxAuth_ memoises per token, so every case uses a fresh one — otherwise a later test reads an
// earlier test's cached auth and passes for the wrong reason.
let n = 0;
const tok = () => 'tok' + (++n);
const reset = () => { ingest = null; ingestBehaviour = () => ({ ok: true, id: 'bug_test1' }); };

// ── 1. bucketing — the whole point ───────────────────────────────────────────
console.log('\n1. sub-app bucketing: app=inventory, tab=spiff');
{
  reset();
  const r = S.reportBug_({ token: tok(), title: 'Progress shows zero units', desc: 'all stores', priority: 'high' });
  ok(r.ok === true, 'a valid report succeeds');
  eq(ingest.app, 'inventory', 'files under the PARENT app, not "spiff"');
  eq(ingest.payload.tab, 'spiff', 'carries the sub-app discriminator in `tab`');
  eq(ingest.payload.priority, 'high', 'priority is passed through');
  eq(r.id, 'bug_test1', 'returns the id GX Core minted');
}

// ── 2. the client cannot change where a report lands ─────────────────────────
console.log('\n2. bucketing is hardcoded, never taken from the caller');
{
  reset();
  // A caller sending its own app/tab — which is what the panel name would look like if the frontend
  // passed state.tab through as `tab`, and what an attacker would send to file into another board.
  S.reportBug_({ token: tok(), title: 'x', app: 'spiff', tab: 'history' });
  eq(ingest.app, 'inventory', 'a caller-supplied app is ignored');
  eq(ingest.payload.tab, 'spiff', 'a caller-supplied tab is ignored — "history" must not become the bucket');
}

// ── 3. the reporter is the validated session, not a client claim ─────────────
console.log('\n3. reporter identity comes from the token');
{
  reset();
  S.reportBug_({ token: tok(), title: 'x', reporter: 'someone-else' });
  eq(ingest.reporter, 'tawny', 'reporter is the user GX Core validated, not the one posted');
}

// ── 4. failures are NOT swallowed ────────────────────────────────────────────
console.log('\n4. a failed ingest never reports success (there is no email fallback here)');
{
  reset();
  ingestBehaviour = () => ({ ok: false, error: 'title or detail required' });
  const refused = S.reportBug_({ token: tok(), title: 'x' });
  ok(refused.ok === false, 'GX Core refusing the report is a failure here too');
  ok(/title or detail required/.test(refused.error), "GX Core's own reason is passed back, not replaced");

  reset();
  ingestBehaviour = () => { throw new Error('library not bound'); };
  const threw = S.reportBug_({ token: tok(), title: 'x' });
  ok(threw.ok === false, 'a throw from the library is a failure, not a silent ok');
  ok(/library not bound/.test(threw.error), 'the underlying message survives to the user');

  reset();
  ingestBehaviour = () => null;
  ok(S.reportBug_({ token: tok(), title: 'x' }).ok === false, 'a null response is a failure');
}

// ── 5. an empty report is refused before it reaches GX Core ──────────────────
console.log('\n5. nothing to report');
{
  reset();
  const r = S.reportBug_({ token: tok(), title: '   ', desc: '' });
  ok(r.ok === false, 'blank title and blank details is refused');
  ok(ingest === null, 'and never reaches GX Core');

  reset();
  ok(S.reportBug_({ token: tok(), desc: 'the calculator hangs' }).ok === true,
     'details with no title is still a report — GX Core derives the title');
}

// ── 6. auth: signed in, but not edit-gated ───────────────────────────────────
console.log('\n6. who may file');
{
  reset();
  const anon = S.reportBug_({ title: 'x' });          // no token at all
  ok(anon.ok === false, 'a signed-out caller is refused');
  ok(anon.needsAuth === true, 'and is told to sign in rather than shown a generic error');
  ok(ingest === null, 'nothing is filed for an unauthenticated caller');

  ok(S.PUBLIC_ACTIONS.indexOf('bugreport') < 0, 'bugreport is NOT public — it is a write to a shared table');
  ok(S.GATED_WRITES.indexOf('bugreport') < 0,
     'bugreport is NOT edit-gated — a viewer is the person most likely to notice a bug');
  ok(S.guard_('bugreport', { token: tok() }) === null, 'a signed-in VIEWER passes the guard');
}

// ── 7. the route is actually reachable ───────────────────────────────────────
console.log('\n7. wired into doGet — writes ride on GET (JSONP is GET-only)');
{
  reset();
  const res = S.doGet({ parameter: { action: 'bugreport', token: tok(), title: 'from the router' } });
  const body = JSON.parse(res.getContent());
  ok(body.ok === true, 'doGet?action=bugreport reaches the handler');
  eq(ingest.payload.title, 'from the router', 'and passes the report through');
  eq([ingest.app, ingest.payload.tab], ['inventory', 'spiff'], 'still buckets correctly through the router');

  const unknown = JSON.parse(S.doGet({ parameter: { action: 'bugReport', token: tok() } }).getContent());
  ok(unknown.ok === false && /Unknown action/.test(unknown.error),
     'the spelling is exactly "bugreport" — camelCase is a different, unknown action');
}

// ── 8. the pin floor — context is dropped silently below GXCore v211 ─────────
console.log('\n8. GXCore pin is high enough for the context snapshot to land');
{
  /* gxWrite_ maps records onto the sheet's REAL header row, so a column GX_TABS knows about but the
     sheet does not is dropped SILENTLY. GXCore v211 is where gxIngestBug started self-installing the
     bug_reports.context header. Below that the report still returns ok while its snapshot — route,
     filters, viewport, last console error — vanishes: the reporter looks like it works while filing
     half of each report. A floor, not an equality, so a future re-pin upward still passes. */
  const manifest = JSON.parse(fs.readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));
  const lib = (manifest.dependencies.libraries || []).find(l => l.userSymbol === 'GXCore');
  ok(!!lib, 'the manifest still binds GXCore');
  ok(Number(lib.version) >= 211,
     'pinned GXCore v' + (lib && lib.version) + ' >= 211, so bug_reports.context is self-installed');
  ok(lib.developmentMode === false, 'and it is a fixed version, not developmentMode');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
