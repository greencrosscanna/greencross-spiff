#!/usr/bin/env node
/* ─── A store link that did not reach the Command Center is SHOWN, per store, until it does ───────
 *
 *   RUN:  node tests/kiosk_link_notice_test.js
 *
 * WHY
 * Settings → Kiosk links has two writes, and the engine tells both when a link was saved here but
 * did not reach GX Core: `storeLinkMintAll` answers `publish_failed` + `publish_note`, and
 * `storeLinkRotate` answers `published: false` + `publish_note` / `publish_error`. Until v1.458
 * neither reached a person. "Create links" discarded the reply and reloaded the list. "Replace"
 * wrote the note into #kioskMsg and then reloaded the list as well — and the reload rebuilds the
 * panel, so the note was replaced by an empty span on the next line. Both looked like success.
 *
 * v1.459 made the warning PER STORE and gave it a button. v1.458 held one notice and let any clean
 * run clear it, so a warning about two stores vanished when a third store's link was replaced. Now
 * a store leaves the warning only when a reply says THAT store reached Core, and "Republish to
 * Command Center" (the engine's storeLinksRepublish) is the step the warning used to quote as a URL.
 *
 * WHAT THIS FILE RUNS. The shipped functions, lifted out of spiff.js by name: mintAllKioskLinks,
 * rotateKioskLink, republishKioskLinks, loadKioskLinks, renderKioskLinks, kioskApplyReply,
 * kioskNoticeHtml, wireKioskNotice, esc and storeUrl. The edges are stubbed: the transport
 * (ENG.jsonp answers from a scripted queue) and the DOM. The DOM stub does ONE thing that matters,
 * and it is the thing the first bug was: assigning host.innerHTML REPLACES #kioskMsg with a fresh
 * empty element, as a browser does. A stub that kept the old element would pass against the code
 * that lost the note.
 *
 * What it cannot see: that `.sp-notice.is-warn` actually paints, and that the real buttons reach
 * these handlers on a click in a browser. Those need the screen and an editor session. The engine
 * side of Republish (who may call it) is in kiosk_token_publish_test.js section 7.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

const LINKS = [
  { store_id: 'bend',       display_name: 'Century',    token: 't-bend',  ever: true },
  { store_id: 'river-rd',   display_name: 'River',      token: 't-river', ever: true },
  { store_id: 'commercial', display_name: 'Commercial', token: 't-comm',  ever: true },
];
const LIST_OK = { ok: true, links: LINKS, missing: 0 };

/* One panel. `replies` is a queue per action; an Error in the queue is thrown, as a dropped
   request would be. `storeLinks` falls back to a good list when its queue is empty, so a scenario
   only scripts the reloads it cares about. */
function panel(replies, opts) {
  opts = opts || {};
  const q = {};
  Object.keys(replies || {}).forEach(k => { q[k] = replies[k].slice(); });
  const asked = [];
  let msg = { textContent: '' };
  let html = '';
  const host = {
    get innerHTML() { return html; },
    set innerHTML(v) { html = String(v); msg = { textContent: '' }; },   // a re-render rebuilds #kioskMsg
    querySelectorAll() { return []; },
  };
  /* #kioskMsg exists only when the current markup contains it — so a branch that renders no
     message line gives a refusal nowhere to go, and the test can see that. */
  const $ = (sel) => sel === '#kioskBody' ? host
    : (sel === '#kioskMsg' ? (html.indexOf('id="kioskMsg"') >= 0 ? msg : null) : null);
  const ENG = { jsonp(action, params) {
    asked.push(action);
    let next = (q[action] || []).shift();
    if (next === undefined && action === 'storeLinks') next = LIST_OK;
    if (next === undefined) return Promise.reject(new Error('test: no scripted reply for ' + action));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  } };
  const src = [
    'var kioskLoaded = false;',
    'var kioskOutstanding = Object.create(null);',
    'var kioskUnchecked = [];',
    'var kioskJustPublished = Object.create(null);',
    /* Read out of the shipped file, not retyped: the reasons are what a person reads. */
    (js.match(/var KIOSK_TRUST_REPLY_MS = [^;]+;/) || ['MISSING KIOSK_TRUST_REPLY_MS'])[0],
    (js.match(/var KIOSK_CHECK_REASON = \{[\s\S]*?\};/) || ['MISSING KIOSK_CHECK_REASON'])[0],
    G.grab('esc', js), G.grab('storeUrl', js),
    'function copyText() { return Promise.resolve(true); }',
    'function copyKioskLink() {}',
    G.grab('kioskOutstandingIds', js), G.grab('kioskApplyCheck', js), G.grab('kioskUncheckedHtml', js),
    G.grab('kioskApplyReply', js), G.grab('kioskNoticeHtml', js),
    G.grab('republishKioskLinks', js), G.grab('wireKioskNotice', js),
    G.grab('mintAllKioskLinks', js), G.grab('renderKioskLinks', js),
    G.grab('loadKioskLinks', js), G.grab('rotateKioskLink', js),
    'return { mint: mintAllKioskLinks, rotate: rotateKioskLink, republish: republishKioskLinks,',
    '         load: loadKioskLinks, apply: kioskApplyReply, noticeHtml: kioskNoticeHtml,',
    '         applyCheck: kioskApplyCheck, unchecked: function () { return kioskUnchecked.slice().sort(); },',
    '         outstanding: function () { return kioskOutstandingIds().sort(); } };',
  ].join('\n');
  const api = new Function('$', 'ENG', 'session', 'canEdit', 'confirm', 'setTimeout', 'location', src)(
    $, ENG, () => ({ token: 'TOKEN' }), () => opts.canEdit !== false, () => true, () => {},
    { origin: 'https://example.test', pathname: '/spiff/index.html' });
  return {
    api, asked,
    html: () => html,
    msg: () => msg.textContent,
    notice: () => (html.split('id="kioskNotice"')[1] || '').split('<table')[0].split('<p class="hint">Could not')[0],
    hasButton: () => html.indexOf('id="kioskRepublish"') >= 0,
    /* What a person can read: the markup with tags dropped, plus the message line. Entities are
       left encoded on purpose — section 4 asserts on them. */
    seen: () => html.replace(/<[^>]*>/g, ' ') + ' ' + msg.textContent,
  };
}
const btn = (text) => ({ textContent: text || 'Create links', disabled: false });

const NOTE = 'Minted, but 2 store link(s) did not reach GX Core, so Leaderboard cannot build the '
           + 'link for those stores. Re-run ?action=publishKioskTokens&apply=1 once Core is reachable.';
const PARTIAL = { ok: true, minted: ['bend', 'river-rd', 'commercial'], published: ['bend'],
                  publish_failed: [{ store_id: 'river-rd', error: 'GX Core unreachable: timeout' },
                                   { store_id: 'commercial', error: 'GX Core unreachable: timeout' }],
                  publish_note: NOTE };
const CLEAN = { ok: true, minted: ['bend'], published: ['bend'], publish_failed: [], publish_note: '' };
const rot = (store, published, err) => ({ ok: true, store_id: store, token: 'new', published: published,
                                          publish_error: err || '', publish_note: err ? 'engine note' : '' });

(async function () {
  /* ══ 0. the reply shapes this file assumes are the ones the engine sends ══ */
  console.log('\n0. the field names are the engine\'s own');
  const mintSrc = G.grab('storeLinkMintAll_'), rotSrc = G.grab('storeLinkRotate_'), repSrc = G.grab('storeLinksRepublish_');
  ok('storeLinkMintAll_ answers published, publish_failed and publish_note',
     /published:\s*published/.test(mintSrc) && /publish_failed:\s*failed/.test(mintSrc) && /publish_note:/.test(mintSrc));
  ok('  …and each failure is { store_id, error }', /\{\s*store_id:\s*id,\s*error:\s*r\.error\s*\}/.test(mintSrc));
  ok('storeLinkRotate_ answers published, publish_error and publish_note',
     /published:\s*pub\.ok/.test(rotSrc) && /publish_error:/.test(rotSrc) && /publish_note:/.test(rotSrc));
  ok('storeLinksRepublish_ answers the same two lists as Create',
     /published:\s*res\.plan/.test(repSrc) && /publish_failed:\s*failed/.test(repSrc));

  /* ══ 1. Create links, some did not reach Core ══ */
  console.log('\n1. a partial failure of "Create links" is shown, and names the stores');
  let P = panel({ storeLinkMintAll: [PARTIAL] });
  await P.api.mint(btn());
  ok('the panel says the links did not reach the Command Center',
     /These store links were saved here but did not reach the Command Center/.test(P.seen()));
  ok('it says how many stores', /2 stores:/.test(P.seen()));
  ok('it names WHICH stores, by their display names', /River, Commercial/.test(P.notice()));
  ok('  …and does not name the store that did reach Core', P.notice().length > 0 && !/Century/.test(P.notice()));
  ok('it carries the reason the engine gave', /Reason: GX Core unreachable: timeout/.test(P.seen()));
  ok('it uses the existing warning block, not a new style', /class="sp-notice is-warn" id="kioskNotice"/.test(P.html()));
  ok('it is in the RENDERED panel, so the reload that follows cannot erase it',
     P.asked.join(',') === 'storeLinkMintAll,storeLinks' && /id="kioskNotice"/.test(P.html()));
  ok('it points at the button, and does not quote a URL at a person',
     P.hasButton() && /Republish to Command Center/.test(P.notice())
     && P.notice().indexOf('?action=') < 0 && P.notice().indexOf('publishKioskTokens') < 0);

  /* ══ 2. full success looks exactly as it did ══ */
  console.log('\n2. a full success shows no notice and no button');
  P = panel({ storeLinkMintAll: [CLEAN] });
  await P.api.mint(btn());
  ok('no notice block is rendered', P.html().indexOf('kioskNotice') < 0 && P.html().indexOf('sp-notice') < 0);
  ok('no Republish button is rendered', !P.hasButton());
  ok('the message line is empty', P.msg() === '');
  ok('the list itself rendered', /class="sp-klinks"/.test(P.html()) && /Century/.test(P.html()));

  /* ══ 3. per store: only a store's OWN success clears it ══ */
  console.log('\n3. a store leaves the warning only when a reply says THAT store reached Core');
  P = panel({ storeLinkMintAll: [PARTIAL, CLEAN] });
  await P.api.mint(btn());
  ok('(first run: River and Commercial are outstanding)', P.api.outstanding().join(',') === 'commercial,river-rd');
  await P.api.mint(btn());
  ok('a later Create that only published Century does NOT clear them',
     P.api.outstanding().join(',') === 'commercial,river-rd' && /River, Commercial/.test(P.notice()));

  P = panel({ storeLinkMintAll: [PARTIAL], storeLinkRotate: [rot('bend', true)] });
  await P.api.mint(btn());
  await P.api.rotate('bend', btn('Replace'));
  ok('a clean Replace of an UNRELATED store does not clear another store\'s warning',
     P.api.outstanding().join(',') === 'commercial,river-rd' && /2 stores:/.test(P.seen()));

  P = panel({ storeLinkMintAll: [PARTIAL], storeLinkRotate: [rot('river-rd', true)] });
  await P.api.mint(btn());
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a clean Replace of River clears River and only River',
     P.api.outstanding().join(',') === 'commercial' && /1 store:<\/b> Commercial/.test(P.html())
     && !/River/.test(P.notice()));
  ok('  …and the wording goes singular', /This store&rsquo;s link was saved here/.test(P.notice()));

  P = panel({ storeLinkMintAll: [PARTIAL] });
  await P.api.mint(btn());
  await P.api.load(true);
  ok('a plain re-render with nothing fixed KEEPS it — it is state, not a one-shot',
     /id="kioskNotice"/.test(P.html()) && /River, Commercial/.test(P.notice()));

  P = panel({ storeLinkRotate: [rot('river-rd', false, 'GX Core refused the write'),
                                { ok: true, store_id: 'river-rd', token: 'n' }] });
  await P.api.rotate('river-rd', btn('Replace'));
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a reply that says nothing either way about publishing leaves the store outstanding',
     P.api.outstanding().join(',') === 'river-rd');

  /* ══ 4. reply text is escaped ══ */
  console.log('\n4. nothing from the reply reaches the DOM unescaped');
  const EVIL = { ok: true, minted: ['x'], published: [],
                 publish_failed: [{ store_id: '<b>bad</b>', error: '<script>alert(1)</script>' }],
                 publish_note: 'note <img src=x onerror=alert(1)> end' };
  P = panel({ storeLinkMintAll: [EVIL] });
  await P.api.mint(btn());
  ok('(the notice rendered at all)', P.notice().length > 0);
  ok('the reason\'s markup is escaped', P.html().indexOf('<script') < 0 && P.notice().indexOf('&lt;script') >= 0);
  ok('a store id that is not in the list is shown as the id, escaped',
     P.notice().indexOf('<b>bad</b>') < 0 && P.notice().indexOf('&lt;b&gt;bad') >= 0);
  ok('the engine\'s note is not rendered at all, so its markup cannot arrive either',
     P.html().indexOf('<img') < 0 && P.html().indexOf('onerror') < 0);
  P = panel({ storeLinkMintAll: [{ ok: true, minted: [], published: [], publish_note: '',
              publish_failed: [{ store_id: 'bend', error: '<i>one</i>' }, { store_id: 'river-rd', error: 'two' }] }] });
  await P.api.mint(btn());
  ok('when reasons differ they are shown per store, and still escaped',
     /Century \(&lt;i&gt;one&lt;\/i&gt;\), River \(two\)/.test(P.notice()) && P.notice().indexOf('<i>') < 0);

  /* ══ 5. Replace ══ */
  console.log('\n5. "Replace" shows the same warning — it used to write it and immediately erase it');
  P = panel({ storeLinkRotate: [rot('river-rd', false, 'GX Core refused the write'), rot('river-rd', true)] });
  await P.api.rotate('river-rd', btn('Replace'));
  ok('the failed replace is still on the panel after the reload',
     /This store&rsquo;s link was saved here but did not reach the Command Center/.test(P.notice()));
  ok('it names the one store, by name', /1 store:<\/b> River/.test(P.html()));
  ok('it carries the engine\'s reason', /Reason: GX Core refused the write/.test(P.seen()));
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a clean replace of the SAME store afterwards clears it', P.html().indexOf('kioskNotice') < 0);
  P = panel({ storeLinkRotate: [rot('river-rd', true)] });
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a clean replace on its own shows nothing', P.html().indexOf('sp-notice') < 0 && P.msg() === '');
  P = panel({ storeLinkRotate: [{ ok: true, store_id: 'bend', token: 'n', published: false }] });
  await P.api.rotate('bend', btn('Replace'));
  ok('a reply with published:false and no note or reason still says something',
     /did not reach the Command Center/.test(P.seen()) && /1 store:<\/b> Century/.test(P.html()));

  /* ══ 6. the reload failing must not hide what the action reported ══ */
  console.log('\n6. if the list cannot reload, the warning and its button are still there');
  P = panel({ storeLinkMintAll: [PARTIAL], storeLinks: [new Error('timeout')] });
  await P.api.mint(btn());
  ok('the warning is shown above the could-not-load line',
     /id="kioskNotice"/.test(P.html()) && /Could not load kiosk links: timeout/.test(P.seen())
     && P.html().indexOf('kioskNotice') < P.html().indexOf('Could not load'));
  ok('with no list in hand it falls back to the store ids', /river-rd, commercial/.test(P.notice()));
  ok('the Republish button is offered there too', P.hasButton());
  /* Press Republish from the could-not-load branch, and have it refused. */
  const stuck = panel({ storeLinkMintAll: [PARTIAL], storeLinks: [new Error('timeout')],
                        storeLinksRepublish: [{ ok: false, error: 'Not signed in' }] });
  await stuck.api.mint(btn());
  await stuck.api.republish(btn('Republish to Command Center'));
  ok('  …and a refusal from that branch has a message line to land on', /Not signed in/.test(stuck.msg()));

  /* ══ 7. the request itself failing keeps today's behavior ══ */
  console.log('\n7. a refused or dropped Create still says so on the message line');
  P = panel({ storeLinkMintAll: [{ ok: false, error: 'Your role (viewer) cannot manage kiosk links' }] });
  await P.api.load(true);
  const b = btn();
  await P.api.mint(b);
  ok('a refusal is shown', /cannot manage kiosk links/.test(P.msg()));
  ok('the button says Failed and is usable again', b.textContent === 'Failed' && b.disabled === false);
  ok('it did not reload the list over the message', P.asked.join(',') === 'storeLinks,storeLinkMintAll');
  P = panel({ storeLinkMintAll: [new Error('JSONP timeout')] });
  await P.api.load(true);
  await P.api.mint(btn());
  ok('a dropped request is shown', /JSONP timeout/.test(P.msg()));

  /* ══ 8. Republish to Command Center ══ */
  console.log('\n8. Republish clears exactly the stores that published, and keeps the rest with their reason');
  P = panel({ storeLinkMintAll: [PARTIAL],
              storeLinksRepublish: [{ ok: true, stores: 3, published: ['bend', 'river-rd'],
                                      publish_failed: [{ store_id: 'commercial', error: 'GX Core refused the write' }],
                                      publish_note: 'x' }] });
  await P.api.mint(btn());
  const rb = btn('Republish to Command Center');
  const pending = P.api.republish(rb);
  ok('the button is busy while it runs', rb.disabled === true && rb.textContent === 'Republishing…');
  await pending;
  ok('it calls the engine\'s session route, not the secret one',
     P.asked.indexOf('storeLinksRepublish') >= 0 && P.asked.indexOf('publishKioskTokens') < 0);
  ok('River published, so River is gone; Commercial failed, so Commercial stays',
     P.api.outstanding().join(',') === 'commercial' && /1 store:<\/b> Commercial/.test(P.html())
     && !/River/.test(P.notice()));
  ok('  …with the NEW reason the engine gave, not the old one',
     /Reason: GX Core refused the write/.test(P.seen()) && !/timeout/.test(P.notice()));
  ok('  …and the button is still offered, because something is still outstanding', P.hasButton());

  P = panel({ storeLinkMintAll: [PARTIAL],
              storeLinksRepublish: [{ ok: true, stores: 3, published: ['bend', 'river-rd', 'commercial'],
                                      publish_failed: [], publish_note: '' }] });
  await P.api.mint(btn());
  await P.api.republish(btn('Republish to Command Center'));
  ok('a republish that reaches every store removes the warning and the button',
     P.api.outstanding().length === 0 && P.html().indexOf('kioskNotice') < 0 && !P.hasButton());

  P = panel({ storeLinkMintAll: [PARTIAL],
              storeLinksRepublish: [{ ok: false, error: 'Your role (viewer) cannot manage kiosk links' }] });
  await P.api.mint(btn());
  const rb2 = btn('Republish to Command Center');
  await P.api.republish(rb2);
  ok('a REFUSED republish is shown on the message line', /Republish did not go through: Your role \(viewer\)/.test(P.msg()));
  ok('  …the button says Failed and can be pressed again', rb2.textContent === 'Failed' && rb2.disabled === false);
  ok('  …and the warning is untouched — nothing is known to have changed',
     P.api.outstanding().join(',') === 'commercial,river-rd' && /River, Commercial/.test(P.notice()));

  P = panel({ storeLinkMintAll: [PARTIAL], storeLinksRepublish: [new Error('JSONP timeout')] });
  await P.api.mint(btn());
  await P.api.republish(btn('Republish to Command Center'));
  ok('a DROPPED republish is shown too', /Republish did not go through: JSONP timeout/.test(P.msg())
     && P.api.outstanding().length === 2);

  /* ══ 9. who is offered the button ══ */
  console.log('\n9. the button is absent with nothing outstanding, and absent for a non-editor');
  P = panel({});
  await P.api.load(true);
  ok('nothing outstanding: no warning, no button', P.html().indexOf('kioskNotice') < 0 && !P.hasButton());
  /* A non-editor never reaches the list at all (the panel is the managed-by-an-editor line), so
     the gate on the button is exercised on the function that draws the warning, with the same
     outstanding stores for both people. The first cut of this check went through the panel and
     passed with the gate removed, because a non-editor's panel never drew the warning either way. */
  const V = panel({}, { canEdit: false }), E = panel({});
  V.api.apply(PARTIAL); E.api.apply(PARTIAL);
  ok('(an editor shown the warning IS offered the button)',
     /2 stores:/.test(E.api.noticeHtml(LINKS)) && /id="kioskRepublish"/.test(E.api.noticeHtml(LINKS)));
  ok('a non-editor shown the SAME warning is NOT offered the button',
     /2 stores:/.test(V.api.noticeHtml(LINKS)) && !/kioskRepublish/.test(V.api.noticeHtml(LINKS)));
  await V.api.load(true);
  ok('  …and the non-editor\'s panel is the managed-by-an-editor line, with no button',
     /managed by an editor/.test(V.seen()) && !V.hasButton());

  /* ══ 11. the warning survives a reload: the list read says which stores Core is out of step on ══ */
  console.log('\n11. on opening the panel, the engine\'s check rebuilds the warning');
  const listWith = (check) => Object.assign({}, LIST_OK, { core_check: check });
  /* A FRESH panel is a reloaded page: nothing in memory. */
  P = panel({ storeLinks: [listWith({ bend: 'in_sync', 'river-rd': 'differs', commercial: 'in_sync' })] });
  await P.api.load(true);
  ok('a store the check says differs is warned about, with no action taken this session',
     P.api.outstanding().join(',') === 'river-rd' && /1 store:<\/b> River/.test(P.html()));
  ok('  …with a reason a person can read', /Reason: The Command Center holds a different link, or none/.test(P.seen()));
  ok('  …and the Republish button, exactly as after a failed Create or Replace', P.hasButton());
  ok('  …from the ONE list call the panel already made — no second request', P.asked.join(',') === 'storeLinks');

  P = panel({ storeLinks: [listWith({ bend: 'in_sync', 'river-rd': 'in_sync', commercial: 'in_sync' })] });
  await P.api.load(true);
  ok('everything in sync: no warning, no button, no extra line',
     P.html().indexOf('kioskNotice') < 0 && !P.hasButton() && P.html().indexOf('kioskUnchecked') < 0);

  P = panel({ storeLinks: [listWith({ bend: 'in_sync', 'river-rd': 'in_sync', commercial: 'core_only' })] });
  await P.api.load(true);
  ok('Core still holding a link SPIFF no longer has is warned about, in its own words',
     P.api.outstanding().join(',') === 'commercial'
     && /still holds a link this store no longer has/.test(P.seen()) && P.hasButton());

  P = panel({ storeLinks: [listWith({ bend: 'unchecked', 'river-rd': 'unchecked', commercial: 'unchecked' })] });
  await P.api.load(true);
  ok('"could not ask Core" is NOT shown as a warning about the links',
     P.api.outstanding().length === 0 && P.html().indexOf('kioskNotice') < 0 && !P.hasButton());
  ok('  …and NOT shown as all clear either: the panel says the check could not run',
     /id="kioskUnchecked"/.test(P.html()) && /Could not ask the Command Center/.test(P.seen())
     && /Century, River, Commercial/.test(P.seen()) && /the check failing, not the links/.test(P.seen()));
  ok('  …as a hint line, not the warning block', /<p class="hint" id="kioskUnchecked">/.test(P.html()));
  ok('  …and the stores are recorded as unchecked', P.api.unchecked().join(',') === 'bend,commercial,river-rd');

  P = panel({ storeLinkMintAll: [PARTIAL],
              storeLinks: [listWith({ bend: 'in_sync', 'river-rd': 'unchecked', commercial: 'unchecked' })] });
  await P.api.mint(btn());
  ok('a store already known to be outstanding STAYS outstanding when the check cannot ask',
     P.api.outstanding().join(',') === 'commercial,river-rd' && /Reason: GX Core unreachable: timeout/.test(P.seen()));

  P = panel({ storeLinkMintAll: [PARTIAL],
              storeLinks: [listWith({ bend: 'in_sync', 'river-rd': 'in_sync', commercial: 'differs' })] });
  await P.api.mint(btn());
  ok('MERGE: the check says River is in sync, so River leaves; Commercial stays',
     P.api.outstanding().join(',') === 'commercial');
  ok('  …and Commercial keeps the engine\'s own reason, not the check\'s generic one',
     /Reason: GX Core unreachable: timeout/.test(P.seen()) && !/holds a different link/.test(P.notice()));

  P = panel({ storeLinks: [listWith({ bend: 'differs' }), LIST_OK] });
  await P.api.load(true);
  await P.api.load(true);
  ok('an engine that sends no core_check leaves what is known exactly as it was',
     P.api.outstanding().join(',') === 'bend');

  P = panel({ storeLinks: [listWith({ bend: 'something_new', 'river-rd': 'differs' })] });
  await P.api.load(true);
  ok('a state word this page does not know makes no claim either way', P.api.outstanding().join(',') === 'river-rd');

  /* The library keeps each kv answer for 60s, so the reload right after a successful Republish can
     still be told "differs" about a store that reply just said reached Core. */
  P = panel({ storeLinks: [listWith({ 'river-rd': 'differs' }), listWith({ 'river-rd': 'differs' })],
              storeLinksRepublish: [{ ok: true, stores: 3, published: ['bend', 'river-rd', 'commercial'],
                                      publish_failed: [], publish_note: '' }] });
  await P.api.load(true);
  await P.api.republish(btn('Republish to Command Center'));
  ok('a stale "differs" in the reload right after a successful Republish does not bring the warning back',
     P.api.outstanding().length === 0 && P.html().indexOf('kioskNotice') < 0);
  P.api.applyCheck({ 'river-rd': 'differs' }, Date.now() + 5 * 60 * 1000);
  ok('  …but the same answer five minutes later is believed', P.api.outstanding().join(',') === 'river-rd');

  P = panel({ storeLinks: [listWith({ '<b>x</b>': 'unchecked' })] });
  await P.api.load(true);
  ok('a store id in the unchecked line is escaped', P.html().indexOf('<b>x</b>') < 0 && P.html().indexOf('&lt;b&gt;x') >= 0);

  /* ══ 10. wiring ══ */
  console.log('\n10. the real buttons are wired to the handlers tested above');
  /* SOURCE-SHAPED on purpose: click wiring cannot run without a browser. */
  ok('renderKioskLinks hands #kioskMintAll to mintAllKioskLinks',
     /mintAll\.addEventListener\('click', function \(\) \{ mintAllKioskLinks\(mintAll\); \}\)/
       .test(G.grab('renderKioskLinks', js)));
  ok('renderKioskLinks paints the warning and wires its button',
     /kioskNoticeHtml\(links\)/.test(G.grab('renderKioskLinks', js)) && /wireKioskNotice\(\)/.test(G.grab('renderKioskLinks', js)));
  ok('the could-not-load branch wires it too', /wireKioskNotice\(\)/.test(G.grab('loadKioskLinks', js)));
  ok('wireKioskNotice hands #kioskRepublish to republishKioskLinks',
     /rb\.addEventListener\('click', function \(\) \{ republishKioskLinks\(rb\); \}\)/.test(G.grab('wireKioskNotice', js)));
  ok('the button is gated on canEdit(), the same signal as Create and Replace',
     /canEdit\(\)\s*\?\s*'<div class="share-row"><button[^']*id="kioskRepublish"/.test(G.grab('kioskNoticeHtml', js)));

  console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
