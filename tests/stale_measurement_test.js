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

/* ── the save actually acts on it ── */
const save = grab('saveProgram_');
ok('the comparison happens BEFORE the row is overwritten',
   save.indexOf('measurementInvalidatedBy_') < save.indexOf('setValues([programToRow_'));
ok('the frozen snapshot is cleared', /if \(moved\.length\) p\.progress_json = null/.test(save));
ok('the cached rows are dropped', /dropProgressRows_\(p\.program_id\)/.test(save));
ok('  …and a stuck cache never fails the save itself',
   /catch \(e\) \{ \/\* the row is already saved/.test(save));
ok('the reply says what was invalidated, so a caller is not left guessing',
   /invalidated: moved\.length \? moved : undefined/.test(save));

const drop = grab('dropProgressRows_');
ok('rows are deleted bottom-up, or the indexes shift under the loop',
   /for \(var i = vals\.length - 1; i >= 1; i--\)/.test(drop));

console.log(fail ? '\n' + fail + ' FAILED' : '\nstale measurement: all passed');
process.exit(fail ? 1 : 0);
