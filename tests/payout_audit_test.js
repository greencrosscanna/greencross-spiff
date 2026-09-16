#!/usr/bin/env node
/* ─── Does a closed program still add up? ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/payout_audit_test.js
 *
 * Sky, 2026-09-09: "nothing checks whether SPIFF's numbers still agree with each other. The hourly
 * trigger measures and publishes; it never asks whether what it published reconciles."
 *
 * Each of these sat for weeks and would have been one line of this job:
 *   · the vendor email, PDF and gift-card list computing a per-unit program's credit with the FLAT
 *     formula — $28.50 against $181.50 owed, on a document headed "Credit due Green Cross"
 *   · a flat program's report ticking 18 people as hitting a target of zero
 *   · closed programs whose measured units still disagree with what the vendor was told
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING, and it is not the arithmetic. A daily report has two ways
 * to be useless, and the second is the one that gets a real finding missed:
 *
 *   1. IT MISSES A DISAGREEMENT. Grön (Sep 15–28 2025) is the live one: its snapshot adds up to
 *      $500 across 188 units and its record says $600 across 201. That is $100 on a program already
 *      reported to a vendor.
 *
 *   2. IT REPORTS THINGS NOBODY CAN ACT ON. Thirteen of the twenty-four closed programs cannot be
 *      compared at all — nine were never measured, four measured zero because stores refused. Sky's
 *      standing decision is that those historical records are not being retrofitted. Flagging them
 *      would put thirteen lines a day in the inbox forever, and an inbox you skim is how a stuck
 *      sweep ran for a week. So: counted, named, never flagged.
 *
 * And the third rule, which is Sky's and absolute: IT REPORTS, IT NEVER CORRECTS. These records
 * went to a vendor and were paid. The one thing worse than the drift is a job that rewrites them.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');

/* Programs as the sheet holds them, so listPrograms_ and rowToProgram_ do the reading. */
function row(o) {
  const r = PH.map(() => '');
  r[PH.indexOf('program_id')] = o.id;
  r[PH.indexOf('program_name')] = o.name || o.id;
  r[PH.indexOf('vendor')] = o.vendor || '';
  r[PH.indexOf('status')] = o.status || 'closed';
  r[PH.indexOf('start_date')] = o.start || '2025-09-15';
  r[PH.indexOf('end_date')] = o.end || '2025-09-28';
  r[PH.indexOf('payout_json')] = JSON.stringify(o.payout || { model: 'flat', amount: 25 });
  r[PH.indexOf('actual_json')] = o.actual === null ? '' : JSON.stringify(o.actual);
  r[PH.indexOf('progress_json')] = o.snap === null || o.snap === undefined ? '' : JSON.stringify(o.snap);
  return r;
}
/* A frozen snapshot: per store, per person, with `earned` already computed by the measurement —
   which is what makes it an INDEPENDENT second opinion on the record's own total. */
function snap(stores, partial, at) {
  return { at: at || '2025-09-29 02:00:00', partial: partial || [],
           stores: stores.map(s => ({ store_id: s[0], units: s[1],
             rows: (s[2] || []).map((e, i) => ({ name: 'BT ' + s[0] + i, employee_id: s[0] + i,
                                                 units: e[0], hit: e[1] > 0, earned: e[1] })) })) };
}

/* ── The clock, pinned where Los Angeles and UTC disagree ───────────────────────────────────────
 * `runPayoutAuditDaily_` stamps the once-a-day gate with today's date, and the suite's first date
 * convention says a calendar day is Los Angeles while an instant is UTC. This instant is
 * 22:30 on the 15th in Los Angeles and 05:30 on the 16th in UTC, so the two answers differ: the
 * engine's `Utilities.formatDate(new Date(), 'America/Los_Angeles', …)` yields 2026-09-15, and the
 * `new Date().toISOString().slice(0,10)` that this convention exists to forbid would yield
 * 2026-09-16. Asserting the LA day therefore FAILS if anyone reaches for the UTC shorthand.
 *
 * It is pinned rather than read off the wall clock, and that is the whole point of this block:
 * unpinned, the assertion below read `=== '2026-09-15'` against whatever day the suite happened to
 * run on. It passed on 2026-09-15 by coincidence, went red at the rollover to 2026-09-16 and
 * blocked a push — while proving nothing about the timezone on any of the days it was green,
 * because the code and the test were reading the same real clock through the same formatter.
 */
const AT_UTC = Date.parse('2026-09-16T05:30:00Z');   // = 2026-09-15 22:30 America/Los_Angeles
const LA_DAY = '2026-09-15';
function pinnedClock(at) {
  const R = Date;
  function D() { return arguments.length ? new R(...arguments) : new R(at); }
  D.prototype = R.prototype;          /* so `v instanceof Date` still holds inside the engine */
  D.now = () => at;
  D.parse = R.parse;
  D.UTC = R.UTC;
  return D;
}

function auditor(programs, opts) {
  const o = opts || {};
  const sheet = G.makeSheet(PH, programs.map(row));
  const notes = [];
  const props = G.makeProps(o.props || {});
  const logs = [];
  const api = G.load({
    real: ['auditClosedPayouts_', 'auditFingerprint_', 'runPayoutAuditDaily_', 'auditNoteTitle_',
           'auditNoteBody_', 'auditPayoutsWeb_', 'listPrograms_', 'rowToProgram_', 'moneyStr_',
           'textDate_', 'parseJson_', 'normalizePitch_', 'scrubSecrets_'],
    vars: ['PROGRAM_HEADERS', 'AUDIT_STATE_PROP', 'AUDIT_UNIT_PCT', 'AUDIT_UNIT_MIN',
           'GX_SECRET_PROP', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      dataSheet_: () => sheet,
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      nowStamp_: () => '2026-09-15 23:00:00',
    },
    globals: {
      Date: pinnedClock(o.at === undefined ? AT_UTC : o.at),
      PropertiesService: props.PropertiesService,
      console: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
      GXCore: { gxAddNote: (from, to, title, body, bugId, kind) => {
        if (o.noteThrows) throw new Error(o.noteThrows);
        notes.push({ from, to, title, body, kind });
        return { ok: true };
      } },
    },
  });
  return { api, sheet, notes, props, logs,
           /* What the sheet holds now — the report-never-correct claim is about these cells. */
           rowsNow: () => sheet.rows.slice(1).map(r => ({
             id: r[PH.indexOf('program_id')],
             actual: r[PH.indexOf('actual_json')],
             snap: r[PH.indexOf('progress_json')] })) };
}

/* ── The live History, in the shapes that matter ────────────────────────────────────────────────
   GRON is the real disagreement. PORTLAND is the one that reconciles to the cent. The rest are the
   thirteen that cannot be judged, one of each kind. */
/* Twenty people earned $25 each — $500 — across 188 units, against a record of $600 and 201.
   The snapshot also carries a STORED `earned` of 9999, deliberately wrong: the audit must recompute
   from what each person earned rather than trusting a total the measurement wrote down. */
function gronSnap() {
  const ten = (u) => Array.from({ length: 10 }, () => [u, 25]);
  const s = snap([['bend', 100, ten(10)], ['river-rd', 88, ten(9)]]);
  s.earned = 9999; s.units = 9999;
  return s;
}
const GRON = { id: 'gron-2025-09-15-2025-09-28', name: 'Grön chews', vendor: 'Grön',
               actual: { units_sold: 201, bts_hit: 24, spiff_amount: 25, investment: 600 },
               snap: gronSnap() };
const PORTLAND = { id: 'portland-heights-2026-08-17-2026-08-30', name: 'Portland Heights',
                   payout: { model: 'per_unit', amount: 0.75 },
                   actual: { units_sold: 242, bts_hit: 38, spiff_amount: 0.75, investment: 181.5 },
                   snap: snap([['river-rd', 242, [[142, 106.5], [100, 75]]]]) };
const NEVER_MEASURED = { id: 'meraki-gardens-2025-12-08-2025-12-21', name: 'Meraki December',
                         actual: { units_sold: 125, investment: 1350 }, snap: null };
const INCOMPLETE = { id: 'hellavated-2026-03-02-2026-03-15', name: 'Hellavated March',
                     actual: { units_sold: 825, investment: 775 },
                     snap: snap([['bend', 0, []]], ['river-rd', 'center']) };
const MEASURED_ZERO = { id: 'kaprikorn-2026-04-13-2026-04-26', name: 'Kaprikorn April',
                        actual: { units_sold: 687, investment: 775 },
                        snap: snap([['bend', 0, []]]) };
const NO_ACTUALS = { id: 'green-cross-2025-08-11-2025-08-17', name: 'Green Cross week',
                     actual: null, snap: snap([['river-rd', 40, [[40, 25]]]]) };
const ONE_UNIT_OFF = { id: 'hellavated-2026-03-16-2026-03-29', name: 'Hellavated late March',
                       actual: { units_sold: 649, investment: 300 },
                       snap: snap([['bend', 650, [[650, 300]]]]) };
const ALL = [GRON, PORTLAND, NEVER_MEASURED, INCOMPLETE, MEASURED_ZERO, NO_ACTUALS, ONE_UNIT_OFF,
             { id: 'running-now', status: 'active', actual: null,
               snap: snap([['bend', 10, [[10, 25]]]]) }];

/* ══════════════════ 1. IT FINDS THE ONE THAT DOES NOT ADD UP ══════════════════ */
{
  const a = auditor(ALL);
  const rep = a.api.auditClosedPayouts_();
  ok('it reads every CLOSED program and no others', rep.closed === 7);
  ok('Grön is flagged', rep.findings.length === 1 && rep.findings[0].program_id === GRON.id);
  const f = rep.findings[0];
  const pay = f.flags.filter(x => x.kind === 'payout')[0];
  ok('  …on the payout: $500 measured against $600 recorded',
     !!pay && pay.measured === 500 && pay.recorded === 600 && pay.gap === -100);
  const units = f.flags.filter(x => x.kind === 'units')[0];
  ok('  …and on the units: 188 against 201', !!units && units.measured === 188 && units.gap === -13);
  ok('  …naming the program and its window, not just an id',
     f.program_name === 'Grön chews' && f.window.join('→') === '2025-09-15→2025-09-28');
  ok('  …and when it was measured, so a stale snapshot is visible as one',
     f.measured_at === '2025-09-29');
  /* The snapshot carries `earned: 9999` and `units: 9999` of its own. Trusting either would make
     this a comparison of two stored numbers rather than a second opinion — and a stored total that
     was computed by the same wrong formula as the record is not evidence of anything. */
  ok('the payout is recomputed from what each PERSON earned, not from the snapshot\'s own total',
     pay.measured === 500 && pay.measured !== 9999);
  ok('  …and the units from the per-store figures, likewise', units.measured === 188);
  ok('a program that reconciles to the cent is not flagged',
     !rep.findings.some(x => x.program_id === PORTLAND.id));
  ok('  …including a per-unit one, where the flat formula would have been $1.50',
     rep.compared >= 2);
}

/* ══════════════════ 2. WHAT IT REFUSES TO JUDGE ══════════════════
   The thirteen historical records are a closed decision. Counted and named, never flagged. */
{
  const a = auditor(ALL);
  const rep = a.api.auditClosedPayouts_();
  const why = {};
  rep.not_comparable.forEach(x => { why[x.program_id] = x.why; });
  ok('a program that was never measured is not flagged', !rep.findings.some(x => x.program_id === NEVER_MEASURED.id));
  ok('  …it is counted, with the reason', /never measured/.test(why[NEVER_MEASURED.id] || ''));
  ok('an INCOMPLETE measurement is not compared — a refused store is not a zero',
     !rep.findings.some(x => x.program_id === INCOMPLETE.id)
     && /did not answer/.test(why[INCOMPLETE.id] || ''));
  ok('  …and the stores that refused are named', /river-rd, center/.test(why[INCOMPLETE.id] || ''));
  ok('a measurement of zero units is not compared — that is a filter fault, not a payout one',
     /filter matches nothing/.test(why[MEASURED_ZERO.id] || ''));
  ok('a program with no recorded actuals has nothing to disagree with',
     /no recorded actuals/.test(why[NO_ACTUALS.id] || ''));
  ok('every closed program is either compared or explained',
     rep.compared + rep.not_comparable.length === rep.closed);
  /* The unit threshold: 2% and at least 5 units. */
  ok('a one-unit difference is not worth anybody\'s morning',
     !rep.findings.some(x => x.program_id === ONE_UNIT_OFF.id));
}
{
  /* …but money is flagged at a cent, so a payout error cannot hide under the unit threshold. */
  const a = auditor([{ id: 'penny', actual: { units_sold: 100, investment: 25.02 },
                       snap: snap([['bend', 100, [[100, 25]]]]) }]);
  const rep = a.api.auditClosedPayouts_();
  ok('two cents of payout difference IS flagged, on a program whose units agree exactly',
     rep.findings.length === 1 && rep.findings[0].flags.length === 1
     && rep.findings[0].flags[0].kind === 'payout');
  const b = auditor([{ id: 'rounding', actual: { units_sold: 100, investment: 25.004 },
                       snap: snap([['bend', 100, [[100, 25]]]]) }]);
  ok('  …and a fraction of a cent is not', b.api.auditClosedPayouts_().findings.length === 0);
  const c = auditor([{ id: 'big', actual: { units_sold: 1000, investment: 250 },
                       snap: snap([['bend', 1015, [[1015, 250]]]]) }]);
  ok('15 units on a thousand is under 2% and passes',
     c.api.auditClosedPayouts_().findings.length === 0);
  const d = auditor([{ id: 'big2', actual: { units_sold: 1000, investment: 250 },
                       snap: snap([['bend', 1030, [[1030, 250]]]]) }]);
  ok('  …30 is over it and does not', d.api.auditClosedPayouts_().findings.length === 1);
}

/* ══════════════════ 3. IT REPORTS AND NEVER CORRECTS ══════════════════ */
{
  const a = auditor(ALL);
  const before = JSON.stringify(a.rowsNow());
  a.api.auditClosedPayouts_();
  a.api.runPayoutAuditDaily_();
  ok('not one cell is written — these records went to a vendor',
     JSON.stringify(a.rowsNow()) === before);
  ok('  …and the note says so in as many words',
     /NOTHING WAS CHANGED/.test(a.notes[0].body));
  ok('  …and tells the reader what clears it', /Fix the record and this clears itself/.test(a.notes[0].body));
}

/* ══════════════════ 4. IT SPEAKS ONLY WHEN SOMETHING CHANGED ══════════════════
   Sky, 2026-09-15: a note the first time, then quiet until the numbers move. A line you have
   already decided about teaches you to skim the inbox. */
{
  const a = auditor(ALL);
  const first = a.api.runPayoutAuditDaily_();
  ok('the first run notes the disagreement', first.noted === true && a.notes.length === 1);
  ok('  …addressed to this app\'s own inbox, as a question rather than an FYI',
     a.notes[0].from === 'spiff' && a.notes[0].to === 'spiff' && a.notes[0].kind === 'ask');
  ok('  …with the program in the title, so the inbox line means something on its own',
     /Grön chews/.test(a.notes[0].title));
  ok('  …and the numbers in the body, not a count and a route to go and run',
     /\$500/.test(a.notes[0].body) && /\$600/.test(a.notes[0].body)
     && /units: measured 188, recorded 201/.test(a.notes[0].body));
  ok('  …with 20 people named as having earned, so the $500 can be traced',
     /20 people earned/.test(a.notes[0].body));

  /* Same day again: the gate holds. */
  const same = a.api.runPayoutAuditDaily_();
  ok('a second run the same day does nothing at all',
     same.skipped === 'already ran today' && a.notes.length === 1);

  /* Next day, nothing changed: quiet. */
  const b = auditor(ALL, { props: { PAYOUT_AUDIT_STATE: JSON.stringify(
    { on: '2026-09-14', fp: a.api.auditFingerprint_(first.findings) }) } });
  const quiet = b.api.runPayoutAuditDaily_();
  ok('tomorrow, with the same disagreement, it writes no note',
     quiet.noted === false && quiet.unchanged === true && b.notes.length === 0);
  ok('  …but still says what it found, for anyone reading the log',
     quiet.findings.length === 1);

  /* The numbers MOVE — a partial correction, or a new record going wrong. Loud again. */
  const moved = auditor([Object.assign({}, GRON, {
    actual: { units_sold: 201, bts_hit: 24, spiff_amount: 25, investment: 550 } })],
    { props: { PAYOUT_AUDIT_STATE: JSON.stringify({ on: '2026-09-14', fp: 'gron-2025-09-15-2025-09-28:payout=-100,units=-13' }) } });
  const again = moved.api.runPayoutAuditDaily_();
  ok('a gap that CHANGED is reported again — a half-correction is not silence',
     again.noted === true && moved.notes.length === 1);

  /* Corrected: no findings, and the memory clears so a recurrence is loud. */
  const fixed = auditor([Object.assign({}, GRON, {
    actual: { units_sold: 188, bts_hit: 20, spiff_amount: 25, investment: 500 } })],
    { props: { PAYOUT_AUDIT_STATE: JSON.stringify({ on: '2026-09-14', fp: 'gron-2025-09-15-2025-09-28:payout=-100,units=-13' }) } });
  const clean = fixed.api.runPayoutAuditDaily_();
  ok('a corrected record produces no finding and no note',
     clean.findings.length === 0 && fixed.notes.length === 0);
  ok('  …and the remembered fingerprint is cleared, so a recurrence is loud again',
     JSON.parse(fixed.props.props.PAYOUT_AUDIT_STATE).fp === '');
}
{
  /* A note that could not be written must not be recorded as written, or the change is swallowed
     and tomorrow calls it unchanged. */
  const a = auditor(ALL, { noteThrows: 'GX Core is unreachable',
    props: { PAYOUT_AUDIT_STATE: JSON.stringify({ on: '2026-09-14', fp: '' }) } });
  const rep = a.api.runPayoutAuditDaily_();
  ok('a note that failed is reported as failed, not as written',
     rep.noted === false && /unreachable/.test(rep.note_error));
  ok('  …the fingerprint is left alone, so tomorrow tries again',
     JSON.parse(a.props.props.PAYOUT_AUDIT_STATE).fp === '');
  ok('  …while the DATE moves, so it retries tomorrow rather than every hour',
     JSON.parse(a.props.props.PAYOUT_AUDIT_STATE).on === LA_DAY);
  /* The clock is pinned at 22:30 Los Angeles / 05:30 UTC the next day, so the line above is also
     the timezone test: a UTC-derived day would stamp 2026-09-16 here, the gate would think it had
     already run, and the retry this block exists to guarantee would be skipped for the rest of the
     evening — seven hours a day, every day, and silently. */
  ok('  …and that date is the LOS ANGELES day, not the UTC one it is 05:30 on',
     LA_DAY !== G.Utilities.formatDate(new Date(AT_UTC), 'UTC', 'yyyy-MM-dd')
     && JSON.parse(a.props.props.PAYOUT_AUDIT_STATE).on
        === G.Utilities.formatDate(new Date(AT_UTC), 'America/Los_Angeles', 'yyyy-MM-dd'));
}
{
  /* An unreadable programs tab is not a clean bill of health. */
  const a = auditor(ALL);
  a.sheet.getRange = () => { throw new Error('sheet is locked'); };
  const rep = a.api.auditClosedPayouts_();
  ok('a failure to read refuses rather than reporting that everything reconciles',
     rep.ok === false && /could not read/.test(rep.error));
  ok('  …and the daily run does not write a note off a failed read',
     a.api.runPayoutAuditDaily_().ok === false && a.notes.length === 0);
}

/* ══════════════════ 5. THE ON-DEMAND ROUTE ══════════════════ */
{
  const a = auditor(ALL, { props: { GX_DEPLOY_SECRET: 'SEKRET' } });
  ok('a wrong secret gets nothing',
     a.api.auditPayoutsWeb_({ secret: 'nope' }).ok === false && a.notes.length === 0);
  const read = a.api.auditPayoutsWeb_({ secret: 'SEKRET' });
  ok('the plain read reports without noting anything',
     read.findings.length === 1 && a.notes.length === 0 && read.noted === undefined);
  const run = a.api.auditPayoutsWeb_({ secret: 'SEKRET', run: '1' });
  ok('run=1 performs the daily pass, note included', run.noted === true && a.notes.length === 1);
  const held = a.api.auditPayoutsWeb_({ secret: 'SEKRET', run: '1' });
  ok('  …and the once-a-day gate still holds against it', held.skipped === 'already ran today');
  const forced = a.api.auditPayoutsWeb_({ secret: 'SEKRET', run: '1', force: '1' });
  ok('  …unless forced', forced.skipped === undefined);
}
/* Reachability and the gate the router applies are the two things execution cannot see. */
ok('it is registered as a route', /case 'auditPayouts': out = auditPayoutsWeb_\(p\);/.test(G.GS));
/* Read as the PARSED list, not as a substring of the file: the declaration wraps over three lines
   and a comment near it naming the action would satisfy a regex that the list itself would not. */
const secretActions = G.grabVar('SECRET_ACTIONS');
ok('  …on the secret-only list, since it names programs and dollars',
   secretActions.indexOf('auditPayouts') >= 0);
ok('  …and not public', !/PUBLIC_ACTIONS[^\n]*auditPayouts/.test(G.GS));
/* Where it runs from: after the recorder, so a program recorded this hour is checked against the
   figure just written rather than the blank it had an hour ago. */
{
  const trig = G.grab('refreshSpiffProgressTrigger');
  ok('the hourly trigger runs it, after the actuals recorder',
     trig.indexOf('runPayoutAuditDaily_') > trig.indexOf('recordMeasuredActuals_'));
  ok('  …in its own try/catch, so a reconciliation that throws does not cost the refresh',
     /try \{ runPayoutAuditDaily_\(\); \}\s*\n\s*catch/.test(trig));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\npayout audit: all passed');
process.exit(fail ? 1 : 0);
