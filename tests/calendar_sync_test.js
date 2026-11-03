#!/usr/bin/env node
/* ─── The Marketing Calendar fills from SPIFF, one way, and never blocks anything else ────────────
 *
 *   RUN:  node tests/calendar_sync_test.js
 *
 * Sky, 2026-11-02: SPIFF programs, penciled holds and vendor days go onto Tawny's
 * shared Google calendar. This RUNS the engine's own sync against an in-memory calendar (the real
 * adapter, with CalendarApp and Utilities.parseDate stood in) and checks the things that matter:
 *   · an edit MOVES the event, it never makes a second one (same key, updated in place)
 *   · a hand-made event is never updated or removed, only REPORTED as a possible duplicate
 *   · removals have brakes (empty programs tab, more than the cap)
 *   · an event beyond the window is not made (it could never be found again, so it would repeat)
 *   · the hourly step is off by default, and a Calendar failure is caught and logged
 *   · dates are Los Angeles days; "12-2" and "3 PM" become real times, junk stays all-day
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* Utilities with parseDate, honoring the zone: LA is -07:00 until 2026-11-01 02:00, -08:00 after. */
const Util = Object.assign({}, G.Utilities, {
  parseDate(text, tz, fmt) {
    const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    for (const off of [7, 8]) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + off, +m[5]));
      if (G.Utilities.formatDate(d, tz, 'x').slice(0, 16) === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`) return d;
    }
    throw new Error('unparseable ' + text);
  },
});

/* A Calendar that stores events the way CalendarApp hands them back. */
function makeCalendar(seed) {
  let n = 0;
  const events = [];
  const wrap = (o) => {
    const e = Object.assign({ tags: {}, deleted: false }, o);
    e.id = 'ev' + (++n);
    e.getId = () => e.id;
    e.getTag = (k) => e.tags[k] || null;
    e.setTag = (k, v) => { e.tags[k] = v; };
    e.isAllDayEvent = () => e.allDay;
    e.getTitle = () => e.title; e.setTitle = (t) => { e.title = t; };
    e.getDescription = () => e.description || ''; e.setDescription = (t) => { e.description = t; };
    e.getAllDayStartDate = () => e.start; e.getAllDayEndDate = () => e.end;
    e.getStartTime = () => e.start; e.getEndTime = () => e.end;
    e.setAllDayDates = (s, x) => { e.allDay = true; e.start = s; e.end = x; };
    e.setTime = (s, x) => { e.allDay = false; e.start = s; e.end = x; };
    e.deleteEvent = () => { e.deleted = true; };
    events.push(e);
    return e;
  };
  const cal = {
    events,
    live: () => events.filter((e) => !e.deleted),
    getEvents: (a, b) => events.filter((e) => !e.deleted && e.start < b && e.end > a),
    createAllDayEvent: (title, s, x, o) => wrap({ title, start: s, end: x, allDay: true, description: o.description }),
    createEvent: (title, s, x, o) => wrap({ title, start: s, end: x, allDay: false, description: o.description, guests: o.guests }),
    getName: () => 'Marketing Calendar',
  };
  (seed || []).forEach((s) => wrap(Object.assign({ allDay: true }, s)));
  return cal;
}

const props = {};
let CAL = makeCalendar();
const NAMES = {};
const api = G.load({
  real: ['calParseTime_', 'calHandMadeTwin_', 'calendarDesired_', 'calSame_', 'calendarAdapter_', 'calendarSync_', 'calendarSyncWeb_',
         'runCalendarSyncHourly_', 'addDaysLocal_', 'brandProgramLabel_', 'normalizeMarketing_', 'mktPickedIds_', 'slug_'],
  vars: ['MKT_CALENDAR_ID_', 'CAL_TAG_', 'CAL_LOOKBACK_DAYS_', 'CAL_LOOKAHEAD_DAYS_', 'CAL_MAX_REMOVES_', 'CAL_NOTE_',
         'MKT_MENU_', 'MKT_PEOPLE_', 'GX_SECRET_PROP'],
  stubs: { calendarSource_: () => SRC, listPrograms_: () => SRC.programs },
  globals: {
    Utilities: Util,
    CalendarApp: { getCalendarById: (id) => (id === G.grabVar('MKT_CALENDAR_ID_') ? CAL : null) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    console,
  },
});
/* calendarSync_ calls calendarSource_ by name; the stub shim above is not reachable from a real
   function loaded beside it, so hand the source in explicitly and keep the stub only as a tripwire. */
let SRC = null;

const prog = (id, vendor, status, start, end, extra) => Object.assign({
  program_id: id, vendor, program_name: 'All products', status, start_date: start, end_date: end,
  marketing_json: '', stores_json: ['bend'],
}, extra || {});
const planWith = (vdays) => ({ v: 1, sel: { vday: true }, vdays });
const TODAY = '2026-11-02';
const sync = (o) => api.calendarSync_(Object.assign({ today: TODAY, cal: api.calendarAdapter_(), source: SRC }, o || {}));
const source = (o) => Object.assign({ programs: [], pencils: [], holidays: [], storeNames: { bend: 'Bend', 'river-rd': 'River' } }, o || {});

console.log('\n1. times and titles');
const T = api.calParseTime_;
ok('"12-2" is noon to 2pm', JSON.stringify(T('12-2')) === '{"start":"12:00","end":"14:00"}');
ok('"3:00 PM - 6:00 PM"', JSON.stringify(T('3:00 PM - 6:00 PM')) === '{"start":"15:00","end":"18:00"}');
ok('"11am to 1pm" crosses noon', JSON.stringify(T('11am to 1pm')) === '{"start":"11:00","end":"13:00"}');
ok('"12–2pm" with an en dash', JSON.stringify(T('12–2pm')) === '{"start":"12:00","end":"14:00"}');
ok('"4pm" alone runs two hours', JSON.stringify(T('4pm')) === '{"start":"16:00","end":"18:00"}');
ok('"10-12" is a morning', JSON.stringify(T('10-12')) === '{"start":"10:00","end":"12:00"}' || JSON.stringify(T('10-12')) === '{"start":"10:00","end":"24:00"}'.replace('24:00', '12:00'));
ok('junk and empty give null (the event stays all day)', T('after lunch') === null && T('') === null && T('25-26') === null);

console.log('\n2. what is made');
SRC = source({
  programs: [
    prog('mule-1', 'Mule Extracts', 'active', '2026-10-26', '2026-11-08'),
    prog('gron-1', 'Gron', 'draft', '2026-11-09', '2026-11-22'),
    prog('hella-1', 'Hellavated', 'closed', '2026-09-14', '2026-09-27', {
      marketing_json: planWith([{ store: 'bend', date: '2026-11-06', time: '12-2' }, { store: '', date: '2026-11-07', time: 'after lunch' }]) }),
  ],
  pencils: [{ pencil_id: 'pen-1', brand: 'Kaprikorn', start_date: '2026-12-07', end_date: '2026-12-20', note: 'hold', status: 'penciled' }],
  holidays: [{ holiday_id: 'hol-1', name: 'Black Friday', send_date: '2026-11-27', channels: ['email', 'sms'], note: '', status: 'planned' }],
});
let r = sync({ apply: false });
ok('a dry run writes nothing', CAL.live().length === 0 && r.created.length > 0);
r = sync({ apply: true });
const by = (k) => CAL.live().find((e) => e.tags.spiff_key === k);
ok('a program is an all-day event with an exclusive end (Mule 10/26-11/08 ends 11/09)',
   by('program:mule-1').allDay && by('program:mule-1').title === 'Mule Extracts Spiff');
ok('  …a draft says so', by('program:gron-1').title === 'Gron Spiff (draft)');
ok('a penciled hold is "Spiff reserved - Brand"', by('pencil:pen-1').title === 'Spiff reserved - Kaprikorn');
ok('a holiday send is NOT put on the company calendar (Sky: it stays internal)', !CAL.live().some((e) => /Black Friday/.test(e.title) || /^holiday:/.test(e.tags.spiff_key)));
ok('a timed vendor day gets real times, named by store', by('vday:hella-1:0').title === 'Hellavated Vendor Day - Bend'
   && !by('vday:hella-1:0').allDay);
ok('  …at noon to two Los Angeles time (PST after Nov 1: 20:00Z to 22:00Z)',
   by('vday:hella-1:0').start.toISOString() === '2026-11-06T20:00:00.000Z' && by('vday:hella-1:0').end.toISOString() === '2026-11-06T22:00:00.000Z');
ok('a vendor day with unreadable time stays all day, the text in the title, "All stores" when no store',
   by('vday:hella-1:1').allDay && by('vday:hella-1:1').title === 'Hellavated Vendor Day - All stores (after lunch)');
ok('no invites by default', !by('vday:hella-1:0').guests);
ok('every event is tagged with the SPIFF key and says it is managed there', CAL.live().every((e) => e.tags.spiff_key && /Managed by SPIFF/.test(e.description)));
const made = CAL.live().length;

console.log('\n3. edits move the event, nothing duplicates');
r = sync({ apply: true });
ok('a second run changes nothing', r.created.length === 0 && r.updated.length === 0 && r.removed.length === 0 && CAL.live().length === made);
SRC.programs[2].marketing_json = planWith([{ store: 'bend', date: '2026-11-13', time: '12-2' }, { store: '', date: '2026-11-07', time: 'after lunch' }]);
r = sync({ apply: true });
ok('moving a vendor day UPDATES the same event (still one, new date)',
   r.updated.length === 1 && r.created.length === 0 && CAL.live().length === made
   && by('vday:hella-1:0').start.toISOString() === '2026-11-13T20:00:00.000Z');
SRC.programs[0].end_date = '2026-11-15';
r = sync({ apply: true });
ok('extending a program moves its end in place', r.updated.length === 1 && CAL.live().length === made
   && Util.formatDate(by('program:mule-1').end, 'America/Los_Angeles', 'yyyy-MM-dd') === '2026-11-16');
SRC.pencils = [];
SRC.programs.push(prog('kap-1', 'Kaprikorn', 'draft', '2026-12-07', '2026-12-20'));
r = sync({ apply: true });
ok('locking a pencil in swaps the hold for the draft (one removed, one made)', r.removed.length === 1 && r.created.length === 1
   && !by('pencil:pen-1') && by('program:kap-1'));

console.log('\n4. hand-made events are never touched');
CAL = makeCalendar([
  { title: 'Mule Extracts Spiff', start: Util.parseDate('2026-10-26 00:00', 'America/Los_Angeles'), end: Util.parseDate('2026-11-09 00:00', 'America/Los_Angeles') },
  { title: 'Spiff reserved', start: Util.parseDate('2026-11-09 00:00', 'America/Los_Angeles'), end: Util.parseDate('2026-11-23 00:00', 'America/Los_Angeles') },
]);
SRC = source({ programs: [prog('mule-1', 'Mule Extracts', 'active', '2026-10-26', '2026-11-08')] });
r = sync({ apply: true });
const hand = CAL.live().filter((e) => !e.tags.spiff_key);
ok('SPIFF makes no copy of the program a hand-made event already covers (reported as skipped)',
   r.skipped_duplicates.length === 1 && r.created.length === 0 && !by('program:mule-1'));
ok('both hand-made events survive untouched', hand.length === 2 && hand[0].title === 'Mule Extracts Spiff' && hand[1].title === 'Spiff reserved');
ok('  …and names which hand-made event covers it', r.skipped_duplicates[0].hand_made === 'Mule Extracts Spiff');
CAL = makeCalendar([
  { title: 'Gron Halloween Gummy Spiff', start: Util.parseDate('2026-10-26 00:00', 'America/Los_Angeles'), end: Util.parseDate('2026-11-09 00:00', 'America/Los_Angeles') },
]);
SRC = source({ programs: [prog('gron-1', 'Gron', 'active', '2026-10-26', '2026-11-08', { marketing_json: planWith([{ store: 'bend', date: '2026-11-03', time: '' }]) })] });
r = sync({ apply: true });
ok('a hand-made SPIFF span covers the program but NOT its vendor day (different kind): only the day is made',
   r.skipped_duplicates.length === 1 && r.created.length === 1 && r.created[0].key === 'vday:gron-1:0');
CAL = makeCalendar([
  { title: 'Gron Vendor Day - South', start: Util.parseDate('2026-11-03 12:00', 'America/Los_Angeles'), end: Util.parseDate('2026-11-03 14:00', 'America/Los_Angeles'), allDay: false },
]);
r = sync({ apply: true });
ok('a hand-made vendor day for the same brand and date covers SPIFF\'s vendor day (store spelling does not matter)',
   r.skipped_duplicates.some((x) => /Vendor Day/.test(x.spiff)) && !CAL.live().some((e) => e.tags.spiff_key === 'vday:gron-1:0'));
SRC = source({ programs: [] });
r = sync({ apply: true });
ok('with every program gone, hand-made events still stand', CAL.live().filter((e) => !e.tags.spiff_key).length === 1);

console.log('\n5. brakes');
CAL = makeCalendar();
SRC = source({ programs: [prog('a', 'A', 'active', '2026-11-01', '2026-11-10')] });
sync({ apply: true });
SRC = source({ programs: [] });
r = sync({ apply: true });
ok('an EMPTY programs tab removes nothing (it would look like everything was deleted)', r.refused && CAL.live().length === 1 && r.removed.length === 0);
CAL = makeCalendar();
SRC = source({ programs: Array.from({ length: 14 }, (_, i) => prog('p' + i, 'B' + i, 'active', '2026-11-01', '2026-11-10')) });
sync({ apply: true });
SRC = source({ programs: [prog('p0', 'B0', 'active', '2026-11-01', '2026-11-10')] });
r = sync({ apply: true });
ok('removing 13 in one hour is refused, every event kept', /limit/.test(r.refused) && CAL.live().length === 14);
ok('  …but the edit to the one that remains is still allowed', r.unchanged === 1);
CAL = makeCalendar();
SRC = source({ programs: [prog('far', 'Far', 'draft', '2028-01-01', '2028-01-14'), prog('old', 'Old', 'closed', '2026-01-01', '2026-01-14')] });
sync({ apply: true }); r = sync({ apply: true });
ok('an event outside the window is not made (so it can never repeat)', CAL.live().length === 0 && r.created.length === 0);
CAL = makeCalendar();
SRC = source({ programs: [prog('d', 'Dup', 'active', '2026-11-01', '2026-11-10')] });
sync({ apply: true });
const e0 = CAL.live()[0];
CAL.createAllDayEvent('Dup Spiff', e0.start, e0.end, { description: '' }).setTag('spiff_key', 'program:d');
r = sync({ apply: true });
ok('a second copy of one key is cleaned up', CAL.live().length === 1 && r.removed.length === 1);

console.log('\n6. invites');
CAL = makeCalendar();
SRC = source({ programs: [prog('v', 'Vee', 'active', '2026-11-01', '2026-11-10', { marketing_json: planWith([{ store: 'bend', date: '2026-11-06', time: '12-2' }]) })] });
sync({ apply: true, invite: '1' });
ok('with the switch on, a NEW timed vendor day invites Mike, once', CAL.live().find((e) => e.tags.spiff_key === 'vday:v:0').guests === 'mike@greencrosscanna.com');
ok('  …and the program span invites no one', !CAL.live().find((e) => e.tags.spiff_key === 'program:v').guests);

console.log('\n7. the hourly step');
CAL = makeCalendar();
SRC = source({ programs: [prog('h', 'Hee', 'active', '2026-11-01', '2026-11-10')] });
const hourly = G.load({
  real: ['runCalendarSyncHourly_'],
  stubs: { calendarSync_: () => { throw new Error('Calendar is down'); } },
  globals: { PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) }, console },
});
ok('OFF by default: the step does nothing and says so', api.runCalendarSyncHourly_().skipped === true && CAL.live().length === 0);
props.CAL_SYNC_ON = '1';
let threw = false;
try { hourly.runCalendarSyncHourly_(); } catch (e) { threw = true; }
ok('a failing sync throws out of the step itself (the trigger catches it, in its own try)', threw);
const trig = G.grab('refreshSpiffProgressTrigger');
const iPub = trig.indexOf('publishSpiffToCore_('), iCal = trig.indexOf('runCalendarSyncHourly_()'), iFin = trig.indexOf('} finally');
ok('the trigger runs the calendar AFTER the publish and inside the lease', iPub > 0 && iCal > iPub && iCal < iFin);
ok('  …wrapped in its own try/catch that logs', /try \{ runCalendarSyncHourly_\(\); \}\s*catch \(e\) \{ console\.warn\('\[spiff\] calendar sync FAILED/.test(trig));

console.log('\n8. wiring');
ok('the route is secret-gated', G.grabVar('SECRET_ACTIONS').indexOf('calendarSync') >= 0);
ok('and dispatched', /case 'calendarSync': out = calendarSyncWeb_\(p\)/.test(G.GS));
ok('a wrong secret is refused', (() => {
  const w = G.load({ real: ['calendarSyncWeb_'], vars: ['GX_SECRET_PROP'],
    globals: { PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'right' }) } } });
  return w.calendarSyncWeb_({ secret: 'wrong' }).error === 'Unauthorized';
})());
const manifest = JSON.parse(require('fs').readFileSync(__dirname + '/../apps-script/appsscript.json', 'utf8'));
ok('the manifest asks for the calendar scope', manifest.oauthScopes.indexOf('https://www.googleapis.com/auth/calendar') >= 0);
ok('authorize() touches the calendar so the owner is asked once', /CalendarApp\.getCalendarById\(MKT_CALENDAR_ID_\)/.test(G.grab('authorize')));
ok('the sync never calls the pay path', !/publishSpiffToCore_|GXCore\.publish|rollProgramStatuses_|progressSheet_/.test(
  ['calendarDesired_', 'calendarSync_', 'calendarSyncWeb_', 'runCalendarSyncHourly_', 'calendarAdapter_', 'calendarSource_'].map((n) => G.grab(n)).join('\n')));

console.log(fail ? '\n' + fail + ' FAILED' : '\ncalendar sync: all passed');
process.exit(fail ? 1 : 0);
