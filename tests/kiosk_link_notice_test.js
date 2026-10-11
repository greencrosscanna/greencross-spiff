#!/usr/bin/env node
/* ─── A store link that did not reach the Command Center is SHOWN, and stays shown ────────────────
 *
 *   RUN:  node tests/kiosk_link_notice_test.js
 *
 * WHY
 * Settings → Kiosk links has two writes, and the engine tells both when a link was minted here but
 * did not reach GX Core: `storeLinkMintAll` answers `publish_failed` + `publish_note`, and
 * `storeLinkRotate` answers `published: false` + `publish_note` / `publish_error`. Until v1.458
 * neither reached a person. "Create links" discarded the reply and reloaded the list. "Replace"
 * wrote the note into #kioskMsg and then reloaded the list as well — and the reload rebuilds the
 * panel, so the note was replaced by an empty span on the next line. Both looked like success.
 *
 * WHAT THIS FILE RUNS. The shipped functions, lifted out of spiff.js by name: mintAllKioskLinks,
 * rotateKioskLink, loadKioskLinks, renderKioskLinks, kioskPublishNotice, kioskNoticeHtml, esc and
 * storeUrl. The edges are stubbed: the transport (ENG.jsonp answers from a scripted queue) and the
 * DOM. The DOM stub does ONE thing that matters, and it is the thing the bug was: assigning
 * host.innerHTML REPLACES #kioskMsg with a fresh empty element, as a browser does. A stub that kept
 * the old element would pass against the code that lost the note.
 *
 * What it cannot see: that `.sp-notice.is-warn` actually paints, and that the real buttons are
 * wired to these handlers in a browser. Those need the screen and an editor session.
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
   request would be. */
function panel(replies) {
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
  const $ = (sel) => sel === '#kioskBody' ? host : (sel === '#kioskMsg' ? msg : null);
  const ENG = { jsonp(action, params) {
    asked.push(action);
    const next = (q[action] || []).shift();
    if (next === undefined) return Promise.reject(new Error('test: no scripted reply for ' + action));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  } };
  const src = [
    'var kioskLoaded = false;',
    'var kioskNotice = null;',
    G.grab('esc', js), G.grab('storeUrl', js),
    'function copyText() { return Promise.resolve(true); }',
    G.grab('kioskPublishNotice', js), G.grab('kioskNoticeHtml', js),
    G.grab('mintAllKioskLinks', js), G.grab('renderKioskLinks', js),
    G.grab('loadKioskLinks', js), G.grab('rotateKioskLink', js),
    'return { mint: mintAllKioskLinks, rotate: rotateKioskLink, load: loadKioskLinks };',
  ].join('\n');
  const api = new Function('$', 'ENG', 'session', 'canEdit', 'confirm', 'setTimeout', 'location', src)(
    $, ENG, () => ({ token: 'TOKEN' }), () => true, () => true, () => {},
    { origin: 'https://example.test', pathname: '/spiff/index.html' });
  return {
    api, asked,
    html: () => html,
    msg: () => msg.textContent,
    /* What a person can read on the panel: the rendered markup with tags dropped, plus the message
       line. Entities are left encoded on purpose — section 4 asserts on them. */
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

(async function () {
  /* ══ 0. the reply shape this file assumes is the one the engine sends ══ */
  console.log('\n0. the field names are the engine\'s own');
  const mintSrc = G.grab('storeLinkMintAll_'), rotSrc = G.grab('storeLinkRotate_');
  ok('storeLinkMintAll_ answers publish_failed and publish_note',
     /publish_failed:\s*failed/.test(mintSrc) && /publish_note:/.test(mintSrc));
  ok('  …and each failure is { store_id, error }', /\{\s*store_id:\s*id,\s*error:\s*r\.error\s*\}/.test(mintSrc));
  ok('storeLinkRotate_ answers published, publish_error and publish_note',
     /published:\s*pub\.ok/.test(rotSrc) && /publish_error:/.test(rotSrc) && /publish_note:/.test(rotSrc));

  /* ══ 1. Create links, some did not reach Core ══ */
  console.log('\n1. a partial failure of "Create links" is shown, and names the stores');
  let P = panel({ storeLinkMintAll: [PARTIAL], storeLinks: [LIST_OK] });
  await P.api.mint(btn());
  ok('the engine\'s own note is on the panel', P.seen().indexOf('2 store link(s) did not reach GX Core') >= 0);
  ok('it says how many stores', /2 stores:/.test(P.seen()));
  ok('it names WHICH stores, by their display names', /River, Commercial/.test(P.seen()));
  const first = (P.html().split('id="kioskNotice"')[1] || '').split('</div>')[0];
  ok('  …and does not name the store that did reach Core',
     first.length > 0 && !/Century/.test(first));
  ok('it carries the reason the engine gave', /Reason: GX Core unreachable: timeout/.test(P.seen()));
  ok('it uses the existing warning block, not a new style', /class="sp-notice is-warn" id="kioskNotice"/.test(P.html()));
  ok('it is in the RENDERED panel, so the reload that follows cannot erase it',
     P.asked.join(',') === 'storeLinkMintAll,storeLinks' && /id="kioskNotice"/.test(P.html()));

  /* ══ 2. full success looks exactly as it did ══ */
  console.log('\n2. a full success shows no notice');
  P = panel({ storeLinkMintAll: [CLEAN], storeLinks: [LIST_OK] });
  await P.api.mint(btn());
  ok('no notice block is rendered', P.html().indexOf('kioskNotice') < 0 && P.html().indexOf('sp-notice') < 0);
  ok('the message line is empty', P.msg() === '');
  ok('the list itself rendered', /class="sp-klinks"/.test(P.html()) && /Century/.test(P.html()));

  /* ══ 3. a later clean run clears an earlier notice ══ */
  console.log('\n3. the notice clears on the next clean run, and does not survive as stale text');
  P = panel({ storeLinkMintAll: [PARTIAL, CLEAN], storeLinks: [LIST_OK, LIST_OK] });
  await P.api.mint(btn());
  ok('(first run shows it)', /id="kioskNotice"/.test(P.html()));
  await P.api.mint(btn());
  ok('the second, clean run removes it', P.html().indexOf('kioskNotice') < 0);
  ok('  …and none of its text is left behind', P.seen().indexOf('did not reach') < 0);
  P = panel({ storeLinkMintAll: [PARTIAL], storeLinks: [LIST_OK, LIST_OK] });
  await P.api.mint(btn());
  await P.api.load(true);
  ok('a plain re-render with nothing fixed KEEPS it — it is state, not a one-shot',
     /id="kioskNotice"/.test(P.html()) && /River, Commercial/.test(P.seen()));

  /* ══ 4. reply text is escaped ══ */
  console.log('\n4. nothing from the reply reaches the DOM unescaped');
  const EVIL = { ok: true, minted: ['x'], published: [],
                 publish_failed: [{ store_id: '<b>bad</b>', error: '<script>alert(1)</script>' }],
                 publish_note: 'note <img src=x onerror=alert(1)> end' };
  P = panel({ storeLinkMintAll: [EVIL], storeLinks: [LIST_OK] });
  await P.api.mint(btn());
  const block = P.html().split('id="kioskNotice"')[1] || '';
  ok('(the notice rendered at all)', block.length > 0);
  ok('the note\'s markup is escaped', block.indexOf('<img') < 0 && block.indexOf('&lt;img') >= 0);
  ok('the reason\'s markup is escaped', P.html().indexOf('<script') < 0 && block.indexOf('&lt;script') >= 0);
  ok('a store id that is not in the list is shown as the id, escaped',
     block.indexOf('<b>bad</b>') < 0 && block.indexOf('&lt;b&gt;bad') >= 0);

  /* ══ 5. Replace ══ */
  console.log('\n5. "Replace" shows the same notice — it used to write it and immediately erase it');
  const ROT_BAD = { ok: true, store_id: 'river-rd', token: 'new', published: false,
                    publish_error: 'GX Core refused the write',
                    publish_note: 'The new link works HERE, but GX Core still holds the OLD token.' };
  const ROT_OK = { ok: true, store_id: 'river-rd', token: 'new2', published: true, publish_error: '', publish_note: '' };
  P = panel({ storeLinkRotate: [ROT_BAD, ROT_OK], storeLinks: [LIST_OK, LIST_OK] });
  await P.api.rotate('river-rd', btn('Replace'));
  ok('the failed-rotate note survives the reload', P.seen().indexOf('GX Core still holds the OLD token') >= 0);
  ok('it names the one store, by name', /1 store:<\/b> River/.test(P.html()));
  ok('it carries the engine\'s reason', /Reason: GX Core refused the write/.test(P.seen()));
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a clean replace afterwards clears it', P.html().indexOf('kioskNotice') < 0);
  P = panel({ storeLinkRotate: [ROT_OK], storeLinks: [LIST_OK] });
  await P.api.rotate('river-rd', btn('Replace'));
  ok('a clean replace on its own shows nothing', P.html().indexOf('sp-notice') < 0 && P.msg() === '');
  P = panel({ storeLinkRotate: [{ ok: true, store_id: 'bend', token: 'n', published: false }], storeLinks: [LIST_OK] });
  await P.api.rotate('bend', btn('Replace'));
  ok('a reply with published:false and no note still says something',
     /did not reach the Command Center/.test(P.seen()) && /1 store:<\/b> Century/.test(P.html()));

  /* ══ 6. the reload failing must not hide what the action reported ══ */
  console.log('\n6. if the list cannot reload, the notice is still there');
  P = panel({ storeLinkMintAll: [PARTIAL], storeLinks: [new Error('timeout')] });
  await P.api.mint(btn());
  ok('the notice is shown above the could-not-load line',
     /id="kioskNotice"/.test(P.html()) && /Could not load kiosk links: timeout/.test(P.seen())
     && P.html().indexOf('kioskNotice') < P.html().indexOf('Could not load'));
  ok('with no list in hand it falls back to the store ids', /river-rd, commercial/.test(P.seen()));

  /* ══ 7. the request itself failing keeps today's behavior ══ */
  console.log('\n7. a refused or dropped request still says so on the message line');
  P = panel({ storeLinkMintAll: [{ ok: false, error: 'Your role (viewer) cannot manage kiosk links' }], storeLinks: [LIST_OK] });
  await P.api.load(true);
  const b = btn();
  await P.api.mint(b);
  ok('a refusal is shown', /cannot manage kiosk links/.test(P.msg()));
  ok('the button says Failed and is usable again', b.textContent === 'Failed' && b.disabled === false);
  ok('it did not reload the list over the message', P.asked.join(',') === 'storeLinks,storeLinkMintAll');
  P = panel({ storeLinkMintAll: [new Error('JSONP timeout')], storeLinks: [LIST_OK] });
  await P.api.load(true);
  await P.api.mint(btn());
  ok('a dropped request is shown', /JSONP timeout/.test(P.msg()));

  /* ══ 8. wiring: the button calls the function this file ran ══ */
  console.log('\n8. the real button is wired to the handler tested above');
  /* SOURCE-SHAPED on purpose: click wiring cannot run without a browser. */
  ok('renderKioskLinks hands #kioskMintAll to mintAllKioskLinks',
     /mintAll\.addEventListener\('click', function \(\) \{ mintAllKioskLinks\(mintAll\); \}\)/
       .test(G.grab('renderKioskLinks', js)));
  ok('renderKioskLinks paints the notice', /kioskNoticeHtml\(links\)/.test(G.grab('renderKioskLinks', js)));

  console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
