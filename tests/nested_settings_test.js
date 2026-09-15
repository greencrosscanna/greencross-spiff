#!/usr/bin/env node
/* ─── Settings is reachable when SPIFF runs inside Inventory ─────────────────────────────────────
 *
 *   RUN:  node tests/nested_settings_test.js
 *
 * Sky, 2026-09-15: "Tawny views SPIFF as a nested iFrame in Inventory, we need to give her a way to
 * see the settings in that use case."
 *
 * Standalone, Settings is a row in the user chip's menu. Nested, gx-theme.css hides the whole
 * .gx-topnav-right (the host owns the user tray), chip and all — so the one door disappeared, and
 * with it the brand directory whose rep emails are what vendor reps sign in with. The fix is a
 * second door that exists ONLY when nested, marked with gx-theme's own data-gx-embed-only.
 *
 * What a later edit would quietly break, and so what this pins:
 *   1. The button exists, carries data-gx-embed-only, and sits OUTSIDE .gx-topnav-right. Inside it,
 *      it would be hidden by the very rule it exists to route around.
 *   2. It is outside #tabs, so showTab never lights it and wireTabs never treats it as a panel.
 *   3. It opens the same dialog, through openSettings — not a copy.
 *   4. It is offered to exactly who the chip menu offers Settings to (canEdit), and that is kept
 *      in sync on every session change via renderAuthChip, BEFORE its early returns.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
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

/* ══════════════════ 1. THE BUTTON, AND WHERE IT LIVES ══════════════════ */
const tag = (html.match(/<button[^>]*id="btnSettingsNested"[^>]*>/) || [''])[0];
ok('index.html has a nested Settings button', !!tag);
ok('  …marked data-gx-embed-only, so standalone never shows it', /data-gx-embed-only/.test(tag));
ok('  …and hidden until spiff.js decides who gets it', /\shidden(\s|>)/.test(tag));

const header = html.slice(html.indexOf('<header class="gx-topnav"'), html.indexOf('</header>'));
const btnAt = header.indexOf('id="btnSettingsNested"');
const navOpen = header.indexOf('id="tabs"'), navClose = header.indexOf('</nav>');
const rightAt = header.indexOf('class="gx-topnav-right"');
ok('  …inside the top bar that data-gx-keep-nested keeps', btnAt > 0);
ok('  …NOT inside .gx-topnav-right, which is hidden when nested', btnAt < rightAt);
ok('  …and NOT inside #tabs, so it is never mistaken for a panel', !(btnAt > navOpen && btnAt < navClose));
ok('the header still keeps itself when nested — without that there is no bar to hold the button',
   /<header class="gx-topnav" data-gx-keep-nested>/.test(html));

/* ══════════════════ 2. WHAT IT DOES ══════════════════ */
const wire = grab('wireSettings');
ok('wireSettings binds it to openSettings — the same dialog, not a copy',
   /#btnSettingsNested/.test(wire) && /addEventListener\('click', openSettings\)/.test(wire));

/* ══════════════════ 3. WHO GETS IT ══════════════════ */
const sync = grab('syncNestedSettings');
ok('syncNestedSettings shows it only to a signed-in editor', /session\(\)/.test(sync) && /canEdit\(\)/.test(sync));
ok('  …the same predicate the chip menu uses for its Settings row',
   /if \(canEdit\(\)\) items\.push\(\{ action: 'settings'/.test(grab('menuItems')));
const chip = grab('renderAuthChip');
const syncAt = chip.indexOf('syncNestedSettings()'), firstReturn = chip.indexOf('return;');
ok('renderAuthChip re-syncs it on every session change, before any early return',
   syncAt > 0 && syncAt < firstReturn);

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
