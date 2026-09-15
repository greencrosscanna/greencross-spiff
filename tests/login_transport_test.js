#!/usr/bin/env node
/* ─── Sign-in runs on OUR engine, never through GX Core /exec ─────────────────────────────────────
 *
 *   RUN:  node tests/login_transport_test.js
 *
 * WHY
 * Apps Script serializes execution per script. A browser signing in at GX Core /exec therefore
 * waits behind everything GX Core is doing for the whole suite — and the JSONP shape this app used
 * measured 3.6-6.4s against 2.5s for plain JSON, spiking to 42s, with one attempt returning
 * Google's Drive HTML page instead of an answer (core-admin, 2026-09-03).
 *
 * The retry made it worse, not better. Abandoning a JSONP attempt does NOT cancel the execution —
 * it keeps its slot — so attempt N+1 queued behind the one we gave up on. That is "GX jsonp login
 * failed after 5 tries", which Sky hit on spiff and crew the same day. Sales never had it, because
 * Sales signs in against its OWN deployment; that is architecture, not luck.
 *
 * WHAT THIS PINS, and why each half is load-bearing:
 *
 *   1. No login call goes to GX Core from the browser. THREE call sites, not one — the operator
 *      modal, the full-page gate, and the budtender flyer. The note that asked for this named all
 *      three precisely because the ones you miss keep failing, silently and only for the users who
 *      happen to enter through them.
 *   2. The engine's login route is PUBLIC. It runs before anyone is authenticated, so a session
 *      gate on it is a contradiction — and a gated login route fails as "Not signed in", which
 *      reads like a broken route rather than a missing gate.
 *   3. No deploy secret anywhere near it. UrlFetchApp puts the whole URL into its exception
 *      message; that is how the live secret reached an on-screen error banner on 2026-09-02.
 *   4. The whole payload is returned. GXCore.login carries token, expiresAt, user (the slug),
 *      role, displayName and avatarConfig. Returning a hand-picked subset is what once showed the
 *      slug and bare initials where the person's name and avatar belong.
 *
 * REWRITTEN 2026-09-15. Points 2, 3 and 4 were regexes over login_'s source and over the two
 * action lists, and each of the three could be satisfied without the behavior existing:
 *
 *   · `/'login'/.test(publicLine)` reads the array's TEXT. It says nothing about guard_, which is
 *     the function that decides. The route is now driven through guard_ and then through doGet
 *     with no token and no secret, so what is proved is that an anonymous browser gets in.
 *   · `/return\s+r\s*;/` matched the source of a function that returns the library's answer, and
 *     matched equally a function that built a subset above and returned that instead — `return r;`
 *     appearing anywhere in the body was enough. The payload is now compared field for field
 *     against what the stubbed GXCore handed over.
 *   · `/GXCore\.login\s*\([^)]*APP\s*\)/` proves the token APP is typed in the call. It cannot see
 *     which value arrives, so a route that read the app key off the request would pass it as long
 *     as the parameter were named APP. The call is now captured and its arguments read, with a
 *     caller-supplied `app=inventory` sent alongside as the control.
 *
 * What stays source-shaped is the three BROWSER call sites. spiff.js, flyer.js and client.js sign
 * in from inside a DOM — a modal, a full-page gate, a flyer — and there is no way to reach that
 * code in node without standing up a browser, which would test the fixture more than the app.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');
const R = __dirname + '/../';

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const spiff  = fs.readFileSync(R + 'spiff.js', 'utf8');
const flyer  = fs.readFileSync(R + 'flyer.js', 'utf8');
const client = fs.readFileSync(R + 'client.js', 'utf8');
const APP    = G.grabVar('APP');

/* ── 1. THE BROWSER SIDE — source-shaped, and it has to be ───────────────────────────────────────
   These three files are DOM code. Reaching the login call means a document, a form and an event,
   so what is checked here is which client object the call is written against. GX is the GX Core
   client; ENG is our engine. A login through GX is the regression. */
console.log('\n1. no frontend calls GX Core to log in  (source-shaped: DOM code)');
[['spiff.js', spiff], ['flyer.js', flyer], ['client.js', client]].forEach(([name, src]) => {
  ok(name + ' does not route login through the GX Core client',
     !/\bGX\s*\.\s*(jsonp|getJSON|postJSON)\s*\(\s*['"]login['"]/.test(src));
});

/* Every surface that signs a user in must use OUR engine. Counted, not merely "at least one" —
   a partial migration is the failure this is here to catch. */
console.log('\n2. all three sign-in surfaces call the engine');
const engLogins = (src) => (src.match(/\bENG\s*\.\s*getJSON\s*\(\s*['"]login['"]/g) || []).length;
ok('spiff.js signs in at the engine twice — the modal AND the full-page gate', engLogins(spiff) === 2);
ok('flyer.js signs in at the engine', engLogins(flyer) === 1);

/* getJSON, not jsonp: a bounded per-attempt deadline, and a parsed {ok:false} is an ANSWER that
   resolves rather than a miss that retries. Retrying a refusal is how a wrong password becomes a
   retry storm. */
console.log('\n3. bounded transport, and the retry rule');
[['spiff.js', spiff], ['flyer.js', flyer]].forEach(([name, src]) => {
  const calls = src.match(/ENG\.getJSON\('login'[^;]*/g) || [];
  ok(name + ' bounds every login attempt with an explicit timeout',
     calls.length > 0 && calls.every(c => /timeoutMs:\s*\d+/.test(c)));
  ok(name + '  …and caps the retries', calls.length > 0 && calls.every(c => /retries:\s*\d+/.test(c)));
});

/* ── 4. THE GATE, RUN ────────────────────────────────────────────────────────────────────────────
   guard_ returns null when a call may proceed and the refusal to send when it may not, so the
   whole question — "can somebody who is not signed in call login" — is one invocation. Driven with
   a deploy secret PRESENT on the script and none supplied by the caller, which is the state that
   would expose login as secret-gated: guard_ answers SECRET_ACTIONS before it looks at a session,
   so a login on that list comes back Unauthorized here and only here. */
console.log('\n4. the gate, run');

function gate(opts) {
  const o = opts || {};
  const props = G.makeProps({ GX_DEPLOY_SECRET: 'NOT-A-REAL-SECRET-0000000000000' });
  const seen = [];
  const api = G.load({
    real: ['guard_'],
    vars: ['PUBLIC_ACTIONS', 'SECRET_ACTIONS', 'GATED_WRITES', 'GX_SECRET_PROP', 'EDIT_ROLES'],
    stubs: {
      /* The control. If login ever stops being public this fires, and the assertion below can say
         so specifically rather than reporting a generic refusal. */
      gxAuth_: (tok) => { seen.push(tok); return o.auth || { ok: false, error: 'Not signed in' }; },
    },
    globals: { PropertiesService: props.PropertiesService },
  });
  return { api, seen };
}

{
  const g = gate();
  ok('an anonymous caller may reach login — no token, no secret, no refusal',
     g.api.guard_('login', {}) === null);
  ok('  …and the gate never even asked whether they were signed in', g.seen.length === 0);
  /* The negative control. Without it, a guard_ that returned null for EVERYTHING would pass the
     line above, which is the assertion-that-cannot-fail this rewrite exists to remove. */
  const denied = g.api.guard_('editProgram', {});
  ok('  …while a gated route with the same empty request IS refused',
     !!denied && denied.ok === false && denied.needsAuth === true);
  const secretRoute = g.api.guard_('publishToCore', {});
  ok('  …and a secret-only route refuses when the caller brings no secret',
     !!secretRoute && secretRoute.error === 'Unauthorized');
}

/* ── 5. THE ROUTE, END TO END ────────────────────────────────────────────────────────────────────
   doGet is the real dispatch: guard, switch, reply. Running it is what proves `login` is wired in
   — a case that was deleted would land on the default and answer "Unknown action", which no regex
   over the switch can distinguish from a case that is present but unreachable behind the guard. */
console.log('\n5. the route, end to end');

const PAYLOAD = {
  ok: true, token: 'tok-abc:1789999999999', expiresAt: 1789999999999,
  user: 'sky', role: 'admin', displayName: 'Sky Pinnick',
  avatarConfig: { style: 'initials', color: '#2f6f3e' }, code: '',
};

/* One /exec call, run for real. Returns the parsed reply plus everything the route touched on the
   way: what GXCore was asked, what was read out of Script Properties, what was logged. */
function call(params, opts) {
  const o = opts || {};
  const calls = [], reads = [], logged = [];
  const props = {
    getScriptProperties: () => ({
      getProperty(k) { reads.push(k); return k === 'GX_DEPLOY_SECRET' ? 'NOT-A-REAL-SECRET-0000000000000' : null; },
    }),
  };
  const spyLog = { log: (...a) => logged.push(a.join(' ')) };
  const api = G.load({
    real: ['doGet', 'guard_', 'login_', 'reply_', 'scrubSecrets_'],
    vars: ['APP', 'PUBLIC_ACTIONS', 'SECRET_ACTIONS', 'GATED_WRITES', 'GX_SECRET_PROP', 'EDIT_ROLES'],
    stubs: { gxAuth_: () => ({ ok: false, error: 'Not signed in' }) },
    globals: {
      PropertiesService: props,
      Logger: spyLog,
      console: { log: spyLog.log, warn: spyLog.log, error: spyLog.log },
      ContentService: {
        MimeType: { JSON: 'application/json', JAVASCRIPT: 'text/javascript' },
        createTextOutput(text) { return { text: text, setMimeType() { return this; } }; },
      },
      GXCore: o.core === null ? undefined : (o.core || {
        login(user, pass, app) {
          calls.push({ user, pass, app, args: arguments.length });
          if (o.coreThrows) throw new Error(o.coreThrows);
          return o.coreAnswer === undefined ? PAYLOAD : o.coreAnswer;
        },
      }),
    },
  });
  const out = api.doGet({ parameter: params });
  return { api, calls, reads, logged, raw: out.text, body: JSON.parse(out.text) };
}

{
  const r = call({ action: 'login', user: 'sky', pass: 'hunter2' });
  ok('a sign-in with no token reaches login_ and is answered', r.body.ok === true);
  ok('  …not "Unknown action", so the case is really wired into the dispatch',
     !/Unknown action/.test(r.raw));
  ok('  …and GXCore.login was called exactly once', r.calls.length === 1);
}

/* THE WHOLE PAYLOAD. Field by field against what the library handed over, not a spot-check: the
   failure this guards against is a hand-picked subset, and a subset passes any check that names
   only the fields somebody remembered to name. */
{
  const r = call({ action: 'login', user: 'sky', pass: 'hunter2' });
  ok('the library\'s payload comes back WHOLE, field for field',
     JSON.stringify(r.body) === JSON.stringify(PAYLOAD));
  ok('  …so displayName and avatarConfig survive the trip',
     r.body.displayName === 'Sky Pinnick' && r.body.avatarConfig.style === 'initials');
  ok('  …and `code` rides along, which is how the browser tells no_access from a bad password',
     Object.prototype.hasOwnProperty.call(r.body, 'code'));
}

/* THIS APP'S OWN KEY. A grant is per-app, so the app key decides which door opens — reading it off
   the request would let a caller ask GX Core to sign them in against Inventory's grant and hand
   the resulting session to SPIFF. */
{
  const r = call({ action: 'login', user: 'sky', pass: 'hunter2', app: 'inventory' });
  /* `|| {}` so a route that never reaches the library reports a clean failure here rather than
     aborting the run on the next line — it makes the assertion fail, never pass. */
  const c = r.calls[0] || {};
  ok('GXCore.login is asked about THIS app, whatever the caller said',
     c.app === APP && APP === 'spiff');
  ok('  …and the caller\'s own app parameter is ignored entirely',
     r.calls.length === 1 && c.app !== 'inventory');
  ok('  …with the user and password passed through as typed',
     c.user === 'sky' && c.pass === 'hunter2');
}

/* ── 6. WHAT IT SAYS WHEN IT CANNOT SIGN ANYONE IN ───────────────────────────────────────────────
   Every one of these is a route failure, and every one of them used to be indistinguishable from
   "wrong password" — which a person answers by typing the same password again, forever. */
console.log('\n6. a broken pin is not a bad password');
const saysUnavailable = (b) =>
  b.ok === false && /unavailable/i.test(String(b.error)) && !/password|credential/i.test(String(b.error));

ok('GXCore not bound at all — reported as unavailable',
   saysUnavailable(call({ action: 'login', user: 'sky', pass: 'x' }, { core: null }).body));
ok('a pin too old to have login() — reported as unavailable',
   saysUnavailable(call({ action: 'login', user: 'sky', pass: 'x' }, { core: {} }).body));
ok('the library returning nothing — reported as unavailable, not as bad credentials',
   saysUnavailable(call({ action: 'login', user: 'sky', pass: 'x' }, { coreAnswer: null }).body));

/* A blank field is the one case that IS about what the person typed, and it must not cost a
   library call — asking GX Core to validate an empty password is a round trip to learn nothing. */
{
  const blank = call({ action: 'login', user: '', pass: 'x' });
  ok('a missing user is refused here, without troubling GX Core',
     blank.body.ok === false && blank.calls.length === 0);
  ok('  …and is worded as something to fix, not as a fault',
     /Enter your user and password/.test(String(blank.body.error)));
  const noPass = call({ action: 'login', user: 'sky', pass: '' });
  ok('a missing password likewise', noPass.body.ok === false && noPass.calls.length === 0);
}

/* ── 7. THE SECRET, AND THE PASSWORD ─────────────────────────────────────────────────────────────
   login_ answers anonymous callers, so the deploy secret must not be within reach of it, and the
   password is in its frame. Both are now facts about a run rather than about the text: the
   Properties stub records every key read, and Logger/console are spies. */
console.log('\n7. nothing from this frame rides out');
const SECRET = 'NOT-A-REAL-SECRET-0000000000000';

{
  const r = call({ action: 'login', user: 'sky', pass: 'hunter2' });
  /* guard_ reads GX_DEPLOY_SECRET for every non-public action, so a read here would mean login had
     stopped being public — and login_ itself has no business asking for it on any path. */
  ok('no Script Property is read anywhere on a successful sign-in', r.reads.length === 0);
  ok('  …and nothing was logged', r.logged.length === 0);
  ok('  …the password is not in the reply', r.raw.indexOf('hunter2') < 0);
}
{
  /* The throw path is where the secret actually leaked in 2026-09-02: UrlFetchApp puts the whole
     URL into the exception message, and login_ interpolates that message into its error. */
  const r = call({ action: 'login', user: 'sky', pass: 'hunter2' },
                 { coreThrows: 'Address unavailable: https://x/exec?action=validate&secret=' + SECRET });
  ok('a thrown library error is reported, not swallowed',
     r.body.ok === false && /Sign-in failed/.test(String(r.body.error)));
  ok('  …with the secret scrubbed out of it', r.raw.indexOf(SECRET) < 0
     && /secret=\[redacted\]/.test(String(r.body.error)));
  ok('  …the reason still readable', /Address unavailable/.test(String(r.body.error)));
  ok('  …and the password still nowhere in the reply or the log',
     r.raw.indexOf('hunter2') < 0 && r.logged.join('|').indexOf('hunter2') < 0);
}

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'login transport: all passed');
process.exit(fail ? 1 : 0);
