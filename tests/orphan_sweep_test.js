#!/usr/bin/env node
/* ─── Sweeping orphaned progress rows ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/orphan_sweep_test.js
 *
 * WHY
 * deleteProgram_ drops a program's cached rows as it goes, so nothing new strands. This sweeps the
 * debris that predates it — on 2026-09-06, 25 rows keyed to `begoat-0826` (the pre-seed key the
 * SPIF-doc seed replaced) plus one row with no program_id at all, together carrying $350 of
 * `earned` for a fortnight that was already paid.
 *
 * They are already excluded from `rows` and `by_employee`, so this is not a correctness fix. It
 * removes a trap: every consumer has to keep remembering to exclude them, and the day one forgets
 * is the day fourteen people show as owed $25 again.
 *
 * THE THREE THINGS THIS FILE EXISTS TO HOLD
 *  - Orphaned means the PROGRAM ROW IS GONE, not that a resolved status came back empty.
 *    spiffProgress_ filters on the latter, which also catches a program that exists with a blank
 *    status cell. Dropping such a row from a response is undone by fixing the cell; deleting it is
 *    not. The stricter question is the one a delete has to ask.
 *  - An unreadable `programs` tab makes every cached row look orphaned. spiffProgress_ refuses
 *    rather than reporting that nobody earned anything; here the same failure would DELETE the
 *    cache, so the guard matters more, not less.
 *  - Dry by default, and what goes is copied first. These rows are no longer authoritative about
 *    money — the payout they were computed from is gone from the system of record — but that is a
 *    reason not to serve them, not a reason to make them unrecoverable.
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
const sw = grab('sweepOrphanProgress_');

/* ── what counts as an orphan ── */
ok('orphaned is decided on the program_id being absent from `programs`',
   /live\[String\(pr\.program_id\)\] = 1/.test(sw) && /if \(live\[id\]\) continue;/.test(sw));
ok('  …NOT on a resolved status being empty, the way the read filter decides',
   !/statusOf/.test(sw) && !/\.status/.test(sw));
ok('a row with no program_id at all is swept — it can belong to nothing',
   /id \|\| '\(no program_id\)'/.test(sw));
ok('programs are read UNCACHED, the way getProgram_ reads before a write',
   /listPrograms_\(\)/.test(sw) && !/listProgramsCached_/.test(sw));

/* ── the guard that matters most here ── */
ok('an unreadable/empty programs tab REFUSES instead of sweeping everything',
   /if \(!known\.length\)/.test(sw) && /ok: false/.test(sw));
ok('  …and says it is a failure to read, not a cache full of orphans',
   /failure to read/.test(sw));

/* ── nothing goes without a copy, and nothing goes by accident ── */
ok('dry by default — apply=1 is required to write anything',
   /String\(p\.apply \|\| ''\) !== '1'/.test(sw));
ok('  …and the dry run still reports the full plan', /would_sweep/.test(sw) && /programs: summary/.test(sw));
ok('the plan totals rows and dollars per program, so the size is visible before the write',
   /plan\[k\]\.rows\+\+/.test(sw) && /plan\[k\]\.earned \+=/.test(sw));
ok('rows are copied to swept_progress_rows before deletion',
   sw.indexOf('keep.getRange') < sw.indexOf('sh.deleteRow'));
ok('  …stamped with when they were swept', /swept_at/.test(sw) && /nowStamp_\(\)/.test(sw));
ok('deletion walks bottom-up, because deleting a row shifts the ones after it',
   /for \(var j = doomed\.length - 1; j >= 0; j--\)/.test(sw));

/* ── who may call it ── */
ok('it is a secret-gated maintenance route',
   /SECRET_ACTIONS[\s\S]{0,200}'sweepOrphanProgress'/.test(gs));
ok('  …and re-checks the secret itself rather than trusting the router',
   /String\(p\.secret \|\| ''\) !== want/.test(sw));
ok('it is NOT public', !/PUBLIC_ACTIONS[^\n]*sweepOrphanProgress/.test(gs));
ok('routed on doGet', /case 'sweepOrphanProgress':/.test(gs));

console.log(fail ? '\norphan sweep: FAILED' : '\norphan sweep: OK');
process.exit(fail ? 1 : 0);
