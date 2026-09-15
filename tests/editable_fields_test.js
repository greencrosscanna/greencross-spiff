#!/usr/bin/env node
/* ─── A patch the engine silently ignores ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/editable_fields_test.js
 *
 * WHY
 * editProgram_ applies only the keys named in EDITABLE_FIELDS. Anything else is skipped WITHOUT A
 * WORD: the route returns ok, `changed` lists just the fields it did apply, and a caller that does
 * not read `changed` sees a successful save that did nothing.
 *
 * match_json and stores_json were missing from that list. match_json is WHAT THE SPIFF IS ON — the
 * brand, the category, the named products — so the one field that decides which sales count could
 * not be changed after a program was created.
 *
 * Sky changed Portland Heights from the Green Cross house brand to "all Portland Heights products"
 * twice on 2026-09-02. The button said Updated both times. The record kept the house brand, and
 * kept reporting 3,514 units of it against a real 242.
 *
 * THE CLASS OF BUG, worth stating because the list will grow again: the Calculator builds one
 * payload of nine model fields and the engine accepts seven of them. Nothing on either side
 * compares the two. So this file does.
 *
 * REWRITTEN 2026-09-15. It used to compare two lists of strings: EDITABLE_FIELDS read out of
 * Code.gs, against key names SCRAPED off calcModelPayload's source with `/^\s{6}(\w+):/gm`. Both
 * halves were weaker than they looked, and in opposite directions.
 *
 *   · The scrape was an indentation rule. Six spaces and a colon — so a field moved one nesting
 *     level, or a payload reformatted, drops out of `sent` and every assertion about it stops
 *     existing. Silently, and with the count guard (`sent.length >= 8`) still satisfied by the
 *     eight that remained. A test that quietly checks less is the same failure as a route that
 *     quietly saves less, which is the bug this file is named after.
 *   · Membership in a list is not acceptance. `EDITABLE.indexOf('match_json') >= 0` is true of an
 *     engine whose editProgram_ was deleted. Nothing here ever ran the route, so nothing here
 *     could tell "the field is on the list" from "the field reaches the sheet" — and it is the
 *     second one Sky was owed on 2026-09-02.
 *
 * Both halves now run. calcModelPayload is executed with a model and its keys are read off the
 * OBJECT it returns; that payload is then handed to the real editProgram_ over a real in-memory
 * sheet, and the assertions read the cells afterwards. The two files are joined by an object that
 * travelled between them rather than by two lists of strings that agree.
 *
 * What stays source-shaped: nothing. The last hold-out was the per-store baseline split, which was
 * three regexes over the payload's source — those are now a plan row carrying DECOY `baseline` and
 * `bts` properties, so reading the wrong name produces the wrong number instead of matching a
 * different line.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

/* EDITABLE_FIELDS is read as a VALUE, but not through G.grabVar: that helper stops at the first
   semicolon, and this declaration carries one inside a comment inside the literal ("…edited through
   saveBrandContact; accepting them here would…"), which truncates it mid-comment. Balanced brackets
   instead. Still the engine's own list — never a copy typed in here, which is the failure the
   harness's note about header lists describes. */
const EDITABLE = new Function('return ' +
  (G.GS.match(/\nvar EDITABLE_FIELDS = (\[[\s\S]*?\n\];)/) || [])[1])();

/* ── 1. THE CALCULATOR'S PAYLOAD, BUILT FOR REAL ─────────────────────────────────────────────────
 * calcModelPayload closes over `calc` (what is typed on the screen) and `matchOf` (which turns a
 * product picker selection into a match). Both are injected; everything inside the function is the
 * shipped code.
 *
 * The plan rows carry `baseline` and `bts` as DECOYS, holding numbers that are wrong. Those are the
 * names on calc.stores — a DIFFERENT object — and reading them off a plan row is what wrote 0 into
 * every store's last-month figure while the chain total came out right: a record that looks correct
 * in summary and is flat zero underneath. With decoys present, reading the wrong name produces 999
 * rather than 0, so the assertion fails on the value instead of hoping a regex still matches.
 */
console.log('\n1. the payload the Calculator sends, built by running the Calculator\'s code');

const CALC = {
  name: 'Portland Heights October', vendor: 'Portland Heights',
  cost: 12.5, model: 'per_unit', spiff: 1, product: '(picker selection)',
};
const MATCH = { brand: 'Portland Heights', category: '', filter_text: '', products: [] };

const buildPayload = new Function('calc', 'matchOf',
  G.grab('calcModelPayload', js) + '; return calcModelPayload;')(CALC, () => MATCH);

const MODEL = {
  baseUnits: 150, baseRev: 3000, goalUnits: 300, targetRev: 6000, bts: 10,
  on: [{ store_id: 'river-rd' }, { store_id: 'bend' }],
  plan: [
    { store_id: 'river-rd', goal: 180, perBt: 30, n: 6, base: 90, baseline: 999, bts: 999 },
    { store_id: 'bend',     goal: 120, perBt: 30, n: 4, base: 60, baseline: 999, bts: 999 },
  ],
};
const PAYLOAD = buildPayload(MODEL);

ok('the payload is nine model fields', Object.keys(PAYLOAD).length === 9);
ok('  …carrying the typed name and vendor',
   PAYLOAD.program_name === 'Portland Heights October' && PAYLOAD.vendor === 'Portland Heights');
ok('  …the payout MODEL, not a hardcoded flat — Hapy Kitchen paid $1 a unit',
   PAYLOAD.payout_type === 'per_unit' && PAYLOAD.payout_json.model === 'per_unit');
ok('  …and the match the picker produced', PAYLOAD.match_json.brand === 'Portland Heights');

/* THE PER-STORE BASELINE SPLIT, read off the object. */
ok('the baseline split reads `base` off a plan row, not `baseline`',
   PAYLOAD.baseline_json.by_store['river-rd'] === 90 && PAYLOAD.baseline_json.by_store.bend === 60);
ok('  …and the headcount reads `n`, not `bts` — 90 over 6 is 15',
   PAYLOAD.baseline_json.per_bt['river-rd'] === 15 && PAYLOAD.baseline_json.per_bt.bend === 15);
ok('  …so the decoy 999s on those rows reached nothing',
   JSON.stringify(PAYLOAD).indexOf('999') < 0);
/* HEADCOUNT IS SAVED. Reopening a program used to guess it back by dividing two already-rounded
   numbers, and the guess was wrong for 20 of 26 live programs — pressing Update then rewrote the
   store goals with nobody typing anything. */
ok('the headcount per store is saved, not left to be guessed back',
   PAYLOAD.target_json.bts_by_store['river-rd'] === 6 && PAYLOAD.target_json.bts_by_store.bend === 4);
/* per_bt comes STRAIGHT off the plan, because the table on screen already rounded it. Two formulas
   for one number is how a program gets sold at one goal and settled at another. */
ok('the per-budtender goal is the one the screen showed, not a second calculation',
   PAYLOAD.target_json.per_bt['river-rd'] === 30);
ok('  …and `budtenders` is there, without which Programs shows "of 0 hit"',
   PAYLOAD.target_json.budtenders === 10);

/* ── 2. THE ENGINE, RUN AGAINST A REAL SHEET ─────────────────────────────────────────────────────
 * editProgram_ over saveProgram_ over programToRow_, writing into an in-memory tab. Only the edges
 * are stubbed: who is signed in, which sheet, and the product catalog the brand guard consults.
 */
const PH = G.grabVar('PROGRAM_HEADERS');
const PROG_H = G.grabVar('PROGRESS_HEADERS');
const col = (n) => PH.indexOf(n);

/* Portland Heights as it sat on 2026-09-02: matched to the Green Cross house brand, with the 38
   measurement rows that were taken against that filter. */
function portlandHeights(over) {
  const p = Object.assign({
    program_id: 'portland-heights-2026-08-17-2026-08-30',
    vendor: 'Green Cross', program_name: 'Green Cross test', title: 'Green Cross test',
    status: 'active', start_date: '2026-08-17', end_date: '2026-08-30',
    match_json: { brand: 'Green Cross', category: '', filter_text: '', products: [] },
    stores_json: ['commercial'], cost_json: {}, payout_type: 'flat',
    payout_json: { model: 'flat', amount: 25 }, baseline_json: {}, target_json: {},
    actual_json: null, source: 'seed',
  }, over || {});
  const row = PH.map(() => '');
  row[col('program_id')] = p.program_id;
  row[col('vendor')] = p.vendor;
  row[col('program_name')] = p.program_name;
  row[col('title')] = p.title;
  row[col('status')] = p.status;
  row[col('start_date')] = p.start_date;
  row[col('end_date')] = p.end_date;
  row[col('pay_period')] = '2026-09-04';          // the wrong old value: end_date + 5, the PAY DATE
  row[col('match_json')] = JSON.stringify(p.match_json);
  row[col('stores_json')] = JSON.stringify(p.stores_json);
  row[col('cost_json')] = JSON.stringify(p.cost_json);
  row[col('payout_type')] = p.payout_type;
  row[col('payout_json')] = JSON.stringify(p.payout_json);
  row[col('baseline_json')] = JSON.stringify(p.baseline_json);
  row[col('target_json')] = JSON.stringify(p.target_json);
  row[col('source')] = p.source;
  row[col('contact_email')] = 'rep@example.test';
  return row;
}

/* One edit, run for real. Returns the route's answer plus the sheets, so an assertion can ask what
   landed in a cell rather than what the source says it would land. */
function edit(patch, opts) {
  const o = opts || {};
  const programs = G.makeSheet(PH, [o.row || portlandHeights()]);
  const progress = G.makeSheet(PROG_H, Array.from({ length: 38 }, () => {
    const r = PROG_H.map(() => '');
    r[0] = 'portland-heights-2026-08-17-2026-08-30';
    r[PROG_H.indexOf('units')] = 92; r[PROG_H.indexOf('earned')] = 25;
    return r;
  }));
  const cache = G.makeCache();
  const api = G.load({
    real: ['editProgram_', 'saveProgram_', 'getProgram_', 'listPrograms_', 'rowToProgram_',
           'programToRow_', 'measurementInvalidatedBy_', 'brandMatchCheck_', 'dropProgressRows_',
           'invalidatePrograms_', 'parseJson_', 'textDate_', 'nowStamp_', 'slug_',
           'normalizePitch_', 'periodStartFor_', 'stripDerivedActuals_', 'scrubSecrets_'],
    vars: ['PROGRAM_HEADERS', 'PROGRESS_HEADERS', 'EDIT_ROLES', 'MEASURED_BY', 'DERIVED_ACTUALS',
           'PROGRAMS_CACHE_KEY', 'PITCH_MAX_LEN'],
    /* EDITABLE_FIELDS by value for the reason above; PITCH_MAX_TIPS pinned because the harness's
       one-line-declarator reader returns the SECOND declarator's value for it (Code.gs:578 puts
       both on one line) and a tip cap of 240 is not the shipped rule. */
    varValues: { EDITABLE_FIELDS: EDITABLE, PITCH_MAX_TIPS: 5 },
    stubs: {
      dataSheet_: () => programs,
      progressSheet_: () => progress,
      gxAuth_: () => (o.auth || { ok: true, user: 'sky', role: 'admin' }),
      /* The brand guard asks the live catalog. Both brands in play are stocked, so it passes and
         is not what any assertion below is about — but it is the REAL guard, so a program whose
         brand matched nothing would still be refused here. */
      catalog_: () => ({ ok: true, brands: ['Green Cross', 'Portland Heights', 'Wyld'] }),
      annotateActuals_: () => {},
      annotateUnmeasurable_: () => {},
      payPeriodCfg_: () => ({ anchor: '2026-08-17', days: 14 }),
    },
    globals: { CacheService: cache.CacheService },
  });
  const res = api.editProgram_({
    token: 'tok', id: o.id || 'portland-heights-2026-08-17-2026-08-30',
    patch: JSON.stringify(patch),
  });
  const saved = () => api.getProgram_(o.id || 'portland-heights-2026-08-17-2026-08-30').program;
  return { res, saved, programs, progress, cache, api };
}

/* ── THE ONE THAT COST A DAY ── */
console.log('\n2. the edit that said Updated and changed nothing');
{
  const r = edit({ match_json: { brand: 'Portland Heights', category: '', filter_text: '', products: [] } });
  ok('the route reports it applied match_json',
     r.res.ok === true && (r.res.changed || []).indexOf('match_json') >= 0);
  /* The assertion the old file could not make. `changed` is the route's own account of itself;
     this reads the sheet. */
  ok('  …and the SHEET now holds the new brand, which is what was wrong on 2026-09-02',
     r.saved().match_json.brand === 'Portland Heights');
  /* Accepting the field is only half the fix. The 38 rows were measured against the old filter —
     3,514 units of house brand — and GX Crew reads them. */
  ok('  …and the 38 measurements taken against the OLD filter are dropped',
     r.res.dropped_rows === 38 && r.progress.rows.length === 1);
  ok('  …with the route saying which field invalidated them',
     (r.res.invalidated || []).indexOf('match_json') >= 0);
  ok('  …and the programs cache cleared, so the next read does not serve the old brand',
     r.cache.removed.indexOf('spiff_programs_v1') >= 0);
}
{
  const r = edit({ stores_json: ['commercial', 'river-rd'] });
  ok('stores_json reaches the sheet too — which stores the program ran in',
     (r.res.changed || []).indexOf('stores_json') >= 0
     && JSON.stringify(r.saved().stores_json) === '["commercial","river-rd"]');
}
{
  const r = edit({ payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 1 } });
  ok('payout_type lands as its own column, not only inside payout_json',
     r.saved().payout_type === 'per_unit'
     && r.programs.rows[1][col('payout_type')] === 'per_unit');
}

/* ── EVERY FIELD THE CALCULATOR SENDS IS ACCEPTED ────────────────────────────────────────────────
   The payload built in section 1 — the real object, not a list of names — patched through the real
   route. This is the assertion that would have caught it: the payload and the whitelist are
   written in two files by two different hands, and nothing but this compares them. */
console.log('\n3. the Calculator\'s payload, applied through the engine');
{
  const r = edit(PAYLOAD);
  ok('the save succeeds', r.res.ok === true);
  ok('  …and EVERY field the Calculator sent was applied, none skipped in silence',
     (r.res.changed || []).slice().sort().join(',') === Object.keys(PAYLOAD).sort().join(','));
  const after = r.saved();
  Object.keys(PAYLOAD).forEach(function (f) {
    ok('  ' + f + ' is on the record afterwards, byte for byte',
       JSON.stringify(after[f]) === JSON.stringify(PAYLOAD[f]));
  });
}

/* The record form's fields too — the other half of the screen saves through the same route. */
console.log('\n4. the record panel\'s own fields');
{
  const r = edit({ status: 'closed', start_date: '2026-08-31', end_date: '2026-09-13',
                   actual_json: { units_sold: 242, investment: 181.5 } });
  const after = r.saved();
  ok('status is applied', after.status === 'closed');
  ok('start_date and end_date are applied',
     after.start_date === '2026-08-31' && after.end_date === '2026-09-13');
  ok('actual_json is applied', after.actual_json.units_sold === 242);
  ok('  …and moving the window re-derives pay_period from the new start, not from the patch',
     after.pay_period === '2026-08-31');
}

/* ── WHAT MUST NOT BE ACCEPTED ───────────────────────────────────────────────────────────────────
   A list of what MAY be written only means something if something is refused. Both of these are
   deliberate exclusions with a reason on the record, and both are now proved by running the route
   rather than by an indexOf over the list. */
console.log('\n5. the deliberate exclusions');
{
  const r = edit({ pay_period: '2026-12-25', status: 'closed' });
  ok('a patched pay_period is not applied — it is derived from start_date',
     (r.res.changed || []).indexOf('pay_period') < 0);
  ok('  …and the cell holds the derived value, not the one that was sent',
     r.saved().pay_period === '2026-08-17' && r.programs.rows[1][col('pay_period')] !== '2026-12-25');
}
{
  /* Reps live in GX Core's brand registry as of 2026-09-15; accepting these here would give a
     program a second, private contact list that the vendor sign-in no longer reads. */
  const r = edit({ contact_email: 'someone-else@example.test', contact_name: 'Someone Else' });
  ok('contact_email and contact_name are refused — reps are Core\'s, not the program\'s',
     r.res.unchanged === true && !r.res.changed);
  ok('  …and the old value on the row is untouched',
     r.programs.rows[1][col('contact_email')] === 'rep@example.test');
}
{
  const r = edit({ program_id: 'something-else' });
  ok('the primary key cannot be patched — renaming is its own route, with its own gates',
     r.res.unchanged === true
     && r.programs.rows[1][col('program_id')] === 'portland-heights-2026-08-17-2026-08-30');
}

/* SILENCE IS THE ACTUAL HAZARD: the route reports ok either way. Keep `changed` in the response so
   a caller CAN tell, even though the fix is to accept the field in the first place. */
console.log('\n6. the route says what it did');
{
  const r = edit({ vendor: 'Green Cross' });   // already the stored value
  ok('a patch that changes nothing says so plainly rather than reporting a save',
     r.res.ok === true && r.res.unchanged === true && !r.res.updated);
  const r2 = edit({ vendor: 'Portland Heights' });
  ok('  …and a real change names the fields it applied and who applied them',
     r2.res.updated === true && (r2.res.changed || []).join(',') === 'vendor' && r2.res.edited_by === 'sky');
  ok('  …stamping the editor onto the row', r2.programs.rows[1][col('edited_by')] === 'sky');
}

/* The role gate is server-side; the modal hiding its Save button is convenience, not the control. */
{
  const r = edit({ match_json: { brand: 'Wyld' } }, { auth: { ok: true, user: 'dev', role: 'viewer' } });
  ok('a viewer cannot edit, and the row is untouched',
     r.res.ok === false && /cannot edit/.test(r.res.error)
     && r.saved().match_json.brand === 'Green Cross');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\neditable fields: all passed');
process.exit(fail ? 1 : 0);
