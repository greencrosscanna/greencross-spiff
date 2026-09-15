#!/usr/bin/env node
/* ─── Re-keying a program moves everything keyed on it ────────────────────────────────────────────
 *
 *   RUN:  node tests/rename_program_id_test.js
 *
 * Sky, 2026-09-08: "update id green-cross-test-202608 to reflect the Portland Heights program."
 * That program is the real Portland Heights fortnight (Aug 17–30, 242 units, $181.50, closed and
 * paid); it carries a test-shaped id only because ids are minted from the name at creation and it
 * was created while named "Green Cross test".
 *
 * WHY THIS NEEDS A ROUTE AND A TEST, and not a cell edit. `program_id` is a FOREIGN KEY:
 *
 *   · `spiff_progress` keys every measurement row on it — 38 rows for this program.
 *   · `?action=progress` DROPS any cached row whose program_id is absent from `programs`, counting
 *     it in orphan_rows.
 *   · GX Crew's incentive column and the Leaderboard kiosks read that route.
 *   · Core's `spiff_publications` now carries the id inside the published payload.
 *
 * Editing the cell in `programs` and stopping would strand 38 rows carrying $181.50 — the BeGOAT
 * failure of 2026-08-31 reproduced exactly (25 stranded rows, $350, fourteen people showing as
 * owed $25 for a fortnight already paid). `deleteProgram` exists because a program is not one row;
 * a rename is the same fact.
 *
 * REWRITTEN 2026-09-15 to RUN the route instead of reading it. Every claim below used to be a
 * regex over renameProgramId_'s source: "the measurements move first" was `indexOf(a) < indexOf(b)`
 * on the source text, which is true of a function that moves them first and equally true of one
 * whose loop never matches a row. The file now drives the real route against an in-memory sheet and
 * counts the rows that actually moved. What stays source-shaped is only what execution cannot see:
 * that the route is wired into the dispatch at all, and that it is absent from the secret-only list.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const ID = PH.indexOf('program_id');

/* Portland Heights as the sheet actually holds it: closed, paid, 38 measurement rows carrying
   $181.50 between them. The numbers are the real ones — a rename that changed them would be a
   different bug, and this file is the only thing watching for it. */
function portlandHeights() {
  const row = [];
  PH.forEach(() => row.push(''));
  row[ID] = 'green-cross-test-202608';
  row[PH.indexOf('vendor')] = 'Green Cross';
  row[PH.indexOf('program_name')] = 'Green Cross test';
  row[PH.indexOf('status')] = 'closed';
  row[PH.indexOf('start_date')] = '2026-08-17';
  row[PH.indexOf('end_date')] = '2026-08-30';
  row[PH.indexOf('payout_type')] = 'per_unit';
  row[PH.indexOf('payout_json')] = JSON.stringify({ model: 'per_unit', amount: 0.75 });
  row[PH.indexOf('actual_json')] = JSON.stringify({ units_sold: 242, bts_hit: 38, investment: 181.5 });
  return row;
}
function otherProgram(id, name) {
  const row = [];
  PH.forEach(() => row.push(''));
  row[ID] = id; row[PH.indexOf('program_name')] = name; row[PH.indexOf('status')] = 'active';
  row[PH.indexOf('start_date')] = '2026-03-30'; row[PH.indexOf('end_date')] = '2026-04-12';
  return row;
}
/* 38 rows for the program being renamed, plus one for a different program that must not move. */
function progressRows(id) {
  const rows = [];
  for (let i = 0; i < 38; i++) {
    const r = PROG_H.map(() => '');
    r[0] = id; r[2] = 'portland-heights'; r[3] = String(100 + i);
    r[PROG_H.indexOf('units')] = 6; r[PROG_H.indexOf('earned')] = 4.5;
    rows.push(r);
  }
  const foreign = PROG_H.map(() => '');
  foreign[0] = 'portland-heights-2026-03-30-2026-04-12';
  foreign[PROG_H.indexOf('earned')] = 25;
  rows.push(foreign);
  return rows;
}

/* One rename, run for real. Returns the answer AND the sheets afterwards, so an assertion can ask
   what moved rather than what the source says it would move. */
function run(params, opts) {
  const o = opts || {};
  const programs = G.makeSheet(PH, o.programs || [portlandHeights(),
                                                 otherProgram('portland-heights-2026-03-30-2026-04-12', 'Portland Heights spring')]);
  const progress = G.makeSheet(PROG_H, o.progress || progressRows('green-cross-test-202608'));
  const deleted  = G.makeSheet(PH.concat(['deleted_by', 'deleted_at', 'reason']));
  const cache = G.makeCache();
  const t = G.trace();
  const published = [];

  const api = G.load({
    real: ['renameProgramId_', 'repointProgressRows_', 'countProgressRows_', 'getProgram_',
           'listPrograms_', 'rowToProgram_', 'programToRow_', 'invalidatePrograms_',
           'slug_', 'scrubSecrets_', 'textDate_', 'parseJson_', 'normalizePitch_',
           'periodStartFor_', 'stripDerivedActuals_', 'nowStamp_'],
    vars: ['PROGRAM_HEADERS', 'EDIT_ROLES', 'PROGRESS_HEADERS', 'DERIVED_ACTUALS',
           'PROGRAMS_CACHE_KEY', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_:     () => programs,
      progressSheet_: () => progress,
      deletedSheet_:  t.wrap('tombstone', () => deleted),
      gxAuth_:        () => (o.auth || { ok: true, user: 'sky', role: 'admin' }),
      /* The measurement move and the republish are the two steps that can fail independently, so
         both are injectable: a test can make one throw and watch what the route does about it. */
      publishSpiffToCore_: t.wrap('publish', (arg) => {
        published.push(arg);
        return o.publish || { ok: true, published: 1 };
      }),
      annotateActuals_:     () => {},
      annotateUnmeasurable_: () => {},
      payPeriodCfg_:        () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });

  /* WHICH SHEET WAS WRITTEN, AND WHEN. The route's safety argument is an ordering of writes —
     tombstone, then the measurements, then the program row — so the order is recorded from the
     sheets themselves rather than from the order of lines in the source. */
  [[programs, 'program_row'], [progress, 'progress_row']].forEach(function (pair) {
    const sheet = pair[0], label = pair[1], orig = sheet.getRange.bind(sheet);
    sheet.getRange = function (r, c, nr, nc) {
      const range = orig(r, c, nr, nc);
      const setValue = range.setValue.bind(range);
      range.setValue = (v) => { t.calls.push(label); return setValue(v); };
      return range;
    };
  });

  const res = api.renameProgramId_(params);
  return { res, programs, progress, deleted, cache, trace: t, published, api };
}

const OK = { token: 'tok', id: 'green-cross-test-202608', to: 'portland-heights-2026-08-17-2026-08-30',
             confirm: 'Green Cross test', apply: '1' };

/* ══════════════════ 1. EVERYTHING KEYED ON THE ID MOVES ══════════════════ */
{
  const r = run(OK);
  ok('the rename answers ok', r.res.ok === true && r.res.dry === false);
  ok('all 38 cached measurement rows are re-pointed, not left behind',
     r.res.progress_rows_moved === 38);
  const moved = r.progress.rows.filter(x => x[0] === OK.to);
  ok('  …and the sheet really holds them under the new id', moved.length === 38);
  ok('  …with none left under the old one',
     r.progress.rows.every(x => x[0] !== OK.id));
  ok('  …and a different program\'s rows are untouched',
     r.progress.rows.filter(x => x[0] === 'portland-heights-2026-03-30-2026-04-12').length === 1);
  /* THE POINT OF A RE-KEY: the money does not move, only the key. */
  ok('every unit and dollar is unchanged — this is a re-key, not a re-measure',
     moved.every(x => x[PROG_H.indexOf('units')] === 6 && x[PROG_H.indexOf('earned')] === 4.5));
  ok('the program row now answers to the new id',
     r.programs.rows.some(x => x[ID] === OK.to) && !r.programs.rows.some(x => x[ID] === OK.id));
  ok('  …and the row itself is otherwise as it was: still closed, still $181.50',
     (() => {
       const row = r.programs.rows.find(x => x[ID] === OK.to);
       return row[PH.indexOf('status')] === 'closed'
         && JSON.parse(row[PH.indexOf('actual_json')]).investment === 181.5;
     })());
  ok('no program row is added or lost', r.programs.rows.length === 3);

  /* Order is the whole safety argument, and it is an ordering of WRITES. */
  ok('the measurements move BEFORE the program row',
     r.trace.before('progress_row', 'program_row') && r.progress.rows.every(x => x[0] !== OK.id));
  ok('the old row is tombstoned before either of them moves',
     r.trace.before('tombstone', 'progress_row') && r.trace.before('tombstone', 'program_row'));
  ok('  …as a full row plus who, when and why',
     r.deleted.rows.length === 2
     && r.deleted.rows[1][ID] === OK.id
     && r.deleted.rows[1].slice(-3)[0] === 'sky'
     && r.deleted.rows[1].slice(-1)[0] === 'renamed to ' + OK.to);
  ok('the programs cache is cleared, so the new id is visible at once',
     r.cache.removed.indexOf(G.grabVar('PROGRAMS_CACHE_KEY')) >= 0);
  ok('Core is republished, so its payload stops carrying the old id',
     r.published.length === 1 && /renaming/.test(r.published[0].notes) && r.res.republished === 1);
  ok('  …and the rename does not warn when the republish worked', !r.res.warning);
}

/* A failed republish is REPORTED — the rename itself is done and correct. */
{
  const r = run(OK, { publish: { ok: false, error: 'Core unreachable' } });
  ok('a failed republish still leaves the rename done',
     r.res.ok === true && r.res.progress_rows_moved === 38);
  ok('  …and says so, naming Core rather than failing silently',
     /republish to Core failed/.test(r.res.warning || '') && /Core unreachable/.test(r.res.warning));
}

/* ══════════════════ 2. IT CANNOT MERGE TWO PROGRAMS ══════════════════ */
{
  const r = run(Object.assign({}, OK, { to: 'portland-heights-2026-03-30-2026-04-12' }));
  ok('an id already in use is refused',
     r.res.ok === false && /already exists/.test(r.res.error));
  ok('  …and nothing moved: the other program keeps its own single row',
     r.progress.rows.filter(x => x[0] === 'portland-heights-2026-03-30-2026-04-12').length === 1
     && r.progress.rows.filter(x => x[0] === OK.id).length === 38
     && r.deleted.rows.length === 1);
}
ok('a no-op rename is refused rather than tombstoned',
   (() => { const r = run(Object.assign({}, OK, { to: OK.id })); return !r.res.ok && r.deleted.rows.length === 1; })());
ok('both ids are required', run(Object.assign({}, OK, { to: '' })).res.error === 'id and to are both required');
ok('an unknown id is refused', /not found/.test(run(Object.assign({}, OK, { id: 'nope' })).res.error));
{
  /* Slugged, so an id cannot be minted with spaces or capitals — checked on the id the sheet ends
     up holding, which is the only place it matters. */
  const r = run(Object.assign({}, OK, { to: '  Portland Heights 2026 08 17  ' }));
  ok('the new id is slugged before it is written',
     r.res.ok === true && r.res.to === 'portland-heights-2026-08-17'
     && r.programs.rows.some(x => x[ID] === 'portland-heights-2026-08-17'));
}

/* ══════════════════ 3. THE SAME GATES AS DELETING ══════════════════ */
{
  const noSess = run(OK, { auth: { ok: false, error: 'Session expired' } });
  ok('it needs a real session, not just the deploy secret',
     noSess.res.ok === false && noSess.res.needsAuth === true);
  ok('  …and nothing moved when it refused',
     noSess.progress.rows.filter(x => x[0] === OK.id).length === 38);
  const viewer = run(OK, { auth: { ok: true, user: 'gx-dev', role: 'viewer' } });
  ok('a viewer cannot rename', viewer.res.ok === false && /cannot rename/.test(viewer.res.error));
  ok('  …and nothing moved', viewer.progress.rows.filter(x => x[0] === OK.id).length === 38);
}
{
  const wrong = run(Object.assign({}, OK, { confirm: 'Portland Heights' }));
  ok('the program NAME must be typed back, checked server-side',
     wrong.res.ok === false && /Type the program name exactly/.test(wrong.res.error));
  ok('  …and the error says which name, so the caller is not guessing',
     /Green Cross test/.test(wrong.res.error));
  ok('  …because writes ride on GET and a URL gets pasted and re-fetched',
     /pasted, bookmarked and re-fetched/.test(G.grab('renameProgramId_')));
}
{
  const dry = run(Object.assign({}, OK, { apply: '' }));
  ok('dry by default — nothing moves without apply=1',
     dry.res.ok === true && dry.res.dry === true);
  ok('  …and it really changed nothing',
     dry.progress.rows.filter(x => x[0] === OK.id).length === 38
     && dry.programs.rows.some(x => x[ID] === OK.id)
     && dry.deleted.rows.length === 1 && dry.published.length === 0);
  ok('  …while still counting the rows it WOULD move, from the sheet',
     dry.res.progress_rows_to_move === 38);
  ok('  …and saying the window and status it found', dry.res.status === 'closed'
     && dry.res.window[0] === '2026-08-17' && dry.res.window[1] === '2026-08-30');
}

/* ── What execution cannot see: the route has to be reachable ──────────────────────────────────
   An assembled function proves the logic; it cannot prove the dispatch calls it. These two stay
   source-shaped on purpose — they are the legitimate use of the shape. */
ok('it is registered as a route, or none of this is reachable',
   /case 'renameProgramId': out = renameProgramId_\(p\);/.test(G.GS));
ok('  …and NOT on the secret-only list, which would drop the session requirement',
   !/SECRET_ACTIONS = \[[^\]]*renameProgramId/.test(G.GS));
/* An earlier draft called an invalidator that does not exist, AFTER both halves had moved. The
   rename above proves the cache IS cleared; this proves the landmine is still gone. */
ok('nothing calls an invalidator that does not exist',
   !/^\s*invalidateProgressCache_\(\);/m.test(G.GS) && !/^function invalidateProgressCache_/m.test(G.GS));

/* ══════════════════ 4. CLOSED IS RENAMEABLE, UNLIKE DELETABLE ══════════════════ */
/* A delete removes money that was reported and paid. A rename moves the same money to a key that
   says what it is — and Portland Heights is closed, so refusing would make the bad id permanent.
   Section 1 renamed a CLOSED program end to end, which is the real proof; what is left is that the
   delete beside it still refuses one. */
{
  const del = G.load({
    real: ['deleteProgram_', 'getProgram_', 'listPrograms_', 'rowToProgram_', 'textDate_',
           'parseJson_', 'normalizePitch_'],
    vars: ['PROGRAM_HEADERS', 'EDIT_ROLES', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => G.makeSheet(PH, [portlandHeights()]),
      deletedSheet_: () => { throw new Error('a closed program must never be tombstoned'); },
      gxAuth_: () => ({ ok: true, user: 'sky', role: 'admin' }),
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      invalidatePrograms_: () => {}, dropProgressRows_: () => 0, programToRow_: () => [],
      nowStamp_: () => '2026-09-15 12:00:00',
    },
  });
  const r = del.deleteProgram_({ token: 'tok', id: 'green-cross-test-202608', confirm: 'Green Cross test' });
  ok('deleting a closed program is still refused',
     r.ok === false && /it ran, was reported to the brand and was paid/.test(r.error));
}

/* ══════════════════ 5. IT DOES NOT GO THROUGH THE SAVE PATH ══════════════════ */
/* saveProgram_ clears a program's measurements when the fields that define what it measured move.
   A re-key must NOT trip that: the numbers are correct and only the key is changing. Section 1
   proves the measurements survived; this pins the mechanism that keeps it true. */
ok('the program row is re-keyed by a direct cell write, not through saveProgram_',
   G.grab('renameProgramId_').indexOf('saveProgram_') < 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nrename program id: all passed');
process.exit(fail ? 1 : 0);
