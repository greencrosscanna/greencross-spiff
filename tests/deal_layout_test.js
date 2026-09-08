#!/usr/bin/env node
/* ─── "The deal" reads in the order Tawny works in, and a program is named once ───────────────────
 *
 *   RUN:  node tests/deal_layout_test.js
 *
 * TWO ASKS FROM SKY, 2026-09-07, and they share a screen.
 *
 *   1. VENDOR FIRST. "change layout of calculator The Deal to Vendor is first (since it pulls the
 *      data that populates the rest). Vendor, Program Name, Program Date (PP), Featured Products,
 *      Payout, The goal." The parenthesis is the whole reason: the product picker is SCOPED by the
 *      brand and stays disabled until one is chosen, cost per unit arrives with the product, and
 *      last month's volume is measured against the brand. Program name led the form, so the first
 *      thing the screen asked for was a label for something it knew nothing about yet.
 *
 *      Moving the pay period up there is NOT cosmetic, and this is the part worth a test. The
 *      record mounts only for a program that already exists, so a NEW program had no window
 *      control anywhere on screen: createProgram_ defaults no dates and the model payload sent
 *      none, so every program was born windowless. A program with no window measures nothing —
 *      the status roll skips rows with no dates, `progress` resolves status FROM those dates, and
 *      pullActuals refuses outright. It had to be saved, found again and edited before it existed
 *      properly.
 *
 *   2. [VENDOR] - [PROGRAM NAME]. "should the Program name just have the details and we can append
 *      the Vendor name: ie Hellavated - Cloud Bars". DERIVED, never stored — this app has already
 *      paid for the alternative twice (the record warnings froze because they were columns; the
 *      upstream display_name drifted for the same reason). And the seeded history already carries
 *      the vendor in the name, because Tawny's SPIF docs were titled that way, so a naive prefix
 *      reads "Wyld - Wyld 10pc".
 *
 * These run the REAL functions against a stub DOM rather than grepping for them. The lesson from
 * v1.360 is in this repo's own CLAUDE.md: a mocked dependency returns whatever you tell it to, so
 * a test built on one can never catch the projection being wrong. Here the assertions read the
 * markup renderWhen actually emits.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. THE FIELD ORDER, OFF THE REAL MARKUP ══════════════════ */
/* Read from index.html, not from a screenshot: the order IS the deliverable here. */
const deal = html.slice(html.indexOf('<h4 class="sp-h4">The deal</h4>'),
                        html.indexOf('id="calcGoalWrap"'));
const at = (needle) => deal.indexOf(needle);
ok('Vendor comes first in "The deal"',
   at('<span>Vendor</span>') < at('<span>Program name</span>'));
ok('  …then the program name',
   at('<span>Program name</span>') < at('id="calcWhenHost"'));
ok('  …then the program date',
   at('id="calcWhenHost"') < at('<span>Featured product</span>'));
ok('  …then the featured product',
   at('<span>Featured product</span>') < at('<span>Payout</span>'));
ok('  …then the payout, with the goal after the whole block',
   at('<span>Payout</span>') > 0 && html.indexOf('id="calcGoalWrap"') > html.indexOf('<span>Payout</span>'));
ok('the vendor field spans the row it now leads',
   /class="sp-fld is-wide sp-pick"><span>Vendor<\/span>/.test(deal));
ok('the name box asks for the program only, not the vendor too',
   /id="cName" placeholder="Cloud Bars"/.test(deal) && /The vendor is added in front/.test(deal));
/* display:contents, or the select and its full-width note collapse into one grid cell. */
ok('the when-host dissolves into the field grid rather than boxing its contents',
   /#calcWhenHost \{ display: contents; \}/.test(fs.readFileSync(__dirname + '/../spiff.css', 'utf8')));

/* ══════════════════ 2. renderWhen, ACTUALLY RUN ══════════════════ */
/* A stub DOM: one host element, and $ resolves the two selectors renderWhen uses. */
function harness() {
  const host = { innerHTML: '' };
  const nodes = { '#calcWhenHost': host };
  const listeners = {};
  const $ = (sel) => {
    if (sel === '#rPPFrom') {
      const m = /id="rPPFrom"[^>]*>([\s\S]*?)<\/select>/.exec(host.innerHTML);
      if (!m) return null;
      const selected = /<option value="([^"]*)" selected>/.exec(m[1]);
      return { value: selected ? selected[1] : '',
               addEventListener: (k, f) => { listeners[k] = f; } };
    }
    return nodes[sel] || null;
  };
  const src = [
    grab('esc'), grab('prettyDay'), grab('ymdPlus'), grab('daysBetween'),
    grab('periodIndexOf'), grab('periodByIndex'), grab('periodLabel'), grab('periodSpanOf'),
    grab('payPeriodOptions'), grab('toISODate'), grab('selField'), grab('renderWhen'),
    'return renderWhen;'
  ].join('\n');
  /* The real anchor and length, a FIXED today so "current" is deterministic, and canEdit true so
     the select is not rendered disabled. recField$ is unused on the paint path. */
  const fn = new Function('$', 'REC', 'calc', 'canEdit', 'today', 'payCfg', 'PP_FUTURE', 'PP_PAST',
                          'recField$', 'renderCalcEditing', src);
  const renderWhen = fn($, { when: '#calcWhenHost' }, { editingId: null }, () => true,
                        () => '2026-09-07', { anchor: '2026-05-11', days: 14 }, 10, 14,
                        () => null, () => {});
  return { renderWhen, host };
}

/* ── a NEW program: the case that had no control at all ── */
let H = harness();
H.renderWhen(null);
ok('a NEW program is offered a window', /id="rPPFrom"/.test(H.host.innerHTML));
ok('  …defaulted to the CURRENT pay period, and labeled as such',
   /<option value="8" selected>Aug 31 → Sep 13 · current<\/option>/.test(H.host.innerHTML));
/* The whole point: without these the program is created with no dates. */
ok('  …and its dates are already filled, so it cannot be created windowless',
   /data-key="start_date" value="2026-08-31"/.test(H.host.innerHTML)
   && /data-key="end_date" value="2026-09-13"/.test(H.host.innerHTML));
ok('  …hidden, because they are derived from the period and not typed',
   (H.host.innerHTML.match(/type="hidden"/g) || []).length === 2);
ok('  …and future periods are offered, so a program can be set up before it starts',
   /· upcoming/.test(H.host.innerHTML));

/* ── an on-grid program: selects its own period, no warning ── */
H = harness();
H.renderWhen({ start_date: '2026-08-03', end_date: '2026-08-16' });
ok('a program on the grid selects its own period',
   /<option value="6" selected>Aug 3 → Aug 16<\/option>/.test(H.host.innerHTML));
ok('  …and says nothing about payroll misalignment, because there is none',
   !/does not line up with payroll/.test(H.host.innerHTML));
ok('  …and its hidden dates are its own, not the current period’s',
   /data-key="start_date" value="2026-08-03"/.test(H.host.innerHTML));

/* ── Buddies: two whole periods (2026-06-22 → 2026-07-19). Off grid by this control's rule,
      since the rule is "exactly ONE period", and handled differently from the seven-day case
      BECAUSE it does sit on period boundaries — it just spans two of them. It selects its FIRST
      period and the note says what the window really is; nothing snaps until somebody chooses.
      The hidden dates are the ones that matter, and they keep the real window. ── */
H = harness();
H.renderWhen({ start_date: '2026-06-22', end_date: '2026-07-19' });
ok('a two-period program selects its FIRST period',
   /<option value="3" selected>Jun 22 → Jul 5<\/option>/.test(H.host.innerHTML));
ok('  …and still offers its real window as an option, written out as itself',
   /<option value="">Jun 22 → Jul 19, 2026  \(as recorded\)<\/option>/.test(H.host.innerHTML));
ok('  …and says so, rather than silently snapping to a fortnight',
   /does not line up with payroll/.test(H.host.innerHTML));
/* THE LOAD-BEARING ONE. This program is CLOSED and was reported to the vendor against exactly
   these dates. The select showing period 3 must not move them. */
ok('  …with the stored dates untouched — this one was reported to the vendor',
   /data-key="start_date" value="2026-06-22"/.test(H.host.innerHTML)
   && /data-key="end_date" value="2026-07-19"/.test(H.host.innerHTML));

/* ── the seven-day program, the other off-grid record ── */
H = harness();
H.renderWhen({ start_date: '2025-08-11', end_date: '2025-08-17' });
ok('a seven-day program is kept as recorded too',
   /\(as recorded\)/.test(H.host.innerHTML)
   && /data-key="end_date" value="2025-08-17"/.test(H.host.innerHTML));

/* ── an empty-value option must never write a date ── */
ok('the "as recorded" option carries no period index to resolve',
   /<option value="" selected>/.test(H.host.innerHTML));
ok('  …and the change handler refuses to act on it',
   /if \(ppFrom\.value === ''\) return;/.test(grab('renderWhen')));

/* ══════════════════ 3. programLabel, ACTUALLY RUN ══════════════════ */
const programLabel = new Function(grab('programLabel') + '\nreturn programLabel;')();

ok('the vendor is joined in front of the program name',
   programLabel({ vendor: 'Hellavated', program_name: 'Cloud Bars' }) === 'Hellavated - Cloud Bars');
/* Sky's own example, verbatim from the to-do. */
ok('  …exactly as Sky wrote it in the to-do',
   programLabel({ vendor: 'Hellavated', program_name: 'Cloud Bars' }).indexOf('Hellavated - ') === 0);
ok('a name that ALREADY leads with its vendor is left alone',
   programLabel({ vendor: 'Wyld', program_name: 'Wyld 10pc' }) === 'Wyld 10pc');
ok('  …case-insensitively, because the seed copied prose',
   programLabel({ vendor: 'drops', program_name: 'Drops Jellies Spiff' }) === 'Drops Jellies Spiff');
ok('  …which is what keeps 25 seeded rows off a migration',
   programLabel({ vendor: 'Freshy', program_name: 'Freshy Cart & AIO Spiff' }) === 'Freshy Cart & AIO Spiff');
ok('no vendor yet gives the bare name rather than a leading dash',
   programLabel({ vendor: '', program_name: 'Cloud Bars' }) === 'Cloud Bars');
ok('no name yet gives the bare vendor',
   programLabel({ vendor: 'Hellavated', program_name: '' }) === 'Hellavated');
ok('the fixed title is still the fallback when program_name is empty',
   programLabel({ vendor: 'Mule', title: 'Mule Summer' }) === 'Mule Summer');
ok('nothing at all is empty, not "undefined"', programLabel(null) === '');
ok('whitespace does not manufacture a dash',
   programLabel({ vendor: '  ', program_name: ' Cloud Bars ' }) === 'Cloud Bars');
/* Idempotent: it is derived, so painting a label twice cannot double the prefix. */
const once = programLabel({ vendor: 'Hellavated', program_name: 'Cloud Bars' });
ok('joining is idempotent — a label fed back in does not double the vendor',
   programLabel({ vendor: 'Hellavated', program_name: once }) === once);

/* ── DERIVED, and provably so ── */
ok('nothing writes a joined label into program_name',
   !/program_name\s*[:=]\s*[^,;\n]*programLabel/.test(js));
ok('the delete confirmation still asks for the RAW stored name, which the engine re-checks',
   /esc\(p\.program_name \|\| p\.title \|\| ''\) \+ '&quot; to confirm/.test(js));

console.log(fail ? '\n' + fail + ' FAILED' : '\ndeal layout: all passed');
process.exit(fail ? 1 : 0);
