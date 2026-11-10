/* THE LIVE COUNT — SPIFF's hourly list of the product ids that count, per running program and store,
 * for the Leaderboard kiosk to add live sales on top of (display only). Runs the engine's own code.
 *
 *   1. buildLivePayloads_: only ACTIVE programs; a store with no read time or no id list is LEFT OUT
 *      (never sent empty); counted_through = read start minus Core's 3-minute cache; grouped by the
 *      derived pay period; the exact field names Leaderboard reads.
 *   2. mergeLiveReadTimes_: fresh times win, stale ones (> 3 days) drop.
 *   3. refreshSpiffProgress_: a store's read time is recorded only when its read SUCCEEDED, and it is
 *      the time the read STARTED.
 *   4. publishSpiffLive_: an old GXCore pin skips without a single match-id call; an oversized payload
 *      is refused, not truncated; it publishes as its own producer, never through publishSpiffProgress.
 *   5. Isolation: nothing that pays calls it, and the hourly trigger calls it AFTER the money publish.
 */
'use strict';
const assert = require('assert');
const { GS, load, grab, makeProps, Utilities } = require('./_gas');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const READ = Date.UTC(2026, 10, 9, 19, 56, 43);   // 2026-11-09 11:56:43 PT
const prog = (id, status, stores, extra) => Object.assign({
  program_id: id, status: status, start_date: '2026-11-09', end_date: '2026-11-22',
  stores_json: stores, match_json: { brand: 'Freshy', category: '', filter_text: '', products: [] },
}, extra || {});

function builder() {
  return load({
    real: ['buildLivePayloads_'],
    vars: ['LIVE_CORE_CACHE_MS', 'LIVE_UNIT_RULE'],
    stubs: {
      textDate_: (s) => String(s || '').slice(0, 10),
      periodStartFor_: (d) => (d ? '2026-11-09' : ''),
      slug_: (s) => String(s || '').trim().toLowerCase(),
    },
  });
}

console.log('1. buildLivePayloads_');
check('active only; missing read time or id list leaves the store out; field names exact', () => {
  const b = builder();
  const programs = [
    prog('carts-aio-s-202611', 'active', ['bend', 'commercial', 'river-rd', 'center']),
    prog('old-one', 'closed', ['bend']),
    prog('draft-one', 'draft', ['bend']),
  ];
  const times = { 'carts-aio-s-202611|bend': READ, 'carts-aio-s-202611|commercial': READ,
                  'carts-aio-s-202611|river-rd': READ, 'old-one|bend': READ };
  const asked = [];
  const idsFor = (p, s) => { asked.push(p.program_id + '|' + s);
    return s === 'river-rd' ? { ok: false, error: 'catalog failed' } : { ok: true, product_ids: ['111', '222'] }; };
  const out = b.buildLivePayloads_(programs, times, idsFor, () => 'abcd1234', '2026-11-09T20:00:00.000Z');
  assert.deepStrictEqual(Object.keys(out.payloads), ['2026-11-09']);
  const pl = out.payloads['2026-11-09'];
  assert.strictEqual(pl.pay_period, '2026-11-09');
  assert.ok(pl.unit_rule.indexOf('isReturned') >= 0);
  assert.strictEqual(pl.programs.length, 1, 'closed and draft programs are never published');
  const p = pl.programs[0];
  assert.deepStrictEqual(Object.keys(p), ['program_id', 'from', 'to', 'rules_hash', 'stores']);
  assert.deepStrictEqual(Object.keys(p.stores).sort(), ['bend', 'commercial'],
    'river-rd (no id list) and center (no read yet) are left out, not sent empty');
  assert.deepStrictEqual(Object.keys(p.stores.bend), ['counted_through', 'product_ids']);
  assert.strictEqual(p.stores.bend.counted_through, '2026-11-09T19:53:43.000Z', 'read start minus 3 minutes');
  assert.deepStrictEqual(p.stores.bend.product_ids, ['111', '222']);
  assert.ok(asked.indexOf('carts-aio-s-202611|center') < 0, 'no id call for a store never read');
  assert.ok(out.skipped.some(s => s.store === 'river-rd') && out.skipped.some(s => s.store === 'center'));
});
check('a program with no store left is not published at all', () => {
  const b = builder();
  const out = b.buildLivePayloads_([prog('x', 'active', ['bend'])], {}, () => ({ ok: true, product_ids: [] }),
                                   () => 'h', 'now');
  assert.deepStrictEqual(Object.keys(out.payloads), []);
});

console.log('2. mergeLiveReadTimes_');
check('fresh wins, stale drops', () => {
  const m = load({ real: ['mergeLiveReadTimes_'], vars: ['LIVE_READ_KEEP_MS'] });
  const now = READ;
  const out = m.mergeLiveReadTimes_({ 'a|bend': now - 1000, 'b|bend': now - 4 * 864e5 }, { 'a|bend': now }, now);
  assert.deepStrictEqual(out, { 'a|bend': now });
});

console.log('3. refreshSpiffProgress_ records read times');
check('only for successful stores, stamped at read START', () => {
  let clock = READ, saved = null;
  const rows = [];
  const sheet = { getDataRange: () => ({ getValues: () => [['h']] }), deleteRow: () => {},
                  getLastRow: () => 1, getRange: () => ({ setValues: (v) => rows.push(...v) }) };
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const r = load({
      real: ['refreshSpiffProgress_'],
      varValues: { PROGRESS_HEADERS: new Array(14).fill('x') },
      stubs: {
        listPrograms_: () => [prog('p1', 'active', ['bend', 'hillsboro'])],
        nowStamp_: () => '2026-11-09 11:56:43',
        slug_: (s) => s,
        sellthrough_: (q) => { clock += 9000;   // each read takes 9s
          return q.store === 'hillsboro' ? { ok: false, error: 'Dutchie said no' }
                                         : { ok: true, rows: [{ employee_id: '1', name: 'A', units: 2, target: 5 }] }; },
        progEarned_: () => 0, scrubSecrets_: (s) => s,
        progressSheet_: () => sheet, forceProgressTextDates_: () => {},
        saveLiveReadTimes_: (t) => { saved = t; },
      },
    });
    r.refreshSpiffProgress_('', '', {});
  } finally { Date.now = realNow; }
  assert.deepStrictEqual(Object.assign({}, saved), { 'p1|bend': READ }, 'bend at its read start; failed hillsboro absent');
});

console.log('4. publishSpiffLive_');
function publisher(GXCore, programs, idsFor) {
  const { PropertiesService } = makeProps({ GX_DEPLOY_SECRET: 's3cret', LIVE_READ_AT: JSON.stringify({ 'p1|bend': READ }) });
  let matchCalls = 0;
  const api = load({
    real: ['publishSpiffLive_', 'buildLivePayloads_', 'loadLiveReadTimes_'],
    vars: ['GX_SECRET_PROP', 'LIVE_READ_PROP', 'LIVE_CORE_CACHE_MS', 'LIVE_UNIT_RULE', 'LIVE_MAX_BYTES'],
    stubs: {
      listPrograms_: () => programs,
      gxMatchIds_: () => { matchCalls++; return idsFor(); },
      liveMatchOf_: () => ({}), liveRulesHash_: () => 'h',
      textDate_: (s) => String(s || '').slice(0, 10), periodStartFor_: () => '2026-11-09',
      slug_: (s) => s, scrubSecrets_: (s) => String(s),
    },
    globals: { PropertiesService, GXCore },
  });
  return { api, calls: () => matchCalls };
}
check('an old GXCore pin skips with zero match-id calls', () => {
  const p = publisher({}, [prog('p1', 'active', ['bend'])], () => ({ ok: true, product_ids: ['1'] }));
  const r = p.api.publishSpiffLive_({});
  assert.ok(r.skipped_all);
  assert.strictEqual(p.calls(), 0);
});
check('publishes through publishSpiffLive, never publishSpiffProgress', () => {
  const sent = [];
  const GXCore = { publishSpiffLive: (sec, scope, payload) => { sent.push({ scope, payload }); return { ok: true }; },
                   publishSpiffProgress: () => { throw new Error('must not be called'); } };
  const p = publisher(GXCore, [prog('p1', 'active', ['bend'])], () => ({ ok: true, product_ids: ['1', '2'] }));
  const r = p.api.publishSpiffLive_({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].scope, '2026-11-09', 'plain pay period scope, no ":live" suffix');
  assert.deepStrictEqual(sent[0].payload.programs[0].stores.bend.product_ids, ['1', '2']);
});
check('an oversized payload is refused, not truncated', () => {
  const sent = [];
  const GXCore = { publishSpiffLive: () => { sent.push(1); return { ok: true }; } };
  const big = []; for (let i = 0; i < 6000; i++) big.push('1234567' + i);
  const p = publisher(GXCore, [prog('p1', 'active', ['bend'])], () => ({ ok: true, product_ids: big }));
  const r = p.api.publishSpiffLive_({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(sent.length, 0);
});

console.log('5. Isolation (SOURCE-SHAPED: call sites, not behavior)');
check('nothing that pays calls the live publisher', () => {
  ['spiffProgress_', 'publishSpiffToCore_', 'snapshotProgram_', 'recordMeasuredActuals_', 'sellthrough_']
    .forEach(n => assert.ok(grab(n).indexOf('publishSpiffLive_') < 0, n + ' must not call it'));
});
check('the hourly trigger publishes live AFTER the money publish', () => {
  const t = grab('refreshSpiffProgressTrigger');
  const a = t.indexOf('publishSpiffToCore_('), b = t.indexOf('publishSpiffLive_(');
  assert.ok(a > 0 && b > a);
});
check('publishLive is secret-only', () => {
  assert.ok(/SECRET_ACTIONS = \[[^\]]*'publishLive'/.test(GS));
});

if (failed) { console.log('\nlive count: ' + failed + ' FAILED'); process.exit(1); }
console.log('\nlive count: all passed');
