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
  MK.BLAST.forEach(k => ids.push(k[0]));
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
  ok('a leftover item-level store pick is ignored: the program\'s own stores run the task (v2.000)',
     MK.tasksOf(chosen, OPTS).filter(t => t.id === 'signage.up').map(r => r.store).join() === 'bend,center');
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
  ok('the item-level store picker is gone: no toggle op is exported (v2.000)', MK.toggleStoreOp === undefined);
}

console.log('\n4. which date wins');
{
  const typed = withPlan({ sel: { email: true }, d: { email: { date: '2026-10-15' } } });
  ok('a typed send date moves the send task', find(MK.tasksOf(typed, OPTS), 'email.send').due === '2026-10-15');
  ok('  …and the blast item\'s other before-start tasks count back from it', find(MK.tasksOf(typed, OPTS), 'email.review').due === '2026-10-12');
  ok('  …but not the program\'s own tasks', find(MK.tasksOf(typed, OPTS), 'core.menu').due === '2026-09-21');
  const raffle = withPlan({ sel: { raffle: true }, d: { raffle: { date: '2026-10-30' } } });
  ok('  …and on an item that is not a blast, a typed date still moves only its own task',
     find(MK.tasksOf(raffle, OPTS), 'raffle.rules').due === '2026-10-02' && find(MK.tasksOf(raffle, OPTS), 'raffle.draw').due === '2026-10-30');
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
  /* Sky, 2026-11-02: the workflows carry the compliance guardrails, so the cards do not repeat them. */
  ok('the cards carry no compliance warning', html.indexOf('tiered spend thresholds') < 0 && html.indexOf('mk-comp') < 0);
  ok('  …and not for one left off', html.indexOf('Entry is not tied to a purchase') < 0);
  ok('a vendor name cannot inject markup', html.indexOf('A<b>') < 0 && html.indexOf('A&lt;b&gt;') > 0);
  ok('the item-level "Which stores?" picker is gone (v2.000)', html.indexOf('Which stores') < 0 && html.indexOf('mk-stores') < 0);
  /* collectPatch reads every [data-key] in the record's hosts. None here, so the program's Save
     button neither reads nor resends this section. */
  ok('nothing in it can be picked up by the program\'s own Save', html.indexOf('data-key') < 0);
  /* Sky, 2026-11-02: the incentive has nothing to fill in, so it has no Details card. */
  ok('the incentive gets no Details card', !/<h6>Budtender incentive/.test(html) && !/Flat \$50/.test(html));
  ok('no sales figure is typed here: the only inputs are the item details and dates',
     !/name="(sales|baseline|units)/.test(html) && !/data-mk-field="(sales|baseline|units|revenue)/.test(html));
  const ro = MK.sectionHtml(p, Object.assign({}, CTX, { canEdit: false }));
  ok('a role that cannot edit gets it read-only',
     (ro.match(/data-mk-task="[^"]*"[^>]*>/g) || []).every(x => /disabled/.test(x))
     && !/mk-stores|data-mk-store=/.test(ro)
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
  const fn = new Function('MK', 'session', 'state', '$', 'today', 'statTile', 'canEdit', 'storeName', 'mkUi', 'mkApply', 'mkPlanAction', 'mkAssign', 'loadSmsPricing',
    src + '\nreturn { mkOn, mkListLine, mkOverdueTile, syncMarketing };');
  const api = fn(MkImpl === undefined ? MK : MkImpl, () => sessionValue,
    { stores: ALL6.map(s => ({ store_id: s })), record: null },
    s => nodes[s] || null, () => TODAY, (v, l) => '[' + v + ' ' + l + ']', () => true, s => s, { moving: '', saved: {} }, () => {}, () => {}, () => {}, () => {});
  return { api, fold, host };
}
/* spiff.js's own save join, run against a stubbed engine: what the screen shows after each outcome. */
function saveJoin(p, answer, role, holidays) {
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const status = { textContent: '', classList: { bad: false, toggle(_, on) { this.bad = on; } } };
  const calls = [];
  let lists = 0, signIn = 0, paints = 0;
  const src = ['mkStatus', 'mkFind', 'mkApply', 'mkSaver', 'mkAssign'].map(n => G.grab(n, js)).join('\n');
  const fn = new Function('MK', 'state', '$', 'canEdit', 'mkUi', 'mkPaint', 'mkRenderViews', 'renderPrograms', 'ENG', 'session', 'clearSession', 'openSignIn',
    'function mkOpts() { return { stores: [] }; }\nvar mkSaverInst = null;\nvar mkView = { dlg: null };\n' + src + '\nreturn { mkApply, mkAssign };');
  const state = { record: p, programs: p ? [p] : [], holidays: holidays || [] };
  const api = fn(MK, state, () => status, () => role !== 'viewer', { moving: '', saved: {} }, () => { paints++; }, () => {},
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

  console.log('\n12. handing a task to someone');
  {
    const p = withPlan({ sel: { email: true } });
    const j = saveJoin(p, (params) => params.patch
      ? { ok: true, marketing_json: Object.assign({}, p.marketing_json) }
      : { ok: true, sent: true, to: 'tawny@greencrosscanna.com' });
    await j.api.mkAssign('email.send', 'tawny');
    await flush();
    ok('it saves the new owner first, through the edit route', j.calls[0].action === 'editProgram'
       && JSON.stringify(JSON.parse(j.calls[0].params.patch).marketing_delta) === '[["own","email.send","tawny"]]');
    const mail = j.calls[1] || {};
    ok('  …then asks the engine to tell that person, naming the task and its date', mail.action === 'marketingAssign'
       && mail.params.person === 'tawny' && mail.params.task === 'email.send' && /^Send at 11 AM/.test(mail.params.text)
       && mail.params.item === 'Email blast' && /^\d{4}-\d{2}-\d{2}$/.test(mail.params.due));
    ok('  …and says who was emailed', /Emailed tawny@greencrosscanna.com/.test(j.status.textContent));
    ok('the task now shows its new owner', MK.tasksOf(p, {}).filter(t => t.id === 'email.send')[0].owner === 'Tawny');
  }
  {
    const p = withPlan({ sel: { email: true }, own: { 'email.send': 'tawny' } });
    const j = saveJoin(p, () => ({ ok: true, marketing_json: Object.assign({}, p.marketing_json) }));
    await j.api.mkAssign('email.send', '');
    await flush();
    ok('handing it back to its default owner saves, and emails nobody', j.calls.length === 1 && j.calls[0].action === 'editProgram'
       && !(p.marketing_json.own || {})['email.send']);
  }
  {
    const p = withPlan({ sel: { email: true } });
    const j = saveJoin(p, () => { throw new Error('the engine said no.'); });
    await j.api.mkAssign('email.send', 'sky');
    await flush();
    ok('a save that fails sends no email', j.calls.length === 1 && j.calls[0].action === 'editProgram');
  }
  ok('picking the default owner clears the override, and an unknown person is refused',
     JSON.stringify(MK.assignOp({}, 'core.menu', 'tawny')) === '[["own","core.menu",null]]'
     && MK.assignOp({}, 'core.menu', 'bob').length === 0 && MK.assignOp({}, 'nope', 'sky').length === 0);
  const html = MK.sectionHtml(withPlan({ sel: { email: true }, own: { 'email.send': 'sky' } }),
    { today: TODAY, canEdit: true, engineReady: true, stores: ALL6.map(s => ({ store_id: s, name: s })), storeName: s => s });
  ok('an editor gets an owner picker on each task, showing who has it', /<select class="mk-own o-SKY" data-mk-assign="email.send"/.test(html)
     && /<option value="sky" selected>Sky<\/option>/.test(html));
  ok('  …offering its default owner and the three people, no one twice', /data-mk-assign="core.menu"[^>]*><option value="" selected>Tawny<\/option><option value="mike">Mike<\/option><option value="sky">Sky<\/option><\/select>/.test(html));
  const view = MK.sectionHtml(withPlan({ sel: { email: true } }),
    { today: TODAY, canEdit: false, engineReady: true, stores: ALL6.map(s => ({ store_id: s, name: s })), storeName: s => s });
  ok('a viewer sees the owner, not a picker', !/data-mk-assign/.test(view) && /class="mk-own o-DIR">Mike/.test(view));
  {
    const p = withPlan({ sel: { sms: true } });
    const j = saveJoin(p, (params) => params.patch
      ? { ok: true, marketing_json: Object.assign({}, p.marketing_json) }
      : { ok: true, sent: true, to: 'sky@greencrosscanna.com' });
    await j.api.mkAssign('blast.copy', 'sky');
    await flush();
    const mail = j.calls[1] || {};
    ok('a blast-cycle task can be handed off too, and its email carries no item name',
       JSON.stringify(JSON.parse(j.calls[0].params.patch).marketing_delta) === '[["own","blast.copy","sky"]]'
       && mail.action === 'marketingAssign' && mail.params.task === 'blast.copy' && mail.params.item === '');
  }
  {
    /* A holiday send is not a program: its ticks and hand-offs go to its own route, never editProgram. */
    const h = { holiday_id: 'hol-1', name: 'Thanksgiving', send_date: '2026-11-23', channels: ['email'], marketing_json: { v: 1 } };
    const j = saveJoin(withPlan({}), (params) => params.patch
      ? { ok: true, holiday_id: 'hol-1', marketing_json: Object.assign({}, h.marketing_json) }
      : { ok: true, sent: true, to: 'mike@greencrosscanna.com' }, 'admin', [h]);
    j.api.mkApply(MK.doneOp('blast.deal', true, 'sky', 'x'), 'hol-1');
    await flush(); await flush();
    ok('a holiday tick saves through saveHolidayPlan, not editProgram', j.calls[0].action === 'saveHolidayPlan'
       && j.calls[0].params.id === 'hol-1' && !('confirm_brand' in j.calls[0].params));
    await j.api.mkAssign('blast.deal', 'mike', 'hol-1');
    await flush();
    const mail = j.calls[j.calls.length - 1] || {};
    ok('  …and a holiday hand-off asks the engine as a holiday', j.calls[j.calls.length - 2].action === 'saveHolidayPlan'
       && mail.action === 'marketingAssign' && mail.params.kind === 'holiday' && mail.params.id === 'hol-1' && mail.params.due === '2026-11-18');
  }
}

/* ── THE BLAST CYCLE (Sky, 2026-11-02) ─────────────────────────────────────────────────────────────
   Send day is a Monday. Tawny locks the deal the Wednesday before, Mike has copy and the Dutchie
   draft Thursday and sends Sky the proofs, Sky approves at the Friday L10, Mike sends at 11 AM. */
function blastChecks() {
  console.log('\n13. the blast cycle');
  const MON = { start_date: '2026-11-16', end_date: '2026-11-29' };
  const byId = (p) => { const m = {}; MK.groupTasks(MK.tasksOf(p, OPTS)).forEach(g => { m[g.id] = g; }); return m; };
  const email = byId(withPlan({ sel: { email: true } }, MON));
  ok('the deal is Tawny\'s, locked the Wednesday before the send', email['blast.deal'].owner === 'Tawny' && email['blast.deal'].due === '2026-11-11');
  ok('copy and the Dutchie draft are Mike\'s, Thursday', email['blast.copy'].owner === 'Mike' && email['blast.copy'].due === '2026-11-12');
  ok('the email proof is Mike\'s, due Friday, and says Sky approves at the L10',
     email['email.review'].owner === 'Mike' && email['email.review'].due === '2026-11-13' && /Sky approves at the Friday L10/.test(email['email.review'].text));
  ok('the send is Mike\'s, on the Monday, at 11 AM, with the sent-vs-planned check',
     email['email.send'].owner === 'Mike' && email['email.send'].due === '2026-11-16' && /11 AM/.test(email['email.send'].text) && /sent vs planned/.test(email['email.send'].text));
  ok('stats are unchanged: Mike, three days after the end', email['email.stats'].owner === 'Mike' && email['email.stats'].due === '2026-12-02');
  ok('no task is Sky\'s by default', !Object.keys(email).some(id => email[id].defOwn === 'SKY'));

  const sms = byId(withPlan({ sel: { sms: true } }, MON));
  ok('a text blast alone gets the deal and copy tasks too', sms['blast.deal'] && sms['blast.copy']);
  ok('the text proof is Mike\'s, due Friday, same wording', sms['sms.approve'].owner === 'Mike' && sms['sms.approve'].due === '2026-11-13'
     && /text proof to Sky Thursday; tick when Sky approves at the Friday L10/.test(sms['sms.approve'].text));
  ok('the text send is at 11 AM', /^Send at 11 AM$/.test(sms['sms.send'].text));
  ok('the text cost model is unchanged: Tawny, two weeks out', sms['sms.cost'].owner === 'Tawny' && sms['sms.cost'].due === '2026-11-02');

  const both = MK.tasksOf(withPlan({ sel: { email: true, sms: true } }, MON), OPTS);
  ok('both picked: the deal and copy tasks come once each, not twice',
     both.filter(t => t.id === 'blast.deal').length === 1 && both.filter(t => t.id === 'blast.copy').length === 1);
  ok('neither picked: no blast-cycle tasks', !MK.tasksOf(withPlan({ sel: { signage: true } }, MON), OPTS).some(t => /^blast\./.test(t.id)));

  ok('creative from the vendor: the creative task shows', !!byId(withPlan({ sel: { email: true }, d: { email: { maker: 'Vendor supplies' } } }, MON))['email.creative']);
  ok('a plan saved before the field: the creative task still shows', !!email['email.creative']);
  ok('we make the creative: no creative task', !byId(withPlan({ sel: { email: true }, d: { email: { maker: 'We do' } } }, MON))['email.creative']);
  ok('the field offers exactly the two answers', JSON.stringify(MK.ITEMS.email.f[0]) === JSON.stringify(['sel', 'maker', 'Who makes the creative', ['We do', 'Vendor supplies']]));

  /* A typed send date (a later Monday) moves the whole cycle, not just the send. */
  const typed = byId(withPlan({ sel: { email: true, sms: true }, d: { email: { date: '2026-11-23', maker: 'Vendor supplies' }, sms: { date: '2026-11-30' } } }, MON));
  ok('the email tasks count back from the email send date',
     typed['email.creative'].due === '2026-11-09' && typed['email.review'].due === '2026-11-20' && typed['email.send'].due === '2026-11-23');
  ok('the text tasks count back from the text send date',
     typed['sms.cost'].due === '2026-11-16' && typed['sms.approve'].due === '2026-11-27' && typed['sms.send'].due === '2026-11-30');
  ok('the deal and copy count back from the earlier of the two', typed['blast.deal'].due === '2026-11-18' && typed['blast.copy'].due === '2026-11-19');
  ok('after-the-end tasks still follow the window', typed['email.stats'].due === '2026-12-02');
  const half = byId(withPlan({ sel: { email: true, sms: true }, d: { sms: { date: '2026-11-30' } } }, MON));
  ok('one send date typed: the email side stays on the window, the shared tasks take the typed one',
     half['email.review'].due === '2026-11-13' && half['blast.deal'].due === '2026-11-25');
  const handMoved = byId(withPlan({ sel: { email: true }, d: { email: { date: '2026-11-23' } }, due: { 'email.review': '2026-11-19' } }, MON));
  ok('a date moved by hand still wins over the send date', handMoved['email.review'].due === '2026-11-19' && handMoved['email.review'].moved);
  ok('the new tasks can be handed to the three people', MK.assignOp({}, 'blast.deal', 'mike')[0][2] === 'mike'
     && JSON.stringify(MK.assignOp({}, 'blast.deal', 'tawny')) === '[["own","blast.deal",null]]');
}

async function main() {
  await saverChecks();

  console.log('\n10. only Sky, Mike and Tawny see it until the switch is flipped');
  ok('Sky sees it', MK.isVisible({ user: 'sky', role: 'admin' }));
  ok('Mike and Tawny see it (their GX Core sign-in names)', MK.isVisible({ user: 'mike', role: 'editor' }) && MK.isVisible({ user: 'Tawny', role: 'editor' }));
  ok('Shawn does not, editor or not', !MK.isVisible({ user: 'shawn', role: 'editor' }));
  ok('the dev viewer does not', !MK.isVisible({ user: 'dev', role: 'viewer' }));
  ok('nobody signed out does', !MK.isVisible(null));
  ok('the switch ships OFF', /var VISIBLE_TO_EVERYONE = false;/.test(SRC));
  const open = loadMk(SRC.replace('var VISIBLE_TO_EVERYONE = false;', 'var VISIBLE_TO_EVERYONE = true;'));
  ok('flipped, everyone signed in sees it', open.isVisible({ user: 'shawn', role: 'editor' }));
  ok('  …and still nobody signed out', !open.isVisible(null));

  const p = withPlan({ sel: { email: true } });
  const shawn = joined({ user: 'shawn', role: 'editor' });
  ok('for anyone else the list line is empty', shawn.api.mkListLine(p) === '');
  ok('  …the overdue box is not drawn', shawn.api.mkOverdueTile([p]) === '');
  shawn.api.syncMarketing(p);
  ok('  …and the section stays hidden and empty', shawn.fold.hidden === true && shawn.host.innerHTML === '');
  const mike = joined({ user: 'mike', role: 'editor' });
  mike.api.syncMarketing(p);
  ok('for Mike the section shows', mike.fold.hidden === false && /What is Kaprikorn in for/.test(mike.host.innerHTML));

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
  blastChecks();

  console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing tasks: all passed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
