#!/usr/bin/env node
/* ─── The Calculator sends only what moved ────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/save_patch_test.js
 *
 * WHY
 * "Update this program" used to post all nine model fields whether or not any of them had been
 * touched. Correcting a program's NAME therefore re-derived and re-wrote the target, the baseline
 * and the per-store goals — including `per_bt`, which is the threshold Progress judges a budtender
 * against and pays on. Nothing errored, because every value was recomputed from the live screen and
 * every one of them looked reasonable. A program could simply end up settled against a slightly
 * different goal than the one the vendor agreed to.
 *
 * This repo has already paid for that exact class of bug once: the save path ran its own rounding,
 * separate from the one the table displayed, so a program could be sold at one per-budtender goal
 * and settled at another. This is the same failure approached from the other side — not two
 * formulas, but one formula re-run when nobody asked for it.
 *
 * THE BIAS IS DELIBERATE AND ONE-WAY. A false "changed" costs one redundant column write, which is
 * what happened on every single save until now. A false "unchanged" silently drops somebody's edit.
 * So everything that cannot be PROVEN identical goes out, and the tests below check that direction
 * as carefully as they check the skipping.
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

const M = new Function([grab('canonJson'), grab('calcModelPatch'),
                        'return { canonJson, calcModelPatch };'].join('\n'))();

/* A stored program, shaped like one that comes back from the engine. */
const STORED = () => ({
  program_id: 'wyld-2026-08-31-2026-09-13',
  program_name: 'Wyld 10pc',
  vendor: 'Wyld',
  cost_json:   { mode: 'flat', per_unit: 10, source_label: 'calculator' },
  payout_type: 'flat',
  payout_json: { amount: 25, model: 'flat' },
  match_json:  { brand: 'Wyld', category: '', filter_text: 'Gummies', products: [] },
  stores_json: ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'],
  baseline_json: { units: 200, revenue: 2000, by_store: { bend: 100, 'river-rd': 100 },
                   per_bt: { bend: 20, 'river-rd': 20 } },
  target_json:   { units: 400, revenue: 4000, budtenders: 10,
                   by_store: { bend: 200, 'river-rd': 200 },
                   per_bt: { bend: 40, 'river-rd': 40 } }
});

/* The payload the screen would build for that same, untouched program. Deliberately assembled with
   its keys in a DIFFERENT order from the stored copy — that is the realistic case, since one came
   out of a datastore and the other was just built in a function. */
const SAME = () => ({
  vendor: 'Wyld',
  program_name: 'Wyld 10pc',
  payout_json: { model: 'flat', amount: 25 },
  cost_json:   { per_unit: 10, source_label: 'calculator', mode: 'flat' },
  payout_type: 'flat',
  match_json:  { products: [], filter_text: 'Gummies', brand: 'Wyld', category: '' },
  stores_json: ['river-rd', 'bend', 'commercial', 'center', 'portland-rd', 'hillsboro'],
  target_json:   { budtenders: 10, units: 400, revenue: 4000,
                   per_bt: { 'river-rd': 40, bend: 40 },
                   by_store: { 'river-rd': 200, bend: 200 } },
  baseline_json: { revenue: 2000, units: 200,
                   per_bt: { 'river-rd': 20, bend: 20 },
                   by_store: { 'river-rd': 100, bend: 100 } }
});

/* ── THE HEADLINE: an untouched program writes NOTHING ── */
let patch = M.calcModelPatch(STORED(), SAME());
ok('loading a program and saving it untouched sends nothing at all',
   Object.keys(patch).length === 0);
ok('  …even though the two objects were built with different key orders',
   JSON.stringify(STORED().payout_json) !== JSON.stringify(SAME().payout_json));
ok('  …and different store orders',
   STORED().stores_json.join() !== SAME().stores_json.join());

/* ── Correcting a NAME must not rewrite the goals ── */
let next = SAME(); next.program_name = 'Wyld 10pc — corrected';
patch = M.calcModelPatch(STORED(), next);
ok('correcting the name sends the name', patch.program_name === 'Wyld 10pc — corrected');
ok('  …and NOT the target', !('target_json' in patch));
ok('  …and NOT the baseline', !('baseline_json' in patch));
ok('  …and NOT per_bt, which is what Progress pays a budtender against',
   !('target_json' in patch) && !('baseline_json' in patch));
ok('  …and nothing else at all', Object.keys(patch).join() === 'program_name');

/* ── But a REAL model change still goes out, whole ── */
next = SAME();
next.target_json = { budtenders: 10, units: 500, revenue: 5000,
                     by_store: { bend: 250, 'river-rd': 250 },
                     per_bt: { bend: 50, 'river-rd': 50 } };
patch = M.calcModelPatch(STORED(), next);
ok('raising the target sends the target', patch.target_json.units === 500);
ok('  …as a whole object, not a half-merged one', patch.target_json.per_bt.bend === 50);
ok('  …and still leaves the untouched fields alone', !('baseline_json' in patch));

/* A nested change buried three levels down is still a change. */
next = SAME();
next.target_json.per_bt['river-rd'] = 41;              // one store re-pinned by hand
patch = M.calcModelPatch(STORED(), next);
ok('re-pinning ONE store’s per-BT goal is detected', 'target_json' in patch);

/* ── The bias: anything unprovable goes out ── */
ok('a field missing from the stored program is sent',
   'match_json' in M.calcModelPatch(
     Object.assign(STORED(), { match_json: undefined }), SAME()));
ok('a stored null is not mistaken for a match',
   'payout_json' in M.calcModelPatch(
     Object.assign(STORED(), { payout_json: null }), SAME()));
ok('a number stored as a STRING is treated as different, not equal',
   'payout_type' in M.calcModelPatch(
     Object.assign(STORED(), { payout_type: '' }), SAME()));

/* Store membership compares as a SET — order is not meaning — but a genuinely different set is. */
next = SAME(); next.stores_json = ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd'];
ok('dropping a store from the list IS a change',
   'stores_json' in M.calcModelPatch(STORED(), next));
next = SAME(); next.stores_json = ['bend'];
ok('and so is scoping down to one', 'stores_json' in M.calcModelPatch(STORED(), next));

/* ── canonJson itself ── */
ok('key order does not change the canonical form',
   M.canonJson({ a: 1, b: 2 }) === M.canonJson({ b: 2, a: 1 }));
ok('array order DOES — order can carry meaning outside stores_json',
   M.canonJson([1, 2]) !== M.canonJson([2, 1]));
ok('undefined and null both read as null rather than throwing',
   M.canonJson(undefined) === 'null' && M.canonJson(null) === 'null');
ok('nested objects are canonicalized too',
   M.canonJson({ x: { a: 1, b: 2 } }) === M.canonJson({ x: { b: 2, a: 1 } }));
ok('0 is not confused with absent', M.canonJson(0) !== M.canonJson(null));
ok('an empty string is not confused with absent',
   M.canonJson('') !== M.canonJson(null));

/* ── The save path must actually USE it ── */
const save = grab('saveCalcProgram');
ok('update posts the patch, not the whole payload',
   /patch: JSON\.stringify\(patch\)/.test(save));
ok('create still posts the whole payload — there is nothing to compare against',
   /program: JSON\.stringify\(payload\)/.test(save));
/* The model save now RETURNS an empty result rather than posting; the one button reports
   "Nothing changed" once, for both halves together. */
ok('a model patch with nothing in it is never posted',
   /if \(!Object\.keys\(patch\)\.length\) return \{ changed: \[\] \}/.test(save));
ok('  …and the single Save says so, for both halves at once',
   /'Nothing changed'/.test(grab('saveEverything')));
ok('a program with no stored copy falls back to sending everything',
   /prog \? calcModelPatch\(prog, payload\) : payload/.test(save));

/* ══════════════ HEADCOUNT: THE REASON AN UNTOUCHED SAVE USED TO CHANGE THINGS ══════════════
 * A patch that reports "changed" when nothing changed is not an honest patch, and until
 * 2026-09-01 every reopened program reported exactly that — because the per-store BUDTENDER
 * COUNT was never stored. It was guessed back by dividing last month's units by last month's
 * per-budtender figure, both of which were already rounded on the way in. A store with 9 units
 * across 6 people stored a per-BT of 2 (1.5, rounded), and 9/2 guesses 5 people. Every store
 * goal then re-derived off a headcount nobody had.
 *
 * Measured against all 26 live programs: 20 of them drifted. Meraki Gardens December went from
 * 90 units to 78 with nobody typing anything. Opening a program and pressing Update was enough.
 */
const B = new Function(grab('btsForStore') + '; return btsForStore;')();

/* Meraki Gardens December, verbatim from the datastore. Every store really had 6 budtenders. */
const MERAKI_BASE = { by_store: { bend: 9, center: 1, commercial: 9, hillsboro: 2,
                                  'portland-rd': 3, 'river-rd': 12 },
                      per_bt:   { bend: 2, center: 0, commercial: 2, hillsboro: 0,
                                  'portland-rd': 1, 'river-rd': 2 } };
const MERAKI_TGT  = { units: 90,
                      by_store: { bend: 18, center: 6, commercial: 18, hillsboro: 12,
                                  'portland-rd': 12, 'river-rd': 24 },
                      per_bt:   { bend: 3, center: 1, commercial: 3, hillsboro: 2,
                                  'portland-rd': 2, 'river-rd': 4 } };

ok('the old guess got bend wrong — 9 units / a rounded per-BT of 2 reads as 5 people',
   Math.round(9 / 2) === 5);
ok('the goal gives it back exactly: 18 / 3 = 6',
   B('bend', MERAKI_TGT, MERAKI_BASE) === 6);
ok('  …and for every other store in that program too',
   ['center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd']
     .every(id => B(id, MERAKI_TGT, MERAKI_BASE) === 6));

/* A saved headcount always wins — it is the only one that is not an inference. */
ok('a SAVED headcount beats both inferences',
   B('bend', Object.assign({ bts_by_store: { bend: 4 } }, MERAKI_TGT), MERAKI_BASE) === 4);

/* Falling back, in order, and never to zero. */
ok('with no target to divide, it falls back to last month',
   B('bend', {}, { by_store: { bend: 12 }, per_bt: { bend: 2 } }) === 6);
ok('with nothing at all it assumes six rather than none',
   B('bend', {}, {}) === 6);
ok('a zero per-BT never divides by zero', B('x', { by_store: { x: 5 }, per_bt: { x: 0 } }, {}) === 6);
ok('and a headcount is never zero — that would zero the store goal',
   B('x', { by_store: { x: 1 }, per_bt: { x: 99 } }, {}) >= 1);

/* The payload has to actually carry it forward, or the next reopen guesses again. */
const payloadSrc = grab('calcModelPayload');
ok('the save stores the headcount so the next reopen does not have to guess',
   /bts_by_store/.test(payloadSrc));
ok('  …taken from the plan, not recomputed', /btsByStore\[s\.store_id\] = Number\(s\.n\)/.test(payloadSrc));

/* Both load paths must use the shared reconstruction — one of them drifting is the same bug. */
ok('openInCalculator uses the shared reconstruction',
   /bts: btsForStore\(/.test(grab('openInCalculator')));
ok('and so does loading a past program from the picker',
   /bts: btsForStore\(/.test(grab('loadIntoCalc')));
ok('neither still divides last month by its rounded per-BT',
   !/Math\.max\(1, Math\.round\(\(b \|\| 0\) \/ perBt\)\)/.test(grab('openInCalculator'))
   && !/Math\.max\(1, Math\.round\(\(b \|\| 0\) \/ perBt\)\)/.test(grab('loadIntoCalc')));

console.log(fail ? '\n' + fail + ' FAILED' : '\nsave patch: all passed');
process.exit(fail ? 1 : 0);
