#!/usr/bin/env node
/* ─── The deals page fills itself from SPIFF, and only with what Sky approved ──────────────────────
 *
 *   RUN:  node tests/wix_publish_test.js
 *
 * Sky, 2026-11-02: deals publish themselves to greencrosscanna.com/deals through GX Core's Wix
 * connector (GXCore v364). This RUNS the engine's own publisher against an in-memory Wix (the same
 * calls the connector answers: read, upsert by key, delete by key, prune) and checks what matters:
 *   · nothing goes out until Sky ticks the approval, and only Sky's tick counts (signed by the session)
 *   · only customer copy crosses: every field sent is on the connector's allowlist, read from the hub
 *   · the vendor-day rows use the same keys and labels the hand-entered Grön rows use
 *   · rows typed by hand are never updated or removed, and SPIFF makes no copy of one
 *   · a program that closes comes off; past days are pruned in LA time; removals have brakes
 *   · Shop Now lists only the stores whose inventory has the brand; none hides it and emails Tawny once
 *   · the Featured image is checked against the spec before anything is imported
 *   · it is off by default, runs last in the hourly job, and nothing that pays calls it
 * and runs the page block itself (wix/gc-deals.js) to check the store picker reads shopStores.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* GX Core's real store rows (?action=stores, 2026-11-02), trimmed to what the publisher reads. */
const STORES = [
  { store_id: 'bend', display_name: 'Century', address: '341 SW Century Dr' },
  { store_id: 'center', display_name: 'Center', address: '1695 Center St NE' },
  { store_id: 'commercial', display_name: 'Commercial', address: '4550 Commercial St SE' },
  { store_id: 'hillsboro', display_name: 'Baseline', address: '1234 SW Baseline St, Ste A' },
  { store_id: 'portland-rd', display_name: 'Portland', address: '4618 Portland Rd NE, Ste 110' },
  { store_id: 'river-rd', display_name: 'River', address: '3165 River Rd N' },
];
const VENDORS = [
  { _id: 'v-gron', title: 'Grön', aliases: ['Gron', 'GRON'], menuSlug: null },
  { _id: 'v-bob', title: 'Bobsled', aliases: null, menuSlug: 'bobsled-extracts' },
];
const APPROVED = { by: 'sky', at: '2026-11-02T10:00:00Z' };

/* The live Grön program, as SPIFF holds it (2026-11-02), plus the deals-page item. */
function gron(o) {
  const m = Object.assign({
    v: 1, sel: { vday: true, web: true },
    d: { web: { headline: 'Grön Pearls week', note: '30% off all Grön, in store, at the listed store and time only.',
                deal: '30% OFF', offer: 'all Grön, in store, this store and time only', alt: 'Pearls by Grön' } },
    rows: { web: [{ text: '$4 off Pearls by Grön 10-packs, Tuesday Nov 3' }, { text: 'Limited <b>release</b>' }] },
    done: { 'web.approve': APPROVED },
    vdays: [{ store: 'commercial', date: '2026-11-03', time: '1-3:30' }, { store: 'river-rd', date: '2026-11-03', time: '4-6:30' },
            { store: 'hillsboro', date: '2026-11-05', time: '3-5:30' }, { store: '', date: '2026-11-06', time: '4pm' },
            { store: 'commercial', date: '2026-11-03', time: '5-6' }, { store: 'center', date: '2026-11-01', time: '4-6' }],
  }, (o && o.plan) || {});
  return Object.assign({ program_id: 'all-products-202610', vendor: 'Gron', program_name: 'All products', status: 'active',
    start_date: '2026-10-26', end_date: '2026-11-08', match_json: { brand: 'Gron' },
    payout_json: { model: 'flat', amount: 25 }, cost_json: { per_unit: 9 }, actual_json: { units_sold: 400 },
    marketing_json: m }, o || {}, { marketing_json: m });
}

/* An in-memory Wix that answers the way GX Core's connector does. */
function makeWix(seed) {
  const w = {
    featured: (seed && seed.featured || []).map(r => Object.assign({}, r)),
    days: (seed && seed.days || []).map(r => Object.assign({}, r)),
    calls: [], imports: [],
    vendors: () => (w.calls.push('vendors'), VENDORS),
    read: (c) => (w.calls.push('read:' + c), (c === 'FeaturedDeals' ? w.featured : c === 'Import1' ? [] : w.days).map(r => Object.assign({}, r))),
    /* Like GX Core's gate (v365): every row needs an approver on the list, which is then stripped. */
    upsert: (c, items) => {
      w.calls.push('upsert:' + c);
      const list = c === 'FeaturedDeals' ? w.featured : w.days, key = c === 'FeaturedDeals' ? 'programId' : 'dayKey';
      if (items.some(it => ['sky', 'mike', 'tawny'].indexOf(it.approvedBy) < 0)) return { ok: false, refused: true, error: 'not approved for the public page' };
      items = items.map(it => { const x = Object.assign({}, it); delete x.approvedBy; return x; });
      return { ok: true, results: items.map(it => {
        const hit = list.find(r => r[key] === it[key]);
        if (hit) { Object.assign(hit, it); return { key: it[key], op: 'updated' }; }
        list.push(Object.assign({}, it)); return { key: it[key], op: 'inserted' };
      }) };
    },
    remove: (c, keys) => {
      w.calls.push('remove:' + c);
      const key = c === 'FeaturedDeals' ? 'programId' : 'dayKey';
      if (c === 'FeaturedDeals') w.featured = w.featured.filter(r => keys.indexOf(r[key]) < 0);
      else w.days = w.days.filter(r => keys.indexOf(r[key]) < 0);
      return { ok: true };
    },
    prune: () => { w.calls.push('prune'); w.days = w.days.filter(r => String(r.date) >= w.today); return { ok: true }; },
    importImage: (url, name, mime) => (w.imports.push(url), { ok: true, wix_image: 'wix:image://v1/abc~mv2.png/' + name + '#originWidth=1200&originHeight=1200' }),
    mediaStatus: () => ({ ok: true, status: 'READY', wix_image: 'wix:image://v1/later' }),
    driveMeta: (id) => w.meta[id] || { name: id + '.png', mimeType: 'image/png', size: 900000, imageMediaMetadata: { width: 1200, height: 1200 } },
    meta: {}, today: '2026-11-02',
  };
  return w;
}

/* The hand-entered Grön card and one of its days, exactly as Wix holds them (wix_read, 2026-11-02). */
const HAND_CARD = { programId: 'gron-202611', title: 'Grön', startDate: '2026-11-01', endDate: '2026-11-08', live: true };
const HAND_DAY = { dayKey: 'gron-202611|commercial-st|2026-11-03', programId: 'gron-202611', title: 'Grön', date: '2026-11-03',
                   store: 'Commercial St', time: '1 to 3:30 PM', sortTime: 780 };

const P = G.makeProps({ GX_DEPLOY_SECRET: 's3cret' });
const mail = [];
let PROGRAMS = [gron()];
let WIX = makeWix();
const INVENTORY = {
  commercial: [{ brandName: 'GRON', productName: 'Pearls 10pk', quantityAvailable: 12 }, { brandName: 'Wyld', productName: 'x', quantityAvailable: 3 }],
  'river-rd': [{ brandName: 'GRON', productName: 'Sample Pearls', quantityAvailable: 2 }, { brandName: 'GRON', productName: 'Pearls', quantityAvailable: 0 }],
  center: [{ brandName: 'GRON', productName: 'Mega Pearl', quantityAvailable: 4 }],
  hillsboro: [], 'portland-rd': [], bend: [],
};
let invFails = {};
const bugs = [];
const makeApi = (varValues) => G.load({
  real: ['wixFold_', 'wixMenuSlug_', 'wixEsc_', 'wixStoreLabel_', 'wixTimeOf_', 'wixDayLabels_', 'wixThroughLabel_', 'wixOfferHtml_',
         'wixApprover_', 'wixCopyProblem_', 'wixSignDelta_', 'wixDutchieBrand_', 'wixVendorIndex_', 'wixDesired_', 'wixSameItem_', 'wixPlan_',
         'wixImageProblem_', 'wixDriveFileId_', 'wixImageFor_', 'wixShopStores_', 'wixPublish_', 'publishToWixWeb_', 'wixReportFailure_',
         'runWixPublishHourly_', 'calParseTime_', 'addDaysLocal_', 'normalizeMarketing_', 'mktPickedIds_', 'slug_', 'parseJson_', 'num_',
         'sitePublish_', 'sitePlan_', 'siteProblem_'],
  vars: ['SITE_DAYS_', 'SITE_MAX_REMOVES_', 'WIX_PUBLISHED_PROP_', 'WIX_SHOP_PROP_', 'WIX_NOSHOP_PREFIX_', 'WIX_IMAGE_PREFIX_', 'WIX_LOOKAHEAD_DAYS_', 'WIX_MAX_REMOVES_',
         'WIX_ITEM_', 'WIX_APPROVE_TASK_', 'WIX_APPROVERS_', 'WIX_COPY_RULES_', 'WIX_FAIL_PROP_', 'WIX_FEATURED_SPEC_', 'WIX_SPEC_TEXT_',
         'WIX_DOW_', 'WIX_MON_', 'MKT_MENU_', 'MKT_PEOPLE_', 'MKT_APP_URL', 'GX_SECRET_PROP'],
  varValues: Object.assign({ WIX_APPROVER_FIELD_: G.grabVar('WIX_APPROVER_FIELD_') }, varValues || {}),
  stubs: {
    listPrograms_: () => PROGRAMS, gxStores_: () => STORES, wixAdapter_: () => WIX, readSite_: () => [],
    dutchieInventoryViaGXCore_: (id) => { if (invFails[id]) throw new Error('Dutchie 401'); return INVENTORY[id] || []; },
    today_: () => WIX.today, nowStamp_: () => '2026-11-02 09:00:00',
    scrubSecrets_: (m) => String(m), sendMail_: (m) => { mail.push(m); },
  },
  globals: { PropertiesService: P.PropertiesService, console: { log() {}, warn() {} },
             GXCore: { gxIngestBug: (app, by, b) => (bugs.push(Object.assign({ app: app }, b)), { ok: true }) } },
});
const api = makeApi();
const run = (o) => api.wixPublish_(Object.assign({ today: WIX.today, wix: WIX, readShop: true }, o || {}));

console.log('\n1. the labels the page shows');
{
  const L = STORES.map(api.wixStoreLabel_);
  ok('store labels come from GX Core\'s addresses: ' + L.join(', '),
     L.join('|') === 'Century Dr|Center St|Commercial St|Baseline St|Portland Rd|River Rd');
  ok('"1-3:30" reads as the hand-entered rows do: 1 to 3:30 PM, minute 780',
     api.wixTimeOf_('1-3:30').label === '1 to 3:30 PM' && api.wixTimeOf_('1-3:30').minute === 780);
  ok('"11am-1pm" keeps both halves of the day', api.wixTimeOf_('11am-1pm').label === '11 AM to 1 PM');
  ok('a single time stays a single time', api.wixTimeOf_('4pm').label === '4 PM' && api.wixTimeOf_('4pm').minute === 960);
  ok('unreadable text goes out as typed', api.wixTimeOf_('after close').label === 'after close' && api.wixTimeOf_('after close').minute === 0);
  const d = api.wixDayLabels_('2026-11-03');
  ok('2026-11-03 is TUE, 11/3, Tue Nov 3', d.dayLabel === 'TUE' && d.dateLabel === '11/3' && d.long === 'Tue Nov 3');
  ok('the end date reads "Through Nov 8"', api.wixThroughLabel_('2026-11-08') === 'Through Nov 8');
  ok('an offer line starting with a price bolds the price and escapes the rest',
     api.wixOfferHtml_(['$4 off Pearls', 'a <script>', '30% off all Grön', '']) ===
     '<p><strong>$4</strong> off Pearls</p><p>a &lt;script&gt;</p><p><strong>30% off</strong> all Grön</p>');
  ok('menu slugs are the menu\'s: Bobsled Extracts → bobsled-extracts, Grön → gron',
     api.wixMenuSlug_('Bobsled Extracts') === 'bobsled-extracts' && api.wixMenuSlug_('Grön') === 'gron');
  ok('Dutchie\'s spelling: one match is the brand', api.wixDutchieBrand_({ match_json: { brand: 'Bobsled' } }, ['Bobsled Extracts', 'Wyld']).name === 'Bobsled Extracts');
  ok('  …an exact name wins over a longer one', api.wixDutchieBrand_({ vendor: 'Mule' }, ['Mule', 'Mule Extracts']).name === 'Mule');
  const amb = api.wixDutchieBrand_({ vendor: 'Mule' }, ['Mule Extracts', 'Mule Gummies']);
  ok('  …two and no exact one is ambiguous: no slug is guessed', amb.name === '' && amb.candidates.length === 2);
}

console.log('\n2. what goes out, and what does not');
{
  const d = api.wixDesired_({ programs: [gron()], vendors: VENDORS, storeLabels: { commercial: 'Commercial St', 'river-rd': 'River Rd', hillsboro: 'Baseline St', center: 'Center St' },
                              shop: { stores: { commercial: ['GRON'], center: ['GRON'], 'river-rd': [] } } }, '2026-11-02');
  const f = d.featured[0];
  ok('an approved, running program makes one card', d.featured.length === 1 && f.programId === 'all-products-202610');
  ok('  …with the copy as typed', f.headline === 'Grön Pearls week' && /<strong>\$4<\/strong> off Pearls/.test(f.offerLines) && /Limited &lt;b&gt;release/.test(f.offerLines));
  ok('  …linked to its Vendors logo through the alias', f.vendorRef === 'v-gron');
  ok('  …live, through Nov 8, with its window as text', f.live === true && f.throughLabel === 'Through Nov 8' && f.startDate === '2026-10-26' && f.endDate === '2026-11-08');
  ok('  …and Shop Now limited to the stores that stock it', JSON.stringify(f.shopStores) === '["center","commercial"]');
  ok('the day that already passed (Nov 1) is not sent', d.days.every(x => x.date >= '2026-11-02') && d.days.length === 5);
  const c = d.days.find(x => x.date === '2026-11-03' && x.time === '1 to 3:30 PM');
  ok('a day row uses the hand-entered key and labels: ' + c.dayKey,
     c.dayKey === 'all-products-202610|commercial-st|2026-11-03' && c.store === 'Commercial St' && c.dayLabel === 'TUE' && c.dateLabel === '11/3' && c.sortTime === 780);
  ok('  …and the deal and offer typed once for the program', c.deal === '30% OFF' && c.offer === 'all Grön, in store, this store and time only');
  ok('a second day at the same store and date gets |2', d.days.some(x => x.dayKey === 'all-products-202610|commercial-st|2026-11-03|2'));
  ok('a day with no store is "all", and the page says All stores', d.days.some(x => x.dayKey === 'all-products-202610|all|2026-11-06' && x.store === ''));
  ok('the card lists its days the way the hand-made card does', /<p><strong>Tue Nov 3<\/strong> · Commercial St · 1 to 3:30 PM<\/p>/.test(f.vendorDays));

  /* The connector's allowlist, read from the hub so the two cannot drift. */
  /* The hub's MERGED main when git can give it (its folder may sit on another branch), else its file. */
  let hub = '';
  for (let dir = __dirname, i = 0; i < 8 && !hub; i++, dir = path.dirname(dir)) {
    const repo = path.join(dir, 'greencross-command-center'), f2 = path.join(repo, 'gx_wix.gs');
    if (!fs.existsSync(f2)) continue;
    try { hub = require('child_process').execFileSync('git', ['-C', repo, 'show', 'origin/main:gx_wix.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { hub = fs.readFileSync(f2, 'utf8'); }
  }
  if (hub) {
    const allow = new Function(hub.match(/var GX_WIX_COLLECTIONS_ = (\{[\s\S]*?\n\});/)[0].replace('var GX_WIX_COLLECTIONS_ =', 'return') )();
    /* The approver field is the gate's own: checked, then stripped before the allowlist applies. */
    const gateField = (hub.match(/var GX_WIX_APPROVER_FIELD_ = '([^']+)'/) || [])[1];
    ok('SPIFF sends the approver under the field name the gate reads (' + gateField + ')', !gateField || gateField === G.grabVar('WIX_APPROVER_FIELD_'));
    const extra = (items, coll) => [].concat.apply([], items.map(it => Object.keys(it))).filter(k => k !== gateField && allow[coll].fields.indexOf(k) < 0);
    ok('every Featured field is on the connector\'s allowlist', !extra(d.featured, 'FeaturedDeals').length);
    ok('every VendorDays field is on it too', !extra(d.days, 'VendorDays').length);
  } else console.log('  · (hub not checked out beside this repo; allowlist check skipped)');
  const sent = JSON.stringify(d);
  ok('no payout, cost, actuals or staff field rides along', !/payout|amount|per_unit|units_sold|cost_json|actual/.test(sent) && sent.indexOf('"25"') < 0);

  const wait = api.wixDesired_({ programs: [gron({ plan: { done: {} } })], vendors: VENDORS }, '2026-11-02');
  ok('nothing goes out before an approver approves', !wait.featured.length && !wait.days.length && /Sky, Mike or Tawny to approve/.test(wait.skipped[0].why));
  const byTawny = api.wixDesired_({ programs: [gron({ plan: { done: { 'web.approve': { by: 'tawny', at: 'x' } } } })], vendors: VENDORS }, '2026-11-02');
  ok('  …Tawny\'s approval counts (Sky, Mike and Tawny only)', byTawny.featured.length === 1);
  const notApprover = api.wixDesired_({ programs: [gron({ plan: { done: { 'web.approve': { by: 'kim', at: 'x' } } } })], vendors: VENDORS }, '2026-11-02');
  ok('  …a tick signed by anyone else is not approval', !notApprover.featured.length);
  for (const [word, line] of [['free', 'Free pre-roll'], ['bogo', 'BOGO carts'], ['with purchase', '$5 off with any purchase'], ['buy one', 'Buy one get one'],
                              ['best', 'Our best price'], ['#1', 'The #1 vape'], ['lowest', 'Lowest prices'], ['em-dash', '$4 off — today']]) {
    const bad = api.wixDesired_({ programs: [gron({ plan: { rows: { web: [{ text: line }] } } })], vendors: VENDORS }, '2026-11-02');
    ok('copy with "' + word + '" is not published, and says why', !bad.featured.length && bad.skipped[0].why.indexOf('"' + word + '"') >= 0);
  }
  ok('  …"sugar-free" and "$4 off" are not caught by the rule on "free" and "off"', api.wixCopyProblem_(['$4 off', 'Freshy carts']) === '');
  const MK0 = require('../marketing.js');
  ok('the screen warns on the same words as the engine', JSON.stringify(MK0.COPY_RULES) === JSON.stringify(G.grabVar('WIX_COPY_RULES_')));
  const byMike = api.wixDesired_({ programs: [gron({ plan: { done: { 'web.approve': { by: 'mike', at: 'x' } } } })], vendors: VENDORS }, '2026-11-02');
  ok('every row carries who approved it, as their user_id', byMike.featured[0].approvedBy === 'mike' && byMike.days.every(x => x.approvedBy === 'mike'));
  const blank = makeApi({ WIX_APPROVER_FIELD_: '' }).wixDesired_({ programs: [gron()], vendors: VENDORS }, '2026-11-02');
  ok('  …and a blank field name sends none (the pre-v365 shape)', !Object.keys(blank.featured[0]).some(k => /approv/i.test(k)));
  const noHead = api.wixDesired_({ programs: [gron({ plan: { d: { web: { deal: '30% OFF' } } } })], vendors: VENDORS }, '2026-11-02');
  ok('no headline: not sent, and says why', !noHead.featured.length && noHead.skipped[0].why === 'no headline yet');
  const noItem = api.wixDesired_({ programs: [gron({ plan: { sel: { vday: true } } })], vendors: VENDORS }, '2026-11-02');
  ok('a program not planned for the website is silent', !noItem.featured.length && !noItem.skipped.length);
  const noVday = api.wixDesired_({ programs: [gron({ plan: { sel: { web: true } } })], vendors: VENDORS }, '2026-11-02');
  ok('days go out only when Vendor day is picked too', noVday.featured.length === 1 && !noVday.days.length);
  ok('closed programs never go out', !api.wixDesired_({ programs: [gron({ status: 'closed' })], vendors: VENDORS }, '2026-11-02').featured.length);
  const soon = api.wixDesired_({ programs: [gron({ status: 'draft', start_date: '2026-11-09', end_date: '2026-11-22' })], vendors: VENDORS }, '2026-11-02');
  ok('a draft starting within 7 days is staged with live=false', soon.featured.length === 1 && soon.featured[0].live === false);
  ok('  …one starting later is not sent yet',
     !api.wixDesired_({ programs: [gron({ status: 'draft', start_date: '2026-11-10', end_date: '2026-11-22' })], vendors: VENDORS }, '2026-11-02').featured.length);
  const unknown = api.wixDesired_({ programs: [gron({ vendor: 'Newbrand', match_json: { brand: 'Newbrand' } })], vendors: VENDORS }, '2026-11-02');
  ok('a brand missing from Vendors still goes out, with no vendorRef, and a problem says so',
     unknown.featured.length === 1 && !('vendorRef' in unknown.featured[0]) && /no Vendors item/.test(unknown.problems[0].problem));
  const noShop = api.wixDesired_({ programs: [gron()], vendors: VENDORS }, '2026-11-02');
  ok('without a day\'s inventory read, shopStores is left as it is on the card', !('shopStores' in noShop.featured[0]));
  const two = api.wixDesired_({ programs: [gron({ program_id: 'b', end_date: '2026-11-20' }), gron({ program_id: 'a', end_date: '2026-11-08' })], vendors: VENDORS }, '2026-11-02');
  ok('cards sort soonest-ending first', two.featured.map(x => x.programId + x.sortOrder).join() === 'a1,b2');
}

console.log('\n3. the session signs ticks, and only Sky approves');
{
  const cur = { d: { web: { headline: 'A' } }, rows: {}, done: { 'web.approve': APPROVED } };
  const t1 = api.wixSignDelta_([['done', 'core.menu', { by: 'sky', at: 'x' }]], 'tawny', cur);
  ok('a tick is signed by the signed-in user, not the name the browser sent', t1[0][2].by === 'tawny');
  ok('a manager cannot tick the approval', api.wixSignDelta_([['done', 'web.approve', { by: 'sky', at: 'x' }]], 'kim', {}).length === 0);
  ok('  …Sky, Mike and Tawny can, each signed as themselves',
     ['sky', 'mike', 'tawny'].every(u => api.wixSignDelta_([['done', 'web.approve', { by: 'x', at: 'x' }]], u, {})[0][2].by === u));
  ok('  …and anyone can un-tick it', api.wixSignDelta_([['done', 'web.approve', null]], 'kim', cur).length === 1);
  const edit = api.wixSignDelta_([['d', 'web', { headline: 'B' }]], 'kim', cur);
  ok('anyone else changing the copy takes the approval away', edit.length === 2 && edit[1][0] === 'done' && edit[1][1] === 'web.approve' && edit[1][2] === null);
  ok('  …and so does an offer line', api.wixSignDelta_([['rows', 'web', [{ text: 'x' }]]], 'kim', cur)[1][2] === null);
  const re = api.wixSignDelta_([['d', 'web', { headline: 'B' }]], 'tawny', cur);
  ok('an approver changing approved copy re-signs it as their own', re.length === 2 && re[1][2].by === 'tawny');
  ok('re-saving the same copy is not a change', api.wixSignDelta_([['d', 'web', { headline: 'A' }]], 'kim', cur).length === 1);
  ok('moving a vendor day is not copy and keeps it', api.wixSignDelta_([['vdays', null, []]], 'kim', cur).length === 1);
}

console.log('\n4. publishing: hand-made rows stay, ours move, closed comes off');
{
  WIX = makeWix({ featured: [HAND_CARD], days: [HAND_DAY, { dayKey: 'old|x|2026-10-30', title: 'Wyld', date: '2026-10-30' }] });
  PROGRAMS = [gron()];
  const dry = run({ apply: false });
  ok('a dry run writes nothing', WIX.calls.every(c => !/^(upsert|remove|prune)/.test(c)) && !P.props.WIX_PUBLISHED);
  ok('the hand-made Grön card means SPIFF makes no second one', !dry.send.featured.length && dry.skipped_duplicates.some(s => s.hand_made === 'gron-202611'));
  ok('  …nor a second Commercial St Nov 3 day', !dry.send.days.some(x => x.dayKey === 'all-products-202610|commercial-st|2026-11-03'));
  ok('  …but days the hand-made rows do not cover still go', dry.send.days.some(x => x.dayKey === 'all-products-202610|river-rd|2026-11-03'));
  ok('the past day would be pruned', dry.pruned_past_days === 1);

  WIX = makeWix();
  const r = run({ apply: true });
  ok('apply sends the card and every day', r.ok && WIX.featured.length === 1 && WIX.days.length === 5);
  const pub = JSON.parse(P.props.WIX_PUBLISHED);
  ok('  …and remembers exactly what it put there', pub.featured.join() === 'all-products-202610' && pub.days.length === 5);
  WIX.calls = [];
  const again = run({ apply: true });
  ok('a second run with nothing changed writes nothing', again.unchanged === 6 && !WIX.calls.some(c => /^upsert|^remove/.test(c)));

  PROGRAMS = [gron({ plan: { d: { web: { headline: 'Grön Pearls week, extended', deal: '30% OFF', offer: 'all Grön, in store, this store and time only' } } } })];
  run({ apply: true });
  ok('an edit UPDATES the same card, never a second one', WIX.featured.length === 1 && WIX.featured[0].headline === 'Grön Pearls week, extended');

  WIX.featured.push(Object.assign({}, HAND_CARD));
  PROGRAMS = [gron({ status: 'closed' })];
  const gone = run({ apply: true });
  ok('a closed program comes off: card and days', !WIX.featured.some(x => x.programId === 'all-products-202610') && !WIX.days.length && gone.ok);
  ok('  …and the hand-made card is left alone', WIX.featured.length === 1 && WIX.featured[0].programId === 'gron-202611');
  ok('  …and is forgotten as published', JSON.parse(P.props.WIX_PUBLISHED).featured.length === 0);
}
{
  WIX = makeWix();
  PROGRAMS = [gron()];
  run({ apply: true });
  PROGRAMS = [];
  const r = run({ apply: true });
  ok('an empty programs tab refuses the removals', /programs tab read empty/.test(r.refused) && WIX.featured.length === 1);
  ok('  …and they stay remembered for next time', JSON.parse(P.props.WIX_PUBLISHED).featured.length === 1);
  const desired = { featured: [], days: [] };
  const big = { featured: [], days: Array.from({ length: 41 }, (_, i) => ({ dayKey: 'k' + i })) };
  const plan = api.wixPlan_(desired, big, { featured: [], days: big.days.map(x => x.dayKey) }, 3);
  ok('more than 40 removals in one run is refused', /limit 40/.test(plan.refused) && !plan.remove_days.length);
}
{
  WIX = makeWix();
  PROGRAMS = [gron()];
  run({ apply: true });
  WIX.today = '2026-11-04';
  WIX.days.push({ dayKey: 'hand|x|2026-11-01', title: 'Wyld', date: '2026-11-01' });
  run({ apply: true, today: '2026-11-04' });
  ok('days whose LA date has passed come off, ours and hand-made', WIX.days.every(x => x.date >= '2026-11-04') && WIX.calls.indexOf('prune') >= 0);
}

{
  WIX = makeWix({ featured: [Object.assign({}, HAND_CARD)] });
  PROGRAMS = [gron()];
  run({ apply: true, today: '2026-11-08' });
  ok('a hand-made card still runs on its last day (LA)', WIX.featured.some(x => x.programId === 'gron-202611'));
  PROGRAMS = [gron({ status: 'closed' })];
  const r = run({ apply: true, today: '2026-11-09' });
  ok('the day after its end date it comes off, hand-made or not (Core does not clear them)',
     !WIX.featured.length && r.expired_featured.indexOf('gron-202611') >= 0);
  ok('  …and it is not then remembered as SPIFF\'s', JSON.parse(P.props.WIX_PUBLISHED).featured.indexOf('gron-202611') < 0);
}

console.log('\n5. Shop Now: the stores that stock the brand');
{
  P.props.WIX_SHOP_STORES = '';
  WIX = makeWix();
  PROGRAMS = [gron()];
  mail.length = 0;
  const r = run({ apply: true });
  ok('stores are read from live inventory, samples and empty shelves ignored: ' + r.shop[0].stores.join(','),
     r.shop[0].stores.join() === 'center,commercial' && r.shop[0].dutchie_brand === 'GRON');
  ok('  …and the card carries them', JSON.stringify(WIX.featured[0].shopStores) === '["center","commercial"]');
  ok('Vendors has no Menu Slug for Grön, and its name already slugs right: no fix asked', !r.menu_slug_fixes.length);
  const shop = JSON.parse(P.props.WIX_SHOP_STORES);
  ok('the answer is kept for the LA day, with only the brands asked about', shop.day === '2026-11-02' && shop.stores.commercial.join() === 'GRON');
  invFails = { commercial: true };
  const r2 = run({ apply: true });
  ok('the same day, no store is read again', r2.shop[0].stores.join() === 'center,commercial');
  P.props.WIX_SHOP_STORES = JSON.stringify(Object.assign(shop, { day: '2026-11-01' }));
  const r3 = run({ apply: true });
  ok('a store whose inventory fails keeps yesterday\'s answer (a refused source is not a zero)',
     r3.shop[0].stores.join() === 'center,commercial' && r3.problems.some(p => /could not be read at commercial/.test(p.problem)));
  invFails = {};
  ok('no email while a store carries it', !mail.length);

  P.props.WIX_SHOP_STORES = '';
  INVENTORY.commercial = []; INVENTORY.center = [];
  const none = run({ apply: true });
  ok('no store stocks it: shopStores is empty, so the page hides Shop Now', JSON.stringify(WIX.featured[0].shopStores) === '[]');
  ok('  …and Tawny gets one email', mail.length === 1 && mail[0].to === 'tawny@greencrosscanna.com' && /no store has Gron/.test(mail[0].subject) && none.notified.length === 1);
  P.props.WIX_SHOP_STORES = '';
  run({ apply: true });
  ok('  …only once', mail.length === 1);

  const bob = api.wixDesired_({ programs: [gron({ program_id: 'bob', vendor: 'Bobsled', match_json: { brand: 'Bobsled' } })], vendors: [{ _id: 'v-bob', title: 'Bobsled', menuSlug: 'bobsled' }],
                                shop: { stores: { commercial: ['Bobsled Extracts'] } }, sendShopBrand: true }, '2026-11-02');
  ok('a Vendors Menu Slug that disagrees with Dutchie is reported for a person to fix', bob.shop[0].fix === true && bob.shop[0].slug === 'bobsled-extracts');
  ok('  …and shopBrand is sent only when the connector has been told to allow it', bob.featured[0].shopBrand === 'bobsled-extracts'
     && !('shopBrand' in api.wixDesired_({ programs: [gron()], vendors: VENDORS, shop: { stores: { commercial: ['GRON'] } } }, '2026-11-02').featured[0]));
}

console.log('\n6. the featured image meets the spec, or is refused');
{
  const sq = (w, h, o) => Object.assign({ mimeType: 'image/png', size: 900000, imageMediaMetadata: { width: w, height: h } }, o || {});
  ok('1200 × 1200 PNG under 2 MB passes', api.wixImageProblem_(sq(1200, 1200)) === '');
  ok('not square is refused, naming the size', /1200 × 900, and it must be square/.test(api.wixImageProblem_(sq(1200, 900))));
  ok('too small is refused', /1080 to 2400/.test(api.wixImageProblem_(sq(800, 800))));
  ok('over 2 MB is refused', /limit is 2 MB/.test(api.wixImageProblem_(sq(1200, 1200, { size: 3000000 }))));
  ok('a GIF is refused', /not a JPG or PNG/.test(api.wixImageProblem_(sq(1200, 1200, { mimeType: 'image/gif' }))));
  WIX = makeWix();
  const props = P.PropertiesService.getScriptProperties();
  const url = 'https://drive.google.com/file/d/1k_irje-UojJteorxQkjIGHfKdByQ9LPQ/view';
  ok('a dry run imports nothing', !!api.wixImageFor_(url, false, WIX, props).pending && !WIX.imports.length);
  const got = api.wixImageFor_(url, true, WIX, props);
  ok('apply imports the Drive file once and stores the wix:image value', /^wix:image:/.test(got.uri) && WIX.imports[0] === 'https://lh3.googleusercontent.com/d/1k_irje-UojJteorxQkjIGHfKdByQ9LPQ');
  api.wixImageFor_(url, true, WIX, props);
  ok('  …and never imports the same file twice', WIX.imports.length === 1);
  ok('a pasted wix:image value is used as it is', api.wixImageFor_('wix:image://v1/x', true, WIX, props).uri === 'wix:image://v1/x');
  WIX.meta.BADBADBADBADBADBADBADBAD = sq(1600, 900);
  const bad = api.wixImageFor_('https://drive.google.com/file/d/BADBADBADBADBADBADBADBAD/view', true, WIX, props);
  ok('a file that breaks the spec is refused before import, with the spec', /must be square/.test(bad.problem) && /1200 × 1200/.test(bad.problem) && WIX.imports.length === 1);

  PROGRAMS = [gron({ plan: { d: { web: { headline: 'H', image: 'https://drive.google.com/file/d/BADBADBADBADBADBADBADBAD/view' } } } })];
  const r = run({ apply: true });
  ok('a refused image leaves the card without one and says why', !('image' in WIX.featured[0]) && r.problems.some(p => /must be square/.test(p.problem)));
}

console.log('\n7. the switch, the route, the hourly job');
{
  const calls = [];
  WIX = makeWix();
  const orig = WIX.vendors;
  WIX.vendors = () => (calls.push('v'), orig());
  ok('the hourly step is OFF until WIX_PUBLISH_ON=1', api.runWixPublishHourly_().skipped === true && !calls.length);
  P.props.WIX_PUBLISH_ON = '1';
  ok('  …and runs once it is set', api.runWixPublishHourly_().apply === true && calls.length === 1);
  /* A failure reaches Sky: filed on SPIFF's bug board, once a day per distinct failure. */
  bugs.length = 0;
  WIX = makeWix();
  PROGRAMS = [gron()];
  WIX.upsert = () => ({ ok: false, error: 'Wix 503 on POST /wix-data/v2/items' });
  api.runWixPublishHourly_();
  ok('a failed write is filed as a SPIFF bug Sky reads', bugs.length === 1 && bugs[0].app === 'spiff' && /Wix 503/.test(bugs[0].desc) && bugs[0].priority === 'high');
  api.runWixPublishHourly_();
  ok('  …once, not every hour', bugs.length === 1);
  WIX.read = () => { throw new Error('wix_read FeaturedDeals failed: Wix not configured'); };
  let threw = false;
  try { api.runWixPublishHourly_(); } catch (e) { threw = true; }
  ok('a run that stops is filed too, and still throws to the hourly job\'s own catch', threw && bugs.length === 2 && /run stopped/.test(bugs[1].desc));
  delete P.props.WIX_PUBLISH_ON;
  WIX = makeWix();
  ok('the route wants the deploy secret', api.publishToWixWeb_({ secret: 'nope' }).error === 'Unauthorized');
  ok('  …and is dry without apply=1', api.publishToWixWeb_({ secret: 's3cret' }).apply === false);

  /* Architecture guards, which no execution can show: where it runs, and who may not call it. */
  const trig = G.grab('refreshSpiffProgressTrigger');
  ok('the hourly job runs it AFTER the pay publish and the calendar', trig.indexOf('runWixPublishHourly_') > trig.indexOf('publishSpiffToCore_') && trig.indexOf('runWixPublishHourly_') > trig.indexOf('runCalendarSyncHourly_'));
  ok('  …inside its own try', /try \{ runWixPublishHourly_\(\); \}\s*catch/.test(trig));
  const pay = ['publishSpiffToCore_', 'spiffProgress_', 'refreshSpiffProgress_', 'recordMeasuredActuals_', 'computePayouts_', 'sendBrandEmail_', 'giftCardList_'];
  ok('nothing that pays calls it', pay.every(n => !/wixPublish_|runWixPublishHourly_/.test(G.grab(n))));
  ok('it is a secret-only route', G.grabVar('SECRET_ACTIONS').indexOf('publishToWix') >= 0);
  /* The real adapter, against a recording GXCore: every write names SPIFF, as the v365 gate requires. */
  const seen = [];
  const rec = (name) => function () { seen.push({ name, opts: arguments[arguments.length - 1] || {} }); return { ok: true, vendors: [], items: [] }; };
  const real = G.load({ real: ['wixAdapter_'], vars: ['GX_SECRET_PROP', 'WIX_PUBLISHER_APP_'], stubs: { scrubSecrets_: String, driveApi_: () => ({}) },
    globals: { PropertiesService: P.PropertiesService,
               GXCore: { wixUpsert: rec('upsert'), wixDelete: rec('delete'), wixPrunePastVendorDays: rec('prune'), wixImportImage: rec('import'),
                         wixVendors: rec('vendors'), wixRead: rec('read'), wixMediaStatus: rec('status') } } }).wixAdapter_();
  real.upsert('VendorDays', []); real.remove('VendorDays', []); real.prune(); real.importImage('https://x', 'a.png', 'image/png');
  ok('every write call says app=spiff', seen.length === 4 && seen.every(s => s.opts.app === 'spiff' && s.opts.apply === true));
  ok('SPIFF is pinned to a GX Core with the approval gate (v365+)',
     Number(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8')).dependencies.libraries[0].version) >= 365);
}

console.log('\n8. the page block lists only the stores in shopStores');
{
  const code = fs.readFileSync(path.join(__dirname, '..', 'wix', 'gc-deals.js'), 'utf8');
  const defs = {};
  class El { getAttribute(k) { return this.attrs[k]; } querySelector() { return null; } getBoundingClientRect() { return { top: 0 }; } }
  const ctx = { customElements: { get: (n) => defs[n], define: (n, c) => { defs[n] = c; } }, HTMLElement: El, Intl,
                document: { getElementById: () => ({}), head: { appendChild() {} }, createElement: () => ({}), querySelector: () => null },
                window: { addEventListener() {}, scrollY: 0 }, console };
  vm.runInNewContext(code, ctx);
  const render = (f) => {
    const el = new defs['gc-deals']();
    el.attrs = { data: JSON.stringify({ vendors: VENDORS, featured: [Object.assign({ title: 'Grön', headline: 'H', live: true, endDate: '2099-01-01', vendorRef: 'v-gron' }, f)], days: [], week: [] }) };
    el.render();
    return el.innerHTML;
  };
  const all = render({});
  ok('a hand-typed card with no shopStores lists all six stores', (all.match(/\/stores\//g) || []).length === 6);
  const two = render({ shopStores: ['commercial', 'center'] });
  ok('a published list shows only those stores', (two.match(/\/stores\//g) || []).length === 2 && /commercial-st\/brands\/gron/.test(two) && /center-st-ne\/brands\/gron/.test(two));
  ok('an empty list hides Shop Now entirely', !/SHOP GRÖN NOW/.test(render({ shopStores: [] })) && /SHOP GRÖN NOW/.test(two));
  ok('shopBrand, when sent, is the brand slug in the link', /brands\/gron-pearls/.test(render({ shopBrand: 'gron-pearls' })));
}

console.log('\n9. the program screen: where the copy is typed, and the spec beside the image');
{
  const MK = require('../marketing.js');
  const ctx = { today: '2026-11-02', canEdit: true, engineReady: true, stores: STORES.map(s => ({ store_id: s.store_id, name: s.display_name })),
                storeName: (id) => id, moving: null };
  const html = MK.sectionHtml(gron({ plan: { done: {} } }), ctx);
  ok('the Deals page item has its headline, image, deal and offer fields',
     ['headline', 'image', 'alt', 'note', 'deal', 'offer', 'fine'].every(f => html.indexOf('data-mk-item="web" data-mk-field="' + f + '"') >= 0));
  ok('  …offer lines are a list, one per line', /data-mk-radd="web"/.test(html));
  ok('  …the Featured image spec sits beside the image link', /Featured image spec:<\/b> 1200 × 1200 px/.test(html));
  ok('  …and it says it waits for an approver', /once Sky, Mike or Tawny ticks/.test(html));
  ok('  …with the copy rules beside it', /Copy rules:<\/b> Straight discounts only/.test(html));
  ok('  …and a warning when the copy breaks one', /uses “free”/.test(MK.sectionHtml(gron({ plan: { rows: { web: [{ text: 'Free gift' }] } } }), ctx)));
  const t = MK.tasksOf(gron(), { stores: [] }).find(x => x.id === 'web.approve');
  ok('the approval is Sky\'s task', t && t.owner === 'Sky');
  ok('the screen checks the image shape the same way the engine does',
     MK.imageShapeProblem(1200, 1200) === '' && /square/.test(MK.imageShapeProblem(1200, 900)) && /1080 to 2400/.test(MK.imageShapeProblem(900, 900)));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
