#!/usr/bin/env node
/* ─── One record editor, two places it can live ───────────────────────────────────────────────────
 *
 *   RUN:  node tests/record_mount_test.js
 *
 * WHY
 * Step 3 puts the record fields — status, the pay-period window, contact, actuals, the vendor link
 * — on the Calculator screen, without deleting the modal that still holds them. That is two hosts
 * for one form, and there are exactly two ways to build it:
 *
 *   Two renderers. This screen has already paid for that once: the record panel used to carry its
 *   own flatter copy of the plan, and "two editors for one set of numbers means two answers to
 *   what this program is, and the weaker one wins whenever it is the one somebody opens."
 *
 *   One renderer, two hosts. Which is what this is — and its own failure mode is DUPLICATE IDS.
 *   The form creates ids (#rPPFrom, #rActuals, #btnShare) and the collector reads them back by id,
 *   so two live copies means the collector reads one form while the user types into the other. A
 *   hidden copy is just as dangerous as a visible one: it still answers a document-wide lookup.
 *
 * So the rule this file exists to hold: exactly one host is mounted, and the unmounted one is
 * EMPTIED, not hidden.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── the two hosts exist and are distinct ── */
const MODAL  = new Function('return ' + (js.match(/var REC_MODAL\s*=\s*(\{[\s\S]*?\});/) || [])[1])();
const INLINE = new Function('return ' + (js.match(/var REC_INLINE\s*=\s*(\{[\s\S]*?\});/) || [])[1])();

['body', 'msg', 'save', 'signIn'].forEach(k => {
  ok('the two hosts have different ' + k, MODAL[k] !== INLINE[k]);
  ok('  modal ' + k + ' exists in the page', html.indexOf('id="' + MODAL[k].slice(1) + '"') >= 0);
  ok('  inline ' + k + ' exists in the page', html.indexOf('id="' + INLINE[k].slice(1) + '"') >= 0);
});
ok('only the inline one is flagged inline', INLINE.inline === true && MODAL.inline === false);

/* ── ONE renderer, not two ── */
ok('there is exactly one renderRecord', (js.match(/function renderRecord\s*\(/g) || []).length === 1);
ok('and exactly one collectPatch', (js.match(/function collectPatch\s*\(/g) || []).length === 1);
ok('and exactly one saveRecord', (js.match(/async function saveRecord\s*\(/g) || []).length === 1);

/* ── the form is read through the MOUNTED host, never a hardcoded one ── */
const readers = ['collectPatch', 'saveRecord', 'pullActuals', 'renderRecord'];
readers.forEach(fn => {
  const src = grab(fn);
  ok(fn + ' reads the mounted host, not #recordBody',
     !/\$\$?\('#recordBody/.test(src));
});
/* renderSignIn is the exception and must STAY modal — it paints the modal's own title and
   backdrop, which the Calculator has no equivalent of. */
const signIn = grab('renderSignIn');
ok('renderSignIn deliberately stays on the modal', /\$\('#recordBody'\)/.test(signIn));

/* ── EXACTLY ONE MOUNT ── */
const sync = grab('syncRecordMount');
ok('the unmounted host is EMPTIED, not merely hidden', /body\.innerHTML = ''/.test(sync));
ok('  …and hidden as well, so it takes no space', /wrap\.hidden = true/.test(sync));
ok('the modal being open always wins the mount', /modalIsOpen\(\)/.test(sync));
ok('nothing mounts inline unless a real program is being edited',
   /calc\.editingId/.test(sync) && /state\.programs/.test(sync));
ok('and the context falls back to the modal when the inline one goes away',
   /recCtx = REC_MODAL/.test(sync));

const open = grab('openRecord');
ok('opening the modal clears the inline copy BEFORE rendering',
   open.indexOf("inlineBody.innerHTML = ''") >= 0 &&
   open.indexOf("inlineBody.innerHTML = ''") < open.indexOf('renderRecord(p)'));
ok('  …and claims the context', /recCtx = REC_MODAL/.test(open));

const close = grab('closeRecord');
ok('closing the modal hands the mount back', /syncRecordMount\(\)/.test(close));

/* ── the inline mount does not restate the model sitting above it ── */
const render = grab('renderRecord');
ok('the read-only plan block is dropped inline, where the live model is right above it',
   /recCtx\.inline \? '' :/.test(render));
ok('  …which also removes the "Edit parameters" hop from the screen it hops to',
   render.indexOf('rEditParams') > render.indexOf("recCtx.inline ? '' :"));

/* ── NO TWO INPUTS FOR ONE COLUMN ──
   The Calculator has its own Program name and Vendor boxes. Both halves of the screen save
   `program_name` and `vendor`, so a second pair inside the inline record form would mean two
   inputs for one column on one screen — and whichever one the user did NOT touch would quietly
   overwrite the one they did, depending on which Save they pressed. */
ok('the inline form does not restate Program name',
   /recCtx\.inline \? '' :\s*\n\s*recField\('Program name'/.test(render));
ok('  …nor the vendor picker', render.indexOf('rVendor') > render.indexOf("recCtx.inline ? '' :"));
ok('  …but Status IS still there, because the Calculator has no view of it',
   /selField\('Status'/.test(render) &&
   render.indexOf("selField('Status'") > render.indexOf('rVendorMenu'));
ok('and the vendor autocomplete is only mounted where its input exists',
   /recPicker = recCtx\.inline \? null : mountPicker/.test(render));

/* ── saving ── */
const save = grab('saveRecord');
ok('an inline save re-renders instead of closing a modal that is not there',
   /if \(recCtx\.inline\) setTimeout\(syncRecordMount, 550\)/.test(save));
ok('  …and the modal still closes', /else\s+setTimeout\(closeRecord, 550\)/.test(save));

/* Both Save buttons must be wired at startup. Routing this through recCtx would wire only the
   modal, because that is what recCtx is at wiring time — and the inline button would be dead. */
ok('both hosts’ buttons are wired by literal id, not through the live context',
   /\[REC_MODAL, REC_INLINE\]\.forEach/.test(js));

console.log(fail ? '\n' + fail + ' FAILED' : '\nrecord mount: all passed');
process.exit(fail ? 1 : 0);
