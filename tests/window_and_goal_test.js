#!/usr/bin/env node
/* ─── Two controls that decide what a program IS ──────────────────────────────────────────────────
 *
 *   RUN:  node tests/window_and_goal_test.js
 *
 * WHY THESE TWO TOGETHER
 * Both were "make it editable / stop making it editable" asks from Sky on 2026-08-31, and both are
 * one careless default away from silently rewriting a program that has already been paid out.
 *
 *   1. THE WINDOW IS PAY PERIODS NOW ("remove custom dates option, only allow PPs"). A SPIFF is
 *      settled against payroll, so a window ending mid-period is a payout landing in a fortnight
 *      nobody can reconcile it to. But three live records predate the rule and MUST NOT be snapped
 *      onto the grid — two of them are CLOSED and were reported to the vendor against the dates
 *      they hold. Moving a settled program's window to make a dropdown tidy changes what it says
 *      it measured.
 *
 *   2. THE PER-BUDTENDER GOAL IS PINNABLE ("so Tawny can fine tune as needed, ie tune down
 *      commercial and tune up another store"). The trap is the empty box: an untouched override
 *      run through `Number(x) || 0` is a store told to sell nothing, and the chain total absorbs
 *      it without complaint.
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
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. THE WINDOW ══════════════════ */
/* The real anchor and length, so these are the periods the app actually offers. */
const P = new Function('payCfg', [
  grab('ymdPlus'), grab('daysBetween'), grab('periodIndexOf'), grab('periodByIndex'),
  grab('periodSpanOf'),
  'return { periodSpanOf, periodByIndex, periodIndexOf };'
].join('\n'))({ anchor: '2026-05-11', days: 14 });

/* A normal program: one whole period. */
let sp = P.periodSpanOf('2026-08-31', '2026-09-13');
ok('a single pay period is recognized as one', sp && sp.from === sp.to);

/* Buddies ran 2026-06-22 → 2026-07-19 — TWO whole periods. One select could only have expressed
   this by rounding it down to a fortnight, which is why the control is a pair. */
sp = P.periodSpanOf('2026-06-22', '2026-07-19');
ok('a two-period program is recognized as a SPAN, not truncated',
   sp && sp.to === sp.from + 1);
ok('  …and that span reproduces the exact stored window',
   P.periodByIndex(sp.from).start === '2026-06-22' && P.periodByIndex(sp.to).end === '2026-07-19');

/* The three that are genuinely off the grid must report so, and be left alone. */
ok('a seven-day program is NOT claimed as a pay period',
   P.periodSpanOf('2025-08-11', '2025-08-17') === null);
ok('a calendar-month draft is NOT claimed as a pay period',
   P.periodSpanOf('2026-06-01', '2026-06-30') === null);
/* The half-open cases are the ones a looser check would wave through: the right start with the
   wrong end is exactly how a closed program's window gets extended by a fortnight. */
ok('starting on a boundary but ending off it is refused',
   P.periodSpanOf('2026-08-31', '2026-09-20') === null);
ok('ending on a boundary but starting off it is refused',
   P.periodSpanOf('2026-08-25', '2026-09-13') === null);
ok('a missing date is refused rather than guessed',
   P.periodSpanOf('', '2026-09-13') === null && P.periodSpanOf('2026-08-31', '') === null);

/* Every window currently in `programs` — the 21 that sit on the grid must stay recognized, or
   opening one of those records would show the off-grid warning and offer to "keep" dates that
   are perfectly fine. */
const LIVE_ON_GRID = [
  ['2026-07-20', '2026-08-02'], ['2026-02-02', '2026-02-15'], ['2025-09-15', '2025-09-28'],
  ['2026-02-16', '2026-03-01'], ['2026-03-16', '2026-03-29'], ['2026-03-02', '2026-03-15'],
  ['2025-11-24', '2025-12-07'], ['2026-04-13', '2026-04-26'], ['2025-10-13', '2025-10-26'],
  ['2026-01-05', '2026-01-18'], ['2025-09-01', '2025-09-14'], ['2025-10-27', '2025-11-09'],
  ['2026-01-19', '2026-02-01'], ['2025-11-10', '2025-11-23'], ['2025-08-18', '2025-08-31'],
  ['2026-03-30', '2026-04-12'], ['2025-09-29', '2025-10-12'], ['2025-12-08', '2025-12-21'],
  ['2026-08-03', '2026-08-16'], ['2026-06-08', '2026-06-21'], ['2026-08-31', '2026-09-13'],
];
ok('all 21 live on-grid windows are still recognized',
   LIVE_ON_GRID.every(([a, b]) => P.periodSpanOf(a, b) !== null));

/* ══════════════════ 2. THE PER-BUDTENDER GOAL ══════════════════ */
const calcModel = new Function('calc', grab('calcModel') + '; return calcModel;');
const model = (stores, target) =>
  calcModel({ cost: 10, spiff: 25, target, model: 'flat', stores })();

const STORES = () => [
  { store_id: 'commercial', name: 'Commercial', baseline: 100, bts: 5, perBtSet: null },
  { store_id: 'river-rd',   name: 'River Rd',   baseline: 100, bts: 5, perBtSet: null },
];

let m = model(STORES(), 200);
ok('with nothing pinned, both stores split the ask as before',
   m.plan[0].perBt === 20 && m.plan[1].perBt === 20 && m.goalUnits === 200);
ok('  …and neither reads as pinned', m.plan.every(r => !r.pinned));

/* Sky's example: tune Commercial down, tune the other up. */
let s = STORES(); s[0].perBtSet = 12; s[1].perBtSet = 28;
m = model(s, 200);
ok('a pinned store is told the number that was typed, not its share',
   m.plan[0].perBt === 12 && m.plan[1].perBt === 28);
ok('  …and says so, so the table does not read as eight identical boxes',
   m.plan[0].pinned && m.plan[1].pinned);
ok('the store goal follows the pin', m.plan[0].goal === 60 && m.plan[1].goal === 140);
ok('and the chain ask is still the sum of the stores', m.goalUnits === 200);

/* THE ONE THAT MATTERS: a pin must not become a goal of zero. Clearing the box sets null, and
   null has to mean "go back to the split" — `Number('') || 0` would mean "sell nothing", and the
   chain total would absorb it silently. */
s = STORES(); s[0].perBtSet = null;
ok('an EMPTY pin falls back to the split, it is not a goal of zero',
   model(s, 200).plan[0].perBt === 20);
s = STORES(); s[0].perBtSet = '';
ok('  …and neither is a blank string', model(s, 200).plan[0].perBt === 20);
/* A deliberate zero IS honored — a store sitting a program out is a real thing to say. */
s = STORES(); s[0].perBtSet = 0;
ok('but a typed ZERO is honored, because sitting a store out is a real choice',
   model(s, 200).plan[0].perBt === 0 && model(s, 200).plan[0].goal === 0);
ok('  …and the chain ask drops by exactly that store', model(s, 200).goalUnits === 100);

/* Moving the target must still move the stores that are NOT pinned — that is the whole reason a
   pin is per store rather than a mode the whole table switches into. */
s = STORES(); s[0].perBtSet = 12;
const a = model(s, 200), b = model(s, 400);
ok('raising the target leaves a pinned store where it was',
   a.plan[0].perBt === 12 && b.plan[0].perBt === 12);
ok('  …while the unpinned store follows it', a.plan[1].perBt === 20 && b.plan[1].perBt === 40);

/* Everything downstream prices the reconciled goal, so a pin has to reach the money too. */
s = STORES(); s[0].perBtSet = 12; s[1].perBtSet = 28;
m = model(s, 999);                                   // typed target deliberately ignored by pins
ok('a fully pinned table ignores the typed target entirely', m.goalUnits === 200);
ok('and the revenue argued to the vendor prices the pinned goal', m.targetRev === 2000);

console.log(fail ? '\n' + fail + ' FAILED' : '\nwindow + goal: all passed');
process.exit(fail ? 1 : 0);
