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
 */
'use strict';
const fs = require('fs');
const R = __dirname + '/../';

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs     = fs.readFileSync(R + 'apps-script/Code.gs', 'utf8');
const spiff  = fs.readFileSync(R + 'spiff.js', 'utf8');
const flyer  = fs.readFileSync(R + 'flyer.js', 'utf8');
const client = fs.readFileSync(R + 'client.js', 'utf8');

/* ── 1. the browser never asks GX Core to sign anyone in ─────────────────────────────────────── */
console.log('\n1. no frontend calls GX Core to log in');
[['spiff.js', spiff], ['flyer.js', flyer], ['client.js', client]].forEach(([name, src]) => {
  /* GX is the GX Core client; ENG is our engine. A login through GX is the regression. */
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

/* ── 4. the engine side ──────────────────────────────────────────────────────────────────────── */
console.log('\n4. the engine route');
ok('the router has a login case', /case\s*'login'\s*:/.test(gs));
const publicLine = (gs.match(/var PUBLIC_ACTIONS = \[[^\]]*\]/) || [''])[0];
ok('login is PUBLIC — it runs before anyone is authenticated', /'login'/.test(publicLine));
ok('  …and is not also secret-gated, which would make it unusable from a browser',
   !/var SECRET_ACTIONS = \[[^\]]*'login'/.test(gs));

function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const body = grab('login_');

ok('it calls GXCore.login in-process — that is the whole point',
   /GXCore\.login\s*\(/.test(body));
ok('  …passing this app\'s own key, not one the caller supplied',
   /GXCore\.login\s*\([^)]*APP\s*\)/.test(body) && !/p\.app/.test(body));
ok('it returns GXCore\'s payload WHOLE, so displayName and avatarConfig survive',
   /return\s+r\s*;/.test(body));
ok('a missing pin is reported as unavailable, not as a bad password',
   /libVersion|typeof GXCore\.login !== 'function'|GXCore\.login !== 'function'/.test(body));

/* The secret must not be within reach of a route that answers to anonymous callers. */
ok('no deploy secret is read on the login path',
   !/GX_SECRET_PROP|GX_DEPLOY_SECRET|getProperty/.test(body));
ok('a thrown error is scrubbed before it reaches the browser',
   /scrubSecrets_\(/.test(body));
/* The password is in this frame. It must not reach a log line, an audit row, or a returned field. */
ok('the password is never logged',
   !/Logger\.log[\s\S]*pass|console\.log[\s\S]*pass/.test(body));

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'login transport: all passed');
process.exit(fail ? 1 : 0);
