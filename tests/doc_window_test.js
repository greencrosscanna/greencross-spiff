#!/usr/bin/env node
/* ─── Reading a program window out of a hand-typed date range ───────────────────────────────────
 *
 *   RUN:  node tests/doc_window_test.js
 *
 * WHY
 * Tawny's SPIF docs are the source of truth for two things the Calculator never recorded: the exact
 * program window, and the real per-budtender goal. The window comes out of the FILENAME, typed by
 * hand 113 times. Three carry a slip, and the old parser — which demanded a literal '.' between
 * every part of a date — dropped all three:
 *
 *   3.16.26-3.29-26     River  Hellavated Cart & Dispo
 *   3.16.26-3.29-.26    South  Hellavated Cart & Dispo
 *   8.31.26-9.1326      the CURRENT Mule Extracts program
 *
 * The cost was not "three files". Two of them were the River and Commercial halves of ONE live
 * program, so hellavated-2026-03-16 imported with four of six stores and looked complete — no
 * error, just two stores that never had a goal. The third is the program starting tomorrow.
 *
 * The two failure modes are genuinely different and only one is recoverable from the filename:
 *   a WRONG separator (3.29-26) is unambiguous — a date is three numbers, so it can be read.
 *   a MISSING one (9.1326) is not: 9.1326 could be the 13th or the 1st. That is rescued from the
 *   document body, which states the period itself. Never guessed.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name, kind) {
  const re = kind === 'var'
    ? new RegExp('\\nvar ' + name + '\\s*=[^;]+;')
    : new RegExp('\\n\\s*function ' + name + '\\s*\\(');
  const i = gs.search(re);
  if (i < 0) throw new Error('missing ' + name);
  if (kind === 'var') return gs.slice(i, gs.indexOf(';', i) + 1);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}

/* Real stores, shaped as GX Core returns them. matchStore_ and norm_ come from the source too, so
   the "South" -> commercial aliasing is the app's own, not a restatement of it here. */
const STORES = [
  { store_id: 'bend',        display_name: 'Bend',        dutchie_name: 'Bend',        short_code: 'BEND' },
  { store_id: 'center',      display_name: 'Center',      dutchie_name: 'Center',      short_code: 'CTR'  },
  { store_id: 'commercial',  display_name: 'Commercial',  dutchie_name: 'Commercial',  short_code: 'COMM' },
  { store_id: 'hillsboro',   display_name: 'Hillsboro',   dutchie_name: 'Hillsboro',   short_code: 'HILL' },
  { store_id: 'portland-rd', display_name: 'Portland Rd', dutchie_name: 'Portland Rd', short_code: 'PDX'  },
  { store_id: 'river-rd',    display_name: 'River Rd',    dutchie_name: 'River Rd',    short_code: 'RIV'  },
];

const src = [
  grab('pad2_'), grab('norm_'), grab('matchStore_'), grab('afterLabel_'),
  grab('DOC_DATE_', 'var'), grab('DOC_RANGE_', 'var'),
  grab('ymdParts_'), grab('dateRange_'), grab('splitStoreHead_'),
  grab('docBaseName_'), grab('parseDocName_'), grab('parseDocFallback_'),
].join('\n');
const api = new Function(`${src}; return { parseDocName_, parseDocFallback_, dateRange_ };`)();
const name = (n) => api.parseDocName_(n, STORES);

/* ── the ordinary filenames, which must not change ── */
let d = name('Bend - Kaprikorn Spiff - 4.13.26-4.26.26.docx');
ok('a clean per-store filename still parses', d && d.start === '2026-04-13' && d.end === '2026-04-26');
ok('...and splits off the store', d && d.store === 'bend');
ok('...leaving the program title', d && d.program === 'Kaprikorn Spiff');

d = name('Copy of South - Meraki Gardens Vibes 40pks - 12.8.25 - 12.21.25.docx');
ok('"Copy of" is stripped', d && d.program === 'Meraki Gardens Vibes 40pks');
ok('...spaces around the range are fine', d && d.start === '2025-12-08' && d.end === '2025-12-21');
ok('..."South" resolves to the Commercial store', d && d.store === 'commercial');

d = name('BeGOAT Energy Drink Spiff - 7.20.26-8.3.26.docx');
ok('an all-locations filename has no store', d && d.store === '');
ok('...and keeps its whole title', d && d.program === 'BeGOAT Energy Drink Spiff');

/* ── the three real typos ── */
d = name('River - Hellavated Cart & Dispo Spiff - 3.16.26-3.29-.26.docx');
ok('a "-." where a "." belongs still reads', d && d.start === '2026-03-16' && d.end === '2026-03-29');
ok('...and keeps the River store', d && d.store === 'river-rd');

d = name('South - Hellavated Cart & Dispo Spiff - 3.16.26-3.29-26.docx');
ok('a "-" where a "." belongs still reads', d && d.start === '2026-03-16' && d.end === '2026-03-29');
ok('...and keeps the Commercial store', d && d.store === 'commercial');

/* A MISSING separator is not recoverable from the filename, and must NOT be guessed. */
ok('a missing separator fails the filename', name('Mule Extracts 2g Dank Tank Spiff - 8.31.26-9.1326.docx') === null);

/* ── the body rescues it, because the body states the period correctly ── */
const MULE_BODY = 'Green Cross Cannabis Emporium\nBi-Weekly SPIF Program\n' +
  'SPIF Period: 8.31.26-9.13.26 Location: All Locations\nVendor Name: Mule Extracts\n';
d = api.parseDocFallback_('Mule Extracts 2g Dank Tank Spiff - 8.31.26-9.1326.docx', MULE_BODY, STORES);
ok('the body supplies the window the filename lost', d && d.start === '2026-08-31' && d.end === '2026-09-13');
ok('...the trailing date blob is stripped from the title', d && d.program === 'Mule Extracts 2g Dank Tank Spiff');
ok('..."All Locations" leaves the store blank', d && d.store === '');

/* The body is a LAST RESORT, not a better source — the River doc's body carries the same typo. */
const RIVER_BODY = 'SPIF Period: 3.16.26-3.29-26 Location: River\n';
d = api.parseDocFallback_('River - Hellavated Cart & Dispo Spiff - 3.16.26-3.29-.26.docx', RIVER_BODY, STORES);
ok('a per-store body names its own location', d && d.store === 'river-rd');

/* ── the shape stays strict ── */
ok('a filename with no range at all is null', name('Some Spiff With No Dates.docx') === null);
ok('an impossible month is rejected', name('X - 13.5.26-14.6.26.docx') === null);
ok('an impossible day is rejected', name('X - 1.45.26-2.3.26.docx') === null);
ok('a single date is not a range', name('X - 4.13.26.docx') === null);
ok('a number in the title is not mistaken for a window',
   (() => { const r = name('Mule Extracts 2g Dank Tank Spiff - 8.31.26-9.13.26.docx');
            return r && r.program === 'Mule Extracts 2g Dank Tank Spiff'; })());
ok('an unanchored range mid-filename does not count',
   name('4.13.26-4.26.26 leftovers.docx') === null);

console.log(fail ? `\ndoc window: ${fail} FAILED` : '\ndoc window: all passed');
process.exit(fail ? 1 : 0);
