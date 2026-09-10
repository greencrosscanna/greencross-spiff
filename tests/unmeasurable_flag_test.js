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
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\nfunction ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* The real snapshotFingerprint_, plus the two helpers under test, wired to a refusal map we
   control instead of PropertiesService. */
const src = grab('snapshotFingerprint_') + '\n' + grab('snapshotRefusalFor_') + '\n'
          + grab('annotateUnmeasurable_') + '\n'
          + 'return { annotate: annotateUnmeasurable_, refusalFor: snapshotRefusalFor_, fp: snapshotFingerprint_ };';

let REFUSALS = {};
const api = new Function('textDate_', 'slug_', 'snapshotRefusals_', src)(
  v => String(v == null ? '' : v).trim(),
  x => String(x || '').trim().toLowerCase(),
  () => REFUSALS);

const prog = () => ({
  program_id: 'kaprikorn-2025-11-24-2025-12-07',
  start_date: '2025-11-24', end_date: '2025-12-07',
  stores_json: ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'],
  match_json: { brand: 'Kaprikorn', category: 'Extracts', filter_text: '',
                products: ["Carts", "Aio’s and 2g Dabs"] },
});

/* ══════════════════ 1. UNTRIED IS NOT UNMEASURABLE ══════════════════ */
REFUSALS = {};
let list = [prog()];
api.annotate(list);
ok('a program the sweep has never tried is NOT flagged', list[0].unmeasurable === null);

/* ══════════════════ 2. A RECORDED REFUSAL IS SURFACED ══════════════════ */
const p = prog();
REFUSALS = { [p.program_id]: { fp: api.fp(p), at: '2026-09-10 03:00:00', reason: 'zero_vs_record' } };
list = [prog()];
api.annotate(list);
ok('a program refused for this exact filter IS flagged', !!list[0].unmeasurable);
ok('the flag carries the reason', list[0].unmeasurable.reason === 'zero_vs_record');
ok('the flag carries when it was learned', list[0].unmeasurable.since === '2026-09-10 03:00:00');

/* ══════════════════ 3. FIXING THE FILTER CLEARS IT, WITH NO HUMAN STEP ══════════════════ */
const fixed = prog();
fixed.match_json.category = 'Extract (Liquid)';       // a REAL Dutchie category
fixed.match_json.products = ['Disposable AIO | 1g'];  // a REAL product name — note the pipe
list = [fixed];
api.annotate(list);
ok('correcting the filter clears the flag on the next read', list[0].unmeasurable === null);

/* Window and stores are part of the fingerprint too — an edit to either earns a retry. */
const rewindowed = prog();
rewindowed.end_date = '2025-12-08';
list = [rewindowed];
api.annotate(list);
ok('changing the window clears the flag', list[0].unmeasurable === null);

const restored = prog();
restored.stores_json = ['bend'];
list = [restored];
api.annotate(list);
ok('changing the stores clears the flag', list[0].unmeasurable === null);

/* ══════════════════ 4. A REFUSAL FOR A DIFFERENT PROGRAM DOES NOT LEAK ══════════════════ */
REFUSALS = { 'some-other-program': { fp: api.fp(prog()), at: '2026-09-10', reason: 'zero_vs_record' } };
list = [prog()];
api.annotate(list);
ok('a refusal filed under another id does not flag this one', list[0].unmeasurable === null);

/* ══════════════════ 5. IT IS DERIVED — NOTHING WRITES IT ══════════════════
   programToRow_ builds its row from an explicit column list, so a top-level property cannot reach
   the sheet. Assert that rather than trusting it, because the failure would be silent: a stored
   flag keeps claiming "unmeasurable" after the filter is corrected, and nothing clears it. */
const row = grab('programToRow_');
ok('programToRow_ never writes the derived flag', !/unmeasurable/.test(row));
ok('PROGRAM_HEADERS has no column for it', !/unmeasurable/.test(gs.match(/PROGRAM_HEADERS\s*=\s*\[[^\]]*\]/s)[0]));

/* ══════════════════ 6. THE PANEL WITHHOLDS THE BUTTON ══════════════════ */
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const fn = js.slice(js.indexOf('function renderUnmeasured'));
const body = fn.slice(0, fn.indexOf('\n  }') + 4);
ok('renderUnmeasured reads the flag', /rec\.unmeasurable/.test(body));
ok('a known refusal suppresses the Measure button', /if \(v\.noWindow \|\| v\.noStores \|\| stuck \|\| !canEdit\(\)\)/.test(body));
ok('it no longer says "not measured yet" for a refused program',
   /stuck\s*\n?\s*\?\s*'cannot be measured/.test(body));

console.log(fail ? `\n✗ ${fail} failed` : '\n✓ unmeasurable flag: all passed');
process.exit(fail ? 1 : 0);
