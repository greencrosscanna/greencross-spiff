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
  grab('moneyStr_'), grab('payoutModelOf_'), grab('payoutAfterGoal_'), grab('payoutRateOf_'), grab('payoutFactsOf_'),
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
const PROPS = G.makeProps({ GX_DEPLOY_SECRET: 'SEKRET' });
let LOCK_OK = true;
const FETCHED = [];
let MAILER = () => ({ ok: true, from: 'tawny@greencrosscanna.com' });
const DOC = G.load({
  real: ['reportHtml_', 'emailDraft_', 'giftCardList_', 'giftCardListFor_', 'buildReport_', 'measuredRowsFor_',
         'payoutFactsOf_', 'payoutModelOf_', 'payoutAfterGoal_', 'payoutRateOf_', 'moneyStr_', 'slug_',
         'friendlyName_', 'userKey_', 'scrubSecrets_', 'today_',
         'brandPaperHtml_', 'unitLiftOf_', 'brandProgramLabel_', 'prettyDay_', 'brandPdfBlob_',
         'brandFromAddress_', 'sendBrandEmail_', 'brandSignatureHtml_',
         'storeSectionsOf_', 'storeBlockHtml_',
         'brandMailer_', 'callBrandMailer_', 'setBrandMailerWeb_'],
  vars: ['EDIT_ROLES', 'LOGO_ONLIGHT', 'GX_SECRET_PROP', 'BTS_PER_STORE',
         'BRAND_FROM_PROP', 'BRAND_SENT_PREFIX', 'BRAND_FROM_DEFAULT',
         'BRAND_MAILER_URL_PROP', 'BRAND_MAILER_SECRET_PROP',
         'BRAND_SIGNER_NAME', 'BRAND_SIGNER_TITLE', 'BRAND_SIG_LOGO', 'BRAND_SIG_LOCATIONS'],
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
    nowStamp_: () => '2026-09-30 12:00:00',
    /* Drive, captured: what would have been written, and with what name. */
    DriveApp_unused_: () => null,
  },
  globals: {
    PropertiesService: PROPS.PropertiesService,
    LockService: { getScriptLock: () => ({ tryLock: () => LOCK_OK, releaseLock() {} }) },
    console: { warn() {}, log() {} },
    /* Utilities.newBlob is where the HTML becomes a PDF. Kept as a pass-through so the assertions
       can read the document that was actually filed, rather than trusting that the call happened. */
    Utilities: Object.assign({}, G.Utilities, {
      newBlob: (html) => ({ html: html,
        getAs: () => ({ setName: (n) => ({ html: html, name: n, getName: () => n,
                                           getBytes: () => Buffer.from(html, 'utf8') }) }) }),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
    }),
    /* Tawny's mailer, captured: every POST the engine made, answered by MAILER(body). */
    UrlFetchApp: { fetch: (url, opts) => {
      const body = JSON.parse(opts.payload);
      FETCHED.push({ url, opts, body });
      const a = MAILER(body, url);
      if (a instanceof Error) throw a;
      return { getResponseCode: () => a.code || 200,
               getContentText: () => (typeof a.text === 'string' ? a.text : JSON.stringify(a)) };
    } },
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

  /* BTs column on the vendor PDF's By-store table (Sky, 2026-09-30): the fixed norm of six. */
  ok('the By-store table has a BTs column', /<th>Store<\/th><th class="n">BTs<\/th>/.test(html));
  ok('  …and every store row carries six',
     (html.match(/<td class="n">6<\/td>/g) || []).length >= (PH.stores_json || []).length);

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
  ok('  …and shows what each person EARNED instead', />Earned</.test(html)
     && /\$76\.50/.test(html));
  const flatHtml = DOC.reportHtml_(FLAT, DOC.measuredRowsFor_(FLAT));
  ok('a flat program still gets Target and Hit, where the target is the point',
     />Target</.test(flatHtml) && />Hit</.test(flatHtml)
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

/* ══════════════════ 5. SENDING THE BRAND EMAIL FROM THE APP ══════════════════
   Sky, 2026-09-30; through Tawny's mailer only since 2026-11-17. These run the real route with the
   mailer captured, because the claims that matter are about what goes on the wire and what is
   refused: who it must come FROM, what is attached, that no budtender is named, and that nothing
   is sent when it should not be. */
{
  const ARG = { token: 't', id: PH.program_id, to: 'Rep@Brand.com', subject: 'SPIFF results' };
  const P = PROPS.props;
  const sends = () => FETCHED.filter((f) => f.body.action === 'send').map((f) => f.body);
  const attHtml = (b) => Buffer.from(b.attachment.base64, 'base64').toString('utf8');

  P.BRAND_EMAIL_FROM = '';
  ok('with no property set the sender is Tawny\'s address, never the account itself',
     DOC.brandFromAddress_() === 'tawny@greencrosscanna.com');
  P.BRAND_EMAIL_FROM = 'other@greencrosscanna.com';
  ok('the script property overrides the default', DOC.brandFromAddress_() === 'other@greencrosscanna.com');
  let r;

  P.BRAND_EMAIL_FROM = 'tawny@greencrosscanna.com';
  delete P.BRAND_MAILER_URL; delete P.BRAND_MAILER_SECRET;
  FETCHED.length = 0;
  r = DOC.sendBrandEmail_(ARG);
  ok('with no mailer connected nothing is sent, and it says to copy the email instead',
     r.ok === false && /mailer is not connected/.test(r.error) && FETCHED.length === 0);
  ok('  …and the draft does not offer Send to brand',
     DOC.emailDraft_({ id: PH.program_id }).send_ready === false);

  P.BRAND_MAILER_URL = 'https://script.google.com/macros/s/AKfyc-abc_123/exec';
  P.BRAND_MAILER_SECRET = 'S'.repeat(64);
  MAILER = () => ({ ok: true, from: 'tawny@greencrosscanna.com' });

  AUTH = { ok: true, user: 'viewer1', role: 'viewer' };
  r = DOC.sendBrandEmail_(ARG);
  ok('a read-only role cannot send', r.ok === false && sends().length === 0);
  AUTH = { ok: true, user: 'tawny', role: 'editor' };

  ok('a bad address is refused',
     DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'not-an-email' })).ok === false
     && DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'a@b.com, c@d.com' })).ok === false
     && sends().length === 0);

  r = DOC.sendBrandEmail_(ARG);
  const m = sends()[0] || {};
  ok('an editor can send, to the lowercased address', r.ok === true && m.to === 'rep@brand.com');
  ok('it asks the mailer to prove it runs as Tawny, and reports that it went through her mailer',
     m.expect_from === 'tawny@greencrosscanna.com' && r.via === 'tawny-mailer');
  ok('the HTML body carries the credit and the BTs column',
     /\$181\.50/.test(m.html) && />BTs</.test(m.html));
  ok('  …and NO budtender is named in what the brand receives',
     !/SKYLER|TAWNY R|JO B|NOBODY/i.test(m.html) && !/SKYLER|TAWNY R|JO B|NOBODY/i.test(attHtml(m)));
  ok('the email ends with Tawny\'s signature: name, title, website and the LOCATIONS button',
     /Tawny Vierra/.test(m.html) && /<br>Inventory Manager</.test(m.html)
     && /GreenCrossCanna\.com/.test(m.html) && /alt="Locations"/.test(m.html)
     && /greencrosscanna\.com\/#locations/.test(m.html));
  ok('  …with her own logo at its real proportions (width only, never a forced height) and no phone number',
     /alt="Green Cross" width="125" style/.test(m.html) && !/tel:|646-8914/.test(m.html));
  ok('  …and the plain-text fallback is signed the same way',
     /Tawny Vierra\nInventory Manager/.test(m.text));
  ok('  …and the attached PDF carries no signature (it is the report alone)',
     !/Locations/.test(attHtml(m)));
  ok('one PDF attached, the brand copy, named for the brand',
     /^Green Cross SPIFF Results - Green Cross - \d{6}\.pdf$/.test(m.attachment.name));

  const before = sends().length;
  r = DOC.sendBrandEmail_(ARG);
  ok('the same program to the same address is refused the second time',
     r.ok === false && r.already === true && sends().length === before);
  ok('  …unless resend is asked for on purpose',
     DOC.sendBrandEmail_(Object.assign({}, ARG, { resend: '1' })).ok === true && sends().length === before + 1);
  ok('  …and a different address is not blocked by it',
     DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'other@brand.com' })).ok === true);

  MAILER = () => ({ ok: false, error: 'The daily limit of 40 vendor emails is reached. Try tomorrow.' });
  r = DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'fresh@brand.com' }));
  ok('a mailer failure is reported, not swallowed, and is not recorded as sent',
     r.ok === false && /Could not send: The daily limit/.test(r.error)
     && !/fresh@brand\.com/.test(P[DOC.BRAND_SENT_PREFIX + PH.program_id] || ''));
  MAILER = () => ({ ok: true, from: 'tawny@greencrosscanna.com' });
  ok('  …so a retry after the failure is allowed',
     DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'fresh@brand.com' })).ok === true);

  LOCK_OK = false;
  ok('a concurrent send is refused rather than doubled',
     DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'locked@brand.com' })).ok === false);
  LOCK_OK = true;

  ok('the draft preview is the same brand page, and says whether sending is ready',
     (() => { const d = DOC.emailDraft_({ id: PH.program_id });
              return d.send_ready === true && /Credit requested/.test(d.html) && !/SKYLER/.test(d.html); })());

  ok('the engine has no Gmail path at all: no GmailApp, no full-Gmail permission',
     (() => { const fs = require('fs'), path = require('path');
              const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '');
              const man = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8');
              return !/GmailApp/.test(src) && !/mail\.google\.com/.test(man); })());
  ok('  …and Send to brand sends only through the mailer, never MailApp from this account',
     !/MailApp\./.test(G.grab('sendBrandEmail_')) && /callBrandMailer_/.test(G.grab('sendBrandEmail_')));
}

/* ══════════════════ 6. SENDING THROUGH TAWNY'S OWN MAILER ══════════════════
   Sky, 2026-11-16: no more delegate on her mailbox. tawny-mailer/ runs as Tawny; the engine pairs
   with it once, then every "Send to brand" goes through it. What matters: nothing is saved unless
   pairing worked, a mailer running as the wrong person is flagged, a connected mailer is the ONLY
   path (no quiet fallback to Sky's alias), and a send that may have gone out says so. */
{
  const URL_ = 'https://script.google.com/macros/s/AKfyc-abc_123/exec';
  const P = PROPS.props;
  const ARG = { token: 't', id: PH.program_id, to: 'Rep@Brand.com', subject: 'SPIFF results', resend: '1' };
  P.BRAND_EMAIL_FROM = 'tawny@greencrosscanna.com';
  delete P.BRAND_MAILER_URL; delete P.BRAND_MAILER_SECRET;
  FETCHED.length = 0;
  let r;

  ok('connecting needs the deploy secret',
     DOC.setBrandMailerWeb_({ url: URL_, apply: '1' }).error === 'Unauthorized' && FETCHED.length === 0);
  ok('only an Apps Script /exec address is accepted',
     DOC.setBrandMailerWeb_({ secret: 'SEKRET', url: 'https://evil.example.com/exec', apply: '1' }).ok === false
     && FETCHED.length === 0);
  r = DOC.setBrandMailerWeb_({ secret: 'SEKRET', url: URL_ });
  ok('without apply=1 it is a dry run: nothing called, nothing saved',
     r.dry === true && FETCHED.length === 0 && !P.BRAND_MAILER_URL);

  MAILER = (b) => (b.action === 'pair' ? { ok: false, already_paired: true, error: 'Already paired.' } : { ok: true });
  r = DOC.setBrandMailerWeb_({ secret: 'SEKRET', url: URL_, apply: '1' });
  ok('a failed pairing saves nothing', r.ok === false && /Pairing failed/.test(r.error)
     && !P.BRAND_MAILER_URL && !P.BRAND_MAILER_SECRET);

  FETCHED.length = 0;
  MAILER = (b) => ({ ok: true, from: 'sky@greencrosscanna.com', paired: b.action === 'pair' });
  r = DOC.setBrandMailerWeb_({ secret: 'SEKRET', url: URL_, apply: '1' });
  ok('a mailer deployed by the wrong person is flagged by name',
     r.ok === false && r.sends_as === 'sky@greencrosscanna.com' && /not tawny@greencrosscanna\.com/.test(r.error));

  FETCHED.length = 0; delete P.BRAND_MAILER_URL; delete P.BRAND_MAILER_SECRET;
  MAILER = () => ({ ok: true, from: 'tawny@greencrosscanna.com', quota_left: 1500 });
  r = DOC.setBrandMailerWeb_({ secret: 'SEKRET', url: URL_, apply: '1' });
  ok('pairing hands the mailer the secret it then stores, and confirms it sends as Tawny',
     r.ok === true && r.sends_as === 'tawny@greencrosscanna.com'
     && FETCHED[0].body.action === 'pair' && FETCHED[0].body.secret === P.BRAND_MAILER_SECRET
     && P.BRAND_MAILER_URL === URL_ && FETCHED[1].body.action === 'ping');

  FETCHED.length = 0;
  r = DOC.sendBrandEmail_(ARG);
  const sent = (FETCHED[0] || {}).body || {};
  ok('once connected, Send to brand goes through the mailer and NOT through Sky\'s Gmail',
     r.ok === true && r.via === 'tawny-mailer' && FETCHED.length === 1);
  ok('  …to the lowercased address, asking the mailer to prove it is Tawny',
     sent.action === 'send' && sent.to === 'rep@brand.com' && sent.expect_from === 'tawny@greencrosscanna.com'
     && sent.secret === P.BRAND_MAILER_SECRET);
  ok('  …with the same brand page: the credit, and no budtender named',
     /\$181\.50/.test(sent.html) && !/SKYLER|TAWNY R|JO B|NOBODY/i.test(sent.html));
  ok('  …and the brand PDF attached, named for the brand',
     /^Green Cross SPIFF Results - Green Cross - \d{6}\.pdf$/.test(sent.attachment.name)
     && !/SKYLER|TAWNY R|JO B|NOBODY/i.test(Buffer.from(sent.attachment.base64, 'base64').toString('utf8')));

  MAILER = () => ({ ok: false, error: 'This mailer runs as sky@greencrosscanna.com, not tawny@greencrosscanna.com. Nothing was sent.' });
  r = DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'new1@brand.com', resend: '' }));
  ok('a mailer refusal is reported, not recorded, and never falls back to Sky\'s alias',
     r.ok === false && /runs as sky/.test(r.error)
     && !/new1@brand\.com/.test(P[DOC.BRAND_SENT_PREFIX + PH.program_id] || ''));

  MAILER = () => new Error('Timeout: ' + URL_);
  r = DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'new2@brand.com' }));
  ok('a timeout says it may have gone out, so check Tawny\'s Sent folder first',
     r.ok === false && /check Tawny's Sent folder/.test(r.error));

  MAILER = () => ({ code: 200, text: '<html><body>Google Drive: You need access</body></html>' });
  r = DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'new3@brand.com' }));
  ok('a Google sign-in page instead of an answer points at the deployment access setting',
     r.ok === false && /Who has access: Anyone/.test(r.error));

  r = DOC.setBrandMailerWeb_({ secret: 'SEKRET', clear: '1', apply: '1' });
  ok('clear=1 disconnects it, after which Send to brand refuses',
     r.cleared === true && !P.BRAND_MAILER_URL && !P.BRAND_MAILER_SECRET && DOC.brandMailer_() === null
     && /not connected/.test(DOC.sendBrandEmail_(Object.assign({}, ARG, { to: 'after@brand.com' })).error));
  MAILER = () => ({ ok: true, from: 'tawny@greencrosscanna.com' });
}

/* ══════════════════ 7. THE MAILER ITSELF (tawny-mailer/Code.gs) ══════════════════
   Runs the real mailer with Google's services stubbed. It sends as whoever deployed it, so the
   claims are about what it refuses. */
{
  const vm = require('vm');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tawny-mailer', 'Code.gs'), 'utf8');
  const store = {};
  const MAILED = [];
  let ME = 'tawny@greencrosscanna.com';
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => ME }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (o) => MAILED.push(o), getRemainingDailyQuota: () => 1500 },
    Utilities: Object.assign({}, G.Utilities, {
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => ({ bytes, type, name }) }),
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const call = (b) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  const S = 'x'.repeat(64);
  const SEND = { secret: S, action: 'send', expect_from: 'tawny@greencrosscanna.com', to: 'Rep@Brand.com',
                 subject: 'SPIFF results', text: 'hi', html: '<p>hi</p>',
                 attachment: { name: 'r.pdf', base64: Buffer.from('%PDF').toString('base64') } };

  ok('mailer: nothing is sent before it is paired', call(SEND).ok === false && MAILED.length === 0);
  ok('mailer: a short secret cannot pair it', call({ action: 'pair', secret: 'short' }).ok === false && !store.MAILER_SECRET);
  ok('mailer: the first pairing sticks', call({ action: 'pair', secret: S }).ok === true && store.MAILER_SECRET === S);
  ok('mailer: a second pairing is refused, so nobody can take it over',
     call({ action: 'pair', secret: 'y'.repeat(64) }).already_paired === true && store.MAILER_SECRET === S);
  ok('mailer: a wrong secret sends nothing',
     call(Object.assign({}, SEND, { secret: 'z'.repeat(64) })).ok === false && MAILED.length === 0);
  ok('mailer: more than one address is refused',
     call(Object.assign({}, SEND, { to: 'a@b.com, c@d.com' })).ok === false && MAILED.length === 0);
  ok('mailer: no PDF, no send',
     call(Object.assign({}, SEND, { attachment: { name: 'r.exe', base64: 'AAAA' } })).ok === false && MAILED.length === 0);
  ME = 'sky@greencrosscanna.com';
  ok('mailer: deployed by anyone but Tawny, it refuses and says who it runs as',
     /runs as sky@/.test(call(SEND).error) && MAILED.length === 0);
  ME = 'tawny@greencrosscanna.com';
  const good = call(SEND);
  ok('mailer: a good request sends one email, to the lowercased address, with the PDF',
     good.ok === true && good.from === 'tawny@greencrosscanna.com' && MAILED.length === 1
     && MAILED[0].to === 'rep@brand.com' && MAILED[0].attachments[0].type === 'application/pdf');
  ok('mailer: it cannot read her mailbox (MailApp only, no GmailApp) and asks only to send',
     !/GmailApp/.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))
     && JSON.stringify(require('../tawny-mailer/appsscript.json').oauthScopes)
        === JSON.stringify(['https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/userinfo.email']));
  store.SENT_ON = G.Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); store.SENT_COUNT = '40';
  ok('mailer: the daily cap holds', /daily limit/.test(call(SEND).error) && MAILED.length === 1);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\ncloseout money: all passed');
process.exit(fail ? 1 : 0);
