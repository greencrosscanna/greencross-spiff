#!/usr/bin/env node
/* ─── The numbers on a store row have to multiply ─────────────────────────────────────────────────
 *
 *   RUN:  node tests/calc_rounding_test.js
 *
 * WHY
 * "9 x 6 is 54 not 53" — Sky, 2026-08-31, reading a per-store row that said goal 53, 6 budtenders,
 * 9 each. Both figures were right on their own: 53 is the store's share of the ask, and 53/6 = 8.83
 * rounds to 9. They just could not both be true, and the row was being shown to a vendor.
 *
 * The fix is an ordering, not a rounding mode. A BUDTENDER IS TOLD ONE WHOLE NUMBER — that is the
 * only figure anyone acts on, and nobody is asked to sell 8.83 units. So the per-budtender goal is
 * the primitive: the store's goal is that number times its headcount, and the chain's ask is the
 * sum of the stores'. Everything reconciles by construction.
 *
 * The consequence, which is the point rather than a side effect: the ask that comes back out is a
 * few units off the one that was typed, because whole budtender goals rarely add up to a round
 * chain number. Every figure on the screen prices what comes out, and the goal footer names the
 * difference — the Calculator must never quote a vendor a number it cannot actually set.
 *
 * ALSO PINNED: the save path uses this same plan. It used to run its own second formula
 * (per_bt = round(round(base/bts) x ratio) against a table showing round(round(base x ratio)/bts)),
 * and per_bt is the threshold Progress pays a budtender on — so a program could be sold at one
 * goal and settled at another.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const calcModel = new Function('calc', grab('calcModel') + '; return calcModel;');
const model = (stores, target, extra) =>
  calcModel(Object.assign({ cost: 10, spiff: 25, target, model: 'flat', stores }, extra || {}))();

/* ── Sky's row, exactly ───────────────────────────────────────────────────────────────────────── */
const one = model([{ store_id: 'river-rd', name: 'River Rd', baseline: 53, bts: 6 }], 53);
const row = one.plan[0];
ok('the row Sky read: 6 budtenders told 9 each', row.n === 6 && row.perBt === 9);
ok('  …so the store goal is 54, not 53', row.goal === 54);
ok('  …and the row multiplies', row.perBt * row.n === row.goal);
ok('  …with the chain ask following the stores', one.goalUnits === 54);

/* ── the invariant, across a spread of awkward splits ─────────────────────────────────────────── */
const six = [
  { store_id: 'river-rd',   name: 'River Rd',   baseline: 212, bts: 6 },
  { store_id: 'commercial', name: 'Commercial', baseline: 187, bts: 5 },
  { store_id: 'lancaster',  name: 'Lancaster',  baseline: 143, bts: 7 },
  { store_id: 'keizer',     name: 'Keizer',     baseline:  98, bts: 4 },
  { store_id: 'salem',      name: 'Salem',      baseline: 251, bts: 9 },
  { store_id: 'corvallis',  name: 'Corvallis',  baseline: 109, bts: 3 }
];
const base = six.reduce((t, s) => t + s.baseline, 0);

let bad = 0, sums = 0;
for (let pctGrow = 0; pctGrow <= 150; pctGrow++) {
  const m = model(six, Math.round(base * (1 + pctGrow / 100)));
  for (const r of m.plan) if (r.n && r.perBt * r.n !== r.goal) bad++;
  if (m.plan.reduce((t, r) => t + r.goal, 0) !== m.goalUnits) sums++;
}
ok('every store row multiplies, at all 151 growth settings', bad === 0);
ok('the chain ask is always the sum of the store goals', sums === 0);

/* ── a store with no budtenders keeps its share instead of vanishing ──────────────────────────── */
const noBts = model([
  { store_id: 'a', name: 'A', baseline: 100, bts: 5 },
  { store_id: 'b', name: 'B', baseline: 100, bts: 0 }
], 220);
ok('a store with zero budtenders still carries a goal', noBts.plan[1].goal > 0);
ok('  …and reports no per-budtender number rather than zero', noBts.plan[1].perBt === null);

/* ── everything downstream prices the reconciled ask, not the typed one ───────────────────────── */
const m = model(six, 1200);
ok('the typed ask is kept, separately, for the controls', m.typed === 1200);
ok('revenue is priced off the reconciled goal', m.targetRev === m.goalUnits * 10);
ok('unit lift is measured off the reconciled goal', m.unitInc === m.goalUnits - m.baseUnits);
ok('growth is measured off the reconciled goal',
   Math.abs(m.growth - (m.goalUnits - m.baseUnits) / m.baseUnits) < 1e-12);
ok('the CONTROLS still echo what was typed, so the thumb does not move itself',
   Math.abs(m.typedGrowth - (1200 - m.baseUnits) / m.baseUnits) < 1e-12);

const perUnit = model(six, 1200, { model: 'per_unit', spiff: 1 });
ok('a per-unit payout funds the reconciled goal', perUnit.invest === perUnit.goalUnits);

/* ── one formula, not two: the save path reads the same plan ──────────────────────────────────── */
const save = grab('saveCalcProgram');
ok('the save builds per_bt from the plan', /m\.plan\.forEach/.test(save));
ok('  …and no longer runs its own rounding', !/Math\.round\(Math\.round\(s\.baseline/.test(save));
ok('  …and files the reconciled ask as the target', (save.match(/units: m\.goalUnits/g) || []).length === 2);

const recalc = grab('recalc');
ok('the per-store table reads the plan too', /m\.plan\.map/.test(recalc));
ok('the total row totals the column rather than restating the typed ask',
   /goal">' \+ m\.goalUnits/.test(recalc));
ok('the goal footer names the difference from what was typed', /m\.goalUnits !== m\.typed/.test(recalc));

const pitch = grab('enterPitch');
ok('the vendor-facing pitch uses the same plan', /m\.plan\.map/.test(pitch));
ok('  …and quotes the reconciled unit count', /m\.goalUnits\.toLocaleString\(\) \+ ' units<\/h1>'/.test(pitch));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall good');
process.exit(fail ? 1 : 0);
