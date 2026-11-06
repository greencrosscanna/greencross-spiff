#!/usr/bin/env node
/* ─── The Dutchie campaign name, built at the deal lock, run for real ─────────────────────────────
 *
 *   RUN:  node tests/blast_name_test.js
 *
 * Sky's naming standard (2026-11-05, SOP claude/sops/dutchie-campaign-naming.md):
 *   `YYYY-MM-DD | TYPE | Who | Hook` + `[stores]` when not every store + `[SMS]`/`[Email]` when one channel.
 * Handoff: _handoffs/spiff-blast-name-at-lock.md. What is checked, by running marketing.js and the
 * engine's holidayPlan_ from their real source:
 *   · the handoff's two examples render exactly;
 *   · a blank hook ends the name at Who and flags "add a hook";
 *   · the date is the earliest typed send date, else the window start, as TEXT: blastName runs with
 *     toISOString booby-trapped, so a day-shifting Date path would throw;
 *   · nothing stored goes stale: changing the send date, stores, channels or hook changes the name;
 *   · holiday sends are PROMO and keep their hook through the engine (and nothing else typed);
 *   · the hook box sits on blast.deal and the Copy button on blast.copy, in the program and Tasks view.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;

const STORES = ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'];
const NAMES = { bend: 'Bend', center: 'Center', commercial: 'Commercial', hillsboro: 'Hillsboro', 'portland-rd': 'Portland Rd', 'river-rd': 'River Rd' };
const VIEW = { stores: STORES.map(s => ({ store_id: s, name: NAMES[s] })), storeName: s => NAMES[s] || s };

function prog(over, plan) {
  return Object.assign({ program_id: 'freshy-202611', vendor: 'Freshy', start_date: '2026-11-09', end_date: '2026-11-22',
    stores_json: [], marketing_json: Object.assign({ v: 1, sel: { email: true, sms: true },
      d: { email: { date: '2026-11-09' }, sms: { date: '2026-11-09' }, blast: { hook: '$3 carts Fridays + vendor days' } } }, plan || {}) }, over || {});
}

console.log('\n1. the handoff\'s examples');
{
  ok('Freshy renders exactly', MK.blastName(prog(), VIEW).name === '2026-11-09 | SPIFF | Freshy | $3 carts Fridays + vendor days');
  const two = prog({ stores_json: ['river-rd', 'commercial'] }, { sel: { sms: true }, d: { sms: { date: '2026-11-09' }, blast: { hook: 'Hook' } } });
  ok('2 stores, SMS only', MK.blastName(two, VIEW).name === '2026-11-09 | SPIFF | Freshy | Hook [River Rd, Commercial] [SMS]');
  const em = prog({}, { sel: { email: true }, d: { email: { date: '2026-11-09' }, blast: { hook: 'Hook' } } });
  ok('email only is tagged [Email]', MK.blastName(em, VIEW).name === '2026-11-09 | SPIFF | Freshy | Hook [Email]');
  ok('all six picked by hand is no stores tag', MK.blastName(prog({ stores_json: STORES.slice() }), VIEW).name.indexOf('[') < 0);
  ok('no store list known: the stores tag is left off, not guessed',
     MK.blastName(prog({ stores_json: ['river-rd'] }), {}).name === '2026-11-09 | SPIFF | Freshy | $3 carts Fridays + vendor days');
}

console.log('\n2. a blank hook');
{
  const b = MK.blastName(prog({}, { d: { email: { date: '2026-11-09' }, sms: { date: '2026-11-09' } } }), VIEW);
  ok('the name ends at Who', b.name === '2026-11-09 | SPIFF | Freshy' && b.hook === '');
  const html = MK.blastNameHtml(prog({}, { d: { email: { date: '2026-11-09' } } }), VIEW);
  ok('  …and says "add a hook"', /add a hook/.test(html));
  ok('a hook does not', !/add a hook/.test(MK.blastNameHtml(prog(), VIEW)));
}

console.log('\n3. the date, as text, never through a Date');
{
  vm.runInContext('Date.prototype.toISOString = function () { throw new Error("toISOString used"); };', ctx);
  let threw = null, b = null;
  try { b = MK.blastName(prog({}, { d: { email: { date: '2026-11-16' }, sms: { date: '2026-11-09' }, blast: { hook: 'H' } } }), VIEW); }
  catch (e) { threw = e; }
  ok('no toISOString on the path', !threw);
  ok('the earliest typed send date wins', b && b.date === '2026-11-09');
  const none = MK.blastName(prog({}, { d: { blast: { hook: 'H' } } }), VIEW);
  ok('no typed send date: the window start, as typed', none.date === '2026-11-09' && none.name.indexOf('2026-11-09 | ') === 0);
  const blank = MK.blastName(prog({ start_date: '' }, { d: {} }), VIEW);
  ok('no date at all: no name, and the screen asks for a send date', blank.name === '' && /set a send date/.test(MK.blastNameHtml(prog({ start_date: '' }, { d: {} }), VIEW)));
  ok('the date field is never a Date in the source', !/new Date|toISOString/.test(String(MK.blastName)));
}

console.log('\n4. it follows every input; nothing stored can go stale');
{
  let p = prog();
  const before = MK.blastName(p, VIEW).name;
  p.marketing_json = MK.applyOps(p.marketing_json, MK.detailOp(p, 'sms', 'date', '2026-11-02'));
  ok('send date moved', MK.blastName(p, VIEW).date === '2026-11-02' && MK.blastName(p, VIEW).name !== before);
  p.marketing_json = MK.applyOps(p.marketing_json, MK.detailOp(p, 'blast', 'hook', 'New hook'));
  ok('hook changed', /\| New hook$/.test(MK.blastName(p, VIEW).name));
  p.marketing_json = MK.applyOps(p.marketing_json, MK.toggleItemOp(p, 'email'));
  ok('channel dropped', / \[SMS\]$/.test(MK.blastName(p, VIEW).name));
  p.stores_json = ['bend'];
  ok('stores changed', / \[Bend\] \[SMS\]$/.test(MK.blastName(p, VIEW).name));
  p.marketing_json = MK.applyOps(p.marketing_json, MK.toggleItemOp(p, 'sms'));
  ok('no blast picked: no name at all', MK.blastName(p, VIEW) === null && MK.blastNameHtml(p, VIEW) === '');
  ok('only the hook is stored', JSON.stringify(prog().marketing_json.d.blast) === '{"hook":"$3 carts Fridays + vendor days"}');
}

console.log('\n5. separators and dashes');
{
  const p = prog({ vendor: 'Grön — Pearls' }, { d: { email: { date: '2026-11-09' }, blast: { hook: 'A | B – C' } } });
  const n = MK.blastName(p, VIEW).name;
  ok('no em or en dashes anywhere', !/[‒-―]/.test(n));
  ok('a typed pipe cannot fake a separator', n.split(' | ').length === 4);
  ok('a long hook is cut to ' + MK.HOOK_MAX, MK.blastName(prog({}, { d: { email: { date: '2026-11-09' }, blast: { hook: 'x'.repeat(80) } } }), VIEW).hook.length === MK.HOOK_MAX);
}

console.log('\n6. holiday sends are PROMO and keep their hook');
{
  const H = { holiday_id: 'hol-1', name: 'Thanksgiving', send_date: '2026-11-23', channels: ['email'], note: '',
              marketing_json: { v: 1, d: { blast: { hook: '20% off sitewide' } } } };
  ok('PROMO, Who = the holiday name', MK.blastName(MK.holidayProgram(H), VIEW).name === '2026-11-23 | PROMO | Thanksgiving | 20% off sitewide [Email]');
  const api = G.load({ real: ['holidayPlan_', 'normalizeMarketing_'], vars: ['MKT_PEOPLE_'] });
  const kept = api.holidayPlan_({ sel: { raffle: true }, d: { blast: { hook: '20% off sitewide' }, email: { date: '2027-01-01' } } });
  ok('the engine keeps the hook', kept.d && kept.d.blast.hook === '20% off sitewide');
  ok('  …and nothing else typed', !kept.sel && Object.keys(kept.d).join() === 'blast');
  ok('  …no hook, no d at all', !api.holidayPlan_({ d: { email: { date: '2027-01-01' } } }).d);
}

console.log('\n7. where it shows');
{
  const p = prog();
  const html = MK.sectionHtml(p, Object.assign({ today: '2026-11-01', canEdit: true, engineReady: true }, VIEW));
  ok('the hook box is on the program screen', /data-mk-item="blast" data-mk-field="hook"/.test(html) && /e\.g\. \$3 carts Fridays/.test(html));
  ok('the Copy button carries the name', html.indexOf('data-mk-copyname="2026-11-09 | SPIFF | Freshy | $3 carts Fridays + vendor days"') >= 0);
  ok('with the paste instruction', /Paste into Campaign name \(Build content step\) before scheduling\./.test(html));
  const tv = MK.tasksAcrossHtml([p], Object.assign({ today: '2026-11-01', canEdit: true }, VIEW));
  ok('Mike\'s Tasks view shows it too', tv.indexOf('data-mk-copyname="2026-11-09 | SPIFF | Freshy') >= 0);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
