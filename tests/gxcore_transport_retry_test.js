#!/usr/bin/env node
/* ─── A GOOGLE ROUTING BOUNCE IS NOT AN AUTH FAILURE ──────────────────────────────────────────────
 *
 *   RUN:  node tests/gxcore_transport_retry_test.js
 *
 * WHAT BROKE. GX Core's web-app `/exec` endpoint bounces intermittently: the same request either
 * answers in ~2s or stalls and comes back as Google's HTML error page. Measured 2026-09-11/12 —
 * five or six failures in ten consecutive calls during a bad spell, and four of six legs on one
 * Sales page load the next day.
 *
 * `gxSalesByEmployee_` is the call behind SPIFF's sell-through and every vendor payout number. It
 * already DETECTED the bounce — `if (body.indexOf('<') === 0)` — and then gave up on the first
 * one, telling the reader it was "auth or redirect issue". So during a bad spell a payout simply
 * failed, and the message sent whoever was standing there to check a deploy secret that was never
 * wrong. One more call, 500ms later, would usually have worked.
 *
 * THE CONTRACT THIS FILE PINS, and the distinction is the whole point:
 *
 *   RETRYABLE — TRANSPORT. A thrown fetch, a non-200 response, a body that is HTML rather than
 *   JSON, a body that will not parse. Nothing at the far end formed an opinion; the request never
 *   arrived or the answer never came back.
 *
 *   NOT RETRYABLE — AN ANSWER. A parsed `{ok:false, error:'bad deploy secret'}` is GX Core
 *   answering correctly. Retrying it costs three times the wait and fails anyway, and — worse —
 *   buries the message that would have explained it. `dutchieInventoryViaGXCore_` has drawn that
 *   line correctly since 2026-08-31 ("A refusal is final"); this makes it the rule rather than
 *   one function's good habit.
 *
 * READS ONLY. Retrying a write is a different question with a different answer, and the helper
 * says so in its own comment. The kiosk-token `set_config` call is a write and is deliberately
 * left on a single attempt.
 *
 * WHAT MAKES EACH ASSERTION BELOW FAIL is named beside it, because an assertion whose fixture
 * cannot produce a failure is measuring the fixture.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* The three module-level constants, lifted verbatim rather than retyped — a test that restates a
   threshold is pinning its own copy of it. Missing ones surface as a ReferenceError inside the
   harness, which is a louder failure than silently defaulting. */
const KNOBS = (gs.match(/^var GXCORE_FETCH_[A-Z_]+\s*=.*$/gm) || []).join('\n');

/* A STAND-IN, never the live value — same rule as secret_leak_test.js, and for the same reason:
   that file once pasted the real secret in and forced a suite-wide rotation. */
const FAKE_SECRET = 'NOT-A-REAL-SECRET-0000000000000';

/* Google's error page, shape for shape — this is what the bounce actually returns. */
const HTML = '<!DOCTYPE html><html><head><title>Error</title></head><body>'
           + 'Sorry, unable to open the file at this time.</body></html>';

/* ── The real functions, run with UrlFetchApp and Utilities faked ────────────────────────────────
   Nothing is stubbed out FROM the code under test: the retry loop, the HTML sniff, the parse and
   the message are all the shipped ones. Only the two Apps Script globals below are ours, and
   `sleep` records rather than waits so the backoff is observable instead of merely endured. */
function harness(responses) {
  const calls = [];
  const slept = [];
  let i = 0;
  const UrlFetchApp = {
    fetch(url) {
      calls.push(url);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.throws) throw new Error(r.throws);
      return { getResponseCode: () => (r.code == null ? 200 : r.code),
               getContentText: () => r.body };
    }
  };
  const Utilities = { sleep(ms) { slept.push(ms); } };
  const api = new Function(
    'UrlFetchApp', 'Utilities', 'GXCORE_URL',
    [grab('scrubSecrets_'),
     /* The module-level knobs the helper reads, taken from the source AS WRITTEN — not retyped
        here, or this would be testing a copy of them. */
     KNOBS,
     grab('gxCoreFetchJson_'),
     grab('gxSalesByEmployee_'),
     'return { fetchJson: gxCoreFetchJson_, salesByEmployee: gxSalesByEmployee_ };'
    ].join('\n')
  )(UrlFetchApp, Utilities, 'https://script.google.com/macros/s/FAKE/exec');
  return { api, calls, slept };
}

const SELL = h => h.api.salesByEmployee(FAKE_SECRET, '2026-08-17', '2026-08-30', 'commercial',
                                        { brand: 'Portland Heights' });

/* ══════════════════ 1. THE KNOBS EXIST AND ARE BOUNDED ══════════════════ */
/* FAILS IF: the constants are missing, or someone widens the budget to something a person waiting
   on a payout screen would sit through. Three attempts is the ceiling the brief set. */
ok('a GX Core read gets exactly 3 attempts',
   /GXCORE_FETCH_ATTEMPTS\s*=\s*3\b/.test(gs));
ok('  …with a short backoff between them — 500ms then 1500ms',
   /GXCORE_FETCH_BACKOFF_MS\s*=\s*\[\s*500\s*,\s*1500\s*\]/.test(gs));

/* ══════════════════ 2. AN HTML BOUNCE RETRIES, AND THEN SUCCEEDS ══════════════════ */
/* THE BUG, exactly. FAILS IF: the first HTML body ends the call — which is what shipped, and what
   this fixture produced before the fix (one attempt, `ok:false`, "auth or redirect issue"). */
{
  const h = harness([{ body: HTML },
                     { body: JSON.stringify({ ok: true, rows: [{ name: 'Ari', units: 12 }],
                                              totals: { units: 12, revenue: 240 } }) }]);
  const r = SELL(h);
  ok('one HTML bounce is retried and the second attempt answers', r.ok === true);
  ok('  …and the real payload comes back intact', r.totals && r.totals.units === 12);
  ok('  …after exactly two fetches', h.calls.length === 2);
  ok('  …having waited 500ms before the retry',
     h.slept.length === 1 && h.slept[0] === 500);
}

/* ══════════════════ 3. THREE BOUNCES FAIL, AND SAY WHAT HAPPENED ══════════════════ */
/* FAILS IF: the loop is unbounded (it would never return), or the message still blames auth.
   The second half is the part that cost a person time: the shipped message sent the reader to
   check a secret that was never wrong. */
{
  const h = harness([{ body: HTML }, { body: HTML }, { body: HTML }]);
  const r = SELL(h);
  ok('three HTML bodies in a row give up', r.ok === false);
  ok('  …after 3 attempts and no more', h.calls.length === 3);
  ok('  …having backed off 500ms then 1500ms', h.slept.join(',') === '500,1500');
  ok('  …and the message names how many attempts were made', /3 attempts/.test(r.error));
  ok('  …and says it was a transport failure', /transport/i.test(r.error));
  ok('  …and does NOT send the reader to check a secret or an authorization',
     !/auth/i.test(r.error));
}

/* ══════════════════ 4. A REAL ANSWER IS NEVER RETRIED ══════════════════ */
/* FAILS IF: the retry triggers on `ok:false` rather than on transport. The fixture is built so a
   retry would SUCCEED — the second response is a valid ok:true — so a wrong implementation
   returns ok:true here and this assertion catches it. A fixture where attempt two also failed
   would pass either way and would be measuring itself. */
{
  const h = harness([{ body: JSON.stringify({ ok: false, error: 'bad deploy secret' }) },
                     { body: JSON.stringify({ ok: true, totals: { units: 999 } }) }]);
  const r = SELL(h);
  ok('a parsed {ok:false} is returned as-is, not retried', r.ok === false);
  ok('  …with GX Core\'s own words, not ours', r.error === 'bad deploy secret');
  ok('  …after exactly ONE fetch', h.calls.length === 1);
  ok('  …and no backoff was spent', h.slept.length === 0);
}

/* ══════════════════ 5. A THROWN FETCH RETRIES ══════════════════ */
/* This is the stall case: UrlFetchApp raises rather than returning a body. FAILS IF: the throw
   escapes the loop (the caller sees an exception instead of a retry) or ends it on attempt one. */
{
  const h = harness([{ throws: 'Address unavailable: https://script.google.com/macros/s/FAKE/exec'
                              + '?action=sales_by_employee&secret=' + FAKE_SECRET },
                     { body: JSON.stringify({ ok: true, totals: { units: 7 } }) }]);
  const r = SELL(h);
  ok('a thrown fetch is retried rather than propagated', r.ok === true && r.totals.units === 7);
  ok('  …after two fetches', h.calls.length === 2);
}

/* ══════════════════ 6. A NON-200 AND AN UNPARSEABLE BODY ARE TRANSPORT TOO ══════════════════ */
/* FAILS IF: only the leading-`<` sniff is treated as a bounce. Google's 429/500 answers are not
   always HTML, and a truncated JSON body is the same class of nothing-arrived. */
{
  const h = harness([{ code: 500, body: 'upstream error' },
                     { body: JSON.stringify({ ok: true, totals: { units: 3 } }) }]);
  const r = SELL(h);
  ok('a non-200 response is retried', r.ok === true && h.calls.length === 2);
}
{
  const h = harness([{ body: '{"ok":true,"rows":[' },
                     { body: JSON.stringify({ ok: true, totals: { units: 4 } }) }]);
  const r = SELL(h);
  ok('a truncated body is retried', r.ok === true && h.calls.length === 2);
}

/* ══════════════════ 7. THE SECRET NEVER RIDES OUT ══════════════════ */
/* FAILS IF: the thrown message — which carries the WHOLE url, secret included — reaches the
   returned error unscrubbed. That is the 2026-09-02 leak, reproduced here on the retry path
   where it would otherwise have to be rediscovered. */
{
  const LEAKY = 'Address unavailable: https://script.google.com/macros/s/FAKE/exec'
              + '?action=sales_by_employee&secret=' + FAKE_SECRET + '&stores=commercial';
  const h = harness([{ throws: LEAKY }, { throws: LEAKY }, { throws: LEAKY }]);
  const r = SELL(h);
  ok('after three thrown fetches the error carries no secret',
     r.ok === false && JSON.stringify(r).indexOf(FAKE_SECRET) < 0);
  ok('  …but still says which store and what went wrong',
     /stores=commercial/.test(r.error) && /Address unavailable/.test(r.error));
  ok('  …and marks the redaction rather than silently dropping it',
     /secret=\[redacted\]/.test(r.error));
}
/* The URL the helper is handed is never echoed wholesale on the give-up path either. */
{
  const h = harness([{ body: HTML }, { body: HTML }, { body: HTML }]);
  const r = SELL(h);
  ok('an HTML give-up leaks no secret', JSON.stringify(r).indexOf(FAKE_SECRET) < 0);
}

/* ══════════════════ 8. THE HELPER IS DOCUMENTED AS READ-ONLY ══════════════════ */
/* FAILS IF: someone wraps a write in it without thinking about idempotency. The brief asked for
   the constraint to live IN the helper, not only in a chat message that scrolls away. */
{
  const helper = grab('gxCoreFetchJson_');
  const before = gs.slice(0, gs.indexOf(helper));
  const preamble = before.slice(-2600);
  ok('the helper states that it is for READS and why writes are different',
     /idempot/i.test(preamble + helper) && /\bread/i.test(preamble + helper));
}

/* ══════════════════ 9. EVERY GX CORE READ OVER HTTP USES IT ══════════════════ */
/* FAILS IF: a read is added later with a bare UrlFetchApp.fetch, or one of today's is missed.
   Two are named as deliberate exceptions:
     • gxPublishKioskToken_      — a WRITE (set_config). Single attempt on purpose.
     • dutchieInventoryViaGXCore_ — has its own 5-attempt loop tuned for a thousands-of-rows pull,
       and already refuses to retry a refusal. Left as it is, except that a thrown fetch now
       retries instead of aborting the loop. */
{
  ok('the sell-through read goes through the helper',
     /gxCoreFetchJson_\(/.test(grab('gxSalesByEmployee_')));
  ok('  …and no longer decides on its own that HTML means an auth problem',
     !/auth or redirect issue/.test(grab('gxSalesByEmployee_')));
  ok('the session check goes through the helper too — a bounce must not sign a person out',
     /gxCoreFetchJson_\(/.test(grab('gxAuth_')));
  const kiosk = grab('gxPublishKioskToken_');
  ok('the kiosk-token WRITE is deliberately not retried, and says so',
     /UrlFetchApp\.fetch/.test(kiosk) && /(not retried|single attempt|idempot)/i.test(kiosk));
  const inv = grab('dutchieInventoryViaGXCore_');
  ok('the inventory pull keeps its own loop and still refuses to retry a refusal',
     /for \(var i = 0; i < 5; i\+\+\)/.test(inv) && /data\.ok === false/.test(inv));
  ok('  …and a thrown fetch inside it now retries instead of aborting all five',
     /try \{\s*resp = UrlFetchApp\.fetch/.test(inv));
}

/* ══════════════════ 10. gxStores_ NO LONGER TAKES THE HOP AT ALL ══════════════════ */
/* `getStores()` reads the GX Core spreadsheet BY ID, so it runs inside this execution — no second
   hop, nothing to bounce. The rule that permits this is GX Core's own: a library function may be
   called from a spoke IF it only touches things opened by id; the moment it needs one of Core's
   ScriptProperties it has to be a web route. `getSalesByEmployee` fails that test by construction
   (it reads Dutchie keys from Core's properties), which is why section 2 above must stay HTTP.
   FAILS IF: someone reverts it to ?action=stores, or "improves" the sell-through read into a
   library call. */
{
  const st = grab('gxStores_');
  ok('gxStores_ calls the library, not the web route', /GXCore\.getStores\(\)/.test(st));
  ok('  …and makes no HTTP request', !/UrlFetchApp/.test(st) && !/action=stores/.test(st));
  ok('the sell-through read is NOT turned into a library call',
     !/GXCore\.getSalesByEmployee/.test(gs));
}

/* The SHAPE, actually computed — the route wraps the array as {stores:[…]} and derives two fields
   the library returns raw, so a straight swap is not obviously safe and was not assumed. */
{
  const cacheStore = {};
  const CacheService = { getScriptCache: () => ({
    get: k => (k in cacheStore ? cacheStore[k] : null),
    put: (k, v, ttl) => { cacheStore[k] = v; cacheStore.__ttl = ttl; },
  }) };
  /* Raw sheet rows, in sheet order (which is NOT sort order) — Center before Century, the way
     gxRead_ hands them back. */
  const RAW = [
    { store_id: 'River-Rd', display_name: 'River',   dutchie_name: 'River Rd', sort_order: 6, active: 'TRUE' },
    { store_id: 'bend',     display_name: 'Century', dutchie_name: 'Bend',     sort_order: 1, active: 'TRUE' },
    { store_id: 'center',   display_name: 'Center',  dutchie_name: 'Center',   sort_order: 2, active: 'TRUE' },
  ];
  const mk = () => new Function('GXCore', 'CacheService', 'UrlFetchApp',
    [grab('slug_'), grab('gxStores_'), 'return gxStores_;'].join('\n')
  )({ getStores: () => JSON.parse(JSON.stringify(RAW)) }, CacheService,
    { fetch() { throw new Error('gxStores_ must not make an HTTP request'); } });

  const out = mk()();
  ok('it returns the array itself, not the route\'s {stores:[…]} wrapper', Array.isArray(out));
  ok('  …with every store present', out.length === 3);
  /* FAILS IF: store_id is passed through raw. "River-Rd" from the sheet would never match the
     'river-rd' every caller compares against, and the vendor report would show a slug where a
     store name belongs. */
  ok('  …store_id slugged the way the route publishes it',
     out.map(s => s.store_id).join(',') === 'bend,center,river-rd');
  /* FAILS IF: the sort is dropped. The route sorts and the callers that iterate — the kiosk-link
     panel, the mint-all sweep — render in whatever order they are given. */
  ok('  …sorted by sort_order, not sheet order',
     out.map(s => s.display_name).join(',') === 'Century,Center,River');
  ok('  …carrying the fields callers read', out[0].display_name === 'Century'
     && out[0].dutchie_name === 'Bend');
  /* FAILS IF: the 900-second cache is lost in the swap — every caller would re-read the registry. */
  ok('the 900-second cache survives the swap', cacheStore.__ttl === 900);
  const second = mk()();
  ok('  …and a second call is served from it',
     Array.isArray(second) && second.length === 3 && second[0].store_id === 'bend');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\ngxcore transport retry: all passed');
process.exit(fail ? 1 : 0);
