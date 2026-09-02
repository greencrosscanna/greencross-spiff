#!/usr/bin/env node
/* ─── The record lives on the Calculator, and nowhere else ────────────────────────────────────────
 *
 *   RUN:  node tests/record_mount_test.js
 *
 * WHY
 * A program used to be two screens: the Calculator modeled it, a modal held its identity, dates,
 * contact, actuals and vendor link, and a button hopped between them. v1.336 rendered the record
 * under the Calculator as well; v1.337 pointed every entry there; v1.338 deleted the modal.
 *
 * The failure this file exists to prevent is the one the move could quietly reintroduce: A SECOND
 * COPY OF THE FORM. The record is read back by id — the collector, the save and the actuals pull
 * all query it by selector — so two copies means the save reads one form while somebody types into
 * the other, and a HIDDEN copy is just as dangerous, because it still answers a lookup.
 *
 * This screen has already paid for the two-copies mistake once, in the other direction: the record
 * panel used to carry its own flatter version of the plan, and "two editors for one set of numbers
 * means two answers to what this program is, and the weaker one wins whenever it is the one
 * somebody happens to open."
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const css  = fs.readFileSync(__dirname + '/../spiff.css', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── THE MODAL IS GONE, ALL OF IT ── */
['recordBack', 'recordBody', 'recordSave', 'recordSignIn', 'recordMsg',
 'recordTitle', 'recordSub', 'recordClose', 'recordCancel'].forEach(id => {
  ok('no #' + id + ' left in the markup', html.indexOf('id="' + id + '"') < 0);
  ok('  …and nothing in the code reaches for it', js.indexOf("'#" + id + "'") < 0);
});
['openRecord', 'closeRecord', 'renderSignIn', 'modalIsOpen', 'planCell'].forEach(fn => {
  ok(fn + ' is gone', js.indexOf('function ' + fn + '(') < 0 && js.indexOf(fn + '(') < 0);
});
ok('the two-host context is gone with it',
   js.indexOf('REC_MODAL') < 0 && js.indexOf('REC_INLINE') < 0 && js.indexOf('recCtx') < 0);
/* The record's vendor autocomplete only existed because the modal had no Calculator in sight. */
ok('the record’s second vendor picker is gone', js.indexOf('recPicker') < 0);
/* Matched as an id, not a substring — `renderVendors` contains the letters and is the
   Calculator's own picker, which is very much still here. */
ok('  …and so is its input',
   html.indexOf('id="rVendor"') < 0 && js.indexOf("'#rVendor'") < 0 && js.indexOf('rVendorMenu') < 0);
ok('the "Edit parameters →" hop is gone — it pointed at the screen it now lives on',
   js.indexOf('rEditParams') < 0);

/* ── ONE HOST ── */
const REC = new Function('return ' + (js.match(/var REC\s*=\s*(\{[\s\S]*?\});/) || [])[1])();
['body', 'msg', 'save', 'signIn'].forEach(k => {
  ok('REC.' + k + ' points at an element that exists',
     html.indexOf('id="' + REC[k].slice(1) + '"') >= 0);
});
ok('there is still exactly one renderRecord', (js.match(/function renderRecord\s*\(/g) || []).length === 1);
ok('and one collectPatch',  (js.match(/function collectPatch\s*\(/g) || []).length === 1);
ok('and one saveRecord',    (js.match(/async function saveRecord\s*\(/g) || []).length === 1);

const sync = grab('syncRecordMount');
ok('an unmounted record is EMPTIED, not merely hidden', /body\.innerHTML = ''/.test(sync));
ok('  …and hidden too, so it takes no space', /wrap\.hidden = true/.test(sync));
ok('nothing mounts unless a real program is being edited',
   /calc\.editingId/.test(sync) && /state\.programs/.test(sync));
ok('  …and state.record is cleared when nothing is', /state\.record = null/.test(sync));

/* ── the record does not restate the model sitting above it ── */
const render = grab('renderRecord');
ok('no Program name field — the Calculator owns it', render.indexOf("'program_name'") < 0);
ok('no vendor field either', render.indexOf('rVendorMenu') < 0);
ok('but Status IS here, because the Calculator has no view of it', /selField\('Status'/.test(render));
ok('and so is the pay-period window', /First pay period/.test(render));
ok('and the contact, the actuals and the vendor link',
   /contact_email/.test(render) && /rPullActuals/.test(render) && /btnShare/.test(render));

/* ── EVERY WAY IN LANDS ON THE CALCULATOR ── */
ok('openProgram is the single way in',
   (js.match(/function openProgram\s*\(/g) || []).length === 1);
ok('  …and it hands off to the Calculator', /openInCalculator\(p\)/.test(grab('openProgram')));
ok('all seven entry points call it', (js.match(/openProgram\(/g) || []).length === 8);

/* Unsaved edits are carried forward ONLY from a form showing the same program. Every list row
   lands here now, and the mounted form is usually the LAST program opened — collecting that would
   paste one program's contact email, actuals and dates onto another as edits nobody made. */
const openCalc = grab('openInCalculator');
ok('unsaved edits only carry from a form showing THE SAME program',
   /state\.record && state\.record\.program_id === p\.program_id/.test(openCalc));
ok('  …otherwise it starts from an empty patch',
   /showing \? collectPatch\(p\) : Object\.create\(null\)/.test(openCalc));

/* ── SIGN-IN: the one thing the overlay was still better at ── */
ok('the sign-in dialog exists in the markup', html.indexOf('id="signInBack"') >= 0);
ok('  …with static fields rather than a form painted by JS',
   html.indexOf('id="siUser"') >= 0 && html.indexOf('id="siPass"') >= 0 &&
   js.indexOf("id=\"siUser\"") < 0);
ok('  …and its own message line, separate from the record’s',
   html.indexOf('id="siMsg"') >= 0 && grab('doSignIn').indexOf("$('#siMsg')") >= 0);
ok('openSignIn / closeSignIn replace the modal pair',
   /function openSignIn\(/.test(js) && /function closeSignIn\(/.test(js));
ok('closing clears the password rather than leaving it in the DOM',
   /p\.value = ''/.test(grab('closeSignIn')));
ok('a successful sign-in closes the dialog and repaints the record',
   /closeSignIn\(\);\s*\n\s*syncRecordMount\(\);/.test(grab('doSignIn')));
ok('signing OUT re-renders the record read-only rather than dropping it',
   /clearSession\(\);[\s\S]{0,300}syncRecordMount\(\)/.test(js));
ok('a rejected write reopens the dialog', /needsAuth[^\n]*openSignIn\(\)/.test(js));
ok('the dialog is sized for a two-field form, not the record it replaced',
   /\.modal-sm\s*\{/.test(css) && html.indexOf('modal modal-sm') >= 0);

/* ── the record's styles moved with it ── */
ok('the record styles are rehomed, not left scoped to a modal body that no longer holds them',
   /#calcRecordBody \.sp-flds/.test(css) && css.indexOf('.modal-body .sp-flds') < 0);
ok('the read-only plan summary’s styles went with the block',
   css.indexOf('.sp-plan-c') < 0 && css.indexOf('.sp-plan-v') < 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nrecord mount: all passed');
process.exit(fail ? 1 : 0);
