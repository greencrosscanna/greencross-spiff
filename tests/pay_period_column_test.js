#!/usr/bin/env node
/* ─── The pay-period column now means what its name says ──────────────────────────────────────────
 *
 *   RUN:  node tests/pay_period_column_test.js
 *
 * WHAT IT HELD, measured across all 25 live programs on 2026-09-08: every one of the 23 seeded
 * programs stored its window's END + 5 days, consistently, to the day. That is the PAY DATE — when
 * payroll for the fortnight runs. Real data, in a column whose name, whose schema comment
 * ("pay-period start — joins to Leaderboard") and whose only consumers all mean the period START.
 *
 * So it joined to nothing. Leaderboard keys periods on `period_start`, so every join on this
 * column missed by a fortnight and five days. That is the cause of a remark already sitting in
 * spiffProgress_: Crew found the pay_period filter unusable and passes nothing, taking the whole
 * payload and filtering client-side.
 *
 * The two that were not pay dates: the one app-created program held the RANGE STRING
 * "2026-08-17 - 2026-08-30", which is not a date at all, and one draft with no window was blank.
 *
 * THE FIX IS DERIVATION, NOT A ONE-OFF CORRECTION. Correcting 25 rows and leaving the column
 * writable would put it straight back the first time something wrote to it — the column got this
 * way precisely because it was a free-text field that nothing computed and nothing validated. So
 * programToRow_ derives it on every write, and it is no longer patchable.
 *
 * THE PAY DATE IS NOT LOST: it is end_date + 5, derivable whenever anyone wants it, and nothing in
 * the suite reads it. A second column for a value nothing consumes would be the worse trade.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. DERIVED ON WRITE, IN ONE PLACE ══════════════════ */
const row = grab('programToRow_');
ok('the column is computed from start_date on every write',
   /periodStartFor_\(textDate_\(p\.start_date\)\)/.test(row));
ok('  …and never taken from the caller', !/p\.pay_period/.test(row));
ok('  …in the function every write funnels through, like the derived-actuals strip',
   /stripDerivedActuals_/.test(row));
ok('a program with no window leaves it blank rather than guessing a period',
   /\|\| ''/.test(row.slice(row.indexOf('periodStartFor_'))));
/* Writable + derived is how it got wrong in the first place. */
/* Read the QUOTED ENTRIES, not the block text — the comment inside the array names pay_period to
   explain why it is absent, and a substring check flags that. Third time today I have written a
   test that cried about its own explanation; the fix is always to assert on the parsed thing. */
const editable = (/var EDITABLE_FIELDS = \[([\s\S]*?)\];/.exec(gs)[1].match(/'[^']+'/g) || [])
  .map(x => x.replace(/'/g, ''));
ok('it is no longer an editable field', editable.indexOf('pay_period') < 0);
ok('  …while the fields that SHOULD be patchable still are',
   ['start_date', 'end_date', 'actual_json', 'pitch_json'].every(f => editable.indexOf(f) >= 0));
ok('  …and the reason is written where the list is',
   /accepting a patch for it would let a caller write a value the next save overwrites/.test(gs));
/* The schema comment was right about intent and silent about reality. */
ok('the schema records what it holds AND what it used to',
   /pay-period START, derived from start_date/.test(gs) && /Held the PAY DATE, end\+5/.test(gs));

/* ══════════════════ 2. THE PERIOD MATH, ACTUALLY RUN ══════════════════ */
const P = new Function('GXCore', 'console', [
  'var PP_CFG = null;', grab('payPeriodCfg_'), grab('periodStartFor_'),
  'return periodStartFor_;'
].join('\n'))(
  { getKv: k => ({ 'cfg.payPeriodAnchor': '2026-05-11', 'cfg.payPeriodDays': '14' }[k]) },
  { warn() {} });

/* Every live program's start date, against what the column should now say. */
[['2026-08-17', '2026-08-17'], ['2026-07-20', '2026-07-20'], ['2026-08-31', '2026-08-31'],
 ['2026-08-03', '2026-08-03'], ['2026-06-08', '2026-06-08'], ['2026-06-22', '2026-06-22']
].forEach(([sd, want]) =>
  ok('a program starting ' + sd + ' files under ' + want, P(sd) === want));
/* The three off-grid records: their start is NOT a period boundary, and the honest answer is the
   period that contains it. green-cross-2025-08-11 is the seven-day program. */
ok('an off-grid start resolves to the period CONTAINING it, not to itself',
   P('2025-08-11') === '2025-08-04');
ok('  …which is the honest answer for a window that never sat on the grid',
   P('2025-08-11') !== '2025-08-11');
/* The pay date it used to hold must not be what comes back. */
ok('the old pay-date value is not what is derived',
   P('2026-08-31') !== '2026-09-18' && P('2026-08-03') !== '2026-08-21');
ok('a blank or non-ISO start yields no period at all',
   P('') === '' && P('2026-08-17 - 2026-08-30') === '');

/* ══════════════════ 3. THE BACKFILL FIXES BOTH SHEETS ══════════════════ */
const bf = grab('backfillPayPeriods_');
ok('the backfill is secret-gated', /GX_SECRET_PROP/.test(bf));
ok('  …and listed as a secret action, or the router refuses it first',
   /SECRET_ACTIONS = \[[^\]]*'backfillPayPeriods'/.test(gs));
ok('  …and dry by default', /String\(p\.apply \|\| ''\) === '1'/.test(bf) && /dry: true/.test(bf));
ok('  …naming every change it would make', /changes: changes\.map/.test(bf));
/* The cache holds its own copy, and payPeriodMatches_ compares against it. */
ok('it fixes the cached copies too, not just the programs sheet',
   /progressSheet_\(\)/.test(bf) && /progress_rows_to_fix/.test(bf));
/* The reasoning lives in the doc comment above the function, which grab() does not include. */
ok('  …because leaving them would make the filter miss exactly the rows asked about',
   /Both or neither/.test(gs));
ok('it writes ONE cell per row rather than re-saving settled records',
   /setValue\(c\.to\)/.test(bf) && bf.indexOf('saveProgram_') < 0);
ok('  …and re-pins both columns to text, where Sheets would coerce a date back',
   /forceTextDates_\(sh\)/.test(bf) && /forceProgressTextDates_\(psh\)/.test(bf));
/* An earlier draft called a pinner that does not exist, behind a `&&` guard. */
ok('  …using the pinner that exists, not a guessed name',
   !/forceProgramTextDates_ &&/.test(gs) && /function forceTextDates_/.test(gs));
ok('a program with no window is named, not silently skipped',
   /programs_with_no_window/.test(bf));
ok('rows already correct are counted rather than rewritten',
   /programs_already_correct/.test(bf) && /already\+\+/.test(bf));

console.log(fail ? '\n' + fail + ' FAILED' : '\npay period column: all passed');
process.exit(fail ? 1 : 0);
