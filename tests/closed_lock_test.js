#!/usr/bin/env node
/* ─── A closed program opens read-only ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/closed_lock_test.js
 *
 * WHY
 * A closed program has been measured, reported to the vendor and paid. Its model is history — but
 * the Calculator is a live thing: every keystroke re-derives the plan, and until v1.334 every save
 * wrote the whole model back whether or not anyone had touched it.
 *
 * That is the same shape this repo has already paid for twice. The save ran its own rounding,
 * separate from the table's, so a program could be sold at one per-budtender goal and settled at
 * another. Then the per-store headcount turned out never to have been stored, and was guessed back
 * from two already-rounded numbers — wrong for 20 of the 26 live programs, which meant simply
 * opening one and pressing Update rewrote its store goals. Both wrote plausible, wrong numbers into
 * settled records without erroring.
 *
 * v1.334 stopped saving what did not change. This is the wider fix: don't put a settled program's
 * goals behind live controls at all.
 *
 * IT IS A DOOR, NOT A WALL. A genuinely wrong closed record has to be fixable somewhere other than
 * the spreadsheet, so the lock opens — deliberately, behind a sentence that says what the program
 * is. What must never happen is the lock coming off by itself.
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

/* ── which state locks ── */
const open = grab('openInCalculator');
ok('opening a program from its record locks it when it is CLOSED',
   /calc\.locked = String\(merged\.status \|\| ''\)\.toLowerCase\(\) === 'closed'/.test(open));
ok('  …so draft and active stay editable, which is the whole point of the field',
   !/status[^\n]*!==[^\n]*'closed'/.test(open));
ok('and the lock is applied, not just recorded', /applyCalcLock\(\)/.test(open));

/* ── the two ways to arrive at a NEW model must never inherit a lock ── */
const nw = grab('newProgram');
ok('a brand-new model is never locked', /calc\.locked = false/.test(nw));
ok('  …and says so on screen', /applyCalcLock\(\)/.test(nw));

const load = grab('loadIntoCalc');
ok('modeling FROM a past program does not inherit its lock', /calc\.locked = false/.test(load));
/* The dangerous half: it must also drop editingId, or Save would point at the program being
   copied rather than the new one being sketched. */
ok('  …nor its editingId, which would aim Save at the program being copied',
   /calc\.editingId = null/.test(load));
ok('  …and it re-applies, so picking an open program after a closed one revives the controls',
   /applyCalcLock\(\)/.test(load));

/* ── THE ONE THAT MATTERS: the table is rebuilt constantly ── */
/* recalc() innerHTML-replaces the whole per-store table on every keystroke. Fresh inputs know
   nothing about the lock, so without a re-apply a closed program's rows come back alive the moment
   anything else on the screen repaints — which is the failure mode a reviewer would never see by
   clicking once. */
const recalc = grab('recalc');
ok('every repaint re-locks the per-store table', /if \(calc\.locked\) applyCalcLock\(\)/.test(recalc));

const apply = grab('applyCalcLock');
ok('the lock covers the table inputs, not only the deal fields',
   /#calcTable input/.test(apply));
ok('  …and the buttons in it, so a pinned goal cannot be cleared',
   /#calcTable input, #calcTable button/.test(apply));
ok('the payout model segment locks too', /#cModel button/.test(apply));
ok('and Save itself is disabled, with a reason', /save\.disabled = on/.test(apply)
   && /unlock it first/i.test(apply));
ok('the deal fields are covered by the shared list, not a second copy',
   /CALC_MODEL_CONTROLS\.forEach/.test(apply));

const CONTROLS = new Function('return ' +
  (js.match(/var CALC_MODEL_CONTROLS = (\[[\s\S]*?\]);/) || [])[1])();
['#cName', '#cVendor', '#cCost', '#cProduct', '#cSpiff', '#cTarget', '#cGrowth'].forEach(id => {
  ok('  ' + id + ' is in the locked set', CONTROLS.indexOf(id) >= 0);
});
/* The slider is the one people forget, because it is not a text box — and dragging it is the
   fastest way to change a target by accident. */
ok('  the growth slider is in it too', CONTROLS.indexOf('#cGoalRange') >= 0);
/* Every id in the list has to exist in the markup, or a rename silently unlocks a control. */
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
CONTROLS.forEach(sel => {
  ok('  ' + sel + ' actually exists in index.html', html.indexOf('id="' + sel.slice(1) + '"') >= 0);
});

/* ── the door ── */
const editing = grab('renderCalcEditing');
ok('a locked program offers an unlock', /calcUnlock/.test(editing));
ok('  …behind a confirm that names what the program is',
   /confirm\(/.test(editing) && /reported to the vendor/.test(editing));
ok('  …and unlocking re-applies rather than just setting a flag',
   /calc\.locked = false;\s*\n\s*renderCalcEditing\(\);\s*\n\s*applyCalcLock\(\)/.test(editing));
ok('stopping editing clears the lock as well as the id',
   /calc\.editingId = null; calc\.window = null; calc\.locked = false/.test(editing));
ok('the banner says CLOSED rather than "Editing" when locked', /Closed &middot; /.test(editing));

console.log(fail ? '\n' + fail + ' FAILED' : '\nclosed lock: all passed');
process.exit(fail ? 1 : 0);
