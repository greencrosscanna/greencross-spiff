#!/usr/bin/env node
/* ─── Deleting a program takes its measurements with it ──────────────────────────────────────────
 *
 *   RUN:  node tests/delete_program_test.js
 *
 * WHY
 * Sky, 2026-09-06: "need a way to delete a program, specifically the Wyld 10pc. it never happened
 * so we can delete it." The reason it is a ROUTE and not a spreadsheet gesture is that a program is
 * not one row.
 *
 * Its measurements live in `spiff_progress`, keyed on program_id, and ?action=progress is read by
 * GX Crew's incentive column and the Leaderboard kiosks. Delete the program row by hand and those
 * rows survive it — orphans carrying `earned` dollars for a program that no longer exists. That is
 * precisely the BeGOAT failure of 2026-08-31: 25 stranded rows, $350 of earnings, fourteen people
 * showing as owed $25 for a fortnight already paid. `orphan_rows` exists to CATCH that shape; a
 * hand-delete manufactures it deliberately. So the row and its measurements go together or the
 * route is worse than useless.
 *
 * The other three rules are about what deletion must never become:
 *  - a CLOSED program cannot be deleted at all. It ran, was measured, was reported to the vendor
 *    and was paid — the same reasoning that makes closed terminal in the status roll and locks its
 *    goals in the Calculator.
 *  - the confirmation is checked SERVER-SIDE. Writes here ride on GET, and a URL is a thing that
 *    gets pasted, bookmarked and re-fetched; a disabled button is a claim about a screen.
 *  - nothing is destroyed. The row is copied to `deleted_programs` BEFORE it is removed, so a
 *    failure between the two leaves a duplicate rather than a hole.
 *
 * REWRITTEN 2026-09-15: the engine half RUNS the route. It used to be entirely source-shaped, and
 * on the one route whose whole purpose is "the row and its measurements go together" that proves
 * nothing: `/dropProgressRows_\(\s*p\.id\s*\)/` says the call is written, not that a single row
 * left the cache. The frontend half stays source-shaped — it is markup and click wiring, which
 * cannot run here — and says so where it sits.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  \u2713 ' + l) : (fail++, console.log('  \u2717 ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grabJs(name) { return G.grab(name, js); }

const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const ID = PH.indexOf('program_id');

/* Wyld 10pc — the draft this route was built for ("it never happened so we can delete it") — with
   cached measurement rows it must take with it, plus a live program that must not be touched. */
function program(id, name, status) {
  const row = PH.map(() => '');
  row[ID] = id; row[PH.indexOf('program_name')] = name;
  row[PH.indexOf('status')] = status;
  row[PH.indexOf('start_date')] = '2026-06-26'; row[PH.indexOf('end_date')] = '2026-07-09';
  return row;
}
function pRow(id, employee, earned) {
  const r = PROG_H.map(() => '');
  r[0] = id; r[PROG_H.indexOf('employee_id')] = employee;
  r[PROG_H.indexOf('units')] = 3; r[PROG_H.indexOf('earned')] = earned;
  return r;
}

function run(params, opts) {
  const o = opts || {};
  const programs = G.makeSheet(PH, o.programs || [
    program('wyld-0626', 'Wyld 10pc', 'draft'),
    program('gron-0908', 'Gron September', 'active'),
    program('portland-heights-2026-08-17-2026-08-30', 'Portland Heights', 'closed'),
  ]);
  const progress = G.makeSheet(PROG_H, o.progress || [
    pRow('wyld-0626', 'e1', 25), pRow('wyld-0626', 'e2', 25), pRow('wyld-0626', 'e3', 25),
    pRow('gron-0908', 'e4', 50),
  ]);
  const deleted = G.makeSheet(G.grabVar('PROGRAM_HEADERS').concat(['deleted_by', 'deleted_at', 'deleted_reason']));
  const cache = G.makeCache();
  const t = G.trace();

  const api = G.load({
    real: ['deleteProgram_', 'getProgram_', 'listPrograms_', 'rowToProgram_', 'programToRow_',
           'dropProgressRows_', 'invalidatePrograms_', 'textDate_', 'parseJson_', 'normalizePitch_',
           'periodStartFor_', 'stripDerivedActuals_', 'nowStamp_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'EDIT_ROLES', 'DERIVED_ACTUALS',
           'PROGRAMS_CACHE_KEY', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => programs,
      progressSheet_: () => progress,
      deletedSheet_: t.wrap('tombstone', () => deleted),
      gxAuth_: () => (o.auth || { ok: true, user: 'sky', role: 'admin' }),
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });

  /* Which sheet lost a row, and in what order — copy-before-delete is the recoverability claim. */
  [[programs, 'program_row_gone'], [progress, 'progress_row_gone']].forEach(function (pair) {
    const sheet = pair[0], label = pair[1], orig = sheet.deleteRow.bind(sheet);
    sheet.deleteRow = (n) => { t.calls.push(label); return orig(n); };
  });

  const res = api.deleteProgram_(params);
  return { res, programs, progress, deleted, cache, trace: t };
}

const OK = { token: 'tok', id: 'wyld-0626', confirm: 'Wyld 10pc', reason: 'never happened' };

console.log('engine');

/* ══ the whole point: measurements go too ══ */
{
  const r = run(OK);
  ok('the delete answers ok and names what went',
     r.res.ok === true && r.res.deleted === true && r.res.program_id === 'wyld-0626');
  ok('the program row is really gone from `programs`',
     !r.programs.rows.some(x => x[ID] === 'wyld-0626') && r.programs.rows.length === 3);
  ok('all three measured progress rows go with it',
     r.res.dropped_rows === 3 && !r.progress.rows.some(x => x[0] === 'wyld-0626'));
  ok('  …leaving no orphan carrying `earned` dollars — the BeGOAT shape',
     r.progress.rows.slice(1).every(x => x[0] === 'gron-0908'));
  ok('  …and another program\'s measurements are untouched',
     r.progress.rows.filter(x => x[0] === 'gron-0908').length === 1);
  ok('the programs cache is invalidated, so the list stops serving it',
     r.cache.removed.indexOf(G.grabVar('PROGRAMS_CACHE_KEY')) >= 0);
  ok('no warning when both halves succeeded', !r.res.warning);
}
/* A failure to drop the measurements is REPORTED — orphans are the failure mode this route exists
   to prevent, so it must never pass silently. */
{
  const programs = G.makeSheet(PH, [program('wyld-0626', 'Wyld 10pc', 'draft')]);
  const broken = G.makeSheet(PROG_H, [pRow('wyld-0626', 'e1', 25)]);
  broken.deleteRow = () => { throw new Error('sheet is locked'); };
  const deleted = G.makeSheet(PH.concat(['deleted_by', 'deleted_at', 'deleted_reason']));
  const cache = G.makeCache();
  const api = G.load({
    real: ['deleteProgram_', 'getProgram_', 'listPrograms_', 'rowToProgram_', 'programToRow_',
           'dropProgressRows_', 'invalidatePrograms_', 'textDate_', 'parseJson_', 'normalizePitch_',
           'periodStartFor_', 'stripDerivedActuals_', 'nowStamp_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'EDIT_ROLES', 'DERIVED_ACTUALS',
           'PROGRAMS_CACHE_KEY', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => programs, progressSheet_: () => broken,
      deletedSheet_: () => deleted,
      gxAuth_: () => ({ ok: true, user: 'sky', role: 'admin' }),
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });
  const res = api.deleteProgram_(OK);
  ok('a failure to drop the measurements is REPORTED, not swallowed',
     res.ok === true && /cached progress rows could not be/.test(res.warning || ''));
  ok('  …naming the cause and telling the caller to re-run', /sheet is locked/.test(res.warning)
     && /re-run the delete/.test(res.warning));
}

/* ══ closed is not deletable ══ */
{
  const r = run({ token: 'tok', id: 'portland-heights-2026-08-17-2026-08-30',
                  confirm: 'Portland Heights' });
  ok('a CLOSED program is refused', r.res.ok === false);
  ok('  …and the refusal says why, rather than reading as a bug',
     /reported to the brand/.test(r.res.error) && /stays in History/.test(r.res.error));
  ok('  …and it is still there, row and all',
     r.programs.rows.some(x => x[ID] === 'portland-heights-2026-08-17-2026-08-30')
     && r.deleted.rows.length === 1);
}
{
  const r = run({ token: 'tok', id: 'gron-0908', confirm: 'Gron September' });
  ok('an ACTIVE program can be deleted — only closed is terminal',
     r.res.ok === true && !r.programs.rows.some(x => x[ID] === 'gron-0908'));
}

/* ══ the confirmation is a control, not a dialog ══ */
{
  const wrong = run(Object.assign({}, OK, { confirm: 'wyld 10pc' }));
  ok('the typed name is compared SERVER-SIDE, exactly',
     wrong.res.ok === false && /Type the program name exactly to confirm: Wyld 10pc/.test(wrong.res.error));
  ok('  …and nothing was deleted on the way to that answer',
     wrong.programs.rows.some(x => x[ID] === 'wyld-0626')
     && wrong.progress.rows.filter(x => x[0] === 'wyld-0626').length === 3);
  const bare = run({ token: 'tok', id: 'wyld-0626' });
  ok('an id alone cannot delete anything, however the URL was arrived at',
     bare.res.ok === false && bare.programs.rows.some(x => x[ID] === 'wyld-0626'));
  ok('no id at all is refused', run({ token: 'tok' }).res.error === 'id required');
  ok('an unknown id is refused', /not found/.test(run(Object.assign({}, OK, { id: 'nope' })).res.error));
}

/* ══ nothing is destroyed ══ */
{
  const r = run(OK);
  ok('the row is tombstoned to deleted_programs, in full',
     r.deleted.rows.length === 2 && r.deleted.rows[1][ID] === 'wyld-0626');
  ok('  …stamped with who deleted it, when, and the reason they gave',
     r.deleted.rows[1].slice(-3)[0] === 'sky'
     && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.deleted.rows[1].slice(-2)[0])
     && r.deleted.rows[1].slice(-1)[0] === 'never happened');
  ok('  …BEFORE the live row is removed, so a half-failure duplicates rather than loses',
     r.trace.before('tombstone', 'program_row_gone'));
  ok('a long reason is truncated rather than writing an essay into the tab',
     run(Object.assign({}, OK, { reason: 'x'.repeat(900) })).deleted.rows[1].slice(-1)[0].length === 500);
}
ok('the tombstone tab carries the deletion columns on top of the program columns',
   /DELETED_HEADERS\s*=\s*PROGRAM_HEADERS\.concat\(\['deleted_by',\s*'deleted_at',\s*'deleted_reason'\]\)/.test(G.GS));

/* ══ who may call it ══ */
{
  const noSess = run(OK, { auth: { ok: false, error: 'Session expired' } });
  ok('it checks a real session itself — a deploy secret alone cannot delete',
     noSess.res.ok === false && noSess.res.needsAuth === true);
  ok('  …and nothing was deleted', noSess.programs.rows.some(x => x[ID] === 'wyld-0626'));
  const viewer = run(OK, { auth: { ok: true, user: 'gx-dev', role: 'viewer' } });
  ok('a viewer cannot delete', viewer.res.ok === false && /cannot delete/.test(viewer.res.error));
  ok('  …and nothing was deleted',
     viewer.programs.rows.some(x => x[ID] === 'wyld-0626')
     && viewer.progress.rows.filter(x => x[0] === 'wyld-0626').length === 3);
}
/* Reachability and the router's lists: an assembled function cannot see the dispatch. */
ok('it is NOT public', !/PUBLIC_ACTIONS[^\n]*deleteProgram/.test(G.GS));
ok('it is NOT a secret-only machine route', !/SECRET_ACTIONS[^\n]*deleteProgram/.test(G.GS));
ok('routed on doGet (writes ride on GET here) and on doPost',
   (G.GS.match(/case 'deleteProgram':/g) || []).length === 2);

/* ═════════ THE SCREEN ═════════
 * Source-shaped, and it stays that way: renderRecord builds markup and binds clicks against a live
 * document, and a stub DOM big enough to run it would be a second implementation of the browser to
 * keep correct. The engine above is what actually refuses a bad delete — the screen's gate is a
 * convenience, and these checks pin that it has not quietly disappeared. */
console.log('frontend (markup and wiring — not executable here, see note)');
const ui = grabJs('renderRecord');
const fn = grabJs('deleteProgram');

ok('the delete control is behind the same role gate as every other write',
   /if \(canEdit\(\)\) \{[\s\S]*?btnDelete/.test(ui));
ok('a closed program is TOLD why it cannot be deleted, not silently given no button',
   /closed\s*$|var closed = String\(p\.status/.test(ui) && /stays in History/.test(ui));
ok('the button starts disabled', /id="btnDelete" disabled/.test(ui));
ok('  …and only enables when the typed name matches exactly',
   /del\.disabled = box\.value\.trim\(\) !== want/.test(ui));
ok('  …and the click re-checks it rather than trusting the attribute',
   /if \(box\.value\.trim\(\) !== want\) return;/.test(ui));
ok('the confirm name is sent to the engine', /confirm: name/.test(fn));
ok('the Calculator lets go of the deleted program before the repaint',
   fn.indexOf('calc.editingId = null') < fn.indexOf('syncRecordMount()'));
ok('every surface that lists programs is repainted',
   ['loadPrograms', 'renderPrograms', 'renderHistory', 'fillProgramPickers', 'syncRecordMount']
     .every(f => fn.includes(f)));
ok('an expired session reopens sign-in instead of reading as a failed delete',
   /needsAuth/.test(fn) && /openSignIn\(\)/.test(fn));

console.log(fail ? '\n' + fail + ' FAILED' : '\ndelete program: all passed');
process.exit(fail ? 1 : 0);
