/* ─── One SPIFF, more than one brand (Tawny, 2026-11-19: Meraki Gardens + Vibes) ──────────────────
 *
 * match_json.also_brands adds whole brands to a program. GX Core's filter takes one brand, so the
 * engine asks once per brand and adds the answers. Money rides on that sum, so this RUNS the real
 * engine code with GX Core stubbed at the edge:
 *   1. the extra brands' sales are added to the main brand's, per store
 *   2. one brand refused refuses the whole pull (half a program's units is not a smaller truth)
 *   3. a one-brand program makes exactly one call, with exactly the old filter
 *   4. two brands that could claim one sale are refused at save, confirm or not
 *   5. the live-count id lists are unioned, and a refusal leaves the store out
 *   6. a one-brand program's fingerprint and live hash are unchanged by the new field
 *   7. the kiosk label names every brand
 */
'use strict';
const G = require('./_gas');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const MERAKI = { brand: 'Meraki Gardens', category: '', filter_text: '', products: ['Pre-Roll 1g'],
                 also_brands: ['Vibes'] };

/* ── 1–3. the money pull ───────────────────────────────────────────────────────────────────────── */
function salesApi(answerFor) {
  const calls = [];
  const api = G.load({
    real: ['alsoBrandsOf_', 'categoriesOf_', 'matchParts_', 'partLabel_', 'mergeSalesAnswers_', 'gxSalesForMatch_'],
    vars: ['MAX_ALSO_BRANDS', 'MAX_CATEGORIES'],
    stubs: { gxSalesByEmployee_: (s, f, t, st, m) => { calls.push(m); return answerFor(m); } },
  });
  return { api, calls };
}
{
  const { api, calls } = salesApi(m => m.brand === 'Vibes'
    ? { ok: true, rows: [{ employee_name: 'Ana', units: 3 }], errors: [], totals: { units: 3, revenue: 60 } }
    : { ok: true, rows: [{ employee_name: 'Ana', units: 5 }, { employee_name: 'Bo', units: 2 }], errors: [],
        totals: { units: 7, revenue: 140 } });
  const r = api.gxSalesForMatch_('s', '2026-11-17', '2026-11-30', 'bend', MERAKI);
  ok('both brands are asked for', calls.length === 2, JSON.stringify(calls));
  ok('  …the main brand keeps its own product filter', JSON.stringify(calls[0].products) === '["Pre-Roll 1g"]');
  ok('  …the extra brand is the whole brand', calls[1].brand === 'Vibes' && !calls[1].products.length
     && !calls[1].filter_text && !calls[1].category);
  ok('rows from both brands are added', r.ok && r.rows.length === 3);
  ok('totals are summed (7 + 3 units, $200)', r.totals.units === 10 && r.totals.revenue === 200,
     JSON.stringify(r.totals));
}
{
  const { api } = salesApi(m => m.brand === 'Vibes'
    ? { ok: false, error: 'Dutchie 401' }
    : { ok: true, rows: [{ employee_name: 'Ana', units: 5 }], errors: [], totals: { units: 5 } });
  const r = api.gxSalesForMatch_('s', 'a', 'b', 'bend', MERAKI);
  ok('a refused brand refuses the whole pull', r.ok === false);
  ok('  …and the error names the brand', /Vibes/.test(r.error) && /401/.test(r.error), r.error);
}
{
  const { api, calls } = salesApi(() => ({ ok: true, rows: [], errors: [], totals: {} }));
  const one = { brand: 'Grön', category: '', filter_text: '', products: [] };
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', one);
  ok('a one-brand program makes exactly one call', calls.length === 1);
  ok('  …with the filter it always sent', calls[0] === one);
  calls.length = 0;
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', { brand: '', also_brands: ['Vibes'], products: ['X'] });
  ok('extras with no main brand are ignored, never promoted', calls.length === 1 && calls[0].brand === '');
  calls.length = 0;
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', { brand: 'Meraki Gardens', also_brands: ['meraki gardens', 'Vibes', 'vibes', ''] });
  ok('an extra equal to the main brand, a repeat and a blank are dropped', calls.length === 2,
     JSON.stringify(calls.map(c => c.brand)));
}

/* ── 4. overlap at save ────────────────────────────────────────────────────────────────────────── */
{
  const api = G.load({ real: ['alsoBrandsOf_', 'brandOverlapProblem_'], vars: ['MAX_ALSO_BRANDS'] });
  ok('Meraki Gardens + Vibes is allowed', api.brandOverlapProblem_(MERAKI, ['Meraki Gardens', 'Vibes', 'Mule']).ok);
  const sub = api.brandOverlapProblem_({ brand: 'Mule', also_brands: ['Mule Extracts'] }, null);
  ok('"Mule" + "Mule Extracts" is refused without a catalog', sub.ok === false && /twice/.test(sub.error));
  const cat = api.brandOverlapProblem_({ brand: 'Vibes', also_brands: ['Meraki'] }, ['Meraki Vibes Co']);
  ok('a catalog brand containing both names is refused', cat.ok === false && /Meraki Vibes Co/.test(cat.error));
  const noMain = api.brandOverlapProblem_({ brand: '', also_brands: ['Vibes'] }, null);
  ok('extras with no main brand are refused at save', noMain.ok === false);
  ok('a program with no extras is never refused', api.brandOverlapProblem_({ brand: 'Mule' }, ['Mule', 'Mule Extracts']).ok);
}
{
  /* Wired into saveProgram_ ahead of the confirm gate: confirm_brand must not pass a double count. */
  const src = G.grab('saveProgram_');
  const ov = src.indexOf('brandOverlapCheck_('), gate = src.indexOf('!opts.confirmBrand');
  ok('saveProgram_ checks overlap before, and outside, the confirm gate', ov > 0 && gate > 0 && ov < gate);
}

/* ── 5. live count ids ─────────────────────────────────────────────────────────────────────────── */
{
  const api = G.load({
    real: ['alsoBrandsOf_', 'categoriesOf_', 'matchParts_', 'partLabel_', 'gxMatchIds_'], vars: ['MAX_ALSO_BRANDS', 'MAX_CATEGORIES'],
    stubs: { gxMatchIdsOne_: (s, st, m) => m.brand === 'Vibes'
      ? { ok: true, product_ids: ['9', '2'] } : { ok: true, product_ids: ['1', '2'] } },
  });
  const r = api.gxMatchIds_('s', 'bend', MERAKI);
  ok('id lists are unioned across brands', r.ok && JSON.stringify(r.product_ids) === '["1","2","9"]',
     JSON.stringify(r));
  const bad = G.load({
    real: ['alsoBrandsOf_', 'categoriesOf_', 'matchParts_', 'partLabel_', 'gxMatchIds_'], vars: ['MAX_ALSO_BRANDS', 'MAX_CATEGORIES'],
    stubs: { gxMatchIdsOne_: (s, st, m) => m.brand === 'Vibes' ? { ok: false, error: 'no catalog' }
                                                               : { ok: true, product_ids: ['1'] } },
  }).gxMatchIds_('s', 'bend', MERAKI);
  ok('one brand refused refuses the store (left out, never sent short)', bad.ok === false && /Vibes/.test(bad.error));
}

/* ── 6. existing programs keep their fingerprints ──────────────────────────────────────────────── */
{
  const api = G.load({
    real: ['alsoBrandsOf_', 'liveMatchOf_', 'snapshotFingerprint_'], vars: ['MAX_ALSO_BRANDS'],
    stubs: { textDate_: v => String(v || ''), slug_: v => String(v || '').toLowerCase() },
  });
  const one = { match_json: { brand: 'Grön', category: '', filter_text: '', products: [] },
                start_date: '2026-11-17', end_date: '2026-11-30', stores_json: ['bend'] };
  ok('a one-brand live match has no also_brands key', !('also_brands' in api.liveMatchOf_(one)));
  ok('a one-brand fingerprint is the 7-part shape it always was',
     JSON.parse(api.snapshotFingerprint_(one)).length === 7);
  const two = Object.assign({}, one, { match_json: Object.assign({}, one.match_json, { also_brands: ['Vibes'] }) });
  ok('adding a brand changes the fingerprint (it re-measures)',
     api.snapshotFingerprint_(two) !== api.snapshotFingerprint_(one));
  ok('  …and the live match carries it', JSON.stringify(api.liveMatchOf_(two).also_brands) === '["vibes"]');
}

/* ── 7. what the kiosk reads ───────────────────────────────────────────────────────────────────── */
{
  const api = G.load({ real: ['alsoBrandsOf_', 'productLabelOf_'], vars: ['MAX_ALSO_BRANDS'] });
  ok('whole brands read as one line',
     api.productLabelOf_({ match_json: { brand: 'Meraki Gardens', also_brands: ['Vibes'] } })
       === 'All Meraki Gardens + Vibes products');
  ok('picked products name the extra brand',
     api.productLabelOf_({ match_json: MERAKI }) === 'Pre-Roll 1g + all Vibes');
  ok('a one-brand label is unchanged',
     api.productLabelOf_({ match_json: { brand: 'Grön' } }) === 'All Grön products');
}

console.log(failed ? '\nmulti_brand: ' + failed + ' FAILED' : '\nmulti_brand: all passed');
process.exit(failed ? 1 : 0);
