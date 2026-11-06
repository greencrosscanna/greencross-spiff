#!/usr/bin/env node
/* ─── The weekly deals and the brand tiles are edited in SPIFF, not in Wix ─────────────────────────
 *
 *   RUN:  node tests/wix_site_test.js
 *
 * Sky, 2026-11-02: nobody edits greencrosscanna.com/deals in Wix. The Tue–Sat schedule (Weekly Deals,
 * Wix collection Import1) and the brand tiles (Vendors) are typed on SPIFF's Deals page screen and
 * published by the hourly step through GX Core's gate (GXCore v366: app=spiff, approvedBy on the list).
 * This RUNS the engine's own code (the save route on an in-memory sheet, the adoption plan, the publish
 * plan, the publisher against an in-memory Wix that refuses what GX Core refuses) and checks:
 *   · only Sky, Mike or Tawny approve, signed by the session; anyone else's edit un-approves
 *   · copy that breaks an OLCC rule cannot be approved and is never sent
 *   · the hand-made Wix rows are adopted onto the SAME rows (same _id), copied in un-approved, and an
 *     un-approved row is never written or removed
 *   · a weekly line taken off comes off Wix; a brand is never removed
 *   · every field sent is on the connector's allowlist, read from the hub
 *   · the tab is read by nothing that pays
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const HEADERS = G.grabVar('SITE_HEADERS');
let SESSION = { user: 'sky', role: 'admin' };
const sheet = G.makeSheet(HEADERS, []);
let stamp = 0;
const api = G.load({
  real: ['saveSiteDeal_', 'removeSiteDeal_', 'approveSiteDeals_', 'readSite_', 'rowToSite_', 'siteToRow_', 'siteWrite_', 'siteContent_', 'siteProblem_', 'siteSign_',
         'siteDealsRead_', 'siteAdoptPlan_', 'siteFoldDay_', 'sitePlan_', 'sitePublish_', 'wixCopyProblem_', 'wixFold_', 'wixMenuSlug_',
         'wixSameItem_', 'wixCanon_', 'parseJson_'],
  vars: ['SITE_HEADERS', 'SITE_DAYS_', 'SITE_MAX_REMOVES_', 'SITE_TEXT_COLS_', 'WIX_APPROVERS_', 'WIX_VDAY_AUTO_APPROVER_', 'WIX_COPY_RULES_', 'WIX_COPY_LIMITS_', 'WIX_APPROVER_FIELD_', 'SITE_TAB'],
  stubs: {
    siteSheet_: () => sheet,
    mktEditor_: () => (['admin', 'manager', 'editor'].indexOf(SESSION.role) >= 0 ? { auth: SESSION } : { fail: { ok: false, error: 'Your role cannot edit the deals page' } }),
    nowStamp_: () => '2026-11-02 20:00:' + String(++stamp).padStart(2, '0'),
    scrubSecrets_: (m) => String(m),
  },
  globals: { LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } },
});
const save = (item, who) => { if (who) SESSION = who; return api.saveSiteDeal_({ item: JSON.stringify(item) }); };
const SKY = { user: 'sky', role: 'admin' }, MIKE = { user: 'mike', role: 'manager' }, KIM = { user: 'kim', role: 'manager' };

console.log('\n1. saving a weekly line, and who can approve it');
{
  const r = save({ kind: 'week', day: 'tue', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates' }, KIM);
  ok('a manager can add a line', r.ok && r.created && /^wk-/.test(r.item.key) && r.item.day === 'TUE');
  ok('  …it is not approved', r.item.approved_by === '');
  const key = r.item.key;
  const k2 = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates', approve: true }, KIM);
  ok('a manager ticking approve is not approval (the browser\'s tick is ignored)', k2.ok && k2.item.approved_by === '');
  const s = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates', approve: true }, SKY);
  ok('Sky approves it, signed as sky', s.ok && s.item.approved_by === 'sky');
  const same = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates' }, KIM);
  ok('re-saving the same copy is not a change: the approval stays', same.item.approved_by === 'sky');
  const edit = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$3', text: 'OFF all 10-packs & full-size chocolates' }, KIM);
  ok('anyone else changing it takes the approval away', edit.item.approved_by === '' && edit.item.amount === '$3');
  const m = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates', approve: true }, MIKE);
  ok('Mike can approve, signed as mike', m.item.approved_by === 'mike');
  const un = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs & full-size chocolates', approve: false }, SKY);
  ok('an approver un-ticking clears it', un.item.approved_by === '');
  for (const [why, item] of [['free', { text: 'Free pre-roll' }], ['bogo', { text: 'BOGO carts' }], ['em-dash', { text: 'OFF carts — today' }],
                             ['a non-discount amount', { amount: '2 for $20' }], ['no day', { day: 'XYZ' }]]) {
    const b = save(Object.assign({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all', approve: true }, item), SKY);
    ok('copy with ' + why + ' cannot be approved, and says why', !b.ok && /Not approved/.test(b.error));
  }
  const bad = save({ key, kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'Free pre-roll' }, KIM);
  ok('  …it can still be saved as a draft, with the problem named', bad.ok && /OLCC/.test(bad.problem) && bad.item.approved_by === '');
  ok('a viewer cannot save at all', !save({ kind: 'week', day: 'WED' }, { user: 'v', role: 'viewer' }).ok);
  ok('an unknown key is refused (no silent re-create)', !save({ key: 'wk-gone', kind: 'week', day: 'TUE' }, SKY).ok);
  SESSION = SKY;
  ok('a weekly line can be taken off', api.removeSiteDeal_({ key }).removed === true);
  ok('  …and the read leaves it out', !api.siteDealsRead_().weekly.some(x => x.key === key));
  ok('  …but the row is kept in the tab', sheet.rows.some(r => r[0] === key && r[10] === 'removed'));
}

console.log('\n1b. an amount the sheet turned into a number (2026-11-03)');
{
  /* The takeover appended "$2" and the sheet stored the number 2 in a "$" format; Approve all then
     refused all eight weekly lines. The cell is read as the sheet shows it and written back as text. */
  const A = HEADERS.indexOf('amount') + 1;
  sheet.shown = (v, col) => (col === A && typeof v === 'number' ? (v < 1 ? Math.round(v * 100) + '%' : '$' + v) : String(v));
  const blank = HEADERS.map(() => '');
  const put = (key, amount) => { const r = blank.slice(); Object.assign(r, { 0: key, 1: 'week', 2: 'SAT', 3: 9, 4: 'Good Tide', 5: amount, 6: 'OFF all Good Tide', 10: 'live' }); sheet.rows.push(r); };
  put('sat-9', 4); put('sat-8', 0.15);
  const byKey = k => api.readSite_().find(s => s.key === k);
  ok('a stored 4 reads as "$4"', byKey('sat-9').amount === '$4');
  ok('a stored 0.15 reads as "15%"', byKey('sat-8').amount === '15%');
  ok('  …so neither is a copy problem', api.siteProblem_(byKey('sat-9')) === '' && api.siteProblem_(byKey('sat-8')) === '');
  const appended = sheet.appendRow; sheet.appendRow = () => { throw new Error('appendRow used'); };
  SESSION = SKY;
  const r = api.approveSiteDeals_({});
  ok('Approve all approves them', r.ok && r.approved.indexOf('sat-9') >= 0 && r.approved.indexOf('sat-8') >= 0);
  const cell = k => sheet.rows.find(x => x[0] === k)[A - 1];
  ok('  …and writes the amount back as text', cell('sat-9') === '$4' && cell('sat-8') === '15%');
  const n = save({ kind: 'week', day: 'MON', row: 1, brand: 'Wyld', amount: '$2', text: 'OFF Wyld' }, SKY);
  ok('a new line is written without appendRow', n.ok && n.created && cell(n.item.key) === '$2');
  sheet.appendRow = appended;
  ok('nothing in the deals tab appends a row (appendRow ignores the text format)',
     !/appendRow/.test(G.grab('saveSiteDeal_') + G.grab('adoptSite_') + G.grab('approveSiteDeals_') + G.grab('removeSiteDeal_')));
  sheet.rows = sheet.rows.filter(x => ['sat-9', 'sat-8', n.item.key].indexOf(x[0]) < 0);
  delete sheet.shown;
}

console.log('\n2. saving a brand');
{
  const r = save({ kind: 'vendor', brand: 'Bobsled', logo: 'wix:image://v1/bob.png', menu_slug: 'Bobsled Extracts', approve: true }, SKY);
  ok('a brand is keyed by its slug, and the menu slug is slugged', r.ok && r.item.key === 'bobsled' && r.item.menu_slug === 'bobsled-extracts' && r.item.approved_by === 'sky');
  const again = save({ kind: 'vendor', brand: 'Bobsled', logo_wide: 'wix:image://v1/bob-wide.png' }, KIM);
  ok('saving the same brand again updates it, not a second row', !again.created && sheet.rows.filter(x => x[0] === 'bobsled').length === 1);
  ok('  …keeps the logo it did not send, and is un-approved by a non-approver\'s change', again.item.logo === 'wix:image://v1/bob.png' && again.item.approved_by === '');
  const link = save({ kind: 'vendor', brand: 'Bobsled', logo: 'https://drive.google.com/file/d/abc/view', approve: true }, SKY);
  ok('a logo that is not in Wix Media cannot be approved', !link.ok && /Wix Media/.test(link.error));
  SESSION = SKY;
  ok('a brand cannot be taken off (cards point at its logo)', !api.removeSiteDeal_({ key: 'bobsled' }).ok);
}

console.log('\n2b. approve all');
{
  const waitA = save({ kind: 'week', day: 'WED', row: 1, brand: 'Wyld', amount: '$4', text: 'OFF Wyld multi-packs' }, KIM).item;
  const waitB = save({ kind: 'vendor', brand: 'Freshy', logo: 'wix:image://v1/f.png' }, KIM).item;
  const broken = save({ kind: 'week', day: 'THU', row: 1, brand: 'Mule', amount: '$3', text: 'Free dabs' }, KIM).item;
  const mikes = save({ kind: 'week', day: 'FRI', row: 1, brand: 'Bobsled', amount: '$2', text: 'OFF all Bobsled dabs', approve: true }, MIKE).item;
  const row = k => api.rowToSite_(sheet.rows.find(r => r[0] === k));
  SESSION = KIM;
  const no = api.approveSiteDeals_({});
  ok('a manager who is not an approver cannot approve all', !no.ok && row(waitA.key).approved_by === '');
  SESSION = { user: 'tawny', role: 'manager' };
  const r = api.approveSiteDeals_({});
  ok('Tawny approves every waiting line and brand, signed as tawny', r.ok && r.approved.indexOf(waitA.key) >= 0 && r.approved.indexOf(waitB.key) >= 0
     && row(waitA.key).approved_by === 'tawny' && row(waitB.key).approved_by === 'tawny');
  ok('  …a line that breaks the copy rules is skipped and named, not approved', r.skipped.some(x => x.key === broken.key && /OLCC/.test(x.problem)) && row(broken.key).approved_by === '');
  ok('  …a line someone already approved keeps its approver', r.approved.indexOf(mikes.key) < 0 && row(mikes.key).approved_by === 'mike');
  ok('  …a line taken off is not approved', !r.approved.some(k => row(k).status !== 'live'));
  ok('  …and it changes no copy', row(waitA.key).amount === '$4' && row(waitA.key).text === 'OFF Wyld multi-packs');
  ok('a second press approves nothing new', api.approveSiteDeals_({}).approved.length === 0);
}

console.log('\n3. taking over the hand-made Wix rows');
/* The live rows, as the page's server HTML held them on 2026-11-02 (ids shortened). */
const WEEK = [
  { _id: 'w-tue', title: 'Grön', day: 'TUE', daySort: 1, rowSort: 1, amount: '$2', text: 'OFF all 10-packs & full-size chocolates' },
  { _id: 'w-wed', title: 'Wyld', day: 'WED', daySort: 2, rowSort: 1, amount: '$4', text: 'OFF Wyld & Good Tide multi-packs' },
  { _id: 'w-thu1', title: 'Mule Extracts', day: 'THU', daySort: 3, rowSort: 1, amount: '$3', text: 'OFF Mule Dank Tanks, glass carts & dabs' },
  { _id: 'w-thu2', title: 'Mule Extracts', day: 'THU', daySort: 3, rowSort: 2, amount: '$1', text: 'OFF all Mule edibles' },
];
const VENDORS = [
  { _id: 'v-gron', title: 'Grön', aliases: ['Gron', 'GRON'], logo: 'wix:image://v1/gron.png', logoWide: 'wix:image://v1/gron-wide.png', menuSlug: null, vendorKey: null },
  { _id: 'v-good', title: 'Good Tide', logo: 'wix:image://v1/gt.png', vendorKey: null },
  { _id: 'v-new', title: 'Strainz', vendorKey: null },
];
const BRANDS = [{ display_name: 'Gron', aliases: ['Grön', 'GRON'] }, { display_name: 'Good Tides', aliases: ['Good Tide'] }];
{
  const plan = api.siteAdoptPlan_(WEEK, VENDORS, BRANDS, []);
  ok('weekly rows are keyed day-row, in page order: ' + plan.week.map(x => x.wix.weekKey).join(','),
     plan.week.map(x => x.wix.weekKey).join() === 'tue-1,wed-1,thu-1,thu-2');
  ok('  …each named by its own Wix _id, so GX Core stamps the SAME row', plan.week.every((x, i) => x.wix._id === WEEK[i]._id && Object.keys(x.wix).length === 2));
  const e = plan.week[0].entry;
  ok('  …and copied in exactly as Wix shows it', e.brand === 'Grön' && e.amount === '$2' && e.text === WEEK[0].text && e.day === 'TUE' && e.row === 1);
  ok('  …UN-approved', plan.week.every(x => !x.entry.approved_by));
  const vk = plan.vendors.map(x => x.wix.vendorKey).join();
  ok('brands take the registry\'s slug, matched through other spellings: ' + vk, vk === 'gron,good-tides,strainz');
  ok('  …a brand missing from the registry is adopted and named as a problem', plan.problems.some(p => /Strainz/.test(p.problem)));
  ok('  …logos and menu slug come along', plan.vendors[0].entry.logo === 'wix:image://v1/gron.png' && plan.vendors[0].entry.logo_wide === 'wix:image://v1/gron-wide.png');
  const twice = api.siteAdoptPlan_(WEEK, VENDORS, BRANDS, plan.week.map(x => x.entry).concat(plan.vendors.map(x => x.entry)));
  ok('adopting twice adopts nothing (matched by Wix _id)', !twice.week.length && !twice.vendors.length);
  const keyed = api.siteAdoptPlan_(WEEK.map(r => Object.assign({ weekKey: 'x-' + r._id }, r)), [], [], []);
  ok('a row that already has a key is not adopted again', !keyed.week.length);
  const odd = api.siteAdoptPlan_([{ _id: 'w-x', title: 'X', day: 'Someday', rowSort: 1 }], [], [], []);
  ok('a row with no readable day is reported, not guessed', !odd.week.length && /no readable day/.test(odd.problems[0].problem));
}

console.log('\n4. publishing');
/* An in-memory Wix that refuses what GX Core refuses: no approver, a field off the allowlist, a delete of
   a Vendors row. Rows are keyed, so an upsert never makes a second copy. */
let hub = '';
for (let dir = __dirname, i = 0; i < 8 && !hub; i++, dir = path.dirname(dir)) {
  const repo = path.join(dir, 'greencross-command-center'), f = path.join(repo, 'gx_wix.gs');
  if (!fs.existsSync(f)) continue;
  try { hub = require('child_process').execFileSync('git', ['-C', repo, 'show', 'origin/main:gx_wix.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { hub = ''; }
  if (!/Import1:\s*\{ key: 'weekKey'/.test(hub)) hub = fs.readFileSync(f, 'utf8');   // the merged hub predates this change: use its file
}
const allow = hub && /Import1:\s*\{ key: 'weekKey'/.test(hub)
  ? new Function(hub.match(/var GX_WIX_COLLECTIONS_ = (\{[\s\S]*?\n\});/)[0].replace('var GX_WIX_COLLECTIONS_ =', 'return'))() : null;
function makeWix() {
  const w = {
    week: WEEK.map(r => Object.assign({}, r)), vendors: VENDORS.map(r => Object.assign({}, r)), calls: [],
    read: (c) => (w.calls.push('read:' + c), (c === 'Import1' ? w.week : []).map(r => Object.assign({}, r))),
    brands: () => BRANDS,
    upsert: (c, items) => {
      w.calls.push('upsert:' + c);
      const list = c === 'Import1' ? w.week : w.vendors, key = c === 'Import1' ? 'weekKey' : 'vendorKey';
      if (items.some(it => ['sky', 'mike', 'tawny'].indexOf(it.approvedBy) < 0)) return { ok: false, refused: true, error: 'not approved' };
      if (allow && items.some(it => Object.keys(it).some(f => f !== 'approvedBy' && allow[c].fields.indexOf(f) < 0))) return { ok: false, error: 'field not allowed' };
      return { ok: true, results: items.map(it => {
        const x = Object.assign({}, it); delete x.approvedBy;
        const hit = list.find(r => r[key] === x[key]);
        if (hit) { Object.assign(hit, x); return { key: x[key], op: 'updated' }; }
        list.push(Object.assign({ _id: 'new-' + x[key] }, x)); return { key: x[key], op: 'inserted' };
      }) };
    },
    remove: (c, keys) => {
      w.calls.push('remove:' + c);
      if (c === 'Vendors') return { ok: false, error: 'never deleted' };
      w.week = w.week.filter(r => keys.indexOf(r.weekKey) < 0); return { ok: true, deleted: keys.length };
    },
  };
  return w;
}
{
  const w = makeWix();
  const plan = api.siteAdoptPlan_(WEEK, VENDORS, BRANDS, []);
  /* What GX Core's wix_adopt does: the key onto the same row. */
  plan.week.forEach(x => { w.week.find(r => r._id === x.wix._id).weekKey = x.wix.weekKey; });
  plan.vendors.forEach(x => { w.vendors.find(r => r._id === x.wix._id).vendorKey = x.wix.vendorKey; });
  const entries = plan.week.map(x => x.entry).concat(plan.vendors.map(x => x.entry));
  const before = JSON.stringify(w.week) + JSON.stringify(w.vendors);

  const idle = api.sitePublish_(w, w.vendors, true, entries);
  ok('adopted but un-approved: nothing is written or removed', !w.calls.some(c => /upsert|remove/.test(c)) && JSON.stringify(w.week) + JSON.stringify(w.vendors) === before);
  ok('  …and the dry answer says they are waiting', idle.waiting.length === 7 && !idle.send_week.length);

  const tue = Object.assign({}, entries[0], { approved_by: 'tawny' });
  const r1 = api.sitePublish_(w, w.vendors, true, [tue].concat(entries.slice(1)));
  ok('approved but unchanged: nothing is sent', r1.unchanged === 1 && !w.calls.some(c => /upsert/.test(c)));

  const tue2 = Object.assign({}, tue, { amount: '$3' });
  const dry = api.sitePublish_(w, w.vendors, false, [tue2]);
  ok('a dry run plans the update and writes nothing', dry.send_week.length === 1 && !w.calls.some(c => /upsert/.test(c)));
  const r2 = api.sitePublish_(w, w.vendors, true, [tue2]);
  const row = w.week.find(r => r._id === 'w-tue');
  ok('an approved change updates the SAME Wix row by key', !r2.failed.length && row.amount === '$3' && w.week.length === 4);
  ok('  …carrying who approved it (GX Core checks, then strips it)', r2.send_week[0].approvedBy === 'tawny');
  if (allow) {
    const extra = (items, c) => [].concat.apply([], items.map(Object.keys)).filter(k => k !== 'approvedBy' && allow[c].fields.indexOf(k) < 0);
    ok('every weekly field sent is on the connector\'s allowlist', !extra(r2.send_week, 'Import1').length);
  } else console.log('  · (hub with Import1 writes not checked out beside this repo; allowlist check skipped)');

  const freeLine = Object.assign({}, tue, { text: 'Free pre-roll', amount: '$2' });
  const r3 = api.sitePublish_(w, w.vendors, true, [freeLine]);
  ok('an approved line whose copy breaks a rule is not sent, and says why', !r3.send_week.length && /OLCC/.test(r3.problems[0].problem));

  const gron = Object.assign({}, entries.find(e => e.key === 'gron'), { approved_by: 'sky', menu_slug: 'gron', logo: '' });
  const r4 = api.sitePublish_(w, w.vendors, true, [gron]);
  const v = w.vendors.find(x => x._id === 'v-gron');
  ok('an approved brand updates its Vendors row by key, same _id', !r4.failed.length && v.menuSlug === 'gron' && w.vendors.length === 3);
  ok('  …with its other spellings from GX Core\'s brand list', JSON.stringify(v.aliases) === '["Grön","GRON"]');
  ok('  …and a blank logo is not sent (the logo stays)', !('logo' in r4.send_vendors[0]) && v.logo === 'wix:image://v1/gron.png');
  if (allow) ok('every Vendors field sent is on the connector\'s allowlist', ![].concat.apply([], r4.send_vendors.map(Object.keys)).some(k => k !== 'approvedBy' && allow.Vendors.fields.indexOf(k) < 0));

  const bob = { key: 'bobsled', kind: 'vendor', brand: 'Bobsled', logo: 'wix:image://v1/bob.png', status: 'live', approved_by: 'sky' };
  api.sitePublish_(w, w.vendors, true, [bob]);
  ok('a new approved brand is inserted', w.vendors.some(x => x.vendorKey === 'bobsled'));

  const gone = Object.assign({}, entries.find(e => e.key === 'thu-2'), { status: 'removed' });
  const r5 = api.sitePublish_(w, w.vendors, true, [gone]);
  ok('a line taken off in SPIFF comes off Wix', r5.remove_week.join() === 'thu-2' && !w.week.some(r => r.weekKey === 'thu-2'));
  const hand = { _id: 'w-hand', title: 'Verdant Leaf', day: 'SAT', daySort: 5, rowSort: 1, amount: '$2', text: 'OFF carts' };
  w.week.push(hand);
  api.sitePublish_(w, w.vendors, true, []);
  ok('a Wix row with no key is never touched', w.week.some(r => r._id === 'w-hand'));
  ok('  …and counted as hand-made in the plan', api.sitePublish_(w, w.vendors, false, []).hand_made === 1);
  const many = Array.from({ length: 11 }, (_, i) => ({ key: 'k' + i, kind: 'week', status: 'removed' }));
  many.forEach(m => w.week.push({ _id: 'x' + m.key, weekKey: m.key }));
  const r6 = api.sitePublish_(w, w.vendors, true, many);
  ok('more than 10 weekly removals in one run is refused', /limit 10/.test(r6.refused) && w.week.filter(r => /^xk/.test(r._id)).length === 11);
}

console.log('\n5. it is wired, and it is not a pay path');
{
  const gs = G.GS;
  ok('the publisher runs the weekly lines and brands inside wixPublish_, in their own try', /function wixPublish_[\s\S]*?var site = function \(doIt\) \{\s*try \{\s*out\.site = sitePublish_/.test(gs));
  ok('  …both in the dry run and after the card writes', /if \(!apply\) \{ site\(false\);/.test(gs) && /\n  site\(true\);/.test(gs));
  ok('SPIFF is pinned to a GX Core that writes Weekly Deals and Vendors (v366+)',
     Number(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8')).dependencies.libraries[0].version) >= 366);
  ok('adoptSite is a secret-only route', /var SECRET_ACTIONS = \[[^\]]*'adoptSite'/.test(gs));
  /* G.grab throws on a name that is not there, so a renamed payer fails this rather than passing it. */
  const payers = ['spiffProgress_', 'publishToCore_', 'refreshProgressPlan_', 'recordMeasuredActuals_', 'rollProgramStatuses_', 'storeView_', 'giftCardList_'];
  const reads = payers.filter(n => /readSite_|SITE_TAB|site_deals|siteSheet_/.test(G.grab(n)));
  ok('nothing that pays, publishes to Core or feeds a kiosk reads the site_deals tab', !reads.length);
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const hedged = (js.match(/ENGINE_HEDGE_READS\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  ok('no Deals page route is hedged (a hedged write runs twice)', !/siteDeals|saveSiteDeal|removeSiteDeal|approveSiteDeals|siteMedia|siteImportLogo/.test(hedged));
  ok('the Approve all route is wired and is not a secret-only route (it needs a signed-in approver)',
     /case 'approveSiteDeals':\s*out = approveSiteDeals_\(p\)/.test(gs) && !/var SECRET_ACTIONS = \[[^\]]*'approveSiteDeals'/.test(gs));
}

console.log('\n6. the screen judges a line the way the engine does');
{
  /* site.js and marketing.js RUN here (no DOM needed for these): the screen's check must agree with the
     engine's, or the screen says "goes up next hour" about a line the engine will not send. */
  const vm = require('vm');
  const sb = { document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) }, console };
  sb.window = sb;                       // as in a browser: marketing.js registers on `this`, site.js reads `window`
  const win = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site.js'), 'utf8'), sb);
  const SITE = win.SpiffSite;
  const base = { kind: 'week', day: 'TUE', row: 1, brand: 'Grön', amount: '$2', text: 'OFF all 10-packs' };
  const cases = [{}, { amount: '15%' }, { amount: '$2.50' }, { amount: '2 for $20' }, { amount: '' }, { day: 'XYZ' }, { brand: '' }, { text: '' },
                 { text: 'Free pre-roll' }, { text: 'BOGO' }, { text: 'carts — today' }, { text: 'our best carts' },
                 { text: 'OFF Mule Dank Tanks, glass carts & dabs' }, { text: 'OFF Mule Dank Tanks, glass carts, dabs & more' },
                 { brand: 'x'.repeat(30) }, { brand: 'x'.repeat(31) },
                 { kind: 'vendor', brand: 'Bobsled', logo: 'wix:image://v1/a/b.png' }, { kind: 'vendor', brand: 'Bobsled', logo: 'https://x/y.png' }, { kind: 'vendor', brand: '' }];
  const disagree = cases.filter(c => { const s = Object.assign({}, base, c); return !!SITE.problemOf(s) !== !!api.siteProblem_(s); });
  ok('screen and engine agree on all ' + cases.length + ' lines (good and bad)' + (disagree.length ? ': not on ' + JSON.stringify(disagree) : ''), !disagree.length);
  ok('the screen shows a Wix Media logo as its static URL', SITE.wixSrc('wix:image://v1/a56cce_x~mv2.png/gron-logo.png#originWidth=600') === 'https://static.wixstatic.com/media/a56cce_x~mv2.png');
  ok('the screen\'s days are the engine\'s', JSON.stringify(SITE.DAYS) === JSON.stringify(G.grabVar('SITE_DAYS_')));
  /* Character limits (Sky, 2026-11-03): the longest live weekly line (39) fits, one past 40 does not. */
  const at40 = Object.assign({}, base, { text: 'x'.repeat(40) }), at41 = Object.assign({}, base, { text: 'x'.repeat(41) });
  ok('a 40-character weekly line passes on both sides', !SITE.problemOf(at40) && !api.siteProblem_(at40));
  ok('a 41-character weekly line is refused on both sides, and says how long', /41 characters; the most is 40/.test(SITE.problemOf(at41)) && /41 characters; the most is 40/.test(api.siteProblem_(at41)));
  /* SOURCE-SHAPED (markup and load order cannot run here). */
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('the Programs view switch has a Deals page button', /data-mk-view="site"/.test(index));
  ok('site.js loads after marketing.js and before spiff.js', /marketing\.js\?v=[^"]+"><\/script>\s*<script src="site\.js\?v=[^"]+"><\/script>\s*<script src="spiff\.js/.test(index));
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  ok('spiff.js draws the view only behind the marketing switch', /var on = mkOn\(\), view = on \? mkView\.view : 'list';[\s\S]*?view === 'site' && window\.SpiffSite/.test(js));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
