#!/usr/bin/env node
/* ─── How many shirts and hats to order for staff ─────────────────────────────────────────────────
 *
 *   RUN:  node tests/swag_sizes_test.js
 *
 * Sky, 2026-11-04: the Staff swag card shows the sizes needed ("6 M, 10 L") so swag can be ordered
 * without asking everyone. GX Crew owns shirt_size and publishes COUNTS per store to GX Core
 * (GXCore.publishedCrewSwagSizes, requested from core-admin and crew 2026-11-04); SPIFF reads Core.
 *
 * WHAT RUNS: marketing.js's swagLine / swagTotals / swagSizesHtml and the section card, and the
 * engine's swagSizes_ / swagSizesClean_ lifted from Code.gs with GX Core, auth and the cache stubbed.
 * SOURCE-SHAPED: the router case, and that no vendor-facing page calls the route, are wiring and
 * absence claims, checked by reading the source.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./_gas');
const MK = require('../marketing.js');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const SIZES = {
  sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  by_store: {
    bend:   { shirt: { L: 4, M: 2, XL: 1 }, hat: {}, not_set: 1, active: 8 },
    redmond:{ shirt: { M: 4, L: 6 }, hat: {}, not_set: 0, active: 10 },
    salem:  { shirt: { S: 3 }, hat: {}, not_set: 2, active: 5 }
  },
  total: {}, as_of: '2026-11-04', age_minutes: 30
};

/* ── 1. the line ────────────────────────────────────────────────────────────────────────────────── */
console.log('1. the size line');
ok('Sky\'s example, in size order', MK.swagLine({ L: 10, M: 6 }) === '6 M, 10 L');
ok('XS before S before 2XL', MK.swagLine({ '2XL': 1, S: 2, XS: 3 }) === '3 XS, 2 S, 1 2XL');
ok('zeros are left out', MK.swagLine({ M: 0, L: 2 }) === '2 L');
ok('nothing is an empty line', MK.swagLine({}) === '');

/* ── 2. only the program's stores are added up ──────────────────────────────────────────────────── */
console.log('2. totals');
const t = MK.swagTotals(SIZES, ['bend', 'redmond']);
ok('two stores: 6 M, 10 L, 1 XL', MK.swagLine(t.shirt) === '6 M, 10 L, 1 XL');
ok('a store not in the program is not counted', !t.shirt.S);
ok('not-set and active add up', t.not_set === 1 && t.active === 18);
ok('a store Crew has nobody at is skipped', MK.swagTotals(SIZES, ['nowhere']).stores.length === 0);

/* ── 3. the card ────────────────────────────────────────────────────────────────────────────────── */
console.log('3. the card');
const ctx = { storeName: s => ({ bend: 'Bend', redmond: 'Redmond' })[s] || s };
let h = MK.swagSizesHtml({ connected: true, sizes: SIZES }, ['bend', 'redmond'], ctx);
ok('shows the shirt total', h.indexOf('Shirts 6 M, 10 L, 1 XL') > 0);
ok('names who has no size yet', /1 of 18 staff have no size in Crew yet/.test(h));
ok('per-store lines when more than one store', h.indexOf('Bend: 2 M, 4 L, 1 XL') > 0 && h.indexOf('Redmond: 4 M, 6 L') > 0);
ok('one store: no per-store list', MK.swagSizesHtml({ connected: true, sizes: SIZES }, ['bend'], ctx).indexOf('<ul') < 0);
ok('loading says so', /Loading/.test(MK.swagSizesHtml(undefined, ['bend'], ctx)));
ok('before Core/Crew publish: "not connected", never a zero count', /not connected to Crew yet/.test(MK.swagSizesHtml({ connected: false }, ['bend'], ctx)));
ok('stale data says how old', /3 days ago/.test(MK.swagSizesHtml({ connected: true, sizes: Object.assign({}, SIZES, { age_minutes: 4400 }) }, ['bend'], ctx)));
ok('hats shown when Crew sends them', /Hats 2 ONE SIZE/.test(MK.swagSizesHtml({ connected: true,
  sizes: { by_store: { bend: { shirt: { M: 1 }, hat: { 'ONE SIZE': 2 } } } } }, ['bend'], ctx)));

const program = { program_id: 'x', vendor: 'Grön', start_date: '2026-11-16', end_date: '2026-11-29',
  marketing_json: { v: 1, sel: { shirts: true }, d: {} } };
const stores = [{ store_id: 'bend', name: 'Bend' }, { store_id: 'redmond', name: 'Redmond' }];
const card = MK.sectionHtml(program, { today: '2026-11-03', canEdit: true, engineReady: true, stores, storeName: ctx.storeName,
  swagSizes: { connected: true, sizes: SIZES } });
ok('the Staff swag card carries the sizes', card.indexOf('Sizes needed') > 0 && card.indexOf('6 M, 10 L') > 0);
const noShirts = MK.sectionHtml(Object.assign({}, program, { marketing_json: { v: 1, sel: { email: true }, d: {} } }),
  { today: '2026-11-03', canEdit: true, engineReady: true, stores, storeName: ctx.storeName, swagSizes: { connected: true, sizes: SIZES } });
ok('a plan without staff swag shows no sizes', noShirts.indexOf('Sizes needed') < 0);

/* ── 4. the engine ──────────────────────────────────────────────────────────────────────────────── */
console.log('4. the engine');
function engine(core, signedIn) {
  const store = {};
  const cache = { get: k => store[k] || null, put: (k, v) => { store[k] = v; } };
  const P = G.makeProps({ GX_DEPLOY_SECRET: 's3cret' });
  const api = G.load({
    real: ['swagSizes_', 'swagSizesClean_', 'swagGroup_', 'swagCounts_', 'swagWhole_'],
    vars: ['SWAG_SIZES_CACHE_KEY_'],
    stubs: { gxAuth_: () => signedIn === false ? { ok: false, error: 'Not signed in' } : { ok: true, user: 'tawny', role: 'editor' } },
    globals: { PropertiesService: P.PropertiesService, CacheService: { getScriptCache: () => cache }, GXCore: core }
  });
  return api;
}
let r = engine({}).swagSizes_({ token: 't' });
ok('an older GXCore without the route: connected false, no error', r.ok && r.connected === false && r.sizes === null);

let seenSecret = '';
const leaky = { ok: true, age_minutes: 12, published_at: 'x', payload: JSON.stringify({
  as_of: '2026-11-04', sizes: ['M', 'L', 'Jane'],
  by_store: { bend: { shirt: { M: 6, L: 10, 'jane doe': 1 }, names: ['Jane Doe'], not_set: 1, active: 17 }, 'Bad Store!': { shirt: { M: 1 } } },
  total: { shirt: { M: 6, L: 10 }, not_set: 1, active: 17 }, people: [{ name: 'Jane Doe', shirt_size: 'M' }] }) };
r = engine({ publishedCrewSwagSizes: s => { seenSecret = s; return leaky; } }).swagSizes_({ token: 't' });
ok('reads Core with the deploy secret', seenSecret === 's3cret');
ok('counts come through', r.ok && r.connected && r.sizes.by_store.bend.shirt.M === 6 && r.sizes.by_store.bend.shirt.L === 10);
const wire = JSON.stringify(r);
ok('nothing but counts is relayed (no names, no people list)', wire.indexOf('Jane') < 0 && wire.indexOf('people') < 0 && wire.indexOf('names') < 0);
ok('a malformed store id is dropped', !r.sizes.by_store['Bad Store!']);
ok('age is passed on for the stale check', r.sizes.age_minutes === 12);

r = engine({ publishedCrewSwagSizes: () => leaky }, false).swagSizes_({ token: '' });
ok('signed out: refused', !r.ok && r.needsAuth);
r = engine({ publishedCrewSwagSizes: () => ({ ok: false, error: 'boom' }) }).swagSizes_({ token: 't' });
ok('a Core failure is an error, not an empty count', !r.ok && /boom/.test(r.error));

/* ── 5. wiring (SOURCE-SHAPED) ──────────────────────────────────────────────────────────────────── */
console.log('5. wiring');
const gs = G.GS;
ok('[source] router case', /case 'swagSizes':\s*out = swagSizes_\(p\);/.test(gs));
ok('[source] not on the deploy-secret-only list', !/SECRET_ACTIONS = \[[^\]]*swagSizes/.test(gs));
const root = path.join(__dirname, '..');
const vendorPages = ['client.html', 'flyer.html'].filter(f => fs.existsSync(path.join(root, f)));
ok('[source] no vendor-facing page calls it', vendorPages.every(f => fs.readFileSync(path.join(root, f), 'utf8').indexOf('swagSizes') < 0));
ok('[source] the brand page builder does not read it', !/function brandPaperHtml_[\s\S]{0,4000}swagSizes/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
