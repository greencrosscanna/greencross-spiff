#!/usr/bin/env node
/* ─── What a program row shows for SOLD and BUDTENDERS HIT ────────────────────────────────────────
 *
 *   RUN:  node tests/row_totals_test.js
 *
 * WHY
 * Actuals are written at CLOSE-OUT. A running program has none — so the list row, which read only
 * actual_json, rendered "0" sold and "0 / 0" hit while the hero directly above it, reading the same
 * program from the progress cache, showed 117 sold and 18 hit. Two numbers for one program on one
 * screen, and the smaller, wronger one looked like a settled fact. Reported by Sky 2026-08-29.
 *
 * The rule this guards is about PRECEDENCE, and it is asymmetric on purpose:
 *   closed  -> actual_json wins. It is what was reconciled and invoiced; a cache refresh must never
 *              appear to restate a number a vendor was already billed for.
 *   running -> the cache wins. Nothing is settled yet and the live figure is the point.
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
  throw new Error('unterminated ' + name);
}

/* rowTotals is the whole decision; liveTotals/cachedTotals are its two sources and get stubbed so
   the test is about precedence, not about how the cache is assembled. */
function load(live, cached) {
  const src = `
    function liveTotals()  { return LIVE; }
    function cachedTotals() { return CACHED; }
    ${grab('rowTotals')}
    return rowTotals;`;
  return new Function('LIVE', 'CACHED', src)(live, cached);
}

const TARGET = { units: 100, budtenders: 17 };
const CACHE  = { units: 117, hit: 18, bts: 19 };
const ACTUAL = { units_sold: 90, bts_hit: 12 };

/* ── the bug, exactly as reported ── */
let rowTotals = load(null, CACHE);
let r = rowTotals({ program_id: 'P1', status: 'active', target_json: TARGET, actual_json: null });
ok('a RUNNING program with no actuals reads the cache, not zero', r && r.units === 117);
ok('and its budtenders-hit is not 0 / 0', r && r.hit === 18);
ok('and it is marked live, so it cannot be read as settled', r && r.live === true);

/* target_json.budtenders is the PLANNED headcount and is routinely unset while a program runs —
   the other half of "0 / 0". */
r = rowTotals({ program_id: 'P1', status: 'active', target_json: {}, actual_json: null });
ok('an unset planned headcount falls back to who actually sold', r && r.bts === 19);

/* ── the money rule: a settled figure is not restated by a later refresh ── */
r = rowTotals({ program_id: 'P1', status: 'closed', target_json: TARGET, actual_json: ACTUAL });
ok('a CLOSED program shows the reconciled actuals, NOT the cache', r && r.units === 90 && r.hit === 12);
ok('and is not marked live', r && r.live === false);

/* An active program that somehow has actuals still prefers the cache: it is still moving. */
r = rowTotals({ program_id: 'P1', status: 'active', target_json: TARGET, actual_json: ACTUAL });
ok('a RUNNING program prefers the cache even when actuals exist', r && r.units === 117);

/* ── falling through, both directions ── */
rowTotals = load(null, null);
r = rowTotals({ program_id: 'P1', status: 'closed', target_json: TARGET, actual_json: ACTUAL });
ok('a closed program predating the cache still shows its actuals', r && r.units === 90);

r = rowTotals({ program_id: 'P1', status: 'active', target_json: TARGET, actual_json: null });
ok('NOTHING to show returns null — the row draws a dash, never a confident 0', r === null);

/* A real zero must survive: sold-nothing is a fact, and units_sold != null is why. */
r = rowTotals({ program_id: 'P1', status: 'closed', target_json: TARGET,
                actual_json: { units_sold: 0, bts_hit: 0 } });
ok('a genuine zero on a closed program is shown, not treated as missing', r && r.units === 0 && r.live === false);

/* Live wins over cached — an in-flight pull is fresher than the hourly sweep. */
rowTotals = load({ units: 200, hit: 20, bts: 21 }, CACHE);
r = rowTotals({ program_id: 'P1', status: 'active', target_json: TARGET, actual_json: null });
ok('an in-flight pull outranks the hourly cache', r && r.units === 200);

console.log(fail ? '\n' + fail + ' FAILED' : '\nrow totals: all passed');
process.exit(fail ? 1 : 0);
