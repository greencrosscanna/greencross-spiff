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

/* ══════════════════ 1. DERIVED ON WRITE, IN ONE PLACE ══════════════════
   REWRITTEN 2026-09-15: programToRow_ is RUN, and the column is read out of the row it returns.
   `/periodStartFor_\(textDate_\(p\.start_date\)\)/` proves the call is typed into the literal; it
   cannot notice the value landing in the wrong column, which is the failure this whole file is
   about — a column whose name, schema comment and consumers all meant one thing while it held
   another. */
const G = require('./_gas');
const PH = G.grabVar('PROGRAM_HEADERS');
const PP = PH.indexOf('pay_period');

const R = G.load({
  real: ['programToRow_', 'periodStartFor_', 'textDate_', 'stripDerivedActuals_', 'normalizePitch_'],
  vars: ['PROGRAM_HEADERS', 'DERIVED_ACTUALS', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
  stubs: { payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }), nowStamp_: () => '2026-09-15 14:00:00' },
});
const rowFor = (prog) => R.programToRow_(prog, null);

ok('the column is computed from start_date on every write',
   rowFor({ program_id: 'p', start_date: '2026-08-17' })[PP] === '2026-08-17');
ok('  …to the period START, not to the pay date it used to hold',
   rowFor({ program_id: 'p', start_date: '2026-08-31' })[PP] === '2026-08-31'
   && rowFor({ program_id: 'p', start_date: '2026-08-31' })[PP] !== '2026-09-18');
ok('  …and NEVER taken from the caller, however insistently it is passed',
   rowFor({ program_id: 'p', start_date: '2026-08-17', pay_period: '2026-08-17 - 2026-08-30' })[PP]
     === '2026-08-17');
ok('a program with no window leaves it blank rather than guessing a period',
   rowFor({ program_id: 'p', start_date: '' })[PP] === '');
ok('  …and so does a start date that is not a date at all',
   rowFor({ program_id: 'p', start_date: '2026-08-17 - 2026-08-30' })[PP] === '');
ok('an off-grid start writes the period CONTAINING it',
   rowFor({ program_id: 'p', start_date: '2025-08-11' })[PP] === '2025-08-04');
/* One place, and it is the same place the derived actuals flags are stripped — every write funnels
   through this function, which is what makes a rule here impossible to forget. */
ok('the derived warnings are stripped on the same write',
   JSON.parse(rowFor({ program_id: 'p', start_date: '2026-08-17',
     actual_json: { units_sold: 5, duplicate_of: 'x', rate_changed: '25→50' } })[PH.indexOf('actual_json')])
       .duplicate_of === undefined);

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

/* ══════════════════ 3. THE BACKFILL FIXES BOTH SHEETS ══════════════════
   Also run now. The claim that matters — "both sheets or neither", because payPeriodMatches_
   compares the cached copy against the programs row — is invisible to a regex: `/progressSheet_\(/`
   says the function is mentioned. */
const PROG_H = G.grabVar('PROGRESS_HEADERS');
function pgRow(id, start, pay) {
  const r = PH.map(() => '');
  r[PH.indexOf('program_id')] = id; r[PH.indexOf('program_name')] = id;
  r[PH.indexOf('start_date')] = start; r[PH.indexOf('end_date')] = '2026-09-13';
  r[PH.indexOf('pay_period')] = pay;
  return r;
}
function cacheRow(id, pay) {
  const r = PROG_H.map(() => '');
  r[0] = id; r[1] = pay; r[PROG_H.indexOf('units')] = 4;
  return r;
}
function backfiller(opts) {
  const o = opts || {};
  /* The three shapes the column was actually found in on 2026-09-08: a RANGE, a date after its own
     window, and a row with no window at all. */
  const programs = G.makeSheet(PH, o.programs || [
    pgRow('portland-heights', '2026-08-17', '2026-08-17 - 2026-08-30'),
    pgRow('mule', '2026-08-31', '2026-09-18'),
    pgRow('correct', '2026-07-20', '2026-07-20'),
    pgRow('no-window', '', ''),
  ]);
  const progress = G.makeSheet(PROG_H, o.rows || [
    cacheRow('portland-heights', '2026-08-17 - 2026-08-30'),
    cacheRow('mule', '2026-09-18'),
    cacheRow('correct', '2026-07-20'),
  ]);
  const api = G.load({
    real: ['backfillPayPeriods_', 'periodStartFor_', 'textDate_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'GX_SECRET_PROP'],
    stubs: {
      dataSheet_: () => programs, progressSheet_: () => progress,
      payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }),
      forceTextDates_: () => { programs.pinned = true; },
      invalidatePrograms_: () => { programs.busted = true; },
      forceProgressTextDates_: () => { progress.pinned = true; },
    },
    globals: { PropertiesService: G.makeProps({ GX_DEPLOY_SECRET: 'SEKRET' }).PropertiesService },
  });
  return { api, programs, progress,
           payOf: (id) => programs.rows.find(x => x[PH.indexOf('program_id')] === id)[PP],
           cachedPayOf: (id) => progress.rows.filter(x => x[0] === id).map(x => x[1]) };
}
{
  const b = backfiller();
  const dry = b.api.backfillPayPeriods_({ secret: 'SEKRET' });
  ok('dry by default: it names every change it would make',
     dry.dry === true && dry.programs_to_fix === 2
     && dry.changes.some(c => c.program_id === 'mule' && c.from === '2026-09-18' && c.to === '2026-08-31'));
  ok('  …counts the rows already correct rather than rewriting them',
     dry.programs_already_correct === 1);
  ok('  …names a program with no window instead of skipping it silently',
     dry.programs_with_no_window.join(',') === 'no-window');
  ok('  …counts the cached copies that need the same fix', dry.progress_rows_to_fix === 2);
  ok('  …and changes nothing', b.payOf('mule') === '2026-09-18'
     && b.cachedPayOf('mule')[0] === '2026-09-18');
}
{
  const b = backfiller();
  b.api.backfillPayPeriods_({ secret: 'SEKRET', apply: '1' });
  ok('applied, the range becomes a period start', b.payOf('portland-heights') === '2026-08-17');
  ok('  …and a date after its own window becomes the period it belongs to',
     b.payOf('mule') === '2026-08-31');
  ok('  …a row that was already right is untouched', b.payOf('correct') === '2026-07-20');
  ok('  …and one with no window stays blank', b.payOf('no-window') === '');
  /* BOTH SHEETS OR NEITHER: payPeriodMatches_ compares the cached copy against this value, so a
     half-done backfill makes the filter miss exactly the rows it is asked about. */
  ok('the cached copies are fixed too, to the same values',
     b.cachedPayOf('portland-heights')[0] === '2026-08-17' && b.cachedPayOf('mule')[0] === '2026-08-31');
  ok('  …and both columns are re-pinned to text, where Sheets would coerce a date back',
     b.programs.pinned === true && b.progress.pinned === true);
  ok('  …and the programs cache is busted, so nothing serves the old value', b.programs.busted === true);
}
{
  const wrong = backfiller().api.backfillPayPeriods_({ secret: 'nope', apply: '1' });
  ok('a wrong secret changes nothing', wrong.ok === false && wrong.error === 'Unauthorized');
  const empty = backfiller({ programs: [] }).api.backfillPayPeriods_({ secret: 'SEKRET' });
  ok('an empty programs tab refuses rather than reporting a clean sheet', empty.ok === false);
}
/* The router's list is the one thing execution cannot see. */
ok('it is listed as a secret action, or the router refuses it first',
   /SECRET_ACTIONS = \[[^\]]*'backfillPayPeriods'/.test(gs));
/* An earlier draft called a pinner that does not exist, behind a `&&` guard — the same silent
   no-op shape as the getConfig() slip. The stubs above are named for the real ones, so a rename
   would fail this file loudly; this pins the symbol itself. */
ok('the pinner it calls exists', /function forceTextDates_/.test(gs) && !/forceProgramTextDates_ &&/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\npay period column: all passed');
process.exit(fail ? 1 : 0);
