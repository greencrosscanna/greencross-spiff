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
const btnHtml = (html.match(/<button[^>]*id="btnSettingsNested"[\s\S]*?<\/button>/) || [''])[0];
ok('  …drawn as the suite gear, not the word (Sky, 2026-09-15)',
   /<svg[^>]*aria-hidden="true"/.test(btnHtml) && /M19\.4 15a1\.65/.test(btnHtml) &&
   !/>\s*Settings\s*</.test(btnHtml));
ok('  …and still named for a screen reader, since it has no text', /aria-label="Settings"/.test(tag));

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

/* ══════════════════ 3. WHO GETS IT ══════════════════
   RUN, not read (2026-09-15): both doors decide from the same session, and "the same predicate"
   is a claim a regex can only make about spelling. syncNestedSettings and menuItems are lifted out
   of spiff.js and given a two-property element and a session — the whole browser they need. */
function doors(session) {
  const button = { id: 'btnSettingsNested', hidden: true };
  const api = new Function('$', 'session', 'canEdit', 'APP_VERSION', [
    grab('syncNestedSettings'), grab('menuItems'),
    'return { syncNestedSettings: syncNestedSettings, menuItems: menuItems };',
  ].join('\n'))(
    (sel) => (sel === '#btnSettingsNested' ? button : null),
    () => session,
    () => !!session && ['admin', 'editor', 'director'].indexOf(session.role) >= 0,
    'v1.423');
  return { api, button,
           /* What the chip menu offers, as labels — the standalone door. */
           menu: () => api.menuItems(null).map(x => x.action || '').filter(Boolean) };
}
{
  const editor = doors({ user: 'tawny', role: 'editor' });
  editor.api.syncNestedSettings();
  ok('an editor is offered the nested gear', editor.button.hidden === false);
  ok('  …and the Settings row in the chip menu, which is the standalone door',
     editor.menu().indexOf('settings') >= 0);

  const viewer = doors({ user: 'gx-dev', role: 'viewer' });
  viewer.api.syncNestedSettings();
  ok('a viewer is offered neither', viewer.button.hidden === true
     && viewer.menu().indexOf('settings') < 0);

  const out = doors(null);
  out.api.syncNestedSettings();
  ok('signed out, neither', out.button.hidden === true && out.menu().indexOf('settings') < 0);

  /* The two doors cannot disagree — that is the whole reason they share canEdit. */
  ['admin', 'editor', 'director', 'viewer', 'nonsense'].forEach(role => {
    const d = doors({ user: 'x', role: role });
    d.api.syncNestedSettings();
    ok('the gear and the menu agree for role "' + role + '"',
       (d.button.hidden === false) === (d.menu().indexOf('settings') >= 0));
  });
  /* An unknown role fails safe to read-only, the same way roleCanEdit does. */
  const odd = doors({ user: 'x', role: 'superuser' });
  odd.api.syncNestedSettings();
  ok('an unknown role is offered nothing, rather than treated as an editor', odd.button.hidden === true);
}
/* Where the sync is CALLED from stays source-shaped: renderAuthChip paints the shared chip through
   gx-topnav, which is loaded from Pages at runtime and not present here. What matters is that the
   call sits before the early returns, or a session change would leave the gear behind. */
const chip = grab('renderAuthChip');
const syncAt = chip.indexOf('syncNestedSettings()'), firstReturn = chip.indexOf('return;');
ok('renderAuthChip re-syncs it on every session change, before any early return',
   syncAt > 0 && syncAt < firstReturn);

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
