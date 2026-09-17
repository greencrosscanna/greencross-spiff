#!/usr/bin/env node
/* ─── A secret must never ride out in an error ────────────────────────────────────────────────────
 *
 *   RUN:  node tests/secret_leak_test.js
 *
 * WHY
 * UrlFetchApp puts the WHOLE URL into its exception message — "Address unavailable: https://…" —
 * and the URLs this engine builds carry GX_DEPLOY_SECRET as a query parameter. So one store timing
 * out during a reference pull rendered the live deploy secret into an error banner in the app, in
 * front of whoever was looking at the screen, and into anything they pasted afterwards.
 *
 * Reported by Sky on 2026-09-02, exactly that way. The secret opens every secret-gated route in GX
 * Core — sales_by_employee, dev_claim, dev_update, the payroll-shaped reads — so a leak is a real
 * one, not a tidiness problem.
 *
 * The redaction is by PATTERN, not by comparing against the known secret. Two reasons, and the
 * second is the one that bites: the message can carry a URL-encoded form, and an error raised
 * BEFORE the secret was read has nothing to compare against — so a value-based scrub would pass a
 * live secret straight through on exactly the paths most likely to fail early.
 *
 * REWRITTEN 2026-09-15. The scrubber itself was always executed; the five callers around it were
 * not. Each was a regex over its own source — `/scrubSecrets_/.test(body)`, and for three of them
 * an `||` against `/gxCoreFetchJson_\(/` that made either half sufficient, so a function could
 * satisfy it by mentioning the helper in a comment. Those are now RUN: a fake UrlFetchApp throws
 * the real "Address unavailable: <whole url>" message at each caller in turn and the assertion
 * reads the answer the app would have rendered. What the old shape could not catch is a scrub
 * applied to the wrong string — `scrubSecrets_(r.attempts)` returned into a raw `r.error` passes
 * every regex here and leaks on every bounce. It also could not see a path where the secret is
 * interpolated into the message a SECOND time after the scrub, which no source check reaches at
 * all. What stays source-shaped is one global negative — that no fetch-error path anywhere still
 * interpolates a raw exception — because "nowhere in the file" is not a thing execution can visit.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = G.GS;
const grab = (n) => G.grab(n);
const scrub = new Function(grab('scrubSecrets_') + '; return scrubSecrets_;')();

/* A STAND-IN, never a real secret. The scrubber matches by PATTERN, not by value, so what this
   proves does not depend on the value being real — and the first version of this file pasted the
   LIVE one in here, which committed it to a public repo and forced a suite-wide rotation on
   2026-09-06. The leak this test exists to prevent is the leak this test caused. Keep it fake. */
const FAKE_SECRET = 'NOT-A-REAL-SECRET-0000000000000';

/* ── 1. THE SCRUBBER ITSELF ──────────────────────────────────────────────────────────────────── */
console.log('\n1. the scrubber');

/* The message that actually leaked, shape for shape. */
const LEAKED = 'GX Core unreachable: Address unavailable: '
  + 'https://script.google.com/macros/s/AKfycbx9mjeCB/exec?action=sales_by_employee'
  + '&secret=' + FAKE_SECRET + '&from=2026-08-05&to=2026-09-01'
  + '&stores=commercial&brand=Portland%20Heights';

const out = scrub(LEAKED);
ok('the secret is gone from the message that actually leaked',
   out.indexOf(FAKE_SECRET) < 0);
ok('  …replaced by something that says what happened', /secret=\[redacted\]/.test(out));
/* The rest has to survive, or the fix trades a leak for an unreadable error and the next failure
   takes an afternoon instead of a minute. */
ok('the store it failed on is still readable', out.indexOf('stores=commercial') >= 0);
ok('  …and the filter, and the dates', out.indexOf('brand=Portland%20Heights') >= 0
   && out.indexOf('from=2026-08-05') >= 0);
ok('  …and the reason', out.indexOf('Address unavailable') >= 0);

/* Every credential-ish parameter, not just the one that bit us. */
[['secret', 'abc123'], ['token', 'tok_live_9'], ['key', 'AIzaSy'], ['password', 'hunter2'],
 ['pass', 'letmein']].forEach(function (pair) {
  const s = scrub('https://x/y?a=1&' + pair[0] + '=' + pair[1] + '&b=2');
  ok(pair[0] + '= is redacted too', s.indexOf(pair[1]) < 0 && s.indexOf('b=2') >= 0);
});
ok('case does not matter', scrub('?SECRET=zzz').indexOf('zzz') < 0);
ok('a bare value stops at the & — the next parameter survives',
   scrub('?secret=aaa&stores=bend').indexOf('stores=bend') >= 0);
ok('and at whitespace, for messages that are not URLs',
   /^secret=\[redacted\] and then some$/.test(scrub('secret=aaa and then some')));

/* Never throws — it sits in catch blocks, and a scrubber that dies takes the real error with it. */
ok('null and undefined come back empty rather than throwing',
   scrub(null) === '' && scrub(undefined) === '');
ok('a message with no secret is returned unchanged',
   scrub('GX Core returned HTML (auth or redirect issue)')
     === 'GX Core returned HTML (auth or redirect issue)');
ok('a non-string is coerced, not crashed', scrub(new Error('secret=xyz').message).indexOf('xyz') < 0);

/* ── 2. EVERY PATH THAT CAN CARRY A URL, RUN ─────────────────────────────────────────────────────
 * The one that leaked was gxSalesByEmployee_'s. Missing one of the others just moves the leak to a
 * rarer failure, which is worse — it would surface once, months from now.
 *
 * So each caller is assembled from its REAL source and handed a UrlFetchApp that throws the exact
 * message Google produces, whole URL included. Nothing about the assertion depends on which line
 * does the scrubbing, or on whether the function scrubs at all versus delegating to the helper:
 * the question asked is the only one that matters, which is whether the secret can be read off
 * what the caller returns. `deep` walks the entire answer, not just `.error` — a secret parked in
 * an `attempts` or `url` field renders just as well in a banner.
 */
console.log('\n2. the callers, each run against a throwing fetch');

const THROWN = (url) => new Error('Address unavailable: ' + url);

/* Assemble a slice of the engine's GX Core transport with the fetch under our control. `fetches`
   records every URL attempted, so "it retried" is a count rather than a reading of the loop. */
function transport(opts) {
  const o = opts || {};
  const fetches = [];
  const props = G.makeProps({ GX_DEPLOY_SECRET: o.secret === undefined ? FAKE_SECRET : o.secret });
  const cache = G.makeCache();
  const UrlFetchApp = {
    fetch(url) {
      fetches.push(url);
      if (o.body !== undefined) {
        return { getResponseCode: () => (o.code || 200), getContentText: () => o.body };
      }
      throw THROWN(url);
    },
  };
  const api = G.load({
    real: ['scrubSecrets_', 'gxCoreFetchJson_', 'gxSalesByEmployee_', 'gxAuth_',
           'gxPublishKioskToken_', 'dutchieInventoryViaGXCore_', 'authCacheKey_',
           'authCacheTtl_', 'slug_'],
    vars: ['GXCORE_URL', 'GX_SECRET_PROP', 'APP', 'GXCORE_FETCH_ATTEMPTS',
           'GXCORE_FETCH_BACKOFF_MS', 'GXCORE_FETCH_BUDGET_MS', 'AUTH_CACHE_PREFIX',
           'AUTH_CACHE_TTL_S'],
    /* _authMemo is module state in the engine; a fresh empty one per run keeps one case from
       answering the next out of a memo it never wrote. */
    varValues: { _authMemo: {} },
    globals: { UrlFetchApp, PropertiesService: props.PropertiesService,
               CacheService: cache.CacheService },
  });
  return { api, fetches };
}

/* Everything the caller returns, flattened — a secret is a leak wherever it is parked. */
const deep = (v) => JSON.stringify(v === undefined ? null : v);
const clean = (v) => deep(v).indexOf(FAKE_SECRET) < 0;

/* The helper. The give-up line is assembled from `last`, which is set inside the catch, so it is a
   second, separate chance to leak — it gets its own assertion. */
{
  const t = transport();
  const r = t.api.gxCoreFetchJson_('https://x/exec?action=validate&secret=' + FAKE_SECRET, 'sell-through');
  ok('gxCoreFetchJson_ gives up rather than answering', r.ok === false);
  ok('  …after three attempts, so the retry really ran', t.fetches.length === 3 && r.attempts === 3);
  ok('  …and no secret survives anywhere in what it returns', clean(r));
  ok('  …with the transport failure still named, so the error is worth reading',
     /transport bounce/.test(r.error) && /Address unavailable/.test(r.error));
}

/* The money route. It scrubs r.error a SECOND time on the way out; the point of running it is that
   whether it does or not, the answer carries nothing. */
{
  const t = transport();
  const r = t.api.gxSalesByEmployee_(FAKE_SECRET, '2026-08-05', '2026-09-01', 'commercial',
                                     { brand: 'Portland Heights' });
  ok('gxSalesByEmployee_ refuses rather than reporting zero units', r.ok === false);
  ok('  …and the secret it was CALLED with is not in its answer', clean(r));
  ok('  …though the store it failed on still is', /commercial/.test(r.error));
}

/* The session check. Its own message wraps the helper's, so a scrub applied to the wrapper and not
   the inner string would still read fine in the source.
   THE TOKEN IS THE CREDENTIAL HERE — this URL carries no deploy secret, it carries a live session
   token, which opens every route a signed-in person can reach. So the fixture's token IS the value
   being hunted for: an assertion that looked for a deploy secret in a URL that never holds one
   could not fail, which is no better than not writing it. */
{
  const t = transport();
  const r = t.api.gxAuth_(FAKE_SECRET + ':' + (Date.now() + 3600000));
  ok('gxAuth_ reports it could not reach Core, not that you are signed out', r.ok === false
     && /Could not reach GX Core/.test(r.error));
  ok('  …with the session token really in the URL it attempted',
     t.fetches.length === 3 && t.fetches[0].indexOf(FAKE_SECRET) >= 0);
  ok('  …and no trace of it in what it hands back', clean(r));
}

/* The kiosk write. Single attempt on purpose (it is a write), and its error is rendered straight
   into the kiosk-links panel, so this one is read by a human every time it fires. */
{
  const t = transport();
  const r = t.api.gxPublishKioskToken_('river-rd', 'deadbeef');
  ok('gxPublishKioskToken_ reports the store it failed on', r.ok === false && r.store_id === 'river-rd');
  ok('  …and does not print the deploy secret into the kiosk-links panel', clean(r));
  ok('  …having really put the secret in the URL it attempted — so there WAS one to leak',
     t.fetches.length === 1 && t.fetches[0].indexOf(FAKE_SECRET) >= 0);
}

/* The inventory pull RAISES rather than returning, and its raw exception used to escape the loop
   entirely: the fetch sat outside the try, so a thrown bounce burned attempts two through five
   without making them. Both halves are checked here — the message, and that five attempts happen. */
{
  const t = transport();
  let thrown = null;
  try { t.api.dutchieInventoryViaGXCore_('river-rd'); } catch (e) { thrown = e; }
  ok('dutchieInventoryViaGXCore_ raises when Core never answers', !!thrown);
  ok('  …and no secret rides out on the exception it raises',
     !!thrown && String(thrown.message).indexOf(FAKE_SECRET) < 0);
  ok('  …the fetch is inside the try, so all five attempts are actually made',
     t.fetches.length === 5);
  ok('  …and it did carry the secret, so the redaction is doing work',
     t.fetches.length > 0 && t.fetches[0].indexOf(FAKE_SECRET) >= 0);
}

/* A REFUSAL IS FINAL — the other half of the same loop, and the half a leak test would otherwise
   never reach. Core answering ok:false is an ANSWER; retrying it burns the budget and buries the
   message that would have explained it. */
{
  const t = transport({ body: JSON.stringify({ ok: false, error: 'bad deploy secret' }) });
  let thrown = null;
  try { t.api.dutchieInventoryViaGXCore_('river-rd'); } catch (e) { thrown = e; }
  ok('a refusal from Core is raised on the first attempt, not retried',
     !!thrown && t.fetches.length === 1 && /bad deploy secret/.test(thrown.message));
}

/* ── 3. WHAT EXECUTION CANNOT VISIT ──────────────────────────────────────────────────────────────
   "No path ANYWHERE still does X" is a claim about every line in the file, including the ones no
   fixture reaches and the ones nobody has written yet. There is no way to run that, so it stays a
   grep — and it is a legitimate one, because the shape it bans is the shape that leaked. */
console.log('\n3. the global guard, which has no runnable form');
ok('no fetch-error path still interpolates a raw exception message',
   !/error: '[^']*' \+ \(e && e\.message \|\| e\)/.test(gs));

/* DELETED 2026-09-15: `ok('the router’s own catch is scrubbed as well', /return { ok: false, error:
   scrubSecrets_(e && e.message || e) };/.test(gs))`. It passed, and it was not about the router.
   That line appears once in the file, in libVersion_. doGet and doPost both catch with
   `String(err && err.message || err)` — unscrubbed — so the assertion's label described behavior
   the engine does not have, and a file-wide grep let an unrelated function vouch for it. Replaced
   below by the claim that IS true and executable. The router's own catch — the gap this file used
   to paper over — is exercised immediately after it, and was fixed the day it was found. */
{
  const props = G.makeProps({});
  const api = G.load({
    real: ['libVersion_', 'scrubSecrets_'],
    vars: ['APP'],
    globals: {
      PropertiesService: props.PropertiesService,
      GXCore: { libVersion() { throw THROWN('https://x/exec?secret=' + FAKE_SECRET); } },
    },
  });
  const r = api.libVersion_();
  ok('libVersion_ — the diagnostic run against a live deploy — scrubs its own catch',
     r.ok === false && clean(r) && /Address unavailable/.test(r.error));
}
/* THE ROUTER'S OWN CATCH, which was the hole this file used to claim was covered (found
   2026-09-15 while converting it, fixed the same day). Every named leak path scrubs at its own
   catch; a handler that THROWS a UrlFetchApp failure instead of catching it lands here, and
   Google's message is "Address unavailable: <the whole url>" — deploy secret included, printed
   into an error banner on whatever screen made the call. Run, on both doors. */
{
  const thrower = () => { throw THROWN('https://script.google.com/exec?secret=' + FAKE_SECRET
                                       + '&action=libversion'); };
  const sent = [];
  const api = G.load({
    real: ['doGet', 'doPost', 'scrubSecrets_'],
    vars: ['APP', 'EDIT_ROLES'],
    stubs: {
      guard_: () => null,                       // authorized; the throw is the subject here
      reply_: (out) => { sent.push(out); return out; },
      libVersion_: thrower,
      gxAuth_: () => ({ ok: true, user: 'sky', role: 'admin' }),
      saveProgram_: thrower,
      nowStamp_: () => '2026-09-15 14:00:00',
    },
  });
  api.doGet({ parameter: { action: 'libversion' } });
  ok('doGet scrubs an exception that reaches its own catch',
     sent.length === 1 && sent[0].ok === false && clean(sent[0]));
  ok('  …while still saying what failed', /Address unavailable/.test(sent[0].error)
     && /secret=\[redacted\]/.test(sent[0].error));
  api.doPost({ postData: { contents: JSON.stringify({ action: 'saveProgram', token: 't' }) } });
  ok('doPost does the same', sent.length === 2 && clean(sent[1])
     && /secret=\[redacted\]/.test(sent[1].error));
}

/* ── 3b. THE TWO EXITS THEMSELVES ────────────────────────────────────────────────────────────────
 *
 * Everything above asks whether a NAMED path scrubs. This asks the question the other way round,
 * which is the one that kept getting the wrong answer: whatever a route returns, and whatever this
 * app mails, has been through the scrub — no matter which catch built it or whether anybody
 * remembered. Four apps were audited by hand on 2026-09-17 and every one had an exit nobody had
 * counted, none of them for want of a scrub function.
 *
 * The fixture is deliberately an error NOTHING ELSE IN THIS FILE SCRUBS: a raw exception message
 * parked on a field by a route that has no redaction of its own. If these pass, it is the exit
 * doing the work and not a caller that happened to be careful.
 */
console.log('\n3b. every reply, and every mail');

const RAW = 'Address unavailable: https://script.google.com/macros/s/AK/exec'
  + '?action=publish_spiff_progress&secret=' + FAKE_SECRET + '&scope=2026-09-01';

{
  const made = [];
  const ContentService = {
    createTextOutput: (s) => { made.push(s); return { setMimeType: function () { return this; } }; },
    MimeType: { JAVASCRIPT: 'application/javascript', JSON: 'application/json' },
  };
  const api = G.load({
    real: ['reply_', 'scrubSecrets_'],
    globals: { ContentService },
  });

  /* The plain JSON door. */
  api.reply_({ ok: false, error: RAW });
  ok('a reply cannot carry the deploy secret, whichever catch built it',
     made.length === 1 && made[0].indexOf(FAKE_SECRET) < 0);
  ok('  …and still says what failed', /secret=\[redacted\]/.test(made[0])
     && made[0].indexOf('Address unavailable') >= 0);

  /* The JSONP door, which is the one the browser actually uses — writes ride on GET here. */
  api.reply_({ ok: false, error: RAW }, 'cb7');
  ok('the JSONP door scrubs too, not just the JSON one',
     made.length === 2 && made[1].indexOf(FAKE_SECRET) < 0 && made[1].indexOf('cb7(') === 0);

  /* NESTED, because a payload is not flat: publishToCore returns a `failed` array of per-scope
     errors, and a scrub applied to the top-level `error` field would miss every one of them. The
     serialized body is what goes through the scrub precisely so depth cannot matter. */
  api.reply_({ ok: true, failed: [{ scope: '2026-09-01', error: RAW }], note: { why: RAW } });
  ok('a secret nested anywhere in the payload goes too, not just a top-level error',
     made[2].indexOf(FAKE_SECRET) < 0);

  /* The trade has to stay small: a reply that redacts the answer is its own failure. */
  const ok_payload = { ok: true, rows: [{ employee: 'tawny', units: 12, earned: 25 }],
                       token: 'abc123def', program_id: 'portland-heights-2026-08-17-2026-08-30' };
  api.reply_(ok_payload);
  ok('an ordinary payload is untouched — the kiosk token is a FIELD, not a query parameter',
     made[3] === JSON.stringify(ok_payload));
}

{
  /* MAIL IS THE WORSE EXIT: a screen shows an error once, an email is forwarded and stays
     searchable. Run from bugUnfiled_ — the real caller, whose `why` is String(e.message) off a
     failed GXCore.gxIngestBug — rather than from sendMail_ alone, so what is pinned is that the
     notice goes THROUGH the funnel and not that the funnel would scrub if anything called it. */
  const sent = [];
  const api = G.load({
    real: ['bugUnfiled_', 'bugNotify_', 'sendMail_', 'scrubSecrets_'],
    vars: ['BUG_WATCH_EMAIL'],
    stubs: { bugMailOnce_: () => true, nowStamp_: () => '2026-09-17 21:00:00' },
    globals: { MailApp: { sendEmail: (m) => { sent.push(m); } } },
  });
  api.bugUnfiled_('tawny', { priority: 'high', appVer: 'v1.434', context: '' },
                  'Progress grid is empty', 'nothing loads',
                  'GX Core could not be reached: ' + RAW);
  ok('the unfiled-bug notice does not mail the deploy secret to an inbox',
     sent.length === 1 && String(sent[0].body).indexOf(FAKE_SECRET) < 0);
  ok('  …and still carries the failure and the report it is preserving',
     String(sent[0].body).indexOf('Address unavailable') >= 0
     && String(sent[0].body).indexOf('nothing loads') >= 0);
  ok('  …and went to the watch address', sent[0].to === 'sky@greencrosscanna.com');

  /* THE SUBJECT TOO. It carries the bug title, and a title is typed by a person who may well have
     pasted the error they were shown into it. */
  sent.length = 0;
  api.bugNotify_('⚠️ UNFILED SPIFF bug: ' + RAW, ['x'], 'tawny',
                 { priority: 'normal', appVer: '', context: '' }, 't', 'd');
  ok('a subject is scrubbed as well as a body',
     sent.length === 1 && String(sent[0].subject).indexOf(FAKE_SECRET) < 0);
}

/* ── 4. THE FILE ON DISK ─────────────────────────────────────────────────────────────────────── */
console.log('\n4. the secret never enters the repo');
const ignored = fs.readFileSync(__dirname + '/../.gitignore', 'utf8');
ok('.gx_deploy_secret is gitignored', /^\.gx_deploy_secret$/m.test(ignored));

/* Belt and braces, and the reason is this file's own history: it must never again hold the live
   value. Compared against the real secret when one is present locally, skipped in CI where it is
   not — a check that cannot run is not a check that passed, so it says which happened. */
try {
  const live = fs.readFileSync(__dirname + '/../.gx_deploy_secret', 'utf8').trim();
  ok('this test file does not contain the live deploy secret',
     !!live && fs.readFileSync(__filename, 'utf8').indexOf(live) < 0);
} catch (e) {
  console.log('  SKIP  live-value check — no .gx_deploy_secret here (gitignored, as it should be)');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nsecret leak: all passed');
process.exit(fail ? 1 : 0);
