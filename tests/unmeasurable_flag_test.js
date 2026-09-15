#!/usr/bin/env node
/* ─── A program that can never measure must not be offered a Measure button ───────────────────────
 *
 *   RUN:  node tests/unmeasurable_flag_test.js
 *
 * WHAT THIS PROTECTS. Twelve closed programs carry prose Dutchie filters from the 2026-08-30 seed
 * — products like ["Carts", "Aio's and 2g Dabs"], a category of "Extracts" — and match nothing, so
 * every pull returns zero and the zero-vs-record guard correctly refuses to write it. Sky decided
 * on 2026-09-10 not to reverse-engineer them, which makes their state permanent. The record panel
 * was still telling Tawny "not measured YET" and offering "Measure now": a minute of Dutchie calls
 * across six stores, ending in a refusal, with nothing on screen explaining it.
 *
 * THE RULE, already stated in renderUnmeasured for the no-window and no-stores cases: an offer that
 * cannot work is worse than none.
 *
 * THE TWO WAYS THIS COULD GO WRONG, and both are what the assertions below are for:
 *
 *   1. SAYING IT TOO EARLY. A program the sweep has not reached yet is not known-unmeasurable — it
 *      is untried. Taking its button away on a guess would strand a perfectly good program.
 *   2. NOT CLEARING. The refusal is keyed on a fingerprint of the filter, so correcting the filter
 *      must clear the flag with no human step. A stored column could not do that, which is the same
 *      trap `duplicate_of` fell into in August — see the DERIVED note above annotateUnmeasurable_.
 *
 * These run the real functions out of Code.gs.
 *
 * REWRITTEN 2026-09-15 — the last two sections stopped reading source and started running it.
 *
 *   · "programToRow_ never writes the derived flag" was `!/unmeasurable/.test(source)`. That is a
 *     claim about a WORD, not about a row: it passes for a version that writes the flag's CONTENTS
 *     under any other name, and it passes for a version that writes a 27th cell into a 26-column
 *     sheet. programToRow_ now runs on a program the real annotator has just flagged, and the
 *     assertions read the row it returns, then read that row back through rowToProgram_ and
 *     re-annotate it — which is the actual rule: the sheet cannot remember the flag, so clearing
 *     the refusal clears the flag with no column to go and blank.
 *
 *   · The panel's button suppression was three regexes over spiff.js, one of which matched the
 *     exact text of an `if` condition — it would have failed on a correct change that reordered the
 *     same four tests, and passed on a broken one that painted the button anyway further down.
 *     renderUnmeasured now runs against a stub DOM and the assertions read what it put on screen.
 *     It is handed the SAME object annotateUnmeasurable_ produced above, so the two halves of the
 *     contract are checked against each other rather than both against a spelling.
 *
 *   Nothing here is source-shaped any more, so nothing is marked as deliberately left that way.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* The refusal memory is a ScriptProperties blob in production. Stubbed at that seam and nowhere
   else: the fingerprinting, the matching and the annotation are all the shipped code. */
let REFUSALS = {};

const PH = G.grabVar('PROGRAM_HEADERS');
const api = G.load({
  real: ['snapshotFingerprint_', 'snapshotRefusalFor_', 'annotateUnmeasurable_',
         'programToRow_', 'rowToProgram_',
         'textDate_', 'slug_', 'parseJson_', 'normalizePitch_', 'stripDerivedActuals_',
         'periodStartFor_'],
  vars: ['PROGRAM_HEADERS', 'DERIVED_ACTUALS', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
  stubs: {
    snapshotRefusals_: () => REFUSALS,
    /* The clock and the payroll grid — edges, both. A fixed anchor keeps the derived pay_period
       column deterministic without teaching this file anything about periods. */
    nowStamp_: () => '2026-09-15 09:00:00',
    payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }),
  },
});

const prog = () => ({
  program_id: 'kaprikorn-2025-11-24-2025-12-07',
  program_name: 'Kaprikorn', vendor: 'Kaprikorn', status: 'closed',
  start_date: '2025-11-24', end_date: '2025-12-07',
  stores_json: ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'],
  match_json: { brand: 'Kaprikorn', category: 'Extracts', filter_text: '',
                products: ["Carts", "Aio’s and 2g Dabs"] },
});

/* ══════════════════ 1. UNTRIED IS NOT UNMEASURABLE ══════════════════ */
REFUSALS = {};
let list = [prog()];
api.annotateUnmeasurable_(list);
ok('a program the sweep has never tried is NOT flagged', list[0].unmeasurable === null);

/* ══════════════════ 2. A RECORDED REFUSAL IS SURFACED ══════════════════ */
const p = prog();
REFUSALS = { [p.program_id]: { fp: api.snapshotFingerprint_(p), at: '2026-09-10 03:00:00',
                               reason: 'zero_vs_record' } };
list = [prog()];
api.annotateUnmeasurable_(list);
ok('a program refused for this exact filter IS flagged', !!list[0].unmeasurable);
ok('the flag carries the reason', list[0].unmeasurable.reason === 'zero_vs_record');
ok('the flag carries when it was learned', list[0].unmeasurable.since === '2026-09-10 03:00:00');

/* ══════════════════ 3. FIXING THE FILTER CLEARS IT, WITH NO HUMAN STEP ══════════════════ */
const fixed = prog();
fixed.match_json.category = 'Extract (Liquid)';       // a REAL Dutchie category
fixed.match_json.products = ['Disposable AIO | 1g'];  // a REAL product name — note the pipe
list = [fixed];
api.annotateUnmeasurable_(list);
ok('correcting the filter clears the flag on the next read', list[0].unmeasurable === null);

/* Window and stores are part of the fingerprint too — an edit to either earns a retry. */
const rewindowed = prog();
rewindowed.end_date = '2025-12-08';
list = [rewindowed];
api.annotateUnmeasurable_(list);
ok('changing the window clears the flag', list[0].unmeasurable === null);

const restored = prog();
restored.stores_json = ['bend'];
list = [restored];
api.annotateUnmeasurable_(list);
ok('changing the stores clears the flag', list[0].unmeasurable === null);

/* ══════════════════ 4. A REFUSAL FOR A DIFFERENT PROGRAM DOES NOT LEAK ══════════════════ */
REFUSALS = { 'some-other-program': { fp: api.snapshotFingerprint_(prog()), at: '2026-09-10',
                                     reason: 'zero_vs_record' } };
list = [prog()];
api.annotateUnmeasurable_(list);
ok('a refusal filed under another id does not flag this one', list[0].unmeasurable === null);

/* ══════════════════ 5. IT IS DERIVED — THE SHEET CANNOT REMEMBER IT ══════════════════
   Run the real writer on a program the real annotator has just flagged. That is the exact object a
   save hands to programToRow_ — the panel reads a flagged program, the user edits a field, and the
   whole record goes back. If any of it reached a cell, the flag would outlive its cause: the
   banner would keep saying "cannot be measured" after the filter was corrected, with nothing to
   clear it. That is `duplicate_of` in August, precisely. */
REFUSALS = { [p.program_id]: { fp: api.snapshotFingerprint_(p), at: '2026-09-10 03:00:00',
                               reason: 'zero_vs_record' } };
const flagged = prog();
api.annotateUnmeasurable_([flagged]);
ok('(the fixture really is flagged, or the rest of this section proves nothing)',
   !!flagged.unmeasurable && flagged.unmeasurable.reason === 'zero_vs_record');

const row = api.programToRow_(flagged, { edited_by: 'sky', edited_at: '2026-09-15' });
ok('the written row is exactly the columns the sheet has — no 27th cell slipped in',
   row.length === PH.length);
ok('PROGRAM_HEADERS has no column for the flag', PH.indexOf('unmeasurable') < 0);
/* By NAME and by CONTENTS: a flag smuggled into another column under another key is the same
   failure, and the word-only check would have missed it. */
ok('no cell of the row carries the flag, by name or by value',
   row.every(c => String(c == null ? '' : c).indexOf('unmeasurable') < 0)
   && row.every(c => String(c == null ? '' : c).indexOf('zero_vs_record') < 0));

const back = api.rowToProgram_(row);
ok('a row read back off the sheet carries no flag of its own', back.unmeasurable === undefined);
ok('  …and the round trip kept the filter, so the fingerprint still identifies the program',
   api.snapshotFingerprint_(back) === api.snapshotFingerprint_(prog()));
/* THE PAYOFF. The refusal is forgotten — the filter was corrected, or the memory aged out — and the
   flag goes with it on the very next read. A stored column would still be sitting there. */
REFUSALS = {};
api.annotateUnmeasurable_([back]);
ok('clearing the refusal clears the flag, with no column to go and blank',
   back.unmeasurable === null);
REFUSALS = { [p.program_id]: { fp: api.snapshotFingerprint_(back), at: '2026-09-11 03:00:00',
                               reason: 'zero_vs_record' } };
api.annotateUnmeasurable_([back]);
ok('  …and it comes back from the refusal memory alone, not from anything on the row',
   !!back.unmeasurable && back.unmeasurable.since === '2026-09-11 03:00:00');

/* ══════════════════ 6. THE PANEL WITHHOLDS THE BUTTON ══════════════════
   renderUnmeasured, RUN, against a stub DOM — it only ever sets textContent/innerHTML and hangs one
   listener, so it needs no browser. `esc` and `prettyDay` are the real ones; `$`, `canEdit` and
   `remeasure` are the edges.

   It is handed the object annotateUnmeasurable_ produced above rather than a hand-written one, so
   this checks the engine and the panel against EACH OTHER. A rename on either side fails here. */
const fs = require('fs');
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

function panel(rec, opts) {
  const o = opts || {};
  const el = () => ({ textContent: '', innerHTML: '' });
  const nodes = { '#resTitle': el(), '#resNote': el(), '#resStamp': el(), '#resGrid': el() };
  const wired = [];
  const $ = (sel) => {
    /* The button exists only once the stamp has been painted with it — resolving it out of what
       renderUnmeasured actually wrote is what makes "offered" mean rendered AND wired. */
    if (sel === '#resMeasure') {
      return /id="resMeasure"/.test(nodes['#resStamp'].innerHTML)
        ? { addEventListener: (k) => { wired.push(k); } } : null;
    }
    return nodes[sel] || null;
  };
  const src = [G.grab('esc', js), G.grab('prettyDay', js), G.grab('renderUnmeasured', js),
               'return renderUnmeasured;'].join('\n');
  const render = new Function('$', 'canEdit', 'remeasure', src)(
    $, () => o.canEdit !== false, () => {});
  render({ rec: rec, canMeasure: true,
           noWindow: !!o.noWindow, noStores: !!o.noStores });
  return { note: nodes['#resNote'].textContent, stamp: nodes['#resStamp'],
           title: nodes['#resTitle'].textContent, wired };
}

/* ── the honest "not yet": a program nobody has measured, and nothing says it cannot be ── */
REFUSALS = {};
const untried = prog();
api.annotateUnmeasurable_([untried]);
let v = panel(untried);
ok('an untried program is still told nothing has been pulled yet',
   /^not measured yet/.test(v.note));
ok('  …and IS offered the button', /Measure now/.test(v.stamp.innerHTML) && v.wired.length === 1);
ok('  …with the window it would measure over, so the offer says what it will do',
   /Nov 24/.test(v.stamp.innerHTML) && /Dec 7/.test(v.stamp.innerHTML));

/* ── the case this whole file exists for ── */
REFUSALS = { [p.program_id]: { fp: api.snapshotFingerprint_(p), at: '2026-09-10 03:00:00',
                               reason: 'zero_vs_record' } };
const stuck = prog();
api.annotateUnmeasurable_([stuck]);
v = panel(stuck);
ok('a known-refused program is told it cannot be measured, not that it is pending',
   /^cannot be measured/.test(v.note) && !/not measured yet/.test(v.note));
ok('  …and says what to do about it', /Correct the filter/.test(v.note));
ok('  …and is offered nothing: no button painted, no click wired',
   v.stamp.innerHTML === '' && v.stamp.textContent === '' && v.wired.length === 0);

/* ── the two cases the rule was already stated for, unchanged ── */
v = panel(untried, { noWindow: true });
ok('a program with no window keeps its own reason and its own silence',
   /^no window set/.test(v.note) && v.wired.length === 0);
v = panel(untried, { noStores: true });
ok('a program with no stores likewise',
   /^no stores on this program/.test(v.note) && v.wired.length === 0);

/* ── read-only is a different silence: the reason still shows, the control does not ── */
v = panel(untried, { canEdit: false });
ok('a viewer is told the state but offered no button',
   /^not measured yet/.test(v.note) && v.wired.length === 0);

console.log(fail ? `\n✗ ${fail} failed` : '\n✓ unmeasurable flag: all passed');
process.exit(fail ? 1 : 0);
