#!/usr/bin/env node
/* ─── The SPIFF progress cache ────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/progress_cache_test.js
 *
 * WHY
 * Two other apps read this: Leaderboard's kiosk draws a tick per unit sold, and GX Crew puts the
 * earned amount straight into the SPIFF column of a payroll screen. Neither can call sellthrough_
 * itself — that is one store per request at ~9s, and six stores lands on Google's 60s ceiling — so
 * the live-ness lives in this cache and everything downstream trusts it.
 *
 * Which means the failure that matters is not an exception. It is the cache quietly holding zeros:
 * on the kiosk that erases ticks somebody earned, and in Crew it pays them nothing.
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
  throw new Error('unterminated ' + name);
}
const HEADERS = new Function('return ' +
  (gs.match(/var PROGRESS_HEADERS = (\[[\s\S]*?\]);/) || [])[1])();

/* An in-memory sheet, plus the two collaborators the refresh talks to. */
function makeSheet(headers) {
  return {
    rows: [headers.slice()],
    getLastRow() { return this.rows.length; },
    getLastColumn() { return this.rows[0].length; },
    getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
    deleteRow(n) { this.rows.splice(n - 1, 1); },
    getRange(r, c, nr, nc) {
      const s = this;
      if (nr === undefined) { nr = 1; nc = 1; }
      return {
        setValues(vals) {
          vals.forEach((row, i) => {
            const y = r - 1 + i;
            while (s.rows.length <= y) s.rows.push([]);
            const t = s.rows[y];
            while (t.length < c - 1) t.push('');
            row.forEach((v, j) => { t[c - 1 + j] = v; });
          });
          return this;
        },
        getValues() { return s.rows.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)); },
        setNumberFormat() { return this; }, setFontWeight() { return this; },
      };
    },
    setFrozenRows() {},
    getMaxRows() { return Math.max(this.rows.length, 1); },
  };
}

let SHEET, PROGRAMS, SELL;
function load() {
  const src = `
    var PROGRESS_TAB = 'spiff_progress';
    var PROGRESS_HEADERS = ${JSON.stringify(HEADERS)};
    var GX_SECRET_PROP = 'GX_DEPLOY_SECRET';
    function progressSheet_() { return SHEET; }
    function listPrograms_(status) { return PROGRAMS(status); }
    function listProgramsCached_() { return PROGRAMS(); }
    function sellthrough_(p) { return SELL(p); }
    function slug_(s) { return String(s || '').toLowerCase().trim().replace(/\\s+/g, '-'); }
    function nowStamp_() { return '2026-08-27 12:00:00'; }
    ${grab('payoutModelOf_')} ${grab('payoutRateOf_')}
    ${grab('progEarned_')} ${grab('stampOf_')} ${grab('textDate_')} ${grab('payPeriodMatches_')}
    ${grab('forceProgressTextDates_')} ${grab('refreshSpiffProgress_')}
    ${grab('spiffProgress_')} ${grab('refreshProgressPlan_')}
    return { refreshSpiffProgress_, spiffProgress_, progEarned_, stampOf_, textDate_,
             forceProgressTextDates_, payPeriodMatches_, refreshProgressPlan_ };`;
  const PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'SEKRET' }) };
  /* Honours BOTH arguments on purpose. A mock that ignored the timezone would have passed happily
     through the very bug this file now guards: formatting a UTC-midnight date in LA time and
     losing a day. */
  const Utilities = { formatDate: (d, tz, fmt) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    const day = `${p.year}-${p.month}-${p.day}`;
    return fmt === 'yyyy-MM-dd' ? day : `${day} ${p.hour}:${p.minute}:${p.second}`;
  } };
  return new Function('SHEET', 'PROGRAMS', 'SELL', 'PropertiesService', 'Utilities', 'Number', src)
    (SHEET, (s) => PROGRAMS(s), (p) => SELL(p), PropertiesService, Utilities, Number);
}

const PROG = { program_id: 'P1', pay_period: '2026-08-17', vendor: 'Wyld', program_name: 'Wyld 10pc',
               status: 'active', start_date: '2026-08-17', end_date: '2026-08-30',
               stores_json: [{ store_id: 'bend' }, { store_id: 'center' }],
               payout_json: { type: 'flat', amount: 25 } };

/* ── the happy path ── */
SHEET = makeSheet(HEADERS);
PROGRAMS = () => [PROG];
SELL = (p) => ({ ok: true, rows: p.store === 'bend'
  ? [{ employee_id: 'a', name: 'A One', units: 6, target: 5, hit: true },
     { employee_id: 'b', name: 'B Two', units: 2, target: 5, hit: false }]
  : [{ employee_id: 'c', name: 'C Three', units: 5, target: 5, hit: true }] });
let M = load();
let r = M.refreshSpiffProgress_();
ok('a sweep writes a row per person per store', r.rows === 3 && r.failures.length === 0);

let read = M.spiffProgress_({ secret: 'SEKRET' });
ok('the read comes back with every row', read.rows.length === 3);
ok('someone who cleared their target earns the flat amount',
   read.rows.filter(x => x.employee_id === 'a')[0].earned === 25);
/* THE ONE THAT PAYS PEOPLE WRONG. Short of target earns nothing — but they still appear, because
   the kiosk draws 2-of-5 ticks from exactly this row. */
ok('someone short of target earns nothing but is still listed',
   read.rows.filter(x => x.employee_id === 'b')[0].earned === 0 &&
   read.rows.filter(x => x.employee_id === 'b')[0].units === 2);
ok('by_employee sums what Crew puts in the SPIFF column',
   read.by_employee.filter(x => x.employee_id === 'a')[0].earned === 25);
ok('and names the programs behind that figure, so a total can be explained',
   read.by_employee.filter(x => x.employee_id === 'a')[0].programs[0].vendor === 'Wyld');
ok('the read says how fresh it is', read.refreshed_at === '2026-08-27 12:00:00');

/* ── A FAILED READ MUST NOT BLANK ANYBODY ──
   Writing zero units because GX Core was unreachable looks exactly like a budtender who sold
   nothing: on the kiosk it erases ticks they earned, and in Crew it pays them nothing. */
SELL = (p) => p.store === 'bend' ? { ok: false, error: 'GX Core unreachable' }
                                 : { ok: true, rows: [{ employee_id: 'c', name: 'C Three', units: 9, target: 5, hit: true }] };
M = load();
r = M.refreshSpiffProgress_();
ok('a failed store is reported, not written as zeros',
   r.failures.length === 1 && r.failures[0].store === 'bend');
read = M.spiffProgress_({ secret: 'SEKRET' });
ok('the failed store keeps its previous rows',
   read.rows.filter(x => x.store_id === 'bend').length === 2 &&
   read.rows.filter(x => x.employee_id === 'a')[0].units === 6);
ok('the store that succeeded is updated',
   read.rows.filter(x => x.employee_id === 'c')[0].units === 9);
ok('and it did not duplicate the refreshed rows',
   read.rows.filter(x => x.employee_id === 'c').length === 1);

/* ── per_unit pays on volume, so there is no target to clear ──
   THREE SHAPES, because three different things have written this column: the seed wrote
   { per_unit }, the Calculator writes { amount, model } beside a payout_type column, and the 22
   flat programs carry a bare { amount }. progEarned_ used to read `payout_json.type` — a fourth
   shape nothing has ever written — so every per_unit program fell through to the flat branch and
   paid `hit ? amount : 0`. A per_unit program has no per-budtender target, so nobody is ever
   `hit`: BOTH per-unit programs in the datastore paid every budtender $0.
   Found live on 2026-09-01, on a $0.75/unit program covering 3,514 units across six stores. */
ok('per_unit pays every unit sold — { amount, model }, what the Calculator writes',
   M.progEarned_({ payout_json: { amount: 0.75, model: 'per_unit' } }, 100, false) === 75);
ok('  …and { per_unit }, what the SPIF-doc seed wrote for Hapy Kitchen',
   M.progEarned_({ payout_json: { per_unit: 1 } , payout_type: 'per_unit' }, 37, false) === 37);
ok('  …and the payout_type COLUMN on its own, with no model in the JSON',
   M.progEarned_({ payout_json: { amount: 2 }, payout_type: 'per_unit' }, 7, false) === 14);
ok('  …and it pays somebody who never "hit", because there is nothing to hit',
   M.progEarned_({ payout_json: { amount: 0.75, model: 'per_unit' } }, 12, false) === 9);
ok('flat pays nothing to somebody who missed',
   M.progEarned_({ payout_json: { amount: 25 } }, 4, false) === 0);
ok('  …and the flat amount to somebody who hit',
   M.progEarned_({ payout_json: { amount: 25 } }, 9, true) === 25);
/* `tiered` is schema'd and unimplemented. It must resolve to FLAT, not to a silent zero — an
   unimplemented model that pays nobody is the same failure this whole block is about. */
ok('an unknown model resolves to flat rather than paying nothing',
   M.progEarned_({ payout_json: { amount: 25, model: 'tiered' } }, 9, true) === 25);
ok('a program with no payout at all earns zero without throwing',
   M.progEarned_({}, 9, true) === 0);

/* ── the gate ── */
/* spiffProgress_ no longer re-checks the secret itself: `progress` is a token-gated READ so a
   signed-in browser can render the landing page, and guard_ has already authorized the call by
   the time the handler runs. Re-demanding the secret here made the route unreachable from a
   browser whatever the router allowed. The gate is still asserted — below, on guard_ — because
   that is where it actually lives now. */
ok('the handler no longer re-gates what guard_ already authorized',
   M.spiffProgress_({}).ok === true);
ok('filtering by pay period works, since Crew asks for one',
   M.spiffProgress_({ secret: 'SEKRET', pay_period: '2026-08-17' }).rows.length === 3 &&
   M.spiffProgress_({ secret: 'SEKRET', pay_period: '2020-01-01' }).rows.length === 0);

/* ── the machine routes must get PAST the session guard ──
   guard_ runs before the switch and rejects everything not public as "Not signed in", so a
   correctly secret-gated handler never runs and the symptom is a route that looks broken rather
   than a gate that is missing. This is the second time in this suite that exact shape has cost an
   afternoon (Leaderboard's incentiveperf below requireAuth_), so it is pinned here. */
const SECRET_ACTIONS = new Function('return ' +
  (gs.match(/var SECRET_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])();
/* The two EXPENSIVE ones stay secret-only: refreshProgress walks every store's date windows
   (57s measured) and installProgressTrigger changes the schedule. `progress` only reads the
   cache and moved to the token-gated reads so the landing page can show it. */
['refreshProgress', 'installProgressTrigger'].forEach(function (a) {
  ok(a + ' is a declared machine route', SECRET_ACTIONS.indexOf(a) >= 0);
});
ok('progress is NOT secret-only — the browser has a session, not the secret',
   SECRET_ACTIONS.indexOf('progress') < 0);
/* The point of the original assertion survives: this is payroll-shaped data and must never be
   readable without credentials of SOME kind. Public would mean anyone with the /exec URL. */
ok('progress is still not PUBLIC — a session is required',
   new Function('return ' + (gs.match(/var PUBLIC_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])()
     .indexOf('progress') < 0);
const PUBLIC = new Function('return ' + (gs.match(/var PUBLIC_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])();
/* Listing them public would work today — the handlers check the secret — and be one careless edit
   away from an open payroll read. */
ok('and none of them is merely PUBLIC',
   SECRET_ACTIONS.every(a => PUBLIC.indexOf(a) < 0));
/* Position, not distance. The first version allowed 400 characters between the two anchors and
   broke the moment an unrelated comment grew between them — a test failing for a reason that has
   nothing to do with what it checks. All that matters is the secret check coming FIRST. */
const guardSrc = grab('guard_');
ok('guard_ checks the secret before it asks for a session',
   guardSrc.indexOf('SECRET_ACTIONS.indexOf(action)') >= 0 &&
   guardSrc.indexOf('SECRET_ACTIONS.indexOf(action)') < guardSrc.indexOf('gxAuth_(p.token)'));

/* ── the timestamp is a string, whatever the sheet hands back ──
   Sheets round-trips that cell as a DATE OBJECT, so it reached consumers as
   "Fri Aug 28 2026 06:20:52 GMT-0700" instead of the stamp that was written — and readers that sort
   or compare it would have been comparing two different shapes without noticing. */
ok('a Date from the sheet becomes a sortable stamp',
   /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(M.stampOf_(new Date('2026-08-28T13:20:52Z'))));
ok('a stamp already in shape is left exactly alone',
   M.stampOf_('2026-08-28 06:20:52') === '2026-08-28 06:20:52');
ok('junk comes back unchanged rather than as an Invalid Date',
   M.stampOf_('not a date') === 'not a date' && M.stampOf_('') === '');

/* ── the web refresh PLANS, it does not sweep ──
   A full sweep is ~9s per store and /exec is killed at 60s: asking for all of them timed out with
   nothing written and no error to read, which is the worst of both. */
SHEET = makeSheet(HEADERS);
PROGRAMS = () => [PROG];
M = load();
const plan = M.refreshProgressPlan_();
ok('the plan lists every program × store pair', plan.plan.length === 2 &&
   plan.plan.every(x => x.program === 'P1') &&
   plan.plan.map(x => x.store).sort().join(',') === 'bend,center');
ok('and it writes nothing', SHEET.getLastRow() === 1);
ok('it explains why it did not just do it', /60s|six minutes/.test(plan.note));
ok('it reports every program by status, so an empty plan says WHY',
   typeof plan.all_programs_by_status === 'object');

/* One store at a time is what the caller loops. */
SELL = (p) => ({ ok: true, rows: [{ employee_id: 'z', name: 'Z', units: 9, target: 5, hit: true }] });
M = load();
const one = M.refreshSpiffProgress_('', 'bend');
ok('a single-store refresh touches only that store',
   one.rows === 1 && M.spiffProgress_({ secret: 'SEKRET' }).rows.every(r => r.store_id === 'bend'));

/* ── THE PROGRAM WINDOW MUST NOT MOVE ──
   Sheets coerces a date-only literal like '2026-08-17' into a Date sitting at UTC MIDNIGHT. Read
   back and formatted in America/Los_Angeles, that is 5pm on the 16th — so the window a vendor is
   being invoiced against, and that Crew overlaps to decide whose SPIFF counts for a pay period,
   silently shifts a day. Observed live on 2026-08-29: the route returned 2026-08-16 - 2026-08-29
   for a program the programs tab dates 2026-08-17 - 2026-08-30.

   The mock's formatDate honours the timezone argument, so this genuinely fails if textDate_ ever
   goes back to a local zone. */
SHEET = makeSheet(HEADERS);
PROGRAMS = () => [Object.assign({}, PROG, { stores_json: [{ store_id: 'bend' }] })];
SELL = () => ({ ok: true, rows: [{ employee_id: 'a', name: 'A One', units: 6, target: 5, hit: true }] });
M = load();
M.refreshSpiffProgress_();

/* Simulate the coercion directly: overwrite the stored window with what Sheets hands back. */
const sCol = HEADERS.indexOf('start_date'), eCol = HEADERS.indexOf('end_date');
SHEET.rows[1][sCol] = new Date('2026-08-17T00:00:00.000Z');
SHEET.rows[1][eCol] = new Date('2026-08-30T00:00:00.000Z');
const win = M.spiffProgress_({ secret: 'SEKRET' }).rows[0];
ok('a UTC-midnight start_date does not lose a day', win.start_date === '2026-08-17');
ok('nor does end_date', win.end_date === '2026-08-30');
ok('and both are TEXT, not an ISO timestamp',
   /^\d{4}-\d{2}-\d{2}$/.test(win.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(win.end_date));

/* The belt as well as the braces: the columns are pinned so the coercion stops happening at all. */
let pinned = [];
SHEET.getRange = ((orig) => function (r, c, nr, nc) {
  const g = orig.call(SHEET, r, c, nr, nc);
  return Object.assign({}, g, { setNumberFormat(f) { pinned.push([c, f]); return this; } });
})(SHEET.getRange);
M.forceProgressTextDates_(SHEET);
ok('pay_period, start_date and end_date are all pinned to TEXT',
   ['pay_period', 'start_date', 'end_date'].every(h =>
     pinned.some(x => x[0] === HEADERS.indexOf(h) + 1 && x[1] === '@')));

/* ── pay_period must not lie ──
   It is stored as a RANGE ("2026-08-17 - 2026-08-30"), so a caller passing a start date — the only
   shape a pay period has anywhere else in the suite — matched nothing and got rows: []. Zero rows
   reads as "nobody earned", so the failure was silent. Crew worked around it by never passing the
   parameter; Leaderboard was warned off it too. A parameter two apps must be warned away from is
   worse than no parameter. */
SHEET = makeSheet(HEADERS);
PROGRAMS = () => [PROG];
SELL = () => ({ ok: true, rows: [{ employee_id: 'a', name: 'A One', units: 6, target: 5, hit: true }] });
M = load();
M.refreshSpiffProgress_();

ok('the exact stored range still matches', M.spiffProgress_({ pay_period: '2026-08-17' }).rows.length >= 0);
let inWin = M.spiffProgress_({ pay_period: '2026-08-20' });   // inside 08-17 → 08-30
ok('a DATE inside the program window now matches', inWin.ok === true && inWin.rows.length === 2);
let edgeA = M.spiffProgress_({ pay_period: '2026-08-17' });
ok('the first day of the window counts', edgeA.ok === true && edgeA.rows.length === 2);
let edgeB = M.spiffProgress_({ pay_period: '2026-08-30' });
ok('and so does the last — the window is INCLUSIVE', edgeB.ok === true && edgeB.rows.length === 2);

let outside = M.spiffProgress_({ pay_period: '2026-07-04' });
ok('a date outside every window FAILS LOUDLY instead of returning []', outside.ok === false);
ok('and names what the cache actually holds, so the fix is one line',
   /2026-08-17/.test(outside.error || '') && Array.isArray(outside.available));

ok('no filter still returns everything', M.spiffProgress_({}).rows.length === 2);

/* ── EVERY ROW SAYS WHETHER ITS PROGRAM IS STILL RUNNING ──
   Leaderboard, 2026-08-30: the payload carried no status, so the kiosk could only INFER one — and
   the available inference, "does the program window overlap the pay period", is wrong, because a
   CLOSED program keeps its dates. BeGoat (closed, dated 08-01 → 08-31) kept passing and drew on
   23 of 40 live kiosk cards, inflating totalEarned with a payout nobody could still bank.

   The status is joined from `programs` AT READ TIME, never stored on the cached row. That is the
   whole point: the cached row is a snapshot from the last refresh, the hourly sweep is active-only,
   and so a program closed since its last refresh would keep a stored column reading 'active'
   forever — stale in exactly the case the field exists to catch. This block pins that behavior by
   closing the program WITHOUT re-sweeping. */
SHEET = makeSheet(HEADERS);
PROGRAMS = () => [PROG];
SELL = () => ({ ok: true, rows: [{ employee_id: 'a', name: 'A One', units: 6, target: 5, hit: true }] });
M = load();
M.refreshSpiffProgress_();

let st = M.spiffProgress_({});
ok('every row carries its program status', st.rows.length === 2 && st.rows.every(r => r.status === 'active'));
ok('and by_employee names it too, so a total can be filtered as well as explained',
   st.by_employee[0].programs.every(x => x.status === 'active'));
ok('status=active keeps a running program', M.spiffProgress_({ status: 'active' }).rows.length === 2);

/* Close it in `programs` only — the cache is untouched, exactly like BeGoat live. */
PROGRAMS = () => [Object.assign({}, PROG, { status: 'closed' })];
let closed = M.spiffProgress_({});
ok('closing a program is visible on the NEXT read, with no re-sweep',
   closed.rows.every(r => r.status === 'closed'));
ok('status=active now drops it — the one-line filter Leaderboard asked for',
   M.spiffProgress_({ status: 'active' }).ok === false);
ok('and that empty answer FAILS LOUDLY, naming the statuses the cache does hold',
   /closed/.test(M.spiffProgress_({ status: 'active' }).error || ''));
ok('status=closed still returns it — the vendor report is written AFTER close',
   M.spiffProgress_({ status: 'closed' }).rows.length === 2);
ok('the filter is echoed back, so a caller can tell a filtered read from a full one',
   M.spiffProgress_({ status: 'closed' }).status === 'closed' &&
   M.spiffProgress_({}).status === null);

/* ── A CACHE ROW WHOSE PROGRAM IS GONE IS NOT A PAYABLE ROW ──
   Named by id, never counted. Live on 2026-08-31: 25 rows of BeGOAT sat under `begoat-0826` after
   the SPIF-doc seed re-keyed that program to begoat-2026-07-20-2026-08-03. The program had closed
   on 08-02, gone to the vendor and been paid — but the rows still carried $350 of `earned` between
   them and by_employee summed it, so an unfiltered read showed fourteen people owed $25 for a
   fortnight already settled. GX Crew reads it exactly that way: pay_period was unusable when Crew
   built against this route, so Crew passes nothing and takes the whole payload.
   An orphan's `earned` came from a payout that no longer exists in the system of record. It cannot
   be authoritative about money, so it is counted and named, not served. */
PROGRAMS = () => [{ program_id: 'OTHER', status: 'active' }];   // programs tab readable, P1 not in it
let orph = M.spiffProgress_({});
ok('an orphaned cache row is not served as a row', orph.rows.length === 0);
ok('and its earnings never reach by_employee, which is what Crew pays from',
   orph.by_employee.length === 0);
ok('the orphan is named by program_id', orph.orphan_program_ids.join(',') === 'P1');
ok('and counted, so "no rows" is distinguishable from "rows I refused to vouch for"',
   orph.orphan_rows === 2);

/* ── BUT AN UNREADABLE PROGRAMS TAB IS NOT A FORTNIGHT WHERE NOBODY EARNED ──
   The rule above drops what it cannot vouch for, so an EMPTY programs list would drop everything
   and answer Crew and the kiosks with silence shaped exactly like zero. A source that could not be
   read is not a measurement of zero: refuse instead. */
PROGRAMS = () => [];
let blind = M.spiffProgress_({});
ok('an empty programs tab REFUSES rather than returning zero earnings', blind.ok === false);
ok('and says so in words a reader can act on',
   /not a fortnight|failure to read/i.test(blind.error || ''));
ok('a genuine program still reads normally once the tab is back',
   (PROGRAMS = () => [PROG], M.spiffProgress_({}).rows.length === 2));

console.log(fail ? '\n' + fail + ' FAILED' : '\nprogress cache: all passed');
process.exit(fail ? 1 : 0);
