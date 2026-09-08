#!/usr/bin/env node
/* ─── Two tabs that were never places ────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/tabs_retired_test.js
 *
 * Sky, 2026-09-07, two to-dos answered together:
 *   "do we need the calculator tab? or is it just a step invoked by the clicking on a program?"
 *   "now that we've pulled progress into the calculator screen, do we need it as a tab? we can
 *    see it live in the current program and the summary in the historicals."
 *
 * Both answers were no, and both panels still exist — what went is the navigation implying they
 * were destinations. So the things worth pinning are the ones a delete quietly breaks:
 *
 *   1. THE CALCULATOR IS STILL REACHABLE. It has no button now, so every route in runs through
 *      openInCalculator / newProgram, and its subnav — which carries Save and "Present to
 *      vendor" — is still mounted by showTab. A panel you can no longer reach and a Save button
 *      that never appears are both silent.
 *
 *   2. THE NAV STILL READS AS WORKING. With no data-tab="calculator" the old toggle matched
 *      nothing and every tab went unlit the moment you opened a program, which looks like a bug.
 *
 *   3. A RUNNING PROGRAM STILL SHOWS ITS BUDTENDERS — the one that actually mattered. Sky's
 *      premise was that progress was already visible in the calculator. It was NOT, for an
 *      active program: the engine writes a snapshot only for a program that has CLOSED
 *      (snapshotReasonFor_ returns nothing for `active`), and the frozen grid renders only from
 *      that snapshot. So for the entire time a program is running — exactly when Tawny watches
 *      who is about to hit their number — the calculator showed nothing, and the Progress tab
 *      was the only view of it. Deleting the tab first and believing the premise would have
 *      removed the only per-budtender view of a live program. #calcLive is what closes that gap.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const js   = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const gs   = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = js.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}') { d--; if (!d) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. THE TABS ARE GONE, THE PANELS ARE NOT ══════════════════ */
const tabs = (html.match(/data-tab="([a-z]+)"/g) || []).map(m => m.match(/"([a-z]+)"/)[1]);
ok('three tabs remain: Programs, Reports, History',
   tabs.length === 3 && tabs.join(',') === 'programs,reports,history');
ok('  …no Calculator tab', tabs.indexOf('calculator') < 0);
ok('  …and no Progress tab', tabs.indexOf('progress') < 0);
/* The panel is the screen. Removing it would take the whole calculator with it. */
ok('the Calculator PANEL still exists — it was the tab that went, not the screen',
   /id="panel-calculator"/.test(html));
ok('  …and its subnav too, which carries Save and Present to vendor',
   /id="subnavCalculator"/.test(html) && /id="calcSave"/.test(html) && /id="calcPresent"/.test(html));
/* showTab mounts the subnav by name, so a calculator opened without a tab still gets its bar. */
ok('  …mounted by showTab from the panel name, so no button is needed to reveal it',
   /subnavIdFor\(name\)/.test(grab('showTab')) && /'subnav' \+ tab/.test(grab('subnavIdFor')));

/* The Progress panel and its picker are genuinely gone, not merely unreachable. */
ok('the Progress panel is removed outright', !/id="panel-progress"/.test(html));
ok('  …along with its subnav and its "which program" picker',
   !/id="subnavProgress"/.test(html) && !/id="pgProgram"/.test(html));
ok('  …and nothing still navigates to it', !/data-goto="progress"/.test(js));

/* ══════════════════ 2. EVERY ROUTE INTO THE CALCULATOR STILL LANDS ══════════════════ */
ok('openInCalculator still ends on the calculator panel',
   /showTab\('calculator'\)/.test(grab('openInCalculator')));
ok('  …and so does starting a new program', /showTab\('calculator'\)/.test(grab('newProgram')));
ok('openProgram is still the single way in', /openInCalculator\(p\)/.test(grab('openProgram')));
/* The hero had two buttons that now do the same thing. */
ok('the program hero offers ONE way in, not two names for it',
   /data-edit="' \+ esc\(p\.program_id\) \+ '">Open program/.test(js)
   && !/Open progress<\/button>/.test(js));

/* ══════════════════ 3. THE NAV STAYS LIT ══════════════════ */
const show = grab('showTab');
ok('a panel with no tab of its own still lights one',
   /NAV_OWNER\[name\] \|\| name/.test(show));
ok('  …and it is Programs, because a program belongs to Programs',
   /NAV_OWNER = \{ calculator: 'programs'/.test(js));

/* ══════════════════ 4. THE GAP THAT HAD TO CLOSE FIRST ══════════════════ */
/* The premise, checked against the engine rather than taken on trust: an ACTIVE program is never
   snapshotted, so the frozen grid cannot be what shows while it runs. */
const reason = gs.slice(gs.indexOf('function snapshotReasonFor_'),
                        gs.indexOf('function snapshotProgram_'));
ok('the engine snapshots a CLOSED program, and a draft whose window has passed',
   /st === 'closed'/.test(reason) && /st === 'draft'/.test(reason));
ok('  …and NEVER an active one — so a frozen grid cannot cover a running program',
   !/'active'/.test(reason));
const asv = grab('applyStatusView');
ok('so the live section shows precisely while the program is running',
   /var running = v\.status === 'active'/.test(asv) && /live\.hidden = !running/.test(asv));
ok('  …and the frozen one only once there is a snapshot to show',
   /if \(!v\.snap\) \{ results\.hidden = true; return; \}/.test(asv));
ok('  …never both, and a draft gets neither',
   asv.indexOf('live.hidden = !running') < asv.indexOf('if (!v.snap)'));
/* The pull is six stores at ~9s. applyStatusView runs on every save, sign-in and repaint. */
ok('the pull starts once per program, not on every repaint',
   /if \(running && \(!pgRun \|\| pgRun\.id !== v\.rec\.program_id\)\) loadProgress\(\);/.test(asv));
ok('  …and no longer hangs off which tab you are on',
   !/name === 'progress'/.test(show));

/* The live grid renders into the calculator, scoped to the program already on screen. */
ok('the live grid has a home on the calculator', /id="calcLive"/.test(html));
ok('  …with the budtender grid, the stats and the note that were the Progress panel',
   /id="pgBody"/.test(html) && /id="pgStats"/.test(html) && /id="pgNote"/.test(html));
ok('  …and Refresh, which still goes past the cache',
   /id="pgRefresh"/.test(html) && /loadProgress\(\{ force: true \}\)/.test(grab('wireProgress')));
ok('  …and per-store retry, so one failed store does not cost the other five',
   /data-retry/.test(grab('wireProgress')) && /pullOneStore\(b\.dataset\.retry\)/.test(grab('wireProgress')));
/* A windowless program can't be measured — say so rather than rendering an empty grid. */
ok('a program with no window says so instead of showing an empty grid',
   /No dates/.test(grab('loadProgress')));

console.log(fail ? '\n' + fail + ' FAILED' : '\ntabs retired: all passed');
process.exit(fail ? 1 : 0);
