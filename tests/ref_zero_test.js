#!/usr/bin/env node
/* ─── A source that refused is not a measurement of zero ──────────────────────────────────────────
 *
 *   RUN:  node tests/ref_zero_test.js
 *
 * WHY
 * "when i select a product it's coming up as 0s for last month" — Sky, 2026-08-31. Dutchie was
 * returning HTTP 401 for all six stores. GX Core reports a store that would not answer in an
 * `errors` array and still returns totals of 0, so refUnits_ replied ok:true, reference:0 — and the
 * Calculator, which cannot tell a refusal from a genuinely unsold product, seeded every store at 0,
 * marked the pull successful, and captioned it "0 in 28d ÷ 2" as though it had been measured.
 * Every figure on the page is arithmetic on that number.
 *
 * The distinction the code now makes, and the only one available: a genuine zero comes back with an
 * EMPTY errors array. A zero with errors beside it is a refusal wearing a number, and is refused.
 *
 * ALSO PINNED: the product catalogue. buildCatalog_ has the same shape — errors reported, build
 * carries on — so a chain-wide outage produced a well-formed catalogue of zero products which was
 * then cached for six hours OVER the good one. Verified live: forcing refresh=1 during the 401
 * replaced an 8,480-row catalogue with an empty one, emptying the vendor picker.
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

/* ── refUnits_, driven for real against a stubbed sell-through ────────────────────────────────── */
const refSrc = grab(gs, 'refUnits_');
function runRef(totals, errors) {
  const env = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'secret' }) },
    GX_SECRET_PROP: 'GX_DEPLOY_SECRET',
    slug_: (x) => String(x || '').trim().toLowerCase(),
    today_: () => '2026-08-31',
    addDaysLocal_: (ymd, n) => {
      const p = String(ymd).split('-');
      const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
      return d.toISOString().slice(0, 10);
    },
    gxSalesByEmployee_: () => ({ ok: true, totals, rows: [], errors }),
    REF_DAYS: 28, REF_DIVISOR: 2
  };
  const names = Object.keys(env);
  return new Function(...names, refSrc + '; return refUnits_;')(...names.map(n => env[n]))
         ({ store: 'river-rd', brand: 'BeGOAT' });
}

const refused = runRef({ units: 0, revenue: 0 }, ['river-rd: Dutchie /reporting/transactions HTTP 401']);
ok('every store refusing is NOT reported as a successful zero', refused.ok === false);
ok('  …and the refusal itself is handed back to be shown', /401/.test(refused.error || ''));
ok('  …with no reference figure for the Calculator to seed from', refused.reference === undefined);

const genuine = runRef({ units: 0, revenue: 0 }, []);
ok('a product that genuinely sold nothing still returns a real zero', genuine.ok === true);
ok('  …as zero, not as an error', genuine.reference === 0 && genuine.units === 0);

const partial = runRef({ units: 412, revenue: 1236 }, ['bend: Dutchie HTTP 401']);
ok('a partial read is still a figure', partial.ok === true && partial.reference === 206);
ok('  …and carries its errors so the caller can say it is short a store',
   (partial.errors || []).length === 1);

const clean = runRef({ units: 413, revenue: 1239 }, []);
ok('a clean read halves the 28 days as Sky specified', clean.reference === Math.round(413 / 2));

/* ── the catalogue must not be emptied by an outage ───────────────────────────────────────────── */
const cat = grab(gs, 'catalog_');
ok('an empty build with errors does not overwrite the cache', /!built\.rows_seen && \(built\.errors/.test(cat));
ok('  …the last good catalogue is served instead', /cat = keep; cached = true; stale = true/.test(cat));
ok('  …flagged stale, so the picker can say the list may be old', /stale: stale/.test(cat));
ok('  …and with nothing cached, it is an error rather than an empty list',
   /ok: false, error: 'no products could be read/.test(cat));
ok('an empty catalogue already IN the cache is treated as a miss',
   /if \(cat && !\(cat\.products \|\| \[\]\)\.length\) cat = null;/.test(cat));
ok('  …and the stale-fallback applies the same test, rather than handing it straight back',
   /if \(keep && !\(keep\.products \|\| \[\]\)\.length\) keep = null;/.test(cat));
ok('a PARTIAL build still caches — one store down must not empty the picker',
   /} else \{\s*\n\s*cat = built;\s*\n\s*catalogPut_\(cat\);/.test(cat));

/* ── the screen says it once, loudly, instead of six times on hover ───────────────────────────── */
const recalc = grab(js, 'recalc');
ok('failed stores are counted apart from slow ones', /function refFailed/.test(js));
ok('all stores out gets a headline, not a tooltip', /could not be read for ANY store/.test(recalc));
ok('  …that names it as waiting, not as measuring zero', /not measuring zero/.test(recalc));
ok('a partial outage says how many stores the totals are short', /are short those stores/.test(recalc));
ok('the vendor picker admits a stale product list', /last product list that read cleanly/.test(js));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall good');
process.exit(fail ? 1 : 0);
