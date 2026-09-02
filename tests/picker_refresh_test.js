#!/usr/bin/env node
/* ─── A rename has to reach the dropdowns ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/picker_refresh_test.js
 *
 * WHY
 * Sky, 2026-09-01: "in progress mode, it's not picking up the changes made to the program name."
 * The record had saved correctly and the engine was returning the new name. Four <select>
 * elements were simply never rebuilt: they were filled once at boot and never again, so a rename
 * left the OLD name in the Progress dropdown, the Reports dropdown, the History vendor filter and
 * the Calculator's "model from a past program" list.
 *
 * The lists that DID update were the ones that re-render from state on every paint. The dropdowns
 * are the exception, which is exactly why they are the ones that got missed — so they are filled
 * by one function now, and a fifth list added here cannot become the one somebody forgets.
 *
 * THE SECOND HALF MATTERS AS MUCH. This now runs after every save, and rebuilding a <select>
 * drops its selection — so saving while looking at one program's grid would silently swing
 * Progress onto whichever program is running. A refill must not move you.
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

/* ── one function fills them all ── */
const all = grab('fillProgramPickers');
['fillCalcLoad', 'fillReportPicker', 'fillHistoryFilters', 'fillProgressPicker'].forEach(fn => {
  ok(fn + ' is refilled by the shared function', all.indexOf(fn + '()') >= 0);
});

/* ── and it runs after every save, not only at boot ── */
/* saveRecord is gone — ONE button saves both halves now (v1.354), so the refill lives there. */
ok('the save refills the pickers', /fillProgramPickers\(\)/.test(grab('saveEverything')));
ok('the Calculator save refills them too',
   /fillProgramPickers\(\)/.test(grab('saveCalcProgram')));
/* Boot must go through the same call, or boot and save drift into two lists of lists. */
/* Boot must call the shared function, not keep its own hand-written list of the four — that is
   how boot and save drift into refreshing different sets. The four names appear together exactly
   ONCE in the file, inside fillProgramPickers itself. */
ok('boot uses the same function rather than its own copy of the list',
   /loadPrograms\(\)\.then\(function \(\) \{\s*fillProgramPickers\(\);\s*\}\)/.test(js));
ok('  …and the four are only ever listed together in that one place',
   (js.match(/fillCalcLoad\(\); fillReportPicker\(\)/g) || []).length === 1 &&
   grab('fillProgramPickers').indexOf('fillCalcLoad(); fillReportPicker()') >= 0);
/* The old bug in one line: the Calculator save used to refresh ONLY its own dropdown. */
ok('the Calculator save no longer refreshes only its own list',
   !/renderPrograms\(\);\s*\n\s*fillCalcLoad\(\);/.test(js));

/* ── a refill must not move you ── */
const pg = grab('fillProgressPicker');
ok('Progress remembers what was selected before the refill', /var was = sel\.value/.test(pg));
ok('  …and restores it when that program still exists',
   /list\.some\(function \(p\) \{ return p\.program_id === was; \}\)/.test(pg));
ok('  …and only falls back to the running program otherwise',
   pg.indexOf('sel.value = was') < pg.indexOf("status === 'active'"));

const rep = grab('fillReportPicker');
ok('Reports keeps its selection the same way', /var was = sel\.value/.test(rep));
ok('  …and restores it when the program is still listed',
   /closed\.some\(function \(p\) \{ return p\.program_id === was; \}\)/.test(rep));

/* ── the names themselves ── */
[['fillProgressPicker', pg], ['fillReportPicker', rep], ['fillCalcLoad', grab('fillCalcLoad')]].forEach(([n, src]) => {
  ok(n + ' shows the editable program_name, falling back to the fixed title',
     /program_name \|\| p\.title/.test(src));
});
/* Both program dropdowns carry the window, because vendors repeat: Meraki, Mule and Hellavated
   each ran more than once, and Portland Heights now twice. */
ok('Progress labels carry the date range', /prettyRangeY\(p\)/.test(pg));
ok('and so does Reports — the same names repeat there',  /prettyRangeY\(p\)/.test(rep));

console.log(fail ? '\n' + fail + ' FAILED' : '\npicker refresh: all passed');
process.exit(fail ? 1 : 0);
