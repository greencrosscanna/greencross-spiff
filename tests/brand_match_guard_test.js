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

console.log(fail ? '\n' + fail + ' FAILED\n' : '\nall passed\n');
process.exit(fail ? 1 : 0);
