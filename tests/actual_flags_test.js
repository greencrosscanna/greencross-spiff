#!/usr/bin/env node
/* ─── The "actuals look copied" warning is computed, never stored ─────────────────────────────────
 *
 *   RUN:  node tests/actual_flags_test.js
 *
 * WHY
 * `duplicate_of` and `rate_changed` used to be written onto the record by the Calculator importer.
 * When the importers were cut (2026-08-30) the code that computed them went too — but the values
 * stayed in actual_json on the sheet. The red "actuals match X — verify" banner became a frozen
 * sentence: correcting the numbers, or pulling live actuals from Dutchie, left it sitting there
 * claiming a match that no longer existed, with no way to clear it short of editing the
 * spreadsheet by hand. Sky asked how to clear one on 2026-08-31 and the answer was "you can't".
 *
 * A warning nobody can clear is a warning everybody learns to ignore. So it is derived on every
 * read, and the two halves of that are both tested here: annotateActuals_ must OVERWRITE whatever
 * the sheet holds, and programToRow_ must STRIP what a reader computed — otherwise a routine edit
 * quietly re-persists the derived answer and we are back where we started.
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
  throw new Error('unterminated ' + name);
}
const DERIVED = eval(gs.match(/var DERIVED_ACTUALS\s*=\s*(\[[^\]]*\]);/)[1]);
const annotate = new Function(
  `var DERIVED_ACTUALS = ${JSON.stringify(DERIVED)};
   ${grab('stripDerivedActuals_')}
   ${grab('annotateActuals_')}
   return annotateActuals_;`)();
const strip = new Function(
  `var DERIVED_ACTUALS = ${JSON.stringify(DERIVED)};
   ${grab('stripDerivedActuals_')}
   return stripDerivedActuals_;`)();

const prog = (title, actual, payout) => ({
  program_id: title, title, actual_json: actual,
  payout_json: payout === undefined ? {} : { amount: payout },
});
const dupOf = (list, title) => list.filter(p => p.title === title)[0].actual_json.duplicate_of;

console.log('derived actuals flags');

/* ── the real shape of the five flagged records: identical units, hits and investment ── */
let set = [
  prog('Freshy 0226',  { units_sold: 289, bts_hit: 26, investment: 1300, roi: -256 }, 50),
  prog('Hapy Kitchen', { units_sold: 289, bts_hit: 26, investment: 1300, roi: -256 }),
  prog('Drops 0826',   { units_sold: 289, bts_hit: 26, investment: 1300, roi: -4627.62, spiff_amount: 50 }, 25),
  prog('Wyld 0626',    { units_sold: 604, bts_hit: 21, investment: 525,  roi: -1978.86 }, 25),
];
annotate(set);
ok('a match names every other program in the group', dupOf(set, 'Freshy 0226').length === 2);
ok('...and never itself', dupOf(set, 'Freshy 0226').indexOf('Freshy 0226') < 0);
ok('...and the naming is mutual', dupOf(set, 'Hapy Kitchen').indexOf('Freshy 0226') >= 0);
ok('a different ROI does NOT save you — the key is units/hits/investment',
   dupOf(set, 'Drops 0826').length === 2);
ok('a program matching nobody is clean', dupOf(set, 'Wyld 0626').length === 0);

/* ── THE POINT: fixing the numbers clears the flag, on BOTH records ── */
set = [
  prog('Freshy 0226',  { units_sold: 289, bts_hit: 26, investment: 1300 }, 50),
  prog('Hapy Kitchen', { units_sold: 289, bts_hit: 26, investment: 1300 }),
];
annotate(set);
ok('two identical records flag each other', dupOf(set, 'Freshy 0226').length === 1);
set[0].actual_json.units_sold = 412;                     // the correction a human makes
annotate(set);
ok('correcting one clears its own flag', dupOf(set, 'Freshy 0226').length === 0);
ok('...and clears its PARTNER too — a stored flag never could',
   dupOf(set, 'Hapy Kitchen').length === 0);

/* ── a stale value from the sheet is overwritten, not merged ── */
set = [prog('Lonely', { units_sold: 10, bts_hit: 1, investment: 5,
                        duplicate_of: ['Some Program Deleted Long Ago'], rate_changed: true }, 5)];
annotate(set);
ok('a duplicate_of left in the sheet is overwritten by today\'s answer',
   dupOf(set, 'Lonely').length === 0);
ok('...and so is a stale rate_changed', set[0].actual_json.rate_changed === false);

/* ── unsettled records are not evidence of anything ── */
set = [
  prog('Draft A', { units_sold: 0, bts_hit: 0, investment: 0 }),
  prog('Draft B', { units_sold: 0, bts_hit: 0, investment: 0 }),
  prog('Draft C', {}),
];
annotate(set);
ok('all-zero actuals do not flag each other', dupOf(set, 'Draft A').length === 0
   && dupOf(set, 'Draft B').length === 0);
ok('...nor does an empty actuals block', dupOf(set, 'Draft C').length === 0);

/* ── rate_changed: only a real disagreement counts ── */
set = [
  prog('settled high', { units_sold: 1, bts_hit: 1, investment: 1, spiff_amount: 50 }, 25),
  prog('settled same', { units_sold: 2, bts_hit: 1, investment: 1, spiff_amount: 25 }, 25),
  prog('you decide',   { units_sold: 3, bts_hit: 1, investment: 1, spiff_amount: 50 }),
  prog('not settled',  { units_sold: 4, bts_hit: 1, investment: 1 }, 25),
];
annotate(set);
const rc = (t) => set.filter(p => p.title === t)[0].actual_json.rate_changed;
ok('modelled 25 but settled 50 is a changed rate', rc('settled high') === true);
ok('modelled and settled agreeing is not', rc('settled same') === false);
ok('no modelled rate ("You Decide") has nothing to differ from', rc('you decide') === false);
ok('an unsettled record is not a changed rate', rc('not settled') === false);

/* ── and none of it is ever written back ── */
const stored = strip({ units_sold: 289, bts_hit: 26, duplicate_of: ['X'], rate_changed: true });
ok('duplicate_of is stripped before storage', !('duplicate_of' in stored));
ok('rate_changed is stripped before storage', !('rate_changed' in stored));
ok('...and the real actuals survive intact', stored.units_sold === 289 && stored.bts_hit === 26);
ok('programToRow_ is the one place that strips',
   /stripDerivedActuals_\(p\.actual_json\)/.test(grab('programToRow_')));

/* ── the annotation must run over the FULL set, before any status filter ── */
ok('listPrograms_ annotates before filtering by status',
   /annotateActuals_\(all\)[\s\S]*if \(!status\)/.test(grab('listPrograms_')));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
