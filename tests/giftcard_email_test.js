#!/usr/bin/env node
/* ─── The gift-card order email to Mike: timing, once-only, no-actuals, same numbers as Reports ───
 *
 *   RUN:  node tests/giftcard_email_test.js
 *
 * Sky, 2026-11-03: when a program closes, Mike gets the buy list so he does not have to be told by
 * hand — by noon (LA) on the first Monday after the end date, so last-minute fixes land first.
 * Runs the real sendGiftCardEmails_ against a fake sheet; only the sheet, clock, mail and stores
 * are stubbed. The money must equal giftCardListFor_ (the Reports panel's builder), not a second sum.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const SNAP = { at: '2026-11-02 00:56:09', units: 168, earners: 3, earned: 75, rate: 25, partial: [], stores: [
  { store_id: 'bend', units: 90, rows: [
    { name: 'Ann A', employee_id: 'e1', units: 40, hit: true, earned: 25 },
    { name: 'Bo B', employee_id: 'e2', units: 50, hit: true, earned: 25 } ] },
  { store_id: 'river-rd', units: 78, rows: [
    { name: 'Cy C', employee_id: 'e3', units: 78, hit: true, earned: 25 },
    { name: 'Di D', employee_id: 'e4', units: 1, hit: false, earned: 0 } ] } ] };
const ACT = { units_sold: 168, bts_hit: 3, spiff_amount: 25, investment: 75 };

function row(o) {
  const r = PH.map(() => '');
  const set = (k, v) => { r[PH.indexOf(k)] = v; };
  set('program_id', o.id); set('program_name', 'Test Program'); set('vendor', 'Gron');
  set('status', o.status || 'closed');
  set('start_date', '2026-10-19'); set('end_date', o.end || '2026-11-01');
  set('payout_json', JSON.stringify({ model: 'flat', amount: 25 }));
  set('actual_json', o.actual === null ? '' : JSON.stringify(o.actual || ACT));
  set('progress_json', JSON.stringify(SNAP));
  return r;
}

function setup(programs, extraProps) {
  const sheet = G.makeSheet(PH, programs.map(row));
  const P = G.makeProps(Object.assign({ GX_DEPLOY_SECRET: 'S' }, extraProps || {}));
  const mail = [];
  let mailFails = false;
  const api = G.load({
    real: ['sendGiftCardEmails_', 'giftMailDueDay_', 'giftMailIsDue_', 'giftMailText_', 'giftMailHtml_', 'prettyDay_', 'giftCardListFor_', 'rowToProgram_',
           'measuredRowsFor_', 'payoutFactsOf_', 'payoutModelOf_', 'payoutRateOf_', 'moneyStr_', 'slug_',
           'friendlyName_', 'userKey_', 'scrubSecrets_', 'brandProgramLabel_', 'sendMail_',
           'textDate_', 'parseJson_', 'normalizePitch_', 'normalizeMarketing_'],
    vars: ['PROGRAM_HEADERS', 'PITCH_MAX_TIPS', 'PITCH_MAX_LEN', 'GX_SECRET_PROP', 'GIFTMAIL_PREFIX',
           'GIFTMAIL_FROM', 'GIFTMAIL_CC', 'MKT_PEOPLE_', 'MKT_APP_URL'],
    stubs: {
      dataSheet_: () => sheet, spiffProgress_: () => ({ ok: false }), nowStamp_: () => '2026-11-02 12:00:00',
      displayNameMap_: () => ({ byId: {}, byName: {} }),
      gxStores_: () => [{ store_id: 'bend', display_name: 'Bend' }, { store_id: 'river-rd', display_name: 'River Rd' }],
    },
    globals: {
      PropertiesService: P.PropertiesService,
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      MailApp: { sendEmail: (m) => { if (mailFails) throw new Error('mail down'); mail.push(m); } },
    },
  });
  return { api, mail, props: P.props, failMail: () => { mailFails = true; } };
}

const BEFORE_NOON = new Date('2026-11-02T19:00:00Z');   // Mon 11:00 PST
const AFTER_NOON  = new Date('2026-11-02T20:30:00Z');   // Mon 12:30 PST

/* ── when ── */
{
  const s = setup([]);
  ok('a program ending Sunday 11-01 is due Monday 11-02', s.api.giftMailDueDay_('2026-11-01') === '2026-11-02');
  ok('one ending on a Monday is due the NEXT Monday', s.api.giftMailDueDay_('2026-11-02') === '2026-11-09');
  ok('one ending Wednesday is due the following Monday', s.api.giftMailDueDay_('2026-11-04') === '2026-11-09');
}
{
  const s = setup([{ id: 'p1' }]);
  const early = s.api.sendGiftCardEmails_({ apply: true, now: BEFORE_NOON });
  ok('before noon Monday: nothing sent, and it says when', s.mail.length === 0 && early.waiting.length === 1
     && /2026-11-02 12:00/.test(early.waiting[0].send_after));
  const sat = s.api.sendGiftCardEmails_({ apply: true, now: new Date('2026-11-01T22:00:00Z') });
  ok('the day it closes: nothing sent', s.mail.length === 0 && sat.waiting.length === 1);
}

/* ── once ── */
{
  const s = setup([{ id: 'p1' }]);
  const dry = s.api.sendGiftCardEmails_({ now: AFTER_NOON });
  ok('dry by default: previews the email, sends nothing, marks nothing',
     dry.dry && dry.would_send.length === 1 && s.mail.length === 0 && !s.props['giftmail:p1']);
  const first = s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  ok('after noon Monday it sends exactly one email', first.sent.length === 1 && s.mail.length === 1);
  ok('  …to Mike only, from the fixed address map', s.mail[0].to === 'mike@greencrosscanna.com');
  const second = s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  ok('a second run sends nothing', second.sent.length === 0 && s.mail.length === 1
     && second.skipped.some(x => x.why === 'already sent'));
  const third = s.api.sendGiftCardEmails_({ apply: true, now: new Date('2026-11-09T20:30:00Z') });
  ok('a week later still nothing', third.sent.length === 0 && s.mail.length === 1);
  const forced = s.api.sendGiftCardEmails_({ apply: true, force: true, program: 'p1', now: AFTER_NOON });
  ok('only force=1 resends', forced.sent.length === 1 && s.mail.length === 2);
}

/* ── same numbers as Reports ── */
{
  const s = setup([{ id: 'p1' }]);
  s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  const list = s.api.giftCardListFor_(s.api.rowToProgram_(row({ id: 'p1' })));
  const body = s.mail[0].body;
  ok('the Reports builder says 3 cards, $75.00', list.count === 3 && list.total === 75);
  ok('the email says 3 cards and $75.00', /Cards to order : 3/.test(body) && /Total to load  : \$75\.00/.test(body));
  ok('  …by store, with real store names', /Bend — 2 cards, \$50\.00/.test(body) && /River Rd — 1 card, \$25\.00/.test(body));
  ok('  …names who earned, not who only sold', /Cy C/.test(body) && !/Di D/.test(body));
  ok('  …the subject carries the total', /3 cards, \$75\.00/.test(s.mail[0].subject));
  ok('  …copies Tawny, Shawn and Sky',
     ['tawny', 'shawn', 'sky'].every(n => s.mail[0].cc.indexOf(n + '@greencrosscanna.com') >= 0));
  const html = s.mail[0].htmlBody;
  ok('  …goes out as a styled HTML email too (Ops Board look, plain text kept as fallback)',
     /GREEN<\/span>CROSS/.test(html) && /#95c93d/.test(html) && !!s.mail[0].body);
  ok('  …the HTML shows the same totals and names', />3<\/div>/.test(html) && /\$75\.00/.test(html)
     && /Cy C/.test(html) && /Bend/.test(html) && /River Rd/.test(html) && !/Di D/.test(html));
  ok('  …and escapes names', !/<script/.test(html));
}

/* ── no actuals, no send ── */
{
  const s = setup([{ id: 'none', actual: null }, { id: 'zero', actual: { units_sold: 0, bts_hit: 0, investment: 0 } }]);
  const r = s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  ok('no recorded actuals: nothing sent', s.mail.length === 0 && r.skipped.filter(x => /actuals/.test(x.why)).length === 2);
  ok('  …and not marked sent, so it goes out on the run after they are recorded',
     !s.props['giftmail:none'] && !s.props['giftmail:zero']);
}

/* ── scope + failure ── */
{
  const s = setup([{ id: 'old', end: '2026-09-13' }, { id: 'draft', status: 'draft' }]);
  const r = s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  ok('programs closed before launch, and non-closed ones, are never mailed', s.mail.length === 0 && !r.waiting.length);
}
{
  const s = setup([{ id: 'p1' }]);
  s.failMail();
  const r = s.api.sendGiftCardEmails_({ apply: true, now: AFTER_NOON });
  ok('a mail failure is reported, not thrown, and not marked sent (retries next hour)',
     r.failed.length === 1 && !s.props['giftmail:p1']);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
