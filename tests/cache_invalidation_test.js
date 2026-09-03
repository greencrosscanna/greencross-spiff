#!/usr/bin/env node
/* ─── Every writer to the programs sheet busts the programs cache ─────────────────────────────────
 *
 *   RUN:  node tests/cache_invalidation_test.js
 *
 * WHY
 * `listProgramsCached_` serves action=programs out of a 300-second script cache. Anything that
 * changes a program row and does NOT call invalidatePrograms_ is invisible to every screen in the
 * app for up to five minutes, and looks exactly like a write that failed.
 *
 * Found 2026-09-02, the hard way. Hellavated March was re-measured store by store, reported 650
 * units and $300 across six stores, and wrote them. The record still showed an empty grid. Two
 * reloads and a direct JSONP probe later it was STILL empty — so the next move would reasonably
 * have been to go looking for a bug in the measurement, or to re-run it, or to conclude the
 * snapshot route was broken. The data had been on the sheet the entire time.
 *
 * saveProgram_ and rollProgramStatuses_ both got this right. The two snapshot writers did not,
 * because they write ONE CELL directly instead of going through saveProgram_ — which is precisely
 * the shortcut that skips the invalidate.
 *
 * The overnight backfill is the case that matters. It writes ~89 (program, store) pairs across an
 * evening; without the bust, the screen you would use to watch it work is the one screen
 * guaranteed to be behind it.
 *
 * SO: this file names every function that writes to the programs sheet and insists each one busts
 * the cache. A new writer added later fails here rather than in six months, on a record somebody
 * is trying to reconcile against a vendor invoice.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* The cache exists and is short-lived — if either changes, the reasoning above needs re-reading
   rather than this file quietly still passing. */
const cached = grab('listProgramsCached_');
ok('the programs list is cached', /CacheService/.test(cached));
ok('  …for a bounded time, so a missed bust is a delay and not a permanent lie',
   /c\.put\(PROGRAMS_CACHE_KEY, body, \d+\)/.test(cached));

/* ── every writer, by name ── */
const WRITERS = [
  ['saveProgram_',         'the ordinary record save'],
  ['writeSnapshot_',       'one store measured into a frozen snapshot'],
  ['snapshotPending_',     'the overnight backfill sweep'],
  ['rollProgramStatuses_', 'the hourly draft→active→closed roll'],
];
WRITERS.forEach(([fn, what]) => {
  const body = grab(fn);
  /* A writer is anything that puts values back on the sheet. */
  ok(fn + ' writes to the sheet (' + what + ')', /\.setValues?\(/.test(body));
  ok('  …and busts the programs cache', /invalidatePrograms_\(\)/.test(body));
});

/* ── the backstop ──
   Named writers can be renamed. This catches a NEW one: any function containing a setValue on a
   row of the programs sheet must mention the invalidate somewhere inside it. The progress CACHE
   tab is a different sheet with its own lifecycle, so writers that only touch PROGRESS_HEADERS
   are out of scope. */
const fns = [...gs.matchAll(/\n\s*function ([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]);
const missed = fns.filter(name => {
  let body;
  try { body = grab(name); } catch (e) { return false; }
  if (!/\.setValues?\(/.test(body)) return false;
  if (/PROGRESS_HEADERS/.test(body)) return false;          // the progress cache tab, not programs
  if (/PROGRAM_HEADERS\]\)\.setFontWeight/.test(body)) return false;  // header row only
  if (!/PROGRAM_HEADERS|pCol|stCol/.test(body)) return false;
  return !/invalidatePrograms_\(\)/.test(body);
});
ok('no OTHER function writes a program row without busting the cache'
   + (missed.length ? ' — found: ' + missed.join(', ') : ''),
   missed.length === 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\ncache invalidation: all passed');
process.exit(fail ? 1 : 0);
