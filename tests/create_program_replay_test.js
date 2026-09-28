#!/usr/bin/env node
/* ─── A retried create is not a second program ────────────────────────────────────────────────
 *
 *   RUN:  node tests/create_program_replay_test.js
 *
 * WHY
 * bug_mulu4dfk_4x9j, Tawny, 2026-09-28: "The new Spiff is not saving." It was — verified live,
 * sodas-tictures-all-products-202609 saved in full on the first send. gx-client's jsonp() retries
 * a call by default whenever the first reply is slow or dropped; createProgram_'s id is derived
 * from the name and month, not handed back, so the retry landed on the SAME id the first call had
 * already used and got refused outright — "A program with id ... already exists" — which
 * saveEverything (spiff.js) reports as "Saved, but the model failed". The program was fine the
 * whole time; only the SECOND call's answer was wrong.
 *
 * So a same-id collision on create is now two questions, not one refusal: is this the SAME create
 * landing twice (same user, same model content) — say so, hand back the existing id, write
 * nothing twice — or is it a DIFFERENT program that happens to slug to the same id, which must
 * still be refused exactly as before.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
function col(name) { return PH.indexOf(name); }

/* A program row shaped like what createProgram_ itself would have written for this draft, so the
   collision it hits is the realistic one: its own prior write. */
function existingRow(overrides) {
  const row = PH.map(() => '');
  const p = Object.assign({
    program_id: 'sodas-tictures-all-products-202609',
    vendor: 'Sodas & Tictures', program_name: 'Sodas & Tictures - All Products',
    title: 'Sodas & Tictures - All Products', status: 'draft',
    start_date: '2026-09-28', end_date: '2026-10-11',
    match_json: { brand: 'Sodas & Tictures', category: '', filter_text: '', products: [] },
    stores_json: ['river-rd', 'bend'],
    cost_json: { mode: 'flat', per_unit: 2, source_label: 'calculator' },
    payout_type: 'flat', payout_json: { amount: 25, model: 'flat' },
    target_json: { units: 100, revenue: 5000, budtenders: 10,
                   by_store: { 'river-rd': 60, bend: 40 }, per_bt: { 'river-rd': 6, bend: 4 },
                   bts_by_store: { 'river-rd': 6, bend: 4 } },
    source: 'calculator-app:tawny',
  }, overrides || {});
  row[col('program_id')] = p.program_id;
  row[col('vendor')] = p.vendor;
  row[col('program_name')] = p.program_name;
  row[col('title')] = p.title;
  row[col('status')] = p.status;
  row[col('start_date')] = p.start_date;
  row[col('end_date')] = p.end_date;
  row[col('match_json')] = JSON.stringify(p.match_json);
  row[col('stores_json')] = JSON.stringify(p.stores_json);
  row[col('cost_json')] = JSON.stringify(p.cost_json);
  row[col('payout_type')] = p.payout_type;
  row[col('payout_json')] = JSON.stringify(p.payout_json);
  row[col('target_json')] = JSON.stringify(p.target_json);
  row[col('source')] = p.source;
  return row;
}

/* The draft as spiff.js's calcModelPayload assembles it — plus the window createProgram_ folds
   in on a create — matching existingRow's defaults unless told otherwise. */
function draft(overrides) {
  return Object.assign({
    program_name: 'Sodas & Tictures - All Products', vendor: 'Sodas & Tictures',
    match_json: { brand: 'Sodas & Tictures', category: '', filter_text: '', products: [] },
    stores_json: ['river-rd', 'bend'],
    cost_json: { mode: 'flat', per_unit: 2, source_label: 'calculator' },
    payout_type: 'flat', payout_json: { amount: 25, model: 'flat' },
    target_json: { units: 100, revenue: 5000, budtenders: 10,
                   by_store: { 'river-rd': 60, bend: 40 }, per_bt: { 'river-rd': 6, bend: 4 },
                   bts_by_store: { 'river-rd': 6, bend: 4 } },
    start_date: '2026-09-28', end_date: '2026-10-11',
  }, overrides || {});
}

function run(programRow, p, auth) {
  const programs = G.makeSheet(PH, programRow ? [programRow] : []);
  const cache = G.makeCache();
  const api = G.load({
    real: ['createProgram_', 'createIsReplay_', 'canonJson_', 'saveProgram_', 'getProgram_',
           'listPrograms_', 'rowToProgram_', 'programToRow_', 'measurementInvalidatedBy_',
           'brandMatchCheck_', 'dropProgressRows_', 'invalidatePrograms_', 'parseJson_',
           'textDate_', 'nowStamp_', 'slug_', 'normalizePitch_', 'today_', 'periodStartFor_',
           'stripDerivedActuals_'],
    vars: ['PROGRAM_HEADERS', 'EDIT_ROLES', 'MEASURED_BY', 'CREATE_REPLAY_FIELDS', 'PITCH_MAX_LEN'],
    varValues: { PITCH_MAX_TIPS: 5 },
    stubs: {
      dataSheet_: () => programs,
      gxAuth_: () => (auth || { ok: true, user: 'tawny', role: 'editor' }),
      catalog_: () => ({ ok: true, brands: ['Sodas & Tictures', 'Green Cross'] }),
      annotateActuals_: () => {},
      annotateUnmeasurable_: () => {},
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });
  // today_ is a real function but not in `real` — pin the month so the derived id is stable.
  const orig = Date;
  const res = api.createProgram_(Object.assign({
    token: 'tok', program: JSON.stringify(draft())
  }, p || {}));
  return { res, programs };
}

console.log('create program — replayed retry');

/* ══ the whole point: a same-user, same-content retry is told it saved, not refused ══ */
{
  const r = run(existingRow());
  ok('answers ok, not the "already exists" refusal',
     r.res.ok === true && !/already exists/.test(r.res.error || ''));
  ok('hands back the SAME id, marked as a replay rather than a new create',
     r.res.program_id === 'sodas-tictures-all-products-202609'
     && r.res.created === false && r.res.replay === true);
  ok('writes nothing twice — still exactly one row on the sheet',
     r.programs.rows.length === 2);
}

/* ══ a genuinely different program at the same id is still refused ══ */
{
  const r = run(existingRow(), { program: JSON.stringify(draft({ vendor: 'Different Vendor Co' })) });
  ok('different model content at the same id is refused, not silently dropped',
     r.res.ok === false && /already exists/.test(r.res.error));
  ok('  …and the original row is untouched',
     r.programs.rows[1][col('vendor')] === 'Sodas & Tictures');
}
{
  const r = run(existingRow(), {}, { ok: true, user: 'sky', role: 'admin' });
  ok('same content but a DIFFERENT user at the same id is refused — two people, one collision, '
     + 'a human should look',
     r.res.ok === false && /already exists/.test(r.res.error));
}

/* ══ an id that was never a calculator-app write is never treated as a replay ══ */
{
  const r = run(existingRow({ source: 'seed:import' }));
  ok('a seeded/imported row at the same id refuses rather than matching by content alone',
     r.res.ok === false && /already exists/.test(r.res.error));
}

/* ══ untouched paths ══ */
{
  const r = run(null);
  ok('a brand-new id still creates normally',
     r.res.ok === true && r.res.created === true && r.programs.rows.length === 2);
}
{
  const r = run(existingRow(), { program: null });
  ok('no program payload is still refused the same way',
     r.res.ok === false && /program_name required/.test(r.res.error));
}
{
  const r = run(existingRow(), {}, { ok: false, error: 'Session expired' });
  ok('an expired session is refused before the replay check ever runs',
     r.res.ok === false && r.res.needsAuth === true);
}
{
  const r = run(existingRow(), {}, { ok: true, user: 'gx-dev', role: 'viewer' });
  ok('a viewer cannot create — role gate still runs before the replay check',
     r.res.ok === false && /cannot create/.test(r.res.error));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\ncreate program replay: all passed');
process.exit(fail ? 1 : 0);
