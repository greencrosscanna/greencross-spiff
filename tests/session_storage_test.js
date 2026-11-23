#!/usr/bin/env node
/* ─── The sign-in lasts 30 days and survives closing the tab (Sky, 2026-11-23) ─────────────────────
 *
 *   RUN:  node tests/session_storage_test.js
 *
 * The sign-in lives in localStorage under 'spiff_session' (was sessionStorage). A session still in
 * sessionStorage is copied across on first read so nobody is signed out by the change; sign-out
 * clears both; the expiresAt check stays.
 *
 * WHAT THIS FILE RUNS. session, setSession and clearSession from spiff.js (the operator app) and
 * from flyer.js, run against fake local and session storage.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

function fake() {
  const s = {};
  return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = v; },
           removeItem: (k) => { delete s[k]; }, _s: s };
}

function build(file, names) {
  const src = fs.readFileSync(__dirname + '/../' + file, 'utf8');
  const body = names.map((n) => G.grab(n, src)).join('\n') +
    '\nreturn { session: session, setSession: setSession, clearSession: clearSession };';
  return (ls, ss) => new Function('localStorage', 'sessionStorage', body)(ls, ss);
}

const SOON = new Date(Date.now() + 29 * 864e5).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

[['spiff.js', ['session', 'setSession', 'clearSession']],
 ['flyer.js', ['session', 'setSession', 'clearSession']]].forEach(([file, names]) => {
  console.log('\n' + file);
  const mk = build(file, names);

  let ls = fake(), ss = fake(), A = mk(ls, ss);
  A.setSession({ user: 'tawny', token: 't', expiresAt: SOON });
  ok('sign-in is written to localStorage', !!ls._s.spiff_session);
  ok('...and not to sessionStorage', !('spiff_session' in ss._s));
  ok('it reads back', A.session().user === 'tawny');

  ls = fake(); ss = fake();
  ss.setItem('spiff_session', JSON.stringify({ user: 'mike', token: 'm', expiresAt: SOON }));
  A = mk(ls, ss);
  ok('a session only in sessionStorage is still honored', A.session() && A.session().user === 'mike');
  ok('...and was copied into localStorage', JSON.parse(ls._s.spiff_session).user === 'mike');

  ls = fake(); ss = fake();
  ls.setItem('spiff_session', JSON.stringify({ user: 'new' }));
  ss.setItem('spiff_session', JSON.stringify({ user: 'old' }));
  ok('localStorage wins when both exist', mk(ls, ss).session().user === 'new');

  ls = fake(); ss = fake();
  ls.setItem('spiff_session', JSON.stringify({ user: 'a' }));
  ss.setItem('spiff_session', JSON.stringify({ user: 'a' }));
  mk(ls, ss).clearSession();
  ok('sign-out clears both stores', !('spiff_session' in ls._s) && !('spiff_session' in ss._s));
  ok('after sign-out nothing comes back from the old tab copy', mk(ls, ss).session() === null);

  if (file === 'spiff.js') {
    ls = fake(); ss = fake();
    ls.setItem('spiff_session', JSON.stringify({ user: 'a', expiresAt: PAST }));
    A = mk(ls, ss);
    ok('an expired session reads as signed out', A.session() === null);
    ok('...and is cleared', !('spiff_session' in ls._s));
  }
});

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
