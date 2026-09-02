#!/usr/bin/env node
/* ─── What a SPIFF is ON ──────────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/product_match_test.js
 *
 * WHY
 * Sky, 2026-09-02: "we need to also be able to select 'all items' from a vendor, this was the
 * Portland Heights SPIFF, the payout applied to all PH items."
 *
 * That was ALREADY expressible on the wire and always had been — brand set, nothing else — but the
 * picker only ever offered a flavor group or one SKU, so the program was left pointing at whatever
 * it had been cloned from. The live Portland Heights row was matching brand "Green Cross", the
 * house brand, because it began life as a duplicated test record.
 *
 * THE MATCHING RULES, from GX Core (gx_dutchie.gs, gxSalesByEmployee_). All AND-ed, each a
 * case-insensitive SUBSTRING:
 *
 *     brand        the product's brand must contain it
 *     category     the product's category must contain it
 *     filter_text  the product's NAME must contain it
 *     products[]   the product's name must contain ANY of them   ← the only OR in the set
 *
 * Which is why:
 *   - all of a vendor  = brand alone, nothing else set
 *   - several things   = products[], NOT filter_text (two filter_texts would AND to nothing)
 *   - four is the cap  = GX Core does .slice(0, 4) SILENTLY. A fifth pick is dropped with no
 *                        error, and the sales it should have counted simply never reach a payout.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const M = new Function(grab('productFromMatch') + grab('matchOf') +
                       '; return { productFromMatch, matchOf };')();

/* ── ALL OF A VENDOR ── */
const all = M.productFromMatch({ brand: 'Portland Heights', category: '', filter_text: '', products: [] });
ok('brand alone hydrates as ALL of that vendor', all && all.all === true);
ok('  …and says so in words a human reads', /^All Portland Heights products$/.test(all.label));
ok('  …and carries no product filter of any kind',
   all.filter_text === '' && all.products.length === 0);
/* The round trip is the part that matters: this is what gets stored and what GX Core matches on. */
const allBack = M.matchOf(all);
ok('it saves as brand and NOTHING else — which is what makes it mean "everything"',
   allBack.brand === 'Portland Heights' && allBack.filter_text === '' &&
   allBack.products.length === 0 && allBack.category === '');

/* ── SEVERAL THINGS ── */
const multi = M.productFromMatch({ brand: 'Wyld', filter_text: '', products: ['Gummies', 'Sparkling Water'] });
ok('a product list hydrates as several picks', multi.picks.length === 2 && !multi.all);
ok('  …each one individually removable, so a chip can be dropped', 
   multi.picks.every(p => p.key && p.label && p.match));
ok('  …labelled as the sum of its parts', multi.label === 'Gummies + Sparkling Water');
const multiBack = M.matchOf(multi);
ok('and saves as products[], the only OR the matcher has',
   multiBack.products.join('|') === 'Gummies|Sparkling Water');
ok('  …with filter_text EMPTY — it ANDs, so a value there would exclude everything',
   multiBack.filter_text === '');

/* ── THE LEGACY SHAPE IS NOT REWRITTEN ──
   22 programs were saved with a single filter_text before multi-select existed. Converting them on
   load would change what a closed program measured, so they are carried through untouched. */
const legacy = M.productFromMatch({ brand: 'Meraki Gardens', filter_text: 'Gummies', products: [] });
ok('a legacy single-group program keeps its filter_text', legacy.filter_text === 'Gummies');
ok('  …and round-trips to exactly what it was',
   M.matchOf(legacy).filter_text === 'Gummies' && M.matchOf(legacy).products.length === 0);
ok('  …and still reads as its brand and group', legacy.label === 'Meraki Gardens · Gummies');

/* ── NOTHING SELECTED ── */
ok('an empty match is no selection, not an empty "all"',
   M.productFromMatch({ brand: '', filter_text: '', products: [] }) === null);
ok('  …and neither is undefined', M.productFromMatch(undefined) === null);
ok('nothing selected saves as four empty fields, never as a partial filter',
   JSON.stringify(M.matchOf(null)) ===
   JSON.stringify({ brand: '', category: '', filter_text: '', products: [] }));

/* ── THE CAP IS GX CORE'S, AND IT IS SILENT ── */
const MAX = Number((js.match(/var MAX_PICKS = (\d+);/) || [])[1]);
ok('the picker caps at four, matching GX Core’s .slice(0, 4)', MAX === 4);
ok('  …and REFUSES the fifth rather than accepting it',
   /picks\.length >= MAX_PICKS/.test(js) && /Four is the limit/.test(js));
/* Accepting five and letting the server drop one is the failure mode this exists to prevent: the
   row would look chosen and its sales would never count. */
ok('  …with a message that names the alternative', /All ' \+ brand \+ ' products/.test(js));

/* ── THE TWO ARE MUTUALLY EXCLUSIVE ── */
ok('picking an item drops "all products"',
   /api\.chosen && !api\.chosen\.all && api\.chosen\.brand === brand/.test(js));
ok('and choosing "all" is a toggle, not a one-way door',
   /\(api\.chosen && api\.chosen\.all\) \? null :/.test(js));

/* ── THE PICKER OFFERS IT AT ALL ── */
ok('the menu pins an "All <vendor> products" row', /data-all="1"/.test(js));
ok('  …which the search box never filters away', js.indexOf('var head = brandNow') >= 0);
ok('  …and the click handler acts on it', /closest\('\[data-all\]'\)/.test(js));

/* ── LOADING A PAST PROGRAM CARRIES THE PRODUCT ──
   loadIntoCalc copied name, vendor, cost, payout, target and stores, and left the product null —
   so "model from a past program" produced a model with nothing selected, and pullReference returns
   early without one. The reference figures the whole Calculator prices off never loaded. */
const load = grab('loadIntoCalc');
ok('modeling from a past program brings its product too',
   /calc\.product = productFromMatch\(p\.match_json\)/.test(load));
ok('  …and shows it in the picker', /calcPicker\.setChosen\(calc\.product\)/.test(load));

/* ══════════════ A PER-UNIT PROGRAM HAS NO INDIVIDUAL TARGET ══════════════
 * Portland Heights, 2026-09-02: the vendor set a per-STORE threshold, every store cleared it, and
 * every budtender then earned $0.75 on each unit they personally sold. Sky's way of expressing
 * that in this app is "all products" plus a per-budtender goal of zero — no per-store threshold
 * logic, because no future program works this way.
 *
 * That is correct for the MONEY: progEarned_ pays units × rate for per_unit and never consults
 * `hit`. But the screens were built for flat programs, where earnings come from clearing a target,
 * and they would have reported the opposite of the truth: $0 earned, 0 of 38 at target, a progress
 * bar at 0% — on a program owing $181.50 across 242 units.
 */
const paint = grab('paintProgress');
ok('Progress knows a per-unit program when it sees one',
   /normalModel\(\(prog\.payout_json \|\| \{\}\)\.model \|\| prog\.payout_type\) === 'per_unit'/.test(paint));
ok('earned so far is UNITS × rate for per-unit, not hit × rate',
   /var earned  = perUnit \? units \* rate : hit \* rate/.test(paint));
ok('  …and the caption says so, so the figure can be checked by hand',
   /'earned so far, ' \+ units\.toLocaleString\(\) \+ ' × '/.test(paint));
ok('"budtenders at their target" becomes who is EARNING — everyone who sold',
   /budtenders earning — everyone who sold/.test(paint));
ok('and "if everyone lands it" — a flat idea — is replaced by the rate',
   /per unit sold, from the first one/.test(paint));
/* With no chain target set, "242 / 0" is worse than "242". */
ok('the units tile drops the "/ target" half when there is no target',
   /target \? ' <small>\/ '/.test(paint));

const card = grab('pgCard');
ok('each store card reports who is earning rather than who "hit"',
   /earning \+ ' of ' \+ r\.budtenders \+ ' earning<\/span>'/.test(card));
ok('  …and shows the store’s money instead of a per-head target',
   /money\(r\.units \* cardRate\)/.test(card));
ok('a budtender’s row shows what they have EARNED, not how far short they are',
   /money\(e\.units \* cardRate\)/.test(card));
ok('  …styled as money rather than as a deficit',
   /sp-bt-d is-earn/.test(card));
ok('everyone who sold reads as earning', /var earns = cardPerUnit && e\.units > 0/.test(card));
/* A bar drawn against a goal of zero sits empty, which reads as "nothing sold" on a card that
   just said 60 units. */
ok('no progress bar is drawn when there is no goal to draw it against',
   /cardPerUnit && !goal \? ''/.test(card));

/* The flat path must be untouched — 22 of the 24 programs are flat. */
ok('flat programs still report hit against target',
   /r\.hit \+ ' of ' \+ r\.budtenders \+ ' hit<\/span>'/.test(card) &&
   /budtenders at their target/.test(paint));
ok('  …and still price the ceiling as everyone landing it',
   /money\(btsAll \* rate\)/.test(paint));

console.log(fail ? '\n' + fail + ' FAILED' : '\nproduct match: all passed');
process.exit(fail ? 1 : 0);
