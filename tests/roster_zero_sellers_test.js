#!/usr/bin/env node
/* ─── Everyone at the store shows on What's selling, including the people at zero ────────────────
 *
 *   RUN:  node tests/roster_zero_sellers_test.js
 *
 * Sell-through only returns people who sold something, so Center's card listed four of its six
 * staff on the Mule SPIFF (2026-09-09) — its store manager and assistant manager, both at 0, were
 * simply absent. Tawny's hand-built sheet listed them.
 *
 * This RUNS withRoster against the real Center case rather than grepping for it. The one shape
 * check at the end guards the decision that matters most: the zero rows are added in the browser,
 * not in the engine, because the engine's rows feed Crew's pay screen, the kiosks and Core.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const make = new Function('rosterByStore',
  grab(js, 'nameParts') + grab(js, 'sameName') + grab(js, 'withRoster') + '\nreturn withRoster;');

/* Center's roster, as GX Core had it on 2026-09-11. */
const roster = { center: [
  { name: 'Malia Gascon',        display_name: 'Malia Gascon',   employee_id: '45705' },
  { name: 'Nathaniel Schneider', display_name: 'Nate Schneider', employee_id: '45475' },
  { name: 'Jennifer Alexander',  display_name: 'Jayce Alexander', employee_id: '45315' },
  { name: 'Sierra Martin',       display_name: 'Sierra Martin',  employee_id: '45783' },
  { name: 'Samuel Keck',         display_name: 'Sam Keck',       employee_id: '42744' },
  { name: 'Tyson Farris',        display_name: 'Tyson Farris',   employee_id: '42416' },
], 'portland-rd': [
  { name: 'Andrew Roberts',      display_name: 'Andrew Roberts', employee_id: '' },
  { name: 'Treshawn Jones',      display_name: 'Tre Jones',      employee_id: '45640' },
] };
const withRoster = make(roster);

/* What sell-through returned for Center that morning: four sellers. */
const center = { target: 3, rows: [
  { name: 'Malia Gascon',                employee_id: '45705', units: 2, target: 3, hit: false },
  { name: 'Nathaniel Schneider',         employee_id: '45475', units: 2, target: 3, hit: false },
  { name: 'Jennifer "Jayce" Alexander',  employee_id: '45315', units: 1, target: 3, hit: false },
  { name: 'Sierra Martin',               employee_id: '45783', units: 1, target: 3, hit: false },
] };
const all = withRoster('center', center);
ok('Center shows all six people, not the four who sold', all.length === 6);
ok('  …the two added are Sam Keck and Tyson Farris',
   all.slice(4).map(e => e.display_name).join(',') === 'Sam Keck,Tyson Farris');
ok('  …at zero units, carrying the store target, never hit',
   all.slice(4).every(e => e.units === 0 && e.target === 3 && e.hit === false));
ok('  …after the sellers, whose rows are untouched', all.slice(0, 4).every((e, i) => e === center.rows[i]));
ok('  …and the response itself is not mutated', center.rows.length === 4);

/* Dutchie adds a middle name the roster does not have, and one roster row has no Dutchie id. */
const pr = withRoster('portland-rd', { target: 3, rows: [
  { name: 'Andrew Roberts', employee_id: '', units: 3 },
  { name: 'TreShawn Jones', employee_id: '45640', units: 4 },
] });
ok('a seller with no Dutchie id is matched by name, not shown twice', pr.length === 2);
const bend = make({ bend: [{ name: 'Sareena Gonzalez', display_name: 'Sunshine Gonzalez', employee_id: '' }] })
  ('bend', { target: 7, rows: [{ name: 'Sareena Sunshine Gonzalez', employee_id: '', units: 8 }] });
ok('a Dutchie middle name still matches the roster by first + last', bend.length === 1);

/* No roster (it failed, or has not landed yet) is the grid exactly as it was. */
const none = make({})('center', center);
ok('no roster leaves the rows exactly as sell-through returned them', none === center.rows);
ok('a store nobody is rostered at adds nothing', withRoster('hillsboro', center) === center.rows);

/* The card counts the roster, the stats strip falls back to it, and the grid repaints when it lands. */
const card = grab(js, 'pgCard');
ok('the card renders and counts everyone at the store', /withRoster\(st, r\)/.test(card) && / of ' \+ all\.length \+ ' hit/.test(card));
ok('the roster landing repaints a live grid, not a retired tab', /if \(pgRun\) paintProgress\(\)/.test(js)
   && !/state\.tab === 'progress'\) paintProgress/.test(js));

/* DISPLAY ONLY: the engine's sell-through still returns sellers only. */
ok('the engine does not add roster rows to sell-through — Crew, the kiosks and Core read it',
   !/rostered/.test(gs) && !/withRoster/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\nroster zero sellers: all passed');
process.exit(fail ? 1 : 0);
