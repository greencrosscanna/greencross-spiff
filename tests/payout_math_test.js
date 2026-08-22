#!/usr/bin/env node
/* ─── SPIFF payout + cost math — tests ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/payout_math_test.js        (from the repo root; no deps, no network, no credentials)
 *
 * WHY THESE FUNCTIONS FIRST
 * computePayouts_ decides what each budtender is owed, and that number becomes a gift card. It is also
 * the function with a known history of being wrong in a specific way: the old Calculator flattened
 * per_unit programs into flat ones, which is why the imported history looked uniformly flat until the
 * SPIF docs contradicted it (see "Payout model" in CLAUDE.md). Most of the cases below exist to keep
 * per_unit from silently collapsing back into flat.
 *
 * HOW IT LOADS THE REAL CODE
 * Reads apps-script/Code.gs as text and evaluates it with every Apps Script global stubbed, so it tests
 * the SHIPPED source rather than a copy that can drift. Same pattern as the Command Center's
 * tests/codeq_test.js. Nothing here touches the engine, the datastore, or GX Core.
 *
 * This file cannot reach the engine: .clasp.json sets rootDir to apps-script, so clasp only ever pushes
 * from there and anything at the repo root is out of scope. That is also why this repo needs no
 * .claspignore — do not "fix" its absence by adding one without checking rootDir first.
 */
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');

// ── Apps Script globals, stubbed. Code.gs has no top-level calls into these; they exist so that
//    evaluating the file does not throw on a missing reference.
const stubs = {
  SpreadsheetApp: {}, DriveApp: {}, DocumentApp: {}, UrlFetchApp: {}, Utilities: {},
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => '', setProperty: () => {} }) },
  ScriptApp: {}, Session: {}, LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  HtmlService: {}, ContentService: {}, CacheService: {}, MailApp: {}, GmailApp: {}, Logger: { log: () => {} },
  GXCore: {},
};
const names = Object.keys(stubs);
const load = new Function(...names, src + '\n; return { computePayouts_, findBlendedCost_ };');
const S = load(...names.map(n => stubs[n]));

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS  ' + label); } else { fail++; console.log('  FAIL  ' + label); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label + (JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

// Three budtenders across two stores. Ana clears her target, Ben misses, Cal clears his.
const ROWS = [
  { employee_id: 'e1', name: 'Ana', store_id: 'river-rd',    units: 12 },
  { employee_id: 'e2', name: 'Ben', store_id: 'river-rd',    units: 4  },
  { employee_id: 'e3', name: 'Cal', store_id: 'portland-rd', units: 9  },
];
const TARGETS = { 'river-rd': 10, 'portland-rd': 5 };

// ── 1. flat ──────────────────────────────────────────────────────────────────
console.log('\n1. flat — a fixed bounty, only to those who clear their target');
{
  const r = S.computePayouts_(ROWS, TARGETS, { type: 'flat', amount: 25 });
  ok(r.ok === true, 'returns ok');
  eq(r.lines.map(l => l.earned), [25, 0, 25], 'Ana and Cal earn, Ben earns nothing');
  eq(r.lines.map(l => l.hit), [true, false, true], 'hit = cleared the target');
  eq(r.hit, 2, 'hit count is 2');
  eq(r.total_owed, 50, 'total owed is 25 x 2');
  eq(r.total_units, 25, 'total units counts everyone, including Ben');
}

// ── 2. per_unit — the case that used to collapse into flat ───────────────────
console.log('\n2. per_unit — pays on volume, with NO target to clear');
{
  const r = S.computePayouts_(ROWS, TARGETS, { type: 'per_unit', per_unit: 1 });
  ok(r.ok === true, 'returns ok');
  eq(r.type, 'per_unit', 'type is preserved, not flattened to flat');
  eq(r.lines.map(l => l.earned), [12, 4, 9], 'everyone earns units x per_unit');
  ok(r.lines[1].earned === 4, 'Ben earns despite missing target — the whole point of per_unit');
  eq(r.lines.map(l => l.hit), [true, true, true], 'hit means "sold something", not "cleared target"');
  eq(r.total_owed, 25, 'total owed equals total units at $1');
}

// ── 3. per_unit must not read the flat `amount` field ────────────────────────
console.log('\n3. the two payout fields do not leak into each other');
{
  const r = S.computePayouts_(ROWS, TARGETS, { type: 'per_unit', amount: 25, per_unit: 2 });
  eq(r.total_owed, 50, 'per_unit uses per_unit (25 units x $2), ignoring a stray amount:25');
  const f = S.computePayouts_(ROWS, TARGETS, { type: 'flat', amount: 25, per_unit: 99 });
  eq(f.total_owed, 50, 'flat uses amount (2 hits x $25), ignoring a stray per_unit:99');
}

// ── 4. targets ───────────────────────────────────────────────────────────────
console.log('\n4. target edge cases');
{
  const noTarget = S.computePayouts_(ROWS, {}, { type: 'flat', amount: 25 });
  eq(noTarget.total_owed, 0, 'a missing target pays nobody rather than paying everybody');
  eq(noTarget.hit, 0, 'and nobody is marked hit');

  const zero = S.computePayouts_(ROWS, { 'river-rd': 0, 'portland-rd': 0 }, { type: 'flat', amount: 25 });
  eq(zero.total_owed, 0, 'a target of 0 pays nobody — target must be > 0, not merely met');

  const exact = S.computePayouts_(
    [{ employee_id: 'e', name: 'Eve', store_id: 's', units: 10 }], { s: 10 }, { type: 'flat', amount: 5 });
  eq(exact.total_owed, 5, 'hitting the target exactly counts as clearing it');
}

// ── 5. unimplemented payout types are refused, not guessed ───────────────────
console.log('\n5. tiered is schema-d but unimplemented — it must refuse');
{
  const t = S.computePayouts_(ROWS, TARGETS, { type: 'tiered', amount: 25 });
  ok(t.ok === false, 'tiered returns ok:false rather than paying something plausible');
  ok(/not implemented/.test(t.error || ''), 'and says why');
  const junk = S.computePayouts_(ROWS, TARGETS, { type: 'whatever' });
  ok(junk.ok === false, 'an unknown type is refused too');
}

// ── 6. defaults ──────────────────────────────────────────────────────────────
console.log('\n6. defaults and empty input');
{
  const d = S.computePayouts_(ROWS, TARGETS, {});
  eq(d.type, 'flat', 'payout type defaults to flat');
  eq(d.total_owed, 0, 'with no amount, a flat program owes nothing');
  const none = S.computePayouts_([], TARGETS, { type: 'flat', amount: 25 });
  eq([none.ok, none.total_owed, none.total_units, none.hit], [true, 0, 0, 0], 'no rows is a valid, empty program');
  const dirty = S.computePayouts_(
    [{ employee_id: 'x', name: 'X', store_id: 'river-rd', units: '12' }], TARGETS, { type: 'flat', amount: 25 });
  eq(dirty.total_owed, 25, 'units arriving as a string still compare numerically');
}

// ── 7. findBlendedCost_ — returns the LABEL, so an import is auditable ───────
console.log('\n7. blended-cost label detection');
{
  const grid = [['Vendor', 'Wyld'], ['SKU', '10pc'], ['Combined WS Cost', '4.12']];
  eq(S.findBlendedCost_(grid, 3), 'Combined WS Cost', 'finds "Combined WS Cost" and returns the label, not the number');
  eq(S.findBlendedCost_([['Average Cost', '3']], 3), 'Average Cost', 'finds "Average Cost"');
  eq(S.findBlendedCost_([['Combined Total for 20pc & 2pc', '9']], 3), 'Combined Total for 20pc & 2pc', 'finds a combined total');
  ok(S.findBlendedCost_([['combioned ws cost', '1']], 3) === 'combioned ws cost',
     'tolerates the "combioned" misspelling — deliberate, it is in real sheets');
  eq(S.findBlendedCost_([['Unit Cost', '2']], 3), null, 'a plain unit cost is not a blend');
  eq(S.findBlendedCost_([[], ['x']], 3), null, 'empty grid rows are survivable');
  eq(S.findBlendedCost_([['a', 'b', 'c', 'Average Cost']], 1), null,
     'respects the cMax column bound rather than scanning the whole row');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
