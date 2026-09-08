#!/usr/bin/env node
/* ─── SPIFF publishes; Core serves. Step 2 of 4 ───────────────────────────────────────────────────
 *
 *   RUN:  node tests/publish_to_core_test.js
 *
 * Leaderboard's spiff.gs and Crew's spiffProgressFor_ both call THIS engine's /exec for
 * per-employee sell-through and payout. Both say in their own comments that it is app-to-app and
 * temporary; Leaderboard's asks to be deleted once Core exposes the slice. SPIFF's uptime was the
 * kiosk's uptime, and Crew paid ~4s per incentive-screen load re-fetching numbers that had not
 * moved. So SPIFF pushes its finished figures into Core and the consumers read Core.
 *
 * THE THREE THINGS THAT WOULD MAKE THIS WORSE THAN THE COUPLING IT REPLACES, which is what this
 * file is for:
 *
 *   1. PUBLISHING A REFUSAL AS ZERO. spiffProgress_ deliberately returns ok:false when it cannot
 *      read the programs tab, so "the source did not answer" can never be mistaken for "nobody
 *      earned anything". Publishing that would freeze the mistake into Core for every consumer,
 *      where it looks exactly like a correct answer. This is the BeGOAT failure ($350 across 25
 *      stranded rows, fourteen people showing as owed $25 for a fortnight already paid) with a
 *      wider blast radius.
 *
 *   2. FILING MONEY UNDER THE WRONG FORTNIGHT. Core keys a publication on (producer, scope) and
 *      documents scope as the pay-period start. The obvious source — each row's `pay_period`
 *      column — is unusable, and this was checked against live data rather than assumed:
 *          38 rows  "2026-08-17 - 2026-08-30"   a RANGE, not a date
 *          34 rows  "2026-09-18"                a date AFTER its own window (Aug 31–Sep 13)
 *      The column's own schema comment claims TEXT 'YYYY-MM-DD' (pay-period start). It is free
 *      text nothing validates, which is also why spiffProgress_ already notes that Crew found the
 *      pay_period filter unusable and passes nothing. So the scope is DERIVED from the program's
 *      start date against the chain's grid.
 *
 *   3. A SECOND CODE PATH TO THE SAME NUMBERS. The publish reads through spiffProgress_ — the same
 *      function every consumer reads — rather than assembling its own payload, so the two cannot
 *      drift the first time one is edited.
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

/* ══════════════════ 1. THE SCOPE, ACTUALLY COMPUTED ══════════════════ */
/* The real function, against the real anchor Core serves (2026-05-11 / 14 days). */
const P = new Function('GXCore', 'console', [
  'var PP_CFG = null;', grab('payPeriodCfg_'), grab('periodStartFor_'),
  'return { periodStartFor_: periodStartFor_, payPeriodCfg_: payPeriodCfg_ };'
].join('\n'))(
  { getKv: k => ({ 'cfg.payPeriodAnchor': '2026-05-11', 'cfg.payPeriodDays': '14' }[k]) },
  { warn() {} }
);

ok('the anchor itself is a period start', P.periodStartFor_('2026-05-11') === '2026-05-11');
ok('a date inside a period resolves to that period\'s start',
   P.periodStartFor_('2026-05-20') === '2026-05-11');
ok('the last day of a period still belongs to it',
   P.periodStartFor_('2026-05-24') === '2026-05-11');
ok('the next day starts the next period',
   P.periodStartFor_('2026-05-25') === '2026-05-25');

/* The two live programs, and the whole point of deriving rather than reading. */
ok('Mule (Aug 31 → Sep 13) files under 2026-08-31',
   P.periodStartFor_('2026-08-31') === '2026-08-31');
ok('  …NOT under the "2026-09-18" its own pay_period column claims',
   P.periodStartFor_('2026-08-31') !== '2026-09-18');
ok('Portland Heights (Aug 17 → Aug 30) files under 2026-08-17',
   P.periodStartFor_('2026-08-17') === '2026-08-17');
ok('  …and its pay_period column is not even a date, so it could never have been the scope',
   !/^\d{4}-\d{2}-\d{2}$/.test('2026-08-17 - 2026-08-30'));

/* Off-grid legacy windows must still produce a scope rather than throwing or landing on ''. */
ok('the seven-day legacy program still resolves to a real period',
   /^\d{4}-\d{2}-\d{2}$/.test(P.periodStartFor_('2025-08-11')));
ok('  …and a date BEFORE the anchor goes backwards rather than to period zero',
   P.periodStartFor_('2026-05-10') === '2026-04-27');
/* Garbage in, nothing out — never a guessed period. */
['', null, '8/31/26', '2026-13-45x', 'tomorrow'].forEach(v =>
  ok('a non-ISO window (' + JSON.stringify(v) + ') yields no scope at all',
     P.periodStartFor_(v) === ''));

/* ══════════════════ 2. THE GRID COMES FROM CORE ══════════════════ */
const cfg = grab('payPeriodCfg_');
ok('the anchor is read from Core, not hardcoded as the primary',
   /GXCore\.getKv\('cfg\.payPeriodAnchor'\)/.test(cfg)
   && /GXCore\.getKv\('cfg\.payPeriodDays'\)/.test(cfg));
/* The first cut called a getConfig() that does not exist, behind a guard — so it would have used
   the fallback forever while claiming to read Core. Exactly the silent no-op this app has shipped
   before. */
ok('  …and not through a getConfig() that does not exist on the library',
   cfg.indexOf('getConfig') < 0 || /does not exist/.test(cfg));
ok('a Core hiccup logs rather than silently defaulting',
   /console\.warn/.test(cfg));
ok('  …and the fallback is the value live today, so a hiccup does not move the grid',
   /'2026-05-11'/.test(cfg) && /days = 14/.test(cfg));

/* ══════════════════ 3. A REFUSAL IS NEVER PUBLISHED ══════════════════ */
const pub = grab('publishSpiffToCore_');
ok('the publish reads through spiffProgress_, the same function consumers read',
   /spiffProgress_\(/.test(pub));
ok('  …and refuses to publish when that read refused',
   /if \(!all \|\| !all\.ok\)/.test(pub) && /nothing published/.test(pub));
ok('  …saying so rather than sending an empty payload',
   /progress unavailable/.test(pub));
ok('a row with no usable window is NAMED, not filed under a guess',
   /undated\.push\(r\.program_id\)/.test(pub) && /undated_program_ids/.test(pub));
ok('orphan counts travel with the payload so a consumer can refuse it',
   /orphan_rows/.test(pub) && /orphan_program_ids/.test(pub));

/* ══════════════════ 4. THE SHAPE CONSUMERS ALREADY PARSE ══════════════════ */
/* Steps 3 and 4 are meant to be "read Core, check the age" — not "rewrite the parser". */
['rows', 'by_employee', 'refreshed_at', 'pay_period'].forEach(k =>
  ok('the payload carries `' + k + '`, as ?action=progress does',
     new RegExp('\\b' + k + ':').test(pub)));
ok('the scope rides inside the payload as pay_period, derived',
   /pay_period: scope/.test(pub));
ok('who published and when are inside the payload, not only on Core\'s row',
   /published_by: 'spiff'/.test(pub) && /published_at: nowStamp_\(\)/.test(pub));
/* by_employee is keyed the way Crew joins. */
const be = grab('byEmployee_');
ok('by_employee keys on employee_id, with name only as a fallback',
   /String\(r\.employee_id \|\| \('name:' \+ r\.name\)\)/.test(be));
ok('  …and sums earnings across a person\'s programs',
   /e\.earned \+= Number\(r\.earned\) \|\| 0/.test(be));

/* ══════════════════ 5. IT RUNS WITHOUT A HUMAN, AND FAILS SOFT ══════════════════ */
const trig = grab('refreshSpiffProgressTrigger');
ok('the hourly trigger publishes after refreshing',
   trig.indexOf('publishSpiffToCore_') > trig.indexOf('refreshSpiffProgress_()'));
ok('  …and a Core outage costs the publish, not the refresh',
   /catch \(e\) \{ console\.warn\('\[spiff\] publish to Core threw/.test(trig));

/* ══════════════════ 6. THE MANUAL ROUTE IS DRY BY DEFAULT ══════════════════ */
const man = grab('publishToCore_');
ok('publishToCore is secret-gated', /GX_SECRET_PROP/.test(man));
ok('  …and listed as a secret action, or the router would refuse it first',
   /SECRET_ACTIONS = \[[^\]]*'publishToCore'/.test(gs));
ok('  …and writes NOTHING without apply=1',
   /String\(p\.apply \|\| ''\) !== '1'/.test(man) && /dry = true/.test(man));
ok('  …saying plainly that nothing was sent',
   /Nothing was published/.test(man));
const prev = grab('previewSpiffPublish_');
ok('the preview groups by the same derived scope as the write',
   /periodStartFor_\(textDate_\(r\.start_date\)\)/.test(prev)
   && /periodStartFor_\(textDate_\(r\.start_date\)\)/.test(pub));
ok('  …and names the programs behind each scope, so a wrong one is traceable',
   /programs: dedupe_/.test(prev));

/* ══════════════════ 7. THE STORED COLUMN IS LEFT ALONE ══════════════════ */
/* Correcting program records is a separate, visible job — not a side effect of a plumbing change. */
ok('nothing here rewrites the pay_period column',
   !/pay_period['"]?\s*\]?\s*=\s*periodStartFor_/.test(gs)
   && !/setValue\([^)]*periodStartFor_/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\npublish to core: all passed');
process.exit(fail ? 1 : 0);
