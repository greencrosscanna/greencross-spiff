#!/usr/bin/env node
/* ─── One program's actuals are never saved onto another ─────────────────────────────────────────
 *
 *   RUN:  node tests/stale_actuals_strip_test.js
 *
 * WHY
 * Tawny's bug, 2026-10-27: "Actuals look copied" on the closed Kaprikorn "All Products" AND on the
 * new, still-running Grön "All products". The warning was right. Grön carried Kaprikorn's measured
 * actuals exactly (1,313 units, 25 hit, $1,250, Kaprikorn's $50 rate and $9.79-cost revenue), with
 * the keys in the order the actuals strip lays them out, which is how it was traced.
 *
 * Opening the closed program painted its figures into the actuals strip. Opening the running one
 * next only HID the strip, and collectPatch reads every [data-key] input in every host, hidden or
 * not, so the next save of the running program wrote the closed one's actuals in as its own.
 * They would have reached Grön's vendor report and gift-card list, and recordMeasuredActuals_
 * never overwrites recorded actuals, so Grön's real result would not have been recorded either.
 *
 * Runs the real collectPatch / recFields / clearActuals from spiff.js against a small fake DOM.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(name, optional) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) { if (optional) return ''; throw new Error('missing ' + name); }
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── A fake DOM: three hosts, each holding [data-key] inputs ── */
function input(key, value) {
  return { dataset: { key }, value: value == null ? '' : String(value), type: 'number' };
}
function host(sel, inputs) {
  return {
    sel, inputs, dataset: {},
    contains(el) { return this.inputs.indexOf(el) >= 0; },
    set innerHTML(v) { if (v === '') this.inputs = []; }
  };
}
const ACT = ['units_sold', 'bts_hit', 'spiff_amount', 'investment', 'roi', 'roi_pct', 'revenue'];
const KAPRIKORN = { program_id: 'kaprikorn-all-products-202610', status: 'closed',
  actual_json: { units_sold: 1313, bts_hit: 25, spiff_amount: 50, investment: 1250,
                 roi: 4437.99, roi_pct: 3.5504, revenue: 12854.27 } };
const GRON = { program_id: 'all-products-202610', status: 'active', actual_json: null };

function world(paintedFor) {
  const H = {
    '#calcRecordBody': host('#calcRecordBody', []),
    '#calcWhenHost':   host('#calcWhenHost', []),
    '#actStrip':       host('#actStrip', ACT.map(k => input('actual_json.' + k, paintedFor.actual_json[k])))
  };
  H['#actStrip'].dataset.programId = paintedFor.program_id;   // what renderActuals leaves behind
  const $  = s => H[s] || null;
  const $$ = s => { const h = H[s.split(' ')[0]]; return h ? h.inputs.slice() : []; };
  const src = [
    'var REC = { body: "#calcRecordBody", when: "#calcWhenHost", act: "#actStrip" };',
    'REC.hosts = [REC.body, REC.when, REC.act];',
    grab('recFields'), grab('clearActuals', true), grab('collectPatch'),
    'return { collectPatch: collectPatch, clearActuals: typeof clearActuals === "function" ? clearActuals : null };'
  ].join('\n');
  return { H, fn: new Function('$', '$$', src)($, $$) };
}

/* ── THE BUG: Kaprikorn painted, Grön saved ── */
let w = world(KAPRIKORN);
let patch = w.fn.collectPatch(GRON);
ok('saving a running program does not pick up the last closed program\'s actuals',
   !('actual_json' in patch));

/* ── and the strip is emptied when a program hides it ── */
w = world(KAPRIKORN);
ok('clearActuals exists', !!w.fn.clearActuals);
if (w.fn.clearActuals) {
  w.fn.clearActuals();
  ok('  …and empties the strip', w.H['#actStrip'].inputs.length === 0);
  ok('  …and forgets whose figures it held', !w.H['#actStrip'].dataset.programId);
  ok('  …so a save afterwards sends no actuals', !('actual_json' in w.fn.collectPatch(GRON)));
}

/* ── THE OTHER DIRECTION: a correction on the program it was painted for still saves ── */
w = world(KAPRIKORN);
w.H['#actStrip'].inputs[0].value = '1300';     // a hand correction of units sold
patch = w.fn.collectPatch(KAPRIKORN);
ok('a hand correction on the program the strip belongs to still goes out',
   patch.actual_json && patch.actual_json.units_sold === 1300);
ok('  …carrying the rest of that program\'s figures unchanged',
   patch.actual_json && patch.actual_json.investment === 1250);

w = world(KAPRIKORN);
ok('an untouched closed program sends no actuals', !('actual_json' in w.fn.collectPatch(KAPRIKORN)));

/* ── wired in: hiding the strip empties it ── */
ok('applyStatusView empties the strip when it hides it',
   /if \(showAct\) renderActuals\(v\.rec\); else clearActuals\(\);/.test(js));
ok('renderActuals stamps whose figures it painted',
   /host\.dataset\.programId = p\.program_id/.test(grab('renderActuals')));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
