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
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const scrub = new Function(grab('scrubSecrets_') + '; return scrubSecrets_;')();

/* A STAND-IN, never a real secret. The scrubber matches by PATTERN, not by value, so what this
   proves does not depend on the value being real — and the first version of this file pasted the
   LIVE one in here, which committed it to a public repo and forced a suite-wide rotation on
   2026-09-06. The leak this test exists to prevent is the leak this test caused. Keep it fake. */
const FAKE_SECRET = 'NOT-A-REAL-SECRET-0000000000000';

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

/* ── EVERY PATH THAT CAN CARRY A URL GOES THROUGH IT ──
   The one that leaked was gxSalesByEmployee_'s catch. Missing one of the others just moves the
   leak to a rarer failure, which is worse — it would surface once, months from now. */
/* Updated 2026-09-12 when the transport retry landed. gxSalesByEmployee_ no longer holds its own
   catch — it delegates to gxCoreFetchJson_, which retries the bounce. So the check follows the
   scrubbing rather than the function: each path either scrubs itself or hands off to the helper,
   AND the helper is separately proved to scrub. Naming the helper without that second assertion
   would be the weaker test, since "it calls something" is not "the something redacts". */
['gxSalesByEmployee_', 'gxAuth_', 'gxPublishKioskToken_'].forEach(function (fn) {
  const body = grab(fn);
  ok(fn + ' scrubs its own error path, or hands it to the helper that does',
     /scrubSecrets_/.test(body) || /gxCoreFetchJson_\(/.test(body));
});
ok('gxCoreFetchJson_ scrubs both the thrown message and the give-up line', (function () {
  const h = grab('gxCoreFetchJson_');
  return /catch \(e\) \{\s*last = scrubSecrets_/.test(h) && /scrubSecrets_\(last\)/.test(h);
})());
/* Actually run it: a regex proves the call is written, not that a secret cannot survive the path. */
ok('  …so three thrown fetches carrying the whole URL return no secret', (function () {
  const LEAK = 'Address unavailable: https://x/exec?action=sales_by_employee&secret=' + FAKE_SECRET;
  const f = new Function('UrlFetchApp', 'Utilities', [
    grab('scrubSecrets_'),
    (gs.match(/^var GXCORE_FETCH_[A-Z_]+\s*=.*$/gm) || []).join('\n'),
    grab('gxCoreFetchJson_'), 'return gxCoreFetchJson_;'].join('\n')
  )({ fetch() { throw new Error(LEAK); } }, { sleep() {} });
  const r = f('https://x/exec?secret=' + FAKE_SECRET, 'sell-through');
  return r.ok === false && JSON.stringify(r).indexOf(FAKE_SECRET) < 0;
})());
/* The inventory pull raises rather than returning, and its raw exception used to escape the loop
   entirely. It is caught and scrubbed now; this is the fixture that would have caught the old one. */
ok('the inventory pull no longer lets a raw fetch exception out of its loop',
   /catch \(e\) \{ lastErr = scrubSecrets_/.test(grab('dutchieInventoryViaGXCore_')));
ok('no fetch-error path still interpolates a raw exception message',
   !/error: '[^']*' \+ \(e && e\.message \|\| e\)/.test(gs));
ok('the router’s own catch is scrubbed as well',
   /return \{ ok: false, error: scrubSecrets_\(e && e\.message \|\| e\) \};/.test(gs));

/* The secret file must never be committed. */
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
  // "SKIP" at the start of the line (indented is fine) is the marker every GX repo's CI coverage
  // step looks for. Worded any other way, a reporter shows this file green while one of its
  // comparisons did not run — which is the thing the reporter exists to prevent.
  console.log('  SKIP  live-value check — no .gx_deploy_secret here (gitignored, as it should be)');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nsecret leak: all passed');
process.exit(fail ? 1 : 0);
