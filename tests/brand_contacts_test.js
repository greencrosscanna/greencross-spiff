#!/usr/bin/env node
/* ─── Brand reps live in GX Core, and they are who can open a proposal ───────────────────────────
 *
 *   RUN:  node tests/brand_contacts_test.js
 *
 * WHY
 * Sky, 2026-09-14: "we only have a few dozen vendors, is it better to bake their profiles in?"
 * Contacts moved off each program into GX Core's shared brand registry (library v330). Sky chose
 * the rules this pins:
 *  - keyed by BRAND, not by vendor/distributor;
 *  - ANY active rep on an ACTIVE brand can open that brand's shared proposals — so removing a rep,
 *    or turning a brand off, closes every link at once;
 *  - reps are edited from SPIFF's program screen, with Core as the only writer.
 *
 * The sign-in is the part that matters. Before this, clientView_ matched one contact_email typed
 * onto the program. A regression back to that — or a gate that forgets `active` — would let a
 * removed rep keep opening a vendor proposal, and nothing on any screen would say so.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── the vendor sign-in, run for real against a stubbed Core ── */
console.log('vendor sign-in');
const DENY = /does not match an active proposal/;

function portal(opts) {
  const programs = opts.programs;
  const brands = opts.brands;
  const cacheStore = {};
  const GXCore = {
    resolveBrand(name) {
      if (opts.coreDown) throw new Error('Service unavailable');
      const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return brands.filter(b => [b.brand_id, b.display_name].concat(b.aliases || [])
        .map(x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')).indexOf(k) >= 0)[0] || null;
    },
    getBrands() {
      if (opts.coreDown) throw new Error('Service unavailable');
      return brands.filter(b => b.active);
    },
  };
  const f = new Function('GXCore', 'CacheService', 'PropertiesService', 'listProgramsCached_',
    'gxStores_', 'progressRowsFor_', 'listPrograms_', 'textDate_',
    [grab(gs, 'norm_'), grab(gs, 'parseJson_'), grab(gs, 'brandNameOf_'), grab(gs, 'brandFold_'),
     grab(gs, 'brandFoldedNames_'), 'var CLIENT_PASS_PROP = "CLIENT_VIEW_PASSWORD";',
     grab(gs, 'clientView_'), 'return clientView_;'].join('\n'));
  return f(GXCore,
    { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
    { getScriptProperties: () => ({ getProperty: () => 'pw' }) },
    () => programs, () => [], () => [], () => [], x => x);
}

const PROG = { program_id: 'mule-1', program_name: 'Mule Dank Tank', vendor: 'Mule Extracts',
               match_json: { brand: 'Mule Extracts' }, share_token: 'tok1', status: 'active',
               target_json: {}, baseline_json: {}, cost_json: {}, payout_json: {},
               // A stale legacy contact on the row must open NOTHING any more.
               contact_email: 'old@legacy.com' };
const rep = (email, over) => Object.assign({ contact_id: 'bc_' + email, email, name: 'Rep ' + email, active: true }, over || {});
const MULE = { brand_id: 'mule-extracts', display_name: 'Mule Extracts', aliases: [], active: true,
               contacts: [rep('amy@mule.com')] };

let cv = portal({ programs: [PROG], brands: [MULE] })({ t: 'tok1', email: 'Amy@Mule.com', pass: 'pw' });
ok('an active rep on the program\'s brand opens the link (email case-blind)', cv.ok === true && cv.program);
ok('  …and the page is prepared for the rep who signed in', cv.ok && cv.program.contact_name === 'Rep amy@mule.com');

cv = portal({ programs: [PROG], brands: [MULE] })({ t: 'tok1', email: 'old@legacy.com', pass: 'pw' });
ok('the program\'s old contact_email no longer opens anything', !cv.ok && DENY.test(cv.error));

cv = portal({ programs: [PROG], brands: [MULE] })({ t: 'tok1', email: 'amy@mule.com', pass: 'wrong' });
ok('a wrong password is still refused', !cv.ok && DENY.test(cv.error));

const removed = Object.assign({}, MULE, { contacts: [rep('amy@mule.com', { active: false })] });
cv = portal({ programs: [PROG], brands: [removed] })({ t: 'tok1', email: 'amy@mule.com', pass: 'pw' });
ok('a REMOVED rep is refused even if Core hands the row back', !cv.ok && DENY.test(cv.error));

const off = Object.assign({}, MULE, { active: false });
cv = portal({ programs: [PROG], brands: [off] })({ t: 'tok1', email: 'amy@mule.com', pass: 'pw' });
ok('a rep on a TURNED-OFF brand is refused', !cv.ok && DENY.test(cv.error));

const OTHER = { brand_id: 'freshy', display_name: 'Freshy', aliases: [], active: true, contacts: [rep('bo@freshy.com')] };
cv = portal({ programs: [PROG], brands: [MULE, OTHER] })({ t: 'tok1', email: 'bo@freshy.com', pass: 'pw' });
ok('a rep on a DIFFERENT brand cannot open this brand\'s link', !cv.ok && DENY.test(cv.error));

cv = portal({ programs: [PROG], brands: [MULE], coreDown: true })({ t: 'tok1', email: 'amy@mule.com', pass: 'pw' });
ok('a Core outage says unavailable, not "wrong password"', !cv.ok && /unavailable/.test(cv.error) && !DENY.test(cv.error));
ok('  …and names no rep while saying it', !cv.ok && !/amy/.test(cv.error));

const PROG2 = Object.assign({}, PROG, { program_id: 'mule-2', program_name: 'Mule Carts', share_token: 'tok2',
                                        vendor: 'MULE EXTRACTS.', match_json: { brand: 'MULE EXTRACTS.' } });
cv = portal({ programs: [PROG, PROG2], brands: [MULE] })({ email: 'amy@mule.com', pass: 'pw' });
ok('with no link, a rep on two shared programs is offered both (spelling folded)',
   cv.ok && Array.isArray(cv.choices) && cv.choices.length === 2);
cv = portal({ programs: [PROG], brands: [MULE, OTHER] })({ email: 'bo@freshy.com', pass: 'pw' });
ok('  …and a rep whose brand has no shared program is refused', !cv.ok && DENY.test(cv.error));

/* ── the program no longer carries its own contact list ── */
console.log('program record');
/* Found in the browser: SPIFF already had a `loadBrands` (the product picker's), and a second function
   declaration of the same name in one scope silently REPLACES the first. The rep section sat on
   "Loading" forever while every test passed. Each name below must be declared exactly once. */
['loadBrandReps', 'brandNameOf', 'brandFold', 'brandOf', 'activeReps', 'needsRep', 'primaryRep',
 'renderBrandReps', 'repRow', 'repMsg', 'brandCall', 'saveRep', 'removeRep', 'restoreRep', 'addBrandFor', 'loadBrands']
  .forEach(function (n) {
    ok('spiff.js declares ' + n + ' exactly once', (js.match(new RegExp('function ' + n + '\\s*\\(', 'g')) || []).length === 1);
  });
ok('boot loads the brand REGISTRY, not the product picker\'s brand list', /var brandsP\s*=\s*loadBrandReps\(\)/.test(js));
const editable = gs.slice(gs.indexOf('var EDITABLE_FIELDS'), gs.indexOf('];', gs.indexOf('var EDITABLE_FIELDS')));
ok('contact_name and contact_email are no longer editable on a program',
   !/'contact_name'|'contact_email'/.test(editable.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('the record screen has no contact_email input left', !/data-key="contact_/.test(js) && !/'contact_email', p\.contact_email/.test(js));
ok('the list and the record warn from the brand\'s reps, not from contact_email',
   /needsRep\(p\)/.test(grab(js, 'shareCell')) && /needsRep\(p\)/.test(grab(js, 'rowShare')));

/* ── the write doors ── */
console.log('writes');
function saveWith(role, contact) {
  let sent = null;
  const f = new Function('GXCore', 'gxAuth_', 'scrubSecrets_',
    ['var EDIT_ROLES = ["admin", "editor", "director"];', 'function brandsChanged_(r) { return r; }', grab(gs, 'parseJson_'),
     gs.match(/^var BRAND_CONTACT_FIELDS = .*$/m)[0], grab(gs, 'brandEditor_'), grab(gs, 'saveBrandContact_'),
     'return saveBrandContact_;'].join('\n'));
  const r = f({ gxUpsertBrandContact(p) { sent = p; return { ok: true }; } },
              () => ({ ok: true, role, user: 'tawny' }), x => String(x))({ token: 't', contact: JSON.stringify(contact) });
  return { r, sent };
}
let w = saveWith('editor', { brand_id: 'mule-extracts', email: 'a@b.co', name: 'A', updated_by: 'forged', evil: 1 });
ok('an editor\'s save reaches Core stamped with who made it', w.r.ok && w.sent.by === 'tawny');
ok('  …and only the contract\'s fields ride along', w.sent && !('evil' in w.sent) && !('updated_by' in w.sent));
w = saveWith('viewer', { brand_id: 'mule-extracts', email: 'a@b.co' });
ok('a viewer cannot change a brand\'s reps', !w.r.ok && w.sent === null);
['addBrand_', 'saveBrandContact_', 'removeBrandContact_'].forEach(function (fn) {
  ok(fn + ' clears the screen\'s brand cache after a write', /brandsChanged_\(GXCore\./.test(grab(gs, fn)));
});
ok('the vendor sign-in never reads the cached brand list — a removed rep is locked out at once',
   !/BRANDS_CACHE_KEY|brandsRead_/.test(grab(gs, 'clientView_')));

/* Blank means "leave it alone" to Core, so an emptied box has to be sent as an explicit clear. */
const saveRep = new Function('brandCall', grab(js, 'repMsg') + grab(js, 'saveRep') + 'return saveRep;');
function runSave(c, values) {
  let call = null;
  const row = { querySelectorAll: () => Object.keys(values).map(k => ({ dataset: { repF: k },
                  type: k === 'is_primary' ? 'checkbox' : 'text', checked: values[k], value: values[k] })),
                querySelector: () => null };
  saveRep((a, params) => { call = { a, contact: JSON.parse(params.contact) }; })(
    { brand_id: 'mule-extracts' }, c, row, {});
  return call;
}
let call = runSave({ contact_id: 'bc_1', email: 'a@b.co', name: 'Amy', phone: '555', role: 'Rep', is_primary: false },
                   { name: 'Amy', email: 'a@b.co', phone: '', role: 'Rep', is_primary: false });
ok('emptying a rep\'s phone sends clear=phone', call && call.contact.clear === 'phone');
ok('  …and resends nothing that did not change', call && !('name' in call.contact) && !('email' in call.contact));
call = runSave({ contact_id: 'bc_1', email: 'a@b.co', name: 'Amy' }, { name: 'Amy', email: 'new@b.co', phone: '', role: '', is_primary: false });
ok('a changed email is sent, on the same contact_id', call && call.contact.email === 'new@b.co' && call.contact.contact_id === 'bc_1');
call = runSave({ contact_id: 'bc_1', email: 'a@b.co' }, { name: '', email: '', phone: '', role: '', is_primary: false });
ok('an emptied email is refused on the screen, never sent', call === null);

/* ── the Settings directory ── */
console.log('settings directory');
ok('Settings holds the brand directory above the kiosk links',
   /id="brandDir"[\s\S]*id="kioskBody"/.test(fs.readFileSync(__dirname + '/../index.html', 'utf8')));
ok('the program screen and the directory share ONE reps editor',
   /repsEditor\(host, b\)/.test(grab(js, 'renderBrandReps')) && /repsEditor\(/.test(grab(js, 'paintBrandBody')));
ok('a load repaints the directory', /renderBrandDirectory\(\)/.test(grab(js, 'repaintBrands')) && /repaintBrands\(\)/.test(grab(js, 'loadBrandReps')));

/* ── a save is quick and says so (Sky, 2026-09-15: "once i click to add it takes a while to load") ──
   Every save used to re-read the WHOLE brand list from Core (6–30s) before anything changed on screen. */
const bc = grab(js, 'brandCall');
ok('a save says something the moment it is pressed', /repMsg\(row, pending \|\| 'Saving…', true, true\)/.test(bc));
ok('  …and folds Core\'s own answer into the screen instead of re-reading every brand',
   /applyBrandWrite\(state\.brands, r\)/.test(bc) && !/await loadBrandReps\(\)/.test(bc));
ok('adding a brand names what it is adding while it waits', /Adding ' \+ r\.name/.test(grab(js, 'wireBrandFind')));
const applyJs = new Function(grab(js, 'applyBrandWrite') + 'return applyBrandWrite;')();
const applyGs = new Function(grab(gs, 'applyBrandWrite_') + 'return applyBrandWrite_;')();
const base = () => [
  { brand_id: 'mule', display_name: 'Mule', contacts: [
      { contact_id: 'c1', name: 'Zed', email: 'z@m.co', is_primary: true, active: true },
      { contact_id: 'c2', name: 'Amy', email: 'a@m.co', is_primary: false, active: true }] },
  { brand_id: 'wyld', display_name: 'Wyld', contacts: [] }];
const WRITES = [
  { ok: true, brand: { brand_id: 'drops', display_name: 'Drops', contacts: [] } },
  { ok: true, brand_id: 'mule', contact: { contact_id: 'c2', brand_id: 'mule', name: 'Amy', email: 'a@m.co', is_primary: true, active: true }, demoted: ['c1'] },
  { ok: true, brand_id: 'wyld', contact: { contact_id: 'c9', brand_id: 'wyld', name: 'Bo', email: 'b@w.co', is_primary: false, active: true }, demoted: [] },
  { ok: false, brand: { brand_id: 'nope', display_name: 'Nope' } },
];
let a = base(); WRITES.forEach(w => { a = applyJs(a, w); });
ok('an added brand appears, in name order', a.map(b => b.brand_id).join() === 'drops,mule,wyld');
ok('a new main contact goes first and the old one is demoted',
   a[1].contacts[0].contact_id === 'c2' && a[1].contacts[1].is_primary === false);
ok('a new rep lands on the right brand', a[2].contacts.length === 1 && a[2].contacts[0].email === 'b@w.co');
ok('a refused write changes nothing', !a.some(b => b.brand_id === 'nope'));
let g = base(); WRITES.forEach(w => { g = applyGs(g, w); });
ok('the engine\'s cache patch and the screen agree exactly', JSON.stringify(g) === JSON.stringify(a));
ok('SPIFF\'s writes patch the cached list rather than clearing it', /applyBrandWrite_\(JSON\.parse\(hit\), r\)/.test(grab(gs, 'brandsChanged_')));
ok('the hourly trigger keeps the brand list warm', /warmBrandsCache_\(\)/.test(grab(gs, 'refreshSpiffProgressTrigger')));

/* Sky, 2026-09-15: "keep the size of the popup window the same … its very disjointing to see the window
   size change as you type". */
ok('the Settings dialog is a fixed size, not sized to what the search has left',
   /class="modal modal-fixed"[^>]*aria-labelledby="settingsTitle"/.test(fs.readFileSync(__dirname + '/../index.html', 'utf8'))
   && /\.modal\.modal-fixed \{[^}]*height:/.test(fs.readFileSync(__dirname + '/../spiff.css', 'utf8')));
const saveInfo = new Function('brandCall', grab(js, 'repMsg') + grab(js, 'saveBrandInfo') + 'return saveBrandInfo;');
function runInfo(b, v) {
  let call = null;
  const row = { querySelectorAll: () => Object.keys(v).map(k => ({ dataset: { brandF: k }, value: v[k] })), querySelector: () => null };
  saveInfo((a, params) => { call = { a, brand: JSON.parse(params.brand) }; })(b, row, {});
  return call;
}
let info = runInfo({ brand_id: 'ncc', website: 'ncc.com', notes: 'x', aliases: ['NCC'] }, { website: '', notes: 'x', aliases: 'NCC, National Cannabis' });
ok('emptying a brand\'s website sends clear=website', info && info.brand.clear === 'website');
ok('  …and a new spelling is sent as the full list', info && info.brand.aliases.join('|') === 'NCC|National Cannabis');
ok('  …and unchanged notes are not resent', info && !('notes' in info.brand));
info = runInfo({ brand_id: 'ncc', website: '', notes: '', aliases: ['NCC'] }, { website: '', notes: '', aliases: '' });
ok('removing every spelling clears aliases', info && info.brand.clear === 'aliases' && !('aliases' in info.brand));
function saveBrandWith(brand) {
  let sent = null;
  const f = new Function('GXCore', 'gxAuth_', 'scrubSecrets_',
    ['var EDIT_ROLES = ["admin", "editor", "director"];', 'function brandsChanged_(r) { return r; }', grab(gs, 'parseJson_'),
     gs.match(/^var BRAND_FIELDS = .*$/m)[0], grab(gs, 'brandEditor_'), grab(gs, 'saveBrand_'), 'return saveBrand_;'].join('\n'));
  const r = f({ gxUpsertBrand(p) { sent = p; return { ok: true }; } }, () => ({ ok: true, role: 'editor', user: 'tawny' }), String)
    ({ token: 't', brand: JSON.stringify(brand) });
  return { r, sent };
}
let sb = saveBrandWith({ brand_id: 'ncc', website: 'w', display_name: 'Renamed', active: false, create: 1 });
ok('saveBrand never renames, switches off or creates a brand from Settings',
   sb.sent && !('display_name' in sb.sent) && !('active' in sb.sent) && !('create' in sb.sent) && sb.sent.by === 'tawny');

/* ── find-or-add, as you type ── */
console.log('find or add');
const suggest = new Function(grab(js, 'brandFold') + grab(js, 'brandSuggestions') + 'return brandSuggestions;')();
const REG = [
  { brand_id: 'national-cannabis-co', display_name: 'National Cannabis Co.', aliases: ['National Cannabis Co'], active: true,
    contacts: [{ name: 'Amy Chen', email: 'amy@ncc.com', active: true }, { name: 'Gone Guy', email: 'gone@ncc.com', active: false }] },
  { brand_id: 'mule-extracts', display_name: 'Mule Extracts', aliases: [], active: true, contacts: [] },
];
const DUTCHIE = [{ name: 'National Cannabis Co', count: 40 }, { name: 'Mule Extracts', count: 12 },
                 { name: 'Muletown Farms', count: 7 }, { name: 'Wyld', count: 90 }];
let sg = suggest('mul', REG, DUTCHIE, true);
ok('a brand already in the list is offered first, with its rep count',
   sg[0].kind === 'brand' && sg[0].id === 'mule-extracts' && /no reps/.test(sg[0].sub));
ok('  …and an in-stock Dutchie brand not in the list is offered to add, in Dutchie\'s spelling',
   sg.some(r => r.kind === 'dutchie' && r.name === 'Muletown Farms'));
ok('  …but never a Dutchie brand the list already has', !sg.some(r => r.kind === 'dutchie' && r.name === 'Mule Extracts'));
sg = suggest('national cannabis', REG, DUTCHIE, true);
ok('a Dutchie spelling that folds to a registered brand is not offered as a second brand',
   !sg.some(r => r.kind === 'dutchie' || r.kind === 'new'));
sg = suggest('amy', REG, DUTCHIE, true);
ok('a rep is found by name, and leads to their brand', sg.some(r => r.kind === 'rep' && r.id === 'national-cannabis-co'));
ok('  …but a removed rep is not', !suggest('gone', REG, DUTCHIE, true).some(r => r.kind === 'rep'));
sg = suggest('Brand New Co', REG, DUTCHIE, true);
ok('a name Dutchie does not carry can still be added, and says to check the spelling',
   sg.length === 1 && sg[0].kind === 'new' && /spelling/.test(sg[0].sub));
ok('  …but not while Dutchie\'s list is still loading, when "not in Dutchie" would be a guess',
   !suggest('Brand New Co', REG, null, true).length);
ok('a viewer is never offered an add', !suggest('mul', REG, DUTCHIE, false).some(r => r.kind === 'dutchie' || r.kind === 'new')
   && !suggest('Brand New Co', REG, DUTCHIE, false).length);
ok('a two-letter query does not match across word breaks', !suggest('na', REG, [{ name: 'Benson Arbor', count: 3 }], true).some(r => r.name === 'Benson Arbor'));
ok('  …but a longer punctuation-blind query still finds its brand', suggest('national cannabis co', [], [{ name: 'National Cannabis Co.', count: 3 }], true).some(r => r.kind === 'dutchie'));
ok('an empty box suggests nothing', suggest('  ', REG, DUTCHIE, true).length === 0);
ok('adding from the menu goes through the same addBrand door', /brandCall\('addBrand'/.test(grab(js, 'wireBrandFind')));
ok('the Dutchie list is the Calculator picker\'s cache, not a second fetch',
   /pick\.brands/.test(grab(js, 'wireBrandFind')) && /loadBrands\(\)/.test(grab(js, 'wireBrandFind')));

/* ── the one-time seed ── */
console.log('seed');
function seed(programs, existing, apply) {
  const made = [];
  const f = new Function('PropertiesService', 'GXCore', 'listPrograms_', 'scrubSecrets_', 'GX_SECRET_PROP',
    ['function brandsChanged_(r) { return r; }', grab(gs, 'parseJson_'), grab(gs, 'brandNameOf_'), grab(gs, 'brandFold_'), grab(gs, 'seedBrands_'), 'return seedBrands_;'].join('\n'));
  const r = f({ getScriptProperties: () => ({ getProperty: () => 's' }) },
    { resolveBrand: n => existing.indexOf(n) >= 0 ? { brand_id: 'x', display_name: n } : null,
      gxUpsertBrand: p => { made.push(p); return { ok: true, brand_id: p.brand_id, created: true }; } },
    () => programs, x => String(x), 'GX_DEPLOY_SECRET')({ secret: 's', apply: apply ? '1' : '' });
  return { r, made };
}
const P = (brand, start) => ({ vendor: brand, match_json: { brand }, start_date: start });
let sd = seed([P('National Cannabis Co.', '2025-01-01'), P('National Cannabis Co', '2025-06-01'),
               P('National Cannabis Co', '2025-03-01'), P('Freshy', '2025-02-01')], [], false);
ok('the seed is dry unless apply=1', sd.r.dry === true && sd.made.length === 0);
ok('  …and plans ONE brand per folded name', sd.r.count === 2);
const ncc = sd.r.brands.filter(b => /national/.test(b.brand_id))[0];
ok('  …named by the spelling most programs use, the other kept as an alias',
   ncc && ncc.display_name === 'National Cannabis Co' && ncc.aliases.join() === 'National Cannabis Co.');
sd = seed([P('Freshy', '2025-02-01'), P('Drops', '2025-02-01')], ['Freshy'], true);
ok('a brand Core already has is skipped, never patched', sd.made.length === 1 && sd.made[0].display_name === 'Drops');
ok('  …and every write passes an explicit brand_id, so a re-run cannot mint a duplicate',
   sd.made.every(p => p.brand_id && p.create === 1));
ok('seedBrands is secret-gated at the router', /'publishKioskTokens', 'seedBrands'\]/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
