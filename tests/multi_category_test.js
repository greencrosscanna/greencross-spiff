/* ─── Which categories count (Tawny, 2026-11-19: "choose what categories qualify for the SPIFF") ───
 *
 * match_json.category = the first pick, match_json.also_categories = the rest. GX Core's filter takes
 * ONE category, so the engine asks once per brand per category and adds the answers. Money rides on
 * that sum, so this RUNS the real engine code with GX Core stubbed at the edge:
 *   1. several categories: one ask per category, the main filter kept on each, answers summed
 *   2. categories apply to the extra brands too (brands × categories)
 *   3. one category, or none, asks exactly what it always did
 *   4. overlapping picks, a Dutchie category under two picks, and too many combinations are refused
 *      at save — before, and outside, the confirm gate
 *   5. live-count ids are unioned across categories, and the live match carries them
 *   6. a program with one category keeps its fingerprint; adding a second changes it
 *   7. the kiosk label names the categories
 *   8. the catalog answer lists Dutchie's categories with counts
 *   9. the screen's own pre-checks (spiff.js) agree with the engine's
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./_gas');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const REAL = ['alsoBrandsOf_', 'categoriesOf_', 'matchParts_', 'partLabel_'];
const VARS = ['MAX_ALSO_BRANDS', 'MAX_CATEGORIES', 'MAX_MATCH_PARTS'];
const GRON = { brand: 'Grön', category: 'Edible (Solid)', filter_text: '', products: [],
               also_categories: ['Tincture'] };

/* ── 1–3. the money pull ───────────────────────────────────────────────────────────────────────── */
function salesApi(answerFor) {
  const calls = [];
  const api = G.load({
    real: REAL.concat(['mergeSalesAnswers_', 'gxSalesForMatch_']), vars: VARS,
    stubs: { gxSalesByEmployee_: (s, f, t, st, m) => { calls.push(m); return answerFor(m); } },
  });
  return { api, calls };
}
{
  const { api, calls } = salesApi(m => m.category === 'Tincture'
    ? { ok: true, rows: [{ employee_name: 'Ana', units: 2 }], errors: [], totals: { units: 2, revenue: 40 } }
    : { ok: true, rows: [{ employee_name: 'Ana', units: 6 }], errors: [], totals: { units: 6, revenue: 30 } });
  const r = api.gxSalesForMatch_('s', '2026-11-17', '2026-11-30', 'bend', GRON);
  ok('two categories → two asks', calls.length === 2, JSON.stringify(calls));
  ok('  …one per category', calls[0].category === 'Edible (Solid)' && calls[1].category === 'Tincture');
  ok('  …each keeps the main brand', calls.every(c => c.brand === 'Grön'));
  ok('totals are summed (6 + 2 units, $70)', r.ok && r.totals.units === 8 && r.totals.revenue === 70,
     JSON.stringify(r.totals));
}
{
  const { api, calls } = salesApi(() => ({ ok: true, rows: [], errors: [], totals: { units: 1 } }));
  const withProduct = { brand: 'Grön', category: 'Edible (Solid)', filter_text: 'Gummy', products: ['Pearl'],
                        also_categories: ['Tincture'] };
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', withProduct);
  ok('the main filter (product / filter text) rides on every category',
     calls.every(c => c.filter_text === 'Gummy' && JSON.stringify(c.products) === '["Pearl"]'));
}
{
  const { api, calls } = salesApi(() => ({ ok: true, rows: [], errors: [], totals: { units: 1 } }));
  const r = api.gxSalesForMatch_('s', 'a', 'b', 'bend',
    { brand: 'Meraki Gardens', category: 'Pre-Roll Pack', also_categories: ['1g Pre-Roll'],
      filter_text: '', products: ['Pre-Roll'], also_brands: ['Vibes'] });
  ok('2 brands × 2 categories → 4 asks', calls.length === 4, JSON.stringify(calls.map(c => c.brand + '/' + c.category)));
  ok('  …the extra brand is the whole brand, in each category',
     calls.filter(c => c.brand === 'Vibes').every(c => !c.products.length && !c.filter_text)
     && calls.filter(c => c.brand === 'Vibes').map(c => c.category).join('|') === 'Pre-Roll Pack|1g Pre-Roll');
  ok('  …summed', r.totals.units === 4);
}
{
  const { api, calls } = salesApi(() => ({ ok: true, rows: [], errors: [], totals: {} }));
  api.gxSalesForMatch_('s', 'a', 'b', 'bend',
    { brand: 'Meraki Gardens', category: 'Pre-Roll Pack', filter_text: '', products: [], also_brands: ['Vibes'] });
  ok('one category + an extra brand: the extra brand is narrowed to that category too',
     calls.length === 2 && calls[1].brand === 'Vibes' && calls[1].category === 'Pre-Roll Pack');
}
{
  const { api, calls } = salesApi(() => ({ ok: true, rows: [], errors: [], totals: {} }));
  const one = { brand: 'Grön', category: 'Edible (Solid)', filter_text: '', products: [] };
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', one);
  ok('one category makes exactly one call, with the object it always sent', calls.length === 1 && calls[0] === one);
  calls.length = 0;
  api.gxSalesForMatch_('s', 'a', 'b', 'bend', { brand: 'Grön', category: '', also_categories: ['Tincture'] });
  ok('extra categories with no first category are ignored, never promoted', calls.length === 1 && !calls[0].category);
  calls.length = 0;
  api.gxSalesForMatch_('s', 'a', 'b', 'bend',
    { brand: 'Grön', category: 'Tincture', also_categories: ['tincture', ' ', 'Topical'] });
  ok('a repeat and a blank are dropped', calls.length === 2, JSON.stringify(calls.map(c => c.category)));
}
{
  const { api } = salesApi(m => m.category === 'Tincture' ? { ok: false, error: 'Dutchie 401' }
                                                           : { ok: true, rows: [], errors: [], totals: { units: 5 } });
  const r = api.gxSalesForMatch_('s', 'a', 'b', 'bend', GRON);
  ok('one category refused refuses the whole pull', r.ok === false);
  ok('  …and the error names the category', /Tincture/.test(r.error) && /401/.test(r.error), r.error);
}

/* ── 4. refused at save ────────────────────────────────────────────────────────────────────────── */
{
  const api = G.load({ real: REAL.concat(['categoryProblem_']), vars: VARS });
  const DUTCHIE = ['Paraphernalia', 'Paraphernalia Pipe', 'Edible (Solid)', 'Edible (Liquid)', 'Tincture'];
  ok('Edible (Solid) + Tincture is allowed', api.categoryProblem_(GRON, DUTCHIE).ok);
  const sub = api.categoryProblem_({ brand: 'X', category: 'Paraphernalia', also_categories: ['Paraphernalia Pipe'] }, null);
  ok('a pick inside another is refused without a catalog', sub.ok === false && sub.code === 'category_overlap'
     && /twice/.test(sub.error), JSON.stringify(sub));
  const cat = api.categoryProblem_({ brand: 'X', category: 'Edible', also_categories: ['(Solid)'] }, DUTCHIE);
  ok('a Dutchie category containing two picks is refused', cat.ok === false && /Edible \(Solid\)/.test(cat.error),
     JSON.stringify(cat));
  const noFirst = api.categoryProblem_({ brand: 'X', category: '', also_categories: ['Tincture'] }, null);
  ok('extras with no first category are refused at save', noFirst.ok === false);
  const five = api.categoryProblem_({ brand: 'X', category: 'A1', also_categories: ['B2', 'C3', 'D4', 'E5'] }, null);
  ok('a fifth category is refused', five.ok === false && /Four/.test(five.error));
  const big = api.categoryProblem_({ brand: 'Meraki', also_brands: ['Vibes', 'Mule'], category: 'A1',
                                     also_categories: ['B2', 'C3'] }, null);
  ok('3 brands × 3 categories (9 reads) is refused', big.ok === false && big.code === 'too_many_filters', JSON.stringify(big));
  ok('2 brands × 4 categories (8 reads) is allowed',
     api.categoryProblem_({ brand: 'Meraki', also_brands: ['Vibes'], category: 'A1', also_categories: ['B2', 'C3', 'D4'] }, null).ok);
  ok('a program with one category is never refused',
     api.categoryProblem_({ brand: 'X', category: 'Paraphernalia' }, DUTCHIE).ok);
}
{
  const src = G.grab('saveProgram_');
  const cv = src.indexOf('categoryCheck_('), gate = src.indexOf('!opts.confirmBrand');
  ok('saveProgram_ checks categories before, and outside, the confirm gate', cv > 0 && gate > 0 && cv < gate);
  ok('  …and also when only extra brands are set (the combination cap)', /also_\(categories\|brands\)/.test(src));
}

/* ── 5. live count ids ─────────────────────────────────────────────────────────────────────────── */
{
  const api = G.load({
    real: REAL.concat(['gxMatchIds_', 'liveMatchOf_']), vars: VARS,
    stubs: { gxMatchIdsOne_: (s, st, m) => m.category === 'tincture'
      ? { ok: true, product_ids: ['9', '2'] } : { ok: true, product_ids: ['1', '2'] } },
  });
  const live = api.liveMatchOf_({ match_json: GRON });
  ok('the live match carries the extra category', JSON.stringify(live.also_categories) === '["tincture"]',
     JSON.stringify(live));
  const r = api.gxMatchIds_('s', 'bend', live);
  ok('id lists are unioned across categories', r.ok && JSON.stringify(r.product_ids) === '["1","2","9"]', JSON.stringify(r));
  ok('a one-category live match has no also_categories key',
     !('also_categories' in api.liveMatchOf_({ match_json: { brand: 'Grön', category: 'Tincture' } })));
}

/* ── 6. fingerprints ───────────────────────────────────────────────────────────────────────────── */
{
  const api = G.load({
    real: ['snapshotFingerprint_'],
    stubs: { textDate_: v => String(v || ''), slug_: v => String(v || '').toLowerCase() },
  });
  const one = { match_json: { brand: 'Grön', category: 'Tincture', filter_text: '', products: [] },
                start_date: '2026-11-17', end_date: '2026-11-30', stores_json: ['bend'] };
  ok('a one-category fingerprint is the 7-part shape it always was', JSON.parse(api.snapshotFingerprint_(one)).length === 7);
  const two = Object.assign({}, one, { match_json: Object.assign({}, one.match_json, { also_categories: ['Topical'] }) });
  ok('adding a category changes the fingerprint (it re-measures)', api.snapshotFingerprint_(two) !== api.snapshotFingerprint_(one));
  const asBrand = Object.assign({}, one, { match_json: Object.assign({}, one.match_json, { also_brands: ['Topical'] }) });
  ok('  …and cannot collide with the same word as an extra brand',
     api.snapshotFingerprint_(two) !== api.snapshotFingerprint_(asBrand));
}

/* ── 7. what the kiosk reads ───────────────────────────────────────────────────────────────────── */
{
  const api = G.load({ real: REAL.concat(['productLabelOf_']), vars: VARS });
  ok('categories close the label',
     api.productLabelOf_({ match_json: GRON }) === 'All Grön products (Edible (Solid), Tincture)',
     api.productLabelOf_({ match_json: GRON }));
  ok('a program with no category reads as it always did',
     api.productLabelOf_({ match_json: { brand: 'Grön', category: '' } }) === 'All Grön products');
}

/* ── 8. the catalog lists Dutchie's categories ─────────────────────────────────────────────────── */
{
  const api = G.load({ real: ['catalogCategories_'] });
  const c = api.catalogCategories_([{ c: 'Tincture' }, { c: 'Edible (Solid)' }, { c: 'Tincture' }, { c: '' }, {}]);
  ok('categories are counted, sorted, blanks skipped',
     JSON.stringify(c) === '[{"name":"Edible (Solid)","count":1},{"name":"Tincture","count":2}]', JSON.stringify(c));
}

/* ── 9. the screen's pre-checks ────────────────────────────────────────────────────────────────── */
{
  const JS = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  /* spiff.js declares these inside its IIFE, indented, so they are read with a plain pattern. */
  const lim = JS.match(/var MAX_CATS = (\d+), MAX_PARTS = (\d+);/);
  ok('screen limits are declared', !!lim);
  const MAX_CATS = Number(lim && lim[1]), MAX_PARTS = Number(lim && lim[2]);
  const fn = new Function(
    'var MAX_CATS = ' + MAX_CATS + ', MAX_PARTS = ' + MAX_PARTS + ';\n'
    + G.grab('categoryPickProblem', JS) + '\n' + G.grab('categoryAlsoCounts', JS)
    + '\nreturn { categoryPickProblem: categoryPickProblem, categoryAlsoCounts: categoryAlsoCounts };')();
  ok('screen limits mirror the engine',
     MAX_CATS === Number(G.grabVar('MAX_CATEGORIES')) && MAX_PARTS === Number(G.grabVar('MAX_MATCH_PARTS')));
  const D = ['Paraphernalia', 'Paraphernalia Pipe', 'Edible (Solid)', 'Tincture'];
  ok('screen: a clean pick passes', fn.categoryPickProblem('Tincture', ['Edible (Solid)'], D, 1) === '');
  ok('screen: an overlapping pick is refused', /overlap/.test(fn.categoryPickProblem('Paraphernalia Pipe', ['Paraphernalia'], D, 1)));
  ok('screen: a repeat is refused', /already/.test(fn.categoryPickProblem('tincture', ['Tincture'], D, 1)));
  ok('screen: the combination cap', fn.categoryPickProblem('Tincture', ['A1', 'B2'], D, 3) !== ''
     && fn.categoryPickProblem('Tincture', ['A1'], D, 3) === '');
  ok('screen: "Paraphernalia" says it also counts "Paraphernalia Pipe"',
     JSON.stringify(fn.categoryAlsoCounts('Paraphernalia', D)) === '["Paraphernalia Pipe"]');
}

console.log(failed ? '\nmulti_category: ' + failed + ' FAILED' : '\nmulti_category: all passed');
process.exit(failed ? 1 : 0);
