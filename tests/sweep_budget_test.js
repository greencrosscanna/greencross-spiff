#!/usr/bin/env node
/* ─── THE HOURLY STORE SWEEP STOPS ON THE CLOCK ───────────────────────────────────────────────────
 *
 *   RUN:  node tests/sweep_budget_test.js
 *
 * WHAT HAPPENED (2026-09-16). The hourly trigger has four phases and until today only ONE of them
 * was bounded: the freeze has a four-minute budget and stops on it. The sweep that follows had no
 * bound at all — it read every active program's stores one after another, waiting on GX Core for
 * each, however long that took. A week of executions: 168 runs, every one publishing the identical
 * result (38 / 35 / 20 rows), and durations from 50s to 636.6s. Same work, 12x spread — the time is
 * spent WAITING on Core, and Core is slowest exactly when the shared account is busiest, so a
 * congested hour made SPIFF hold its execution slot longer and fire more Core calls while it waited.
 *
 * Two runs (Sep 14, 636.6s; Sep 16, 526.4s) outlived the 7-minute lease that is supposed to
 * guarantee one run at a time, so for those minutes the job ran with no lock held. The comment above
 * the lease blamed Google's six-minute trigger ceiling for the worst case — but this account gets
 * thirty minutes, which is why those runs completed instead of being killed.
 *
 * WHAT MUST STAY TRUE, and the second one is the money:
 *   - the sweep stops STARTING store reads once the run is out of time;
 *   - a store it never got to keeps the rows it already had. Not zero, not deleted. The delete is
 *     scoped to the program+store pairs that actually came back, which is the same rule a FAILED
 *     store has always followed — a store that did not answer is not a store that sold nothing.
 *   - a manual single-store refresh passes no deadline and is never truncated.
 */
'use strict';
const { load, makeSheet, grabVar } = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));
/* Read `skipped` defensively. Strip the budget out of Code.gs and the field stops existing, which
   would throw here and bury the point in a stack trace — a revert should be told to you by name. */
const skips = (out) => (out && out.skipped) || [];

const PROGRESS_HEADERS = grabVar('PROGRESS_HEADERS');
const H = (n) => PROGRESS_HEADERS.indexOf(n);

/* Two programs, three stores each: six reads, each costing `costMs` on the fake clock. */
function harness(opts) {
  const o = opts || {};
  const costMs = o.costMs || 9000;
  let clock = 1758000000000;

  const programs = [
    { program_id: 'p1', pay_period: '2026-09-14', vendor: 'Wyld', program_name: 'Wyld Sep',
      start_date: '2026-09-14', end_date: '2026-09-27',
      stores_json: ['river-rd', 'bend', 'hillsboro'], status: 'active' },
    { program_id: 'p2', pay_period: '2026-09-14', vendor: 'Gron', program_name: 'Gron Sep',
      start_date: '2026-09-14', end_date: '2026-09-27',
      stores_json: ['river-rd', 'bend', 'hillsboro'], status: 'active' },
  ];

  /* Rows already on the tab from the last good sweep — what a skipped store must keep. */
  const prior = [];
  programs.forEach(p => p.stores_json.forEach(s => {
    const r = new Array(PROGRESS_HEADERS.length).fill('');
    r[H('program_id')] = p.program_id;
    r[H('store_id')] = s;
    r[H('name')] = 'Prior ' + s;
    r[H('units')] = 11;
    r[H('refreshed_at')] = '2026-09-16 09:56:04';
    prior.push(r);
  }));
  const sheet = makeSheet(PROGRESS_HEADERS.slice(), prior);

  const read = [];
  const S = load({
    real: ['refreshSpiffProgress_'],
    vars: ['PROGRESS_HEADERS'],
    stubs: {
      listPrograms_: (status) => (status === 'active' ? programs.slice() : programs.slice()),
      slug_: (x) => String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      nowStamp_: () => '2026-09-16 13:56:04',
      progressSheet_: () => sheet,
      forceProgressTextDates_: () => {},
      progEarned_: () => 25,
      scrubSecrets_: (e) => String(e),
      sellthrough_: (p) => {
        clock += costMs;                       // the wait on GX Core, on the fake clock
        read.push(p.id + '|' + p.store);
        return { ok: true, rows: [{ employee_id: 'e1', name: 'Ann ' + p.store, units: 7, hit: true }] };
      },
    },
    globals: { Date: { now: () => clock } },
  });

  return { S, sheet, read, programs, at: () => clock, start: 1758000000000 };
}

const rowsFor = (sheet, pid, store) => sheet.rows.slice(1)
  .filter(r => r[H('program_id')] === pid && r[H('store_id')] === store);

/* ── 1. no deadline: the sweep does every store, exactly as before ─────────────────────────────── */
console.log('\n1. with no deadline nothing is truncated (the manual single-store path)');
{
  const h = harness();
  const out = h.S.refreshSpiffProgress_();
  ok('all six program+store pairs are read', h.read.length === 6);
  ok('nothing is reported as skipped', skips(out).length === 0);
  ok('out_of_budget is false', !out.out_of_budget);
  ok('every pair was rewritten with this sweep\'s rows',
     rowsFor(h.sheet, 'p2', 'hillsboro').every(r => r[H('refreshed_at')] === '2026-09-16 13:56:04'));
}

/* ── 2. a generous deadline behaves like no deadline ───────────────────────────────────────────── */
console.log('\n2. a deadline the sweep comfortably beats changes nothing');
{
  const h = harness({ costMs: 9000 });                 // 6 x 9s = 54s
  const out = h.S.refreshSpiffProgress_('', '', { deadline: h.start + 6 * 60 * 1000 });
  ok('all six are still read (fails if the budget fires early)', h.read.length === 6);
  ok('nothing skipped', skips(out).length === 0 && !out.out_of_budget);
}

/* ── 3. a slow hour: the sweep stops, and what it missed keeps its rows ────────────────────────── */
console.log('\n3. when Core is slow the run stops on the clock instead of running open-ended');
{
  const h = harness({ costMs: 100000 });               // 100s a store — the bad-hour shape
  const out = h.S.refreshSpiffProgress_('', '', { deadline: h.start + 6 * 60 * 1000 });

  ok('it stopped starting reads once out of time (fails if the sweep is unbounded)',
     h.read.length === 4 && h.at() - h.start === 400000);
  ok('…and says so, with what it missed', out.out_of_budget === true && skips(out).length === 2);
  ok('the skipped pairs are named, not just counted',
     skips(out).every(s => s.program_id && s.store) &&
     skips(out).map(s => s.program_id + '|' + s.store).join(',') === 'p2|bend,p2|hillsboro');

  /* THE MONEY ASSERTION. A store the sweep never reached must look untouched, not empty. */
  const missed = rowsFor(h.sheet, 'p2', 'hillsboro');
  ok('a store it never reached still has its rows (fails if a skipped store is deleted)',
     missed.length === 1);
  ok('…unchanged, carrying the previous sweep\'s stamp and units (fails if it is zeroed)',
     missed[0][H('units')] === 11 && missed[0][H('refreshed_at')] === '2026-09-16 09:56:04');

  const got = rowsFor(h.sheet, 'p1', 'bend');
  ok('a store it DID reach was replaced with this hour\'s rows',
     got.length === 1 && got[0][H('refreshed_at')] === '2026-09-16 13:56:04');
}

/* ── 4. an already-blown deadline reads nothing at all, and destroys nothing ───────────────────── */
console.log('\n4. a run that is already out of time reads nothing and deletes nothing');
{
  const h = harness();
  const out = h.S.refreshSpiffProgress_('', '', { deadline: h.start - 1 });
  ok('no store is read', h.read.length === 0);
  ok('all six pairs are reported skipped', skips(out).length === 6 && out.out_of_budget === true);
  ok('the tab is left exactly as it was (fails if an empty sweep clears the cache)',
     h.sheet.rows.length === 7 &&
     rowsFor(h.sheet, 'p1', 'river-rd')[0][H('units')] === 11);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
