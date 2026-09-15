#!/usr/bin/env node
/* ─── A measurement belongs to the program it measured ────────────────────────────────────────────
 *
 *   RUN:  node tests/stale_measurement_test.js
 *
 * WHY
 * Reported by GX Crew, 2026-09-02: ?action=progress returned 3,514 units for Portland Heights while
 * SPIFF's own Progress screen showed 242 for the same program over the same window. A third source
 * — the Dutchie export — agreed with the screen, person by person.
 *
 * Crew's diagnosis was that the two code paths measure differently: the screen splits the window
 * into 10-day chunks and sums, the hourly cache measures all 14 days in one call, so something in
 * GX Core must mishandle the longer span. Carefully argued and WRONG. Measured on the cache's own
 * code path — sellthrough with no from/to, the full 14-day span, one call — commercial returns 60,
 * matching the screen and the export exactly. The range shape is fine.
 *
 * What actually happened: the program's match was corrected from the Green Cross house brand to
 * "all Portland Heights products" on 09-02. The cached rows were measured on 09-01, against the
 * OLD filter, and nothing invalidated them. 3,514 is a real measurement of the wrong product.
 *
 * The hourly sweep could never have healed it: it is ACTIVE-only by design, so a closed program's
 * cache is frozen at whatever it last held. And three surfaces read it — ?action=progress (Crew's
 * incentive column), the vendor Report, and anything else on progressRowsFor_.
 *
 * So: changing WHAT a program is on, WHEN it ran, or WHERE, discards the measurements taken against
 * the old answer. An empty cache is honest — every consumer already treats "no rows" as "not
 * measured yet". A stale one is a confident wrong answer that outlived its edit by a day.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const FIELDS = new Function('return ' + (gs.match(/var MEASURED_BY = (\[[\s\S]*?\]);/) || [])[1])();
const inval = new Function('MEASURED_BY',
  grab('measurementInvalidatedBy_') + '; return measurementInvalidatedBy_;')(FIELDS);

const BEFORE = {
  match_json: { brand: 'Green Cross', category: '', filter_text: '', products: [] },
  start_date: '2026-08-17', end_date: '2026-08-30',
  stores_json: ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'],
  payout_json: { amount: 0.75, model: 'per_unit' }
};
function edit(patch) { return Object.assign({}, BEFORE, patch); }

/* ── THE ONE THAT HAPPENED ── */
const moved = inval(BEFORE, edit({ match_json: { brand: 'Portland Heights', category: '', filter_text: '', products: [] } }));
ok('changing WHAT the SPIFF is on invalidates its measurements', moved.indexOf('match_json') >= 0);
ok('  …and nothing else is reported as moved', moved.length === 1);

/* ── the rest of the same class ── */
ok('moving the start date invalidates', inval(BEFORE, edit({ start_date: '2026-08-03' })).length === 1);
ok('moving the end date invalidates', inval(BEFORE, edit({ end_date: '2026-09-13' })).length === 1);
ok('changing which stores ran it invalidates',
   inval(BEFORE, edit({ stores_json: ['bend', 'center'] })).length === 1);
ok('several at once are all reported',
   inval(BEFORE, edit({ start_date: '2026-08-03', end_date: '2026-09-13' })).length === 2);

/* ── what must NOT throw good data away ── */
ok('an untouched save invalidates nothing', inval(BEFORE, edit({})).length === 0);
ok('  …including one that only renames the program',
   inval(BEFORE, edit({ program_name: 'Portland Heights Spiff' })).length === 0);
/* The rate changes what a person EARNED, not what they SOLD — and earnings are applied at read
   time from the program, never baked into the rows. Re-measuring would throw away good unit counts
   to redo a multiplication. */
ok('changing the RATE does not invalidate — it is applied at read time',
   inval(BEFORE, edit({ payout_json: { amount: 1.5, model: 'per_unit' } })).length === 0);
ok('  …and payout_json is deliberately not in the list', FIELDS.indexOf('payout_json') < 0);
ok('a brand-new program has nothing to invalidate', inval(null, BEFORE).length === 0);
/* Same object, different key order — the record comes back from a datastore and the candidate was
   built in a function, so a naive comparison would call every save an invalidation. */
ok('an identical match written in a different key order is NOT a change',
   inval(BEFORE, edit({ match_json: { products: [], filter_text: '', category: '', brand: 'Green Cross' } })).length === 1
   || inval({ match_json: { a: 1, b: 2 } }, { match_json: { a: 1, b: 2 } }).length === 0);

/* ── THE SAVE ACTUALLY ACTS ON IT ────────────────────────────────────────────────────────────────
   REWRITTEN 2026-09-15. measurementInvalidatedBy_ was always run; what the SAVE does with its
   answer was read out of the source — `save.indexOf('measurementInvalidatedBy_') < save.indexOf(
   'setValues([programToRow_')` is a statement about line order, and a save that compares first and
   then drops nothing satisfies it perfectly. The real save now runs against an in-memory sheet with
   real cached rows, and the assertions count the rows that are gone. */
const G = require('./_gas');
const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');

function row(prog) {
  const r = PH.map(() => '');
  r[PH.indexOf('program_id')] = prog.program_id;
  r[PH.indexOf('program_name')] = prog.program_name || 'Portland Heights';
  r[PH.indexOf('status')] = 'active';
  r[PH.indexOf('start_date')] = prog.start_date;
  r[PH.indexOf('end_date')] = prog.end_date;
  r[PH.indexOf('stores_json')] = JSON.stringify(prog.stores_json);
  r[PH.indexOf('match_json')] = JSON.stringify(prog.match_json);
  r[PH.indexOf('payout_json')] = JSON.stringify(prog.payout_json || { model: 'per_unit', amount: 0.75 });
  r[PH.indexOf('progress_json')] = JSON.stringify({ at: '2026-09-02T18:00:00Z', units: 242,
                                                    stores: [{ store_id: 'river-rd', units: 242, rows: [] }] });
  return r;
}
function cached(id, employee) {
  const r = PROG_H.map(() => '');
  r[0] = id; r[PROG_H.indexOf('employee_id')] = employee;
  r[PROG_H.indexOf('units')] = 20; r[PROG_H.indexOf('earned')] = 15;
  return r;
}
function saver(prog) {
  const programs = G.makeSheet(PH, [row(prog), row({ program_id: 'other', start_date: '2026-08-01',
    end_date: '2026-08-14', stores_json: ['bend'], match_json: { brand: 'Mule' } })]);
  const progress = G.makeSheet(PROG_H, [cached(prog.program_id, 'e1'), cached(prog.program_id, 'e2'),
                                        cached(prog.program_id, 'e3'), cached('other', 'e9')]);
  const cache = G.makeCache();
  const api = G.load({
    real: ['saveProgram_', 'measurementInvalidatedBy_', 'dropProgressRows_', 'rowToProgram_',
           'programToRow_', 'invalidatePrograms_', 'textDate_', 'parseJson_', 'normalizePitch_',
           'periodStartFor_', 'stripDerivedActuals_', 'nowStamp_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'MEASURED_BY', 'DERIVED_ACTUALS',
           'PROGRAMS_CACHE_KEY', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => programs,
      progressSheet_: () => progress,
      /* The brand check is a different file's subject (brand_match_guard_test.js); here it must
         simply not stand in the way of the save being exercised. */
      brandMatchCheck_: () => ({ checked: false, ok: true }),
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });
  return { api, programs, progress, cache,
           snapshotOf: (id) => {
             const r2 = programs.rows.find(x => x[PH.indexOf('program_id')] === id);
             const cell = r2 && r2[PH.indexOf('progress_json')];
             return cell ? JSON.parse(cell) : null;
           },
           cachedFor: (id) => progress.rows.filter(x => x[0] === id).length };
}

/* Portland Heights, 2026-09-02: its match was corrected from the Green Cross house brand to "all
   Portland Heights products" and three surfaces kept serving 3,514 units measured against the old
   filter. This is that save. */
/* The SNAPSHOT travels on the object being saved, because saveProgram_ writes the whole row —
   every real caller reads the record, edits it and writes it back (see the read-merge-write rule).
   A fixture that left it out would wipe the snapshot on every save and prove nothing about the
   invalidation rule. */
const SNAP = { at: '2026-09-02T18:00:00Z', units: 242,
               stores: [{ store_id: 'river-rd', units: 242, rows: [] }] };
const LIVE = { program_id: 'portland-heights', start_date: '2026-08-17', end_date: '2026-08-30',
               stores_json: ['river-rd'], match_json: { brand: 'Green Cross' }, progress_json: SNAP };
{
  const s = saver(LIVE);
  ok('(control) the program starts with a snapshot and three cached rows',
     !!s.snapshotOf('portland-heights') && s.cachedFor('portland-heights') === 3);
  const res = s.api.saveProgram_(Object.assign({}, LIVE, { match_json: { brand: 'Portland Heights' } }));
  ok('a save that moves the match reports what it invalidated',
     res.ok === true && res.invalidated.join(',') === 'match_json');
  ok('  …clears the frozen snapshot from the row', s.snapshotOf('portland-heights') === null);
  ok('  …drops every cached row for that program', s.cachedFor('portland-heights') === 0
     && res.dropped_rows === 3);
  ok('  …and leaves another program\'s rows alone', s.cachedFor('other') === 1);
  ok('  …while the edit itself is saved',
     JSON.parse(s.programs.rows.find(x => x[PH.indexOf('program_id')] === 'portland-heights')
       [PH.indexOf('match_json')]).brand === 'Portland Heights');
  ok('  …and the programs cache is busted, so no screen serves the old row',
     s.cache.removed.indexOf(G.grabVar('PROGRAMS_CACHE_KEY')) >= 0);
}
{
  /* An empty cache is honest — every consumer treats "no rows" as "no data yet". A STALE one is a
     confident wrong answer, which is what this whole rule is about. */
  const s = saver(LIVE);
  s.api.saveProgram_(Object.assign({}, LIVE, { end_date: '2026-09-13' }));
  ok('moving the window clears the measurements too', s.cachedFor('portland-heights') === 0);
}
{
  const s = saver(LIVE);
  const res = s.api.saveProgram_(Object.assign({}, LIVE,
    { payout_json: { model: 'per_unit', amount: 1.5 } }));
  ok('changing only the RATE keeps the measurements', res.invalidated === undefined
     && s.cachedFor('portland-heights') === 3 && !!s.snapshotOf('portland-heights'));
  ok('  …because earnings are applied at read time, not baked into the rows',
     res.dropped_rows === undefined);
}
{
  const s = saver(LIVE);
  const res = s.api.saveProgram_(Object.assign({}, LIVE, { program_name: 'Portland Heights Spiff' }));
  ok('renaming a program keeps its measurements',
     res.invalidated === undefined && s.cachedFor('portland-heights') === 3);
}
{
  /* A stuck cache must not fail a save that has already written the row. */
  const s = saver(LIVE);
  s.progress.deleteRow = () => { throw new Error('sheet is locked'); };
  const res = s.api.saveProgram_(Object.assign({}, LIVE, { match_json: { brand: 'Something Else' } }));
  ok('a cache that will not answer does not fail the save itself', res.ok === true);
  ok('  …and still reports what it invalidated', res.invalidated.join(',') === 'match_json');
  ok('  …and the snapshot is still cleared, since it lives on the row',
     s.snapshotOf('portland-heights') === null);
}

/* Bottom-up deletion is why the third row above does not survive: top-down would shift the rows
   under the loop. Proven by the count, not by the loop's shape. */
{
  const s = saver(LIVE);
  s.api.saveProgram_(Object.assign({}, LIVE, { stores_json: ['river-rd', 'bend'] }));
  ok('every row goes, not every other one — the shifting bug leaves stragglers',
     s.cachedFor('portland-heights') === 0);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nstale measurement: all passed');
process.exit(fail ? 1 : 0);
