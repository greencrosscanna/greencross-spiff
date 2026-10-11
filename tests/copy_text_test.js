#!/usr/bin/env node
/* ─── Copy puts the text on the clipboard, and says truthfully whether it did ─────────────────────
 *
 *   RUN:  node tests/copy_text_test.js
 *
 * WHY
 * Sky, 2026-10-10: Copy on a kiosk link said "Copy failed" while selecting the link and copying by
 * hand worked. The cause was not a browser. spiff.js declared `copyText` TWICE in one scope —
 * `copyText(text)` → Promise<boolean>, and later `copyText(text, btn, label)` beside the gift-card
 * buy list. Function declarations hoist and the later one wins, so the kiosk Copy button and the
 * program row's share button were both calling the buy-list version: it returned undefined (read
 * as "failed"), and its clipboard write — which had usually worked — then threw setting
 * `.textContent` on a button nobody passed. The link was on the clipboard under a button saying it
 * was not. Section 0 is the guard for exactly that, and it is the one that would have caught it.
 *
 * The body was also reordered. It used to await navigator.clipboard first and only then try
 * execCommand, by which time the click's user activation is spent (Safari and Firefox refuse
 * execCommand('copy') outside the gesture), so anywhere the async API is refused both paths failed.
 *
 * WHAT THIS FILE RUNS. The shipped copyTextSync, copyText and copyKioskLink, lifted out of spiff.js
 * by name, against a stubbed document and navigator that record ORDER and the state of the field
 * at the instant execCommand is called. What it cannot see is what a real browser does with a
 * real gesture; the report names the browsers this was reasoned about rather than run in.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');

/* A page. `exec` decides what execCommand answers ('yes' | 'no' | 'throw'); `clip` what
   navigator.clipboard.writeText does ('yes' | 'no' | 'absent'). */
function page(o) {
  o = o || {};
  const events = [];
  const snap = {};                       // the field as it was when execCommand was called
  const tas = [];
  const prev = { focused: 0, focus() { this.focused++; doc.activeElement = this; } };
  const mount = (name) => ({
    name, kids: [],
    appendChild(el) { this.kids.push(el); el.parentNode = this; events.push('append:' + name); },
    removeChild(el) { this.kids = this.kids.filter(k => k !== el); el.parentNode = null; events.push('remove:' + name); },
  });
  const body = mount('body'), modal = mount('modal');
  const doc = {
    activeElement: prev,
    body,
    querySelector(sel) { return (o.modalOpen && /modal-back/.test(sel)) ? modal : null; },
    createElement() {
      const ta = { value: '', attrs: {}, style: {}, parentNode: null, focused: false, range: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        focus() { this.focused = true; doc.activeElement = this; },
        select() { this.range = [0, this.value.length]; },
        setSelectionRange(a, b) { this.range = [a, b]; } };
      tas.push(ta);
      return ta;
    },
    execCommand(cmd) {
      events.push('exec');
      const ta = tas[tas.length - 1] || {};
      snap.cmd = cmd; snap.focused = ta.focused; snap.active = doc.activeElement === ta;
      snap.range = ta.range && ta.range.slice(); snap.value = ta.value;
      snap.readonly = 'readonly' in (ta.attrs || {}) || ta.readOnly === true;
      snap.mounted = ta.parentNode ? ta.parentNode.name : null;
      snap.css = String((ta.style || {}).cssText || '');
      if (o.exec === 'throw') throw new Error('NotAllowedError');
      return o.exec !== 'no';
    },
  };
  const navigator = o.clip === 'absent' ? {} : { clipboard: { writeText(t) {
    events.push('clipboard');
    snap.clipText = t;
    return o.clip === 'no' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
  } } };
  const msg = { textContent: '' };
  const src = [
    'function storeUrl(tok) { return "https://example.test/spiff/store.html?t=" + tok; }',
    G.grab('copyTextSync', js), G.grab('copyText', js), G.grab('copyKioskLink', js),
    'return { copyText: copyText, copyTextSync: copyTextSync, copyKioskLink: copyKioskLink };',
  ].join('\n');
  const api = new Function('document', 'navigator', 'window', '$', 'setTimeout', src)(
    doc, navigator, { isSecureContext: true }, (sel) => sel === '#kioskMsg' ? msg : null, () => {});
  return { api, events, snap, tas, prev, body, modal, doc, msg };
}

(async function () {
  /* ══ 0. the bug itself ══ */
  console.log('\n0. `copyText` is declared ONCE — a second declaration silently replaces the first');
  const decls = js.match(/\n\s*(?:async\s+)?function copyText\s*\(/g) || [];
  ok('exactly one `function copyText(` in spiff.js (found ' + decls.length + ')', decls.length === 1);
  ok('  …and it is the one-argument, promise-returning one', /async function copyText\(text\)/.test(G.grab('copyText', js)));
  ok('the buy list calls it and reads its answer, instead of declaring its own',
     /copyText\(rows\.join\('\\n'\)\)\.then\(/.test(G.grab('copyCards', js)));
  ok('the other two callers await its answer too',
     /await copyText\(storeUrl\(b\.dataset\.kcopy\)\)/.test(G.grab('copyKioskLink', js))
     && /await copyText\(clientUrl\(tok\)\)/.test(G.grab('rowShare', js)));
  ok('the old second helper it leaned on is gone as well', !/function fallbackCopy\s*\(/.test(js));

  /* ══ (a) the async API is refused, execCommand works ══ */
  console.log('\n(a) clipboard API refused, execCommand works → true, and execCommand ran inside the gesture');
  let P = page({ exec: 'yes', clip: 'no' });
  let pr = P.api.copyText('hello');
  ok('execCommand has ALREADY run when copyText returns its promise — before any await',
     P.events.indexOf('exec') >= 0);
  ok('  …and the async API had not been touched at that point', P.events.indexOf('clipboard') < 0);
  ok('it resolves true', (await pr) === true);
  ok('the async API is never called when the synchronous copy worked', P.events.indexOf('clipboard') < 0);

  /* ══ (b) execCommand says no, the async API works ══ */
  console.log('\n(b) execCommand answers false, clipboard API works → true');
  P = page({ exec: 'no', clip: 'yes' });
  ok('it resolves true', (await P.api.copyText('hello')) === true);
  ok('execCommand was tried first, then the async API',
     P.events.indexOf('exec') >= 0 && P.events.indexOf('exec') < P.events.indexOf('clipboard'));
  ok('the async API was given the text', P.snap.clipText === 'hello');
  P = page({ exec: 'throw', clip: 'yes' });
  ok('an execCommand that THROWS falls through to the async API as well', (await P.api.copyText('x')) === true);

  /* ══ (c) both fail ══ */
  console.log('\n(c) both fail → false, and the row\'s link is left selected for one keystroke');
  P = page({ exec: 'no', clip: 'no' });
  ok('copyText resolves false, not undefined', (await P.api.copyText('hello')) === false);
  P = page({ exec: 'no', clip: 'absent' });
  ok('with no async API at all it still resolves false', (await P.api.copyText('hello')) === false);

  P = page({ exec: 'no', clip: 'no' });
  const box = { value: 'https://example.test/spiff/store.html?t=TOK', focused: false, range: null,
                focus() { this.focused = true; }, select() { this.range = [0, this.value.length]; },
                setSelectionRange(a, b) { this.range = [a, b]; } };
  const row = { querySelector: (s) => s === '.sp-klink-u' ? box : null };
  const b = { dataset: { kcopy: 'TOK' }, textContent: 'Copy', closest: (s) => s === 'tr' ? row : null };
  await P.api.copyKioskLink(b);
  ok('the link shown on that row is focused and fully selected',
     box.focused === true && box.range && box.range[0] === 0 && box.range[1] === box.value.length);
  ok('the message line says what to press', /press .*Ctrl\+C/.test(P.msg.textContent) && /selected/.test(P.msg.textContent));
  ok('the button does not just say "Copy failed"', b.textContent !== 'Copy failed' && /Ctrl\+C/.test(b.textContent));

  P = page({ exec: 'yes', clip: 'no' });
  const b2 = { dataset: { kcopy: 'TOK' }, textContent: 'Copy', closest: () => row };
  await P.api.copyKioskLink(b2);
  ok('when the copy works the button says Copied and the message line stays empty',
     b2.textContent === 'Copied' && P.msg.textContent === '');
  ok('  …and what was copied is that store\'s link', P.snap.value === 'https://example.test/spiff/store.html?t=TOK');

  /* ══ (d) the field at the instant execCommand is called ══ */
  console.log('\n(d) at the moment execCommand runs, the field is focused and holds a real selection');
  P = page({ exec: 'yes', clip: 'no' });
  await P.api.copyText('some text');
  ok('the command is copy', P.snap.cmd === 'copy');
  ok('the field is focused, and is the document\'s active element', P.snap.focused === true && P.snap.active === true);
  ok('the selection covers the whole text and is not empty',
     P.snap.range && P.snap.range[0] === 0 && P.snap.range[1] === 'some text'.length && P.snap.range[1] > 0);
  ok('the field holds the text', P.snap.value === 'some text');
  ok('it is NOT readonly (iOS Safari will not select a readonly field)', P.snap.readonly === false);
  ok('it is attached to the page', P.snap.mounted === 'body');
  ok('it is hidden by size and opacity, never display:none or visibility:hidden',
     /opacity:0/.test(P.snap.css) && !/display\s*:\s*none/.test(P.snap.css) && !/visibility\s*:\s*hidden/.test(P.snap.css));
  P = page({ exec: 'yes', clip: 'no', modalOpen: true });
  await P.api.copyText('x');
  ok('with a dialog open the field is mounted INSIDE the dialog', P.snap.mounted === 'modal');

  /* ══ (e) cleanup in every path ══ */
  console.log('\n(e) the field is removed and focus restored, whatever happened');
  for (const [label, o] of [['execCommand worked', { exec: 'yes', clip: 'no' }],
                            ['execCommand said no, async worked', { exec: 'no', clip: 'yes' }],
                            ['execCommand threw', { exec: 'throw', clip: 'no' }],
                            ['both failed', { exec: 'no', clip: 'no' }],
                            ['dialog open', { exec: 'yes', clip: 'no', modalOpen: true }]]) {
    P = page(o);
    await P.api.copyText('x');
    ok(label + ': one field was made, and it is gone',
       P.tas.length === 1 && P.tas[0].parentNode === null && P.body.kids.length === 0 && P.modal.kids.length === 0);
    ok(label + ': focus went back to where it was', P.prev.focused === 1 && P.doc.activeElement === P.prev);
  }

  console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
