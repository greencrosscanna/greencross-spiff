#!/usr/bin/env node
/* ─── One SPIFF row per PERSON, not per spelling ──────────────────────────────────────────────────
 *
 *   RUN:  node tests/seller_aggregation_test.js
 *
 * WHY
 * aggregateSellers_ turns a GX Core `sales_by_employee` payload into the per-budtender rows the
 * Progress grid shows and the payout is computed from. It keyed on NAME until 2026-08-30, which
 * was only ever a stopgap for an empty employees tab in GX Core. A name is not an identity, and
 * both directions of that cost real money:
 *
 *   two people, one name   -> summed into a single row. One target, one SPIFF paid, one budtender
 *                             silently unpaid for units they actually sold.
 *   one person, two names  -> split in two. Each half lands under the target, `hit` is false on
 *                             both, and a budtender who cleared the goal is paid nothing.
 *
 * The key is now the Dutchie id, falling back to the name only when there is no id at all. The
 * fallback matters as much as the key: dropping unidentified sellers into one bucket keyed ''
 * would merge strangers, which is the first failure above wearing a different hat.
 *
 * The mixed case is the subtle one and is why aggregateSellers_ makes two passes — see the
 * `learns an id from a sibling row` case below.
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

const agg = new Function(`${grab('userKey_')}\n${grab('aggregateSellers_')}\nreturn aggregateSellers_;`)();
const by = (list, name) => list.filter(e => e.name === name);
const row = (o) => Object.assign({ store_id: 'bend', units: 0, revenue: 0 }, o);

/* ── the ordinary case still behaves ── */
let out = agg([
  row({ employee_name: 'Nathan Wydick', dutchie_employee_id: '44905', units: 100, revenue: 500 }),
  row({ employee_name: 'Chris Carney',  dutchie_employee_id: '42415', units: 60,  revenue: 300 }),
], 'bend');
ok('distinct people stay distinct', out.length === 2);
ok('units survive the round trip', by(out, 'Nathan Wydick')[0].units === 100);
ok('store_id is stamped on every row', out.every(e => e.store_id === 'bend'));

/* ── one person, two spellings: the split that paid nobody ── */
out = agg([
  row({ employee_name: 'Nathan Wydick', dutchie_employee_id: '44905', units: 30 }),
  row({ employee_name: 'nathan  wydick', dutchie_employee_id: '44905', units: 25 }),
], 'bend');
ok('same id under two spellings is ONE person', out.length === 1);
ok('...and their units are summed, not split', out[0].units === 55);

/* ── two people, one name: the merge that overpaid one and underpaid the other ── */
out = agg([
  row({ employee_name: 'Alex Smith', dutchie_employee_id: '111', units: 40 }),
  row({ employee_name: 'Alex Smith', dutchie_employee_id: '222', units: 35 }),
], 'bend');
ok('one name across two ids is TWO people', out.length === 2);
ok('...and neither inherits the other units', out.every(e => e.units === 40 || e.units === 35));

/* ── the mixed case: pass 1 is what stops a NEW split being introduced ── */
out = agg([
  row({ employee_name: 'Janett Webber', dutchie_employee_id: '42793', units: 20 }),
  row({ employee_name: 'Janett Webber', units: 15 }),   // same person, id missing on this row
], 'bend');
ok('a row with no id joins its identified twin', out.length === 1);
ok('...summing across the gap', out[0].units === 35);
ok('...and keeps the id', out[0].employee_id === '42793');

/* ── no id anywhere: fall back to the NAME, never to one shared '' bucket ── */
out = agg([
  row({ employee_name: 'Ghost One', units: 10 }),
  row({ employee_name: 'Ghost Two', units: 12 }),
], 'bend');
ok('unidentified sellers do NOT collapse into one row', out.length === 2);
ok('...and carry an empty id rather than a fake one', out.every(e => e.employee_id === ''));

/* ── GX Core older than v248 ships only the deprecated alias ── */
out = agg([
  row({ employee_name: 'Legacy Payload', employee_id: '42790', units: 9 }),
  row({ employee_name: 'legacy payload', employee_id: '42790', units: 1 }),
], 'bend');
ok('the deprecated employee_id alias still joins', out.length === 1 && out[0].units === 10);
ok('...and is read into our own employee_id field', out[0].employee_id === '42790');

/* ── data we do not control ── */
out = agg([
  row({ employee_name: 'constructor', dutchie_employee_id: '900', units: 5 }),
  row({ employee_name: 'valueOf', units: 7 }),
], 'bend');
ok('a budtender named "constructor" does not hit Object.prototype', out.length === 2);
ok('...and their units are a number, not a function', out.every(e => typeof e.units === 'number'));

/* ── an id that looks like a name, and a name that looks like an id ── */
out = agg([
  row({ employee_name: '44905', units: 3 }),                                  // no id, digit name
  row({ employee_name: 'Real Person', dutchie_employee_id: '44905', units: 4 }),
], 'bend');
ok('a digit-only NAME cannot collide with that id', out.length === 2);

/* ── nothing in, nothing out ── */
ok('an empty payload is an empty list', agg([], 'bend').length === 0);
ok('a missing payload does not throw', agg(null, 'bend').length === 0);
ok('a nameless row is skipped', agg([row({ employee_name: '  ', units: 5 })], 'bend').length === 0);

console.log(fail ? `\nseller aggregation: ${fail} FAILED` : '\nseller aggregation: all passed');
process.exit(fail ? 1 : 0);
