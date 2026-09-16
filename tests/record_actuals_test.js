#!/usr/bin/env node
/* ─── A closed program's actuals are recorded from its close-out measurement, automatically ───────
 *
 *   RUN:  node tests/record_actuals_test.js
 *
 * WHY
 * Sky, 2026-09-15: "we should automate the pull from dutchie after a program has closed, we shouldn't
 * rely on a human to remember that." The Mule Dank Tank program closed, was measured (168 units, 20
 * budtenders, $500), and sat with no recorded actuals, so History, the vendor report and every total
 * read zero.
 *
 * The four refusals below are the part that matters — each is a failure this app has already had.
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
const fromSnap = new Function('payoutRateOf_', 'nowStamp_', grab('actualsFromSnapshot_') + 'return actualsFromSnapshot_;')(
  p => Number((p.payout_json || {}).amount) || 0, () => '2026-09-15 14:00:00');

/* The live record, 2026-09-15. */
const MULE = {
  program_id: 'mule-extracts-2026-08-31-2026-09-13', status: 'closed', actual_json: null,
  payout_json: { amount: 25, model: 'flat' }, cost_json: { per_unit: 20 }, baseline_json: { units: 115 },
  progress_json: { at: '2026-09-14 00:56:09', units: 168, earners: 20, earned: 500, rate: 25, partial: [],
                   stores: [{ store_id: 'bend', units: 43 }] },
};
const with_ = (o) => Object.assign({}, MULE, o);

let r = fromSnap(MULE);
ok('the Mule program gets actuals: 168 units, 20 hit, $25, $500 paid', r.actual && r.actual.units_sold === 168
   && r.actual.bts_hit === 20 && r.actual.spiff_amount === 25 && r.actual.investment === 500);
ok('  …revenue is units × cost ($3,360)', r.actual.revenue === 3360);
ok('  …ROI by the Calculator identity: (168 − 115) × $20 − $500 = $560', r.actual.roi === 560);
ok('  …ROI % is ROI over what was paid (1.12)', r.actual.roi_pct === 1.12);
ok('  …and it says a measurement wrote it, not a person', r.actual.source === 'measured' && r.actual.measured_at === '2026-09-14 00:56:09');

r = fromSnap(with_({ actual_json: { units_sold: 170, bts_hit: 21 } }));
ok('RECORDED actuals are never overwritten — they may already be on a vendor report', !r.actual && r.skip === 'already recorded');
r = fromSnap(with_({ progress_json: Object.assign({}, MULE.progress_json, { partial: ['river-rd'] }) }));
ok('a PARTIAL measurement is not recorded, and is handed to a person by name', !r.actual && /river-rd/.test(r.person));
r = fromSnap(with_({ progress_json: Object.assign({}, MULE.progress_json, { units: 0, earners: 0, earned: 0 }) }));
ok('a measurement of ZERO units is not recorded — it is usually a filter matching nothing', !r.actual && /zero/.test(r.person));
r = fromSnap(with_({ status: 'draft' }));
ok('a DRAFT whose window passed is left to a person', !r.actual && !r.person);
r = fromSnap(with_({ progress_json: null }));
ok('a closed program not measured yet waits for the freeze', !r.actual && r.skip === 'not measured yet');
r = fromSnap(with_({ actual_json: {} }));
ok('an EMPTY actuals object counts as not recorded', !!r.actual);

const perUnit = fromSnap(with_({ payout_json: { amount: 1, model: 'per_unit' },
  progress_json: Object.assign({}, MULE.progress_json, { rate: 1, earned: 168, earners: 31 }) }));
ok('a per-unit program pays what the measurement earned (168 × $1)', perUnit.actual.investment === 168 && perUnit.actual.bts_hit === 31);

/* ── THE SWEEP THAT WRITES THEM ──────────────────────────────────────────────────────────────────
   REWRITTEN 2026-09-15. The arithmetic above was always run; the sweep around it was read —
   `/if \(apply\) sh\.getRange/` proves the guard is typed, not that a dry run leaves the sheet
   alone, and "dry by default" is the only thing standing between a preview and a write onto rows
   that may already be on a vendor report. */
const G = require('./_gas');
const PH = G.grabVar('PROGRAM_HEADERS');

function progRow(o) {
  const r = PH.map(() => '');
  r[PH.indexOf('program_id')] = o.program_id;
  r[PH.indexOf('program_name')] = o.program_id;
  r[PH.indexOf('status')] = o.status || 'closed';
  r[PH.indexOf('start_date')] = '2026-08-31';
  r[PH.indexOf('end_date')] = '2026-09-13';
  r[PH.indexOf('payout_json')] = JSON.stringify(o.payout_json || MULE.payout_json);
  r[PH.indexOf('cost_json')] = JSON.stringify(o.cost_json || MULE.cost_json);
  r[PH.indexOf('baseline_json')] = JSON.stringify(o.baseline_json || MULE.baseline_json);
  r[PH.indexOf('actual_json')] = o.actual_json ? JSON.stringify(o.actual_json) : '';
  r[PH.indexOf('progress_json')] = o.progress_json === null ? ''
    : JSON.stringify(o.progress_json || MULE.progress_json);
  r[PH.indexOf('edited_by')] = 'tawny';
  r[PH.indexOf('edited_at')] = '2026-09-10 11:00:00';
  return r;
}
function recorder(programs) {
  const sheet = G.makeSheet(PH, programs.map(progRow));
  const cache = G.makeCache();
  const api = G.load({
    real: ['recordMeasuredActuals_', 'actualsFromSnapshot_', 'rowToProgram_', 'payoutRateOf_',
           'payoutModelOf_', 'textDate_', 'parseJson_', 'normalizePitch_', 'invalidatePrograms_'],
    vars: ['PROGRAM_HEADERS', 'PROGRAMS_CACHE_KEY', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: { dataSheet_: () => sheet, nowStamp_: () => '2026-09-15 14:00:00' },
    globals: { CacheService: cache.CacheService },
  });
  return { api, sheet, cache,
           actualsOf: (id) => {
             const row = sheet.rows.find(x => x[PH.indexOf('program_id')] === id);
             const cell = row && row[PH.indexOf('actual_json')];
             return cell ? JSON.parse(cell) : null;
           },
           editedBy: (id) => sheet.rows.find(x => x[PH.indexOf('program_id')] === id)[PH.indexOf('edited_by')] };
}

/* Four programs, one of each kind the sweep has to tell apart. */
const FOUR = [
  { program_id: 'mule' },                                                   // measured, unrecorded
  { program_id: 'already', actual_json: { units_sold: 170, bts_hit: 21 } },  // hand-corrected
  { program_id: 'partial', progress_json: Object.assign({}, MULE.progress_json, { partial: ['river-rd'] }) },
  { program_id: 'zero', progress_json: Object.assign({}, MULE.progress_json, { units: 0, earners: 0, earned: 0 }) },
];

{
  const s = recorder(FOUR);
  const dry = s.api.recordMeasuredActuals_({});
  ok('dry by default: it says what it WOULD record', dry.dry === true && dry.recorded.length === 1
     && dry.recorded[0].program_id === 'mule');
  ok('  …and writes nothing at all', s.actualsOf('mule') === null);
  ok('  …while naming what needs a person, and why',
     dry.needs_person.map(x => x.program_id).sort().join(',') === 'partial,zero'
     && /river-rd/.test(dry.needs_person.filter(x => x.program_id === 'partial')[0].why));
  ok('  …and leaving a hand-corrected record out of both lists',
     !dry.recorded.some(x => x.program_id === 'already')
     && !dry.needs_person.some(x => x.program_id === 'already'));
}
{
  const s = recorder(FOUR);
  const res = s.api.recordMeasuredActuals_({ apply: true });
  ok('applied, the measured program gets its actuals', res.dry === false
     && s.actualsOf('mule').units_sold === 168 && s.actualsOf('mule').investment === 500);
  ok('  …tagged as measured, with when the measurement ran',
     s.actualsOf('mule').source === 'measured' && s.actualsOf('mule').measured_at === '2026-09-14 00:56:09');
  /* NEVER OVERWRITES: those figures may already be on a vendor report. */
  ok('a record that already has actuals is left exactly as it was',
     s.actualsOf('already').units_sold === 170 && s.actualsOf('already').bts_hit === 21);
  ok('a partial measurement writes nothing — a refused store is not a zero',
     s.actualsOf('partial') === null);
  ok('a measurement of zero units writes nothing either', s.actualsOf('zero') === null);
  /* ONE CELL. A measurement is not an edit by the person who last corrected the record. */
  ok('who last edited the record is untouched', s.editedBy('mule') === 'tawny');
  ok('the programs cache is busted, so the screens show it at once',
     s.cache.removed.indexOf(G.grabVar('PROGRAMS_CACHE_KEY')) >= 0);
}
{
  const s = recorder(FOUR);
  s.api.recordMeasuredActuals_({ apply: true, program: 'mule' });
  ok('one program can be recorded on its own', s.actualsOf('mule') !== null);
  const s2 = recorder(FOUR);
  const r2 = s2.api.recordMeasuredActuals_({ apply: true, program: 'nobody' });
  ok('  …and an id that matches nothing records nothing, quietly',
     r2.ok === true && r2.recorded.length === 0 && s2.actualsOf('mule') === null);
}
{
  const s = recorder([{ program_id: 'mule' }]);
  s.api.recordMeasuredActuals_({ apply: true });
  const twice = s.api.recordMeasuredActuals_({ apply: true });
  ok('running it twice records once — the second pass sees actuals and stands down',
     twice.recorded.length === 0);
}
{
  const s = recorder([{ program_id: 'stale-draft', status: 'draft' }]);
  const r = s.api.recordMeasuredActuals_({ apply: true });
  ok('a stale draft is left alone entirely, and not reported as needing a person',
     r.recorded.length === 0 && r.needs_person.length === 0 && s.actualsOf('stale-draft') === null);
}
/* Where it runs from. Both are wiring rather than computation: the trigger's ORDER (freeze, then
   record, then refresh) and the route's gate live in functions whose other halves reach Google. */
ok('the hourly trigger records, straight after the freeze and before the refresh',
   /snapshot failed[\s\S]*recordMeasuredActuals_\(\{ apply: true \}\)[\s\S]*refreshSpiffProgress_\(\)/
     .test(G.grab('refreshSpiffProgressTrigger')));
/* Read as the PARSED list. This was `/'recordActuals'\];/` — the action followed by the closing
   bracket — which stopped being true the moment another action was appended after it (auditPayouts,
   2026-09-15). The claim is membership, not position. */
ok('the on-demand route is on the secret-only list',
   G.grabVar('SECRET_ACTIONS').indexOf('recordActuals') >= 0);
ok('  …and is dry unless asked',
   /apply: String\(p\.apply \|\| ''\) === '1'/.test(G.grab('recordActualsWeb_')));

console.log(fail ? '\n' + fail + ' FAILED' : '\nrecord actuals: all passed');
process.exit(fail ? 1 : 0);
