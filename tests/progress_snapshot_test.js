#!/usr/bin/env node
/* ─── Tawny's progress snapshot: the brand page, mid-program, no names ───────────────────────────
 *
 *   RUN:  node tests/progress_snapshot_test.js
 *
 * WHY
 * The vendor link is retired (Sky, 2026-11-05; tests/client_view_test.js). What replaces it is an
 * editor's "Download progress report": the SAME brand page the close-out uses (brandPaperHtml_, one
 * builder for preview, email and PDF), built from what has been measured so far, labeled with its
 * as-of time. This runs the real route against a running program and reads the document a vendor
 * would be handed. What it must never do: name a budtender, call a mid-program figure a credit
 * request, write to the record, or send anything.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const RUNNING = {
  program_id: 'mule-2026-11', vendor: 'Mule Extracts', program_name: 'Mule Dank Tank', status: 'active',
  start_date: '2026-11-02', end_date: '2026-11-15',
  stores_json: ['river-rd', 'commercial'],
  payout_json: { model: 'flat', amount: 25 }, cost_json: { per_unit: 8 },
  baseline_json: { units: 40, by_store: { 'river-rd': 25, commercial: 15 } },
  target_json: { units: 100, by_store: { 'river-rd': 60, commercial: 40 }, per_bt: { 'river-rd': 10, commercial: 10 } },
  actual_json: null,      // running: nothing recorded yet
  progress_json: null,
};
const LIVE = { ok: true, refreshed_at: '2026-11-05T21:30:00', rows: [
  { store_id: 'river-rd',   name: 'SKYLER P', display_name: 'Sky',   units: 12, target: 10, hit: true,  earned: 25 },
  { store_id: 'river-rd',   name: 'JO B',     display_name: 'Jo',    units: 4,  target: 10, hit: false, earned: 0 },
  { store_id: 'commercial', name: 'TAWNY R',  display_name: 'Tawny', units: 11, target: 10, hit: true,  earned: 25 },
] };

let AUTH = { ok: true, user: 'tawny', role: 'editor' };
let saved = 0, sent = 0, spiffCalls = 0;
const api = G.load({
  real: ['progressSnapshot_', 'snapshotProgramOf_', 'measuredRowsFor_', 'brandPaperHtml_', 'payoutFactsOf_',
         'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_', 'friendlyName_', 'userKey_', 'unitLiftOf_',
         'brandProgramLabel_', 'prettyDay_', 'brandSignatureHtml_'],
  vars: ['EDIT_ROLES', 'LOGO_ONLIGHT', 'GX_SECRET_PROP', 'BTS_PER_STORE', 'BRAND_SIGNER_NAME',
         'BRAND_SIGNER_TITLE', 'BRAND_SIG_LOGO', 'BRAND_SIG_LOCATIONS'],
  stubs: {
    gxAuth_: () => AUTH,
    getProgram_: (id) => (id === RUNNING.program_id ? { ok: true, program: RUNNING } : { ok: false, error: 'not found' }),
    gxStores_: () => [{ store_id: 'river-rd', display_name: 'River Rd' }, { store_id: 'commercial', display_name: 'Commercial St' }],
    displayNameMap_: () => ({ byId: {}, byName: {} }),
    spiffProgress_: () => { spiffCalls++; return LIVE; },
    saveProgram_: () => { saved++; },
  },
  globals: {
    PropertiesService: G.makeProps({ GX_DEPLOY_SECRET: 'S' }).PropertiesService,
    GmailApp: { sendEmail: () => { sent++; } },
    Utilities: Object.assign({}, G.Utilities, {
      base64Encode: (b) => 'B64:' + b.length,
      newBlob: (html) => ({ html, getAs: () => ({ setName: (n) => ({ name: n, getName: () => n, getBytes: () => [1, 2, 3] }) }) }),
    }),
  },
});

const r = api.progressSnapshot_({ token: 't', id: RUNNING.program_id });
ok('a running program builds a snapshot', r.ok === true && r.program_id === RUNNING.program_id);
ok('  …labeled with the as-of time of the measurement', r.as_of === '2026-11-05 21:30' && /Progress as of 2026-11-05 21:30/.test(r.html));
ok('  …says it is progress and still running, not final results',
   /SPIFF progress/.test(r.html) && /still running/.test(r.html) && !/SPIFF results/.test(r.html));
ok('  …shows money as earned so far, never as a credit being requested',
   /Earned so far/.test(r.html) && !/Credit requested/.test(r.html));
ok('  …with the units measured so far (12 + 4 + 11 = 27)', />27</.test(r.html));
ok('  …and two people at $25 earned: $50.00', /\$50\.00/.test(r.html));
ok('  …and NO budtender name anywhere in it',
   !/SKYLER|JO B|TAWNY R|>Sky<|>Jo<|>Tawny</.test(r.html.replace(/Tawny Vierra/g, '')));
ok('  …with a PDF file named for the vendor to download',
   /^Green Cross SPIFF Progress - Mule Extracts - \d{6}\.pdf$/.test(r.filename) && /^B64:/.test(r.pdf_base64));
ok('  …without writing to the record or sending anything', saved === 0 && sent === 0);
ok('  …and the stored program was not changed', RUNNING.actual_json === null);

console.log('who may ask');
AUTH = { ok: true, user: 'viewer1', role: 'viewer' };
let n = spiffCalls;
let d = api.progressSnapshot_({ token: 't', id: RUNNING.program_id });
ok('a viewer is refused, and nothing is measured for them', d.ok === false && spiffCalls === n);
AUTH = { ok: false, error: 'expired' };
d = api.progressSnapshot_({ token: 'bad', id: RUNNING.program_id });
ok('a bad session is refused and told to sign in', d.ok === false && d.needsAuth === true);
AUTH = { ok: true, user: 'tawny', role: 'editor' };

console.log('nothing measured yet');
const EMPTY = { ok: true, refreshed_at: '', rows: [] };
const none = G.load({
  real: ['progressSnapshot_', 'snapshotProgramOf_', 'measuredRowsFor_', 'brandPaperHtml_', 'payoutFactsOf_',
         'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_', 'friendlyName_', 'userKey_', 'unitLiftOf_',
         'brandProgramLabel_', 'prettyDay_', 'brandSignatureHtml_'],
  vars: ['EDIT_ROLES', 'LOGO_ONLIGHT', 'GX_SECRET_PROP', 'BTS_PER_STORE', 'BRAND_SIGNER_NAME',
         'BRAND_SIGNER_TITLE', 'BRAND_SIG_LOGO', 'BRAND_SIG_LOCATIONS'],
  stubs: { gxAuth_: () => AUTH, getProgram_: () => ({ ok: true, program: RUNNING }), gxStores_: () => [],
           displayNameMap_: () => ({ byId: {}, byName: {} }), spiffProgress_: () => EMPTY },
  globals: { PropertiesService: G.makeProps({ GX_DEPLOY_SECRET: 'S' }).PropertiesService },
}).progressSnapshot_;
d = none({ token: 't', id: RUNNING.program_id });
ok('an unmeasured program says so instead of handing a vendor a page of zeros', d.ok === false && /Nothing has been measured/.test(d.error));

console.log('the close-out page is unchanged');
const fs = require('fs');
const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
ok('the snapshot reuses brandPaperHtml_ rather than a second builder',
   /brandPaperHtml_\(copy, measured, \{ snapshot:/.test(gs));
ok('and the route is registered for a signed-in editor, not on a secret or public list',
   /case 'progressSnapshot': out = progressSnapshot_\(p\)/.test(gs));

process.exit(fail ? 1 : 0);
