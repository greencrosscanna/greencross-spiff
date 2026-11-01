#!/usr/bin/env node
/* ─── Pay does not move: the marketing column changes nothing anybody is paid from ────────────────
 *
 *   RUN:  node tests/marketing_pay_isolation_test.js
 *
 * SPIFF feeds Crew's payroll and the kiosks. Pushing the engine is a live change, because the hourly
 * job runs whatever was pushed last, so this runs the REAL routes twice over the same programs: once
 * with an empty marketing cell, once with a full plan including every field it can hold. Each answer
 * must be identical to the character, and must not carry any of the plan's words anywhere.
 *
 *   · ?action=progress          what Crew's incentive approval reads
 *   · the publication to Core   what the kiosks and Crew's screen read
 *   · the hourly sweep          what writes the figures both of those serve
 *   · the status roll           which programs are running at all
 *
 * PENCILED BRANDS get the same treatment (phase 2). A pencil is a brand holding a calendar slot, kept
 * in its own `pencils` tab precisely so that nothing which reads programs can see one. Here every one
 * of the routes above runs with a pencil whose start date has already passed sitting in that tab, the
 * tab's accessors are rigged to fail the test if anything pay-shaped touches them, and the source of
 * every pay, publication, kiosk and boot function is checked for the word.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const col = (n) => PH.indexOf(n);

const MARKER = 'MARKETING-CANARY';
const FULL_PLAN = JSON.stringify({
  v: 1, stores: ['bend'], sel: { email: true, vday: true },
  d: { email: { date: '2026-10-15', note: MARKER } }, done: { 'core.menu': { by: MARKER, at: 'x' } },
  due: { 'email.send': '2026-10-20' }, events: [{ name: MARKER, date: '2026-10-12', time: '' }], notes: MARKER,
});

function row(id, status, start, end, amount, plan) {
  const r = PH.map(() => '');
  r[col('program_id')] = id;
  r[col('vendor')] = 'Wyld';
  r[col('program_name')] = id;
  r[col('status')] = status;
  r[col('start_date')] = start;
  r[col('end_date')] = end;
  r[col('match_json')] = JSON.stringify({ brand: 'Wyld' });
  r[col('stores_json')] = '["bend","center"]';
  r[col('payout_type')] = 'flat';
  r[col('payout_json')] = JSON.stringify({ model: 'flat', amount });
  r[col('target_json')] = JSON.stringify({ units: 100, budtenders: 3, per_bt: { bend: 5, center: 5 } });
  r[col('pitch_json')] = '{"tips":["Lead with the terpenes"]}';
  r[col('marketing_json')] = plan ? FULL_PLAN : '';
  return r;
}
const programsRows = (plan) => [
  row('running', 'active', '2026-10-12', '2026-10-25', 50, plan),
  row('starts-today', 'draft', '2026-10-14', '2026-10-27', 25, plan),
  row('ended', 'active', '2026-09-28', '2026-10-11', 25, plan),
  row('settled', 'closed', '2026-08-31', '2026-09-13', 25, plan),
];

function progressRow(program, emp, units, target, earned) {
  const r = PROG_H.map(() => '');
  const set = (h, v) => { r[PROG_H.indexOf(h)] = v; };
  set('program_id', program); set('store_id', 'bend'); set('employee_id', emp); set('name', 'BT ' + emp);
  set('units', units); set('target', target); set('hit', units >= target); set('earned', earned);
  set('vendor', 'Wyld'); set('program_name', program); set('start_date', '2026-10-12'); set('end_date', '2026-10-25');
  set('refreshed_at', '2026-10-14 08:00:00');
  return r;
}

let PENCIL_TOUCHES = 0;
function engine(plan) {
  const programs = G.makeSheet(PH, programsRows(plan));
  const progress = G.makeSheet(PROG_H, [progressRow('running', 'e1', 6, 5, 50), progressRow('running', 'e2', 2, 5, 0)]);
  const props = G.makeProps({ GX_DEPLOY_SECRET: 'SEKRET' });
  const cache = G.makeCache();
  const sent = [];
  const api = G.load({
    real: ['spiffProgress_', 'listPrograms_', 'rowToProgram_', 'normalizeMarketing_', 'normalizePitch_', 'parseJson_',
           'textDate_', 'stampOf_', 'payPeriodMatches_', 'userKey_', 'displayNameMap_', 'friendlyName_',
           'productLabelOf_', 'programsFor_', 'payoutModelOf_', 'payoutRateOf_', 'progEarned_',
           'publishSpiffToCore_', 'publishToCore_', 'byEmployee_', 'dedupe_', 'periodStartFor_', 'scrubSecrets_',
           'lastProgramsByStore_', 'lastClosedFor_', 'programRunsAt_', 'programCoversStore_', 'slug_',
           'publishNoProgramHeartbeat_', 'noProgramHeartbeatPayload_',
           'refreshSpiffProgress_', 'refreshProgressPlan_', 'forceProgressTextDates_',
           'rollProgramStatuses_', 'invalidatePrograms_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'GX_SECRET_PROP', 'PITCH_MAX_LEN', 'PROGRAMS_CACHE_KEY'],
    varValues: { PITCH_MAX_TIPS: 5 },
    stubs: {
      dataSheet_: () => programs,
      /* Rigged: a pay, publication or kiosk route that reaches for the pencils tab is a failure. */
      pencilSheet_: () => { PENCIL_TOUCHES++; throw new Error('a pay route read the pencils tab'); },
      readPencils_: () => { PENCIL_TOUCHES++; throw new Error('a pay route read the pencils'); },
      progressSheet_: () => progress,
      listProgramsCached_: () => api.listPrograms_(),
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      sellthrough_: (p) => ({ ok: true, rows: [{ employee_id: 'e1', name: 'A One', units: 6, target: 5, hit: true }] }),
      gxRosterFull_: () => [],
      nowStamp_: () => '2026-10-14 09:00:00',
      today_: () => '2026-10-14',
      payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }),
    },
    globals: {
      PropertiesService: props.PropertiesService, CacheService: cache.CacheService,
      console: { warn() {}, log() {} },
      GXCore: {
        getEmployees: () => [],
        publishSpiffProgress: (secret, scope, payload) => { sent.push({ scope, payload }); return { ok: true }; },
        publishSpiffHeartbeat: (secret, scope, payload) => { sent.push({ hb: scope, payload }); return { ok: true }; },
      },
    },
  });
  return { api, programs, progress, sent };
}

function bothWays(label, run) {
  const without = JSON.stringify(run(engine(false)));
  const withPlan = JSON.stringify(run(engine(true)));
  ok(label + ': a real answer came back', without && without !== '{}' && without !== 'null' && without !== '[]');
  ok('  …identical with and without a marketing plan', without === withPlan);
  ok('  …and none of the plan is in it', withPlan.indexOf(MARKER) < 0 && withPlan.indexOf('marketing') < 0);
  return JSON.parse(withPlan);
}

console.log('\n1. ?action=progress');
const read = bothWays('progress', (e) => e.api.spiffProgress_({ secret: 'SEKRET' }));
ok('  …and it is the money it should be', read.rows.filter(r => r.employee_id === 'e1')[0].earned === 50);
bothWays('progress, active only', (e) => e.api.spiffProgress_({ secret: 'SEKRET', status: 'active' }));

console.log('\n2. the publication to Core');
const pub = bothWays('publication', (e) => { e.api.publishSpiffToCore_(); return e.sent; });
ok('  …and something really was published', pub.some(s => s.scope));

console.log('\n3. the hourly sweep');
bothWays('sweep', (e) => { e.api.refreshSpiffProgress_(); return e.progress.rows; });

console.log('\n4. the status roll');
const roll = (e) => {
  const res = e.api.rollProgramStatuses_();
  return { changed: res.changed, statuses: e.programs.rows.slice(1).map(r => [r[col('program_id')], r[col('status')]]) };
};
const rolled = bothWays('status roll', roll);
ok('  …it still does its job', rolled.statuses.filter(s => s[0] === 'ended')[0][1] === 'closed'
   && rolled.statuses.filter(s => s[0] === 'starts-today')[0][1] === 'active');
{
  const e = engine(true);
  const before = e.programs.rows.map(r => r[col('marketing_json')]);
  e.api.rollProgramStatuses_();
  ok('  …and leaves the plan alone', JSON.stringify(e.programs.rows.map(r => r[col('marketing_json')])) === JSON.stringify(before));
}

console.log('\n5. penciled brands');
ok('no route above reached for the pencils tab', PENCIL_TOUCHES === 0);
{
  const NAMES = ['spiffProgress_', 'publishSpiffToCore_', 'publishToCore_', 'refreshSpiffProgress_', 'refreshProgressPlan_',
                 'rollProgramStatuses_', 'listPrograms_', 'listProgramsCached_', 'rowToProgram_', 'programToRow_',
                 'storeView_', 'lastProgramsByStore_', 'recordMeasuredActuals_', 'recordActualsWeb_', 'bootAll_',
                 'byEmployee_', 'progEarned_', 'programRunsAt_', 'noProgramHeartbeatPayload_', 'publishNoProgramHeartbeat_',
                 'sweepOrphanProgress_', 'dropProgressRows_', 'auditClosedPayouts_', 'clientView_'];
  const named = [];
  NAMES.forEach((n) => { try { named.push([n, G.grab(n)]); } catch (e) { /* a name that is not in the engine has nothing to leak */ } });
  ok('the functions checked are really there (' + named.length + ' of ' + NAMES.length + ')', named.length >= 18);
  const leaks = named.filter(([n, src]) => /pencil/i.test(src)).map(([n]) => n);
  ok('  …and none of them mentions a pencil: ' + (leaks.join(', ') || 'none'), leaks.length === 0);
  /* Only the pencil routes themselves may use the tab's accessors. */
  const users = ['pencilSheet_(', 'readPencils_('];
  const owners = ['pencilSheet_', 'rowToPencil_', 'readPencils_', 'pencilsRead_', 'findPencilRow_', 'closePencil_',
                  'savePencil_', 'releasePencil_', 'lockPencil_'];
  let rest = G.GS;
  owners.forEach((n) => { rest = rest.replace(G.grab(n), ''); });
  ok('  …and nothing else in the engine calls the pencils tab', users.every((u) => rest.indexOf(u) < 0));
}
{
  const e = engine(true);
  const before = e.programs.rows.length;
  e.api.rollProgramStatuses_();
  ok('the status roll makes no program and reads no pencil, whatever dates are penciled',
     e.programs.rows.length === before && PENCIL_TOUCHES === 0);
}

console.log('\n6. the vendor plan and the team email (phase 3)');
{
  const PAY = ['spiffProgress_', 'publishSpiffToCore_', 'publishToCore_', 'refreshSpiffProgress_', 'refreshProgressPlan_',
               'rollProgramStatuses_', 'listPrograms_', 'storeView_', 'lastProgramsByStore_', 'recordMeasuredActuals_',
               'bootAll_', 'byEmployee_', 'progEarned_', 'payoutFactsOf_', 'auditClosedPayouts_', 'clientView_',
               'sendBrandEmail_', 'buildReport_', 'giftCardList_'];
  const named = [];
  PAY.forEach((n) => { try { named.push([n, G.grab(n)]); } catch (e) { /* not in the engine, nothing to leak */ } });
  ok('the pay-side functions checked are really there (' + named.length + ')', named.length >= 14);
  const hits = named.filter(([n, src]) => /marketingOverview_|marketingNotify_|mkt[A-Z]\w*_|MKT_/.test(src)).map(([n]) => n);
  ok('  …and none of them calls the vendor plan or the team email: ' + (hits.join(', ') || 'none'), hits.length === 0);

  /* The other direction: the new routes read the allow-list of plan facts and no pay field. */
  const mine = ['mktPlanFacts_', 'marketingOverviewHtml_', 'marketingOverview_', 'marketingNotify_', 'mktRecipients_']
    .map((n) => G.grab(n)).join('\n');
  const payFields = ['payout_json', 'payout_type', 'cost_json', 'actual_json', 'target_json', 'baseline_json', 'progress_json',
                     'payoutFactsOf_', 'measuredRowsFor_', 'spiff_progress', 'earned', 'gxRosterFull_', 'GXCore.getEmployees']
    .filter((f) => mine.indexOf(f) >= 0);
  ok('the new routes never name a pay, cost or roster field: ' + (payFields.join(', ') || 'none'), payFields.length === 0);

  /* Neither runs from a trigger: nothing but the doGet dispatch mentions them. */
  const rest = G.GS.replace(G.grab('marketingOverview_'), '').replace(G.grab('marketingNotify_'), '');
  const callers = (rest.match(/^.*\b(marketingOverview_|marketingNotify_)\(.*$/gm) || []).filter((l) => !/^\s*case '/.test(l));
  ok('  …and nothing but the click route calls them: ' + (callers.join(' | ') || 'none'), callers.length === 0);
  ok('  …and the dispatch lists them once each', (G.GS.match(/case 'marketingOverview'/g) || []).length === 1
     && (G.GS.match(/case 'marketingNotify'/g) || []).length === 1);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing pay isolation: all passed');
process.exit(fail ? 1 : 0);
