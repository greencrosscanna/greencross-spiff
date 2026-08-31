#!/usr/bin/env node
/* ─── A program's status follows its dates ────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/status_roll_test.js
 *
 * WHY
 * Nothing used to move a program between draft, active and closed — a human did it, or it never
 * happened. The visible symptom was a hero card reading "day 14 of 14 · ended" over a programme
 * still filed ACTIVE. The invisible one is worse: `?action=progress&status=active` is resolved from
 * this field, and GX Crew's incentive column and the Leaderboard kiosk cards both read that route,
 * so a programme left active past its end date keeps drawing on kiosk cards it should have stopped
 * appearing on.
 *
 * The two NON-transitions are the ones worth a test. Closed is terminal — a typo'd end_date must
 * never reopen a programme whose actuals are already on a vendor report. And a draft whose window
 * has entirely passed is left alone rather than filed as closed, because "drafted and never run" is
 * not the same fact as "ran and finished", and only a human knows which it was.
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
/* The real header order, read out of the engine — a test that hard-codes its own column list stops
   testing the thing the moment a column is added. */
const HEADERS = eval(gs.match(/var PROGRAM_HEADERS\s*=\s*(\[[\s\S]*?\]);/)[1]);
const col = (h) => HEADERS.indexOf(h);

const TODAY = '2026-08-31';

/* Minimum viable Sheets range: enough for a bulk read and single-cell writes. */
function fakeSheet(grid) {
  return {
    grid,
    getLastRow: () => grid.length + 1,
    getRange(r, c, nr, nc) {
      return {
        getValues: () => grid.slice(r - 2, r - 2 + nr).map(x => x.slice(c - 1, c - 1 + nc)),
        setValue: (v) => { grid[r - 2][c - 1] = v; },
      };
    },
  };
}

function program(id, status, start, end) {
  const r = HEADERS.map(() => '');
  r[col('program_id')] = id;
  r[col('status')]     = status;
  r[col('start_date')] = start;
  r[col('end_date')]   = end;
  return r;
}

/* textDate_ reaches for Apps Script's Utilities when the sheet hands back a real Date. Only the
   one format string is used here, so the stub is exactly that and nothing more. */
const UTILITIES = { formatDate: (d) => d.toISOString().slice(0, 10) };

let invalidated = 0;
function run(rows, opts) {
  const sheet = fakeSheet(rows);
  invalidated = 0;
  const fn = new Function('SHEET', 'HEADERS', 'BUMP', 'Utilities', `
    var PROGRAM_HEADERS = HEADERS;
    function dataSheet_() { return SHEET; }
    function today_() { return '${TODAY}'; }
    function nowStamp_() { return '${TODAY} 09:00:00'; }
    function invalidatePrograms_() { BUMP(); }
    ${grab('textDate_')}
    ${grab('rollProgramStatuses_')}
    return rollProgramStatuses_;
  `)(sheet, HEADERS, () => invalidated++, UTILITIES);
  return { res: fn(opts), rows };
}
const statusOf = (rows, id) =>
  rows.filter(r => r[col('program_id')] === id).map(r => r[col('status')])[0];

console.log('status roll');

/* ── the two transitions Sky asked for ── */
let t = run([
  program('starts-today',  'draft',  TODAY,        '2026-09-13'),
  program('ended-yesterday','active','2026-08-17', '2026-08-30'),
]);
ok('a draft goes ACTIVE on its start date', statusOf(t.rows, 'starts-today') === 'active');
ok('an active program CLOSES once its window has passed', statusOf(t.rows, 'ended-yesterday') === 'closed');
ok('the programs cache is invalidated after a change', invalidated === 1);

/* ── the end date is INCLUSIVE: a program ending today is still running today ── */
t = run([program('ends-today', 'active', '2026-08-17', TODAY)]);
ok('a program ending TODAY is still active today', statusOf(t.rows, 'ends-today') === 'active');

/* ── a future draft is not touched ── */
t = run([program('next-month', 'draft', '2026-09-20', '2026-10-04')]);
ok('a draft whose window has not started stays a draft', statusOf(t.rows, 'next-month') === 'draft');
ok('...and no change is reported', t.res.changed.length === 0);

/* ── closed is TERMINAL. This is the one that protects a sent vendor report. ── */
t = run([
  program('long-done',   'closed', '2026-06-08', '2026-06-21'),
  program('bad-end-date','closed', '2026-08-01', '2027-12-31'),
]);
ok('a closed program is never reopened by its dates', statusOf(t.rows, 'long-done') === 'closed');
ok('...not even one whose end date is still in the future', statusOf(t.rows, 'bad-end-date') === 'closed');
ok('...and nothing is written for them', t.res.changed.length === 0 && invalidated === 0);

/* ── a draft that missed its whole window is a QUESTION, not a closed program ── */
t = run([program('never-ran', 'draft', '2026-07-01', '2026-07-14')]);
ok('a draft whose window has passed is NOT auto-closed', statusOf(t.rows, 'never-ran') === 'draft');
ok('...it is reported as stale so a human can decide', t.res.stale.length === 1
   && t.res.stale[0].program_id === 'never-ran');

/* ── no schedule, nothing to act on ── */
t = run([
  program('no-dates',  'draft',  '', ''),
  program('half-dated','active', '2026-08-01', ''),
]);
ok('a row with no window is skipped, not guessed at', t.res.changed.length === 0 && t.res.skipped.length === 2);
ok('...and the skip says why', t.res.skipped.every(s => s.why === 'no window'));

/* ── dry run reports without writing: the safe way to preview a date correction ── */
t = run([program('starts-today', 'draft', TODAY, '2026-09-13')], { dryRun: true });
ok('dry run reports the change it would make', t.res.changed.length === 1
   && t.res.changed[0].to === 'active');
ok('...and writes nothing', statusOf(t.rows, 'starts-today') === 'draft' && invalidated === 0);

/* ── a Date object out of the sheet still reads as a window ── */
t = run([(() => { const r = program('legacy', 'active', '', ''); 
                  r[col('start_date')] = new Date('2026-06-08T00:00:00Z');
                  r[col('end_date')]   = new Date('2026-06-21T00:00:00Z'); return r; })()]);
ok('a legacy row storing real Dates still closes', statusOf(t.rows, 'legacy') === 'closed');

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
