#!/usr/bin/env node
/* ─── Store-by-store reports (Sky's asks 2026-11-03) ───────────────────────────────────────────────
 *
 *   RUN:  node tests/store_report_test.js
 *
 * "Break down by store like old reports" and "mid week store by store reports (printable)".
 * Runs the real storeSectionsOf_, storeBlockHtml_, storeReportHtml_, storeReport_ and the real
 * staff copy (reportHtml_) against a closed program (frozen snapshot) and a running one (hourly
 * cache). Rules pinned: one block per store with that store's people only; a running program uses
 * the hourly figures, not a live pull; the sheet is a light page with one page per store; per-unit
 * programs show Earned instead of a target; it needs a session; and the BRAND page never gets names.
 */
'use strict';
const G = require('./_gas');
let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PROPS = G.makeProps({ GX_DEPLOY_SECRET: 'SEKRET' });
let AUTH = { ok: true, user: 'tawny', role: 'viewer' };
let LIVE_CALLS = 0;

const CLOSED = {
  program_id: 'acme-202610', vendor: 'Acme', program_name: 'Acme Fall', status: 'closed',
  start_date: '2026-10-05', end_date: '2026-10-18', stores_json: ['river-rd', 'commercial'],
  payout_json: { model: 'flat', amount: 25 },
  target_json: { units: 24, by_store: { 'river-rd': 12, commercial: 12 }, per_bt: { 'river-rd': 6, commercial: 4 } },
  baseline_json: { units: 20, by_store: { 'river-rd': 10, commercial: 10 } },
  actual_json: { units_sold: 21, bts_hit: 2, spiff_amount: 25, investment: 50 },
  progress_json: { at: '2026-10-19 02:00:00', stores: [
    { store_id: 'river-rd', units: 13, rows: [
      { name: 'ZED RIVER', employee_id: 'e3', units: 1, hit: false, earned: 0 },
      { name: 'AMY RIVER', employee_id: 'e1', units: 8, hit: true, earned: 25 },
      { name: 'BOB RIVER', employee_id: 'e2', units: 4, hit: false, earned: 0 } ] },
    { store_id: 'commercial', units: 8, rows: [
      { name: 'CAL COMM', employee_id: 'e4', units: 8, hit: true, earned: 25 } ] } ] },
};
const RUNNING = Object.assign({}, CLOSED, {
  program_id: 'acme-202611', status: 'active', actual_json: null, progress_json: null,
  start_date: '2026-11-02', end_date: '2026-11-15',
});
const PER_UNIT = Object.assign({}, CLOSED, { program_id: 'pu-202610', payout_json: { model: 'per_unit', amount: 0.75 },
  actual_json: { units_sold: 21, spiff_amount: 0.75, investment: 15.75 } });
const LIVE = { ok: true, refreshed_at: '2026-11-04T01:00:00', rows: [
  { store_id: 'river-rd', name: 'AMY RIVER', display_name: 'Amy', units: 3, target: 6, hit: false, earned: 0 },
  { store_id: 'river-rd', name: 'BOB RIVER', display_name: 'Bob', units: 7, target: 6, hit: true, earned: 25 },
  { store_id: 'commercial', name: 'CAL COMM', display_name: 'Cal', units: 1, target: 4, hit: false, earned: 0 } ] };
const BY_ID = { [CLOSED.program_id]: CLOSED, [RUNNING.program_id]: RUNNING, [PER_UNIT.program_id]: PER_UNIT };

const D = G.load({
  real: ['storeSectionsOf_', 'storeBlockHtml_', 'storeReportHtml_', 'storeReport_', 'programDayInfo_',
         'reportHtml_', 'brandPaperHtml_', 'brandProgramLabel_', 'prettyDay_', 'unitLiftOf_',
         'measuredRowsFor_', 'payoutFactsOf_', 'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_',
         'friendlyName_', 'today_'],
  vars: ['LOGO_ONLIGHT', 'BTS_PER_STORE', 'GX_SECRET_PROP'],
  stubs: {
    getProgram_: (id) => BY_ID[id] ? { ok: true, program: BY_ID[id] } : { ok: false, error: 'not found: ' + id },
    gxStores_: () => [{ store_id: 'river-rd', display_name: 'River Rd' }, { store_id: 'commercial', display_name: 'Commercial St' }],
    displayNameMap_: () => ({ byId: { e1: 'Amy', e2: 'Bob', e3: 'Zed', e4: 'Cal' }, byName: {} }),
    spiffProgress_: () => { LIVE_CALLS++; return LIVE; },
    gxAuth_: () => AUTH,
  },
  globals: { PropertiesService: PROPS.PropertiesService, console: { warn() {}, log() {} },
             Utilities: Object.assign({}, G.Utilities) },
});

/* ── closed program: one block per store, each person under their own store ── */
const closedM = D.measuredRowsFor_(CLOSED);
const secs = D.storeSectionsOf_(CLOSED, closedM);
ok('two stores, in the program\'s order, named for people', secs.length === 2 && secs[0].name === 'River Rd' && secs[1].name === 'Commercial St');
ok('River Rd holds exactly its three people, top seller first', secs[0].bts.map(b => b.name).join('|') === 'Amy|Bob|Zed');
ok('  …and Commercial\'s person is not in River Rd', !secs[0].bts.some(b => b.name === 'Cal') && secs[1].bts[0].name === 'Cal');
ok('store totals come from the measurement (13 and 8)', secs[0].sold === 13 && secs[1].sold === 8);
ok('the per-person target is the store\'s own (6 at River Rd, 4 at Commercial)', secs[0].bts[0].target === 6 && secs[1].bts[0].target === 4);
ok('hit counts per store (1 and 1)', secs[0].hit === 1 && secs[1].hit === 1);

const f = D.payoutFactsOf_(CLOSED);
const block = D.storeBlockHtml_(secs[0], f, {});
ok('a block names its store and says units sold of goal and how many hit', /River Rd/.test(block) && /13 units sold of 12 goal/.test(block) && /1 of 3 hit/.test(block));
ok('  …with the people under it, and no other store\'s people', /Amy/.test(block) && /Zed/.test(block) && !/Cal\b/.test(block));

/* ── the staff copy now carries store blocks under the same heading ── */
const staff = D.reportHtml_(CLOSED, closedM);
ok('staff copy: still headed "By budtender"', /<h2>By budtender<\/h2>/.test(staff));
ok('  …with a block per store, each store before its people',
   staff.indexOf('River Rd', staff.indexOf('By budtender')) < staff.indexOf('Amy') &&
   staff.indexOf('Amy') < staff.indexOf('Commercial St', staff.indexOf('Amy')) &&
   staff.indexOf('Commercial St', staff.indexOf('Amy')) < staff.indexOf('Cal'));

/* ── a person from an unlisted store is not dropped ── */
const extra = D.storeSectionsOf_(CLOSED, { rows: closedM.rows.concat([{ name: 'Dee', store_id: 'bend', units: 2, target: 0, hit: false, earned: 0 }]), by_store: closedM.by_store });
ok('a store with rows but not on the program gets its own block', extra.length === 3 && extra[2].bts[0].name === 'Dee');

/* ── mid-week: a running program reads the hourly cache, once, and says when ── */
AUTH = { ok: true, role: 'viewer' };
LIVE_CALLS = 0;
let r = D.storeReport_({ token: 't', id: RUNNING.program_id });
ok('running program: ok, from the hourly cache', r.ok && /live cache/.test(r.source) && LIVE_CALLS === 1);
ok('  …says WHEN the figures are from', r.as_of === '2026-11-04T01:00:00' && /Figures as of 2026-11-04 01:00/.test(r.html));
ok('  …River Rd sold 10 (3 + 7), Commercial 1', r.stores[0].sold === 10 && r.stores[1].sold === 1);
ok('  …"to go" is what each person still needs (Amy 3 more, Bob already hit)', /Amy[\s\S]*?>3</.test(r.html) && /Bob[\s\S]*?>Hit</.test(r.html));
ok('  …day count is real (a mid-program date has days left)', r.days && r.days.total === 14);

/* ── printable: light page, a page break between stores and none after the last ── */
const breaks = (r.html.match(/page-break-after:always/g) || []).length;
ok('one page per store: a break after every store but the last', breaks === 1);
ok('light background only (no dark theme colors)', /background:#fff/.test(r.html) && !/#0[0-9a-f]{5}[;"]/i.test(r.html.replace(/#0{3,}/g, '')));
ok('sheet is staff-only and says so', /for store staff, not for brands/.test(r.html));

/* ── per-unit: Earned, never a target of zero ── */
r = D.storeReport_({ token: 't', id: PER_UNIT.program_id });
ok('per-unit program shows Earned, no Target column', r.ok && /Earned/.test(r.html) && r.html.indexOf('>Target<') < 0);

/* ── access: a session or the deploy secret, nothing else ── */
AUTH = { ok: false, error: 'bad token' };
r = D.storeReport_({ token: 'nope', id: RUNNING.program_id });
ok('no session: refused, and no names leave', r.ok === false && r.needsAuth === true && !/Amy|Bob/.test(JSON.stringify(r)));
r = D.storeReport_({ secret: 'SEKRET', id: RUNNING.program_id });
ok('the deploy secret opens it (terminal verification)', r.ok === true);
r = D.storeReport_({ secret: 'wrong', id: RUNNING.program_id });
ok('a wrong secret does not', r.ok === false);
AUTH = { ok: true, role: 'viewer' };
ok('unknown program: a clear error', D.storeReport_({ token: 't', id: 'nope' }).ok === false);

/* ── the BRAND page is untouched: still no budtender names ── */
const brand = D.brandPaperHtml_(CLOSED, closedM);
ok('brand page carries no budtender names', !/Amy|Bob|Zed|Cal\b/.test(brand));

/* ── day math ── */
ok('before the start: "before"', D.programDayInfo_(RUNNING, '2026-11-01').before === true);
ok('last day: 0 days left, not over', (x => x.left === 0 && !x.over && x.day === 14)(D.programDayInfo_(RUNNING, '2026-11-15')));
ok('after the end: over', D.programDayInfo_(RUNNING, '2026-11-16').over === true);
ok('no window: null', D.programDayInfo_({ start_date: '', end_date: '' }, '2026-11-04') === null);

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
