#!/usr/bin/env node
/* ─── Standalone vendor days: a vendor visit with no SPIFF program, run for real ─────────────────
 *
 *   RUN:  node tests/standalone_vendor_day_test.js
 *
 * Sky, 2026-11-05: Tawny books a vendor to visit a store without running a SPIFF incentive. It is
 * brand + store(s) + date + time + note, in its own `vendor_days` tab (NOT programs). What is checked:
 *   · saveStandaloneVday_ / cancelStandaloneVday_ / standaloneVdaysRead_ from their real source, the
 *     sheet and session stubbed: only an editor writes, a retry is not a second visit, rows are never
 *     deleted, dates stay text;
 *   · the deals-page approval is the SESSION's: only Sky, Mike or Tawny can give it, anyone else
 *     changing the brand or copy takes it off, an approver changing copy re-signs it;
 *   · calendarDesired_ puts one event per store (or one for all stores) on the Marketing Calendar;
 *   · wixDesired_ sends a day only when ticked for the page, approved, inside the OLCC word rules and
 *     length limits, and inside the look-ahead window; its dayKey can never collide with a program's;
 *   · the screen (marketing.js) draws the marker, the dialog and the copy warnings.
 * That nothing paying reads the tab is tests/marketing_pay_isolation_test.js's job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const VH = G.grabVar('VDAY_HEADERS');
const vcol = (n) => VH.indexOf(n);

function engine(role, user) {
  const programs = G.makeSheet(G.grabVar('PROGRAM_HEADERS'), []);
  const book = G.makeBook({ programs });
  programs.getParent = () => book;
  const props = G.makeProps({});
  const api = G.load({
    real: ['standaloneVdaySheet_', 'vdayStores_', 'vdayWeb_', 'rowToStandaloneVday_', 'standaloneVdayToRow_',
           'readStandaloneVdays_', 'standaloneVdaysRead_', 'getStandaloneVday_', 'saveStandaloneVday_',
           'cancelStandaloneVday_', 'mktEditor_', 'parseJson_', 'textDate_', 'wixCopyProblem_', 'wixLengthProblem_'],
    vars: ['VDAYS_TAB', 'VDAY_HEADERS', 'EDIT_ROLES', 'WIX_APPROVERS_', 'WIX_VDAY_AUTO_APPROVER_', 'WIX_COPY_RULES_', 'WIX_COPY_LIMITS_', 'WIX_LIMIT_NAMES_'],
    stubs: {
      dataSheet_: () => programs,
      gxAuth_: (t) => (t === 'good' ? { ok: true, user: user || 'tawny', role: role || 'editor' } : { ok: false, error: 'bad token' }),
      nowStamp_: () => '2026-11-05 09:00:00',
    },
    globals: {
      PropertiesService: props.PropertiesService, console: { warn() {}, log() {} },
      GXCore: { roleCanEdit: (r) => ['editor', 'admin', 'director', 'manager'].indexOf(r) >= 0 },
    },
  });
  return { api, book, programs };
}
const rows = (e) => (e.book.getSheetByName('vendor_days') ? e.book.getSheetByName('vendor_days').rows.slice(1) : []);
const BASE = { token: 'good', brand: 'Grön', stores: 'commercial,river-rd', date: '2026-11-12', time: '1-3:30', note: 'Sampling' };

console.log('\n1. only an editor writes');
{
  const e = engine('viewer');
  ok('a viewer cannot add one', /cannot/.test(e.api.saveStandaloneVday_(BASE).error || ''));
  ok('a viewer cannot cancel one', /cannot/.test(e.api.cancelStandaloneVday_({ token: 'good', id: 'x' }).error || ''));
  ok('  …and nothing was written', rows(e).length === 0);
  ok('a bad token says to sign in', engine().api.saveStandaloneVday_(Object.assign({}, BASE, { token: 'nope' })).needsAuth === true);
}

console.log('\n2. adding one');
{
  const e = engine();
  const bad = (o) => e.api.saveStandaloneVday_(Object.assign({}, BASE, o));
  ok('no brand is refused', bad({ brand: ' ' }).ok === false);
  ok('no date is refused', bad({ date: 'soon' }).ok === false);
  ok('  …and every refusal wrote nothing', rows(e).length === 0);
  const r = e.api.saveStandaloneVday_(BASE);
  ok('it saves, stamped with who', r.ok && r.created && r.vday.created_by === 'tawny' && /^vd-/.test(r.vday.vday_id));
  ok('  …into its OWN tab, not programs', rows(e).length === 1 && e.programs.rows.length === 1);
  const row = rows(e)[0];
  ok('  …planned, date as text, both stores', row[vcol('status')] === 'planned' && row[vcol('date')] === '2026-11-12'
     && row[vcol('stores')] === 'commercial,river-rd');
  ok('a retried call is a replay, not a second visit', e.api.saveStandaloneVday_(Object.assign({}, BASE, { brand: 'GRÖN'.toLowerCase() })).replay === true && rows(e).length === 1);
  ok('no stores means every store', e.api.saveStandaloneVday_(Object.assign({}, BASE, { brand: 'Wyld', stores: '' })).vday.stores.length === 0);
  ok('a store id that is not a slug is dropped', e.api.vdayStores_('river-rd, ../x,Bad Id,center')  .join('|') === 'river-rd|center');
  const id = r.vday.vday_id;
  const ch = e.api.saveStandaloneVday_(Object.assign({}, BASE, { id, date: '2026-11-13', stores: 'bend' }));
  ok('editing changes it in place', ch.ok && !ch.created && rows(e).length === 2 && ch.vday.date === '2026-11-13' && ch.vday.stores.join() === 'bend');
  ok('the read serves it, stores as a list', e.api.standaloneVdaysRead_().vdays.some((v) => v.vday_id === id && v.stores.join() === 'bend'));
  const c = e.api.cancelStandaloneVday_({ token: 'good', id });
  ok('cancel keeps the row and marks it', c.ok && c.canceled && rows(e).length === 2 && rows(e).some((x) => x[vcol('status')] === 'canceled'));
  ok('  …and the read no longer serves it', !e.api.standaloneVdaysRead_().vdays.some((v) => v.vday_id === id));
  ok('  …and a canceled one cannot be edited', e.api.saveStandaloneVday_(Object.assign({}, BASE, { id })).ok === false);
}

console.log('\n3. the deals-page approval is the session\'s');
{
  const web = { web_on: '1', web_deal: '30% OFF', web_offer: 'all Grön, in store' };
  const staff = engine('editor', 'jordan');
  const a = staff.api.saveStandaloneVday_(Object.assign({}, BASE, web, { approve: '1' }));
  ok('an editor who is not Sky, Mike or Tawny cannot approve', a.ok && a.vday.approved_by === '');
  const t = engine('editor', 'tawny');
  const b = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { approve: '1' }));
  ok('Tawny can, and it is her name from the session', b.ok && b.vday.approved_by === 'tawny');
  const id = b.vday.vday_id;
  const time = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, time: '2-4' }));
  ok('moving the time is not copy: approval stays', time.vday.approved_by === 'tawny');
  const copy = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_deal: '25% OFF' }));
  ok('changing the copy without re-approving takes it off', copy.vday.approved_by === '');
  const again = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_deal: '25% OFF', approve: '1' }));
  ok('an approver re-approving the new copy signs it', again.vday.approved_by === 'tawny');
  // a non-approver editing approved copy clears it
  const sheet = t.book.getSheetByName('vendor_days');
  const other = G.load({ real: ['standaloneVdaySheet_', 'vdayStores_', 'vdayWeb_', 'rowToStandaloneVday_', 'standaloneVdayToRow_',
      'readStandaloneVdays_', 'getStandaloneVday_', 'saveStandaloneVday_', 'mktEditor_', 'parseJson_', 'textDate_', 'wixCopyProblem_', 'wixLengthProblem_'],
    vars: ['VDAYS_TAB', 'VDAY_HEADERS', 'EDIT_ROLES', 'WIX_APPROVERS_', 'WIX_VDAY_AUTO_APPROVER_', 'WIX_COPY_RULES_', 'WIX_COPY_LIMITS_', 'WIX_LIMIT_NAMES_'],
    stubs: { dataSheet_: () => ({ getParent: () => t.book }), gxAuth_: () => ({ ok: true, user: 'jordan', role: 'editor' }), nowStamp_: () => 'x' },
    globals: { PropertiesService: G.makeProps({}).PropertiesService, console: { warn() {}, log() {} }, GXCore: { roleCanEdit: () => true } } });
  const hijack = other.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_deal: 'Half off' }));
  ok('anyone else changing approved copy clears the approval', hijack.ok && hijack.vday.approved_by === '');
  const off = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_deal: 'Half off', approve: '0' }));
  ok('approve=0 withdraws it', off.vday.approved_by === '');
  const rule = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_offer: 'BOGO on everything', approve: '1' }));
  ok('approving copy that breaks the OLCC rules is refused', rule.ok === false && /OLCC/.test(rule.error));
  const long = t.api.saveStandaloneVday_(Object.assign({}, BASE, web, { id, web_deal: 'Thirty percent off everything', approve: '1' }));
  ok('approving copy over the layout limit is refused', long.ok === false && /characters/.test(long.error));
  const noweb = t.api.saveStandaloneVday_(Object.assign({}, BASE, { id, web_on: '0', approve: '1' }));
  ok('turning the page off clears any approval', noweb.ok && noweb.vday.approved_by === '' && noweb.vday.web.on === false);
}

console.log('\n4. the Marketing Calendar');
{
  const api = G.load({
    real: ['calParseTime_', 'calendarDesired_', 'addDaysLocal_', 'brandProgramLabel_', 'normalizeMarketing_', 'mktPickedIds_', 'slug_'],
    vars: ['CAL_LOOKBACK_DAYS_', 'CAL_LOOKAHEAD_DAYS_', 'CAL_NOTE_', 'MKT_MENU_'],
    globals: { console },
  });
  const V = (o) => Object.assign({ vday_id: 'vd-1', brand: 'Grön', stores: ['commercial', 'river-rd'], date: '2026-11-12', time: '1-3:30',
                                   note: 'Sampling', status: 'planned', web: {} }, o);
  const ev = api.calendarDesired_({ programs: [], pencils: [], vdays: [V()], storeNames: { commercial: 'Commercial', 'river-rd': 'River Rd' } }, '2026-11-05');
  ok('one event per store', ev.length === 2 && ev.map((x) => x.key).join() === 'svday:vd-1:commercial,svday:vd-1:river-rd');
  ok('  …titled like a program vendor day, timed', ev[0].summary === 'Grön Vendor Day - Commercial' && ev[0].start === '13:00' && ev[0].end === '15:30');
  ok('  …marked as a vendor day so a hand-made twin is not duplicated', ev[0].kind === 'vday' && ev[0].vday === true);
  ok('  …described as not part of a program, with the note', /not part of a SPIFF program/.test(ev[0].description) && /Sampling/.test(ev[0].description));
  const all = api.calendarDesired_({ programs: [], vdays: [V({ stores: [], time: 'after close' })] }, '2026-11-05');
  ok('no stores: one all-day event for every store, the time rides in the title',
     all.length === 1 && all[0].key === 'svday:vd-1:all' && all[0].allDay && /All stores \(after close\)/.test(all[0].summary));
  ok('a canceled day is not on the calendar', api.calendarDesired_({ programs: [], vdays: [V({ status: 'canceled' })] }, '2026-11-05').length === 0);
  ok('a day long past is outside the sync window', api.calendarDesired_({ programs: [], vdays: [V({ date: '2026-08-01' })] }, '2026-11-05').length === 0);
}

console.log('\n5. the deals page');
const STORES = [{ store_id: 'commercial', display_name: 'Commercial', address: '4550 Commercial St SE' },
                { store_id: 'river-rd', display_name: 'River', address: '3165 River Rd N' }];
const wixApi = G.load({
  real: ['wixFold_', 'wixMenuSlug_', 'wixEsc_', 'wixStoreLabel_', 'wixTimeOf_', 'wixDayLabels_', 'wixThroughLabel_', 'wixOfferHtml_',
         'wixApprover_', 'wixCopyProblem_', 'wixLengthProblem_', 'wixDutchieBrand_', 'wixVendorIndex_', 'wixDesired_', 'wixVdayCopy_', 'wixSameItem_',
         'wixCanon_', 'wixPlan_', 'calParseTime_', 'addDaysLocal_', 'normalizeMarketing_', 'mktPickedIds_', 'slug_', 'wixVdayLogoProblem_'],
  vars: ['WIX_LOOKAHEAD_DAYS_', 'WIX_MAX_REMOVES_', 'WIX_ITEM_', 'WIX_APPROVE_TASK_', 'WIX_VDAY_APPROVE_TASK_', 'WIX_APPROVERS_', 'WIX_VDAY_AUTO_APPROVER_', 'WIX_COPY_RULES_', 'WIX_COPY_LIMITS_',
         'WIX_LIMIT_NAMES_', 'WIX_DOW_', 'WIX_MON_', 'MKT_MENU_'],
  varValues: { WIX_APPROVER_FIELD_: G.grabVar('WIX_APPROVER_FIELD_') },
  globals: { console },
});
{
  const labels = { commercial: 'Commercial St', 'river-rd': 'River Rd' };
  const VENDORS = [{ _id: 'v-gron', title: 'Grön', aliases: ['Gron'], logo: 'wix:image://v1/gron.png/gron.png#originWidth=600&originHeight=600' },
                   { _id: 'v-bare', title: 'Bare Brand' }];
  const V = (o) => Object.assign({ vday_id: 'vd-1', brand: 'Grön', stores: ['commercial', 'river-rd'], date: '2026-11-12', time: '1-3:30',
                                   note: '', status: 'planned', approved_by: 'tawny',
                                   web: { on: true, deal: '30% OFF', offer: 'all Grön, in store' } }, o);
  const want = (v, extra) => wixApi.wixDesired_(Object.assign({ programs: [], vdays: v, vendors: VENDORS, storeLabels: labels }, extra || {}), '2026-11-05');
  const d = want([V()]);
  ok('an approved, ticked day sends one row per store', d.days.length === 2 && d.featured.length === 0);
  const r = d.days[0];
  ok('  …keyed sv-<id>|<store>|<date>, so it cannot collide with a program', r.dayKey === 'sv-vd-1|commercial-st|2026-11-12' && r.programId === 'sv-vd-1');
  ok('  …with the page\'s labels, time, deal and the approver', r.store === 'Commercial St' && r.dayLabel === 'THU' && r.dateLabel === '11/12'
     && r.time === '1 to 3:30 PM' && r.sortTime === 780 && r.deal === '30% OFF' && r.offer === 'all Grön, in store' && r.approvedBy === 'tawny');
  ok('  …linked to the brand\'s Vendors row', r.vendorRef === 'v-gron' && d.problems.length === 0);
  ok('no stores sends one "all" row with a blank store', (() => { const a = want([V({ stores: [] })]).days; return a.length === 1 && a[0].dayKey === 'sv-vd-1|all|2026-11-12' && a[0].store === ''; })());
  ok('not ticked for the page: nothing, and nothing to report', (() => { const a = want([V({ web: { on: false, deal: 'x' } })]); return a.days.length === 0 && a.skipped.length === 0; })());
  /* The DAY goes on its own; only its deal WORDING waits for a person (Sky, 2026-11-06). */
  const bareDay = (a) => a.days.length === 2 && a.days.every((x) => x.deal === '' && x.offer === '' && x.approvedBy === 'sky');
  const wait = want([V({ approved_by: '' })]);
  ok('not approved: the day still goes, without its deal wording, signed by Sky\'s standing approval',
     bareDay(wait) && /waits for Sky, Mike or Tawny/.test(wait.skipped[0].why));
  ok('approved by someone not on the list: the day goes, the wording does not', bareDay(want([V({ approved_by: 'jordan' })])));
  const noCopy = want([V({ approved_by: '', web: { on: true, deal: '', offer: '' } })]);
  ok('a day with no deal wording goes, with nothing to report', noCopy.days.length === 2 && noCopy.skipped.length === 0);
  const olcc = want([V({ web: { on: true, deal: 'BOGO', offer: 'x' } })]);
  ok('wording that breaks the OLCC rules stays off; the day goes', bareDay(olcc) && /OLCC/.test(olcc.skipped[0].why));
  const long = want([V({ web: { on: true, deal: 'Thirty percent off', offer: 'x' } })]);
  ok('wording over the layout limit stays off; the day goes', bareDay(long) && /characters/.test(long.skipped[0].why));
  const badBrand = want([V({ brand: 'Best Buds' })]);
  ok('a brand name that breaks the OLCC rules keeps the whole day off', badBrand.days.length === 0 && /brand name/.test(badBrand.skipped[0].why));
  ok('a day already past does not go', want([V({ date: '2026-11-04' })]).days.length === 0);
  ok('a day beyond the look-ahead window does not go yet', want([V({ date: '2027-02-01' })]).days.length === 0);
  ok('a canceled day does not go', want([V({ status: 'canceled' })]).days.length === 0);
  /* The logo is a gate for a standalone day (Sky, 2026-11-05): never a card on a black tile. */
  const nov = want([V({ brand: 'Nobody' })]);
  ok('a brand missing from Vendors does NOT go, and says to add its logo', nov.days.length === 0 && nov.skipped.length === 1
     && /no brand tile for "Nobody"/.test(nov.skipped[0].why) && /Brands and logos/.test(nov.skipped[0].why));
  const bare = want([V({ brand: 'Bare Brand' })]);
  ok('a Vendors row with no logo does NOT go, and says so', bare.days.length === 0 && /"Bare Brand" has no logo/.test(bare.skipped[0].why));
  ok('another spelling finds the same logo', (() => { const a = want([V({ brand: 'Gron' })]).days; return a.length === 2 && a[0].vendorRef === 'v-gron'; })());
  ok('a wide logo alone is enough', want([V({ brand: 'Wide' })], { vendors: [{ _id: 'v-w', title: 'Wide', logoWide: 'wix:image://v1/w.png/w.png' }] }).days.length === 2);
  ok('every standalone row it sends carries a vendorRef', d.days.every((x) => x.vendorRef === 'v-gron'));
  const gone = want([V({ brand: 'Nobody' })]);
  const plan3 = wixApi.wixPlan_(gone, { featured: [], days: [] }, { featured: [], days: [] }, 5, '2026-11-05');
  ok('  …so a logo-less day is never sent', plan3.days.length === 0);

  /* The plan: a published standalone day that is canceled comes off; one that is unchanged is left. */
  const have = d.days.map((x) => Object.assign({}, x, { approvedBy: undefined }));
  const plan1 = wixApi.wixPlan_(d, { featured: [], days: have }, { featured: [], days: d.days.map((x) => x.dayKey) }, 5, '2026-11-05');
  ok('a published day, unchanged, is not rewritten', plan1.days.length === 0 && plan1.unchanged === 2);
  const none = want([V({ status: 'canceled' })]);
  const plan2 = wixApi.wixPlan_(none, { featured: [], days: have }, { featured: [], days: d.days.map((x) => x.dayKey) }, 5, '2026-11-05');
  ok('cancel it and it comes off the page', plan2.remove_days.length === 2);
}

console.log('\n6. the screen');
{
  const MK = require('../marketing.js');
  const V = { vday_id: 'vd-1', brand: 'Grön', stores: ['commercial'], date: '2026-11-12', time: '1-3:30', note: 'Sampling', status: 'planned',
              web: { on: true, deal: '30% OFF', offer: 'all Grön' }, approved_by: 'tawny' };
  const names = { commercial: 'Commercial' };
  const bars = MK.barsOf([], [], { storeName: (s) => names[s] || s, vdaysSolo: [V] });
  ok('the calendar draws a one-day marker for it', bars.length === 1 && bars[0].kind === 'vday' && bars[0].solo && bars[0].start === '2026-11-12'
     && bars[0].label === 'Grön at Commercial, 1-3:30');
  ok('  …with "all stores" when none is picked', MK.barsOf([], [], { storeName: (s) => s, vdaysSolo: [Object.assign({}, V, { stores: [] })] })[0].label === 'Grön at all stores, 1-3:30');
  const cal = MK.calendarHtml([], [], { today: '2026-11-05', canEdit: true, offset: 0, storeName: (s) => s, vdaysSolo: [V] });
  ok('  …that opens its own dialog, not a program', /data-mk-svday="vd-1"/.test(cal) && !/data-mk-open="vd-1"/.test(cal));
  ok('the toolbar has an Add vendor day button for editors only', /data-mk-act="svadd"/.test(cal)
     && !/data-mk-act="svadd"/.test(MK.calendarHtml([], [], { today: '2026-11-05', canEdit: false, offset: 0, storeName: (s) => s })));
  const stores = [{ store_id: 'commercial', name: 'Commercial' }, { store_id: 'river-rd', name: 'River Rd' }];
  const form = MK.vendorDayDialogHtml(null, { canEdit: true, stores, approver: true });
  ok('the form takes brand, stores, date, time, note and the page copy', ['mkVfBrand', 'mkVfDate', 'mkVfTime', 'mkVfNote', 'mkVfWeb', 'mkVfDeal', 'mkVfOffer']
     .every((id) => form.indexOf('id="' + id + '"') >= 0) && /data-mk-vfst="river-rd"/.test(form));
  /* Sky, 2026-11-06: a new day goes on the deals page by default; unticking takes it off. */
  ok('  …a new day is ticked for the deals page, its copy box open', /id="mkVfWeb" checked/.test(form) && !/id="mkVfWebBox" hidden/.test(form));
  const off = MK.vendorDayDialogHtml({ vday_id: 'vd-1', brand: 'Grön', stores: [], date: '2026-11-12', time: '', note: '', web: { on: false } },
                                     { canEdit: true, stores, approver: true });
  ok('  …a day someone took off the page stays off, its copy box hidden', !/id="mkVfWeb" checked/.test(off) && /id="mkVfWebBox" hidden/.test(off));
  ok('  …an approver sees the approval box', /id="mkVfApprove"/.test(form));
  const view = MK.vendorDayDialogHtml(V, { canEdit: true, stores, approver: false });
  ok('  …anyone else sees who approved, and no box', !/id="mkVfApprove"/.test(view) && /approved by tawny/.test(view) && /data-mk-vfst="commercial" checked/.test(view));
  ok('  …an existing one offers Cancel; a new one does not', /data-mk-act="svcancel"/.test(view) && !/data-mk-act="svcancel"/.test(form));
  ok('copy warnings use the OLCC rules and the layout limits', /OLCC/.test(MK.vdayCopyWarning('Grön', { deal: 'BOGO' }))
     && /characters/.test(MK.vdayCopyWarning('Grön', { deal: 'Thirty percent off' })) && MK.vdayCopyWarning('Grön', { deal: '30% OFF' }) === '');
  /* The logo check on the form (Sky, 2026-11-05), from the Deals page view's brand list. */
  const SITE = [{ kind: 'vendor', brand: 'Grön', logo: 'wix:image://v1/abc_123.png/g.png#x', wix_id: 'w1' },
                { kind: 'vendor', brand: 'Bare', logo: '', logo_wide: '', wix_id: 'w2' },
                { kind: 'vendor', brand: 'Newco', logo_wide: 'wix:image://v1/n.png/n.png', wix_id: '', approved_by: '' },
                { kind: 'week', brand: 'Weekly Only', logo: 'wix:image://v1/q.png/q.png' }];
  const REG = [{ display_name: 'Grön', aliases: ['Gron'] }];
  const st = (b, list) => MK.vdayLogoStatus(b, list === undefined ? SITE : list, REG);
  ok('a brand with a logo on the page: ok, with its picture', st('Grön').state === 'ok' && st('Grön').src === 'https://static.wixstatic.com/media/abc_123.png');
  ok('  …found by another spelling too', st('gron').state === 'ok');
  ok('no brand tile: missing', st('Nobody').state === 'missing' && st('Weekly Only').state === 'missing');
  ok('a tile with no logo: nologo', st('Bare').state === 'nologo');
  ok('a logo saved but never approved or published: waiting', st('Newco').state === 'waiting'
     && MK.vdayLogoStatus('Newco', [Object.assign({}, SITE[2], { approved_by: 'mike' })], REG).state === 'ok');
  ok('list not loaded yet: checking; no brand typed: blank', st('Grön', null).state === 'checking' && st('  ').state === 'blank');
  const ask = MK.vdayLogoHtml(st('Nobody'), true);
  ok('missing logo: the form says so and offers to add it', /no logo for Nobody/.test(ask) && /stays off the website/.test(ask) && /data-mk-act="svlogo"/.test(ask));
  ok('  …a viewer is told, with no button', !/data-mk-act="svlogo"/.test(MK.vdayLogoHtml(st('Nobody'), false)));
  ok('a found logo shows it, with no ask', /<img src="https:\/\/static\.wixstatic\.com/.test(MK.vdayLogoHtml(st('Grön'), true)) && !/svlogo/.test(MK.vdayLogoHtml(st('Grön'), true)));
  ok('the form carries the logo box inside the deals-page section',
     /id="mkVfWebBox"[^>]*>\s*<div id="mkVfLogo">[^]*no logo for Nobody/.test(MK.vendorDayDialogHtml(null, { canEdit: true, stores, approver: true, logo: st('Nobody') })));
  const sj = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  /* "Add the logo" opens the brand's card in a popup over the form (Sky, 2026-11-05): no leave-the-page
     confirm, the form stays open, and the form's logo line repaints as the popup saves. */
  const svlogo = (sj.match(/if \(name === 'svlogo'\) \{[^]*?\n    \}/) || [''])[0];
  ok('SOURCE-SHAPED: "Add the logo" opens a popup over the form, not another view',
     /SpiffSite\.openBrandPopup\(/.test(svlogo) && /mkVdayLogoPaint/.test(svlogo)
     && !/confirm\(|mkDlgClose\(|mkView\.view =/.test(svlogo));
  const site = fs.readFileSync(path.join(__dirname, '..', 'site.js'), 'utf8');
  ok('SOURCE-SHAPED: the popup draws the same brand card and runs the same actions as the Deals page view',
     /function paintPopup\(\)[^]*vendorHtml\(card, ctx\)/.test(site) && /act\(b\.dataset\.stAct, b\.closest\('\.st-line'\), b, busyCtx\(popCtx\(\), b\)\)/.test(site));
  ok('SOURCE-SHAPED: Escape closes the popup only, not the vendor day form under it',
     /e\.key === 'Escape' && P\) \{ e\.stopPropagation\(\)/.test(site) && /#stLogoDlg:not\(\[hidden\]\)/.test(sj));

  /* A button that started a save says so and takes no second click (Sky, 2026-11-05). */
  const fakeBtn = () => {
    const cls = new Set();
    return { innerHTML: 'Add it', disabled: false, isConnected: true, attrs: {},
             classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) },
             setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  };
  const b1 = fakeBtn(), stop1 = MK.busyButton(b1, 'Saving…');
  ok('busy: the button is disabled, says Saving… with a spinner, and is marked busy',
     b1.disabled && /mk-spin/.test(b1.innerHTML) && /Saving…/.test(b1.innerHTML) && b1.classList.has('is-busy') && b1.attrs['aria-busy'] === 'true');
  stop1();
  ok('  …and comes back as it was when the engine answers', !b1.disabled && b1.innerHTML === 'Add it' && !b1.classList.has('is-busy') && !('aria-busy' in b1.attrs));
  const b2 = fakeBtn(); b2.disabled = true;
  const stop2 = MK.busyButton(b2, 'Saving…');
  ok('  …a button already busy is left alone (no second save)', b2.innerHTML === 'Add it' && typeof stop2 === 'function');
  const b3 = fakeBtn(), stop3 = MK.busyButton(b3, 'Saving…');
  b3.isConnected = false; stop3();
  ok('  …a button a repaint already replaced is not touched', b3.disabled);
  ok('  …no button is fine', typeof MK.busyButton(null) === 'function');
  ok('SOURCE-SHAPED: every dialog engine call marks the clicked button busy until it answers',
     /async function mkPencilCall[^]{0,500}MK\.busyButton\(btn[^]{0,600}finally \{ stop\(\); \}/.test(sj)
     && /mkView\.actBtn = dlg && !dlg\.hidden \? dlg\.querySelector/.test(sj));
  ok('SOURCE-SHAPED: the Deals page view wraps every engine call the same way',
     /function busyCtx\(ctx, btn\)[^]{0,400}busyButton\(btn[^]{0,200}\.finally\(stop\)/.test(site)
     && /act\(b\.dataset\.stAct, b\.closest\('\.st-line'\), b, busyCtx\(host\.__stCtx, b\)\)/.test(site));
  const gs = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const approvers = (gs.match(/var WIX_APPROVERS_ = (\[[^\]]*\])/) || [])[1];
  ok('the screen\'s approver list is the engine\'s', JSON.stringify(MK.VDAY_APPROVERS) === JSON.stringify(JSON.parse(approvers.replace(/'/g, '"'))));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nstandalone vendor days: all passed');
process.exit(fail ? 1 : 0);
