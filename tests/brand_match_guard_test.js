#!/usr/bin/env node
/* ─── A program whose brand matches nothing measures nothing ──────────────────────────────────────
 *
 *   RUN:  node tests/brand_match_guard_test.js
 *
 * WHY
 * A program is matched to products by brand, and one wrong character makes it match nothing —
 * silently. Nothing warned anyone, and SPIFF's numbers reach GX Crew's incentive column, which is
 * what people are PAID on. A bad match has already published a wrong figure once: Portland Heights,
 * 2026-09-02, reported 3,514 units against a real 242 and Crew had no way to know better.
 *
 * THE PART THIS TEST EXISTS TO PIN DOWN
 * There are TWO brand matchers in this system and they do not agree:
 *
 *   catalog_ (Code.gs)                  brand === product.brand      exact, for the PICKER
 *   gxSalesByEmployee_ (GX Core)        product.brand.indexOf(brand) substring, for the MONEY
 *
 * The guard has to use the SECOND one. Written against the first it would refuse programs that pay
 * out perfectly well — "National Cannabis Co" against products branded "National Cannabis Co." is a
 * real program from Aug 2025 that measured 267 real units. Getting this backwards turns a safety
 * check into a blocker on legitimate work, so the direction is asserted here rather than left to
 * whoever reads the guard next.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

function grab(name) {
  const i = gs.search(new RegExp('\\nfunction ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

// Run brandMatchCheck_ against a stubbed catalog_ so the test never touches Dutchie.
function check(matchJson, catalogResult) {
  const fn = new Function('catalog_', grab('brandMatchCheck_') + '\nreturn brandMatchCheck_;');
  return fn(() => catalogResult)(matchJson);
}
const catalogOf = names => ({ ok: true, brands: names.map(n => ({ name: n, count: 1 })) });

console.log('\n1. the rule is the one that moves money, not the one that fills the picker');
{
  // The Aug 2025 program: brand "National Cannabis Co", products "National Cannabis Co."
  const r = check({ brand: 'National Cannabis Co' }, catalogOf(['National Cannabis Co.', 'Mule Extracts']));
  ok('a brand that is a SUBSTRING of a real brand passes — this program really did pay out',
     r.checked === true && r.ok === true);

  const exactOnly = check({ brand: 'National Cannabis Co.' }, catalogOf(['National Cannabis Co.']));
  ok('an exact brand passes too', exactOnly.ok === true);
}

console.log('\n2. a real typo is caught, and the suggestion is punctuation-only');
{
  const r = check({ brand: 'Sesions' }, catalogOf(['Sessions', 'Dab Factory']));
  ok('a misspelled brand is refused', r.checked === true && r.ok === false);
  ok('...and no suggestion is invented for it', Array.isArray(r.suggest) && r.suggest.length === 0);

  const p = check({ brand: 'Cloudious 9' }, catalogOf(['Cloudious9']));
  ok('a punctuation-only near-miss IS suggested', p.ok === false && p.suggest[0] === 'Cloudious9');
}

console.log('\n3. it fails OPEN — an outage must not stop every save');
{
  ok('a catalog that could not be read is not checked',
     check({ brand: 'Anything' }, { ok: false, error: 'no products from any store' }).checked === false);
  ok('a catalog with no brands is not checked',
     check({ brand: 'Anything' }, { ok: true, brands: [] }).checked === false);
  ok('a program with no brand at all is not checked (other filters carry it)',
     check({ brand: '', filter_text: 'Dank Tank' }, catalogOf(['Mule Extracts'])).checked === false);
  ok('a match_json arriving as a STRING is still parsed',
     check(JSON.stringify({ brand: 'Mule Extracts' }), catalogOf(['Mule Extracts'])).ok === true);
}

console.log('\n4. the guard is wired where both save paths pass through');
{
  ok('saveProgram_ runs the check', /brandMatchCheck_\(p\.match_json\)/.test(gs));
  ok('an import is exempt — it replays records nobody is editing', /!opts\.fromImport && !opts\.confirmBrand/.test(gs));
  ok('editProgram_ forwards confirm_brand', /saveProgram_\(merged, \{ editedBy: auth\.user, confirmBrand:/.test(gs));
  ok('createProgram_ forwards confirm_brand', /saveProgram_\(draft, \{ editedBy: auth\.user, confirmBrand:/.test(gs));
  ok('the refusal is identifiable by code, not by message text', /code: 'brand_no_match'/.test(gs));
}

console.log('\n5. a brand that matches MORE than one brand asks first — that is the widening');
{
  const r = check({ brand: 'Mule' }, catalogOf(['Mule', 'Mule Extracts', 'Wyld']));
  ok('"Mule" against Mule + Mule Extracts is flagged, not waved through', r.checked === true && r.ok === false);
  ok('  …as brand_ambiguous, naming both brands it would count',
     r.code === 'brand_ambiguous' && r.matches.join('|') === 'Mule|Mule Extracts');
  ok('  …while the full name matches one brand and passes', check({ brand: 'Mule Extracts' }, catalogOf(['Mule', 'Mule Extracts'])).ok === true);
  ok('saveProgram_ returns it as its own code, with the brands it would count',
     /code: 'brand_ambiguous'/.test(gs) && /matches: bm\.matches/.test(gs));
  ok('  …and it is a question, not a wall: confirm_brand skips it like the no-match case',
     grab('saveProgram_').indexOf("bm.code === 'brand_ambiguous'") > grab('saveProgram_').indexOf('!opts.confirmBrand'));
}

console.log('\n6. the PICKER now uses the payout rule too, so the two cannot disagree');
{
  const run = (brand, products) => new Function('catalogGet_', 'catalogPut_', 'buildCatalog_',
    grab('catalog_') + '\nreturn catalog_;')(() => ({ products, brands: [], built_at: 'x' }), () => {}, () => null)({ brand });
  const prods = [{ b: 'National Cannabis Co.', n: 'Tincture' }, { b: 'Mule Extracts', n: 'Dank Tank' }, { b: 'Wyld', n: 'Gummy' }];
  ok('"National Cannabis Co" now finds the products branded "National Cannabis Co." (was zero)',
     run('National Cannabis Co', prods).products.length === 1);
  ok('  …case-insensitively, the same as the payout', run('mule', prods).products.map(x => x.b).join() === 'Mule Extracts');
  ok('  …and still nothing for a brand we do not carry', run('Sessions', prods).products.length === 0);

  const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
  ok('the frontend has no exact brand comparison left in the picker', !/x\.b === (brand|chosen\.brand)/.test(js));
  ok('  …it uses brandHas, which is contains + case-insensitive',
     /function brandHas\(productBrand, brand\)/.test(js) && /indexOf\(b\) >= 0/.test(js));
  ok('the save screen asks on brand_ambiguous as well as brand_no_match',
     /r\.code === 'brand_no_match' \|\| r\.code === 'brand_ambiguous'/.test(js));
}

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
