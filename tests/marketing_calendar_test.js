#!/usr/bin/env node
/* ─── The Calendar, the Tasks view and penciled brands, as the browser runs them ─────────────────
 *
 *   RUN:  node tests/marketing_calendar_test.js
 *
 * marketing.js is loaded through vm with no `module`, exactly as on the page, and what is checked is
 * the markup it RETURNS: one bar per program per week it spans, a dashed bar for a pencil, open tasks
 * grouped by owner, and what a viewer is and is not offered. spiff.js's own pencil join (save, release,
 * lock in) runs against a stubbed engine so the calls it makes are checked rather than read.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'marketing.js'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'spiff.js'), 'utf8');
const ctxVm = {};
vm.runInNewContext(SRC, ctxVm);
const MK = ctxVm.SpiffMarketing;

const TODAY = '2026-10-14';
const ALL6 = ['bend', 'center', 'commercial', 'river-rd', 'portland', 'century'];
const STORES = ALL6.map(s => ({ store_id: s, name: s }));
const plan = (sel, done) => ({ v: 1, sel: sel || {}, skip: {}, d: {}, done: done || {}, due: {}, events: [], notes: '' });
function prog(over) {
  return Object.assign({
    program_id: 'kap', vendor: 'Kaprikorn', program_name: 'All Products', status: 'active',
    start_date: '2026-10-12', end_date: '2026-10-25', stores_json: ['bend', 'center'],
    payout_type: 'flat', payout_json: { model: 'flat', amount: 50 }, marketing_json: plan({ email: true }),
  }, over || {});
}
const PEN = { pencil_id: 'pen-1', brand: 'Mule Extracts', start_date: '2026-11-09', end_date: '2026-11-22', note: 'waiting on budget', created_by: 'tawny', created_at: '2026-10-09 10:00:00', status: 'penciled' };
const cx = (over) => Object.assign({ today: TODAY, canEdit: true, offset: 0 }, over || {});
const count = (html, re) => (html.match(re) || []).length;

console.log('\n1. the calendar: one bar per week of a window');
{
  const html = MK.calendarHtml([prog()], [], cx());
  const bars = html.match(/<button[^>]*class="mk-vb run[^"]*"[^>]*>/g) || [];
  ok('a two-week program in October is three week-segments (it spans three calendar weeks)', bars.length === 3);
  ok('  …the first starts on Monday and runs to the week end', /grid-column:2\/8/.test(bars[0]));
  ok('  …the middle one fills the week', /grid-column:1\/8/.test(bars[1]));
  ok('  …the last stops on Sunday the 25th', /grid-column:1\/2/.test(bars[2]));
  ok('  …only the ends are rounded', /\bl\b/.test(bars[0]) && !/\br\b/.test(bars[0]) && /\br\b/.test(bars[2]) && !/\bl\b/.test(bars[1]));
  ok('three months are drawn, starting with this one', count(html, /class="mk-month"/g) === 3 && /October 2026/.test(html) && /December 2026/.test(html));
  ok('the days are real buttons an editor can pencil from', count(html, /data-mk-day="/g) > 90 && !/data-mk-day="2026-10-20"[^>]*disabled/.test(html));
  ok('  …except the greyed days borrowed from the next month', /data-mk-day="2026-09-27" class="out "[^>]*disabled/.test(html));
  const view = MK.calendarHtml([prog()], [], cx({ canEdit: false }));
  ok('a viewer sees the calendar but cannot pencil', !/Pencil a brand<\/button>/.test(view) && /data-mk-day="2026-10-14"[^>]*disabled/.test(view));
  const next = MK.calendarHtml([prog()], [], cx({ offset: 1 }));
  ok('Later moves the window a month', /November 2026/.test(next) && /January 2027/.test(next) && !/>October 2026</.test(next));
  const kinds = MK.calendarHtml([prog({ program_id: 'd', status: 'draft', vendor: 'Gron', start_date: '2026-10-26', end_date: '2026-11-08' }),
                                 prog({ program_id: 'c', status: 'closed', vendor: 'Old', start_date: '2026-09-28', end_date: '2026-10-11' })], [], cx());
  ok('drafts and closed programs are told apart', /mk-vb draft/.test(kinds) && /mk-vb done/.test(kinds));
  const noDates = MK.calendarHtml([prog({ start_date: '', end_date: '' })], [], cx());
  ok('a program with no window is left off rather than guessed', !/mk-vb /.test(noDates));
  ok('bars open the program', /data-mk-open="kap"/.test(html));
}

console.log('\n2. penciled brands on the calendar');
{
  const html = MK.calendarHtml([prog()], [PEN], cx());
  const pencils = html.match(/<button[^>]*class="mk-vb pencil[^"]*"[^>]*>[^<]*/g) || [];
  ok('a pencil is drawn as a dashed bar, once per week it spans', pencils.length === 3 || pencils.length === 2);
  ok('  …marked and named', /&#9998; Mule Extracts/.test(pencils[0]) && /Penciled, not official/.test(pencils[0]));
  ok('  …and opens the pencil, not a program', /data-mk-pencil="pen-1"/.test(pencils[0]) && !/data-mk-open/.test(pencils[0]));
  const lanes = MK.assignLanes(MK.barsOf([prog(), prog({ program_id: 'g', vendor: 'Gron', start_date: '2026-10-19', end_date: '2026-11-01' })], [PEN]));
  ok('overlapping bars take separate lanes; programs sit above pencils', lanes[0].lane === 0 && lanes[1].lane === 1 && lanes[2].lane === 0);
  ok('the list shows the pencil with its note', /Mule Extracts/.test(MK.pencilListHtml([PEN], cx())) && /waiting on budget/.test(MK.pencilListHtml([PEN], cx())));
  ok('  …and says plainly when its start has passed', /STARTED, NOT LOCKED/.test(MK.pencilListHtml([PEN], cx({ today: '2026-11-12' }))));
  ok('no pencils, no heading', MK.pencilListHtml([], cx()) === '');
  const o = MK.overlapNames([prog({ start_date: '2026-11-09', end_date: '2026-11-22' }), prog({ program_id: 'x', vendor: 'Closed Co', status: 'closed', start_date: '2026-11-09', end_date: '2026-11-22' })],
    [PEN, Object.assign({}, PEN, { pencil_id: 'pen-2', brand: 'Magic Number' })], '2026-11-09', '2026-11-22', 'pen-1');
  ok('overlap names what else is in the period, never the slot itself or a closed program', o.join('|') === 'Kaprikorn|Magic Number (penciled)');
  ok('  …and it warns in words', /Also in this period: Kaprikorn, Magic Number \(penciled\)\./.test(MK.overlapHtml([prog({ start_date: '2026-11-09', end_date: '2026-11-22' })], [Object.assign({}, PEN, { pencil_id: 'pen-2', brand: 'Magic Number' })], '2026-11-09', '2026-11-22')));
  ok('  …and says nothing when the period is clear', MK.overlapHtml([], [], '2026-11-09', '2026-11-22') === '');
}

console.log('\n2b. vendor days on the calendar and in the tasks');
{
  /* Gron, Nov 2026: five vendor days at five stores, two of them on the same Tuesday. */
  const VD = [{ store: 'commercial', date: '2026-11-03', time: '1 to 3:30 PM' }, { store: 'river-rd', date: '2026-11-03', time: '4 to 6:30 PM' },
              { store: 'bend', date: '2026-11-05', time: '' }, { store: 'portland', date: '2026-11-06', time: '' },
              { store: 'center', date: '2026-11-06', time: '' }];
  const gron = prog({ program_id: 'gron', vendor: 'Gron', start_date: '2026-10-26', end_date: '2026-11-08', stores_json: ALL6,
                      marketing_json: { sel: { vday: true }, vdays: VD } });
  const html = MK.calendarHtml([gron], [], cx({ storeName: s => s.toUpperCase() }));
  const marks = html.match(/<button[^>]*class="mk-vb vday[^"]*"[^>]*>[^<]*/g) || [];
  ok('each vendor day is its own one-day marker', marks.length === 5);
  ok('  …named for the vendor, store and time', /Gron at COMMERCIAL, 1 to 3:30 PM/.test(marks.join('')) && /Gron at RIVER-RD, 4 to 6:30 PM/.test(marks.join('')));
  ok('  …and opens its program', marks.every(m => /data-mk-open="gron"/.test(m)));
  ok('the legend names them', /lg vday/.test(html));
  const lanes = MK.assignLanes(MK.barsOf([gron], []));
  const tue = lanes.filter(b => b.kind === 'vday' && b.start === '2026-11-03');
  ok('two on the same day stack rather than overlap', tue.length === 2 && tue[0].lane !== tue[1].lane);
  ok('an item not picked draws no markers', !/mk-vb vday/.test(MK.calendarHtml([prog({ marketing_json: { sel: {}, vdays: VD } })], [], cx())));

  const held = MK.tasksOf(gron, {}).filter(t => t.id === 'vday.held');
  ok('"Vendor day held" is one row per vendor day, at its store, due that day',
     held.length === 5 && held.every((t, i) => t.store === VD[i].store && t.due === VD[i].date));
  ok('  …and stores with no vendor day get none', !held.some(t => t.store === 'century'));
  const twice = MK.tasksOf(prog({ marketing_json: { sel: { vday: true }, vdays: [{ store: 'bend', date: '2026-10-14' }, { store: 'bend', date: '2026-10-21' }] } }), {})
    .filter(t => t.id === 'vday.held').map(t => t.key);
  ok('two days at one store each get their own tick', twice.join('|') === 'vday.held@bend|vday.held@bend.2');
  const all = MK.tasksOf(prog({ marketing_json: { sel: { vday: true }, vdays: [{ store: '', date: '2026-10-14' }] } }), {}).filter(t => t.id === 'vday.held');
  ok('a day with no store means every store on the plan', all.map(t => t.store).join('|') === 'bend|center');
  const old = MK.tasksOf(prog({ marketing_json: { sel: { vday: true }, d: { vday: { date: '2026-10-16' } } } }), {}).filter(t => t.id === 'vday.held');
  ok('an old one-day plan keeps its store ticks and its date', old.map(t => t.key + '=' + t.due).join('|') === 'vday.held@bend=2026-10-16|vday.held@center=2026-10-16');
  const none = MK.tasksOf(prog({ marketing_json: { sel: { vday: true } } }), {}).filter(t => t.id === 'vday.held');
  ok('with no day set yet, every store waits on the window start', none.length === 2 && none.every(t => t.due === '2026-10-12'));

  const sec = MK.sectionHtml(gron, cx({ stores: STORES, storeName: s => s, engineReady: true }));
  ok('the card shows a row per day with store, date and time', (sec.match(/class="mk-vday"/g) || []).length === 5
     && /data-mk-vfield="store"/.test(sec) && /value="2026-11-06"/.test(sec) && /\+ Add a vendor day/.test(sec));
  ok('  …the store picker offers "All stores"', /<option value="">All stores<\/option>/.test(sec));
  const ro = MK.sectionHtml(gron, cx({ canEdit: false, stores: STORES, storeName: s => s, engineReady: true }));
  ok('a viewer can neither add nor remove days', !/data-mk-vadd/.test(ro) && !/data-mk-vdel/.test(ro));
}

console.log('\n2c. post dates, signs, featured cases and the vendor files link');
{
  const plan2 = { sel: { social: true, 'case': true, signage: true },
    rows: { social: [{ date: '2026-10-20' }, { date: '2026-10-14' }, { date: '2026-10-20' }],
            'case': [{ text: 'Front case', stores: ['center'] }], signage: [{ text: 'Window cling' }, { text: 'Readerboard' }] },
    d: { files: { url: 'https://drive.google.com/drive/folders/abc' } } };
  const q = prog({ marketing_json: plan2 });
  const pub = MK.tasksOf(q, {}).filter(t => t.id === 'social.publish');
  ok('"Publish posts" is one tick per post date, in date order, duplicates once',
     pub.map(t => t.key + '=' + t.due).join('|') === 'social.publish@2026-10-14=2026-10-14|social.publish@2026-10-20=2026-10-20');
  const set = MK.tasksOf(q, {}).filter(t => t.id === 'case.set').map(t => t.store);
  ok('case tasks go only to stores that have a case', set.join('|') === 'center');
  const noCase = MK.tasksOf(prog({ marketing_json: { sel: { 'case': true } } }), {}).filter(t => t.id === 'case.set').map(t => t.store);
  ok('  …and to every store until a case names one', noCase.join('|') === 'bend|center');
  const sec = MK.sectionHtml(q, cx({ stores: STORES, storeName: s => s, engineReady: true }));
  ok('post dates are date pickers, one per row, with Add', (sec.match(/data-mk-ritem="social"[^>]*data-mk-rfield="date"/g) || []).length === 3 && /\+ Add a post date/.test(sec));
  ok('signs are text boxes, one per row, with Add', (sec.match(/data-mk-ritem="signage"[^>]*data-mk-rfield="text"/g) || []).length === 2 && /\+ Add a sign/.test(sec));
  ok('a case row has store pills, the chosen one on', /class="mk-store-tick on" data-mk-ritem="case" data-mk-row="0" data-mk-rstore="center"/.test(sec)
     && /data-mk-rstore="bend"/.test(sec));
  ok('the folder link has an Open button that opens a new tab', /href="https:\/\/drive.google.com\/drive\/folders\/abc" target="_blank" rel="noopener noreferrer">Open folder/.test(sec));
  const bad = MK.sectionHtml(prog({ marketing_json: { d: { files: { url: 'javascript:alert(1)' } } } }), cx({ stores: STORES, storeName: s => s, engineReady: true }));
  ok('  …but only for an https link', !/Open folder/.test(bad));
  ok('the publish ticks are labeled by date', /each date: 0 of 2/.test(sec));
}

console.log('\n3. the pencil form and detail');
{
  const periods = [];
  for (let i = 0; i < 8; i++) { const s = MK.addDays('2026-10-12', 14 * i); periods.push({ start: s, end: MK.addDays(s, 13) }); }
  const form = MK.pencilFormHtml({ periods, programs: [prog()], pencils: [], day: '2026-10-20' });
  ok('the form opens on the period holding the clicked day', /<option value="2026-10-12" selected>/.test(form) && /<option value="2026-10-25" selected>/.test(form));
  ok('  …with whole-period choices only', count(form, /<option value="2026-10-26"/g) === 1 && !/<option value="2026-10-20"/.test(form));
  ok('  …and the overlap already named', /Also in this period: Kaprikorn/.test(form));
  const future = MK.pencilDetailHtml(PEN, { today: TODAY, canEdit: true, periods, programs: [], pencils: [PEN] });
  ok('a future slot offers Lock it in and Release the slot', /data-mk-act="penlock"/.test(future) && /data-mk-act="penrelease"/.test(future));
  ok('  …with no new-date choice and no warning', !/mkLkFirst/.test(future) && !/already started/.test(future));
  const past = MK.pencilDetailHtml(PEN, { today: '2026-11-12', canEdit: true, periods, programs: [], pencils: [PEN] });
  ok('a slot that has started says so and that it will not activate', /already started/.test(past) && /will not be/.test(past));
  ok('  …and offers new dates that are in the future', /id="mkLkFirst"/.test(past) && /<option value="2026-11-23" selected>/.test(past));
  const viewer = MK.pencilDetailHtml(PEN, { today: TODAY, canEdit: false, periods, programs: [], pencils: [PEN] });
  ok('a viewer can read a pencil and do nothing to it', !/penlock|penrelease/.test(viewer) && /dlgclose/.test(viewer));
  ok('everything typed is escaped', !/<script>/.test(MK.pencilDetailHtml(Object.assign({}, PEN, { brand: '<script>x</script>' }), { today: TODAY, canEdit: true, periods, programs: [], pencils: [] })));
}

console.log('\n4. open tasks across every program, by owner');
{
  const a = prog({ marketing_json: plan({ email: true }) });
  const b = prog({ program_id: 'gron', vendor: 'Gron', status: 'draft', start_date: '2026-10-26', end_date: '2026-11-08', marketing_json: plan({ signage: true }) });
  const closed = prog({ program_id: 'old', vendor: 'Old Co', status: 'closed', marketing_json: plan({ email: true }) });
  const unplanned = prog({ program_id: 'raw', vendor: 'Unplanned', marketing_json: null });
  const html = MK.tasksAcrossHtml([a, b, closed, unplanned], cx({ stores: STORES, storeName: s => s, owner: '' }));
  ok('it lists open tasks, grouped under Tawny, Mike and Managers in that order',
     html.indexOf('>Tawny<') > 0 && html.indexOf('>Tawny<') < html.indexOf('>Mike<') && html.indexOf('>Mike<') < html.indexOf('>Managers<'));
  ok('  …only from programs that are planned and not closed', /Kaprikorn/.test(html) && /Gron/.test(html) && !/Old Co/.test(html) && !/Unplanned/.test(html));
  ok('  …each row says which program and which add-on', /Kaprikorn · Email blast/.test(html));
  const mikeOnly = MK.tasksAcrossHtml([a, b], cx({ stores: STORES, storeName: s => s, owner: 'DIR' }));
  ok('the owner filter narrows it', !/>Tawny<[^]*?<div class="mk-task"/.test(mikeOnly.replace(/<span>\d+<\/span>/g, '')) || count(mikeOnly, /class="mk-phase"/g) === 1);
  ok('  …and marks the chosen person', /data-mk-owner="DIR" class="is-on"/.test(mikeOnly));
  const doneEverything = MK.tasksAcrossHtml([prog({ marketing_json: plan({}, {}) })], cx({ stores: STORES, storeName: s => s, owner: 'VEN' }));
  ok('an empty list says so', /Nothing open\./.test(doneEverything));
  ok('a tick carries the program it belongs to', /data-mk-xtask="core\.menu" data-mk-prog="kap"/.test(html));
  ok('a per-store task offers a tick per store', /data-mk-xtask="signage\.up@bend" data-mk-prog="gron"/.test(html));
  const ticked = MK.tasksAcrossHtml([prog({ marketing_json: plan({}, { 'core.menu': { by: 'sky', at: 'x' } }) })], cx({ stores: STORES, storeName: s => s }));
  ok('a task that is done disappears from the open list', !/data-mk-xtask="core\.menu"/.test(ticked));
  const ro = MK.tasksAcrossHtml([a], cx({ stores: STORES, storeName: s => s, canEdit: false }));
  ok('a viewer sees the boxes but cannot tick them', /data-mk-xtask="core\.menu"[^>]*disabled/.test(ro));
  const late = MK.overdueTotal([a, b, closed, unplanned], TODAY, { stores: ALL6 });
  ok('the badge counts the same overdue tasks the stat tile does', late === MK.lateOf(a, TODAY, { stores: ALL6 }).length + MK.lateOf(b, TODAY, { stores: ALL6 }).length + MK.lateOf(closed, TODAY, { stores: ALL6 }).length);
}

console.log('\n5. clicks reach the right handler');
{
  const handlers = {};
  const host = { addEventListener: (t, f) => { handlers[t] = f; }, contains: () => true };
  const seen = [];
  const api = new Proxy({}, { get: (_, name) => (...a) => seen.push([name, ...a]) });
  MK.wireViews(host, api);
  MK.wireViews(host, api);
  const click = (dataset, extra) => handlers.click({ target: { closest: () => Object.assign({ dataset, disabled: false, tagName: 'BUTTON', classList: { contains: () => false } }, extra || {}) } });
  click({ mkView: 'calendar' }); click({ mkNav: '-1' }); click({ mkOwner: 'DIR' }); click({ mkDay: '2026-10-20' });
  click({ mkPencil: 'pen-1' }); click({ mkOpen: 'kap' }); click({ mkAct: 'penlock', mkId: 'pen-1' });
  click({ mkXtask: 'core.menu', mkProg: 'kap' });
  ok('each control calls its own handler', seen.map(s => s[0]).join(',') === 'view,nav,owner,penAdd,pencil,open,act,tick');
  ok('  …with the right arguments', seen[1][1] === -1 && seen[6][1] === 'penlock' && seen[6][2] === 'pen-1' && seen[7][1] === 'kap' && seen[7][3] === true);
  ok('wiring twice does not double the listeners', Object.keys(handlers).length === 2);
  seen.length = 0;
  handlers.click({ target: { closest: () => ({ dataset: { mkDay: '2026-10-20' }, disabled: true }) } });
  ok('a disabled day does nothing', seen.length === 0);
  handlers.change({ target: { type: 'checkbox', checked: true, dataset: { mkXtask: 'core.menu', mkProg: 'kap' } } });
  ok('a checkbox ticks through the same path', seen[0][0] === 'tick' && seen[0][3] === true);
}

console.log('\n6. spiff.js: saving, releasing and locking a pencil');
function pencilJoin(role, answer) {
  const calls = [], log = { signIn: 0, closed: 0, errors: [], reloaded: 0, opened: [] };
  const fields = { '#mkPfBrand': { value: 'Mule Extracts' }, '#mkPfFirst': { value: '2026-11-09' }, '#mkPfLast': { value: '2026-11-22' }, '#mkPfNote': { value: 'budget' } };
  const src = ['mkDlgOpen', 'mkDlgClose', 'mkDlgError', 'mkPencilCall', 'mkPencilAct'].map(n => G.grab(n, JS)).join('\n');
  const fn = new Function('$', 'state', 'canEdit', 'mkView', 'ENG', 'session', 'clearSession', 'openSignIn', 'mkDlgPaint', 'mkRenderViews', 'loadPrograms', 'openProgram', 'extra',
    src + '\nreturn { mkPencilAct };');
  const state = { pencils: [PEN], stores: ALL6.map(s => ({ store_id: s })) };
  const mkView = { dlg: { kind: 'form' } };
  const api = fn((sel) => fields[sel] || null, state, () => role !== 'viewer', mkView,
    { jsonp: async (action, params) => { calls.push({ action, params }); return answer(action, params); } },
    () => ({ token: 'tok', user: 'tawny' }), () => {}, () => { log.signIn++; }, () => { if (!mkView.dlg) log.closed++; if (mkView.dlg && mkView.dlg.error) log.errors.push(mkView.dlg.error); },
    () => {}, async () => { log.reloaded++; }, (id) => log.opened.push(id), null);
  return { api, calls, state, mkView, log, fields };
}
(async () => {
  {
    const j = pencilJoin('editor', (a, p) => ({ ok: true, pencil: { pencil_id: 'pen-9', brand: p.brand, start_date: p.start_date, end_date: p.end_date, note: p.note, status: 'penciled' } }));
    await j.api.mkPencilAct('pensave');
    const c = j.calls[0];
    ok('Pencil it in sends brand, both ends and the note, with the session', c.action === 'savePencil' && c.params.brand === 'Mule Extracts'
       && c.params.start_date === '2026-11-09' && c.params.end_date === '2026-11-22' && c.params.note === 'budget' && c.params.token === 'tok');
    ok('  …adds it to the screen and closes the form', j.state.pencils.some(x => x.pencil_id === 'pen-9') && j.mkView.dlg === null);
  }
  {
    const j = pencilJoin('editor', () => ({ ok: true }));
    j.fields['#mkPfLast'].value = '2026-10-25';
    await j.api.mkPencilAct('pensave');
    ok('a last period before the first is stopped on the screen, no call made', j.calls.length === 0 && /comes before/.test(j.mkView.dlg.error));
    j.fields['#mkPfLast'].value = '2026-11-22'; j.fields['#mkPfBrand'].value = ' ';
    await j.api.mkPencilAct('pensave');
    ok('a blank brand is stopped too', j.calls.length === 0 && /brand name/.test(j.mkView.dlg.error));
  }
  {
    const j = pencilJoin('viewer', () => ({ ok: true }));
    await j.api.mkPencilAct('pensave'); await j.api.mkPencilAct('penrelease', 'pen-1'); await j.api.mkPencilAct('penlock', 'pen-1');
    ok('a viewer sends nothing at all', j.calls.length === 0);
  }
  {
    const j = pencilJoin('editor', () => ({ ok: true }));
    await j.api.mkPencilAct('penrelease', 'pen-1');
    ok('Release the slot calls the release route and takes the pencil off the screen', j.calls[0].action === 'releasePencil' && j.calls[0].params.id === 'pen-1' && j.state.pencils.length === 0);
  }
  {
    const j = pencilJoin('editor', () => ({ ok: true, program_id: 'mule-extracts-202611', locked: true }));
    await j.api.mkPencilAct('penlock', 'pen-1');
    const c = j.calls[0];
    ok('Lock it in calls the lock route with the real stores from Core', c.action === 'lockPencil' && c.params.id === 'pen-1' && c.params.stores === JSON.stringify(ALL6));
    ok('  …then reloads the programs and opens the new draft', j.log.reloaded === 1 && j.log.opened[0] === 'mule-extracts-202611' && j.state.pencils.length === 0);
  }
  {
    const j = pencilJoin('editor', () => ({ ok: false, error: 'That slot was already locked.' }));
    await j.api.mkPencilAct('penlock', 'pen-1');
    ok('a refusal is shown in the dialog and the pencil stays', /already locked/.test(j.mkView.dlg.error) && j.state.pencils.length === 1 && j.log.reloaded === 0);
  }
  {
    const j = pencilJoin('editor', () => ({ ok: false, needsAuth: true, error: 'Not signed in' }));
    await j.api.mkPencilAct('penrelease', 'pen-1');
    ok('an expired session opens sign-in', j.log.signIn === 1 && j.state.pencils.length === 1);
  }

  console.log('\n7. the curtain and the hedge');
  const hedge = /var ENGINE_HEDGE_READS = \{([^}]*)\}/.exec(JS)[1];
  ok('no pencil route is hedged (a hedged write runs twice)', !/pencil/i.test(hedge));
  ok('  …not even the read, which is its own decision', !/\bpencils\b/.test(hedge));
  const off = G.grab('mkRenderViews', JS);
  const nodes = { '#mkViewSeg': { hidden: false, classList: { toggle() {} } }, '#mkView': { hidden: false, innerHTML: 'x' }, '#mkPencils': { innerHTML: 'x' },
                  '#progStats': { hidden: false }, '#progRunning': { hidden: false }, '#progDrafts': { hidden: false }, '#progClosed': { hidden: false } };
  const run = new Function('$', '$$', 'mkOn', 'mkView', 'MK', 'state', 'today', 'mkOpts', 'canEdit', 'mkStoreList', 'storeName', 'mkWireViews', 'mkLoadPencils', 'mkDlgPaint',
    off + '\nreturn mkRenderViews;');
  const loads = [];
  const render = run(s => nodes[s] || null, () => [], () => false, { view: 'calendar', offset: 0, owner: '', ready: true }, MK, { programs: [], pencils: null }, () => TODAY, () => ({}), () => true, () => [], s => s, () => {}, () => loads.push(1), () => {});
  render();
  ok('with the switch off the new buttons stay hidden and the list is untouched', nodes['#mkViewSeg'].hidden === true && nodes['#progStats'].hidden === false
     && nodes['#mkView'].innerHTML === '' && nodes['#mkPencils'].innerHTML === '');
  ok('  …and the pencils are not even fetched', loads.length === 0);
  /* Sky, 2026-11-02: Mike runs the blast cycle and Tawny the deals, so the preview opens to them. */
  ok('the switch is still closed to everyone but Sky, Mike, Tawny and the read-only dev viewer', /var VISIBLE_TO_EVERYONE = false;/.test(SRC) && /var PREVIEW_USERS = \['sky', 'mike', 'tawny', 'gx-dev'\];/.test(SRC));
  ok('the app still has three top-level tabs', (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/data-tab="/g) || []).length === 3);

  console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing calendar: all passed');
  process.exit(fail ? 1 : 0);
})();
