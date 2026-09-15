#!/usr/bin/env node
/* ─── Sweeping orphaned progress rows ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/orphan_sweep_test.js
 *
 * WHY
 * deleteProgram_ drops a program's cached rows as it goes, so nothing new strands. This sweeps the
 * debris that predates it — on 2026-09-06, 25 rows keyed to `begoat-0826` (the pre-seed key the
 * SPIF-doc seed replaced) plus one row with no program_id at all, together carrying $350 of
 * `earned` for a fortnight that was already paid.
 *
 * They are already excluded from `rows` and `by_employee`, so this is not a correctness fix. It
 * removes a trap: every consumer has to keep remembering to exclude them, and the day one forgets
 * is the day fourteen people show as owed $25 again.
 *
 * THE THREE THINGS THIS FILE EXISTS TO HOLD
 *  - Orphaned means the PROGRAM ROW IS GONE, not that a resolved status came back empty.
 *    spiffProgress_ filters on the latter, which also catches a program that exists with a blank
 *    status cell. Dropping such a row from a response is undone by fixing the cell; deleting it is
 *    not. The stricter question is the one a delete has to ask.
 *  - An unreadable `programs` tab makes every cached row look orphaned. spiffProgress_ refuses
 *    rather than reporting that nobody earned anything; here the same failure would DELETE the
 *    cache, so the guard matters more, not less.
 *  - Dry by default, and what goes is copied first. These rows are no longer authoritative about
 *    money — the payout they were computed from is gone from the system of record — but that is a
 *    reason not to serve them, not a reason to make them unrecoverable.
 *
 * REWRITTEN 2026-09-15 to RUN the sweep. It used to be entirely source-shaped, which on a DELETE
 * route is the wrong bargain: `sw.indexOf('keep.getRange') < sw.indexOf('sh.deleteRow')` says the
 * copy is written earlier in the FILE, and would pass just as happily if the copy wrote the wrong
 * rows, wrote them to the wrong tab, or wrote none at all. The sweep now runs against the real
 * BeGOAT shape — 25 rows under a dead id, one with no id, $350 between them — and the assertions
 * read the two sheets afterwards.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const SWEPT_TAB = G.grabVar('SWEPT_TAB');
const ID = PROG_H.indexOf('program_id');
const EARNED = PROG_H.indexOf('earned');

function program(id, status) {
  const row = PH.map(() => '');
  row[PH.indexOf('program_id')] = id;
  row[PH.indexOf('program_name')] = id;
  row[PH.indexOf('status')] = status === undefined ? 'closed' : status;
  return row;
}
function pRow(id, employee, earned) {
  const r = PROG_H.map(() => '');
  r[ID] = id; r[PROG_H.indexOf('employee_id')] = employee;
  r[PROG_H.indexOf('units')] = 1; r[EARNED] = earned;
  return r;
}
/* The cache as it stood on 2026-09-06: 25 rows under the dead `begoat-0826`, one with no
   program_id at all, and 3 live rows that must survive. $350 of `earned` between the orphans. */
function beGoatCache() {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(pRow('begoat-0826', 'e' + i, 14));
  rows.push(pRow('', 'e99', 0));
  rows.push(pRow('wyld-0908', 'e1', 25));
  rows.push(pRow('wyld-0908', 'e2', 25));
  rows.push(pRow('gron-0908', 'e3', 25));
  return rows;
}

function run(params, opts) {
  const o = opts || {};
  const programs = G.makeSheet(PH, o.programs === undefined
    ? [program('wyld-0908'), program('gron-0908')] : o.programs);
  const progress = G.makeSheet(PROG_H, o.progress === undefined ? beGoatCache() : o.progress);
  const book = G.makeBook(Object.assign({ spiff_progress: progress }, o.tabs || {}));
  progress.getParent = () => book;
  const props = G.makeProps({ GX_DEPLOY_SECRET: o.secret === undefined ? 'SEKRET' : o.secret });
  const t = G.trace();

  /* Record the order of the two writes that matter, from the sheets rather than from the source:
     copy-then-delete is the whole recoverability argument. */
  const origDelete = progress.deleteRow.bind(progress);
  progress.deleteRow = (n) => { t.calls.push('delete'); return origDelete(n); };

  const api = G.load({
    real: ['sweepOrphanProgress_', 'listPrograms_', 'rowToProgram_', 'textDate_', 'parseJson_',
           'normalizePitch_', 'nowStamp_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'SWEPT_TAB', 'GX_SECRET_PROP',
           'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => programs,
      progressSheet_: () => progress,
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
    },
    globals: { PropertiesService: props.PropertiesService },
  });

  /* The copy tab does not exist until the sweep makes it, so the write is traced by wrapping
     insertSheet's result on the way out. */
  const origInsert = book.insertSheet.bind(book);
  book.insertSheet = (n) => {
    const sh = origInsert(n);
    const orig = sh.getRange.bind(sh);
    sh.getRange = (r, c, nr, nc) => {
      const range = orig(r, c, nr, nc);
      const setValues = range.setValues.bind(range);
      range.setValues = (v) => { t.calls.push('copy'); return setValues(v); };
      return range;
    };
    return sh;
  };

  const res = api.sweepOrphanProgress_(params);
  return { res, programs, progress, book, trace: t, api };
}

const APPLY = { secret: 'SEKRET', apply: '1' };

/* ══════════════════ 1. WHAT COUNTS AS AN ORPHAN ══════════════════ */
{
  const r = run({ secret: 'SEKRET' });          // dry
  ok('the dry run finds all 26 orphaned rows and writes nothing',
     r.res.ok === true && r.res.dry === true && r.res.would_sweep === 26
     && r.progress.rows.length === 30 && !r.book.getSheetByName(SWEPT_TAB));
  const bg = r.res.programs.filter(x => x.program_id === 'begoat-0826')[0];
  ok('  …reporting the dead program by name, with its row count',
     !!bg && bg.rows === 25);
  ok('  …and the DOLLARS behind it, which is why this is not cosmetic',
     bg.earned === 350);
  ok('a row with no program_id at all is counted — it can belong to nothing',
     r.res.programs.some(x => x.program_id === '' && x.rows === 1));
  ok('  …and the live programs are not in the plan',
     !r.res.programs.some(x => /wyld|gron/.test(x.program_id)));
}
{
  const r = run(APPLY);
  ok('applied, it sweeps 26 rows and leaves the 3 live ones',
     r.res.ok === true && r.res.swept === 26 && r.progress.rows.length === 4);
  ok('  …and every surviving row belongs to a program that still exists',
     r.progress.rows.slice(1).every(x => ['wyld-0908', 'gron-0908'].indexOf(x[ID]) >= 0));
  ok('  …with their money untouched',
     r.progress.rows.slice(1).reduce((a, x) => a + Number(x[EARNED] || 0), 0) === 75);
  /* Bottom-up deletion is not a style preference: top-down would shift the rows under it and
     delete live measurements. This is the assertion that would have caught that. */
  ok('no live row is deleted by the shifting that bottom-up deletion avoids',
     r.progress.rows.filter(x => x[ID] === 'wyld-0908').length === 2
     && r.progress.rows.filter(x => x[ID] === 'gron-0908').length === 1);

  /* ── nothing goes without a copy ── */
  const keep = r.book.getSheetByName(SWEPT_TAB);
  ok('what went is in swept_progress_rows, all 26 of it',
     !!keep && keep.rows.length === 27);
  ok('  …with the original columns plus swept_at',
     keep.rows[0].length === PROG_H.length + 1
     && keep.rows[0][PROG_H.length] === 'swept_at'
     && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(keep.rows[1][PROG_H.length]));
  ok('  …and the $350 is recoverable from the copy',
     keep.rows.slice(1).reduce((a, x) => a + Number(x[EARNED] || 0), 0) === 350);
  ok('the copy is written BEFORE the first deletion', r.trace.before('copy', 'delete'));
  ok('the answer says where to find them', r.res.kept_in === SWEPT_TAB && !!r.res.swept_at);
}

/* ══════════════════ 2. ORPHANED MEANS THE PROGRAM IS GONE ══════════════════ */
/* A program that EXISTS with a blank status cell is dropped from ?action=progress but must never be
   swept: the response recovers when the cell is fixed, a delete does not. */
{
  const r = run(APPLY, {
    programs: [program('wyld-0908', ''), program('gron-0908')],
    progress: [pRow('wyld-0908', 'e1', 25), pRow('gron-0908', 'e3', 25)],
  });
  ok('a program with a BLANK status keeps its rows — it exists, so they are not orphans',
     r.res.ok === true && r.res.swept === 0 && r.progress.rows.length === 3);
  ok('  …and nothing is copied either', !r.book.getSheetByName(SWEPT_TAB));
}
{
  const r = run(APPLY, { progress: [pRow('wyld-0908', 'e1', 25)] });
  ok('a clean cache sweeps nothing and says so',
     r.res.ok === true && r.res.swept === 0 && /no orphaned rows/.test(r.res.note));
}
{
  const r = run(APPLY, { progress: [] });
  ok('an empty cache is not an error', r.res.ok === true && /cache is empty/.test(r.res.note));
}

/* ══════════════════ 3. THE GUARD THAT MATTERS MOST HERE ══════════════════ */
/* If `programs` cannot be read, every cached row looks orphaned — and here that would DELETE the
   lot. This is the case the file exists for. */
{
  const r = run(APPLY, { programs: [] });
  ok('an unreadable/empty programs tab REFUSES rather than sweeping everything',
     r.res.ok === false && /failure to read/.test(r.res.error));
  ok('  …and every row, orphan or not, is still there',
     r.progress.rows.length === 30 && !r.book.getSheetByName(SWEPT_TAB));
}

/* ══════════════════ 4. WHO MAY CALL IT ══════════════════ */
{
  const wrong = run({ secret: 'nope', apply: '1' });
  ok('a wrong secret is refused', wrong.res.ok === false && wrong.res.error === 'Unauthorized');
  ok('  …and it swept nothing', wrong.progress.rows.length === 30);
  const none = run({ apply: '1' });
  ok('no secret at all is refused too', none.res.ok === false && none.progress.rows.length === 30);
  const unset = run(APPLY, { secret: '' });
  ok('a script with no GX_DEPLOY_SECRET set refuses rather than letting anyone through',
     unset.res.ok === false && /GX_DEPLOY_SECRET is not set/.test(unset.res.error));
}
/* Reachability and the router's own gating are the legitimate source-shaped checks: an assembled
   function cannot tell you what the dispatch does with it. */
ok('it is on the secret-only list in the router',
   /SECRET_ACTIONS[\s\S]{0,200}'sweepOrphanProgress'/.test(G.GS));
ok('  …and is not public', !/PUBLIC_ACTIONS[^\n]*sweepOrphanProgress/.test(G.GS));
ok('routed on doGet', /case 'sweepOrphanProgress':/.test(G.GS));
/* Uncached on purpose — a delete reads the truth, not a five-minute-old copy. Not observable from
   the outside: both paths return the same programs here, so it stays a source check. */
ok('programs are read UNCACHED, the way getProgram_ reads before a write',
   /listPrograms_\(\)/.test(G.grab('sweepOrphanProgress_'))
   && !/listProgramsCached_/.test(G.grab('sweepOrphanProgress_')));

console.log(fail ? '\n' + fail + ' FAILED' : '\norphan sweep: all passed');
process.exit(fail ? 1 : 0);
