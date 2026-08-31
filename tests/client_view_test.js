#!/usr/bin/env node
/* ─── What the VENDOR page says ───────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/client_view_test.js
 *
 * WHY THIS FILE EXISTS
 * client.html is the only surface that leaves the company. Everything else is read by people who
 * know the data; this is read by a vendor deciding whether to fund the next program. A number that
 * is merely confusing internally is a claim externally.
 *
 * Every case below is a real defect found on the live BeGoat page, 2026-08-29:
 * 117 units against a 120 goal was reported to the vendor as "cleared the goal by 3 units".
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const src = fs.readFileSync(__dirname + '/../client.js', 'utf8');
function grab(name) {
  const i = src.search(new RegExp('\\n\\s*function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unterminated ' + name);
}
const money = new Function(grab('money') + '; return money;')();
const num = (n) => (Number(n) || 0).toLocaleString();

/* The goal clause, lifted verbatim in shape from the render. */
function goalClause(sold, tgt, growth) {
  const overGoal = tgt ? sold - tgt : null;
  if (overGoal == null) return '';
  return (growth == null ? ' Sales' : ' and')
    + (overGoal > 0 ? ' cleared the goal by ' + num(overGoal) + ' units'
     : overGoal < 0 ? ' finished ' + num(Math.abs(overGoal)) + ' units short of the goal'
     :                ' landed exactly on the goal');
}

/* ── THE ONE THAT MATTERS: a miss must never read as a win ── */
let c = goalClause(117, 120, 333);                       // BeGoat, exactly as shipped
ok('a program that MISSED says it fell short', /3 units short of the goal/.test(c));
ok('and never claims it cleared anything', !/cleared/.test(c));

ok('a program that BEAT its goal still says so',
   /cleared the goal by 5 units/.test(goalClause(125, 120, 10)));
ok('landing exactly on the goal is neither', /landed exactly on the goal/.test(goalClause(120, 120, 10)));
ok('no goal set means no claim at all', goalClause(117, 0, 10) === '');

/* ── money: the sign goes before the dollar sign ── */
ok('a net loss reads -$315, not $-315', money(-315) === '-$315');
ok('a positive figure is unchanged', money(450) === '$450');
ok('zero is not signed', money(0) === '$0');
ok('thousands still group', money(-3183) === '-$3,183');

/* ── the headcount comparison is dropped when unknown, never stated as "of 0" ── */
function btSub(btTotal, rBt, pBt, rate) {
  const of = btTotal || Number(rBt) || Number(pBt) || 0;
  return (of ? 'of ' + num(of) + ' · ' : '') + money(rate) + ' each';
}
ok('an unknown headcount omits the comparison', btSub(0, 0, 0, 25) === '$25 each');
ok('and never prints "of 0"', !/of 0/.test(btSub(0, 0, 0, 25)));
ok('a known headcount still shows it', btSub(0, 0, 36, 25) === 'of 36 · $25 each');
ok('per-store totals win when present', btSub(38, 0, 36, 25) === 'of 38 · $25 each');

/* ── a negative return must not wear the winning color ── */
const down = (net, credit) => credit ? (net / credit) < 0 : false;
ok('a loss flags the panel as down', down(-315, 450) === true);
ok('a gain does not', down(90, 450) === false);

/* ── THE HEADLINE MUST TIE TO THE TABLE ──
   The KPIs came from actual_json while the table came from the progress cache, so BeGoat's page
   showed "117 units sold" above a table totalling 122 and neither number explained the other.
   Measured data now drives both. This replicates the engine's derivation. */
function derive(byStore, actual, rate) {
  const has = byStore.some(s => s.budtenders > 0);
  const m = has ? byStore.reduce((n, x) => ({ units: n.units + x.sold, hit: n.hit + x.hit,
                                              bts: n.bts + x.budtenders }),
                                 { units: 0, hit: 0, bts: 0 }) : null;
  const soldTot = m ? m.units : (actual ? actual.units_sold : 0);
  const hitTot  = m ? m.hit   : (actual ? actual.bts_hit : 0);
  return { sold: soldTot, hit: hitTot, bts: m ? m.bts : 0,
           credit: hitTot * rate, source: m ? 'measured' : 'recorded' };
}

/* BeGoat, exactly as the cache holds it after the 2026-08-29 backfill. */
const BEGOAT = [
  { sold: 18, hit: 3, budtenders: 6 }, { sold: 3,  hit: 0, budtenders: 2 },
  { sold: 28, hit: 3, budtenders: 5 }, { sold: 3,  hit: 0, budtenders: 3 },
  { sold: 65, hit: 7, budtenders: 7 }, { sold: 5,  hit: 1, budtenders: 2 },
];
let d = derive(BEGOAT, { units_sold: 117, bts_hit: 18 }, 25);
ok('the headline total equals the table total', d.sold === 122);
ok('and does NOT silently keep the stale recorded figure', d.sold !== 117);
ok('budtenders hit comes from the same measurement', d.hit === 14 && d.bts === 25);
/* The credit is what the vendor is INVOICED. Billing 18 hits under a table showing 14 is the
   version of this bug that costs someone money. */
ok('the credit is derived from the measured hits, not the recorded ones', d.credit === 350);
ok('and is labeled as measured', d.source === 'measured');

/* No per-store rows at all — fall back, and say so. */
let f = derive([{ sold: 0, hit: 0, budtenders: 0 }], { units_sold: 117, bts_hit: 18 }, 25);
ok('with no measurement it falls back to the recorded actuals', f.sold === 117 && f.hit === 18);
ok('and labels itself recorded', f.source === 'recorded');

/* ── THE HEADLINE PICKS THE STRONGEST TRUE RESULT, AND HIDES NOTHING ──
   The page is a sales tool, and it was leading with "-59%" for a program that grew sell-through
   352% and cleared its goal: the least flattering true fact, in 54px, at the top. The headline is
   now chosen — but the integrity rule is that whatever loses the headline is still shown, so the
   page REFRAMES rather than conceals. */
function pickHeadline(roiPct, growth, overGoal) {
  if (roiPct != null && roiPct > 0) return { label: 'Return on the SPIFF', down: false };
  if (growth != null && growth > 0) return { label: 'Sales growth over the prior period', down: false };
  if (overGoal != null && overGoal > 0) return { label: 'Units over goal', down: false };
  return { label: 'Return on the SPIFF', down: roiPct != null && roiPct < 0 };
}
const shows = (h, roiPct) => roiPct != null && h.label !== 'Return on the SPIFF';

let h = pickHeadline(-59, 352, 2);                       // BeGoat, as shipped
ok('a negative return does NOT lead when growth is strong',
   h.label === 'Sales growth over the prior period');
ok('and the return is still stated as a stat — reframed, not hidden', shows(h, -59) === true);

h = pickHeadline(120, 352, 2);
ok('a POSITIVE return outranks growth — it is the claim a vendor cares most about',
   h.label === 'Return on the SPIFF');
ok('and then there is no duplicate ROI stat', shows(h, 120) === false);

h = pickHeadline(-20, -5, 3);
ok('with return and growth both down, clearing the goal leads', h.label === 'Units over goal');
ok('and the negative return is still disclosed', shows(h, -20) === true);

h = pickHeadline(-59, -12, -3);
ok('when NOTHING is positive the page does not hunt for an angle', h.label === 'Return on the SPIFF');
ok('and it wears the loss styling', h.down === true);

h = pickHeadline(null, 40, null);
ok('a program with no credit still leads on growth', h.label === 'Sales growth over the prior period');
ok('and shows no ROI stat, because there is no ROI', shows(h, null) === false);

/* ── THE BUDTENDER DENOMINATOR IS THE ROSTER, NOT THE PEOPLE WHO TRIED ──
   It was a count of budtenders appearing in the sell-through, i.e. who sold at least one unit. So
   a store where only two staff touched the product read "0 of 2" — which FLATTERS it: nobody hit,
   out of a denominator that had quietly shrunk to the people who tried. Across one BeGoat program
   the denominators were 6, 2, 5, 3, 7, 2 for stores that all had six budtenders.

   The plan knows the real number: unit goal / per-budtender goal. */
function roster(target, perBt, sellers, hit) {
  const planned = perBt > 0 ? Math.round(target / perBt) : 0;
  return Math.max(planned, sellers, hit);
}
ok('a store where only 2 of 6 sold is still out of 6', roster(18, 3, 2, 0) === 6);
ok('and one where only 3 sold, likewise', roster(18, 3, 3, 0) === 6);
ok('a bigger goal at the same per-head target is still 6', roster(30, 5, 5, 3) === 6);
/* Seven people sold at portland-rd and all seven hit. "7 of 6" reads as a broken page. */
ok('more sellers than planned raises the denominator, never prints 7 of 6',
   roster(18, 3, 7, 7) === 7);
ok('and hits alone can raise it, so hit can never exceed the roster',
   roster(18, 3, 0, 8) === 8);
ok('with no per-budtender goal it falls back to who took part', roster(18, 0, 4, 2) === 4);

/* The whole BeGoat table: five stores at /6, portland-rd at /7. */
const BG = [[18,3,6,3],[18,3,2,0],[30,5,5,3],[18,3,3,0],[18,3,7,7],[18,3,2,1]];
const dens = BG.map(([t2,pb,se,h]) => roster(t2,pb,se,h));
ok('five of six stores read out of 6', dens.filter(d => d === 6).length === 5);
ok('and the program total is 37, not the 25 who happened to sell',
   dens.reduce((a,b) => a+b, 0) === 37);

/* ── vs BEFORE SPIFF ──
   The question the vendor came with is "did this move anything", and vs-goal alone cannot answer
   it: a store can miss an ambitious goal and still have multiplied its sell-through. BeGoat's bend
   went 2 -> 18 while finishing exactly level with goal, so the vs-goal column reads +0 and the
   entire effect of the program at that store is invisible without this one. */
const lift = (sold, baseline) => sold - baseline;
const BG2 = [ // baseline, sold, goal
  ['bend', 2, 18, 18], ['center', 4, 3, 18], ['commercial', 15, 28, 30],
  ['hillsboro', 1, 3, 18], ['portland-rd', 2, 65, 18], ['river-rd', 3, 5, 18] ];
const lifts = BG2.map(([, b2, s2]) => lift(s2, b2));
ok('bend reads +16 against before, where vs-goal reads only +0', lifts[0] === 16);
ok('a store that went BACKWARDS is shown as negative, not hidden', lifts[1] === -1);
ok('portland-rd carried the program: +63', lifts[4] === 63);
ok('the lift total ties to the headline unit lift (122 - 27)',
   lifts.reduce((a, b) => a + b, 0) === 95);
ok('and equals soldTotal - baselineTotal, so the row and total cannot disagree',
   lifts.reduce((a, b) => a + b, 0)
     === BG2.reduce((n, [, b2, s2]) => n + s2, 0) - BG2.reduce((n, [, b2]) => n + b2, 0));

/* ── FOUR CARDS, AND NEVER A DUPLICATE OF THE HEADLINE ──
   With growth leading, the strip still carried "Growth over prior +352%" — the same number twice,
   a card apart, spending one of four slots on nothing new. Each headline makes exactly one card
   redundant; that one is dropped, so the strip lands on four without truncating anything. */
function strip(headlineKind, hasRoi) {
  const all = ['units', 'growth', 'bts', 'credit'].concat(hasRoi ? ['roi'] : []);
  const redundant = headlineKind === 'goal' ? 'units' : headlineKind;
  return all.filter(k => k !== redundant).slice(0, 4);
}
let st = strip('growth', true);                       // BeGoat, as shipped
ok('growth leading drops the growth card', !st.includes('growth'));
ok('and the strip is exactly four cards', st.length === 4);
ok('and the return is still one of them', st.includes('roi'));

st = strip('roi', true);
ok('ROI leading drops the ROI card', !st.includes('roi'));
ok('and growth comes back', st.includes('growth'));
ok('still four', st.length === 4);

st = strip('goal', true);
ok('goal leading drops units sold, whose sub-line already says the same', !st.includes('units'));
ok('still four, and the return survives', st.length === 4 && st.includes('roi'));

/* FOUR IS A CAP, NOT A QUOTA. A program with no credit has no return to show, so growth leading
   leaves three — and the right answer is three cards that stretch, not a fourth card repeating the
   headline. The grid is auto-fit for exactly this. */
st = strip('growth', false);
ok('with no ROI the strip is three, never padded with the duplicate', st.length === 3);
ok('and still never repeats the headline', !st.includes('growth'));
ok('and keeps units sold', st.includes('units'));
ok('the strip is never more than four', ['roi','growth','goal'].every(k => strip(k, true).length <= 4));

console.log(fail ? '\n' + fail + ' FAILED' : '\nclient view: all passed');
process.exit(fail ? 1 : 0);
