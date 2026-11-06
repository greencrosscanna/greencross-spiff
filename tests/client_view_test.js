#!/usr/bin/env node
/* ─── The vendor link is RETIRED, and every way in says so ──────────────────────────────────────
 *
 *   RUN:  node tests/client_view_test.js
 *
 * WHY THIS FILE IS NOW SHORT
 * It used to pin what the vendor page SAID (units, goal, lift) and who could open it. Sky retired
 * the self-serve link on 2026-11-05: Tawny already sends the close-out PDF, the live login mostly
 * duplicated it, and a password shared by every vendor was the app's weakest outside door. What
 * replaced it is an editor's progress snapshot (see tests/progress_snapshot_test.js).
 *
 * So the guarantee reverses. clientView_ must refuse EVERY request with the plain message, whatever
 * is sent — a good token, a rep who really is on the brand, the right shared password, or nothing —
 * and must not so much as touch the program list, GX Core or the failure counter. Links already
 * emailed must land on a page that says so, not on a 404 and not on a sign-in form.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const MSG = 'This link is no longer active. Ask Tawny for a progress report.';

/* Anything the old route read is a tripwire: if the refusal touches it, the refusal is not a refusal. */
let touched = [];
const trip = (n) => () => { touched.push(n); throw new Error('clientView_ must not read ' + n); };
const eng = G.load({
  real: ['clientView_'],
  vars: ['CLIENT_LINK_RETIRED_MSG'],
  stubs: { listProgramsCached_: trip('programs'), listPrograms_: trip('programs'),
           gxStores_: trip('stores'), progressRowsFor_: trip('progress') },
  globals: {
    CacheService: { getScriptCache: trip('cache') },
    PropertiesService: { getScriptProperties: trip('properties') },
    GXCore: { resolveBrand: trip('core'), getBrands: trip('core') },
  },
}).clientView_;

console.log('every request is refused');
[
  ['a good link, a real rep and the right shared password',
   { t: 'shr-begoat', email: 'dana@begoat.example', pass: 'shared-pass' }],
  ['a link with no email or password', { t: 'shr-begoat' }],
  ['no link at all (the old "choose a program" path)', { email: 'dana@begoat.example', pass: 'shared-pass' }],
  ['an empty request', {}],
  ['a made-up token', { t: 'nope', email: 'x@y.example', pass: 'guess' }],
].forEach(([label, req]) => {
  const r = eng(req);
  ok(label + ': refused with the plain message', r.ok === false && r.error === MSG);
  ok('  …and it says retired, with no program or choices in the answer',
     r.retired === true && !r.program && !r.choices);
});
ok('nothing was read to decide that (no programs, no Core, no cache, no password)', touched.length === 0);

console.log('the page');
const html = fs.readFileSync(__dirname + '/../client.html', 'utf8');
ok('client.html still exists, so an emailed link is not a 404', html.length > 0);
ok('  …says the link is no longer active and to ask Tawny',
   /no longer active/i.test(html) && /Ask Tawny for a progress report/.test(html));
ok('  …has no email or password box, and no sign-in button',
   !/type="password"|type="email"|id="cvGo"|id="cvEmail"|id="cvPass"/.test(html));
ok('  …loads no script that could call the engine (no client.js, no gx-client)',
   !/client\.js/.test(html) && !/gx-client\.js/.test(html));
ok('client.js is gone', !fs.existsSync(__dirname + '/../client.js'));

console.log('no new links can be made');
{
  let saved = 0;
  const share = G.load({
    real: ['shareLink_'],
    vars: ['CLIENT_LINK_RETIRED_MSG', 'EDIT_ROLES'],
    stubs: {
      gxAuth_: () => ({ ok: true, role: 'admin', user: 'tawny' }),
      getProgram_: () => ({ ok: true, program: { program_id: 'p1', share_token: '' } }),
      saveProgram_: () => { saved++; },
    },
  }).shareLink_;
  const r = share({ token: 't', id: 'p1' });
  ok('minting is refused with the same message, even for an admin', r.ok === false && r.error === MSG);
  ok('  …and writes nothing to the record', saved === 0);
  const rv = share({ token: 't', id: 'p1', revoke: '1' });
  ok('revoking a stale token off a record still works', rv.ok === true && rv.revoked === true && saved === 1);
}

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
ok('the program list and record panel offer no brand link any more',
   !/Create brand link|Copy brand link|data-share|client\.html\?t=/.test(js));

process.exit(fail ? 1 : 0);
