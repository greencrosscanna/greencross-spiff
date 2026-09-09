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
/* THREE, not four, since 2026-09-08: Progress stopped being a tab, so its picker went with it —
   a section of a program does not have to ask which program it is about. The rule this file
   exists to protect is unchanged, and now has one fewer place to be forgotten. */
['fillCalcLoad', 'fillReportPicker', 'fillHistoryFilters'].forEach(fn => {
  ok(fn + ' is refilled by the shared function', all.indexOf(fn + '()') >= 0);
});
ok('the Progress picker is gone entirely, not merely unwired',
   !/function fillProgressPicker/.test(js) && !/#pgProgram/.test(js));

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
/* ── PROGRESS NO LONGER PICKS, SO IT CANNOT BE MOVED BY A REFILL ──────────────────────────────
   The bug this file was written for — a refill silently swinging Progress onto the running
   program — is now structurally impossible rather than guarded against: there is no selection to
   drop. It follows calc.editingId, which a refill does not touch. */
const lp = grab('loadProgress');
ok('the live grid follows the program on screen, not a picker',
   /var id = calc\.editingId/.test(lp) && !/#pgProgram/.test(lp));
ok('  …so a refill has no Progress selection left to lose',
   !/fillProgressPicker/.test(js));
ok('  …and a pull only starts when the open program is actually running',
   /running && \(!pgRun \|\| pgRun\.id !== v\.rec\.program_id\)/.test(grab('applyStatusView')));

const rep = grab('fillReportPicker');
ok('Reports keeps its selection the same way', /var was = sel\.value/.test(rep));
ok('  …and restores it when the program is still listed',
   /closed\.some\(function \(p\) \{ return p\.program_id === was; \}\)/.test(rep));

/* ── THE VENDOR LIST HAS TO ARRIVE, AND SAY SO WHILE IT IS ARRIVING ───────────────────────────
   Found 2026-09-08 while creating a program end-to-end in Chrome. Only `focus` loaded the brand
   catalog; `input` rendered from whatever pick.brands held at that instant and never looked again.
   A cold catalog build measures ~14s across six stores, and the first thing anybody does in a new
   program is click Vendor and type — so the first action in the app painted an empty menu reading
   "No vendor in stock matches that." and, when the brands landed, repainted nothing. The menu sat
   on that lie until you blurred the field and came back. The catalog route was answering 137
   brands in 2 seconds throughout.

   Three different facts had one message. An unloaded list is not an empty one. */
const src0 = js;
ok('typing loads the catalog, not only focusing the field',
   /vEl\.addEventListener\('input', async function/.test(js) && /await loadBrands\(\)/.test(js));
ok('  …and a load that lands repaints, instead of leaving the empty menu up',
   /if \(document\.activeElement === vEl \|\| !vMenu\.hidden\) renderVendors\(vEl\.value\)/.test(js));
ok('  …re-reading the box AFTER the await, so a late resolve paints the current query',
   /renderVendors\(vEl\.value\);\s*$/m.test(js));
ok('a list still loading says so rather than claiming nothing matched',
   /pick\.loading/.test(js) && /Loading the product list from Dutchie/.test(js));
ok('  …and the flag is cleared however the fetch ends',
   /pick\.loading = false;\s*\n\s*return pick\.brands;/.test(js));
ok('a real read error still wins over both', /pick\.catErr\s*\n?\s*\? esc\(pick\.catErr\)/.test(js));
/* A falsy reply used to fall through BOTH branches — `if (r && r.ok)` set no brands and
   `if (r && !r.ok)` set no error — leaving the picker holding nothing and saying nothing. That is
   what "no vendor in stock matches that" was actually reporting. */
ok('a falsy catalog reply is treated as a failure, not as an empty shop',
   /if \(!r\) throw new Error\('the product list came back empty'\)/.test(js));

/* ── the names themselves ── */
/* The name is joined with its vendor at read time now (2026-09-07, "[Vendor] - [Program Name]"),
   so the pickers name a program through programLabel rather than reaching for the columns
   themselves. The old rule is not gone — it moved INSIDE that one function, which is the point:
   ten call sites cannot disagree about what a program is called if only one of them decides. */
[['fillReportPicker', rep], ['fillCalcLoad', grab('fillCalcLoad')]].forEach(([n, src]) => {
  ok(n + ' names the program through the one shared label',
     /programLabel\(p\)/.test(src));
});
const label = grab('programLabel');
ok('programLabel still prefers the editable program_name over the fixed title',
   /program_name \|\| p\.title/.test(label));
ok('  …and joins the vendor in front of it',
   /vendor \+ ' - ' \+ name/.test(label));
ok('  …but never twice, so a seeded "Wyld 10pc" does not become "Wyld - Wyld 10pc"',
   /indexOf\(vendor\.toLowerCase\(\)\) === 0/.test(label));
ok('  …and it is DERIVED — nothing writes a joined label back into program_name',
   !/program_name\s*[:=]\s*[^,;\n]*programLabel/.test(js));
/* Both program dropdowns carry the window, because vendors repeat: Meraki, Mule and Hellavated
   each ran more than once, and Portland Heights now twice. */
ok('Reports labels carry the date range — the same names repeat there',
   /prettyRangeY\(p\)/.test(rep));

console.log(fail ? '\n' + fail + ' FAILED' : '\npicker refresh: all passed');
process.exit(fail ? 1 : 0);
