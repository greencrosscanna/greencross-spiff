#!/usr/bin/env node
/* ─── The marketing_json column: storing it, and adding it to the live sheet safely ───────────────
 *
 *   RUN:  node tests/marketing_json_test.js
 *
 * THE TRAP. The live `programs` tab has exactly 26 columns (read off the sheet 2026-11-01), the whole
 * of a default grid, and all 26 are in use. Apps Script throws when a range runs past the grid, and
 * dataSheet_ runs the header migration on EVERY read. So a 27th column read the old way stops every
 * route and the hourly job, pay included, the moment the engine is pushed. The ordinary test sheet
 * grows on demand and would never show it, so section 2 uses one with a real fixed grid, and proves
 * that grid would have caught it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const col = (n) => PH.indexOf(n);
const OLD_PH = PH.slice(0, col('marketing_json'));
const EDITABLE = new Function('return ' + (G.GS.match(/\nvar EDITABLE_FIELDS = (\[[\s\S]*?\n\];)/) || [])[1])();

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;

const rowApi = G.load({
  real: ['programToRow_', 'rowToProgram_', 'normalizeMarketing_', 'normalizePitch_', 'applyMarketingDelta_',
         'periodStartFor_', 'textDate_', 'parseJson_', 'stripDerivedActuals_', 'nowStamp_'],
  vars: ['DERIVED_ACTUALS', 'PITCH_MAX_LEN'],
  varValues: { PITCH_MAX_TIPS: 5 },
  stubs: { payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }) },
});
const N = rowApi.normalizeMarketing_;

console.log('\n1. what the column holds');
ok('marketing_json is the LAST column, so no existing column moves', PH[PH.length - 1] === 'marketing_json');
ok('  …and everything before it is where it always was', col('pitch_json') === 25 && col('program_id') === 0);
ok('it can be saved', EDITABLE.indexOf('marketing_json') >= 0);

const PLAN = { v: 1, stores: ['river-rd', 'bend'], sel: { email: true }, skip: { led: true },
  d: { email: { date: '2026-10-15' } }, done: { 'core.menu': { by: 'sky', at: '2026-10-01T10:00:00Z' } },
  due: { 'email.send': '2026-10-20' }, events: [{ name: 'Kickoff', date: '2026-10-12', time: '4 PM' }], notes: 'Rep is out Fridays.' };
{
  const row = rowApi.programToRow_({ program_id: 'p', start_date: '2026-10-12', marketing_json: PLAN });
  ok('the row is exactly as wide as the headers', row.length === PH.length);
  const back = rowApi.rowToProgram_(row);
  ok('it comes back from the sheet exactly as it went in', JSON.stringify(back.marketing_json) === JSON.stringify(PLAN));
  ok('  …and survives a second trip unchanged',
     JSON.stringify(rowApi.rowToProgram_(rowApi.programToRow_(back)).marketing_json) === JSON.stringify(PLAN));
}
{
  const row = rowApi.programToRow_({ program_id: 'p' });
  ok('a program nobody planned stores an empty cell', row[col('marketing_json')] === '');
  ok('  …and reads back as nothing', rowApi.rowToProgram_(row).marketing_json === null);
  const old = rowApi.programToRow_({ program_id: 'p' }).slice(0, 26);
  ok('a row written before the column existed reads as nothing', rowApi.rowToProgram_(old).marketing_json === null);
  ok('a damaged cell reads as nothing rather than throwing',
     rowApi.rowToProgram_(rowApi.programToRow_({ program_id: 'p' }).slice(0, 26).concat(['{not json'])).marketing_json === null);
}
{
  const dirty = Object.assign({}, PLAN, {
    tasks: [{ due: '2026-01-01' }], overdue: 9, compliance: 'computed', late_count: 3,
    due: { 'email.send': '2026-10-20', 'bad.date': 'tomorrow' },
    d: { email: { date: '2026-10-15', nested: { no: 1 } } },
    sel: { email: true, off: false },
  });
  const out = N(dirty);
  ok('derived fields are dropped before a write', !('tasks' in out) && !('overdue' in out) && !('compliance' in out) && !('late_count' in out));
  const cell = rowApi.programToRow_({ program_id: 'p', marketing_json: dirty })[col('marketing_json')];
  ok('  …including on the path to the cell', cell.indexOf('overdue') < 0 && cell.indexOf('compliance') < 0);
  ok('a date that is not a date is refused', !('bad.date' in out.due));
  ok('a false flag is not stored', !('off' in out.sel));
  ok('a field cannot smuggle in an object', !('nested' in out.d.email));
  const evil = N(JSON.parse('{"sel":{"__proto__":true,"ok":true},"done":{"__proto__":{"by":"x"}}}'));
  ok('a key named __proto__ goes nowhere', Object.keys(evil.sel).join() === 'ok' && !evil.done.by && ({}).by === undefined);
  ok('notes are capped', N({ notes: 'x'.repeat(5000) }).notes.length === 2000);
  ok('an array is not a plan', N([1, 2]) === null);
  ok('an empty plan is not a plan', N({ v: 1, sel: {}, done: {} }) === null);
  ok('every task key the menu can produce is accepted', (function () {
    const keys = [];
    const p = { start_date: '2026-10-12', end_date: '2026-10-25', stores_json: ['river-rd', 'hood-river-2'],
                marketing_json: { sel: Object.keys(MK.ITEMS).reduce((a, k) => (a[k] = true, a), {}) } };
    MK.tasksOf(p, {}).forEach(t => keys.push(t.key));
    const done = keys.reduce((a, k) => (a[k] = { by: 'sky', at: 'x' }, a), {});
    return keys.length > 40 && Object.keys(N({ done: done }).done).length === keys.length;
  })());
}

/* ── 2. A SHEET WITH A REAL GRID ─────────────────────────────────────────────────────────────────── */
function gridSheet(headers, rows, maxCols) {
  const s = G.makeSheet(headers, rows);
  const base = s.getRange.bind(s);
  s.maxCols = maxCols;
  s.cleared = 0;
  s.getMaxColumns = () => s.maxCols;
  s.insertColumnsAfter = (after, n) => { s.maxCols += n; return s; };
  s.getLastColumn = () => s.rows.reduce((m, r) => {
    let w = r.length;
    while (w && (r[w - 1] === '' || r[w - 1] == null)) w--;
    return Math.max(m, w);
  }, 0);
  s.clear = () => { s.cleared++; s.rows = []; return s; };
  s.getRange = (r, c, nr, nc) => {
    const wide = c + (nc === undefined ? 1 : nc) - 1;
    if (wide > s.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    return base(r, c, nr, nc);
  };
  return s;
}
const liveRow = (id) => OLD_PH.map(h => (h === 'program_id' ? id : h === 'start_date' ? '2026-10-12' : h === 'pitch_json' ? '{"tips":["keep me"]}' : ''));
function migrator(stubs) {
  return G.load({
    real: ['migrateHeaders_'].concat(stubs ? [] : ['ensureColumns_']),
    vars: ['PROGRAM_HEADERS'],
    stubs: stubs || {},
  });
}

console.log('\n2. adding the column to the live sheet');
{
  const sheet = gridSheet(OLD_PH, [liveRow('a'), liveRow('b')], 26);
  let threw = '';
  try { migrator({ ensureColumns_: () => {} }).migrateHeaders_(sheet); } catch (e) { threw = e.message; }
  ok('(this sheet WOULD catch the trap: without growing the grid, the read throws)', /outside the dimensions/.test(threw));
}
{
  const sheet = gridSheet(OLD_PH, [liveRow('a'), liveRow('b')], 26);
  const before = JSON.stringify(sheet.rows.slice(1));
  migrator().migrateHeaders_(sheet);
  ok('the grid grows to fit it', sheet.getMaxColumns() === 27);
  ok('the header lands in column 27', sheet.rows[0][26] === 'marketing_json');
  ok('  …and every other header is untouched', sheet.rows[0].slice(0, 26).join() === OLD_PH.join());
  ok('the tab is NOT cleared and rewritten', sheet.cleared === 0);
  ok('  …every program row is byte for byte what it was', JSON.stringify(sheet.rows.slice(1)) === before);
  const rerun = JSON.stringify(sheet.rows);
  migrator().migrateHeaders_(sheet);
  ok('running again changes nothing, which matters because it runs on every read',
     JSON.stringify(sheet.rows) === rerun && sheet.getMaxColumns() === 27);
  /* The way every route really reads, through to a program. */
  const reads = G.load({
    real: ['listPrograms_', 'rowToProgram_', 'normalizeMarketing_', 'normalizePitch_', 'textDate_', 'parseJson_'],
    vars: ['PROGRAM_HEADERS', 'PITCH_MAX_LEN'], varValues: { PITCH_MAX_TIPS: 5 },
    stubs: { dataSheet_: () => sheet, annotateActuals_: () => {}, annotateUnmeasurable_: () => {} },
  }).listPrograms_();
  ok('both programs read back, with their old data and no plan',
     reads.length === 2 && reads[0].pitch_json.tips[0] === 'keep me' && reads[1].marketing_json === null);
}
{
  /* dataSheet_ itself: the door every read goes through. */
  const sheet = gridSheet(OLD_PH, [liveRow('a')], 26);
  const api = G.load({
    real: ['dataSheet_', 'migrateHeaders_', 'ensureColumns_', 'forceTextDates_'],
    vars: ['PROGRAM_HEADERS', 'PROGRAMS_TAB'],
    globals: { SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) } },
  });
  ok('the real dataSheet_ opens the live shape without throwing', api.dataSheet_() === sheet && sheet.rows[0][26] === 'marketing_json');
}
{
  /* The old path still works for a column that went missing from the middle: it has to remap. */
  const gap = OLD_PH.filter(h => h !== 'source');
  const sheet = gridSheet(gap, [gap.map(h => (h === 'program_id' ? 'a' : h === 'vendor' ? 'Wyld' : ''))], 26);
  migrator().migrateHeaders_(sheet);
  ok('a column missing from the middle still remaps by name',
     sheet.cleared === 1 && sheet.rows[1][col('vendor')] === 'Wyld' && sheet.rows[1].length === PH.length);
}
{
  /* Data in a column with no heading is not a clean append. It goes down the old path, as before. */
  const sheet = gridSheet(OLD_PH, [liveRow('a').concat(['stray'])], 30);
  migrator().migrateHeaders_(sheet);
  ok('an unexplained column does not get mistaken for an empty one', sheet.cleared === 1);
}

console.log('\n3. a deleted or renamed program keeps its columns straight');
{
  const DEL = PH.concat(['deleted_by', 'deleted_at', 'deleted_reason']);
  const liveHeaders = OLD_PH.concat(['deleted_by', 'deleted_at', 'deleted_reason']);
  const oldStone = liveHeaders.map(h => (h === 'program_id' ? 'gone' : h === 'deleted_by' ? 'tawny' : ''));
  const tab = gridSheet(liveHeaders, [oldStone], 29);
  const api = G.load({
    real: ['writeTombstone_', 'ensureColumns_', 'programToRow_', 'normalizeMarketing_', 'normalizePitch_',
           'periodStartFor_', 'textDate_', 'stripDerivedActuals_', 'nowStamp_'],
    vars: ['DERIVED_ACTUALS', 'PITCH_MAX_LEN'],
    varValues: { DELETED_HEADERS: DEL, PITCH_MAX_TIPS: 5 },
    stubs: { deletedSheet_: () => tab, payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }) },
  });
  api.writeTombstone_({ program_id: 'wyld', vendor: 'Wyld', marketing_json: { sel: { email: true } } }, 'sky', 'mistake');
  const head = tab.rows[0], stone = tab.rows[2];
  const at = (h) => head.indexOf(h);
  ok('the existing headings stay where they are', head.slice(0, 29).join() === liveHeaders.join());
  ok('the new one goes on the end', head[29] === 'marketing_json' && tab.getMaxColumns() === 30);
  ok('who deleted it is still under "deleted_by"', stone[at('deleted_by')] === 'sky');
  ok('  …why, under "deleted_reason"', stone[at('deleted_reason')] === 'mistake');
  ok('  …and the plan under its own heading', /email/.test(stone[at('marketing_json')]));
  ok('older tombstones are not touched', tab.rows[1][at('deleted_by')] === 'tawny');
}

/* ── 4. SAVING, THROUGH THE REAL ROUTE ───────────────────────────────────────────────────────────── */
function editor(opts) {
  const o = opts || {};
  const row = PH.map(() => '');
  row[col('program_id')] = 'kap';
  row[col('status')] = o.status || 'active';
  row[col('start_date')] = '2026-10-12';
  row[col('end_date')] = '2026-10-25';
  row[col('match_json')] = JSON.stringify({ brand: 'Not Stocked', category: '', filter_text: '', products: [] });
  row[col('stores_json')] = '["bend"]';
  row[col('payout_json')] = '{"model":"flat","amount":50}';
  row[col('progress_json')] = '{"stores":{"bend":{"units":5}}}';
  row[col('marketing_json')] = o.plan ? JSON.stringify(o.plan) : '';
  const programs = G.makeSheet(PH, [row]);
  const progress = G.makeSheet(PROG_H, [PROG_H.map((h, i) => (i === 0 ? 'kap' : ''))]);
  const cache = G.makeCache();
  const api = G.load({
    real: ['editProgram_', 'saveProgram_', 'getProgram_', 'listPrograms_', 'rowToProgram_', 'programToRow_',
           'measurementInvalidatedBy_', 'brandMatchCheck_', 'dropProgressRows_', 'invalidatePrograms_',
           'applyMarketingDelta_', 'normalizeMarketing_', 'parseJson_', 'textDate_', 'nowStamp_', 'slug_',
           'normalizePitch_', 'periodStartFor_', 'stripDerivedActuals_', 'scrubSecrets_', 'wixSignDelta_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'EDIT_ROLES', 'MEASURED_BY', 'DERIVED_ACTUALS', 'PROGRAMS_CACHE_KEY', 'PITCH_MAX_LEN',
           'WIX_ITEM_', 'WIX_APPROVE_TASK_', 'WIX_VDAY_APPROVE_TASK_', 'WIX_APPROVERS_'],
    varValues: { EDITABLE_FIELDS: EDITABLE, PITCH_MAX_TIPS: 5 },
    stubs: {
      dataSheet_: () => programs, progressSheet_: () => progress,
      gxAuth_: () => (o.auth || { ok: true, user: 'sky', role: 'admin' }),
      catalog_: () => ({ ok: true, brands: ['Wyld'] }),
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });
  const send = (ops, extra) => api.editProgram_(Object.assign({ token: 't', id: 'kap', patch: JSON.stringify({ marketing_delta: ops }) }, extra || {}));
  return { api, send, programs, progress, cache, saved: () => api.getProgram_('kap').program };
}
const TICK = (k, by) => [['done', k, { by: by || 'sky', at: '2026-10-01T10:00:00Z' }]];

console.log('\n4. saving through the edit route');
{
  const e = editor();
  const r = e.send(TICK('core.menu'), { confirm_brand: '1' });
  ok('a tick saves', r.ok === true && r.changed.join() === 'marketing_json');
  ok('  …lands in the cell', /core\.menu/.test(e.programs.rows[1][col('marketing_json')]));
  ok('  …and comes back for the screen to adopt', r.marketing_json.done['core.menu'].by === 'sky');
  ok('  …and clears the programs cache', e.cache.removed.indexOf('spiff_programs_v1') >= 0);
}
{
  const e = editor({ auth: { ok: true, user: 'tawny', role: 'viewer' } });
  const r = e.send(TICK('core.menu'), { confirm_brand: '1' });
  ok('the edit-role check is what protects it: a viewer is refused', r.ok === false && /cannot edit/.test(r.error));
  ok('  …and nothing was written', e.programs.rows[1][col('marketing_json')] === '');
  const m = editor({ auth: { ok: true, user: 'mgr', role: 'manager' } });
  ok('  …so is a manager, for now', m.send(TICK('core.menu'), { confirm_brand: '1' }).ok === false);
  const out = editor({ auth: { ok: false, error: 'Not signed in' } });
  ok('  …and anyone not signed in', out.send(TICK('core.menu'), { confirm_brand: '1' }).needsAuth === true);
}
{
  const e = editor();
  e.send(TICK('core.menu', 'tawny'), { confirm_brand: '1' });
  e.send(TICK('core.plan', 'sky'), { confirm_brand: '1' });
  const done = e.saved().marketing_json.done;
  ok('two ticks on different tasks do not undo each other', !!done['core.menu'] && !!done['core.plan']);
  /* Signed by the session since the deals-page approval (one tick now publishes to the website):
     the browser said "tawny", the signed-in user is sky. See wixSignDelta_. */
  ok('  …and each is signed by the SESSION, not by the name the browser sent', done['core.menu'].by === 'sky');
  e.send([['done', 'core.menu', null]], { confirm_brand: '1' });
  ok('unticking removes just that one', !e.saved().marketing_json.done['core.menu'] && e.saved().marketing_json.done['core.plan']);
}
{
  const e = editor({ plan: { sel: { email: true } } });
  const r = e.send([['sel', 'sms', true]]);
  ok('a real brand question still stops an ordinary save of the same program', r.ok === false && r.code === 'brand_no_match');
  ok('  …but a marketing save says the brand is not its question', e.send([['sel', 'sms', true]], { confirm_brand: '1' }).ok === true);
}
{
  const e = editor({ plan: { sel: { email: true } } });
  const before = e.progress.rows.length;
  const r = e.send(TICK('core.menu'), { confirm_brand: '1' });
  ok('a marketing save never throws away measurements', !r.invalidated && e.progress.rows.length === before);
  ok('  …and the frozen close-out figures stay', e.saved().progress_json.stores.bend.units === 5);
}
{
  const e = editor({ status: 'closed' });
  ok('a closed program can still be ticked: results are shared after it ends',
     e.send(TICK('core.results'), { confirm_brand: '1' }).ok === true);
}
{
  const e = editor();
  const before = e.programs.rows[1].slice();
  const r = e.send([['payout_json', 'amount', 999], ['status', null, 'closed'], ['__proto__', 'x', 1]], { confirm_brand: '1' });
  const after = e.programs.rows[1];
  ok('a change aimed at anything outside the marketing record goes nowhere',
     after[col('payout_json')] === before[col('payout_json')] && after[col('status')] === before[col('status')]);
  ok('  …and the route says nothing changed', r.unchanged === true);
}

console.log('\n5. the screen and the engine agree on what a click does');
{
  const script = [
    [['sel', 'email', true]], [['sel', 'sms', true], ['sel', 'email', null]],
    [['stores', null, ['bend', 'river-rd']]],
    [['d', 'sms', { date: '2026-10-15', cost: 'We cover it' }]], [['d', 'sms', { cost: 'Vendor credit' }]],
    [['done', 'core.menu', { by: 'sky', at: 'x' }]], [['done', 'signage.up@bend', { by: 'sky', at: 'x' }]],
    [['done', 'core.menu', null]],
    [['due', 'sms.send', '2026-10-20']], [['due', 'sms.send', null]],
    [['notes', null, 'hello']], [['bogus', 'x', 1]], [['done', '__proto__', { by: 'x' }]],
  ];
  let screen = null, engine = null, same = true;
  script.forEach(ops => {
    screen = JSON.parse(JSON.stringify(rowApi.normalizeMarketing_(MK.applyOps(screen, ops))));
    engine = rowApi.applyMarketingDelta_(engine, ops);
    if (JSON.stringify(screen) !== JSON.stringify(engine)) same = false;
  });
  ok('every step of a run of clicks ends in the same record', same);
  ok('  …and that record is the expected one', engine.sel.sms === true && !engine.sel.email
     && engine.d.sms.cost === 'Vendor credit' && !engine.d.sms.date && engine.done['signage.up@bend'] && !engine.done['core.menu']);
}

console.log('\n6. a save stays short enough to ride on GET');
{
  /* Measured 2026-11-01: the live engine answers a 10,000-character address and fails at 12,000. */
  const allOn = Object.keys(MK.ITEMS).reduce((a, k) => (a[k] = true, a), {});
  const p = { start_date: '2026-10-12', end_date: '2026-10-25',
              stores_json: ['century', 'center', 'commercial', 'baseline', 'portland', 'river-rd'],
              marketing_json: { sel: allOn } };
  const done = MK.tasksOf(p, {}).reduce((a, t) => (a[t.key] = { by: 'tawny', at: '2026-10-25T23:59:59.000Z' }, a), {});
  const whole = encodeURIComponent(JSON.stringify({ marketing_json: { sel: allOn, done: done } })).length;
  const one = encodeURIComponent(JSON.stringify({ marketing_delta: MK.doneOp('signage.up@commercial', true, 'tawny', '2026-10-25T23:59:59.000Z') })).length;
  ok('resending the whole plan at the end of a full program would not fit (' + whole + ' characters)', whole > 10000);
  ok('one tick is small (' + one + ' characters)', one < 400);
}

console.log('\n7. several vendor days, each at its own store');
{
  /* Gron, Nov 2026: five days across five stores, typed one at a time on the screen. A plan saved
     before the list existed holds one day in d.vday; the first edit moves it into the list. */
  const legacy = { sel: { vday: true }, d: { vday: { date: '2026-11-03', time: '1-3:30' } } };
  const p = () => ({ start_date: '2026-10-26', end_date: '2026-11-08', marketing_json: screen });
  let screen = JSON.parse(JSON.stringify(N(legacy))), engine = JSON.parse(JSON.stringify(N(legacy))), same = true;
  ok('an old one-day plan reads as one day for every store', JSON.stringify(MK.vdaysOf(p())) === JSON.stringify([{ store: '', date: '2026-11-03', time: '1-3:30' }]));
  const step = (opsFn) => {
    const ops = opsFn(p());
    screen = JSON.parse(JSON.stringify(N(MK.applyOps(screen, ops))));
    engine = rowApi.applyMarketingDelta_(engine, ops);
    if (JSON.stringify(screen) !== JSON.stringify(engine)) same = false;
  };
  step(q => MK.setVdayOp(q, 0, 'store', 'commercial'));
  step(q => MK.addVdayOp(q));
  step(q => MK.setVdayOp(q, 1, 'store', 'river-rd'));
  step(q => MK.setVdayOp(q, 1, 'date', '2026-11-03'));
  step(q => MK.setVdayOp(q, 1, 'time', '4 to 6:30 PM'));
  step(q => MK.addVdayOp(q));
  step(q => MK.setVdayOp(q, 2, 'date', '2026-11-05'));
  ok('screen and engine agree at every step', same);
  ok('the first edit retires the old one-day field', !engine.d.vday);
  ok('three days, each with its own store and time', engine.vdays.length === 3 && engine.vdays[0].store === 'commercial'
     && engine.vdays[0].time === '1-3:30' && engine.vdays[1].store === 'river-rd' && engine.vdays[1].time === '4 to 6:30 PM');
  ok('  …a day with no store yet means every store', engine.vdays[2].store === '' && engine.vdays[2].date === '2026-11-05');
  step(q => MK.removeVdayOp(q, 0));
  ok('removing one keeps the others in order', engine.vdays.length === 2 && engine.vdays[0].store === 'river-rd' && same);
  step(q => MK.removeVdayOp(q, 0));
  step(q => MK.removeVdayOp(q, 0));
  ok('removing the last leaves no list at all', !('vdays' in engine) && engine.sel.vday === true && same);
  const junk = N({ vdays: [{ store: '__proto__', date: 'Nov 3', time: 'x'.repeat(99) }, 'nope', [1]] });
  ok('the engine keeps only a store slug, an ISO date and a short time',
     junk.vdays.length === 1 && junk.vdays[0].store === '' && junk.vdays[0].date === '' && junk.vdays[0].time.length === 40);
  const five = MK.addVdayOp({ marketing_json: { vdays: Array.from({ length: 5 }, (_, i) => ({ store: 'river-rd', date: '2026-11-0' + (i + 1), time: '4 to 6:30 PM' })) } });
  const len = encodeURIComponent(JSON.stringify({ marketing_delta: five })).length;
  ok('a six-day edit still rides on GET (' + len + ' characters)', len < 2000);
}

console.log('\n8. an item\'s own list: post dates, signs, featured cases');
{
  let screen = null, engine = null, same = true;
  const p = () => ({ marketing_json: screen });
  const step = (opsFn) => {
    const ops = opsFn(p());
    screen = JSON.parse(JSON.stringify(N(MK.applyOps(screen, ops))));
    engine = rowApi.applyMarketingDelta_(engine, ops);
    if (JSON.stringify(screen) !== JSON.stringify(engine)) same = false;
  };
  step(() => [['sel', 'social', true]]);
  step(q => MK.addRowOp(q, 'social'));
  step(q => MK.setRowOp(q, 'social', 0, 'date', '2026-11-04'));
  step(q => MK.addRowOp(q, 'social'));
  step(q => MK.setRowOp(q, 'social', 1, 'date', '2026-11-07'));
  step(q => MK.addRowOp(q, 'case'));
  step(q => MK.setRowOp(q, 'case', 0, 'text', 'Front glass case'));
  step(q => MK.toggleRowStoreOp(q, 'case', 0, 'river-rd'));
  step(q => MK.toggleRowStoreOp(q, 'case', 0, 'bend'));
  step(q => MK.toggleRowStoreOp(q, 'case', 0, 'river-rd'));
  step(q => MK.addRowOp(q, 'signage'));
  step(q => MK.setRowOp(q, 'signage', 0, 'text', 'Window cling'));
  step(q => MK.detailOp(q, 'files', 'url', 'https://drive.google.com/drive/folders/abc'));
  ok('screen and engine agree at every step', same);
  ok('two post dates, one sign, one case at one store', engine.rows.social.map(r => r.date).join('|') === '2026-11-04|2026-11-07'
     && engine.rows.signage[0].text === 'Window cling' && engine.rows['case'][0].stores.join('|') === 'bend');
  ok('the folder link is kept', engine.d.files.url === 'https://drive.google.com/drive/folders/abc');
  step(q => MK.removeRowOp(q, 'signage', 0));
  ok('removing the last sign drops that list and keeps the others', !engine.rows.signage && engine.rows.social.length === 2 && same);
  const junk = N({ rows: { social: [{ date: 'soon', stores: ['__proto__', 'bend', 'bend'] }, 'x'], __proto__: [{}], 'Bad Key': [{}] } });
  ok('the engine keeps only real dates, store slugs and safe keys', junk.rows.social.length === 1
     && junk.rows.social[0].date === '' && junk.rows.social[0].stores.join('|') === 'bend' && Object.keys(junk.rows).join() === 'social');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing_json: all passed');
process.exit(fail ? 1 : 0);
