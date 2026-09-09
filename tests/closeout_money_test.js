#!/usr/bin/env node
/* ─── What the vendor is billed, and who gets a gift card ─────────────────────────────────────────
 *
 *   RUN:  node tests/closeout_money_test.js
 *
 * Found 2026-09-08 by running the close-out against a real closed program. All three outputs — the
 * vendor PDF, the drafted email and the gift-card buy list — computed the credit as
 * `bts_hit × rate`, the FLAT formula, unconditionally. Portland Heights is per_unit: 242 units at
 * $0.75 is $181.50, and it reads $181.50 in the record, on screen and in what Core publishes. All
 * three close-out paths said $28.50 — 38 earners × $0.75.
 *
 * Tawny would have asked the vendor for $153 less than we were owed, on a document headed "Credit
 * due Green Cross", with the working printed underneath confirming itself ("38 budtenders ×
 * $0.75"). The buy list would have been short by the same amount, and named nobody at all.
 *
 * THE SAME BUG HAD ALREADY BEEN FOUND AND FIXED TWICE — in the progress stats strip and in
 * pullActuals, both of which carry a comment about it. It survived because the formula was written
 * out by hand in three more places, and fixing the two that were noticed did not touch them. So
 * the rule has one home now, and this file's real job is to keep it that way: a fourth output must
 * not be able to get it wrong by being written later.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. THE RULE, ACTUALLY RUN ══════════════════ */
const F = new Function([
  grab('moneyStr_'), grab('payoutModelOf_'), grab('payoutRateOf_'), grab('payoutFactsOf_'),
  'return payoutFactsOf_;'
].join('\n'))();

/* Portland Heights, exactly as the record holds it. */
const ph = F({ payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 0.75 },
               actual_json: { units_sold: 242, bts_hit: 38, spiff_amount: 0.75, investment: 181.5 } });
ok('a per-unit program owes rate × UNITS', ph.owed === 181.5);
ok('  …not rate × earners, which is the bug', ph.owed !== 28.5);
ok('  …and says so in its working', /242 units × \$0\.75 a unit/.test(ph.basis));
ok('  …with labels that match the model',
   ph.rate_label === 'SPIFF per unit sold' && ph.earner_label === 'Budtenders who earned');

/* A flat program must be unchanged by the fix. */
const flat = F({ payout_type: 'flat', payout_json: { model: 'flat', amount: 25 },
                 actual_json: { units_sold: 168, bts_hit: 5, spiff_amount: 25, investment: 125 } });
ok('a flat program still owes rate × budtenders who hit', flat.owed === 125);
ok('  …and says so in its working', /5 budtenders × \$25\.00/.test(flat.basis));
ok('  …with the per-budtender labels', flat.rate_label === 'SPIFF per budtender');
ok('one budtender is not "1 budtenders"',
   /1 budtender × /.test(F({ payout_json: { model: 'flat', amount: 25 },
      actual_json: { bts_hit: 1, spiff_amount: 25, investment: 25 } }).basis));

/* The reconciled figure is what a human verified; the computation is the fallback. */
const noStored = F({ payout_json: { model: 'per_unit', amount: 0.75 },
                     actual_json: { units_sold: 242, bts_hit: 38, spiff_amount: 0.75 } });
ok('with no recorded investment it falls back to the model computation', noStored.owed === 181.5);
const zero = F({ payout_json: { model: 'flat', amount: 25 },
                 actual_json: { units_sold: 0, bts_hit: 0, spiff_amount: 25, investment: 0 } });
ok('a genuine zero is honored, not treated as missing', zero.owed === 0 && !zero.mismatch);

/* A DISAGREEMENT IS REPORTED, never silently resolved — this goes to a vendor. */
const bad = F({ payout_json: { model: 'per_unit', amount: 0.75 },
                actual_json: { units_sold: 242, bts_hit: 38, spiff_amount: 0.75, investment: 28.5 } });
ok('a stored total that disagrees with the working is flagged',
   !!bad.mismatch && bad.mismatch.stored === 28.5 && bad.mismatch.computed === 181.5);
ok('  …and the RECORD still wins, so the document shows what was reconciled', bad.owed === 28.5);
ok('a penny-level float difference is not a mismatch',
   !F({ payout_json: { model: 'per_unit', amount: 0.1 },
        actual_json: { units_sold: 3, spiff_amount: 0.1, investment: 0.3 } }).mismatch);
/* tiered is schema'd and unimplemented — it must resolve to flat, not pay nothing. */
ok('an unimplemented model resolves to flat rather than to zero',
   F({ payout_json: { model: 'tiered', amount: 25 },
       actual_json: { bts_hit: 4, spiff_amount: 25 } }).owed === 100);

/* ══════════════════ 2. ALL THREE OUTPUTS USE IT ══════════════════ */
['reportHtml_', 'emailDraft_', 'giftCardList_'].forEach(fn => {
  const f = grab(fn);
  ok(fn + ' takes its total from the one shared rule', /payoutFactsOf_\(/.test(f));
  ok('  …and no longer computes bts_hit × rate itself',
     !/\(a\.bts_hit \|\| 0\) \* rate/.test(f));
});
/* The formula must not survive anywhere. */
ok('the flat formula is written nowhere by hand any more',
   !/\(a\.bts_hit \|\| 0\) \* rate/.test(gs));
ok('the PDF prints the basis rather than a hardcoded "budtenders ×" line',
   /esc\(f\.basis\)/.test(grab('reportHtml_')));
ok('the email states the basis beside the total',
   /\+ f\.basis \+/.test(grab('emailDraft_')));
ok('  …and carries a warning field the UI can gate on',
   /warning: f\.mismatch/.test(grab('emailDraft_')));
ok('the PDF shows a mismatch ON the document',
   /Verify before sending/.test(grab('reportHtml_')));

/* ══════════════════ 3. WHO SOLD WHAT, IN ONE PLACE ══════════════════
   The source selection used to live inside giftCardList_. It now lives in measuredRowsFor_,
   because the vendor PDF needs the identical answer — a buy list and the report sent alongside it
   naming different people would be worse than either being wrong alone. Same argument
   payoutFactsOf_ settles for the money. */
const gc = grab('giftCardList_');
const mr = grab('measuredRowsFor_');

ok('the buy list is no longer hardcoded empty', !/lines: \[\],/.test(gc));
ok('the frozen snapshot wins — it is what the vendor was invoiced against',
   mr.indexOf('progress_json') < mr.indexOf('spiffProgress_'));
ok('  …with the live cache as the fallback, read through the same function consumers read',
   /spiffProgress_\(\{ program: prog\.program_id/.test(mr));
ok('  …carrying per-store units, so the PDF\'s Sold column stops printing an em dash',
   /byStore\[st\.store_id\] = Number\(st\.units\)/.test(mr) && /by_store: byStore/.test(mr));
/* A snapshot row holds only what Dutchie reported. */
ok('snapshot names are decorated the way every other surface decorates them',
   /friendlyName_\(nameMap, e\.employee_id, legal\)/.test(mr));
ok('  …and BOTH names travel — the card needs one, reconciling needs the other',
   /legal_name: legal/.test(mr));

ok('the buy list lists only people who actually EARNED, not who sold',
   /\(Number\(r\.earned\) \|\| 0\) > 0/.test(gc));
ok('  …biggest amount first, because it is a shopping list', /y\.amount - x\.amount/.test(gc));
ok('  …and it no longer carries its own copy of the source selection',
   gc.indexOf('progress_json') < 0 && gc.indexOf('displayNameMap_') < 0);
/* The list and the invoice must agree, or somebody buys cards against the wrong number. */
ok('a list that does not add up to the recorded total is flagged',
   /Reconcile before buying cards/.test(gc));
ok('  …and owing money with nobody named is flagged too', /nobody can be named/.test(gc));
ok('the authoritative total stays the record\'s, the figure the vendor is invoiced',
   /total: f\.owed/.test(gc));
ok('  …with what the names sum to reported separately', /listed_total/.test(gc));
ok('  …and it reports where its numbers came from', /source: measured\.source/.test(gc));
/* The stale note claiming the detail does not exist must be gone. Checked as an EMITTED note:
   the comments quote the old wording to explain what changed. */
ok('the note claiming per-budtender detail is unavailable is no longer returned',
   !/note:\s*'Per-budtender names require/.test(gs));

/* ══════════════════ 4. THE VENDOR PDF GETS THE MATRIX TOO ══════════════════
   The FOURTH output in this family wired to nothing. buildReport_ called reportHtml_(prog, null)
   unconditionally, so the PDF printed "Per-budtender breakdown is not included: this program's
   sell-through was recorded in aggregate" on programs carrying exactly that matrix — Portland
   Heights has 38 budtenders across six stores, frozen since 2026-09-02 — and an em dash in the
   per-store Sold column for every one. The report format this app replaces IS the matrix. */
const br = grab('buildReport_');
ok('the vendor PDF is built WITH the measurements',
   /reportHtml_\(prog, measured\)/.test(br));
/* Checked as a CALL — the comment above buildReport_ quotes the old line to explain the fix. */
ok('  …and reportHtml_ is never CALLED with a hardcoded null again',
   !/Utilities\.newBlob\(reportHtml_\(prog, null\)/.test(gs));
ok('  …from the shared source selection, not a third copy',
   /measuredRowsFor_\(prog\)/.test(br));
ok('  …reporting what actually went on the document',
   /budtenders: measured\.rows\.length/.test(br) && /measured_from: measured\.source/.test(br));
ok('the PDF still says so plainly when there IS nothing to include',
   /Per-budtender breakdown is not included/.test(grab('reportHtml_')));

console.log(fail ? '\n' + fail + ' FAILED' : '\ncloseout money: all passed');
process.exit(fail ? 1 : 0);
