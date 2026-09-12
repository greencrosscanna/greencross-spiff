#!/usr/bin/env node
/* ─── The kiosk board: no session, and no person on it ────────────────────────────────────────────
 *
 *   RUN:  node tests/store_view_test.js
 *
 * Sky, 2026-09-07/08: "We need unique store links for each store. We will then wire these to
 * Leaderboard so that BTs can open a window with the SPIFF details from their Kiosk." … "for Staff
 * to be able to click a SPIFF button from the Kiosk and see the details (payout out, goal, etc)
 * plus a few Selling tips writen by Tawny, hence the request for bullet points."
 *
 * THIS IS THE ONE ROUTE IN THE APP WITH NO CREDENTIAL OF ITS OWN. A kiosk is a shared screen in a
 * shop and nobody signs into it, so the token in the URL is the whole credential. That makes two
 * things worth a test rather than a comment:
 *
 *   1. IT MUST NOT CARRY A PERSON. A screen facing the sales floor cannot show one budtender's
 *      units or earnings to the room, and a customer at the counter cannot be shown what we pay
 *      for the product. `flyer` is the personal view and keeps its sign-in; these two answer
 *      different questions and merging them would put earnings on a wall.
 *
 *   2. THE LINK IS PER STORE AND PERMANENT. Minted per program it would need re-pasting into six
 *      kiosks every time a SPIFF ended, and the first time somebody forgot, a kiosk would show a
 *      finished program as though it were live.
 *
 * And the reason only TIPS are editable: four of the six things the to-do listed already exist on
 * the program — the featured product, the store goal, the per-BT goal, the payout and its model.
 * Sky chose to read those live, so the kiosk cannot promise $25 on a program since re-modeled to
 * $20. A goal with two homes is the failure this repo keeps paying for.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs    = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const js    = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
const sjs   = fs.readFileSync(__dirname + '/../store.js', 'utf8');
const shtml = fs.readFileSync(__dirname + '/../store.html', 'utf8');

function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ══════════════════ 1. NO PERSON, NO MARGIN ══════════════════ */
const view = grab(gs, 'storeView_');

/* AN ALLOWLIST, read off the keys the route actually emits — not a substring hunt. The first cut
   of this test searched the function text for "name" and "rows" and failed on `program_name` and
   `storeLinkRows_`, which is the wrong kind of wrong: a check that cries about safe code teaches
   you to loosen it. Reading the emitted keys means a NEW leak fails this, and a rename does not. */
function emittedKeys(block) {
  return (block.match(/(?:^|[\s{,])([a-z_][a-z0-9_]*)\s*:/gi) || [])
    .map(m => m.replace(/[\s{,]/g, '').replace(/:$/, ''));
}
const perProgram = view.slice(view.indexOf('out.push({'), view.indexOf('});', view.indexOf('out.push({')));
const envelope   = view.slice(view.lastIndexOf('return { ok: true'));

/* `people` and `measured_at` were added 2026-09-11 — see the PEOPLE block below, which is where
   the reversal is argued and where the line that did NOT move (earnings) is pinned. */
const PROGRAM_ALLOWED = ['program_id', 'vendor', 'program_name', 'start_date', 'end_date',
                         'product', 'store_goal', 'bt_goal', 'payout', 'payout_type', 'tips',
                         'people', 'measured_at'];
const ENVELOPE_ALLOWED = ['ok', 'store_id', 'store_name', 'today', 'programs'];

const progKeys = emittedKeys(perProgram);
ok('each program on the board emits only the agreed fields',
   progKeys.length > 0 && progKeys.every(k => PROGRAM_ALLOWED.indexOf(k) >= 0));
ok('  …and the envelope around them likewise',
   emittedKeys(envelope).every(k => ENVELOPE_ALLOWED.indexOf(k) >= 0));
/* Named individually so a future reader sees WHICH leaks were being guarded against. */
['full_name', 'employee', 'nameKey', 'user_id', 'earned', 'bts_hit', 'units_sold', 'hit']
  .forEach(k => ok('no `' + k + '` reaches the kiosk', progKeys.indexOf(k) < 0));
ok('  …and no vendor cost or ROI — a customer can read this over the counter',
   view.indexOf('cost_json') < 0 && view.indexOf('roi') < 0 && view.indexOf('actual_json') < 0);
ok('  …and no progress snapshot, which is per budtender',
   view.indexOf('progress_json') < 0);
/* What it DOES carry is exactly the detail Sky asked for. */
['store_goal', 'bt_goal', 'payout', 'payout_type', 'tips', 'product']
  .forEach(k => ok('it does carry `' + k + '`', progKeys.indexOf(k) >= 0));

/* The page cannot render what it was not sent, but it must not ask for it either. */
ok('the kiosk page never reads the personal route',
   sjs.indexOf("'flyer'") < 0 && /jsonp\('storeView'/.test(sjs));
ok('  …and has no sign-in of any kind',
   !/spiff_session/.test(sjs) && !/renderGate/.test(sjs) && !/password/i.test(sjs));
ok('  …and says so in the markup, so the next reader does not add one',
   /no sign-in/.test(shtml) && /never shows anyone's earnings/.test(shtml));

/* ══════════════════ 1b. THE PEOPLE SLICE — WHAT MOVED, AND WHAT DID NOT ══════════════════
 * Sky, 2026-09-11: the kiosk's SPIFF button now opens this page directly, so the per-person bars
 * that Leaderboard's own panel drew move here. That reverses "no person on this page" — with his
 * confirmation, and on the ground that the Leaderboard board on the SAME screen already shows each
 * person's SPIFF units and target on their staff card.
 *
 * EARNINGS DID NOT MOVE, and that is what this block exists to hold. Money per person is the half
 * that reads worst over a counter, and it is one property away at every step: the cached row this
 * reads carries `earned`, and returning the row would have shipped it.
 */
const people = grab(gs, 'storePeople_');
const PERSON_ALLOWED = ['name', 'units', 'target', 'hit', 'unmeasured', 'people', 'measured_at'];
ok('a person on the kiosk board carries only name, units, target and hit',
   emittedKeys(people).every(k => PERSON_ALLOWED.indexOf(k) >= 0));
['earned', 'employee_id', 'revenue', 'payout', 'user_id']
  .forEach(k => ok('  …no `' + k + '` on a kiosk person', emittedKeys(people).indexOf(k) < 0));
ok('  …and `earned` is not even read off the cached row', !/\.earned/.test(people));
ok('it reads the hourly cache, not a live Dutchie pull — six kiosks polling sell-through would crawl',
   /progressRowsFor_\(/.test(people) && people.indexOf('sellthrough_') < 0);
ok('  …and says how old the figures are, so a board is not trusted to the minute',
   /measured_at/.test(view) && /as of /.test(sjs));
ok('only THIS store\'s people are on this store\'s board',
   /slug_\(r\.store_id\) !== store/.test(people));
ok('everyone at the store is listed, including whoever has sold none yet',
   /gxEmployees_\(\)/.test(people) && /units: 0/.test(people));
ok('  …and a roster that could not be read adds nobody rather than emptying the board',
   /roster = \[\]/.test(people));
ok('the goal a bar is drawn against is the PROGRAM\'s per-store goal, not the cached row\'s',
   /x\.target = perBt/.test(view));
ok('the page draws no bar when there is no personal goal to draw it against',
   /goal > 0/.test(sjs) && /is-none/.test(sjs));
ok('nothing on the kiosk renders money for a PERSON',
   !/money\(/.test(grab(sjs, 'crew')));

/* ══════════════════ 2. THE TOKEN IS THE CREDENTIAL, AND IT IS CHECKED ══════════════════ */
ok('a missing token is refused', /if \(!tok\) return \{ ok: false/.test(view));
ok('the token is matched against a LIVE row, never trusted from the caller',
   /r\.token === tok && !r\.revoked_at/.test(view));
ok('  …and a revoked link says the LINK is dead, not the store',
   /no longer active/.test(view));
/* Minting and rotating are writes and need a real session, like everything else here. */
['storeLinks_', 'storeLinkRotate_'].forEach(fn => {
  const f = grab(gs, fn);
  ok(fn + ' needs a signed-in session', /gxAuth_\(p\.token\)/.test(f) && /needsAuth: true/.test(f));
  ok('  …and an editing role', /EDIT_ROLES\.indexOf\(String\(auth\.role\)\) < 0/.test(f));
});
/* A deploy secret must not be a way in, and storeView must not be a way to enumerate. */
ok('the kiosk read is not secret-gated either — the URL token is the whole credential',
   view.indexOf('GX_SECRET_PROP') < 0);
/* ── AND IT HAS TO BE REACHABLE, which is a separate fact from being safe ────────────────────
   The router is private-by-default: PUBLIC_ACTIONS is a short closed list and anything absent
   from it is answered "Not signed in" BEFORE its handler runs. So the first deploy of this route
   returned auth_required to every kiosk — the handler was correct and simply never reached,
   which reads as a broken route rather than a missing line. That failure direction is the point
   of the list, and this pins the entry so a later tidy-up cannot silently take the kiosks down. */
ok('storeView is on the public list, or no kiosk can reach it',
   /var PUBLIC_ACTIONS = \[[^\]]*'storeView'/.test(gs));
ok('  …and it is the ONLY new name on it — minting still needs a session',
   !/PUBLIC_ACTIONS = \[[^\]]*storeLinks/.test(gs)
   && !/PUBLIC_ACTIONS = \[[^\]]*storeLinkRotate/.test(gs));

/* ══════════════════ 3. ONE LINK PER STORE, PERMANENT ══════════════════ */
const links = grab(gs, 'storeLinks_');
ok('links are keyed on the store, not on a program',
   /STORE_LINK_HEADERS = \['store_id', 'token'/.test(gs) && links.indexOf('program_id') < 0);
ok('  …so the page resolves the program at READ time, from today',
   /var today = nowStamp_\(\)\.slice\(0, 10\)/.test(view) && /a <= today && today <= b/.test(view));
ok('  …and a closed program never shows on a kiosk',
   /st === 'closed'/.test(view));
ok('  …and only programs that actually run at THIS store',
   /pr\.stores_json \|\| \[\]\)\.some/.test(view));
ok('the soonest to end is listed first — that is the one worth pushing today',
   /localeCompare/.test(view));
/* An empty store registry is not an empty company. */
ok('a registry that did not answer refuses rather than minting against nothing',
   /if \(!stores\.length\)/.test(links) && /Nothing was changed/.test(links));
/* ── LISTING MUST NOT MINT ────────────────────────────────────────────────────────────────────
   It did, for convenience, and the dev guard refused it from localhost as an undeclared write —
   correctly. A read that mutates cannot be declared a read, cannot be pointed at production just
   to look, and makes "I only opened the panel to check" untrue. Minting is its own route and its
   own press. */
ok('listing kiosk links writes nothing',
   links.indexOf('appendRow') < 0 && links.indexOf('Utilities.getUuid') < 0);
ok('  …and reports how many stores still need one, so the panel can offer it',
   /missing: links\.filter/.test(links));
const mint = grab(gs, 'storeLinkMintAll_');
ok('minting is a separate, deliberate route', /appendRow/.test(mint));
ok('  …that does every missing store in ONE call, so none gets missed',
   /stores\.forEach/.test(mint) && /made\.push\(id\)/.test(mint));
ok('  …and skips a store that already has a live link',
   /if \(!id \|\| live\[id\]\) return;/.test(mint));
ok('  …and refuses an unanswered registry rather than minting against nothing',
   /Nothing was minted/.test(mint));
/* ── WHERE THE PANEL LIVES ────────────────────────────────────────────────────────────────────
   In the user chip's Settings tray (Sky, 2026-09-08), not a fold under the Programs list. Kiosk
   links are app-level configuration — set up once, then not thought about — and the programs
   list is a working screen you should not scroll past config to read. */
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
ok('the kiosk panel lives in the Settings dialog',
   /id="settingsBack"/.test(html) && /modal-body" id="kioskBody"/.test(html));
ok('  …and no longer sits under the programs list',
   !/id="kioskFold"/.test(html));
ok('  …reached from the chip menu, editor-only',
   /if \(canEdit\(\)\) items\.push\(\{ action: 'settings'/.test(js));
ok('  …and the app knows what that action means',
   /if \(a === 'settings'\) openSettings\(\);/.test(js));
ok('  …loading the links on first open rather than at boot',
   /loadKioskLinks\(\);/.test(grab(js, 'openSettings')));
ok('  …and it closes on the backdrop and on Escape, not only the ×',
   /e\.target === back/.test(grab(js, 'wireSettings'))
   && /e\.key === 'Escape'/.test(grab(js, 'wireSettings')));

/* The dev guard's lists are the local half of the same rule. */
ok('the two reads are declared to the dev guard',
   /'storeLinks', 'storeView'/.test(html));
ok('  …and the two writes are NOT, so they stay behind ARM WRITES',
   !/GX_DEV_READS[\s\S]{0,400}storeLinkMintAll/.test(html)
   && !/GX_DEV_READS[\s\S]{0,400}storeLinkRotate/.test(html));
ok('replacing a link retires the old one and mints in the same call',
   /revoked_at\b/.test(grab(gs, 'storeLinkRotate_'))
   && /sh\.appendRow\(\[id, tok/.test(grab(gs, 'storeLinkRotate_')));

/* ══════════════════ 4. ONLY THE TIPS ARE TYPED ══════════════════ */
const norm = grab(gs, 'normalizePitch_');
ok('the stored shape is tips and nothing else', /return \{ tips: out \}/.test(norm));
ok('  …capped server-side, because a kiosk has no operator watching it',
   /out\.length < PITCH_MAX_TIPS/.test(norm) && /PITCH_MAX_TIPS = 5/.test(gs));
ok('  …each one length-bounded', /slice\(0, PITCH_MAX_LEN\)/.test(norm));
ok('  …blank entries dropped rather than rendered as stray dots', /if \(t\) out\.push/.test(norm));
ok('  …and the two-field shape it briefly shipped as still reads back',
   /src\.bullets/.test(norm) && /src\.talking_points/.test(norm));
/* The four that already exist must NOT have become typeable copies. */
const editor = js.slice(js.indexOf('Selling tips &mdash; what budtenders see'),
                        js.indexOf('Minting a vendor link'));
ok('the editor offers tips only — no goal, payout or product boxes',
   editor.indexOf("data-key=\"pitch_json\"") > 0
   && editor.indexOf('target_json') < 0 && editor.indexOf('payout_json') < 0
   && editor.indexOf('match_json') < 0);
ok('  …and says the rest comes off the program automatically',
   /come off this program automatically/.test(editor));
ok('pitch_json is accepted by the engine, or the save would be a silent no-op',
   /'contact_name', 'contact_email', 'pitch_json'/.test(gs));
/* The structural compare — without it every save rewrites the tips with themselves. */
ok('collectPatch compares tips structurally, not as "[object Object]"',
   /key === 'match_json' \|\| key === 'pitch_json'/.test(grab(js, 'collectPatch')));

/* ══════════════════ 5. THE KIOSK LOOKS AFTER ITSELF ══════════════════ */
ok('the board refreshes on its own — nobody reloads a kiosk by hand',
   /setInterval\(load, REFRESH_MS\)/.test(sjs));
ok('  …and immediately when the screen wakes, so the morning shift sees today',
   /visibilitychange/.test(sjs));
ok('  …at a gentle interval, since nothing on it moves by the minute',
   /REFRESH_MS = 10 \* 60 \* 1000/.test(sjs));
ok('a failure says the plain thing rather than showing a stack trace on the floor',
   /Can’t reach the SPIFF board/.test(sjs));
ok('nothing running is stated, not left blank',
   /No SPIFF running right now/.test(sjs));
/* A SHARED screen must not send the room to a page that needs a personal sign-in — most readers
   cannot follow that where they are standing, and it invited somebody to sign in on a kiosk
   everybody uses. Removed 2026-09-08 (Sky), alongside the nav entry. */
/* Checked against the RENDERED footer, not the file — the comment above it names My SPIFF to
   explain the removal, and a bare substring search flags that prose. A test that cries about a
   comment is a test people learn to loosen. */
const foot = /st-foot">([^<]*)</.exec(sjs);
ok('the kiosk footer no longer sends the room to a personal login',
   !!foot && !/My SPIFF/.test(foot[1]));
/* And nothing NAVIGATES there either. Checked as a link, not as a substring: the header comment
   names flyer.html to explain the split, and flagging that would be a test crying about prose. */
ok('  …and nothing on the page links or navigates to it',
   !/href\s*=\s*['"][^'"]*flyer/.test(sjs) && !/location[^\n]*flyer/.test(sjs)
   && !/window\.open[^\n]*flyer/.test(sjs));
/* Dates are TEXT here too — a Date constructor on YYYY-MM-DD renders the day before in LA. */
ok('dates are formatted from text, never through Date()',
   /never coerces a Date|parses as UTC and renders the day before/.test(sjs));
ok('days left is inclusive of the end date, like the operator app',
   /\+ 1;/.test(grab(sjs, 'daysLeft')));
/* One name for a program across both screens. */
ok('the kiosk joins vendor and name the same way the operator app does',
   /name\.toLowerCase\(\)\.indexOf\(vendor\.toLowerCase\(\)\) === 0/.test(sjs));

console.log(fail ? '\n' + fail + ' FAILED' : '\nstore view: all passed');
process.exit(fail ? 1 : 0);
