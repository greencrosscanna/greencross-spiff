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
    function sellthrough_(p) { return SELL(p); }
    function slug_(s) { return String(s || '').toLowerCase().trim().replace(/\\s+/g, '-'); }
    function nowStamp_() { return '2026-08-27 12:00:00'; }
    ${grab('progEarned_')} ${grab('refreshSpiffProgress_')} ${grab('spiffProgress_')}
    return { refreshSpiffProgress_, spiffProgress_, progEarned_ };`;
  const PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'SEKRET' }) };
  return new Function('SHEET', 'PROGRAMS', 'SELL', 'PropertiesService', 'Number', src)
    (SHEET, (s) => PROGRAMS(s), (p) => SELL(p), PropertiesService, Number);
}

const PROG = { program_id: 'P1', pay_period: '2026-08-17', vendor: 'Wyld', program_name: 'Wyld 10pc',
               start_date: '2026-08-17', end_date: '2026-08-30',
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

/* ── per_unit pays on volume, so there is no target to clear ── */
ok('per_unit pays every unit sold',
   M.progEarned_({ payout_json: { type: 'per_unit', per_unit: 2 } }, 7, false) === 14);
ok('flat pays nothing to somebody who missed',
   M.progEarned_({ payout_json: { type: 'flat', amount: 25 } }, 4, false) === 0);

/* ── the gate ── */
ok('a wrong secret is refused', M.spiffProgress_({ secret: 'nope' }).ok === false);
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
['progress', 'refreshProgress', 'installProgressTrigger'].forEach(function (a) {
  ok(a + ' is a declared machine route', SECRET_ACTIONS.indexOf(a) >= 0);
});
const PUBLIC = new Function('return ' + (gs.match(/var PUBLIC_ACTIONS = (\[[\s\S]*?\]);/) || [])[1])();
/* Listing them public would work today — the handlers check the secret — and be one careless edit
   away from an open payroll read. */
ok('and none of them is merely PUBLIC',
   SECRET_ACTIONS.every(a => PUBLIC.indexOf(a) < 0));
ok('guard_ checks the secret before it asks for a session',
   /SECRET_ACTIONS\.indexOf\(action\)[\s\S]{0,400}gxAuth_\(p\.token\)/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\nprogress cache: all passed');
process.exit(fail ? 1 : 0);
