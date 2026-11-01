#!/usr/bin/env node
/* ─── The Marketing section's task logic, run in the shape the browser loads it ───────────────────
 *
 *   RUN:  node tests/marketing_tasks_test.js
 *
 * marketing.js is loaded through vm with no `module`, so it attaches to its global exactly as it does
 * on the page. What is checked is what it RETURNS: due dates, per-store fan-out, what counts as
 * overdue, and who gets to see any of it.
 *
 * The switch has its own section because merging puts this screen live: Tawny and staff must see no
 * change until Sky says so. Those checks run spiff.js's own join functions rather than reading them.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8');
function loadMk(src) {
  const ctx = {};
  vm.runInNewContext(src || SRC, ctx);
  return ctx.SpiffMarketing;
}
const MK = loadMk();

const ALL6 = ['bend', 'center', 'commercial', 'river-rd', 'portland', 'century'];
const OPTS = { stores: ALL6 };
function prog(over) {
  return Object.assign({
    program_id: 'kap', vendor: 'Kaprikorn', status: 'active',
    start_date: '2026-10-12', end_date: '2026-10-25',
    stores_json: ['bend', 'center'], payout_type: 'flat', payout_json: { model: 'flat', amount: 50 },
    marketing_json: { v: 1, sel: {}, skip: {}, d: {}, done: {}, due: {}, events: [], notes: '' },
  }, over || {});
}
function withPlan(plan, over) {
  return prog(Object.assign({ marketing_json: Object.assign({ v: 1, sel: {}, d: {}, done: {}, due: {} }, plan) }, over || {}));
}
const find = (tasks, key) => tasks.filter(t => t.key === key)[0];
const group = (p, id) => MK.groupTasks(MK.tasksOf(p, OPTS)).filter(g => g.id === id)[0];

console.log('\n1. due dates are arithmetic on the window');
ok('adding days crosses a month', MK.addDays('2026-10-12', -21) === '2026-09-21');
ok('  …and the day clocks change does not move an answer',
   MK.addDays('2026-11-01', 1) === '2026-11-02' && MK.addDays('2026-03-08', 1) === '2026-03-09');
ok('  …and a blank window gives a blank date, not a guess', MK.addDays('', 3) === '');
{
  const t = MK.tasksOf(prog(), OPTS);
  ok('the menu task is due three weeks before the start', find(t, 'core.menu').due === '2026-09-21');
  ok('sharing results is due two weeks after the end', find(t, 'core.results').due === '2026-11-08');
  const moved = MK.tasksOf(prog({ start_date: '2026-11-09', end_date: '2026-11-22' }), OPTS);
  ok('move the window and every date moves with it', find(moved, 'core.menu').due === '2026-10-19'
     && find(moved, 'core.results').due === '2026-12-06');
}

console.log('\n2. what is on the list');
{
  const t = MK.tasksOf(prog(), OPTS);
  ok('all the core tasks apply to every program', MK.CORE.every(c => find(t, c[0])));
  ok('the budtender incentive is always on, with nothing picked', find(t, 'incentive.terms') && MK.isOn(prog(), 'incentive'));
  ok('  …and cannot be switched off', MK.toggleItemOp(prog(), 'incentive').length === 0);
  ok('an item not picked adds no tasks', !t.some(x => x.item === 'email'));
  const on = MK.tasksOf(withPlan({ sel: { email: true } }), OPTS);
  ok('picking an item adds its tasks', find(on, 'email.send') && find(on, 'email.review'));
  ok('the incentive is not counted as an add-on', MK.pickedItems(withPlan({ sel: { email: true } })).join() === 'email');
}
{
  const ids = [];
  MK.CORE.forEach(k => ids.push(k[0]));
  Object.keys(MK.ITEMS).forEach(id => MK.ITEMS[id].k.forEach(k => ids.push(k[0])));
  ok('every task id is unique, because done state is stored against it',
     new Set(ids).size === ids.length);
  ok('every item carries its compliance note', Object.keys(MK.ITEMS).every(id => MK.ITEMS[id].c));
  const secs = MK.SECTIONS.map(s => s[0]);
  ok('every item belongs to a section the picker draws', Object.keys(MK.ITEMS).every(id => secs.indexOf(MK.ITEMS[id].sec) >= 0));
}

console.log('\n3. per-store tasks fan out, and each store is its own key');
{
  const p = withPlan({ sel: { signage: true } });
  const rows = MK.tasksOf(p, OPTS).filter(t => t.id === 'signage.up');
  ok('one row per program store', rows.map(r => r.key).join() === 'signage.up@bend,signage.up@center');
  ok('a task the office does once stays one row', MK.tasksOf(p, OPTS).filter(t => t.id === 'signage.approve').length === 1);
  const chosen = withPlan({ sel: { signage: true }, stores: ['river-rd'] });
  ok('stores picked for marketing win over the program\'s',
     MK.tasksOf(chosen, OPTS).filter(t => t.id === 'signage.up').map(r => r.store).join() === 'river-rd');
  const none = withPlan({ sel: { signage: true } }, { stores_json: [] });
  ok('with no stores on the program, every store', MK.tasksOf(none, OPTS).filter(t => t.id === 'signage.up').length === 6);

  const one = withPlan({ sel: { signage: true }, done: { 'signage.up@bend': { by: 'sky', at: 'x' } } });
  const g = group(one, 'signage.up');
  ok('one store done leaves the task open for the other', g.open === 1 && g.rows.length === 2);
  const both = withPlan({ sel: { signage: true }, done: {
    'signage.up@bend': { by: 'sky', at: 'x' }, 'signage.up@center': { by: 'sky', at: 'x' } } });
  ok('every store done closes it', group(both, 'signage.up').open === 0);
}
{
  const p = withPlan({ sel: { signage: true } });
  ok('turning a store on adds it', MK.toggleStoreOp(p, 'river-rd', OPTS)[0][2].join() === 'bend,center,river-rd');
  ok('the last store will not turn off',
     MK.toggleStoreOp(withPlan({ stores: ['bend'] }), 'bend', OPTS).length === 0);
}

console.log('\n4. which date wins');
{
  const typed = withPlan({ sel: { email: true }, d: { email: { date: '2026-10-15' } } });
  ok('a typed send date moves the send task', find(MK.tasksOf(typed, OPTS), 'email.send').due === '2026-10-15');
  ok('  …and only that task', find(MK.tasksOf(typed, OPTS), 'email.review').due === '2026-10-05');
  const moved = withPlan({ sel: { email: true }, d: { email: { date: '2026-10-15' } }, due: { 'email.send': '2026-10-20' } });
  const t = find(MK.tasksOf(moved, OPTS), 'email.send');
  ok('a date moved by hand wins over the typed one', t.due === '2026-10-20' && t.moved === true);
  ok('  …and the planned date is still known, so it can go back', t.planned === '2026-10-15');
  const each = withPlan({ sel: { signage: true }, due: { 'signage.up': '2026-10-14' } });
  ok('moving a per-store task moves it for every store',
     MK.tasksOf(each, OPTS).filter(x => x.id === 'signage.up').every(x => x.due === '2026-10-14'));
  const slid = withPlan({ due: { 'core.menu': '2026-09-01' } }, { start_date: '2026-11-09', end_date: '2026-11-22' });
  ok('a window change leaves a hand-moved date alone', find(MK.tasksOf(slid, OPTS), 'core.menu').due === '2026-09-01');
}

console.log('\n5. overdue is computed, and counts each job once');
const TODAY = '2026-10-14';
{
  const p = withPlan({ sel: { signage: true } });
  const late = MK.lateOf(p, TODAY, OPTS);
  ok('a task due before today and not done is late', late.some(g => g.id === 'core.menu'));
  ok('a task due today is not late', !MK.lateOf(withPlan({ due: { 'core.menu': TODAY } }), TODAY, OPTS).some(g => g.id === 'core.menu'));
  const done = withPlan({ done: { 'core.menu': { by: 'sky', at: 'x' } } });
  ok('a done task is not late', !MK.lateOf(done, TODAY, OPTS).some(g => g.id === 'core.menu'));

  const up = withPlan({ sel: { signage: true } }, { start_date: '2026-10-01', end_date: '2026-10-08' });
  ok('a per-store task late at two stores is one thing to chase, not two',
     MK.lateOf(up, TODAY, OPTS).filter(g => g.id === 'signage.up').length === 1);

  const next = MK.nextOf(withPlan({ sel: { email: true } }, { start_date: '2026-10-20', end_date: '2026-11-02' }), TODAY, OPTS);
  ok('next is the earliest open task from today on', next && next.due >= TODAY
     && !MK.groupTasks(MK.tasksOf(withPlan({ sel: { email: true } }, { start_date: '2026-10-20', end_date: '2026-11-02' }), OPTS))
          .some(g => g.open && g.due >= TODAY && g.due < next.due));
}
{
  const unplanned = prog({ marketing_json: null, start_date: '2025-01-01', end_date: '2025-01-14' });
  ok('a program nobody planned counts for nothing, however old', MK.overdueTotal([unplanned], TODAY, OPTS) === 0);
  ok('  …its list line says so rather than reading as behind',
     /not set up yet/.test(MK.listLine(unplanned, TODAY, OPTS)) && !/overdue/.test(MK.listLine(unplanned, TODAY, OPTS)));
  const planned = withPlan({ sel: { email: true } });
  ok('a planned one does count', MK.overdueTotal([unplanned, planned], TODAY, OPTS) === MK.lateOf(planned, TODAY, OPTS).length
     && MK.lateOf(planned, TODAY, OPTS).length > 0);
  const closed = withPlan({}, { status: 'closed', start_date: '2026-09-01', end_date: '2026-09-14' });
  ok('a closed program still counts, because results are shared after it ends',
     MK.lateOf(closed, TODAY, OPTS).some(g => g.id === 'incentive.cards'));
  const noWindow = withPlan({}, { start_date: '', end_date: '' });
  ok('a program with no window has nothing late', MK.lateOf(noWindow, TODAY, OPTS).length === 0);
  ok('  …and its tasks say they need one',
     MK.groupTasks(MK.tasksOf(noWindow, OPTS)).every(g => MK.phaseOf(g, noWindow) === 'undated'));
}

console.log('\n6. grouped Before / While / After');
{
  const p = withPlan({ sel: { email: true } });
  const ph = id => MK.phaseOf(group(p, id), p);
  ok('before the start', ph('email.review') === 'before');
  ok('on the start date is while it runs', ph('email.send') === 'during');
  ok('after the end', ph('email.stats') === 'after');
}

console.log('\n7. the incentive follows the program\'s own payout');
{
  ok('flat', /Flat \$50 per budtender/.test(MK.incentiveLine(prog())));
  ok('per unit', /\$1 per unit/.test(MK.incentiveLine(prog({ payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 1 } }))));
  ok('re-model the program and it changes, because nothing here stores it',
     /Flat \$20/.test(MK.incentiveLine(prog({ payout_json: { model: 'flat', amount: 20 } }))));
  ok('no payout yet says where to set it', /Calculator/.test(MK.incentiveLine(prog({ payout_json: {} }))));
}

console.log('\n8. the screen it draws');
const CTX = { today: TODAY, canEdit: true, engineReady: true, moving: '',
              stores: ALL6.map(s => ({ store_id: s, name: s.toUpperCase() })), storeName: s => s.toUpperCase() };
{
  const p = withPlan({ sel: { email: true, signage: true } }, { vendor: 'A<b>' });
  const html = MK.sectionHtml(p, CTX);
  ok('it shows the compliance note for a picked item', html.indexOf('tiered spend thresholds') > 0);
  ok('  …and not for one left off', html.indexOf('Entry is not tied to a purchase') < 0);
  ok('a vendor name cannot inject markup', html.indexOf('A<b>') < 0 && html.indexOf('A&lt;b&gt;') > 0);
  ok('it uses the real store names it was given', html.indexOf('RIVER-RD') > 0);
  /* collectPatch reads every [data-key] in the record's hosts. None here, so the program's Save
     button neither reads nor resends this section. */
  ok('nothing in it can be picked up by the program\'s own Save', html.indexOf('data-key') < 0);
  ok('the incentive card states the payout', /Flat \$50/.test(html));
  ok('no sales figure is typed here: the only inputs are the item details and dates',
     !/name="(sales|baseline|units)/.test(html) && !/data-mk-field="(sales|baseline|units|revenue)/.test(html));
  const ro = MK.sectionHtml(p, Object.assign({}, CTX, { canEdit: false }));
  ok('a role that cannot edit gets it read-only',
     (ro.match(/data-mk-task="[^"]*"[^>]*>/g) || []).every(x => /disabled/.test(x))
     && (ro.match(/data-mk-store="[^"]*"[^>]*>/g) || []).every(x => /disabled/.test(x))
     && !/data-mk-moving/.test(ro));
  ok('an engine without the column says so instead of silently not saving',
     /engine has not been updated/.test(MK.sectionHtml(p, Object.assign({}, CTX, { engineReady: false }))));
}

console.log('\n9. saves go one at a time, in order');
async function saverChecks() {
  const sent = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const states = [];
  const saver = MK.makeSaver(async (id, ops) => {
    sent.push({ id, ops });
    if (sent.length === 1) await gate;
    return { ok: true };
  }, (phase) => states.push(phase));
  const first = saver.add('p1', [['sel', 'a', true]]);
  saver.add('p1', [['sel', 'b', true]]);
  saver.add('p1', [['sel', 'c', true]]);
  ok('a second click waits for the first reply', sent.length === 0 || sent.length === 1);
  release();
  await first;
  await new Promise(r => setTimeout(r, 0));
  ok('what queued goes together in the next call', sent.length === 2 && sent[1].ops.length === 2);
  ok('  …in the order it was clicked', sent[1].ops[0][1] === 'b' && sent[1].ops[1][1] === 'c');
  ok('it ends saying saved', states[states.length - 1] === 'saved');

  const bad = [];
  const failing = MK.makeSaver(async () => { throw new Error('nope'); }, (phase, res) => bad.push([phase, res && res.message]));
  await failing.add('p1', [['sel', 'a', true]]);
  ok('a failed save reports the reason', bad[bad.length - 1][0] === 'failed' && bad[bad.length - 1][1] === 'nope');
}

/* ── THE SWITCH ─────────────────────────────────────────────────────────────────────────────────── */
function joined(sessionValue, MkImpl) {
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const fold = { hidden: true };
  const host = { innerHTML: 'stale', addEventListener() {} };
  const note = { textContent: '' };
  const nodes = { '#calcMarketingFold': fold, '#calcMarketingBody': host, '#calcMarketingNote': note };
  const src = ['mkOn', 'mkOpts', 'mkListLine', 'mkOverdueTile', 'mkPaint', 'syncMarketing']
    .map(n => G.grab(n, js)).join('\n');
  const fn = new Function('MK', 'session', 'state', '$', 'today', 'statTile', 'canEdit', 'storeName', 'mkUi', 'mkApply',
    src + '\nreturn { mkOn, mkListLine, mkOverdueTile, syncMarketing };');
  const api = fn(MkImpl === undefined ? MK : MkImpl, () => sessionValue,
    { stores: ALL6.map(s => ({ store_id: s })), record: null },
    s => nodes[s] || null, () => TODAY, (v, l) => '[' + v + ' ' + l + ']', () => true, s => s, { moving: '', saved: {} }, () => {});
  return { api, fold, host };
}
/* spiff.js's own save join, run against a stubbed engine: what the screen shows after each outcome. */
function saveJoin(p, answer, role) {
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const status = { textContent: '', classList: { bad: false, toggle(_, on) { this.bad = on; } } };
  const calls = [];
  let lists = 0, signIn = 0, paints = 0;
  const src = ['mkStatus', 'mkApply', 'mkSaver'].map(n => G.grab(n, js)).join('\n');
  const fn = new Function('MK', 'state', '$', 'canEdit', 'mkUi', 'mkPaint', 'renderPrograms', 'ENG', 'session', 'clearSession', 'openSignIn',
    'var mkSaverInst = null;\n' + src + '\nreturn { mkApply };');
  const state = { record: p, programs: [p] };
  const api = fn(MK, state, () => status, () => role !== 'viewer', { moving: '', saved: {} }, () => { paints++; },
    () => { lists++; },
    { jsonp: async (action, params) => { calls.push({ action, params }); return answer(params); } },
    () => ({ user: 'sky', token: 'tok', role: role || 'admin' }), () => {}, () => { signIn++; });
  return { api, calls, status, counts: () => ({ lists, signIn, paints }) };
}
const flush = () => new Promise(r => setTimeout(r, 0));

async function saveJoinChecks() {
  console.log('\n11. what the screen does around a save');
  {
    const p = withPlan({ sel: { sms: true } });
    const j = saveJoin(p, () => ({ ok: true, updated: true, changed: ['marketing_json'],
      marketing_json: { v: 1, sel: { sms: true, email: true }, skip: {}, d: {}, done: {}, due: {}, events: [], notes: '' } }));
    j.api.mkApply([['sel', 'email', true]]);
    ok('the tick shows at once', p.marketing_json.sel.email === true);
    await flush(); await flush();
    const sent = j.calls[0];
    ok('it goes through the edit route', sent.action === 'editProgram' && sent.params.id === 'kap');
    ok('  …carrying only what changed', JSON.parse(sent.params.patch).marketing_delta[0][1] === 'email'
       && !('marketing_json' in JSON.parse(sent.params.patch)));
    ok('  …and saying the brand is not its question', sent.params.confirm_brand === '1');
    ok('it says Saved', j.status.textContent === 'Saved' && j.status.classList.bad === false);
    ok('the program list repaints with the new count', j.counts().lists === 1);
  }
  for (const start of [null, { v: 1, sel: { sms: true } }]) {
    const p = prog({ marketing_json: start });
    const j = saveJoin(p, () => { throw new Error('the engine said no.'); });
    j.api.mkApply([['sel', 'email', true]]);
    await flush(); await flush();
    ok('a failed save puts the screen back to what is stored (' + (start ? 'a plan' : 'no plan') + ')',
       JSON.stringify(p.marketing_json) === JSON.stringify(start));
    ok('  …and says why, in red', /^Not saved: the engine said no\. The screen is back/.test(j.status.textContent) && j.status.classList.bad === true);
  }
  {
    const p = withPlan({});
    const j = saveJoin(p, () => ({ ok: false, needsAuth: true, error: 'Not signed in' }));
    j.api.mkApply([['sel', 'email', true]]);
    await flush(); await flush();
    ok('an expired session opens sign-in', j.counts().signIn === 1);
  }
  {
    const p = withPlan({});
    const j = saveJoin(p, () => ({ ok: true }), 'viewer');
    j.api.mkApply([['sel', 'email', true]]);
    await flush();
    ok('a role that cannot edit sends nothing', j.calls.length === 0 && !p.marketing_json.sel.email);
  }
  {
    const p = prog();
    delete p.marketing_json;
    const j = saveJoin(p, () => ({ ok: true }));
    j.api.mkApply([['sel', 'email', true]]);
    await flush();
    ok('against an engine without the column, nothing is sent or pretended', j.calls.length === 0 && !p.marketing_json);
  }
}

async function main() {
  await saverChecks();

  console.log('\n10. only Sky sees it until the switch is flipped');
  ok('Sky sees it', MK.isVisible({ user: 'sky', role: 'admin' }));
  ok('Tawny does not, editor or not', !MK.isVisible({ user: 'tawny', role: 'editor' }));
  ok('the dev viewer does not', !MK.isVisible({ user: 'dev', role: 'viewer' }));
  ok('nobody signed out does', !MK.isVisible(null));
  ok('the switch ships OFF', /var VISIBLE_TO_EVERYONE = false;/.test(SRC));
  const open = loadMk(SRC.replace('var VISIBLE_TO_EVERYONE = false;', 'var VISIBLE_TO_EVERYONE = true;'));
  ok('flipped, everyone signed in sees it', open.isVisible({ user: 'tawny', role: 'editor' }));
  ok('  …and still nobody signed out', !open.isVisible(null));

  const p = withPlan({ sel: { email: true } });
  const tawny = joined({ user: 'tawny', role: 'editor' });
  ok('for Tawny the list line is empty', tawny.api.mkListLine(p) === '');
  ok('  …the overdue box is not drawn', tawny.api.mkOverdueTile([p]) === '');
  tawny.api.syncMarketing(p);
  ok('  …and the section stays hidden and empty', tawny.fold.hidden === true && tawny.host.innerHTML === '');

  const sky = joined({ user: 'sky', role: 'admin' });
  ok('for Sky the list line is there', /Marketing/.test(sky.api.mkListLine(p)));
  ok('  …so is the box', /marketing tasks overdue/.test(sky.api.mkOverdueTile([p])));
  sky.api.syncMarketing(p);
  ok('  …and the section', sky.fold.hidden === false && /What is Kaprikorn in for/.test(sky.host.innerHTML));
  sky.api.syncMarketing(null);
  ok('a new, unsaved program has no section', sky.fold.hidden === true);

  const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('the page loads marketing.js before the script that reads it',
     page.indexOf('src="marketing.js') > 0 && page.indexOf('src="marketing.js') < page.indexOf('src="spiff.js'));
  ok('  …and the section starts hidden in the markup itself', /id="calcMarketingFold" hidden/.test(page));

  const missing = joined({ user: 'sky', role: 'admin' }, null);
  ok('if marketing.js fails to load, nothing here breaks',
     missing.api.mkListLine(p) === '' && missing.api.mkOverdueTile([p]) === '');

  await saveJoinChecks();

  console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing tasks: all passed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
