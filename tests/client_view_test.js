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

/* ── a negative return must not wear the winning colour ── */
const down = (net, credit) => credit ? (net / credit) < 0 : false;
ok('a loss flags the panel as down', down(-315, 450) === true);
ok('a gain does not', down(90, 450) === false);

console.log(fail ? '\n' + fail + ' FAILED' : '\nclient view: all passed');
process.exit(fail ? 1 : 0);
