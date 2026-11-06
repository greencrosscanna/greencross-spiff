#!/usr/bin/env node
/* ─── Holiday sends: the engine's routes and the screen's tasks, run for real ────────────────────
 *
 *   RUN:  node tests/marketing_holidays_test.js
 *
 * A holiday send (Thanksgiving, Christmas, New Year's Eve) is our own email and/or text blast. It runs
 * the blast cycle a vendor program's email and text run, counted back from its send date, and it is
 * NOT a program: it lives in its own `holidays` tab. What is checked:
 *   · saveHoliday_, cancelHoliday_, saveHolidayPlan_ and holidaysRead_ from their real source, sheet
 *     and session stubbed: only an editor writes, a retry is not a second send, rows are never
 *     deleted, the stored plan keeps only ticks, moved dates and hand-offs;
 *   · marketingAssign_ hands off a holiday's task and emails once;
 *   · marketing.js reads a holiday as a program with only its blast items picked: the same task ids,
 *     owners and offsets, none of the vendor-only tasks, on the Calendar and in the Tasks view.
 * That nothing paying reads the tab is tests/marketing_pay_isolation_test.js's job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const HOL_H = G.grabVar('HOLIDAY_HEADERS');
const hcol = (n) => HOL_H.indexOf(n);

function engine(role) {
  const programs = G.makeSheet(G.grabVar('PROGRAM_HEADERS'), []);
  const book = G.makeBook({ programs });
  programs.getParent = () => book;
  const props = G.makeProps({});
  const mails = [];
  const api = G.load({
    real: ['holidaySheet_', 'holidayChannels_', 'holidayPlan_', 'rowToHoliday_', 'holidayToRow_', 'readHolidays_',
           'holidaysRead_', 'findHolidayRow_', 'getHoliday_', 'saveHoliday_', 'cancelHoliday_', 'saveHolidayPlan_',
           'mktEditor_', 'normalizeMarketing_', 'applyMarketingDelta_', 'parseJson_', 'textDate_',
           'marketingAssign_', 'prettyDay_'],
    vars: ['HOLIDAYS_TAB', 'HOLIDAY_HEADERS', 'HOLIDAY_CHANNELS', 'EDIT_ROLES', 'MKT_PEOPLE_', 'MKT_ASSIGNED_PREFIX', 'MKT_APP_URL'],
    stubs: {
      dataSheet_: () => programs,
      gxAuth_: (t) => (t === 'good' ? { ok: true, user: 'sky', role: role || 'admin' } : { ok: false, error: 'bad token' }),
      nowStamp_: () => '2026-11-02 09:00:00',
      getProgram_: () => { throw new Error('a holiday hand-off read the programs tab'); },
      brandProgramLabel_: () => { throw new Error('a holiday was labeled as a program'); },
      sendMail_: (m) => { mails.push(m); },
      scrubSecrets_: (x) => String(x),
    },
    globals: {
      PropertiesService: props.PropertiesService, console: { warn() {}, log() {} },
      GXCore: { roleCanEdit: (r) => ['editor', 'admin', 'director', 'manager'].indexOf(r) >= 0 },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    },
  });
  return { api, book, programs, mails };
}
const holRows = (e) => (e.book.getSheetByName('holidays') ? e.book.getSheetByName('holidays').rows.slice(1) : []);
const TG = { token: 'good', name: 'Thanksgiving', send_date: '2026-11-23', channels: 'email,sms', note: 'Pre-holiday deals' };

console.log('\n1. only an editor writes');
{
  const e = engine('viewer');
  for (const [name, args] of [['saveHoliday_', TG], ['cancelHoliday_', { token: 'good', id: 'x' }],
                              ['saveHolidayPlan_', { token: 'good', id: 'x', patch: '{"marketing_delta":[]}' }]]) {
    const r = e.api[name](args);
    ok(name + ': a viewer is refused', r.ok === false && /cannot/.test(r.error));
  }
  ok('  …and nothing was written', holRows(e).length === 0);
  ok('a bad token says to sign in', engine().api.saveHoliday_(Object.assign({}, TG, { token: 'nope' })).needsAuth === true);
}

console.log('\n2. adding one');
{
  const e = engine();
  const bad = (over) => e.api.saveHoliday_(Object.assign({}, TG, over));
  ok('no name is refused', bad({ name: '  ' }).ok === false);
  ok('no send date is refused', bad({ send_date: 'soon' }).ok === false);
  ok('no channel is refused', bad({ channels: 'fax' }).ok === false);
  ok('  …and every refusal wrote nothing', holRows(e).length === 0);
  const r = e.api.saveHoliday_(TG);
  ok('it saves, stamped with who', r.ok && r.created && r.holiday.created_by === 'sky' && /^hol-/.test(r.holiday.holiday_id));
  const row = holRows(e)[0];
  ok('  …into its OWN tab, not programs', holRows(e).length === 1 && e.programs.rows.length === 1);
  ok('  …planned, the date as text, both channels', row[hcol('status')] === 'planned' && row[hcol('send_date')] === '2026-11-23'
     && row[hcol('channels')] === 'email,sms');
  ok('a retried call is a replay, not a second send', e.api.saveHoliday_(Object.assign({}, TG, { name: 'thanksgiving' })).replay === true && holRows(e).length === 1);
  ok('the read serves it, channels as a list', JSON.stringify(e.api.holidaysRead_().holidays[0].channels) === '["email","sms"]');
  const ch = e.api.saveHoliday_({ token: 'good', id: r.holiday.holiday_id, name: 'Thanksgiving', send_date: '2026-11-24', channels: 'email', note: '' });
  ok('editing changes the date and channels in place', ch.ok && holRows(e).length === 1
     && holRows(e)[0][hcol('send_date')] === '2026-11-24' && holRows(e)[0][hcol('channels')] === 'email');
}

console.log('\n3. ticks, moved dates and hand-offs');
{
  const e = engine();
  const id = e.api.saveHoliday_(TG).holiday.holiday_id;
  const save = (ops) => e.api.saveHolidayPlan_({ token: 'good', id, patch: JSON.stringify({ marketing_delta: ops }) });
  save([['done', 'blast.deal', { by: 'tawny', at: 'x' }]]);
  const r = save([['due', 'email.send', '2026-11-24'], ['own', 'blast.copy', 'sky'], ['sel', 'raffle', true], ['d', 'email', { date: '2027-01-01' }]]);
  ok('the delta applies on top of what is stored', r.ok && r.marketing_json.done['blast.deal'].by === 'tawny'
     && r.marketing_json.due['email.send'] === '2026-11-24' && r.marketing_json.own['blast.copy'] === 'sky');
  ok('  …and nothing else is kept: channels and the date are columns, not plan', !r.marketing_json.sel && !r.marketing_json.d);
  ok('an unknown person is not kept as an owner', !save([['own', 'blast.deal', 'bob']]).marketing_json.own['blast.deal']);
  ok('the read carries the plan back', e.api.holidaysRead_().holidays[0].marketing_json.done['blast.deal'].by === 'tawny');
}

console.log('\n4. canceling never deletes');
{
  const e = engine();
  const id = e.api.saveHoliday_(TG).holiday.holiday_id;
  const r = e.api.cancelHoliday_({ token: 'good', id });
  ok('it cancels', r.ok && r.canceled === true);
  ok('  …off the read', e.api.holidaysRead_().holidays.length === 0);
  ok('  …the row stays, marked canceled, with who', holRows(e).length === 1 && holRows(e)[0][hcol('status')] === 'canceled'
     && holRows(e)[0][hcol('closed_by')] === 'sky');
  ok('a canceled send takes no more ticks', e.api.saveHolidayPlan_({ token: 'good', id, patch: '{"marketing_delta":[["done","blast.deal",{"by":"x","at":"y"}]]}' }).ok === false);
  ok('canceling again changes nothing', e.api.cancelHoliday_({ token: 'good', id }).canceled === false);
}

console.log('\n5. handing a holiday task to someone');
{
  const e = engine();
  const id = e.api.saveHoliday_(TG).holiday.holiday_id;
  e.api.saveHolidayPlan_({ token: 'good', id, patch: JSON.stringify({ marketing_delta: [['own', 'blast.copy', 'mike']] }) });
  const base = { token: 'good', id, kind: 'holiday', task: 'blast.copy', text: 'Copy and Dutchie draft ready', due: '2026-11-19' };
  const r = e.api.marketingAssign_(Object.assign({ person: 'mike' }, base));
  ok('it emails the person it is stored against', r.ok && r.sent && e.mails.length === 1 && e.mails[0].to === 'mike@greencrosscanna.com');
  ok('  …naming the holiday, not a program', /Holiday send: Thanksgiving/.test(e.mails[0].subject) && /Holiday send: Thanksgiving/.test(e.mails[0].body));
  ok('  …once', e.api.marketingAssign_(Object.assign({ person: 'mike' }, base)).sent === false && e.mails.length === 1);
  ok('not to someone it is not stored against', e.api.marketingAssign_(Object.assign({ person: 'tawny' }, base)).ok === false);
}

/* ── The screen ───────────────────────────────────────────────────────────────────────────────── */
const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;
const H = { holiday_id: 'hol-1', name: 'Thanksgiving', send_date: '2026-11-23', channels: ['email', 'sms'], note: '', marketing_json: { v: 1 } };
const byId = (p) => { const m = {}; MK.groupTasks(MK.tasksOf(p, { stores: ['bend'] })).forEach(g => { m[g.id] = g; }); return m; };

console.log('\n6. a holiday runs the blast cycle, counted back from its send date');
{
  const t = byId(MK.holidayProgram(H));
  ok('the deal is Tawny\'s, two weeks before', t['blast.deal'].owner === 'Tawny' && t['blast.deal'].due === '2026-11-09');
  ok('the hand-off to Mike is Tawny\'s, the Wednesday before', t['blast.handoff'].owner === 'Tawny' && t['blast.handoff'].due === '2026-11-18');
  ok('copy is Mike\'s, Thursday', t['blast.copy'].owner === 'Mike' && t['blast.copy'].due === '2026-11-19');
  ok('both proofs are Mike\'s, Friday', t['email.review'].owner === 'Mike' && t['email.review'].due === '2026-11-20'
     && t['sms.approve'].owner === 'Mike' && t['sms.approve'].due === '2026-11-20');
  ok('both sends are Mike\'s, on the send date', t['email.send'].due === '2026-11-23' && t['sms.send'].due === '2026-11-23');
  ok('stats three days after', t['email.stats'].owner === 'Mike' && t['email.stats'].due === '2026-11-26');
  ok('no vendor-only task: no creative, no cost model', !t['email.creative'] && !t['sms.cost']);
  ok('no program task and no incentive', !Object.keys(t).some(id => /^(core|incentive)\./.test(id)));
  ok('exactly the cycle, nothing else', Object.keys(t).sort().join() === 'blast.copy,blast.deal,blast.handoff,email.review,email.send,email.stats,sms.approve,sms.send');
  const textOnly = byId(MK.holidayProgram(Object.assign({}, H, { channels: ['sms'] })));
  ok('text only: no email tasks, the shared pair once', !textOnly['email.send'] && textOnly['sms.send'] && textOnly['blast.deal']);
  const moved = byId(MK.holidayProgram(Object.assign({}, H, { send_date: '2026-12-21' })));
  ok('move the send date and the whole cycle moves', moved['blast.deal'].due === '2026-12-07' && moved['email.send'].due === '2026-12-21');
  const ticked = byId(MK.holidayProgram(Object.assign({}, H, { marketing_json: { done: { 'blast.deal': { by: 'tawny', at: 'x' } }, own: { 'blast.copy': 'sky' } } })));
  ok('its own ticks and hand-offs read back', ticked['blast.deal'].open === 0 && ticked['blast.copy'].owner === 'Sky');
}

console.log('\n7. on the Calendar and in the Tasks view');
{
  const today = '2026-11-02';
  const cal = MK.calendarHtml([], [], { today, canEdit: true, offset: 0, holidays: [H] });
  ok('the Calendar draws it on its send date, opening its own dialog', /data-mk-holiday="hol-1"/.test(cal) && /Thanksgiving \(Email \+ Text\)/.test(cal));
  ok('  …with a legend entry and an add button', /Holiday send<\/span>/.test(cal) && /data-mk-act="holadd"/.test(cal));
  ok('  …and never as a program bar', !/data-mk-open="hol-1"/.test(cal));
  const view = MK.tasksAcrossHtml([MK.holidayProgram(H)], { today, canEdit: true, owner: '', stores: [], storeName: s => s });
  ok('the Tasks view lists its open tasks under the person', /Deal and timeline set/.test(view) && /Holiday send/.test(view));
  ok('  …ticked against the holiday', /data-mk-xtask="blast.deal" data-mk-prog="hol-1"/.test(view));
  ok('  …and Open opens the holiday, not a program', /data-mk-holiday="hol-1"/.test(view) && !/data-mk-open="hol-1"/.test(view));
  const dlg = MK.holidayDialogHtml(H, { today, canEdit: true, moving: '', storeName: s => s });
  ok('its dialog lists the tasks with an owner picker each', /data-mk-assign="blast.deal"/.test(dlg) && /data-mk-task="email.send"/.test(dlg));
  ok('  …and can cancel it, not delete it', /data-mk-act="holcancel"/.test(dlg) && !/delete/i.test(dlg));
  ok('a new one has no tasks until it is saved', !/data-mk-assign/.test(MK.holidayDialogHtml(null, { today, canEdit: true })));
  const viewer = MK.holidayDialogHtml(H, { today, canEdit: false, moving: '', storeName: s => s });
  ok('a viewer gets it read-only', !/data-mk-assign/.test(viewer) && !/holsave/.test(viewer));
  ok('a name cannot inject markup', MK.holidayDialogHtml(Object.assign({}, H, { name: '<b>x' }), { today, canEdit: true, storeName: s => s }).indexOf('<b>x') < 0);
}

console.log('\n8. the suggested send date is the Monday before the holiday');
{
  const T = '2026-11-02';
  const s = (name, typed, today) => MK.sendSuggestion(name, typed || '', today || T);
  ok('Thanksgiving 2026 (Thu Nov 26) suggests Mon Nov 23', s('Thanksgiving').date === '2026-11-23' && /Thanksgiving/.test(s('Thanksgiving').text));
  ok('Black Friday (Nov 27) and Green Wednesday (Nov 25) suggest the same Monday',
     s('Black Friday deals').date === '2026-11-23' && s('Green Wednesday').date === '2026-11-23');
  ok('Christmas 2026 (Fri) suggests Mon Dec 21', s('Christmas').date === '2026-12-21');
  ok('New Year\'s Eve 2026 (Thu) suggests Mon Dec 28', s('New Year\'s Eve').date === '2026-12-28' && s('NYE blast').date === '2026-12-28');
  ok('a holiday already past this year looks to next year: 4/20 → Mon Apr 19, 2027', s('4/20').date === '2027-04-19');
  ok('Memorial Day 2027 (Mon May 31) sends the Monday a week before', s('Memorial Day', '', '2027-01-10').date === '2027-05-24');
  ok('Labor Day 2027 is the first Monday of September', MK.holidayOn('Labor Day', '2027-01-10').day === '2027-09-06');
  ok('a name it does not know, with no date, suggests nothing', s('Spring cleanout') === null);
  ok('any date that is not a Monday is offered the Monday before it', s('Spring cleanout', '2026-12-03').date === '2026-11-30');
  ok('a Monday that is not a holiday needs no suggestion', s('Spring cleanout', '2026-11-30') === null);
  ok('the dialog shows the suggestion with a Use-it button while the date differs',
     /Suggested: Mon, Nov 23.*data-mk-act="holsuggest" data-mk-id="2026-11-23"/.test(
       MK.holidayDialogHtml(Object.assign({}, H, { send_date: '2026-11-25' }), { today: T, canEdit: true, storeName: x => x })));
  ok('  …a blank new one says nothing until a name or date is typed', !/Suggested/.test(MK.holidayDialogHtml(null, { today: T, canEdit: true })));
  ok('  …and just the note once the date matches', !/holsuggest/.test(MK.suggestionHtml(s('Thanksgiving'), '2026-11-23')));
  ok('  …and nothing for a viewer', !/Suggested/.test(MK.holidayDialogHtml(H, { today: T, canEdit: false })));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing holidays: all passed');
process.exit(fail ? 1 : 0);
