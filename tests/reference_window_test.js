#!/usr/bin/env node
/* ─── The baseline is measured against the program, not against today ─────────────────────────────
 *
 *   RUN:  node tests/reference_window_test.js
 *
 * Sky, 2026-09-09: "the re-measure function should pull the sales from the 28 days before the
 * period in which the program is set to run."
 *
 * WHAT WAS WRONG
 * The reference pull always ended YESTERDAY and counted 28 days back from there. That is correct
 * for modeling a program that starts tomorrow and wrong for every other case. Reconciling Hapy
 * Kitchen's February window measured it against late August and early September — months after
 * the program ended, a different season, and for a brand that is not in the live catalog at all
 * today (137 brands, no Hapy Kitchen).
 *
 * WHY IT IS NOT A COSMETIC BUG. That figure is the BASELINE. It sets ROI, every per-store target
 * and every per-budtender goal, and the Calculator gets turned around to face a vendor. An
 * unanchored reference does not mislabel a caption, it re-prices the deal against the wrong month.
 *
 * THIS FILE RUNS THE REAL FUNCTION. refWindow_ was extracted from refUnits_ for exactly that
 * reason — the rest of refUnits_ needs PropertiesService and a Dutchie round trip, so the rule
 * used to be unreachable by anything except a grep. Two tests already shipped today passed for as
 * long as the thing they guarded was broken (`'Save changes'`, and `force: '1'` on a call that
 * measured nothing), and both were greps.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\nfunction ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* The real thing, with only Apps Script's date formatter stubbed. */
const Utilities = {
  formatDate: (d, _tz, _fmt) => d.toISOString().slice(0, 10),
};
const refWindow_ = new Function('Utilities', 'REF_DAYS', [
  grab('addDaysLocal_'), grab('textDate_'), grab('refWindow_'),
  'return refWindow_;',
].join('\n'))(Utilities, 28);

const TODAY = '2026-09-09';
const span = w => (Date.parse(w.to) - Date.parse(w.from)) / 86400000 + 1;

/* ══════════════════ 1. ANCHORED TO A PROGRAM ══════════════════ */
const hapy = refWindow_('2026-02-16', 28, TODAY);
ok('a program window anchors the reference to itself', hapy.anchored === true);
ok('  …ending the day BEFORE the program started', hapy.to === '2026-02-15');
ok('  …so the program\'s own first day is not in its own baseline', hapy.to < '2026-02-16');
ok('  …spanning exactly 28 days', span(hapy) === 28);
ok('  …which for Hapy Kitchen is January, not September', hapy.from === '2026-01-19');

/* The two programs reconciled today, as regression anchors. */
const buddies = refWindow_('2026-06-22', 28, TODAY);
ok('Buddies references 2026-05-25 → 2026-06-21',
   buddies.from === '2026-05-25' && buddies.to === '2026-06-21');
const drops = refWindow_('2026-08-03', 28, TODAY);
ok('Drops references 2026-07-06 → 2026-08-02',
   drops.from === '2026-07-06' && drops.to === '2026-08-02');

/* ══════════════════ 2. NO WINDOW IS NOT AN ERROR ══════════════════ */
/* A brand-new program being modelled has no dates yet, and there the recent four weeks IS the
   honest reference. Refusing would block the case the old behavior existed for. */
for (const empty of ['', null, undefined, '   ']) {
  const w = refWindow_(empty, 28, TODAY);
  ok('no window falls back to the last 28 days (' + JSON.stringify(empty) + ')',
     w.anchored === false && w.to === '2026-09-08' && span(w) === 28);
}
/* Junk must not be believed just because it is a non-empty string — a half-typed date silently
   anchoring to the year 20 would move the baseline by two millennia. */
for (const junk of ['2026-02', 'February', '02/16/2026', '2026-2-16', 'tomorrow']) {
  const w = refWindow_(junk, 28, TODAY);
  ok('a malformed date is refused rather than anchored: ' + JSON.stringify(junk),
     w.anchored === false && w.to === '2026-09-08');
}

/* ══════════════════ 3. THE PARTIAL-DAY RULE HOLDS BOTH WAYS ══════════════════ */
ok('unanchored never includes today', refWindow_('', 28, TODAY).to !== TODAY);
ok('anchored never includes the start date',
   refWindow_('2026-08-03', 28, TODAY).to !== '2026-08-03');

/* ══════════════════ 4. LENGTH IS BOUNDED AND DEFAULTED ══════════════════ */
ok('days defaults to 28', span(refWindow_('2026-02-16', 0, TODAY)) === 28);
ok('  …is clamped to 90 at the top', span(refWindow_('2026-02-16', 5000, TODAY)) === 90);
ok('  …and to 1 at the bottom', span(refWindow_('2026-02-16', -5, TODAY)) === 1);
ok('  …with a garbage length treated as absent, not as zero',
   span(refWindow_('2026-02-16', 'lots', TODAY)) === 28);

/* ══════════════════ 5. MONTH AND YEAR BOUNDARIES ══════════════════ */
/* Plain date arithmetic gets this wrong in exactly the places a program is most likely to start:
   the 1st of a month, and January. */
ok('a program starting Jan 1 reaches back into the previous year',
   refWindow_('2026-01-01', 28, TODAY).from === '2025-12-04');
ok('  …ending Dec 31', refWindow_('2026-01-01', 28, TODAY).to === '2025-12-31');
ok('a program starting Mar 1 crosses February correctly',
   refWindow_('2026-03-01', 28, TODAY).from === '2026-02-01'
   && refWindow_('2026-03-01', 28, TODAY).to === '2026-02-28');

/* ══════════════════ 6. THE CALLER ACTUALLY PASSES IT ══════════════════ */
/* The function being right buys nothing if the browser never sends the anchor — which is the
   shape of today's re-measure bug, where the request was fine and the effect was absent. */
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
ok('the Calculator sends the program window as the anchor',
   /before: \(calc\.window && calc\.window\.start\) \|\| ''/.test(js));
ok('refUnits_ reads it through the shared function, not its own copy of the rule',
   /refWindow_\(p\.before, days, today_\(\)\)/.test(gs));
ok('  …and reports which 28 days it used, so the caption can say',
   /anchored: anchored/.test(gs) && /st\.refAnchored = !!r\.anchored/.test(js));

console.log(fail ? '\n' + fail + ' FAILED' : '\nreference window: all passed');
process.exit(fail ? 1 : 0);
