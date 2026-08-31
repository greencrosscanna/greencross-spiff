#!/usr/bin/env node
/* ─── The Calculator says NOTHING until there is an ask ───────────────────────────────────────────
 *
 *   RUN:  node tests/calc_no_ask_test.js
 *
 * WHY
 * A target of zero is not a target of zero — it is no target yet. The model cannot tell the
 * difference, and it should not have to: `growth` off a target of 0 is exactly −1, and −1 renders
 * as "−100.0% over last month" under a headline of "−1,000". On a screen Tawny turns around to
 * face a vendor, that is the app announcing their product has stopped selling — before anyone has
 * asked them for anything.
 *
 * v1.301 fixed three of the four stat cards ("you fund", "revenue increase", "your return") and
 * left Unit lift on the weaker `hasBase` guard, so the −100% survived on the one card that still
 * looked like a measurement. Reported by Sky 2026-08-31.
 *
 * The rule: a card may show a computed figure only when there is BOTH a reference to grow from
 * and a target to grow to. Reference alone earns a prompt, not a number. The goal bar's "target
 * is N BELOW last month" warning is the same rule — it must not fire on a target nobody set.
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

/* ── 1. the real model, proving the −100% is genuinely what it produces ───────────────────────── */
const calcModel = new Function('calc', grab('calcModel') + '; return calcModel;');

const stores = (baseline) => [{ store_id: 'river-rd', name: 'River Rd', baseline: baseline, bts: 6 }];
const model = (baseline, target) =>
  calcModel({ cost: 10, spiff: 25, target: target, model: 'flat', stores: stores(baseline) })();

const noAsk = model(1000, 0);
ok('a product pulled with no target yet gives growth of exactly −1', noAsk.growth === -1);
ok('  …which is the −100% — the model is right, the RENDER must gate it', Math.round(noAsk.growth * 100) === -100);
ok('  …and a unit lift of −1,000', noAsk.unitInc === -1000);

const asked = model(1000, 1300);
ok('a real ask still computes: +300 units, 30% growth', asked.unitInc === 300 && Math.round(asked.growth * 100) === 30);

const below = model(1000, 800);
ok('a target genuinely BELOW last month is still negative, not clamped', below.unitInc === -200);

/* ── 2. the guards that keep it off the screen ────────────────────────────────────────────────── */
const recalc = grab('recalc');

const lift = /cstat\('Unit lift',([\s\S]*?)\);/.exec(recalc);
ok('the Unit lift card exists', !!lift);
if (lift) {
  ok('Unit lift gates its VALUE on an ask, not just a base', /hasAsk \?/.test(lift[1]));
  ok('Unit lift gates its CAPTION on an ask too', (lift[1].match(/hasAsk \?/g) || []).length >= 2);
  ok('Unit lift never falls back to hasBase for a computed figure',
     !/hasBase \? (?:\(m\.unitInc|pct\()/.test(lift[1]));
}

const belowLine = /var below = ([^;]+);/.exec(recalc);
ok('the below-target warning exists', !!belowLine);
if (belowLine) {
  ok('"target is N BELOW last month" requires a target somebody actually set',
     /calc\.target/.test(belowLine[1]));
}

/* Everything in the strip that prints a number must sit behind hasAsk. This is the check that
   catches the NEXT card someone adds on the weaker guard. */
const strip = recalc.slice(recalc.indexOf("var stats = $('#calcStats')"), recalc.indexOf("var base = $('#cGoalBase')"));
ok('no stat card renders money() or a percent under hasBase alone',
   !/hasBase \? (?:money\(|pct\(|pctWhole\()/.test(strip));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall good');
process.exit(fail ? 1 : 0);
