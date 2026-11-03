#!/usr/bin/env node
/* ─── What one text blast costs a vendor ──────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/sms_pricing_test.js
 *
 * Sky, 2026-11-03: the Text blast card shows, beside its cost model picker, opted-in phones × Dutchie's
 * rate ("≈5,136 phones × $0.03 = about $154 per text, about $257 with an image ($0.05)"), labeled a
 * pass-through at Dutchie's cost added to the vendor's credit, with the 160-character note. The list
 * size and both rates are SETTINGS (script properties, edited in Settings), because the count changes
 * every month.
 *
 * WHAT RUNS: marketing.js's smsCostLine / smsCostHtml and the section card, and the engine's
 * smsPricingRead_ / saveSmsPricing_ lifted from Code.gs with properties and the editor check stubbed.
 * SOURCE-SHAPED: the router cases and the rule that no number is a constant in marketing.js are
 * absence/wiring claims, checked by reading the source.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./_gas');
const MK = require('../marketing.js');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

/* ── 1. the line ────────────────────────────────────────────────────────────────────────────────── */
console.log('1. the cost line');
const PR = { count: 5136, rate_text: 0.03, rate_image: 0.05, as_of: '2026-11-01' };
ok('matches Sky\'s example exactly',
   MK.smsCostLine(PR) === '≈5,136 phones × $0.03 = about $154 per text, about $257 with an image ($0.05)');
ok('no image rate: the text price alone',
   MK.smsCostLine({ count: 5136, rate_text: 0.03 }) === '≈5,136 phones × $0.03 = about $154 per text');
ok('no count: no line (never "$0 per text")', MK.smsCostLine({ rate_text: 0.03 }) === '');
ok('no rate: no line', MK.smsCostLine({ count: 5136 }) === '');
ok('a third-decimal rate keeps its digits', MK.smsCostLine({ count: 1000, rate_text: 0.035 }).indexOf('$0.035') > 0);

const html = MK.smsCostHtml(PR);
ok('labeled a pass-through at Dutchie\'s cost, added to the vendor\'s credit',
   /pass-through at Dutchie’s cost, added to the vendor’s credit/.test(html));
ok('carries the 160-character note', /over 160 characters may bill as more than one message/.test(html));
ok('says when the count was taken', html.indexOf('2026-11-01') > 0);
ok('unset pricing points at Settings', /not set yet/.test(MK.smsCostHtml({})) && /Settings/.test(MK.smsCostHtml({})));
ok('still loading says so', /Loading/.test(MK.smsCostHtml(undefined)));

/* ── 2. on the card, under the cost model picker ───────────────────────────────────────────────── */
console.log('2. the Text blast card');
const program = { program_id: 'x', vendor: 'Grön', start_date: '2026-11-16', end_date: '2026-11-29',
  marketing_json: { v: 1, sel: { sms: true }, d: {} } };
const card = MK.sectionHtml(program, { today: '2026-11-03', canEdit: true, engineReady: true,
  stores: [{ store_id: 'bend', name: 'Bend' }], storeName: s => s, smsPricing: PR });
const at = card.indexOf('data-mk-field="cost"'), line = card.indexOf('Cost per send'), send = card.indexOf('data-mk-field="date"', at);
ok('the cost line is on the card', line > 0);
ok('it sits after the cost model picker and before the send date', at > 0 && line > at && (send < 0 || line < send));
const emailOnly = MK.sectionHtml(Object.assign({}, program, { marketing_json: { v: 1, sel: { email: true }, d: {} } }),
  { today: '2026-11-03', canEdit: true, engineReady: true, stores: [{ store_id: 'bend', name: 'Bend' }], storeName: s => s, smsPricing: PR });
ok('an email-only plan shows no text cost', emailOnly.indexOf('Cost per send') < 0);

/* ── 3. the engine: settings, not constants ─────────────────────────────────────────────────────── */
console.log('3. the engine');
function engine(props, role) {
  const P = G.makeProps(props);
  const api = G.load({
    real: ['smsPricingRead_', 'saveSmsPricing_'],
    vars: ['SMS_PRICING_PROPS_'],
    stubs: { mktEditor_: () => role === 'viewer' ? { fail: { ok: false, error: 'Your role (viewer) cannot change text blast pricing' } }
                                                : { auth: { user: 'tawny', role: 'editor' } } },
    globals: { PropertiesService: P.PropertiesService }
  });
  return { api, props: P.props };
}
let e = engine({});
let r = e.api.smsPricingRead_();
ok('unset reads as null, not 0', r.ok && r.pricing.count === null && r.pricing.rate_text === null && r.pricing.rate_image === null);

r = e.api.saveSmsPricing_({ count: '5,136', rate_text: '$0.03', rate_image: '0.05', as_of: '2026-11-01' });
ok('an editor saves; commas and $ are accepted', r.ok && r.pricing.count === 5136 && r.pricing.rate_text === 0.03 && r.pricing.rate_image === 0.05);
ok('stored as script properties', e.props.SMS_LIST_COUNT === '5136' && e.props.SMS_RATE_TEXT === '0.03' && e.props.SMS_LIST_AS_OF === '2026-11-01');

r = e.api.saveSmsPricing_({ count: '5136', rate_text: '3', rate_image: '0.05' });
ok('a rate over $1 (3 for 0.03) is refused', !r.ok && e.props.SMS_RATE_TEXT === '0.03');
r = e.api.saveSmsPricing_({ count: '51.5', rate_text: '0.03', rate_image: '0.05' });
ok('a fractional list size is refused', !r.ok && e.props.SMS_LIST_COUNT === '5136');
r = e.api.saveSmsPricing_({ count: '5136', rate_text: '0.03', rate_image: '0.05', as_of: 'Nov 1' });
ok('a non-ISO count date is refused', !r.ok);
r = e.api.saveSmsPricing_({ count: '5136', rate_text: '0.03', rate_image: '' });
ok('a blank clears that setting', r.ok && r.pricing.rate_image === null && !('SMS_RATE_IMAGE' in e.props));

e = engine({ SMS_LIST_COUNT: '5136' }, 'viewer');
r = e.api.saveSmsPricing_({ count: '1', rate_text: '0.03' });
ok('a viewer cannot change it', !r.ok && e.props.SMS_LIST_COUNT === '5136');

/* ── 4. wiring (SOURCE-SHAPED) ──────────────────────────────────────────────────────────────────── */
console.log('4. wiring');
const gs = G.GS, mk = fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8');
ok('[source] router has both routes', /case 'smsPricing':\s*out = smsPricingRead_\(p\);/.test(gs)
   && /case 'saveSmsPricing':\s*out = saveSmsPricing_\(p\);/.test(gs));
ok('[source] the save is not on the deploy-secret-only list', !/SECRET_ACTIONS = \[[^\]]*saveSmsPricing/.test(gs));
ok('[source] marketing.js holds no list size or rate constant', !/5136|5,136|0\.03\b|0\.05\b/.test(mk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
