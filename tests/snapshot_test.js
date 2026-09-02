#!/usr/bin/env node
/* ─── Frozen progress: measured once, when a program stops moving ─────────────────────────────────
 *
 *   RUN:  node tests/snapshot_test.js
 *
 * WHY
 * A program's results stop changing the moment it stops running, and recomputing them after that
 * costs six stores of Dutchie calls (~9s each) to arrive at the same answer — which is why the
 * Progress grid could never be part of the record. Measure once, write it to the program's row,
 * and History renders instantly.
 *
 * TWO DECISIONS THIS FILE HOLDS.
 *
 * WHERE. On the PROGRAM, not in the shared spiff_progress tab. Crew fetches that tab whole and
 * unfiltered — it filters by window itself — so adding the 23 closed programs would take one
 * response from 23KB to ~343KB against Crew's 95KB cache ceiling. Crew would silently stop caching
 * and re-fetch the lot on every page load. Measured 2026-09-02.
 *
 * WHICH. Closed, obviously. And a DRAFT whose window has passed (Sky, 2026-09-02) — the status roll
 * leaves those alone on purpose, because "drafted and never run" and "ran and finished" are
 * different facts only a human can separate. But the sales either happened or they did not, and
 * measuring them is what makes that call answerable. An ACTIVE program is never frozen: its numbers
 * are still moving and the live grid is the whole point.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── the column exists, round-trips, and does not disturb the others ── */
const HEADERS = new Function('return ' + (gs.match(/var PROGRAM_HEADERS = (\[[\s\S]*?\]);/) || [])[1])();
ok('progress_json is a column', HEADERS.indexOf('progress_json') >= 0);
ok('  …appended LAST, so no existing column shifts',
   HEADERS[HEADERS.length - 1] === 'progress_json');
ok('  …and it is written', /p\.progress_json \? JSON\.stringify\(p\.progress_json\) : ''/.test(grab('programToRow_')));
ok('  …and read back at the matching index',
   new RegExp('progress_json: parseJson_\\(r\\[' + (HEADERS.length - 1) + '\\], null\\)').test(grab('rowToProgram_')));
/* migrateHeaders_ remaps by NAME, which is what makes appending safe on a live sheet. */
ok('adding a column is safe because rows are remapped by name',
   /remapped BY NAME|rather than trusted to line up/.test(gs));

/* ── WHICH programs freeze ── */
const reason = new Function('today_', 'textDate_',
  grab('snapshotReasonFor_') + '; return snapshotReasonFor_;')(
  () => '2026-09-02', (v) => String(v || ''));

ok('a closed program freezes', reason({ status: 'closed' }) === 'closed');
ok('an ACTIVE program never freezes — its numbers are still moving',
   reason({ status: 'active', end_date: '2026-09-13' }) === '');
ok('  …not even one whose window has passed but is still marked active',
   reason({ status: 'active', end_date: '2026-08-30' }) === '');
ok('a draft whose window has PASSED freezes',
   /passed/.test(reason({ status: 'draft', end_date: '2026-08-30' })));
ok('  …but a draft still ahead of its window does not',
   reason({ status: 'draft', end_date: '2026-09-30' }) === '');
ok('  …nor one with no window at all', reason({ status: 'draft', end_date: '' }) === '');
ok('an unknown status is left alone rather than guessed at',
   reason({ status: 'archived' }) === '');

/* ── the measurement ── */
const snap = grab('snapshotProgram_');
ok('a store that refuses is NAMED, not written as zeros', /out\.partial\.push\(slug\)/.test(snap));
ok('  …and a snapshot with no store at all refuses outright',
   /no store answered/.test(snap));
/* The distinction that makes the whole thing trustworthy: a quiet undercount is indistinguishable
   from a store that genuinely sold nothing. */
ok('earnings come from the shared payout helper, not a second formula',
   /progEarned_\(prog, e\.units, e\.hit\)/.test(snap));
ok('per-unit counts everyone who SOLD as an earner, flat counts who hit',
   /perUnit \? x\.units > 0 : x\.hit/.test(snap));
ok('the rate and model are recorded with the numbers, so a later rate change cannot rewrite history',
   /rate: rate/.test(snap) && /model: perUnit \? 'per_unit' : 'flat'/.test(snap));

/* ── bounded and resumable ── */
const pend = grab('snapshotPending_');
ok('the work is capped per call', /Math\.max\(1, Math\.min\(20, Number\(opts\.max\) \|\| 1\)\)/.test(pend));
ok('  …and reports what is LEFT, so a caller can finish the job', /remaining:/.test(pend));
ok('  …counting eligible programs it did not get to, rather than reporting zero',
   /eligible\+\+/.test(pend) && /if \(done\.length \+ failed\.length >= max\) continue/.test(pend));
ok('a program that already has a snapshot is skipped', /if \(prog\.progress_json && !force\) continue/.test(pend));
ok('force re-measures it — the break-glass', /var force = !!opts\.force/.test(pend));
ok('only ONE cell is written; a measurement is not a human edit',
   /sh\.getRange\(i \+ 2, pCol \+ 1\)\.setValue/.test(pend));

/* ── how it is reached ── */
const SECRET = new Function('return ' + (gs.match(/var SECRET_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])();
ok('snapshotProgress is secret-gated — it is expensive and it writes',
   SECRET.indexOf('snapshotProgress') >= 0);
const PUBLIC = new Function('return ' + (gs.match(/var PUBLIC_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])();
ok('  …and never public', PUBLIC.indexOf('snapshotProgress') < 0);

const trig = grab('refreshSpiffProgressTrigger');
ok('the hourly trigger freezes whole programs, capped per run',
   /snapshotPending_\(\{ max: quietHours_\(\) \? 4 : 1 \}\)/.test(trig));
ok('  …after the status roll, so a program that just closed is caught the same hour',
   trig.indexOf('rollProgramStatuses_') < trig.indexOf('snapshotPending_'));
ok('  …and a failure there does not take the sweep down with it',
   /catch \(e\) \{ console\.warn\('\[spiff\] snapshot failed/.test(trig));

/* ══════════════ A ZERO THAT CONTRADICTS THE RECORD IS NOT A MEASUREMENT ══════════════
 * Found while backfilling, 2026-09-02: Hellavated measured 0 units against 649 recorded, Hapy
 * Kitchen 0 against 289. Not quiet fortnights — broken filters. The SPIF-doc seed copied Tawny's
 * PROSE into fields Dutchie has to match literally:
 *
 *     category "Inhalable Cannabanoid w/ Non-Cannabis Additives"   typo, 'a' for 'i'
 *     category "Edible Solid, Tinctures, Concentrates"             a list, not a category
 *     category "Extracts" / "Extracts(Liquid)"                     plural, missing space
 *     products ["All Disposables"]                                 no product is called that
 *
 * Fifteen of twenty-six carry a category that matches nothing, and category is AND-ed — so they
 * measure zero however much sold. The overnight sweep was about to write that across History as
 * empty grids that look authoritative.
 */
const store0 = grab('snapshotStore_');
ok('a measured zero is refused when the record says otherwise',
   /snap\.units === 0 && recorded > 0/.test(store0));
ok('  …and NOT written', store0.indexOf('refused:') < store0.indexOf('writeSnapshot_'));
ok('  …naming the recorded figure it contradicts', /recorded: recorded/.test(store0));
ok('  …and pointing at the filter, which is the actual fault',
   /check match_json/.test(store0));
/* A program with NO recorded actuals is left alone: there, zero is unproven either way and there
   is nothing for it to contradict. */
ok('a program with no recorded actuals is not blocked',
   /Number\(\(prog\.actual_json \|\| \{\}\)\.units_sold\) \|\| 0/.test(store0));
const whole = grab('snapshotProgram_');
ok('the whole-program path refuses identically, so the trigger cannot write what the web path will not',
   /out\.units === 0 && rec > 0/.test(whole));

/* ══════════════ ONE STORE PER CALL ══════════════
 * The first cut of the backfill route measured a whole program per request — six stores at ~9s —
 * and died at 60.15s against Google's 60s /exec ceiling without writing a thing. Measured, not
 * guessed. Every other expensive path in this app already loops stores for exactly this reason;
 * this one now does too.
 */
const store = grab('snapshotStore_');
ok('a store can be measured on its own', /function snapshotStore_\(prog, slug\)/.test(gs));
ok('  …and merges into what is already there rather than replacing it',
   /snap\.stores = \(snap\.stores \|\| \[\]\)\.filter/.test(store));
ok('  …keyed by store, so re-running one corrects it without disturbing the other five',
   /x\.store_id !== slug/.test(store));
ok('totals are recomputed from the stores present, never accumulated blindly',
   /snap\.units   = snap\.stores\.reduce/.test(store));
ok('`partial` is derived from what is MISSING, so it clears itself as stores land',
   /snap\.partial = \(prog\.stores_json \|\| \[\]\)/.test(store));
ok('the window and rate are refreshed each time, so a half-built snapshot cannot describe itself twice',
   /snap\.from = from; snap\.to = to;/.test(store));

const plan = grab('snapshotPlan_');
ok('a plan lists every (program, store) pair still to do', /plan\.push\(\{ program: prog\.program_id, store: slug/.test(plan));
ok('  …skipping stores already measured, unless forced', /if \(done && !force\) \{ skipped\+\+; return; \}/.test(plan));
ok('  …and writes nothing', !/setValue|writeSnapshot_/.test(plan));
ok('the route measures one store when named, and plans when not',
   /out = p\.store[\s\S]{0,220}snapshotStore_\(g\.program, p\.store\)/.test(gs));

/* The trigger keeps the whole-program path: a trigger gets six minutes, a web call does not. */
ok('the hourly trigger still freezes whole programs — a trigger gets six minutes',
   /snapshotPending_\(\{ max: quietHours_\(\) \? 4 : 1 \}\)/.test(gs));

/* ══════════════ IT DRAINS THE BACKLOG WHEN NOBODY IS LOOKING ══════════════
 * Apps Script runs one thing at a time per project, so every second spent measuring is a second
 * the app cannot answer a page load. A 20-minute backfill made SPIFF unusable twice this
 * afternoon and had to be killed both times. So the trigger does more work overnight and almost
 * none during the day — a 23-program backlog is gone by morning either way.
 */
const quiet = new Function('Utilities',
  grab('quietHours_') + '; return quietHours_;')({
    formatDate: function (d, tz, fmt) { return String(global.__H); }
  });
[[22, true], [23, true], [0, true], [3, true], [5, true],
 [6, false], [9, false], [14, false], [17, false], [21, false]].forEach(function (c) {
  global.__H = c[0];
  ok((c[0] + ':00 is ' + (c[1] ? 'quiet' : 'working hours')), quiet() === c[1]);
});
ok('the hour is read in LOS ANGELES — the stores are in Oregon',
   /'America\/Los_Angeles', 'H'/.test(grab('quietHours_')));

const trig2 = grab('refreshSpiffProgressTrigger');
ok('the trigger takes four at a time overnight, one in working hours',
   /max: quietHours_\(\) \? 4 : 1/.test(trig2));
/* Four programs is ~216s of measuring against a six-minute trigger — room to spare, and the cap
   is what keeps a run from being killed halfway with rows half-written. */
ok('  …and still says how many are left, so the drain is watchable',
   /snap\.remaining \+ ' still to freeze'/.test(trig2));

/* ══════════════ THE PAGE FOLLOWS THE STATUS ══════════════ */
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
function grabJs(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

ok('the model sits in a fold', html.indexOf('id="calcModelFold"') >= 0);
ok('  …open by default, so an unsettled program is unaffected',
   /id="calcModelFold" open/.test(html));
ok('the frozen results have a home', html.indexOf('id="calcResults"') >= 0);
ok('  …hidden until there is something to show', /id="calcResults" hidden/.test(html));

const view = grabJs('statusView');
ok('"settled" means finished AND measured, not merely closed',
   /st === 'closed' && snap && snap\.stores && snap\.stores\.length/.test(view));
/* A closed program with no snapshot must keep its model open — folding it away to reveal an empty
   space is worse than not folding at all. */
ok('  …so a closed program with no snapshot still shows its model',
   /settled: !!\(st === 'closed'/.test(view));

const apply = grabJs('applyStatusView');
ok('the fold follows settled-ness', /fold\.open = !v\.settled/.test(apply));
ok('the results appear only when a snapshot exists', /if \(!v\.snap\) \{ results\.hidden = true/.test(apply));
ok('  …and it is only set on load, never on every repaint',
   /never on every repaint/.test(apply));

const froz = grabJs('renderFrozen');
ok('the frozen grid reads the snapshot, it does not re-measure',
   !/sellthrough|pullStore|ENG\.jsonp/.test(froz));
ok('it says WHEN it was measured', /measured ' \+ esc\(String\(snap\.at/.test(froz));
ok('  …and names any store the snapshot is missing, as an undercount',
   /these totals undercount/.test(froz));
ok('per-unit credits everyone who sold; flat credits who hit',
   /perUnit \? e\.units > 0 : e\.hit/.test(froz));

const rem = grabJs('remeasure');
ok('re-measuring is behind a confirm that names the vendor risk',
   /confirm\(/.test(rem) && /reported to '/.test(rem));
ok('  …and it is the only thing that passes force', /force: '1'/.test(rem));
ok('  …offered only to someone who can edit', /canEdit\(\) \? ' · <button/.test(froz));

console.log(fail ? '\n' + fail + ' FAILED' : '\nsnapshot: all passed');
process.exit(fail ? 1 : 0);
