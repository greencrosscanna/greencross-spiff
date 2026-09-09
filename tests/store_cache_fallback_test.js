#!/usr/bin/env node
/* ─── The offline store fallback, and an error that told the truth about it ───────────────────────
 *
 *   RUN:  node tests/store_cache_fallback_test.js
 *
 * WHAT WENT WRONG (reported twice, 2026-09-08)
 * Every store rendered as its SLUG — "bend", "river-rd", "portland-rd" instead of Century, River,
 * Portland — across the progress cards, the per-store table and the frozen grid. Four of the six
 * stores have a display name that differs from the slug, so half the screen named places nobody
 * calls by those names. The console said:
 *
 *     [spiff] GX Core load failed: Error: stores: no rows from GX Core and nothing cached
 *
 * and "nothing cached" was FALSE. localStorage held gx_stores_v1 with all six rows, display names
 * included, read out of the browser at the time.
 *
 * THE MECHANISM, reproduced below against the real gx-stores.js rather than asserted
 * GXStores.readCache() DISCARDS a cache entry older than its 6h TTL and returns null. The rows stay
 * in localStorage and simply never reach `rows`, so GXStores.all() is [] and SPIFF concludes there
 * is no cache. Because load() attempts a network refresh EVERY time regardless, that TTL never
 * saves a stale read from being served — it only throws the data away at the one moment the cache
 * exists for, which is a failed fetch. The boundary is exact: at 5.9h old the names render, at 6.1h
 * they become slugs.
 *
 * WHOSE FIX IS WHOSE
 * The TTL lives in greencross-gx-theme/gx-stores.js and belongs to core-admin — five other apps
 * load that file by URL, so it is not SPIFF's to edit (CLAUDE.md, "gx-theme — shared, live, and not
 * yours to edit"). A note went to core-admin. What was SPIFF's was the error: a claim this app is
 * in no position to make, pointing the next reader at an empty localStorage they will not find.
 *
 * SECTION 1 DOES NOT GATE THE PUSH, AND THAT IS DELIBERATE
 * It runs the copy of gx-stores.js sitting in the sibling repo and REPORTS what it finds. It does
 * not count a failure, for two reasons. The code is not ours to fix, so a red gate here would block
 * every SPIFF push on core-admin's timetable. And an assertion written against the CURRENT behavior
 * would go red on the day the bug is fixed — a test that fails when the thing it describes gets
 * better is worse than no test. So it prints ⏸ while gx-theme still discards the cache and ✓ once it
 * stops, and either way the push turns on section 2, which is SPIFF's own half.
 *
 * It also cannot prove what is LIVE: the app loads gx-stores.js from GitHub Pages at runtime, not
 * from this disk. It pins the diagnosis, not the deployment.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

async function main() {

/* ── 1. run the real shared client and watch the cache get thrown away ── */
console.log('\n1. GXStores discards a usable cache past its TTL (the reported failure)');

const THEME = path.join(__dirname, '..', '..', 'greencross-gx-theme', 'gx-stores.js');
if (!fs.existsSync(THEME)) {
  /* Loud, not silent, and not a failure: the sibling repo is normally right there, but a checkout
     without it must not turn a missing input into a passing test. */
  console.log('  ~ SKIPPED — no greencross-gx-theme beside this repo, so there is nothing to run.');
  console.log('    (Section 2 below is SPIFF\'s own half and still runs.)');
} else {
  const SIX = [
    { store_id: 'bend',        display_name: 'Century' },
    { store_id: 'river-rd',    display_name: 'River' },
    { store_id: 'portland-rd', display_name: 'Portland' },
  ];

  /* Exactly the reported condition: a populated gx_stores_v1 of a given age, and a stores fetch
     that fails the way GX Core's second hop actually fails. */
  const runAged = async (ageHours) => {
    const store = {
      gx_stores_v1: JSON.stringify({ ts: Date.now() - ageHours * 3600e3, rows: SIX }),
    };
    const g = {
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      document: null,
      GXClient: () => ({ jsonp: async () => { throw new Error('second hop 404'); } }),
    };
    const warn = console.warn; console.warn = () => {};          // gx-stores logs its own failure
    try {
      new Function('window', fs.readFileSync(THEME, 'utf8') + ';window.__S = window.GXStores;')(g);
      await g.__S.load('https://example/exec');
    } finally { console.warn = warn; }
    return {
      inStorage: JSON.parse(store.gx_stores_v1).rows.length,
      served:    g.__S.all().length,
      /* What SPIFF's storeName() ends up rendering: GXStores.name(id) || id. */
      rendered:  g.__S.name('bend') || 'bend',
    };
  };

  const fresh = await runAged(5.9);
  const stale = await runAged(6.1);

  /* Reported, not asserted — see the header. */
  const note = (l, good) => console.log('  ' + (good ? '✓' : '⏸') + ' ' + l);

  note('under the TTL, a failed fetch serves the cached registry ("Century")',
       fresh.served === 3 && fresh.rendered === 'Century');
  note('past the TTL, the six rows are still sitting in localStorage',
       stale.inStorage === 3);

  const fixed = stale.served === 3 && stale.rendered === 'Century';
  note(fixed
        ? 'past the TTL, the cache is served anyway — gx-theme has been fixed'
        : 'past the TTL, GXStores serves none of them and "bend" renders as the slug '
          + '— STILL PRESENT in the sibling repo, core-admin holds the note',
       fixed);
}

/* ── 2. SPIFF no longer asserts something it cannot know ── */
console.log('\n2. the error describes what this app actually knows');

const src = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
/* Comments here quote the old wording on purpose, so anything checking for it has to read code
   only — same reason boot_path_test.js strips comments before counting call sites. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

ok('the false "nothing cached" claim is gone from the code',
   !/nothing cached/.test(code));
ok('it says GXStores is empty, which is the part this app can see',
   /GXStores is holding none/.test(code));
ok('it names the 6h discard, so the next reader looks in the right place',
   /discards its localStorage cache past 6h/.test(code));
ok('it still names gx_stores_v1, so the rows can be found by hand',
   /gx_stores_v1/.test(code));

/* The branch itself must survive: an error here is still the honest answer when there is genuinely
   no registry to show. Wording was the bug; swallowing it would be a worse one. */
ok('the no-registry case still throws rather than rendering an empty app',
   /else if \(!cached\.length\) \{[\s\S]{0,1400}?throw new Error\('stores: /.test(src));
ok('a refresh failing on top of a good cache is still not an outage',
   /if \(state\.stores\.length\) \{[\s\S]{0,300}?conn\('GX Core', 'cached'\)/.test(src));

console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
return fail ? 1 : 0;

}

/* A rejection here means the test itself broke, not that the app is fine — exit nonzero for it too,
   or a thrown error inside main() would leave the push gate green. */
main().then(process.exit, err => { console.error(err); process.exit(1); });
