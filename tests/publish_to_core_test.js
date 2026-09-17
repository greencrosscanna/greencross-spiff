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
 *
 * REWRITTEN 2026-09-15: sections 3 and 4 now RUN the publish. The scope math was always executed;
 * everything about the payload was a regex over publishSpiffToCore_'s source, which on the function
 * that decides what dollar figures reach Crew and the kiosks is the weakest place in the suite to
 * be guessing. `/pay_period: scope/` proves the key is typed in the literal, not that the right
 * period ends up on the right rows.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  \u2713 ' + l) : (fail++, console.log('  \u2717 ' + l));

const gs = G.GS;
const grab = (name) => G.grab(name);

/* ── The publish, assembled and run ──────────────────────────────────────────────────────────────
   spiffProgress_ is injected rather than run here: progress_cache_test.js already drives the real
   one against a fake sheet, and what THIS file is about is what the publish does with the answer —
   how it slices by period, what it sends, and what it refuses to send. Everything downstream of
   that seam (the grouping, byEmployee_, programsFor_, the payload literal, the failure handling)
   is the real code. */
function publisher(opts) {
  const o = opts || {};
  const sent = [];
  const props = G.makeProps({ GX_DEPLOY_SECRET: o.secret === undefined ? 'SEKRET' : o.secret });
  const api = G.load({
    /* `nowStamp_` is real unless a test pins the clock. The per-store chip is a NOW-fact — whether
       something is running today decides whether a store appears at all — so those cases cannot be
       left to the machine's calendar. */
    real: ['publishSpiffToCore_', 'publishToCore_', 'previewSpiffPublish_', 'byEmployee_',
           'programsFor_', 'dedupe_', 'periodStartFor_', 'textDate_', 'normalizePitch_',
           'payoutRateOf_', 'payoutModelOf_', 'productLabelOf_', 'scrubSecrets_',
           'lastProgramsByStore_', 'lastClosedFor_', 'programRunsAt_', 'programCoversStore_',
           'slug_'].concat(o.today ? [] : ['nowStamp_']),
    vars: ['GX_SECRET_PROP', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: Object.assign({
      spiffProgress_: (arg) => { sent.push({ readWith: arg }); return o.progress; },
      listProgramsCached_: () => (o.programs || []),
      payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }),
    }, o.today ? { nowStamp_: () => o.today + ' 09:00:00' } : {}),
    globals: {
      PropertiesService: props.PropertiesService,
      console: { warn() {}, log() {} },
      /* Core's own door, captured. What lands here is what a consumer would read back. */
      GXCore: {
        publishSpiffProgress: (secret, scope, payload, meta) => {
          sent.push({ secret, scope, payload, meta });
          if (o.coreThrows) throw new Error(o.coreThrows);
          return o.coreAnswer || { ok: true, bytes: JSON.stringify(payload).length };
        },
      },
    },
  });
  return { api, sent, publications: () => sent.filter(x => x.scope) };
}

/* Two fortnights of real shape: Portland Heights (Aug 17 → Aug 30) and Mule (Aug 31 → Sep 13),
   with one person who worked both — so a mis-grouping shows up as money in the wrong period. */
function row(programId, start, end, employee, earned, extra) {
  /* `status` is carried because spiffProgress_ resolves it onto every row it returns, and the
     publish reads through that function — a fixture without it is a row this route never sees.
     It is load-bearing now: the freshness floor counts active rows only. */
  return Object.assign({ program_id: programId, start_date: start, end_date: end,
                         employee_id: employee, name: 'BT ' + employee, store_id: 'river-rd',
                         units: 6, target: 6, hit: true, earned: earned, status: 'active',
                         vendor: 'Vendor', program_name: programId,
                         refreshed_at: '2026-09-15 08:00:00' }, extra || {});
}
const TWO_PERIODS = {
  ok: true,
  rows: [
    row('portland-heights', '2026-08-17', '2026-08-30', 'e1', 4.5),
    row('portland-heights', '2026-08-17', '2026-08-30', 'e2', 4.5, { refreshed_at: '2026-09-15 09:30:00' }),
    row('mule-0831', '2026-08-31', '2026-09-13', 'e1', 25),
  ],
  orphan_rows: 2, orphan_program_ids: ['begoat-0826'],
};

/* ══════════════════ 1. THE SCOPE, ACTUALLY COMPUTED ══════════════════ */
/* The real function, against the real anchor Core serves (2026-05-11 / 14 days). */
const P = G.load({
  real: ['payPeriodCfg_', 'periodStartFor_'],
  varValues: { PP_CFG: null },
  stubs: {},
  globals: {
    GXCore: { getKv: k => ({ 'cfg.payPeriodAnchor': '2026-05-11', 'cfg.payPeriodDays': '14' }[k]) },
    console: { warn() {} },
  },
});

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
{
  /* spiffProgress_ returns ok:false when it could not read `programs` — precisely so a failure to
     read can never be mistaken for "nobody earned anything". Publishing that would freeze the
     mistake into Core for every consumer. */
  const p = publisher({ progress: { ok: false, error: 'could not read the programs tab' } });
  const res = p.api.publishSpiffToCore_({});
  ok('a refused read is NOT published', res.ok === false && p.publications().length === 0);
  ok('  …and the answer says why, naming the read', /progress unavailable, nothing published/.test(res.error)
     && /could not read the programs tab/.test(res.error));
}
{
  const p = publisher({ progress: null });
  ok('no answer at all is also not published',
     p.api.publishSpiffToCore_({}).ok === false && p.publications().length === 0);
}
{
  const p = publisher({ progress: TWO_PERIODS, secret: '' });
  ok('a script with no GX_DEPLOY_SECRET publishes nothing',
     p.api.publishSpiffToCore_({}).ok === false && p.publications().length === 0);
}
{
  /* The publish reads through the same function consumers read, and hands it the secret — a second
     assembled payload would be a second answer to "what is this person owed". */
  const p = publisher({ progress: TWO_PERIODS });
  p.api.publishSpiffToCore_({});
  ok('the publish reads through spiffProgress_, with the secret, not a payload of its own',
     p.sent[0].readWith && p.sent[0].readWith.secret === 'SEKRET');
}

/* ══════════════════ 4. THE PAYLOAD, AS A CONSUMER WOULD READ IT BACK ══════════════════ */
{
  const p = publisher({ progress: TWO_PERIODS, programs: [
    { program_id: 'portland-heights', vendor: 'Green Cross', program_name: 'Portland Heights',
      status: 'closed', start_date: '2026-08-17', end_date: '2026-08-30',
      payout_type: 'per_unit', payout_json: { model: 'per_unit', amount: 0.75 },
      target_json: { by_store: { 'river-rd': 120 }, per_bt: { 'river-rd': 6 } },
      match_json: { brand: 'Green Cross' }, pitch_json: { tips: ['Lead with the price'] } },
    { program_id: 'mule-0831', vendor: 'Mule', program_name: 'Mule August', status: 'active',
      start_date: '2026-08-31', end_date: '2026-09-13',
      payout_type: 'flat', payout_json: { model: 'flat', amount: 25 },
      target_json: {}, match_json: { brand: 'Mule Extracts' }, pitch_json: null },
  ] });
  const res = p.api.publishSpiffToCore_({ notes: 'test run' });
  const pubs = p.publications();

  ok('every period is published, one publication each',
     res.ok === true && pubs.length === 2 && res.published.length === 2);
  ok('  …oldest first, so a partial run leaves the newest period unwritten rather than a hole',
     pubs[0].scope === '2026-08-17' && pubs[1].scope === '2026-08-31');

  /* FILING MONEY UNDER THE RIGHT FORTNIGHT — the failure this route was designed around. */
  const aug = pubs[0].payload, sep = pubs[1].payload;
  ok('Portland Heights\' rows file under 2026-08-17',
     aug.rows.length === 2 && aug.rows.every(r => r.program_id === 'portland-heights'));
  ok('Mule\'s row files under 2026-08-31, not with them',
     sep.rows.length === 1 && sep.rows[0].program_id === 'mule-0831');
  ok('the scope rides inside the payload too, matching the one Core keys on',
     aug.pay_period === '2026-08-17' && sep.pay_period === '2026-08-31'
     && aug.pay_period === pubs[0].scope);
  ok('a person who worked both fortnights is paid once in each, not twice in one',
     aug.by_employee.filter(e => e.employee_id === 'e1')[0].earned === 4.5
     && sep.by_employee.filter(e => e.employee_id === 'e1')[0].earned === 25);
  ok('  …and the period\'s own total is what its rows add up to',
     aug.by_employee.reduce((a, e) => a + e.earned, 0) === 9);

  /* The shape steps 3 and 4 are supposed to read without rewriting a parser. */
  ['ok', 'pay_period', 'rows', 'by_employee', 'programs', 'refreshed_at', 'oldest_refreshed_at',
   'orphan_rows', 'orphan_program_ids', 'published_by', 'published_at'].forEach(k =>
    ok('the payload carries `' + k + '`, as ?action=progress does', k in aug));
  ok('refreshed_at is the NEWEST row\'s stamp, so a consumer can age the whole payload',
     aug.refreshed_at === '2026-09-15 09:30:00');
  /* THE FLOOR, and it has to be computed per SCOPE rather than copied off the whole cache — a
     consumer holding one publication must not be told about staleness in a fortnight it has no
     rows for. Without it a store the sweep skipped hides behind the ones it refreshed: the payload
     reads as fresh as its newest row, and the kiosk draws hour-old numbers as current. */
  ok('oldest_refreshed_at is the STALEST row\'s stamp, not the newest',
     aug.oldest_refreshed_at === '2026-09-15 08:00:00');
  ok('  …and is scoped to this period\'s rows, so one fortnight cannot age another',
     sep.oldest_refreshed_at === '2026-09-15 08:00:00' && sep.refreshed_at === '2026-09-15 08:00:00');

  /* A CLOSED PROGRAM MUST NOT DRAG THE FLOOR. Its rows are frozen the day it closes and are never
     swept again, correctly — so counting them makes the floor a clock running permanently
     backwards. Measured live when this field first shipped: taken over all rows it read two weeks
     stale and would have read staler every day, telling any consumer "something is stale" forever.
     An alarm that is always on is one nobody reads. */
  {
    const q = publisher({ progress: { ok: true, orphan_rows: 0, orphan_program_ids: [], rows: [
      row('portland-heights', '2026-08-17', '2026-08-30', 'e1', 4.5,
          { status: 'closed', refreshed_at: '2026-09-02 15:30:14' }),
      row('portland-heights', '2026-08-17', '2026-08-30', 'e2', 4.5,
          { refreshed_at: '2026-09-15 09:30:00' }),
    ] } });
    q.api.publishSpiffToCore_({});
    const p0 = q.publications()[0].payload;
    ok('a closed program\'s frozen rows do not drag the floor backwards',
       p0.oldest_refreshed_at === '2026-09-15 09:30:00');
    ok('  …while refreshed_at still spans every row, closed included',
       p0.refreshed_at === '2026-09-15 09:30:00' && p0.rows.length === 2);
  }
  {
    const q = publisher({ progress: { ok: true, orphan_rows: 0, orphan_program_ids: [], rows: [
      row('portland-heights', '2026-08-17', '2026-08-30', 'e1', 4.5, { status: 'closed' }),
    ] } });
    q.api.publishSpiffToCore_({});
    ok('a period with nothing active reports no floor at all, rather than a false alarm',
       q.publications()[0].payload.oldest_refreshed_at === '');
  }
  ok('who published and when are inside the payload, not only on Core\'s row',
     aug.published_by === 'spiff' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(aug.published_at));
  ok('orphan counts travel with it, so a consumer can refuse a payload it cannot vouch for',
     aug.orphan_rows === 2 && aug.orphan_program_ids[0] === 'begoat-0826');

  /* The program sidecar is scoped to the period it rides with — Leaderboard renders from it. */
  ok('the program sidecar carries only the programs this period has rows for',
     aug.programs.length === 1 && aug.programs[0].program_id === 'portland-heights'
     && sep.programs.length === 1 && sep.programs[0].program_id === 'mule-0831');
  ok('  …with the rate and model a kiosk needs rather than a guess from what was paid',
     aug.programs[0].payout === 0.75 && aug.programs[0].payout_type === 'per_unit'
     && sep.programs[0].payout === 25 && sep.programs[0].payout_type === 'flat');
  ok('  …the store and per-budtender goals, keyed by store',
     aug.programs[0].store_goals['river-rd'] === 120 && aug.programs[0].bt_goals['river-rd'] === 6);
  ok('  …and Tawny\'s tips, normalized', aug.programs[0].tips[0] === 'Lead with the price'
     && Array.isArray(sep.programs[0].tips) && sep.programs[0].tips.length === 0);

  ok('Core is told who is publishing and why', pubs[0].meta.by === 'spiff' && pubs[0].meta.notes === 'test run');
  ok('  …and gets the secret, since the route is secret-gated on its side', pubs[0].secret === 'SEKRET');
  ok('each period reports its row count back to the caller',
     res.published[0].rows === 2 && res.published[1].rows === 1);
}

/* A window that yields no period is NAMED, never filed under a guess. */
{
  const p = publisher({ progress: { ok: true, rows: [
    row('portland-heights', '2026-08-17', '2026-08-30', 'e1', 4.5),
    row('legacy-no-window', '', '', 'e2', 10),
    row('legacy-junk-window', '8/31/26', '9/13/26', 'e3', 10),
    row('legacy-no-window', '', '', 'e4', 10),
  ] } });
  const res = p.api.publishSpiffToCore_({});
  const pubs = p.publications();
  ok('a row with no usable window is left out of every publication',
     pubs.length === 1 && pubs[0].payload.rows.length === 1);
  ok('  …and NAMED on the answer, so it is a visible gap rather than a silent loss',
     res.undated_program_ids.indexOf('legacy-no-window') >= 0
     && res.undated_program_ids.indexOf('legacy-junk-window') >= 0);
  ok('  …once each, however many rows it had', res.undated_program_ids.length === 2);
}
{
  const p = publisher({ progress: { ok: true, rows: [row('x', '', '', 'e1', 10)] } });
  const res = p.api.publishSpiffToCore_({});
  ok('a cache with nothing datable publishes nothing and says so',
     p.publications().length === 0 && /no rows with a usable window/.test(res.skipped));
}

/* One period failing must not hide the others, and Core's own errors must not leak a secret. */
{
  const p = publisher({ progress: TWO_PERIODS, coreAnswer: { ok: false, error: 'quota exceeded' } });
  const res = p.api.publishSpiffToCore_({});
  ok('a period Core refuses is reported as failed', res.ok === false && res.failed.length === 2
     && res.failed[0].error === 'quota exceeded');
  ok('  …and every period was still attempted', p.publications().length === 2);
}
{
  const p = publisher({ progress: TWO_PERIODS,
                        coreThrows: 'UrlFetch failed: https://core/exec?secret=SEKRET&action=publish' });
  const res = p.api.publishSpiffToCore_({});
  ok('a throw from Core is caught per period, not fatal to the run', res.failed.length === 2);
  ok('  …with the secret scrubbed out of the message it reports',
     /secret=\[redacted\]/.test(res.failed[0].error) && res.failed[0].error.indexOf('SEKRET') < 0);
}

/* The manual route: dry by default, and the preview is the same grouping as the write. */
{
  const p = publisher({ progress: TWO_PERIODS });
  const dry = p.api.publishToCore_({ secret: 'SEKRET' });
  ok('publishToCore is DRY by default — nothing reaches Core',
     dry.dry === true && p.publications().length === 0);
  ok('  …saying plainly that nothing was sent', /Nothing was published/.test(dry.note));
  /* The preview has to agree with the write, or a dry run is a different answer from the real one:
     same scopes, same row counts, same dollars, and the programs behind each one named. */
  const scopes = (dry.would_publish || []).map(x => x.scope);
  ok('  …while previewing the same two scopes the write would use',
     scopes.join(',') === '2026-08-17,2026-08-31');
  const previewAug = dry.would_publish[0];
  ok('  …with the same rows, people and dollars behind each',
     previewAug.rows === 2 && previewAug.people === 2 && previewAug.earned === 9);
  ok('  …and the programs behind a scope named, so a wrong one is traceable',
     previewAug.programs[0] === 'portland-heights');
  const wet = p.api.publishToCore_({ secret: 'SEKRET', apply: '1', notes: 'by hand' });
  ok('apply=1 publishes for real', wet.dry === false && p.publications().length === 2
     && p.publications()[0].meta.notes === 'by hand');
  const bad = publisher({ progress: TWO_PERIODS });
  ok('a wrong secret publishes nothing',
     bad.api.publishToCore_({ secret: 'nope', apply: '1' }).error === 'Unauthorized'
     && bad.publications().length === 0);
}

/* ══════════════════ 5. IT RUNS WITHOUT A HUMAN, AND FAILS SOFT ══════════════════ */
const trig = grab('refreshSpiffProgressTrigger');
ok('the hourly trigger publishes after refreshing',
   trig.indexOf('publishSpiffToCore_') > trig.indexOf('refreshSpiffProgress_()'));
ok('  …and a Core outage costs the publish, not the refresh',
   /catch \(e\) \{ console\.warn\('\[spiff\] publish to Core threw/.test(trig));

/* ══════════════════ 6. A MANUAL RE-MEASURE PUBLISHES TOO ══════════════════
   Crew asked on 2026-09-09: its "Re-measure now" button sweeps SPIFF store by store then clears
   Crew's own cache so the manager sees what they just re-measured. Only the hourly trigger
   published, so the manager could re-measure and still be shown the previously published figures
   for up to an hour with nothing looking wrong. The app that owns the numbers should publish
   whenever they move, not only on a clock. */
const router = gs.slice(gs.indexOf("case 'refreshProgress':"), gs.indexOf("case 'installProgressTrigger'"));
ok('the manual refresh route publishes after sweeping',
   /publishSpiffToCore_\(\{ notes: 'after a manual re-measure' \}\)/.test(router));
ok('  …including a single-store call, since a human drove it',
   router.indexOf('p.store ?') < router.indexOf('publishSpiffToCore_'));
ok('  …and a Core outage does not turn a good sweep into an error',
   /out\.publish_error/.test(router) && /try \{/.test(router));
ok('  …with the failure reported on the reply, not swallowed',
   /publish_error = rpub\.error/.test(router));
ok('the secret gate still comes first', router.indexOf('Unauthorized') < router.indexOf('publishSpiffToCore_'));

/* ══════════════════ 7. WHAT EXECUTION CANNOT SEE ══════════════════
   The dry-run behavior and the preview's agreement with the write are exercised in section 4. What
   is left is the router: an assembled function cannot tell you which list its action is on. */
ok('publishToCore is listed as a secret action, or the router would refuse it first',
   /SECRET_ACTIONS = \[[^\]]*'publishToCore'/.test(gs));
ok('  …and is not public', !/PUBLIC_ACTIONS[^\n]*publishToCore/.test(gs));

/* ══════════════════ 8. THE EMPTY-BOARD CHIP, ON THE PIPE LEADERBOARD ACTUALLY READS ══════════════════
 * Leaderboard's kiosk panel reads the PUBLICATION, not `storeView`. `last_program` shipped on the
 * route in v1.429 and we reported the work done — it was not, because the route was never their
 * consumer. Run for real, because the interesting half is WHICH stores get an entry and what
 * attainment is measured against, and because the presence of a key is the whole contract.
 */
{
  const CLOSED = { program_id: 'wyld-0824', vendor: 'Wyld', program_name: 'Wyld 5pc Gummies',
                   status: 'closed', start_date: '2026-08-24', end_date: '2026-09-06',
                   stores_json: ['river-rd', 'bend'],
                   target_json: { by_store: { 'river-rd': 50, bend: 100 } } };
  const OLDER  = { program_id: 'gron-0810', vendor: 'Grön', program_name: 'Grön older',
                   status: 'closed', start_date: '2026-08-01', end_date: '2026-08-23',
                   stores_json: ['river-rd'], target_json: { by_store: { 'river-rd': 10 } } };
  /* Running at bend only — so bend must be ABSENT from the map while river-rd is present. */
  const LIVE   = { program_id: 'mule-0910', vendor: 'Mule', program_name: 'Mule 2g',
                   status: 'active', start_date: '2026-09-08', end_date: '2026-09-21',
                   stores_json: ['bend'], target_json: { by_store: { bend: 40 } } };

  const closedRow = (store, employee, units) =>
    row('wyld-0824', '2026-08-24', '2026-09-06', employee, 25,
        { store_id: store, units: units, status: 'closed' });
  const progress = {
    ok: true,
    rows: [closedRow('river-rd', 'e1', 33), closedRow('river-rd', 'e2', 23),
           closedRow('bend', 'e7', 99),
           row('mule-0910', '2026-09-08', '2026-09-21', 'e7', 25, { store_id: 'bend' })],
    orphan_rows: 0, orphan_program_ids: [],
  };

  const q = publisher({ progress, programs: [CLOSED, OLDER, LIVE], today: '2026-09-10' });
  q.api.publishSpiffToCore_({});
  const pubs = q.publications();
  const map = pubs[0].payload.last_programs;

  ok('the publication carries the per-store chip, not just the kiosk route', !!map);
  ok('  …for a store with nothing running', !!map['river-rd']);
  ok('  …naming the program that finished most recently, not the first one found',
     map['river-rd'].program_name === 'Wyld 5pc Gummies'
     && map['river-rd'].end_date === '2026-09-06');
  ok('  …with how THAT store did, against ITS goal and only its own rows',
     map['river-rd'].store_pct === 112);
  /* bend's own rows total 99 against a goal of 100. If the map leaked across stores, river-rd
     would read (33+23+99)/50 and bend would exist at all — both are checked. */
  ok('a store with a program running gets no chip, so no reader can draw one beside a live board',
     !('bend' in map));
  const LAST_ALLOWED = ['vendor', 'program_name', 'end_date', 'store_pct'];
  ok('the chip carries nothing a finished program has no business putting on a wall',
     Object.keys(map['river-rd']).every(k => LAST_ALLOWED.indexOf(k) >= 0));

  /* Presence is the signal, so the two pipes must agree on what "nothing running" means. Same
     fixture with the live program removed: bend appears, measured against its own goal. */
  const quiet = publisher({ progress, programs: [CLOSED, OLDER], today: '2026-09-10' });
  quiet.api.publishSpiffToCore_({});
  const qmap = quiet.publications()[0].payload.last_programs;
  ok('the store appears the moment nothing is running there', !!qmap.bend);
  ok('  …measured against its own goal, never the chain\'s', qmap.bend.store_pct === 99);

  /* No percentage rather than a wrong one — the same rule the route follows. */
  const noGoal = publisher({ progress, programs: [Object.assign({}, CLOSED, { target_json: {} })],
                             today: '2026-09-10' });
  noGoal.api.publishSpiffToCore_({});
  const ngmap = noGoal.publications()[0].payload.last_programs;
  ok('a program that set no store goal reports no percentage rather than a made-up one',
     !!ngmap['river-rd'] && !('store_pct' in ngmap['river-rd']));

  /* A store that has never finished one gets no entry, so the consumer's empty state stays plain
     rather than drawing a chip with blanks in it. */
  const never = publisher({ progress, programs: [LIVE, Object.assign({}, CLOSED,
                             { stores_json: ['bend'], target_json: { by_store: { bend: 100 } } })],
                            today: '2026-09-10' });
  never.api.publishSpiffToCore_({});
  ok('a store that has never finished one is absent, not present and empty',
     !('river-rd' in never.publications()[0].payload.last_programs));

  /* It is a now-fact, not a slice of a period — so every scope carries the same map. A consumer
     reading a lookback must not get a different answer depending on which one it looks at. */
  const two = publisher({ progress: TWO_PERIODS, programs: [CLOSED, OLDER], today: '2026-09-10' });
  two.api.publishSpiffToCore_({});
  const maps = two.publications().map(x => JSON.stringify(x.payload.last_programs));
  ok('every scope carries the same map, because the chip belongs to no period',
     maps.length === 2 && maps[0] === maps[1]);

  /* THE DEPARTURE FROM "SAME KEYS", asserted so it stays deliberate. `?action=progress` takes
     filters, and a map computed from a filtered slice is quietly wrong rather than absent. */
  ok('the filtered route does not carry it — a filtered slice cannot compute it honestly',
     !/last_programs/.test(grab('spiffProgress_')));
  ok('  …and the publisher computes it from the UNFILTERED read it already makes',
     /lastProgramsByStore_\(all\.rows/.test(grab('publishSpiffToCore_')));
  /* The presence rule is shared code, not a second copy — see programRunsAt_. */
  ok('both pipes decide "nothing running" with the one predicate',
     /programRunsAt_\(/.test(grab('storeView_'))
     && /programRunsAt_\(/.test(grab('lastProgramsByStore_')));
}

/* ══════════════════ 7. THE STORED COLUMN IS LEFT ALONE ══════════════════ */
/* Correcting program records is a separate, visible job — not a side effect of a plumbing change. */
ok('nothing here rewrites the pay_period column',
   !/pay_period['"]?\s*\]?\s*=\s*periodStartFor_/.test(gs)
   && !/setValue\([^)]*periodStartFor_/.test(gs));

console.log(fail ? '\n' + fail + ' FAILED' : '\npublish to core: all passed');
process.exit(fail ? 1 : 0);
