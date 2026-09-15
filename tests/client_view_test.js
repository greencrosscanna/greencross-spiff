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
 *
 * REWRITTEN 2026-09-15, and this file is the reason the rule got written down. Every assertion here
 * DID execute code — and the code it executed was a copy of the page's logic, retyped into the test
 * under comments saying "lifted verbatim in shape" and "replicates the engine's derivation". Only
 * money() was the real function. So the file proved that the test's own reimplementation was
 * correct: it would have gone on passing, green and detailed, while the shipped page printed
 * "cleared the goal by 3 units" again. It now runs the REAL clientView_ from the engine and feeds
 * its answer to the REAL render() from client.js, and reads the HTML a vendor would be looking at.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* ── The page, assembled ─────────────────────────────────────────────────────────────────────────
   render() only touches the DOM through $('#id').hidden and .innerHTML, so a two-property stub is
   the whole browser it needs — and what comes back is the actual markup the vendor sees. */
const CJS = fs.readFileSync(__dirname + '/../client.js', 'utf8');
function page() {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id: id, innerHTML: '', textContent: '', hidden: false }));
  const src = [
    G.grab('money', CJS), G.grab('num', CJS), G.grab('esc', CJS), G.grab('prettyDay', CJS),
    G.grab('cvStat', CJS), G.grab('storeTable', CJS), G.grab('setFoot', CJS), G.grab('render', CJS),
    'return { render: render, money: money, view: function () { return __els; } };',
  ].join('\n');
  const api = new Function('$', 'document', '__els', src)(
    (sel) => el(String(sel).replace('#', '')),
    { getElementById: (id) => el(id) },
    els);
  return { api, els, html: () => el('view').innerHTML, foot: () => el('cvFoot').textContent };
}

/* ── The engine, assembled ───────────────────────────────────────────────────────────────────────
   The real clientView_, with the sheet, the clock and GX Core's brand registry stubbed at the
   edges. What it returns is what the page is given. */
function engine(opts) {
  const o = opts || {};
  const cache = G.makeCache();
  return {
    cache,
    api: G.load({
      real: ['clientView_', 'norm_', 'brandNameOf_', 'brandFold_', 'brandFoldedNames_'],
      vars: ['CLIENT_PASS_PROP'],
      stubs: {
        listProgramsCached_: () => (o.programs || [BEGOAT]),
        listPrograms_: () => (o.programs || [BEGOAT]),
        gxStores_: () => STORES,
        progressRowsFor_: () => (o.rows === undefined ? cacheRows() : o.rows),
      },
      globals: {
        CacheService: cache.CacheService,
        PropertiesService: G.makeProps({ CLIENT_VIEW_PASSWORD: 'shared-pass' }).PropertiesService,
        GXCore: {
          resolveBrand: () => (o.brand === undefined ? BRAND : o.brand),
          getBrands: () => (o.brands === undefined ? [BRAND] : o.brands),
        },
      },
    }),
  };
}

/* A brand row as GX Core's registry serves one: brand_id, display_name and the reps. */
const BRAND = { brand_id: 'begoat', display_name: 'BeGoat', aliases: [], active: true,
                contacts: [{ name: 'Dana Rep', email: 'dana@begoat.example', active: true },
                           { name: 'Gone Rep', email: 'gone@begoat.example', active: false }] };
const STORES = ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd']
  .map(id => ({ store_id: id, display_name: id.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase()) }));

/* BeGoat, exactly as the record and the cache held it on 2026-08-29: six stores, a 120-unit goal,
   117 recorded against 122 measured, and the per-store rows that made the two disagree. */
const BEGOAT = {
  program_id: 'begoat-0826', share_token: 'shr-begoat',
  program_name: 'BeGoat August', title: 'BeGoat August', vendor: 'BeGoat', status: 'closed',
  start_date: '2026-08-04', end_date: '2026-08-17',
  match_json: { brand: 'BeGoat' },
  stores_json: ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'],
  payout_json: { model: 'flat', amount: 25 },
  cost_json: { per_unit: 8.68 },
  baseline_json: { units: 27, by_store: { bend: 2, center: 4, commercial: 15, hillsboro: 1,
                                          'portland-rd': 2, 'river-rd': 3 } },
  target_json: { units: 120, by_store: { bend: 18, center: 18, commercial: 30, hillsboro: 18,
                                         'portland-rd': 18, 'river-rd': 18 },
                 per_bt: { bend: 3, center: 3, commercial: 5, hillsboro: 3, 'portland-rd': 3, 'river-rd': 3 } },
  actual_json: { units_sold: 117, bts_hit: 18, spiff_amount: 25 },
};
/* The cache rows behind it — 25 people who sold, 14 who hit, 122 units. */
function cacheRows() {
  const per = { bend: [18, 3, 6], center: [3, 0, 2], commercial: [28, 3, 5],
                hillsboro: [3, 0, 3], 'portland-rd': [65, 7, 7], 'river-rd': [5, 1, 2] };
  const rows = [];
  Object.keys(per).forEach(store => {
    const [units, hits, sellers] = per[store];
    for (let i = 0; i < sellers; i++) {
      rows.push({ program_id: 'begoat-0826', store_id: store, employee_id: store + i,
                  name: 'BT ' + store + i, units: i === 0 ? units - (sellers - 1) : 1,
                  hit: i < hits, earned: i < hits ? 25 : 0, refreshed_at: '2026-08-30 08:00:00' });
    }
  });
  return rows;
}

const OPEN = { t: 'shr-begoat', email: 'dana@begoat.example', pass: 'shared-pass' };

/* ══════════════════ 1. WHO MAY OPEN IT ══════════════════ */
{
  const e = engine();
  ok('an active rep on an active brand, with the password, gets the proposal',
     e.api.clientView_(OPEN).ok === true);
  ok('the wrong password is refused',
     e.api.clientView_(Object.assign({}, OPEN, { pass: 'nope' })).ok === false);
  ok('  …with the same message an unknown email gets, so neither can be probed',
     e.api.clientView_(Object.assign({}, OPEN, { pass: 'nope' })).error
     === e.api.clientView_(Object.assign({}, OPEN, { email: 'stranger@example.com' })).error);
  ok('a REMOVED rep is refused even with the password',
     e.api.clientView_(Object.assign({}, OPEN, { email: 'gone@begoat.example' })).ok === false);
  ok('a retired brand closes every proposal on it',
     engine({ brand: Object.assign({}, BRAND, { active: false }) })
       .api.clientView_(OPEN).ok === false);
  ok('a token that matches no shared program is refused',
     e.api.clientView_(Object.assign({}, OPEN, { t: 'shr-someone-else' })).ok === false);
  /* A Core outage is not a wrong password: the rep needs to know to try again, not to go hunting
     for a credential that was never wrong. Made real by throwing from resolveBrand. */
  const down = G.load({
    real: ['clientView_', 'norm_', 'brandNameOf_', 'brandFold_', 'brandFoldedNames_'],
    vars: ['CLIENT_PASS_PROP'],
    stubs: { listProgramsCached_: () => [BEGOAT], listPrograms_: () => [BEGOAT],
             gxStores_: () => STORES, progressRowsFor_: () => cacheRows() },
    globals: {
      CacheService: G.makeCache().CacheService,
      PropertiesService: G.makeProps({ CLIENT_VIEW_PASSWORD: 'shared-pass' }).PropertiesService,
      GXCore: { resolveBrand: () => { throw new Error('UrlFetch timed out'); },
                getBrands: () => { throw new Error('UrlFetch timed out'); } },
    },
  });
  ok('a Core outage is NOT reported as a wrong password',
     /unavailable right now/.test(down.clientView_(OPEN).error));
  ok('  …and names no rep while saying so', !/dana@/.test(down.clientView_(OPEN).error));
  ok('no email or no password asks for both rather than denying',
     /Enter your email and the password/.test(e.api.clientView_({ t: 'shr-begoat', pass: 'x' }).error));
}
{
  /* The brute-force brake is real state, so it can be exercised: nine wrong tries, then even the
     right credentials are held off. */
  const e = engine();
  for (let i = 0; i < 9; i++) e.api.clientView_(Object.assign({}, OPEN, { pass: 'wrong' }));
  ok('repeated wrong passwords stop being answered at all',
     /Too many attempts/.test(e.api.clientView_(OPEN).error));
}
{
  /* No link: the rep is offered what they are on, and nothing else. */
  const other = Object.assign({}, BEGOAT, { program_id: 'begoat-0701', share_token: 'shr-2',
                                            program_name: 'BeGoat July' });
  const e = engine({ programs: [BEGOAT, other] });
  const r = e.api.clientView_({ email: 'dana@begoat.example', pass: 'shared-pass' });
  ok('a rep on two programs is offered the choice, not one at random',
     r.ok === true && r.choices.length === 2);
  ok('  …by name and token only — no figures before they have opened one',
     Object.keys(r.choices[0]).sort().join(',') === 'name,period,token');
}

/* ══════════════════ 2. THE HEADLINE TIES TO THE TABLE ══════════════════
   The KPIs came from actual_json while the table came from the progress cache, so BeGoat's page
   showed "117 units sold" above a table totaling 122. */
const view = engine().api.clientView_(OPEN).program;
ok('the headline total is the measured 122, not the recorded 117',
   view.results.units_sold === 122);
ok('  …and the per-store rows add up to the same number',
   view.by_store.reduce((n, s) => n + s.sold, 0) === 122);
ok('budtenders hit comes from the same measurement', view.results.budtenders_hit === 14);
/* The credit is what the vendor is INVOICED. Billing 18 hits under a table showing 14 is the
   version of this bug that costs someone money. */
ok('the credit is derived from the measured hits, not the recorded ones',
   view.results.investment === 350);
ok('  …and the page records which measurement it used', view.results.source === 'measured');
{
  const noCache = engine({ rows: [] }).api.clientView_(OPEN).program;
  ok('with no measurement at all it falls back to the recorded actuals',
     noCache.results.units_sold === 117 && noCache.results.budtenders_hit === 18);
  ok('  …labels itself recorded', noCache.results.source === 'recorded');
  ok('  …and drops the per-store result columns rather than printing zeros',
     noCache.has_store_results === false);
}

/* ══════════════════ 3. THE BUDTENDER DENOMINATOR IS THE ROSTER ══════════════════
   It was a count of budtenders appearing in the sell-through, i.e. who sold at least one unit. So
   a store where only two staff touched the product read "0 of 2" — which FLATTERS it. */
{
  const by = Object.create(null);
  view.by_store.forEach(s => { by[s.store] = s; });
  ok('a store where only 2 of 6 sold is still out of 6', by.Center.budtenders === 6);
  ok('  …and one where only 3 sold, likewise', by.Hillsboro.budtenders === 6);
  ok('a bigger goal at the same per-head target is still 6', by.Commercial.budtenders === 6);
  /* Seven people sold at portland-rd and all seven hit. "7 of 6" reads as a broken page. */
  ok('more sellers than planned raises the denominator, never prints 7 of 6',
     by['Portland-Rd'].budtenders === 7 && by['Portland-Rd'].hit === 7);
  ok('the program total is 37, not the 25 who happened to sell',
     view.by_store.reduce((n, s) => n + s.budtenders, 0) === 37
     && view.by_store.reduce((n, s) => n + s.sellers, 0) === 25);
  ok('how many actually sold is kept alongside, for anyone reconciling later',
     by.Center.sellers === 2);
}

/* ══════════════════ 4. vs BEFORE SPIFF ══════════════════
   The question the vendor came with is "did this move anything", and vs-goal alone cannot answer
   it: bend went 2 → 18 while finishing exactly level with goal. */
{
  const by = Object.create(null);
  view.by_store.forEach(s => { by[s.store] = s; });
  ok('bend reads +16 against before, where vs-goal reads only +0',
     by.Bend.lift === 16 && by.Bend.delta === 0);
  ok('a store that went BACKWARDS is shown as negative, not hidden', by.Center.lift === -1);
  ok('portland-rd carried the program: +63', by['Portland-Rd'].lift === 63);
  ok('the lift total ties to the headline unit lift (122 − 27)',
     view.by_store.reduce((n, s) => n + s.lift, 0) === 95);
}

/* ══════════════════ 5. THE PAGE ITSELF, RENDERED ══════════════════ */
const P = page();
P.api.render(view);
const HTML = P.html();

/* ── THE ONE THAT MATTERS: a miss must never read as a win ── */
ok('a program that MISSED its goal says it fell short — 117 became 122, so this one BEAT it',
   /cleared the goal by 2 units/.test(HTML));
{
  /* The BeGoat page exactly as it shipped: 117 measured against a 120 goal. */
  const missed = engine({ rows: cacheRows().slice(0, -5) }).api.clientView_(OPEN).program;
  const p2 = page(); p2.api.render(missed);
  const h2 = p2.html();
  ok('a genuine miss says it fell short of the goal', / units short of the goal/.test(h2));
  ok('  …and never claims it cleared anything', !/cleared the goal/.test(h2));
}
{
  const level = engine().api.clientView_(OPEN).program;
  level.results.units_sold = 120; level.target_units = 120;
  const p3 = page(); p3.api.render(level);
  ok('landing exactly on the goal is neither a win nor a miss',
     /landed exactly on the goal/.test(p3.html()));
  /* The goal the page compares against is the sum of the per-store goals, so a program with none
     set has nothing to claim either way. */
  const noGoal = engine().api.clientView_(OPEN).program;
  noGoal.target_units = 0;
  noGoal.by_store = noGoal.by_store.map(x => Object.assign({}, x, { target: 0 }));
  const p4 = page(); p4.api.render(noGoal);
  ok('no goal set means no claim at all',
     !/cleared the goal|short of the goal|landed exactly/.test(p4.html()));
}

/* ── money: the sign goes before the dollar sign ── */
ok('a net loss reads -$315, not $-315', P.api.money(-315) === '-$315');
ok('a positive figure is unchanged', P.api.money(450) === '$450');
ok('zero is not signed', P.api.money(0) === '$0');
ok('thousands still group', P.api.money(-3183) === '-$3,183');
ok('  …and a negative net on the page carries the sign the same way',
   !/\$-/.test(HTML));

/* ── THE HEADLINE PICKS THE STRONGEST TRUE RESULT, AND HIDES NOTHING ──
   The page is a sales tool, and it was leading with "-59%" for a program that grew sell-through
   and cleared its goal: the least flattering true fact, in 54px, at the top. */
function headlineOf(html) {
  const m = /<div class="cv-roi-l">([^<]*)<\/div>/.exec(html);
  return m ? m[1] : '';
}
function statLabels(html) {
  return (html.match(/<div class="cv-stat-l">([^<]*)<\/div>/g) || [])
    .map(x => x.replace(/<[^>]*>/g, ''));
}
/* Measured, BeGoat's return IS positive — $824 of sell-through on $350 of credit — and a positive
   return outranks growth, because it is the claim a vendor cares most about. */
ok('a POSITIVE return leads', headlineOf(HTML) === 'Return on the SPIFF');
ok('  …and then there is no duplicate ROI card',
   statLabels(HTML).indexOf('Return on the SPIFF') < 0);
{
  /* The BeGoat page as it shipped: a NEGATIVE return on a program that grew 352% and cleared its
     goal, led with "-59%" — the least flattering true fact, in 54px, at the top. */
  const poor = engine().api.clientView_(OPEN).program;
  poor.results.added_revenue = 140;          // less back than the $350 credited
  const p5 = page(); p5.api.render(poor);
  ok('a NEGATIVE return does not lead when growth is strong',
     headlineOf(p5.html()) === 'Sales growth over the prior period');
  ok('  …and the return is still stated as a stat — reframed, not hidden',
     statLabels(p5.html()).indexOf('Return on the SPIFF') >= 0);
  ok('  …with the loss styling on that card, not on the headline',
     /cv-stat is-down/.test(p5.html()) && !/cv-roi is-down/.test(p5.html()));
  ok('  …and the growth card is dropped, since the headline just said it',
     statLabels(p5.html()).indexOf('Growth over prior') < 0);
}
{
  /* Return and growth both down, but the goal cleared: that is what leads. */
  const goalOnly = engine().api.clientView_(OPEN).program;
  goalOnly.results.added_revenue = 140;
  goalOnly.by_store = goalOnly.by_store.map(x => Object.assign({}, x, { baseline: x.sold + 5 }));
  const p5b = page(); p5b.api.render(goalOnly);
  ok('with return and growth both down, clearing the goal leads',
     headlineOf(p5b.html()) === 'Units over goal');
  ok('  …and the negative return is still disclosed',
     statLabels(p5b.html()).indexOf('Return on the SPIFF') >= 0);
}
{
  /* When nothing is positive the page does not hunt for an angle. */
  const grim = engine().api.clientView_(OPEN).program;
  grim.results.added_revenue = 10;
  grim.results.units_sold = 100;
  grim.by_store = grim.by_store.map(x => Object.assign({}, x, { baseline: 40, target: 40 }));
  const p6 = page(); p6.api.render(grim);
  ok('with nothing positive it leads on the return anyway',
     headlineOf(p6.html()) === 'Return on the SPIFF');
  ok('  …and wears the loss styling', /cv-roi is-down/.test(p6.html()));
}

/* ── FOUR CARDS, AND NEVER A DUPLICATE OF THE HEADLINE ── */
ok('the strip is never more than four cards', statLabels(HTML).length <= 4);
ok('  …and never repeats whatever is in the headline',
   statLabels(HTML).indexOf(headlineOf(HTML)) < 0);
ok('  …while still stating the credit the vendor is asked for',
   statLabels(HTML).indexOf('Total credit') >= 0 && /\$350/.test(HTML));
{
  /* FOUR IS A CAP, NOT A QUOTA: a program with no credit has no return to show, and three cards
     that stretch beat a fourth repeating the headline. */
  const noCredit = engine().api.clientView_(OPEN).program;
  noCredit.results.investment = 0; noCredit.results.budtenders_hit = 0;
  const p7 = page(); p7.api.render(noCredit);
  ok('with no ROI the strip is three, never padded with a duplicate',
     statLabels(p7.html()).length === 3);
}

/* ── THE HEADCOUNT COMPARISON IS DROPPED WHEN UNKNOWN, never stated as "of 0" ── */
ok('the budtender card shows the real denominator', /of 37 · \$25 each/.test(HTML));
{
  const unknown = engine({ rows: [] }).api.clientView_(OPEN).program;
  unknown.budtenders = 0; unknown.results.budtenders = 0;
  unknown.by_store = unknown.by_store.map(s => Object.assign({}, s, { budtenders: 0 }));
  const p8 = page(); p8.api.render(unknown);
  ok('  …and never prints "of 0" when nobody knows the headcount', !/of 0 ·/.test(p8.html()));
}

/* ── THE TABLE, AND THE FOOTER THAT DESCRIBES IT ── */
ok('the store table names stores, not slugs',
   /<td>Portland-Rd<\/td>/.test(HTML) && HTML.indexOf('<td>portland-rd</td>') < 0);
ok('  …and shows before, goal, sold and vs-before for each',
   /<th class="n">Before SPIFF<\/th>/.test(HTML) && /<th class="n">vs before<\/th>/.test(HTML));
ok('  …with a total row that ties to the headline',
   /class="total"[\s\S]*?122/.test(HTML));
ok('a results page does not call its figures estimates', /final figures/.test(P.foot()));
{
  const proposal = engine().api.clientView_(OPEN).program;
  proposal.results = null;
  const p9 = page(); p9.api.render(proposal);
  ok('a PROPOSAL leads with the ask, never with a result',
     /The proposal/.test(p9.html()) && !/cv-roi-v/.test(p9.html().split('The proposal')[0]));
  ok('  …and its footer says the figures are estimates', /estimates/.test(p9.foot()));
}
{
  /* A closed program with no cached rows: the columns go, rather than printing zeros under a
     headline of 117. */
  const noRows = engine({ rows: [] }).api.clientView_(OPEN).program;
  const p10 = page(); p10.api.render(noRows);
  ok('with no per-store measurement the Sold column is dropped, not zero-filled',
     !/<th class="n">Sold<\/th>/.test(p10.html()) && /<th class="n">Goal<\/th>/.test(p10.html()));
}

/* Dates are TEXT here too — new Date('2026-08-04') parses as UTC and renders the day before. */
ok('dates render from the text, never a day early', /Aug 4 – Aug 17/.test(HTML));

console.log(fail ? '\n' + fail + ' FAILED' : '\nclient view: all passed');
process.exit(fail ? 1 : 0);
