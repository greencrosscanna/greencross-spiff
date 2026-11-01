#!/usr/bin/env node
/* ─── The vendor marketing plan and the team email, run through the engine's real routes ──────────
 *
 *   RUN:  node tests/marketing_vendor_plan_test.js
 *
 * marketingOverview_ and marketingNotify_ run from their real source with Drive, Gmail, the clock and
 * GX Core stubbed at the edges. What is checked:
 *   · the vendor plan holds no budtender name, payout dollar, cost or margin figure, run on a program
 *     that HAS all of them, plus internal free text in the plan's notes and details;
 *   · only an editor session gets either route; neither runs without one;
 *   · the plan is filed in the SPIFF Reports folder only when save=1, and is never mailed;
 *   · the team email goes to Green Cross addresses only, from a configurable property, refusing
 *     clearly when it is unset; it is a dry draft until send=1, and a repeat needs resend=1;
 *   · the menu ids here match marketing.js, so the two cannot drift apart.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const SECRETS = ['Zelda Budtender', 'BT-CANARY-NAME', '$777', '777', '4242', 'COST-CANARY', 'MARGIN-CANARY', 'INTERNAL-NOTE-CANARY'];
const FULL_PLAN = {
  v: 1, stores: ['bend', 'center'],
  sel: { email: true, vday: true, raffle: true, signage: true, edu: true, sms: true },
  d: { email: { date: '2026-10-15', note: 'INTERNAL-NOTE-CANARY' }, vday: { date: '2026-10-20', time: '4-7 PM' },
       raffle: { prize: 'INTERNAL-NOTE-CANARY', date: '2027-02-01' }, edu: { format: 'Training video (recommended)' },
       sms: { cost: 'We cover it', date: '2026-10-22' } },
  done: { 'core.menu': { by: 'Zelda Budtender', at: 'x' } }, due: {},
  events: [{ name: 'Hillsboro Vendor Day', date: '2026-10-18', time: '' }],
  notes: 'INTERNAL-NOTE-CANARY',
};

function program(over) {
  return Object.assign({
    program_id: 'wyld-1', vendor: 'Wyld', program_name: 'All Products', title: 'Wyld', status: 'active',
    start_date: '2026-10-12', end_date: '2026-10-25', stores_json: ['bend', 'center'],
    payout_type: 'flat', payout_json: { model: 'flat', amount: 777 },
    cost_json: { per_unit: 4242, margin: 'MARGIN-CANARY', note: 'COST-CANARY' },
    target_json: { units: 4242, budtenders: 12, per_bt: { bend: 777 } },
    actual_json: { units_sold: 4242, revenue: 777, investment: 777, roi: 777 },
    progress_json: { rows: [{ name: 'Zelda Budtender', legal_name: 'BT-CANARY-NAME', earned: 777 }] },
    marketing_json: FULL_PLAN,
  }, over || {});
}

function engine(o) {
  o = o || {};
  const props = G.makeProps(Object.assign({}, o.props || {}));
  const mails = [], files = [], folders = [];
  let program_ = o.program || program();
  const api = G.load({
    real: ['marketingOverview_', 'marketingOverviewHtml_', 'mktPlanFacts_', 'mktEsc_', 'mktPickedIds_', 'mktEditor_',
           'mktRecipients_', 'marketingNotify_', 'normalizeMarketing_', 'brandProgramLabel_', 'prettyDay_',
           'addDaysLocal_', 'slug_', 'today_'],
    vars: ['EDIT_ROLES', 'LOGO_ONLIGHT', 'MKT_NOTIFY_PROP', 'MKT_NOTIFY_DOMAIN', 'MKT_NOTIFIED_PREFIX', 'MKT_OREGON_RULES_', 'REPORT_FOLDER_ID', 'MKT_MENU_'],
    stubs: {
      gxAuth_: (t) => (t === 'good' ? { ok: true, user: 'tawny', role: o.role || 'editor' } : { ok: false, error: 'bad token' }),
      getProgram_: (id) => (id === 'wyld-1' ? { ok: true, program: program_ } : { ok: false, error: 'not found: ' + id }),
      gxStores_: () => [{ store_id: 'bend', display_name: 'Bend' }, { store_id: 'center', display_name: 'Center' }],
      nowStamp_: () => '2026-10-14 09:00:00',
      sendMail_: (m) => { if (o.mailFails) throw new Error('mail down'); mails.push(m); },
      scrubSecrets_: (x) => String(x),
    },
    globals: {
      PropertiesService: props.PropertiesService, console: { warn() {}, log() {} },
      GXCore: { roleCanEdit: (r) => ['editor', 'admin', 'director', 'manager'].indexOf(r) >= 0 },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
      DriveApp: { getFolderById: (id) => { folders.push(id); return { createFile: (b) => { files.push(b); return { getId: () => 'f1', getUrl: () => 'https://drive/f1' }; } }; } },
      Utilities: {
        newBlob: (html) => ({ html, getAs() { return this; }, setName(n) { this.name = n; return this; } }),
        formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : '102026') },
    },
  });
  return { api, mails, files, folders, props };
}

const TOKEN = { token: 'good', id: 'wyld-1' };

console.log('\n1. the vendor plan holds nothing internal');
{
  const e = engine();
  const r = e.api.marketingOverview_(TOKEN);
  ok('it builds', r.ok === true && r.html.length > 1000);
  const leaks = SECRETS.filter(s => r.html.indexOf(s) >= 0);
  ok('  …with no budtender name, payout, cost, margin or internal note in it: ' + (leaks.join(', ') || 'none'), leaks.length === 0);
  ok('  …and no dollar sign at all', r.html.indexOf('$') < 0);
  ok('  …and it IS the plan: vendor, window, stores, picked items, dates',
     /Wyld/.test(r.html) && /Oct 12, 2026/.test(r.html) && /Bend, Center/.test(r.html) && /Email blast/.test(r.html)
     && /Oct 20, 2026/.test(r.html));
  for (const h of ['Your team and ours', 'Your plan', 'Two weeks at a glance', 'What we need from you', 'Incentive options', 'Artwork specs'])
    ok('  …section: ' + h, r.html.indexOf(h) >= 0);
  const glance = r.html.slice(r.html.indexOf('Two weeks at a glance'), r.html.indexOf('What we need from you'));
  ok('  …the glance covers 14 days: the Oct 18 event is in, the Feb 2027 raffle is not',
     /Hillsboro Vendor Day/.test(glance) && /Email goes out/.test(glance) && !/Raffle drawing/.test(glance));
  ok('  …an item not picked is not in the plan', !/Customer swag/.test(r.html));
  ok('  …nothing was filed or mailed by building it', e.files.length === 0 && e.mails.length === 0);
  const bare = e.api.marketingOverview_(TOKEN);
  ok('  …and it is the same every time', bare.html === r.html);
}

console.log('\n2. saving files a PDF in the SPIFF Reports folder only');
{
  const e = engine();
  const r = e.api.marketingOverview_(Object.assign({ save: '1' }, TOKEN));
  ok('it saves into REPORT_FOLDER_ID and nowhere else', r.ok && r.saved && e.folders.length === 1 && e.folders[0] === '1c8Yj23OkEusskHylLKYzHsqPYIgAHP1t');
  ok('  …named for the vendor', /Marketing Plan - Wyld/.test(r.name));
  ok('  …and mailed to nobody', e.mails.length === 0);
}

console.log('\n3. only an editor session, on both routes');
{
  for (const role of ['viewer', 'budtender']) {
    const e = engine({ role, props: { MARKETING_NOTIFY_TO: 'mike@greencrosscanna.com' } });
    const a = e.api.marketingOverview_(Object.assign({ save: '1' }, TOKEN));
    const b = e.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
    ok(role + ': refused on both routes', a.ok === false && b.ok === false && /cannot/.test(a.error + b.error));
    ok('  …nothing filed or sent', e.files.length === 0 && e.mails.length === 0);
  }
  const e = engine({ props: { MARKETING_NOTIFY_TO: 'mike@greencrosscanna.com' } });
  const bad = [e.api.marketingOverview_({ token: 'nope', id: 'wyld-1' }), e.api.marketingNotify_({ token: 'nope', id: 'wyld-1', send: '1' })];
  ok('a bad token is told to sign in', bad.every(r => r.ok === false && r.needsAuth === true));
  ok('  …and nothing was sent', e.mails.length === 0);
}

console.log('\n4. the team email');
{
  const unset = engine();
  const r0 = unset.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
  ok('with no recipient set it refuses, and names what to set', r0.ok === false && /MARKETING_NOTIFY_TO/.test(r0.error) && unset.mails.length === 0);

  const outside = engine({ props: { MARKETING_NOTIFY_TO: 'mike@greencrosscanna.com, rep@wyld.com' } });
  const r1 = outside.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
  ok('one outside address in the property refuses the whole send', r1.ok === false && /rep@wyld\.com/.test(r1.error) && outside.mails.length === 0);

  const e = engine({ props: { MARKETING_NOTIFY_TO: 'Mike@GreenCrossCanna.com;tawny@greencrosscanna.com' } });
  const d = e.api.marketingNotify_(TOKEN);
  ok('without send=1 it only shows the draft', d.ok && d.preview && e.mails.length === 0);
  ok('  …to the configured team, lower-cased', JSON.stringify(d.to) === JSON.stringify(['mike@greencrosscanna.com', 'tawny@greencrosscanna.com']));
  ok('  …with the subject and body the confirmation shows', /Wyld/.test(d.subject) && /Email blast/.test(d.body));
  const leaks = SECRETS.filter(s => (d.body + d.subject).indexOf(s) >= 0);
  ok('  …and nothing internal-private in it: ' + (leaks.join(', ') || 'none'), leaks.length === 0);

  const s1 = e.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
  ok('send=1 sends once, through sendMail_', s1.ok && s1.sent && e.mails.length === 1 && e.mails[0].to === 'mike@greencrosscanna.com,tawny@greencrosscanna.com');
  const s2 = e.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
  ok('a re-fetched URL does not send twice', s2.ok === false && s2.already === true && e.mails.length === 1);
  const s3 = e.api.marketingNotify_(Object.assign({ send: '1', resend: '1' }, TOKEN));
  ok('resend=1 does', s3.ok && e.mails.length === 2);
  const s4 = e.api.marketingNotify_(Object.assign({ send: '1', kind: 'summary' }, TOKEN));
  ok('a different kind is its own email', s4.ok && e.mails.length === 3);
  ok('an unknown kind is refused', e.api.marketingNotify_(Object.assign({ send: '1', kind: 'blast' }, TOKEN)).ok === false);

  const down = engine({ mailFails: true, props: { MARKETING_NOTIFY_TO: 'mike@greencrosscanna.com' } });
  const f = down.api.marketingNotify_(Object.assign({ send: '1' }, TOKEN));
  ok('a failed send says so and is not recorded as sent', f.ok === false && /Could not send/.test(f.error)
     && !down.props.props['mktnotified:wyld-1:plan']);
}

console.log('\n5. the menu here matches marketing.js, and no route is hedged');
{
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
  const a = Object.keys(ctx.SpiffMarketing.ITEMS).sort(), b = Object.keys(G.grabVar('MKT_MENU_')).sort();
  ok('the same item ids in both (' + a.length + ')', JSON.stringify(a) === JSON.stringify(b));
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const hedge = js.slice(js.indexOf('var ENGINE_HEDGE_READS'), js.indexOf('var ENG = GXClient'));
  ok('neither route is on ENGINE_HEDGE_READS', !/marketingOverview|marketingNotify/.test(hedge));
  ok('both client calls have retries off', (js.match(/retries: 0/g) || []).length > 0 && /var opt = \{ timeoutMs: 60000, retries: 0 \}/.test(js));
}

console.log('\n6. the buttons');
{
  const MKc = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), MKc);
  const MK = MKc.SpiffMarketing;
  const p = { program_id: 'x', vendor: 'Wyld', start_date: '2026-10-12', end_date: '2026-10-25', stores_json: ['bend'], marketing_json: { v: 1, sel: {}, skip: {}, d: {}, done: {}, due: {}, events: [], notes: '' } };
  const cx = (o) => Object.assign({ today: '2026-10-14', canEdit: true, engineReady: true, stores: [{ store_id: 'bend', name: 'Bend' }], storeName: (s) => s }, o || {});
  const btns = (h) => h.match(/<button[^>]*data-mk-plan="[a-z]+"[^>]*>/g) || [];
  ok('an editor gets three live buttons', btns(MK.sectionHtml(p, cx())).length === 3 && !btns(MK.sectionHtml(p, cx())).some(b => /disabled/.test(b)));
  ok('a viewer gets them disabled', btns(MK.sectionHtml(p, cx({ canEdit: false }))).every(b => /disabled/.test(b)));
  ok('an engine without the routes yet gets them disabled', btns(MK.sectionHtml(p, cx({ engineReady: false }))).every(b => /disabled/.test(b)));
  const calls = [];
  const host = { __mkWired: false, addEventListener(t, f) { this[t] = f; }, contains: () => true };
  MK.wire(host, { program: () => p, plan: (w) => calls.push(w), apply() {}, opts() { return {}; }, moving() {}, tick() {} });
  host.click({ target: { closest: () => ({ disabled: false, dataset: { mkPlan: 'notify' } }) } });
  ok('a click reaches the plan handler', calls[0] === 'notify');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nmarketing vendor plan: all passed');
process.exit(fail ? 1 : 0);
