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

/* ── THE SWEEP ITSELF, RUN ───────────────────────────────────────────────────────────────────────
   REWRITTEN 2026-09-15. Sections 2 and 3 used to read snapshotPending_'s source with the comments
   stripped out, which is a delicate way to check the most consequential thing in this file: that a
   refusal no longer eats the run's one slot. `/done\.length >= max/` is equally true of a sweep
   that budgets correctly and one that never reaches the second program for some other reason —
   and "never reaches the second program" is exactly the bug. The sweep now runs against an
   in-memory programs sheet with a scripted snapshotProgram_, and the assertions count what got
   written. */
const G = require('./_gas');
const PH = G.grabVar('PROGRAM_HEADERS');
/* The harness reads these constants out of Code.gs rather than copying them. Two names declared on
   one line used to both resolve to the SECOND value — `var PITCH_MAX_TIPS = 5, PITCH_MAX_LEN = 240`
   gave 240 for both — so a test of the tip cap would have read a 240-tip limit as correct. Pinned
   here because this file is the one that loads the most of them. */
ok('the harness reads a two-on-one-line declaration correctly',
   G.grabVar('PITCH_MAX_TIPS') === 5 && G.grabVar('PITCH_MAX_LEN') === 240);

function progRow(id, status, extra) {
  const row = PH.map(() => '');
  row[PH.indexOf('program_id')] = id;
  row[PH.indexOf('program_name')] = id;
  row[PH.indexOf('status')] = status || 'closed';
  row[PH.indexOf('start_date')] = '2026-02-16';
  row[PH.indexOf('end_date')] = '2026-03-01';
  row[PH.indexOf('stores_json')] = JSON.stringify(['bend', 'center']);
  row[PH.indexOf('match_json')] = JSON.stringify((extra && extra.match) || { brand: 'Kaprikorn' });
  row[PH.indexOf('progress_json')] = (extra && extra.snapshot) ? JSON.stringify(extra.snapshot) : '';
  return row;
}
/* `answers` scripts snapshotProgram_ per program id, so a run can contain a deterministic refusal,
   a transient failure and a success at once — which is the case the budget fix is about. */
function sweeper(rows, answers, memory) {
  const sheet = G.makeSheet(PH, rows);
  const store = memory || {};
  const calls = [];
  const api = G.load({
    /* scrubSecrets_ is REAL, not stubbed, because the refusal memory below is written through it —
       a stub would let a fake scrub vouch for the thing the refusal assertions are checking. */
    real: ['snapshotPending_', 'rowToProgram_', 'snapshotFingerprint_', 'textDate_', 'parseJson_',
           'normalizePitch_', 'slug_', 'scrubSecrets_'],
    vars: ['PROGRAM_HEADERS', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => sheet,
      snapshotReasonFor_: (prog) => (String(prog.status).toLowerCase() === 'closed' ? 'closed' : ''),
      snapshotProgram_: (prog) => {
        calls.push(prog.program_id);
        const a = answers[prog.program_id];
        if (!a) return { ok: false, error: 'no answer scripted' };
        return typeof a === 'function' ? a(prog) : a;
      },
      snapshotRefusals_: () => store,
      saveSnapshotRefusals_: (m) => { store.__saved = (store.__saved || 0) + 1; Object.assign(store, m); },
      invalidatePrograms_: () => {},
      nowStamp_: () => '2026-09-09 10:00:00',
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
    },
  });
  return { api, sheet, memory: store, calls,
           snapshotOf: (id) => {
             const i = sheet.rows.findIndex(r => r[PH.indexOf('program_id')] === id);
             const cell = i < 0 ? '' : sheet.rows[i][PH.indexOf('progress_json')];
             return cell ? JSON.parse(cell) : null;
           } };
}
const GOOD = { ok: true, snapshot: { units: 120, earned: 250, earners: 10, partial: [] } };
const REFUSED = { ok: false, error: 'measured 0 units against a record of 242', refused: 'zero_vs_record' };
const FLAKY = { ok: false, error: 'bend did not answer' };

/* ══════════════════ 2. A FAILURE NO LONGER BUYS A SLOT ══════════════════
   `max` is 1 in working hours. Before the fix, one unmeasurable program at the head of the queue
   ended every run — for a week, with every health signal green. */
{
  const s = sweeper([progRow('unmeasurable'), progRow('waiting')],
                    { unmeasurable: REFUSED, waiting: GOOD });
  const r = s.api.snapshotPending_({ max: 1 });
  ok('a refusal at the head of the queue does not end the run',
     s.calls.join(',') === 'unmeasurable,waiting');
  ok('  …and the program behind it is measured in the SAME run',
     r.done.length === 1 && r.done[0].program_id === 'waiting');
  ok('  …with its snapshot really written to the row',
     (s.snapshotOf('waiting') || {}).units === 120);
  ok('  …and the refusal reported separately from the success',
     r.failed.length === 1 && r.failed[0].program_id === 'unmeasurable');
}
{
  /* `max` counts what was WRITTEN, so two successes with max 1 still stop after one. */
  const s = sweeper([progRow('first'), progRow('second')], { first: GOOD, second: GOOD });
  const r = s.api.snapshotPending_({ max: 1 });
  ok('max still bounds what is written — one success, one run',
     r.done.length === 1 && s.calls.join(',') === 'first');
  ok('  …and what it did not reach is reported as remaining, not as done', r.remaining === 1);
  const s2 = sweeper([progRow('first'), progRow('second')], { first: GOOD, second: GOOD });
  ok('a bigger budget writes both', s2.api.snapshotPending_({ max: 5 }).done.length === 2);
}
{
  /* A program that already has a snapshot is left alone — a measurement is frozen once. */
  const s = sweeper([progRow('already', 'closed', { snapshot: { units: 9 } }), progRow('new')],
                    { already: GOOD, new: GOOD });
  s.api.snapshotPending_({ max: 5 });
  ok('a program already measured is not re-measured', s.calls.join(',') === 'new');
  ok('  …and its frozen snapshot is untouched', s.snapshotOf('already').units === 9);
  const s2 = sweeper([progRow('already', 'closed', { snapshot: { units: 9 } })], { already: GOOD });
  s2.api.snapshotPending_({ max: 5, force: true });
  ok('  …unless force says otherwise', s2.snapshotOf('already').units === 120);
}
{
  const s = sweeper([progRow('running', 'active')], { running: GOOD });
  const r = s.api.snapshotPending_({ max: 5 });
  ok('a program with no reason to be measured is never attempted',
     s.calls.length === 0 && r.done.length === 0 && r.remaining === 0);
}

/* ══════════════════ 3. WHAT IS REMEMBERED, AND WHAT IS NOT ══════════════════ */
{
  const s = sweeper([progRow('unmeasurable')], { unmeasurable: REFUSED });
  s.api.snapshotPending_({ max: 5 });
  ok('a deterministic refusal is remembered, with its reason and the day it happened',
     !!s.memory.unmeasurable && s.memory.unmeasurable.reason === 'zero_vs_record'
     && s.memory.unmeasurable.at === '2026-09-09 10:00:00');
  /* Second run, same program, unchanged: not attempted at all — that is the Dutchie call saved. */
  const again = sweeper([progRow('unmeasurable')], { unmeasurable: REFUSED }, s.memory);
  const r2 = again.api.snapshotPending_({ max: 5 });
  ok('  …and the next hour it is skipped without spending a Dutchie call',
     again.calls.length === 0 && r2.refused_skipped === 1);
  ok('  …counted apart from what a further run would still try', r2.remaining === 0);
  /* THE IMPORTANT NEGATIVE: a refusal must not hold up anything else. */
  const behind = sweeper([progRow('unmeasurable'), progRow('waiting')],
                         { unmeasurable: REFUSED, waiting: GOOD }, s.memory);
  const r3 = behind.api.snapshotPending_({ max: 1 });
  ok('  …while the program behind it is measured normally', r3.done.length === 1);
}
/* WHAT THE MEMORY IS ALLOWED TO HOLD. snapshotProgram_ can fail with a UrlFetchApp exception, and
   Apps Script puts the WHOLE url — deploy secret and all — into that message. This is a STORE, so
   the exit-scrub test cannot see it: that one finds escapes, not accumulations. Crew's identical
   "stored error with no reader" turned out to have one, a health check that folded it into a reason
   a weekly recap mailed out, which is why this is scrubbed at the write rather than at whichever
   reader appears first. Scrubbed BEFORE the 200-char truncation, or a long url would be cut
   mid-secret and stored as a fragment nothing would ever redact. */
{
  const SECRET = 'NOT-A-REAL-SECRET-0000000000000';
  const LEAKY = { ok: false, refused: 'zero_vs_record',
                  error: 'Address unavailable: https://script.google.com/macros/s/AK/exec'
                         + '?action=sales_by_employee&secret=' + SECRET + '&stores=bend' };
  const s = sweeper([progRow('leaky')], { leaky: LEAKY });
  s.api.snapshotPending_({ max: 5 });
  const stored = s.memory.leaky || {};
  ok('a remembered refusal does not park the deploy secret in the memory',
     !!stored.error && String(stored.error).indexOf(SECRET) < 0);
  ok('  …and still says what failed, so the next reader can act on it',
     /secret=\[redacted\]/.test(stored.error) && stored.error.indexOf('stores=bend') >= 0);
}
{
  /* A TRANSIENT failure is NOT remembered — writing those off would turn one bad afternoon at
     Dutchie into a program that is never measured again. */
  const s = sweeper([progRow('flaky')], { flaky: FLAKY });
  s.api.snapshotPending_({ max: 5 });
  ok('a transient failure is NOT remembered', !s.memory.flaky);
  const retry = sweeper([progRow('flaky')], { flaky: GOOD }, s.memory);
  const r = retry.api.snapshotPending_({ max: 5 });
  ok('  …so the next hour tries it again, and it succeeds',
     retry.calls.join(',') === 'flaky' && r.done.length === 1);
}
{
  /* Correcting the filter re-arms it, with nobody having to remember to clear a flag. */
  const s = sweeper([progRow('unmeasurable')], { unmeasurable: REFUSED });
  s.api.snapshotPending_({ max: 5 });
  const fixed = sweeper([progRow('unmeasurable', 'closed', { match: { brand: 'Mule Extracts' } })],
                        { unmeasurable: GOOD }, s.memory);
  const r = fixed.api.snapshotPending_({ max: 5 });
  ok('editing what makes a program measurable re-arms it with no flag to clear',
     fixed.calls.join(',') === 'unmeasurable' && r.done.length === 1);
  ok('  …and succeeding forgets the refusal', !fixed.memory.unmeasurable);
  /* force ignores the memory entirely. */
  const forced = sweeper([progRow('unmeasurable')], { unmeasurable: GOOD }, { unmeasurable:
    { fp: 'whatever', at: '2026-09-02', reason: 'zero_vs_record' } });
  ok('force ignores the memory', forced.api.snapshotPending_({ max: 5, force: true }).done.length === 1);
}
{
  /* The memory is only written when it moved: a quiet run must not rewrite the property. */
  const s = sweeper([progRow('fine')], { fine: GOOD });
  s.api.snapshotPending_({ max: 5 });
  ok('a run that changed no refusal writes the memory not at all', !s.memory.__saved);
}
/* Only the zero-vs-record case is a refusal at all; a store that would not answer is partial.
   Source-shaped because it is a property of snapshotProgram_, which is exercised in
   snapshot_test.js — here it pins that this file's REFUSED fixture matches the only real one. */
ok('snapshotProgram_ marks ONLY the zero-vs-record case as refused',
   (G.grab('snapshotProgram_').match(/refused:/g) || []).length === 1
   && /refused: 'zero_vs_record'/.test(G.grab('snapshotProgram_')));

/* ══════════════════ 4. IT HAS TO BE SAYABLE ══════════════════ */
/* The counts existed all along — snapshotPending_ has always returned `failed` and `remaining`.
   Nothing read either, which is the whole reason a stuck sweep ran for a week. */
/* Exercised above: `refused_skipped` counted the skipped program and `remaining` stayed 0. What is
   left for this section is the surfaces that READ those counts — the trigger's warning and the
   diagnostic route — which is where a week of silence actually hid. */
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
/* snapshotBacklog_ asks snapshotRefusalFor_ whether a remembered refusal still applies, rather than
   re-deriving that test itself — the record panel needs the same answer, and two copies of "is this
   refusal still current" would be free to drift. So the REAL helper is built here over whichever
   fingerprint function each case injects, not stubbed: a stub would let the shared rule break while
   this file still passed. */
const refusalFor = fp => new Function('snapshotFingerprint_',
                                      grab('snapshotRefusalFor_') + '; return snapshotRefusalFor_;')(fp);
const backlog = new Function('listPrograms_', 'snapshotReasonFor_', 'snapshotRefusals_',
                             'snapshotFingerprint_', 'snapshotRefusalFor_',
                             grab('snapshotBacklog_') + '; return snapshotBacklog_;');
const P = [
  { program_id: 'measured', status: 'closed', progress_json: { stores: [{ store_id: 'bend' }] } },
  { program_id: 'stuck',    status: 'closed' },
  { program_id: 'pending',  status: 'closed' },
  { program_id: 'active',   status: 'active' },
];
const fp1 = p => (p.program_id === 'stuck' ? 'FP' : 'other');
const r = backlog(() => P,
                  p => (p.status === 'closed' ? 'closed' : ''),
                  () => ({ stuck: { fp: 'FP', at: '2026-09-02', reason: 'zero_vs_record' } }),
                  fp1, refusalFor(fp1))();
ok('the backlog counts only programs that could be measured', r.eligible === 3);
ok('  …separating measured from never-measured', r.measured === 1 && r.never_measured === 2);
ok('  …and stuck from merely not-yet-reached', r.refused === 1
   && r.programs.filter(x => x.refused).length === 1
   && r.programs.filter(x => !x.refused).length === 1);
ok('  …naming when it got stuck, so a week-old floor is visible as one',
   (r.programs.find(x => x.refused) || {}).since === '2026-09-02');
/* A fingerprint that no longer matches means somebody fixed the filter: not stuck any more. */
const fp2 = () => 'CURRENT';
const r2 = backlog(() => P, p => (p.status === 'closed' ? 'closed' : ''),
                   () => ({ stuck: { fp: 'STALE', at: '2026-09-02' } }),
                   fp2, refusalFor(fp2))();
ok('a program whose filter has since been edited is no longer counted as stuck', r2.refused === 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nsnapshot queue: all passed');
process.exit(fail ? 1 : 0);
