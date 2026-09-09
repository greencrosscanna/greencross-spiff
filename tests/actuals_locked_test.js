#!/usr/bin/env node
/* ─── The money fields are measured, not typed ────────────────────────────────────────────────────
 *
 *   RUN:  node tests/actuals_locked_test.js
 *
 * Sky, 2026-09-08: "remove actuals from edit mode."
 *
 * WHAT WAS WRONG
 * Units sold, budtenders who hit, rate paid, investment and both ROI figures sat on every record
 * as six open number boxes — on a CLOSED program too, whose figures had already gone to the vendor
 * on a report and been paid out to staff. The model above locks itself on a closed program for
 * precisely that reason (applyCalcLock); the actuals, which ARE the money, did not. Portland
 * Heights showed 242 units and $181.50 in fields anybody could land in and retype.
 *
 * WHY THEY ARE LOCKED RATHER THAN REMOVED
 * Hand entry is real and in use. `green-cross-2025-08-11-2025-08-17` is a program Sky confirmed
 * that the Calculator never held, so it has goals and NO actuals and is the one row meant to be
 * filled in by hand; and the records whose actuals were copied from a duplicated tab are being
 * corrected by hand as well. Deleting the inputs would have deleted work in progress. So the
 * DEFAULT changed, not the capability.
 *
 * THE TWO THINGS A CARELESS VERSION OF THIS BREAKS, which is what this file is for:
 *
 *   1. THE MEASURED FIGURES MUST STILL SAVE. "Pull live from Dutchie" writes through
 *      setRecField, and collectPatch reads the form back by [data-key]. A readonly <input> does
 *      both — it refuses the keyboard, not the app. Swapping in a <span> or dropping the
 *      data-key would leave the pull looking like it worked and saving nothing, which is the
 *      exact silent-success failure editable_fields_test.js exists for.
 *
 *   2. THE UNLOCK MUST NOT OUTLIVE THE RECORD. Held as a boolean it would survive switching
 *      programs, so unlocking one record and opening the next hands you six live money fields
 *      you never asked to open. It is held as a program id.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js  = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const css = fs.readFileSync(__dirname + '/../spiff.css', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. LOCKED BY DEFAULT, AND ACTUALLY RUN ══════════════════ */
const actField = new Function('esc', 'canEdit', grab('actField') + '\nreturn actField;')(
  s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
  () => true
);

const locked = actField('Units sold', 'actual_json.units_sold', 242, false);
const open   = actField('Units sold', 'actual_json.units_sold', 242, true);

ok('a locked actuals field refuses the keyboard', /\breadonly\b/.test(locked));
ok('  …and is out of the tab order, so you cannot land in one by accident',
   /tabindex="-1"/.test(locked));
ok('  …and says why, rather than just swallowing the keystroke',
   /title="Measured, not typed/.test(locked));
ok('an unlocked one takes typing', !/\breadonly\b/.test(open));

/* ── the part a careless version breaks ── */
ok('LOCKED IS STILL AN <input> — the app can write it even when the user cannot',
   /^<label/.test(locked) && /<input /.test(locked));
ok('  …carrying its data-key, so collectPatch still reads it back',
   /data-key="actual_json\.units_sold"/.test(locked));
ok('  …and its measured value, so a pull is not lost on save',
   /value="242"/.test(locked));
ok('  …and it is a number input either way, so collectPatch coerces it the same',
   /type="number"/.test(locked) && /type="number"/.test(open));
/* A locked field must not read as a broken one. */
ok('locked fields are styled as unavailable, not merely inert',
   /\.sp-act\.is-locked input \{[^}]*cursor: default/.test(css)
   && /\.sp-act\.is-locked \{[^}]*dashed/.test(css));

/* ══════════════════ 2. THE UNLOCK IS SCOPED TO ONE RECORD ══════════════════ */
ok('the unlock is held as a program id, never a bare boolean',
   /actualsOpenFor: null/.test(js) && !/actualsUnlocked:\s*(true|false)/.test(js));
const render = grab('renderRecord');
ok('  …and is compared against THIS record on every paint',
   /calc\.actualsOpenFor === p\.program_id/.test(render));
ok('  …so switching programs re-locks with nothing to remember to reset',
   /var actualsOpen = canEdit\(\) && calc\.actualsOpenFor === p\.program_id/.test(render));
ok('a viewer never gets the unlock at all', /actualsOpen = canEdit\(\) &&/.test(render));
ok('  …nor the button offering it', /canEdit\(\) && !actualsOpen/.test(render));
ok('the unlock is spent once the correction saves',
   /calc\.actualsOpenFor = null;/.test(grab('saveEverything')));

/* ══════════════════ 3. THE SANCTIONED PATH IS UNTOUCHED ══════════════════ */
/* Measuring is the way these are meant to be filled, so it must not need the unlock. */
ok('Pull live from Dutchie is offered whether or not the fields are unlocked',
   /id="rPullActuals"/.test(render)
   && render.indexOf('rPullActuals') > render.indexOf('actualsOpen'));
const pull = grab('pullActuals');
ok('  …and still writes all six figures through setRecField',
   ['units_sold','bts_hit','spiff_amount','investment','roi','roi_pct']
     .every(k => pull.indexOf("setRecField('actual_json." + k + "'") >= 0));
/* IT MUST NAME THE BUTTON THAT EXISTS. This asserted the literal 'Save changes' for a year, and
   the button has never said that in either state — it is 'Save as program' on a new program and
   'Update this program' on an existing one. Sky hit it on Drops, 2026-09-09: a correct pull sat on
   screen telling him to press a control that is not on the page. So the note now names the button
   through the same helper that LABELS the button, and the test pins that they share it rather than
   pinning a string that can drift out from under the UI again. */
ok('  …and still says nothing is saved until the save button is pressed',
   /nothing saved until you press ' \+ saveBtnLabel\(\)/.test(pull));
const lbl = grab('saveBtnLabel');
ok('  …naming it from the one helper that also labels the button',
   /calc\.editingId \? 'Update this program' : 'Save as program'/.test(lbl)
   && /btn\.textContent = saveBtnLabel\(\)/.test(js));
ok('  …so no caller hardcodes a label beside it',
   js.indexOf("'Save changes'") < 0);

/* ══════════════════ 4. A CLOSED PROGRAM ASKS FIRST ══════════════════ */
ok('unlocking a CLOSED program confirms, naming what those figures are',
   /closed && !confirm\(/.test(render)
   && /figures the vendor was \'\s*\+\s*\'sent and the budtenders were paid against/.test(render.replace(/\n\s*\+\s*/g, ' + ')));
ok('  …and points at the measured alternative instead of typing',
   /Pull live from Dutchie re-measures them instead/.test(render));
/* A draft or running program has been reported to nobody — a dialog there teaches people to
   dismiss dialogs. */
ok('a draft or running program unlocks without a dialog',
   /var closed = String\(p\.status \|\| ''\)\.toLowerCase\(\) === 'closed'/.test(render));

console.log(fail ? '\n' + fail + ' FAILED' : '\nactuals locked: all passed');
process.exit(fail ? 1 : 0);
