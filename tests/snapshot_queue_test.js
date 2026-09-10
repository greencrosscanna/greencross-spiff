#!/usr/bin/env node
/* ─── The sweep must not be held by work it can never do ──────────────────────────────────────────
 *
 *   RUN:  node tests/snapshot_queue_test.js
 *
 * WHAT HAPPENED. Between 2026-09-02 and 2026-09-09 the hourly sweep wrote not one snapshot. The
 * trigger was alive the whole time and publishing to Core correctly, so every health signal was
 * green and accurate: `hourlyTrigger: installed` was true, Core's freshness route read
 * `age_minutes: 6`, `state: ok`. Nine closed programs had never been measured at all.
 *
 * THE MECHANISM. snapshotPending_ budgeted a run with
 *
 *     if (done.length + failed.length >= max) continue;
 *
 * so a FAILURE cost the same budget as a success, and `max` is 1 in working hours. The
 * zero-vs-record guard refuses a program whose Dutchie filter matches nothing — correctly, and
 * that guard stays — but the refusal is DETERMINISTIC: the same program refuses identically the
 * next hour, forever. One unmeasurable program at the head of the queue ended every run before it
 * reached anything else.
 *
 * THE TWO HALVES OF THE FIX, and this file exists because each is useless alone:
 *   1. `max` counts what was WRITTEN; the clock bounds the run. A failure no longer buys a slot.
 *   2. A deterministic refusal is REMEMBERED against a fingerprint of what makes a program
 *      measurable at all — filter, window, stores. Edit any of them and it is retried, with nobody
 *      having to remember to clear a flag. A TRANSIENT failure (a store that would not answer) is
 *      NOT remembered; writing those off would turn one bad afternoon at Dutchie into a program
 *      that is never measured again.
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

/* ══════════════════ 1. THE FINGERPRINT ══════════════════ */
const fingerprint = new Function('textDate_', 'slug_', grab('snapshotFingerprint_') + '; return snapshotFingerprint_;')(
  v => String(v == null ? '' : v).trim(),
  x => String(x || '').trim().toLowerCase());

const base = () => ({
  program_id: 'p1', start_date: '2026-02-16', end_date: '2026-03-01',
  stores_json: ['bend', 'center'],
  match_json: { brand: 'Kaprikorn', category: 'Extracts', filter_text: '', products: ['Carts'] },
});
const fp0 = fingerprint(base());
ok('the same program fingerprints the same twice', fingerprint(base()) === fp0);

/* Every one of these changes whether the program can be measured, so every one must re-arm it. */
const moves = {
  'the brand':      p => { p.match_json.brand = 'Mule Extracts'; },
  'the category':   p => { p.match_json.category = ''; },
  'the filter text':p => { p.match_json.filter_text = 'Dank Tank'; },
  'the products':   p => { p.match_json.products = []; },
  'the start date': p => { p.start_date = '2026-02-17'; },
  'the end date':   p => { p.end_date = '2026-03-02'; },
  'the stores':     p => { p.stores_json = ['bend']; },
};
for (const [what, mutate] of Object.entries(moves)) {
  const p = base(); mutate(p);
  ok('changing ' + what + ' re-arms it', fingerprint(p) !== fp0);
}
/* Things that do NOT decide measurability must not churn the memory — a record edited for an
   unrelated reason should not buy another pointless Dutchie call every hour. */
const untouched = base();
untouched.vendor = 'Someone Else';
untouched.actual_json = { units_sold: 999 };
untouched.edited_by = 'sky';
ok('an unrelated edit does not re-arm it', fingerprint(untouched) === fp0);

/* Distinct filters must not collide onto one fingerprint — a separator bug would silently mark a
   fixed program as still-refused. */
const a = base(); a.match_json.products = ['Carts', 'Dabs'];
const b = base(); b.match_json.products = ['Carts|Dabs'];
ok('two different product lists do not share a fingerprint', fingerprint(a) !== fingerprint(b));

/* ══════════════════ 2. THE BUDGET, in the source of the sweep ══════════════════ */
const sweep = grab('snapshotPending_');
/* Checked as a STATEMENT, not as a phrase. The first cut searched the source for
   `done.length + failed.length >= max` and failed on the comment above the fix explaining what it
   USED to be — the same way a "no 0 units" grep failed on the comment saying why. The second cut
   stripped only lines beginning with / or *, and still failed: the phrase sits on a continuation
   line inside a block comment, which carries no marker of its own. Strip the blocks. */
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const stmts = strip(sweep);
ok('the comment explaining the old guard is still there to read',
   /done\.length \+ failed\.length >= max/.test(sweep));
ok('a failure no longer buys a slot the way a success does',
   !/done\.length \+ failed\.length >= max/.test(stmts));
ok('  …max now counts what was WRITTEN', /done\.length >= max/.test(sweep));
ok('  …and the clock bounds the run, because a trigger has six minutes',
   /Date\.now\(\) - t0 > BUDGET_MS/.test(sweep) && /var BUDGET_MS/.test(sweep));

/* ══════════════════ 3. WHAT IS REMEMBERED, AND WHAT IS NOT ══════════════════ */
ok('a deterministic refusal is remembered', /if \(res\.refused\) \{/.test(sweep)
   && /refused\[prog\.program_id\] = \{ fp: fp/.test(sweep));
/* THE IMPORTANT NEGATIVE: only res.refused. snapshotProgram_ sets that solely for zero_vs_record;
   a store that would not answer comes back ok:false with no `refused`, and must be retried. */
ok('  …but a transient failure is NOT, so one bad Dutchie afternoon is not permanent',
   /failed\.push\(/.test(sweep)
   && sweep.indexOf('if (res.refused) {') > sweep.indexOf('failed.push('));
const prog = grab('snapshotProgram_');
ok('  …and snapshotProgram_ marks ONLY the zero-vs-record case as refused',
   (prog.match(/refused:/g) || []).length === 1 && /refused: 'zero_vs_record'/.test(prog));
ok('  …a store that would not answer is reported as partial, not as a refusal',
   /out\.partial\.push\(slug\)/.test(prog));
ok('a program that succeeds clears any memory of refusing',
   /if \(prior\) \{ delete refused\[prog\.program_id\]; refusalsMoved = true; \}/.test(sweep));
ok('  …and force ignores the memory entirely', /prior\.fp === fp && !force/.test(sweep));
ok('the memory is only written when it moved', /if \(refusalsMoved\) saveSnapshotRefusals_/.test(sweep));

/* ══════════════════ 4. IT HAS TO BE SAYABLE ══════════════════ */
/* The counts existed all along — snapshotPending_ has always returned `failed` and `remaining`.
   Nothing read either, which is the whole reason a stuck sweep ran for a week. */
ok('the sweep reports what it skipped as unmeasurable, apart from what it will retry',
   /refused_skipped: stuck/.test(sweep) && /remaining: Math\.max/.test(sweep));
const diag = grab('diag_');
ok('diag reports the backlog beside the trigger it rides on',
   /snapshotBacklog_\(\)/.test(diag) && /never_measured/.test(diag));
ok('  …and says plainly when programs are stuck needing a human',
   /snapshotStuck/.test(diag));
ok('  …with counts only, because that route is anonymous',
   !/program_id/.test(diag));
const trig = grab('refreshSpiffProgressTrigger');
ok('the trigger warns when it skipped unmeasurable programs',
   /snap\.refused_skipped/.test(trig));
ok('  …and when it froze nothing while work remained — silence used to read as "no work"',
   /!snap\.done\.length && !snap\.failed\.length && snap\.remaining/.test(trig));

/* ══════════════════ 5. THE BACKLOG REPORT ══════════════════ */
const backlog = new Function('listPrograms_', 'snapshotReasonFor_', 'snapshotRefusals_',
                             'snapshotFingerprint_',
                             grab('snapshotBacklog_') + '; return snapshotBacklog_;');
const P = [
  { program_id: 'measured', status: 'closed', progress_json: { stores: [{ store_id: 'bend' }] } },
  { program_id: 'stuck',    status: 'closed' },
  { program_id: 'pending',  status: 'closed' },
  { program_id: 'active',   status: 'active' },
];
const r = backlog(() => P,
                  p => (p.status === 'closed' ? 'closed' : ''),
                  () => ({ stuck: { fp: 'FP', at: '2026-09-02', reason: 'zero_vs_record' } }),
                  p => (p.program_id === 'stuck' ? 'FP' : 'other'))();
ok('the backlog counts only programs that could be measured', r.eligible === 3);
ok('  …separating measured from never-measured', r.measured === 1 && r.never_measured === 2);
ok('  …and stuck from merely not-yet-reached', r.refused === 1
   && r.programs.filter(x => x.refused).length === 1
   && r.programs.filter(x => !x.refused).length === 1);
ok('  …naming when it got stuck, so a week-old floor is visible as one',
   (r.programs.find(x => x.refused) || {}).since === '2026-09-02');
/* A fingerprint that no longer matches means somebody fixed the filter: not stuck any more. */
const r2 = backlog(() => P, p => (p.status === 'closed' ? 'closed' : ''),
                   () => ({ stuck: { fp: 'STALE', at: '2026-09-02' } }),
                   () => 'CURRENT')();
ok('a program whose filter has since been edited is no longer counted as stuck', r2.refused === 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nsnapshot queue: all passed');
process.exit(fail ? 1 : 0);
