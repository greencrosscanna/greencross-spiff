#!/usr/bin/env node
/* ─── Actual unit lift on the vendor report (Sky, 2026-11-03) ─────────────────────────────────────
 *
 *   RUN:  node tests/unit_lift_test.js
 *
 * "412 units sold, up 96 (+30%) from the period before." Runs the real unitLiftOf_ and the real
 * brandPaperHtml_ (the one builder behind the preview, the email body and the PDF).
 * Sky's rules: no usable baseline or no recorded actuals means NO lift line; a drop is shown
 * honestly; the vendor copy carries no budtender names.
 */
'use strict';
const G = require('./_gas');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const D = G.load({
  real: ['unitLiftOf_', 'brandPaperHtml_', 'brandProgramLabel_', 'prettyDay_', 'payoutFactsOf_',
         'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_', 'measuredRowsFor_'],
  vars: ['LOGO_ONLIGHT', 'BTS_PER_STORE'],
  stubs: { displayNameMap_: () => ({}), friendlyName_: (m, id, n) => n,
           gxStores_: () => [{ store_id: 'river-rd', display_name: 'River Rd' },
                             { store_id: 'commercial', display_name: 'Commercial St' }] },
  globals: { console: { warn() {}, log() {} } },
});

/* ── the rule itself ── */
let l = D.unitLiftOf_(412, 316);
ok('positive: +96 units, +30%', l && l.delta === 96 && l.pct === 30);
ok('  …reads "412 units sold, up 96 (+30%) from the period before."',
   l.line === '412 units sold, up 96 (+30%) from the period before.');
l = D.unitLiftOf_(388, 400);
ok('negative: shown honestly as −12 units (−3%)', l && l.short === '−12 units (−3%)');
ok('  …and the sentence says down', /down 12 \(−3%\)/.test(l.line));
ok('baseline 0 → no line', D.unitLiftOf_(300, 0) === null);
ok('baseline missing → no line', D.unitLiftOf_(300, undefined) === null && D.unitLiftOf_(300, '') === null);
ok('no recorded actuals (null / blank) → no line, not a drop to zero',
   D.unitLiftOf_(null, 400) === null && D.unitLiftOf_(undefined, 400) === null && D.unitLiftOf_('', 400) === null);
ok('a recorded zero IS a real zero (−100%), not hidden', D.unitLiftOf_(0, 400).pct === -100);

/* ── the vendor document ── */
const prog = (over) => Object.assign({
  program_id: 'x-202611', vendor: 'Acme', program_name: 'Acme Fall', status: 'closed',
  start_date: '2026-10-05', end_date: '2026-10-18', stores_json: ['river-rd', 'commercial'],
  payout_type: 'flat', payout_json: { model: 'flat', amount: 25 },
  target_json: { units: 400, by_store: { 'river-rd': 200, commercial: 200 }, per_bt: {} },
  baseline_json: { units: 316, by_store: { 'river-rd': 150, commercial: 166 } },
  actual_json: { units_sold: 412, bts_hit: 5, spiff_amount: 25, investment: 125 },
}, over || {});
const measured = { by_store: { 'river-rd': 240, commercial: 172 }, rows: [
  { store_id: 'river-rd', name: 'SKYLER P', units: 240, hit: true },
  { store_id: 'commercial', name: 'TAWNY R', units: 172, hit: true } ] };

let html = D.brandPaperHtml_(prog(), measured);
ok('flat program: the lift sentence is on the page', html.includes('412 units sold, up 96 (+30%) from the period before.'));
ok('  …with a per-store line', html.includes('River Rd +90 units (+60%)') && html.includes('Commercial St +6 units (+4%)'));
ok('vendor copy has no budtender names', !/SKYLER|TAWNY R/.test(html));

html = D.brandPaperHtml_(prog({ payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 0.75 } }), measured);
ok('per_unit program: lift is units too', html.includes('412 units sold, up 96'));

html = D.brandPaperHtml_(prog({ actual_json: { units_sold: 388, bts_hit: 2, spiff_amount: 25 },
  baseline_json: { units: 400, by_store: {} } }), { by_store: {}, rows: [] });
ok('a drop prints on the page', html.includes('388 units sold, down 12 (−3%)'));

html = D.brandPaperHtml_(prog({ baseline_json: { units: 0 } }), measured);
ok('zero baseline: no lift line', !/from the period before/.test(html));
html = D.brandPaperHtml_(prog({ baseline_json: {} }), measured);
ok('missing baseline: no lift line', !/from the period before/.test(html));
html = D.brandPaperHtml_(prog({ actual_json: {} }), measured);
ok('no recorded actuals: no lift line', !/from the period before/.test(html));
html = D.brandPaperHtml_(prog({ baseline_json: { units: 316 } }), { by_store: { 'river-rd': 240 }, rows: [] });
ok('no by-store baseline: chain total only', html.includes('up 96') && !/By store:/.test(html));


/* ── Kaprikorn shape: by-store baselines, NO by-store actuals (found live 2026-11-03: email said every
      store sold 0, down 100%, while the chain was up). Absent is not zero. ── */
const kap = prog({ actual_json: { units_sold: 726, bts_hit: 3, spiff_amount: 25 },
  baseline_json: { units: 316, by_store: { 'river-rd': 150, commercial: 166 } } });
html = D.brandPaperHtml_(kap, { by_store: {}, rows: [] });
ok('Kaprikorn: headline lift stays (+410)', html.includes('726 units sold, up 410'));
ok('  …no per-store line at all', !/By store:/.test(html) && !/−100%/.test(html));
let mrows = D.measuredRowsFor_(prog({ progress_json: { at: '2026-10-19', stores: [
  { store_id: 'river-rd', rows: [] }, { store_id: 'commercial', units: 0, rows: [] } ] } }));
ok('snapshot stores without units are left out of by_store', Object.keys(mrows.by_store).length === 0);
mrows = D.measuredRowsFor_(prog({ progress_json: { at: '2026-10-19', stores: [
  { store_id: 'commercial', units: 0, rows: [{ name: 'A', units: 0, hit: false }] } ] } }));
ok('a measured zero (with people behind it) IS kept', mrows.by_store.commercial === 0);

/* mixed: one store with actuals, one without → one row */
html = D.brandPaperHtml_(kap, { by_store: { 'river-rd': 240 }, rows: [] });
ok('mixed: exactly one per-store row', /By store: River Rd \+90 units \(\+60%\)</.test(html) && !/Commercial St [+−]/.test(html));
html = D.brandPaperHtml_(prog({ baseline_json: { units: 316, by_store: { 'river-rd': 150 } } }), { by_store: { 'river-rd': 240, commercial: 172 }, rows: [] });
ok('a store with no baseline gets no row', /By store: River Rd \+90/.test(html) && !/Commercial St [+−]/.test(html));

/* ── the staff screen's twin (spiff.js `unitLift`) must agree with the engine, case for case ── */
const fs = require('fs');
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const i = js.indexOf('function unitLift(');
let d = 0, end = -1;
for (let k = js.indexOf('{', i); k < js.length; k++) {
  if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) { end = k; break; } }
}
const twin = new Function(js.slice(i, end + 1) + '; return unitLift;')();
[[412, 316], [388, 400], [300, 0], [300, undefined], [null, 400], ['', 400], [0, 400], [316, 316]].forEach(([s, b]) => {
  const a = D.unitLiftOf_(s, b), t = twin(s, b);
  ok('twin agrees for sold=' + s + ' before=' + b, (a === null && t === null) || (a && t && a.line === t.line && a.short === t.short));
});

process.exit(fail ? 1 : 0);
