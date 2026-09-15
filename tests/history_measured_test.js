#!/usr/bin/env node
/* ─── History shows a closed program's measured results until actuals are recorded ────────────────
 *
 *   RUN:  node tests/history_measured_test.js
 *
 * WHY
 * Sky, 2026-09-15: "in history, the updated performance metrics aren't showing up for the recently
 * closed Mule program." History read ONLY recorded actuals. The Mule Dank Tank program (Aug 31 →
 * Sep 13) was the first to close inside the app rather than arrive from the seed, so it had no
 * recorded actuals — and History printed 0 sold, 0 hit, $0 over a frozen measurement of 168 units
 * and 20 budtenders earning $500.
 *
 * Recording actuals stays a human's step (they go to the vendor), so History SHOWS the measurement
 * and labels it, and recorded actuals always win when they exist.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const histFigures = new Function(grab('histFigures') + 'return histFigures;')();

/* The live record, as it stood on 2026-09-15. */
const MULE = {
  program_id: 'mule-extracts-2026-08-31-2026-09-13', status: 'closed',
  actual_json: null, payout_json: { amount: 25, model: 'flat' },
  cost_json: { mode: 'flat', per_unit: 20 }, baseline_json: { units: 115 }, target_json: { units: 168 },
  progress_json: { units: 168, earners: 20, earned: 500, rate: 25, partial: [],
                   stores: [{ store_id: 'bend', units: 43 }] },
};

let f = histFigures(MULE);
ok('the Mule program shows the 168 units it measured, not 0', f.sold === 168);
ok('  …and the 20 budtenders who earned', f.hit === 20);
ok('  …and the $500 it paid', f.paid === 500);
ok('  …with ROI by the Calculator\'s identity: (168 − 115) × $20 − $500 = +$560', f.roi === 560);
ok('  …labeled as measured, not recorded', f.measured === true && f.recorded === false);

const RECORDED = Object.assign({}, MULE, { actual_json: { units_sold: 170, bts_hit: 21, spiff_amount: 25, roi: 535 } });
f = histFigures(RECORDED);
ok('recorded actuals always win over the measurement', f.sold === 170 && f.hit === 21 && f.roi === 535 && !f.measured);
ok('  …and paid follows them (21 × $25)', f.paid === 525);

f = histFigures(Object.assign({}, MULE, { progress_json: Object.assign({}, MULE.progress_json, { partial: ['river-rd'] }) }));
ok('a measurement missing a store says how many are missing', f.measured && f.partial === 1);

f = histFigures(Object.assign({}, MULE, { progress_json: null }));
ok('nothing recorded and nothing measured is zeros, and claims neither', f.sold === 0 && !f.measured && !f.recorded);

f = histFigures(Object.assign({}, MULE, { progress_json: Object.assign({}, MULE.progress_json, { units: 0, earners: 0, earned: 0 }) }));
ok('a measurement of ZERO units is not presented as a result — it is usually a filter that matches nothing',
   !f.measured && f.sold === 0);

f = histFigures(Object.assign({}, MULE, { actual_json: {} }));
ok('an EMPTY actuals object does not hide the measurement', f.measured && f.sold === 168);

const row = grab('histRow'), render = grab('renderHistory');
ok('each row reads the shared figures', /histFigures\(p\)/.test(row));
ok('  …and says "not yet recorded" when it is showing a measurement', /not yet recorded/.test(row));
ok('the page and month totals use the same figures, so they add up to the rows',
   (render.match(/histFigures\(p\)/g) || []).length === 2 && !/a\.units_sold \|\| 0/.test(render));

console.log(fail ? '\n' + fail + ' FAILED' : '\nhistory measured: all passed');
process.exit(fail ? 1 : 0);
