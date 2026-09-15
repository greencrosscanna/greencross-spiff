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
const G = require('./_gas');

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

/* ── THE THREE DOCUMENTS, BUILT FOR REAL ─────────────────────────────────────────────────────────
   Sections 2-4 used to be regexes over reportHtml_, emailDraft_, giftCardList_ and buildReport_ —
   which is the wrong place in this app to be reading rather than running, because these are the
   outputs that carry a dollar figure to a vendor. `/payoutFactsOf_\(/` proves the shared rule is
   CALLED; it cannot notice that the number printed beside it came from somewhere else. Everything
   below assembles the real functions and reads the documents they produce.

   PORTLAND HEIGHTS, as the record holds it: per_unit at $0.75, 242 units, $181.50 reconciled, and
   a frozen snapshot of 38 budtenders across six stores. The wrong answer this file exists to catch
   is $28.50. */
const DOC = G.load({
  real: ['reportHtml_', 'emailDraft_', 'giftCardList_', 'buildReport_', 'measuredRowsFor_',
         'payoutFactsOf_', 'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_',
         'friendlyName_', 'userKey_', 'scrubSecrets_', 'today_'],
  vars: ['EDIT_ROLES', 'LOGO_ONLIGHT', 'GX_SECRET_PROP'],
  stubs: {
    getProgram_: (id) => (id === PH.program_id ? { ok: true, program: PH }
                        : id === FLAT.program_id ? { ok: true, program: FLAT }
                        : id === NOSNAP.program_id ? { ok: true, program: NOSNAP }
                        : id === MISMATCH.program_id ? { ok: true, program: MISMATCH }
                        : { ok: false, error: 'not found: ' + id }),
    /* The six stores as Command Center serves them — the document must print what people call the
       shop, not the slug. */
    gxStores_: () => ([
      { store_id: 'river-rd', display_name: 'River Rd' },
      { store_id: 'commercial', display_name: 'Commercial St' },
      { store_id: 'bend', display_name: 'Bend' },
    ]),
    /* The roster map in its real shape — friendlyName_ reads byId first, byName as the fallback,
       which is why 'JO B' below stays exactly as Dutchie reported it. */
    displayNameMap_: () => ({ byId: { e1: 'Sky', e2: 'Tawny' }, byName: {} }),
    spiffProgress_: () => LIVE,
    gxAuth_: () => AUTH,
    /* Drive, captured: what would have been written, and with what name. */
    DriveApp_unused_: () => null,
  },
  globals: {
    PropertiesService: G.makeProps({ GX_DEPLOY_SECRET: 'SEKRET' }).PropertiesService,
    console: { warn() {}, log() {} },
    /* Utilities.newBlob is where the HTML becomes a PDF. Kept as a pass-through so the assertions
       can read the document that was actually filed, rather than trusting that the call happened. */
    Utilities: Object.assign({}, G.Utilities, {
      newBlob: (html) => ({ html: html,
        getAs: () => ({ setName: (n) => ({ html: html, name: n }) }) }),
    }),
    DriveApp: { getFolderById: (id) => ({ createFile: (blob) => { FILED.push({ folder: id, blob: blob });
      return { getId: () => 'file-1', getUrl: () => 'https://drive/file-1' }; } }) },
    REPORT_FOLDER_ID: 'folder-1',
  },
});
let AUTH = { ok: true, user: 'tawny', role: 'editor' };
const FILED = [];
let LIVE = { ok: false };

/* A snapshot the way snapshotProgram_ freezes one: per store, per person, with `earned` already
   computed by the measurement. */
function snapshot() {
  return { at: '2026-09-02T18:00:00Z', stores: [
    { store_id: 'river-rd', units: 140, rows: [
      { name: 'SKYLER P', employee_id: 'e1', units: 80, hit: true, earned: 60 },
      { name: 'JO B', employee_id: 'e9', units: 60, hit: true, earned: 45 } ] },
    { store_id: 'commercial', units: 102, rows: [
      { name: 'TAWNY R', employee_id: 'e2', units: 102, hit: true, earned: 76.5 },
      { name: 'NOBODY N', employee_id: 'e8', units: 0, hit: false, earned: 0 } ] },
  ] };
}
const PH = {
  program_id: 'portland-heights-2026-08-17-2026-08-30', vendor: 'Green Cross',
  program_name: 'Portland Heights', status: 'closed',
  start_date: '2026-08-17', end_date: '2026-08-30',
  stores_json: ['river-rd', 'commercial'],
  payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 0.75 },
  target_json: { units: 300, by_store: { 'river-rd': 180, commercial: 120 }, per_bt: {} },
  actual_json: { units_sold: 242, bts_hit: 38, spiff_amount: 0.75, investment: 181.5 },
  progress_json: snapshot(),
};
/* A flat program, where the target IS the point: $25 a head, 5 of them. */
const FLAT = {
  program_id: 'mule-0831', vendor: 'Mule', program_name: 'Mule Extracts 2g', status: 'closed',
  start_date: '2026-08-31', end_date: '2026-09-13', stores_json: ['river-rd'],
  payout_type: 'flat', payout_json: { model: 'flat', amount: 25 },
  target_json: { units: 200, by_store: { 'river-rd': 200 }, per_bt: { 'river-rd': 5 } },
  actual_json: { units_sold: 168, bts_hit: 5, spiff_amount: 25, investment: 125 },
  progress_json: { at: '2026-09-14T18:00:00Z', stores: [
    { store_id: 'river-rd', units: 168, rows: [
      { name: 'SKYLER P', employee_id: 'e1', units: 40, hit: true, earned: 25 },
      { name: 'JO B', employee_id: 'e9', units: 2, hit: false, earned: 0 } ] } ] },
};
/* The same program with a recorded total nobody can account for: $400 invoiced against $181.50 of
   named earnings. Somebody has to look at that before cards are bought. */
const MISMATCH = Object.assign({}, PH, { program_id: 'mismatch-0817',
  actual_json: Object.assign({}, PH.actual_json, { investment: 400 }) });
/* No snapshot: the live cache is the fallback, read through the same function consumers read. */
const NOSNAP = Object.assign({}, FLAT, { program_id: 'nosnap-0901', progress_json: null });

/* ══════════════════ 2. ALL THREE OUTPUTS PRINT THE SAME MONEY ══════════════════ */
{
  const email = DOC.emailDraft_({ id: PH.program_id });
  const cards = DOC.giftCardList_({ id: PH.program_id });
  const html  = DOC.reportHtml_(PH, DOC.measuredRowsFor_(PH));

  ok('the email asks the vendor for $181.50', /Total credit due:  \$181\.50/.test(email.body));
  ok('  …and not the $28.50 the flat formula gives', email.body.indexOf('28.50') < 0);
  ok('  …with the working printed beside it', /242 units × \$0\.75 a unit/.test(email.body));
  ok('  …and the credit repeated in the ask, so both figures are the same number',
     (email.body.match(/\$181\.50/g) || []).length >= 2);
  ok('the buy list\'s authoritative total is $181.50 too', cards.total === 181.5);
  ok('the PDF prints $181.50 as the credit due',
     /\$181\.50/.test(html) && html.indexOf('$28.50') < 0);
  ok('  …and prints the basis rather than a hardcoded "budtenders ×" line',
     /242 units × \$0\.75 a unit/.test(html));

  /* A flat program must be unchanged by the fix. */
  const fEmail = DOC.emailDraft_({ id: FLAT.program_id });
  const fCards = DOC.giftCardList_({ id: FLAT.program_id });
  ok('a flat program still bills rate × budtenders who hit',
     /Total credit due:  \$125\.00/.test(fEmail.body) && fCards.total === 125);
  ok('  …and says so in its working', /5 budtenders × \$25\.00/.test(fEmail.body));
  ok('the email labels the rate the way the model means it',
     /SPIFF per unit sold: \$0\.75/.test(email.body)
     && /SPIFF per budtender: \$25\.00/.test(fEmail.body));
}
/* A DISAGREEMENT REACHES THE DOCUMENT, never resolved silently — this goes to a vendor. */
{
  const bad = Object.assign({}, PH, {
    actual_json: Object.assign({}, PH.actual_json, { investment: 28.5 }) });
  const email = DOC.emailDraft_({ id: PH.program_id });
  ok('a clean record draws no warning', !email.warning);
  const html = DOC.reportHtml_(bad, DOC.measuredRowsFor_(bad));
  ok('a stored total that disagrees with the working is called out ON the PDF',
     /Verify before sending/.test(html));
  ok('  …naming both numbers, so the reader can tell which is wrong',
     /\$28\.50/.test(html) && /\$181\.50/.test(html));
}
/* The formula must not survive anywhere — one home for the rule is the whole point. */
ok('the flat formula is written nowhere by hand any more',
   !/\(a\.bts_hit \|\| 0\) \* rate/.test(gs));

/* ══════════════════ 3. WHO SOLD WHAT, IN ONE PLACE ══════════════════ */
{
  const m = DOC.measuredRowsFor_(PH);
  ok('the frozen snapshot is what gets measured — it is what the vendor was invoiced against',
     /frozen snapshot, measured 2026-09-02/.test(m.source));
  ok('  …with every person on it', m.rows.length === 4);
  ok('  …per-store units carried through, so the PDF\'s Sold column is not an em dash',
     m.by_store['river-rd'] === 140 && m.by_store.commercial === 102);
  ok('  …most sold first, because the vendor reads the top of the table',
     m.rows[0].units === 102 && m.rows[m.rows.length - 1].units === 0);
  ok('names are decorated the way every other surface decorates them',
     m.rows.some(r => r.name === 'Tawny') && m.rows.some(r => r.name === 'Sky'));
  ok('  …and an undecorated name falls back to what Dutchie reported',
     m.rows.some(r => r.name === 'JO B'));
  ok('  …with BOTH names travelling: the card needs one, reconciling needs the other',
     m.rows.filter(r => r.name === 'Tawny')[0].legal_name === 'TAWNY R');

  const cards = DOC.giftCardList_({ id: PH.program_id });
  ok('the buy list names people — it is no longer empty', cards.count === 3 && cards.lines.length === 3);
  ok('  …only those who actually EARNED, not everyone who sold',
     cards.lines.every(l => l.amount > 0) && !cards.lines.some(l => l.legal_name === 'NOBODY N'));
  ok('  …biggest amount first, because it is a shopping list',
     cards.lines[0].amount === 76.5 && cards.lines[2].amount === 45);
  ok('  …with the store on each line, since cards are handed out per shop',
     cards.lines[0].store === 'commercial');
  ok('what the names add up to is reported beside the authoritative total',
     cards.listed_total === 181.5 && cards.total === 181.5);
  ok('  …and it says where its numbers came from', /frozen snapshot/.test(cards.source));
  ok('the buy list and the PDF name the same people, from the same source',
     DOC.measuredRowsFor_(PH).source === cards.source);
}
/* A list that does not add up to the invoice is FLAGGED — otherwise somebody buys cards against
   the wrong number, and the shortfall arrives later as an unhappy budtender. */
{
  const cards = DOC.giftCardList_({ id: MISMATCH.program_id });
  ok('a buy list that does not add up to the recorded total is flagged',
     /Reconcile before buying cards/.test(cards.warning || ''));
  ok('  …naming both figures, the invoice\'s and the list\'s',
     cards.total === 400 && cards.listed_total === 181.5);
  ok('the clean record raises nothing', !DOC.giftCardList_({ id: PH.program_id }).warning);
}
{
  /* Nobody named, money owed: the case where the list cannot be acted on at all. */
  const empty = Object.assign({}, FLAT, { program_id: 'nosnap-0901' });
  LIVE = { ok: true, refreshed_at: '2026-09-15 08:00', rows: [] };
  const cards = DOC.giftCardList_({ id: 'nosnap-0901' });
  ok('owing money with nobody named is flagged rather than handed over as an empty list',
     cards.count === 0 && /nobody can be named/.test(cards.warning || ''));
}
{
  /* The live cache is the fallback for a program with no snapshot — same function consumers read. */
  LIVE = { ok: true, refreshed_at: '2026-09-15 08:00:00', rows: [
    { program_id: 'nosnap-0901', store_id: 'river-rd', employee_id: 'e1', name: 'SKYLER P',
      display_name: 'Sky', units: 40, target: 5, hit: true, earned: 25 } ] };
  const m = DOC.measuredRowsFor_(NOSNAP);
  ok('with no snapshot it reads the live cache instead', /live cache, refreshed 2026-09-15/.test(m.source));
  ok('  …and takes the decorated name the route already resolved', m.rows[0].name === 'Sky');
  LIVE = { ok: false, error: 'could not read the programs tab' };
  const none = DOC.measuredRowsFor_(NOSNAP);
  ok('a refused read yields no rows rather than inventing zeros',
     none.rows.length === 0 && none.source === '');
}

/* ══════════════════ 4. THE VENDOR PDF GETS THE MATRIX TOO ══════════════════ */
{
  const html = DOC.reportHtml_(PH, DOC.measuredRowsFor_(PH));
  ok('the per-budtender table is on the document', /<h2>By budtender<\/h2>/.test(html));
  ok('  …with all four people, named', /Tawny/.test(html) && /Sky/.test(html) && /JO B/.test(html));
  ok('stores are NAMED, not slugged — this document leaves the building',
     /River Rd/.test(html) && /Commercial St/.test(html) && html.indexOf('>river-rd<') < 0);
  ok('  …and the per-store Sold column carries real units, not an em dash',
     />140</.test(html) && />102</.test(html));
  /* "242 UNITS SOLD / 0 TARGET" on a program that set no per-person target reads as a miss. */
  ok('a per-unit program prints no Target column at all', html.indexOf('>Target<') < 0);
  ok('  …and shows what each person EARNED instead', /<th class="n">Earned<\/th>/.test(html)
     && /\$76\.50/.test(html));
  const flatHtml = DOC.reportHtml_(FLAT, DOC.measuredRowsFor_(FLAT));
  ok('a flat program still gets Target and Hit, where the target is the point',
     /<th class="n">Target<\/th>/.test(flatHtml) && /<th>Hit<\/th>/.test(flatHtml)
     && /✓/.test(flatHtml));
  ok('  …with the per-budtender goal off the PROGRAM, never the snapshot row\'s zero',
     />5</.test(flatHtml) && !/TARGET 0/.test(flatHtml));
  ok('the title line does not print the vendor twice when it IS the program name',
     (flatHtml.match(/Mule Extracts 2g/g) || []).length >= 1
     && flatHtml.indexOf('Mule · Mule Extracts 2g') < 0);
  ok('the PDF still says so plainly when there IS nothing to include',
     /Per-budtender breakdown is not included/.test(DOC.reportHtml_(PH, { rows: [], by_store: {} })));
}
/* buildReport_ is the fourth output in this family, and it wired to nothing: reportHtml_(prog,
   null) unconditionally, so every PDF claimed the breakdown was unavailable. */
{
  FILED.length = 0;
  const r = DOC.buildReport_({ token: 'tok', id: PH.program_id });
  ok('the vendor PDF is filed, named by the folder\'s own precedent',
     r.ok === true && /^SPIFF_Sales Report - Green Cross - \d{6}\.pdf$/.test(r.name));
  ok('  …to the close-out folder', FILED.length === 1 && FILED[0].folder === 'folder-1');
  ok('  …and it is built WITH the measurements, not a hardcoded null',
     r.budtenders === 4 && /frozen snapshot/.test(r.measured_from));
  ok('  …with the matrix really in the bytes that were filed',
     /<h2>By budtender<\/h2>/.test(FILED[0].blob.html) && /\$181\.50/.test(FILED[0].blob.html));
  AUTH = { ok: false, error: 'Session expired' };
  ok('no session files nothing', DOC.buildReport_({ id: PH.program_id }).needsAuth === true);
  AUTH = { ok: true, user: 'gx-dev', role: 'viewer' };
  FILED.length = 0;
  const v = DOC.buildReport_({ token: 'tok', id: PH.program_id });
  ok('a viewer cannot file a vendor report',
     v.ok === false && /cannot file reports/.test(v.error) && FILED.length === 0);
  AUTH = { ok: true, user: 'tawny', role: 'editor' };
}
/* Nothing sends TO A VENDOR. A vendor hears from Tawny, not from an app. The engine does mail —
   bug-report notifications go out through MailApp — so the claim worth holding is narrower and is
   about these two functions: neither the draft nor the report may acquire a send call. */
ok('the draft and the report contain no send call of their own',
   !/MailApp\.|GmailApp\./.test(G.grab('emailDraft_'))
   && !/MailApp\.|GmailApp\./.test(G.grab('buildReport_')));
ok('  …and the draft hands back TEXT for a human, with a subject and a body',
   (() => { const d = DOC.emailDraft_({ id: PH.program_id });
            return typeof d.body === 'string' && /^SPIFF results/.test(d.subject); })());
ok('  …and the draft says what to attach rather than attaching it itself',
   /Attach the PDF saved to the SPIFF close-out folder/.test(DOC.emailDraft_({ id: PH.program_id }).attach_hint));

console.log(fail ? '\n' + fail + ' FAILED' : '\ncloseout money: all passed');
process.exit(fail ? 1 : 0);
