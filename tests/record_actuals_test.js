#!/usr/bin/env node
/* ─── A closed program's actuals are recorded from its close-out measurement, automatically ───────
 *
 *   RUN:  node tests/record_actuals_test.js
 *
 * WHY
 * Sky, 2026-09-15: "we should automate the pull from dutchie after a program has closed, we shouldn't
 * rely on a human to remember that." The Mule Dank Tank program closed, was measured (168 units, 20
 * budtenders, $500), and sat with no recorded actuals, so History, the vendor report and every total
 * read zero.
 *
 * The four refusals below are the part that matters — each is a failure this app has already had.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const fromSnap = new Function('payoutRateOf_', 'nowStamp_', grab('actualsFromSnapshot_') + 'return actualsFromSnapshot_;')(
  p => Number((p.payout_json || {}).amount) || 0, () => '2026-09-15 14:00:00');

/* The live record, 2026-09-15. */
const MULE = {
  program_id: 'mule-extracts-2026-08-31-2026-09-13', status: 'closed', actual_json: null,
  payout_json: { amount: 25, model: 'flat' }, cost_json: { per_unit: 20 }, baseline_json: { units: 115 },
  progress_json: { at: '2026-09-14 00:56:09', units: 168, earners: 20, earned: 500, rate: 25, partial: [],
                   stores: [{ store_id: 'bend', units: 43 }] },
};
const with_ = (o) => Object.assign({}, MULE, o);

let r = fromSnap(MULE);
ok('the Mule program gets actuals: 168 units, 20 hit, $25, $500 paid', r.actual && r.actual.units_sold === 168
   && r.actual.bts_hit === 20 && r.actual.spiff_amount === 25 && r.actual.investment === 500);
ok('  …revenue is units × cost ($3,360)', r.actual.revenue === 3360);
ok('  …ROI by the Calculator identity: (168 − 115) × $20 − $500 = $560', r.actual.roi === 560);
ok('  …ROI % is ROI over what was paid (1.12)', r.actual.roi_pct === 1.12);
ok('  …and it says a measurement wrote it, not a person', r.actual.source === 'measured' && r.actual.measured_at === '2026-09-14 00:56:09');

r = fromSnap(with_({ actual_json: { units_sold: 170, bts_hit: 21 } }));
ok('RECORDED actuals are never overwritten — they may already be on a vendor report', !r.actual && r.skip === 'already recorded');
r = fromSnap(with_({ progress_json: Object.assign({}, MULE.progress_json, { partial: ['river-rd'] }) }));
ok('a PARTIAL measurement is not recorded, and is handed to a person by name', !r.actual && /river-rd/.test(r.person));
r = fromSnap(with_({ progress_json: Object.assign({}, MULE.progress_json, { units: 0, earners: 0, earned: 0 }) }));
ok('a measurement of ZERO units is not recorded — it is usually a filter matching nothing', !r.actual && /zero/.test(r.person));
r = fromSnap(with_({ status: 'draft' }));
ok('a DRAFT whose window passed is left to a person', !r.actual && !r.person);
r = fromSnap(with_({ progress_json: null }));
ok('a closed program not measured yet waits for the freeze', !r.actual && r.skip === 'not measured yet');
r = fromSnap(with_({ actual_json: {} }));
ok('an EMPTY actuals object counts as not recorded', !!r.actual);

const perUnit = fromSnap(with_({ payout_json: { amount: 1, model: 'per_unit' },
  progress_json: Object.assign({}, MULE.progress_json, { rate: 1, earned: 168, earners: 31 }) }));
ok('a per-unit program pays what the measurement earned (168 × $1)', perUnit.actual.investment === 168 && perUnit.actual.bts_hit === 31);

const rec = grab('recordMeasuredActuals_');
ok('it writes ONE cell, so who last edited the record is untouched', /getRange\(i \+ 2, aCol \+ 1\)\.setValue/.test(rec) && !/edited_by/.test(rec));
ok('it only writes when told to', /if \(apply\) sh\.getRange/.test(rec));
ok('the hourly trigger records, straight after the freeze and before the refresh',
   /snapshot failed[\s\S]*recordMeasuredActuals_\(\{ apply: true \}\)[\s\S]*refreshSpiffProgress_\(\)/.test(grab('refreshSpiffProgressTrigger')));
ok('the on-demand route is secret-gated and dry by default',
   /'recordActuals'\];/.test(gs) && /apply: String\(p\.apply \|\| ''\) === '1'/.test(grab('recordActualsWeb_')));

console.log(fail ? '\n' + fail + ' FAILED' : '\nrecord actuals: all passed');
process.exit(fail ? 1 : 0);
