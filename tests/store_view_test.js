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
const scss  = fs.readFileSync(__dirname + '/../store.css', 'utf8');
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

/* ── THE BOARD, BUILT FOR REAL ───────────────────────────────────────────────────────────────────
   REWRITTEN 2026-09-15. Every check below used to read storeView_'s SOURCE and pull the emitted
   keys out of the text between `out.push({` and `});`. That is a weak way to guard a leak on the
   one route with no credential: it reads what the literal SAYS, so a key added by
   `Object.assign(row, cached)`, by spreading a cached row, or by returning the row itself would
   never appear in it — and the cached row this reads carries `earned`. The route is now RUN and
   the assertions call Object.keys on what it actually returns. */
const G = require('./_gas');

/* The cache rows carry MORE than the board may show — `earned` above all, which is the property
   one line away at every step. Handing the route a realistic row is the only way "no earnings on a
   wall screen" can be tested rather than asserted. */
function cachedRow(store, employeeId, name, units, earned) {
  return { program_id: 'mule-0831', store_id: store, employee_id: employeeId, name: name,
           display_name: '', units: units, target: 4, hit: units >= 4, earned: earned,
           vendor: 'Mule', program_name: 'Mule Extracts 2g', pay_period: '2026-08-31',
           start_date: '2026-08-31', end_date: '2026-09-13', refreshed_at: '2026-09-15 08:00:00' };
}
const PROGRAMS = [
  { program_id: 'mule-0831', vendor: 'Mule', program_name: 'Mule Extracts 2g', status: 'active',
    start_date: '2026-08-31', end_date: '2026-09-13',
    stores_json: [{ store_id: 'river-rd' }, { store_id: 'bend' }],
    match_json: { brand: 'Mule Extracts' }, payout_json: { model: 'flat', amount: 25 },
    payout_type: 'flat',
    target_json: { units: 200, by_store: { 'river-rd': 120 }, per_bt: { 'river-rd': 6 } },
    pitch_json: { tips: ['Lead with the 2g price', '  ', 'Mention the terpene sheet'] },
    /* Everything below is what must NOT reach a wall screen. */
    cost_json: { model: 'flat', unit_cost: 8.68 },
    actual_json: { units_sold: 168, bts_hit: 5, investment: 125 },
    progress_json: { at: '2026-09-14T18:00:00Z', stores: [] },
    contact_email: 'rep@mule.example', share_token: 'sekret-share' },
  /* Ends sooner — must sort first. */
  { program_id: 'gron-0905', vendor: 'Grön', program_name: 'Grön chews', status: 'active',
    start_date: '2026-09-05', end_date: '2026-09-11', stores_json: ['river-rd'],
    match_json: { brand: 'Grön' }, payout_json: { model: 'per_unit', amount: 1 },
    payout_type: 'per_unit', target_json: { by_store: { 'river-rd': 60 }, per_bt: {} },
    pitch_json: null },
  /* Must never appear: closed, another store, and a window that has not started. */
  { program_id: 'closed-0801', vendor: 'Wyld', program_name: 'Wyld closed', status: 'closed',
    start_date: '2026-09-01', end_date: '2026-09-30', stores_json: ['river-rd'], target_json: {} },
  { program_id: 'bend-only', vendor: 'Kaprikorn', program_name: 'Bend only', status: 'active',
    start_date: '2026-09-01', end_date: '2026-09-30', stores_json: ['bend'], target_json: {} },
  { program_id: 'future-1001', vendor: 'Freshy', program_name: 'Not yet', status: 'active',
    start_date: '2026-10-01', end_date: '2026-10-14', stores_json: ['river-rd'], target_json: {} },
];

function kiosk(opts) {
  const o = opts || {};
  return G.load({
    real: ['storeView_', 'storePeople_', 'lastClosedFor_', 'programRunsAt_', 'programCoversStore_',
           'productLabelOf_', 'payoutModelOf_',
           'normalizePitch_', 'slug_', 'userKey_', 'stampOf_', 'friendlyName_'],
    vars: ['PITCH_MAX_TIPS', 'PITCH_MAX_LEN'],
    stubs: {
      storeLinkRows_: () => (o.links || [{ store_id: 'river-rd', token: 'live-token', revoked_at: '' },
                                         { store_id: 'bend', token: 'dead-token', revoked_at: '2026-09-01' }]),
      gxStores_: () => (o.stores === undefined
        ? [{ store_id: 'river-rd', display_name: 'River Rd', color: '#22D3EE' }] : o.stores),
      listPrograms_: () => (o.programs || PROGRAMS),
      progressRowsFor_: () => (o.rows === undefined ? [
        cachedRow('river-rd', 'e1', 'SKYLER P', 9, 25),
        cachedRow('river-rd', 'e2', 'TAWNY R', 3, 0),
        cachedRow('bend', 'e7', 'SOMEBODY ELSE', 40, 25),
      ] : o.rows),
      displayNameMap_: () => ({ byId: { e1: 'Sky' }, byName: {} }),
      gxEmployees_: () => (o.employees === undefined
        ? { ok: true, employees: [
            { dutchie_employee_id: 'e1', full_name: 'SKYLER P', display_name: 'Sky', home_store: 'river-rd' },
            { dutchie_employee_id: 'e5', full_name: 'NEW HIRE', display_name: 'New Hire', home_store: 'river-rd' },
            { dutchie_employee_id: 'e7', full_name: 'SOMEBODY ELSE', home_store: 'bend' } ] }
        : o.employees),
      nowStamp_: () => '2026-09-10 09:00:00',
    },
  });
}

/* ══════════════════ 1. NO PERSON'S MONEY, NO MARGIN ══════════════════ */
const board = kiosk().storeView_({ t: 'live-token' });

ok('the board answers for the store the token belongs to',
   board.ok === true && board.store_id === 'river-rd' && board.store_name === 'River Rd');
/* `store_color` joined the envelope 2026-09-16 with the board redesign: the store's own registry
   color draws its attainment track. It comes off the SAME registry row the display name does —
   the alternative was loading gx-stores.js on the kiosk page, a second GX Core call from six shop
   screens for a value already in hand. Still a closed list, and still the point of this check. */
ok('  …and the envelope carries nothing else',
   Object.keys(board).sort().join(',') === 'ok,programs,store_color,store_id,store_name,today');
ok('the store draws in its own registry color, never one hardcoded per screen',
   board.store_color === '#22D3EE');
ok('  …and a registry that did not answer sends no color rather than a wrong one',
   kiosk({ stores: [] }).storeView_({ t: 'live-token' }).store_color === '');

const prog = board.programs.filter(x => x.program_id === 'mule-0831')[0];
const PROGRAM_ALLOWED = ['program_id', 'vendor', 'program_name', 'start_date', 'end_date',
                         'product', 'store_goal', 'bt_goal', 'payout', 'payout_type', 'tips',
                         'people', 'measured_at'];
ok('each program on the board emits only the agreed fields',
   !!prog && Object.keys(prog).every(k => PROGRAM_ALLOWED.indexOf(k) >= 0));
/* Named individually so a future reader sees WHICH leaks were being guarded against, and now
   checked against the REAL object rather than the text of the literal that builds it. */
['cost_json', 'actual_json', 'progress_json', 'contact_email', 'share_token', 'earned',
 'bts_hit', 'units_sold', 'roi'].forEach(k =>
  ok('no `' + k + '` reaches the kiosk', !(k in prog)));
ok('  …not anywhere in the whole response, however it was nested',
   JSON.stringify(board).indexOf('8.68') < 0 && JSON.stringify(board).indexOf('rep@mule') < 0
   && JSON.stringify(board).indexOf('sekret-share') < 0);
/* What it DOES carry is exactly the detail Sky asked for, with the right values. */
ok('it carries the product in words a wall screen can show', prog.product === 'All Mule Extracts products');
ok('  …the store goal and the per-budtender goal for THIS store',
   prog.store_goal === 120 && prog.bt_goal === 6);
ok('  …the payout and its model', prog.payout === 25 && prog.payout_type === 'flat');
ok('  …and Tawny\'s tips, blanks dropped',
   prog.tips.length === 2 && prog.tips[0] === 'Lead with the 2g price');

/* ══════════════════ 1b. THE PEOPLE SLICE — WHAT MOVED, AND WHAT DID NOT ══════════════════
 * Sky, 2026-09-11: the kiosk's SPIFF button now opens this page directly, so the per-person bars
 * that Leaderboard's own panel drew move here. That reverses "no person on this page" — with his
 * confirmation, and on the ground that the Leaderboard board on the SAME screen already shows each
 * person's SPIFF units and target on their staff card.
 *
 * EARNINGS DID NOT MOVE, and that is what this block exists to hold. Money per person is the half
 * that reads worst over a counter, and it is one property away at every step: the cached row this
 * reads carries `earned`, and returning the row would have shipped it. The fixture above carries
 * $25 on a row precisely so this can fail if it ever does.
 */
const PERSON_ALLOWED = ['name', 'units', 'target', 'hit', 'unmeasured'];
ok('a person on the kiosk board carries only name, units, target and hit',
   prog.people.length > 0
   && prog.people.every(x => Object.keys(x).every(k => PERSON_ALLOWED.indexOf(k) >= 0)));
['earned', 'employee_id', 'revenue', 'payout', 'user_id'].forEach(k =>
  ok('  …no `' + k + '` on a kiosk person', prog.people.every(x => !(k in x))));
/* The fixture rows carry $25 of `earned`, so the key checks above are the real guard — a second
   assertion with an `||` fallback in it would pass on either half and prove neither. */
ok('only THIS store\'s people are on this store\'s board',
   !prog.people.some(x => /SOMEBODY ELSE/.test(x.name)));
ok('names are decorated where the roster has a better one',
   prog.people.some(x => x.name === 'Sky') && !prog.people.some(x => x.name === 'SKYLER P'));
ok('  …and left as Dutchie reported them where it does not',
   prog.people.some(x => x.name === 'TAWNY R'));
ok('everyone at the store is listed, including whoever has sold none yet',
   prog.people.some(x => x.name === 'New Hire' && x.units === 0 && x.unmeasured === true));
ok('  …without listing the same person twice under two spellings',
   prog.people.filter(x => /Sky|SKYLER/.test(x.name)).length === 1);
ok('most sold first, so the board reads as a board',
   prog.people[0].units === 9 && prog.people[prog.people.length - 1].units === 0);
ok('the goal a bar is drawn against is the PROGRAM\'s per-store goal, not the cached row\'s',
   prog.people.every(x => x.target === 6));
ok('  …and `hit` is resolved against that same goal',
   prog.people.filter(x => x.name === 'Sky')[0].hit === true
   && prog.people.filter(x => x.name === 'TAWNY R')[0].hit === false);
ok('a program with no per-budtender goal draws no personal bar at all',
   board.programs.filter(x => x.program_id === 'gron-0905')[0].people.every(x => x.target === 0 && !x.hit));
ok('it says how old the figures are, so a board is not trusted to the minute',
   prog.measured_at === '2026-09-15 08:00:00');
{
  const noRoster = kiosk({ employees: { ok: false } }).storeView_({ t: 'live-token' });
  ok('a roster that could not be read adds nobody rather than emptying the board',
     noRoster.programs[0].people.length >= 2);
  const noCache = kiosk({ rows: [] }).storeView_({ t: 'live-token' });
  ok('a cache with no rows still lists the store\'s people, at zero',
     noCache.programs[0].people.length === 2
     && noCache.programs[0].people.every(x => x.units === 0 && x.unmeasured === true));
}

/* ══════════════════ 2. THE TOKEN IS THE CREDENTIAL, AND IT IS CHECKED ══════════════════ */
{
  const k = kiosk();
  ok('a missing token is refused',
     k.storeView_({}).ok === false && /missing its code/.test(k.storeView_({}).error));
  const wrong = k.storeView_({ t: 'not-a-token' });
  ok('a token that matches no row is refused', wrong.ok === false && !wrong.programs);
  ok('  …and a revoked link says the LINK is dead, not the store',
     /no longer active/.test(k.storeView_({ t: 'dead-token' }).error)
     && !/no such store/i.test(k.storeView_({ t: 'dead-token' }).error));
  ok('a refusal carries no store, no people and no programs',
     Object.keys(wrong).sort().join(',') === 'error,ok');
  /* The caller cannot ask for another store's board by saying so. */
  const spoof = k.storeView_({ t: 'live-token', store: 'bend', store_id: 'bend' });
  ok('the store comes from the matched row, never from the caller', spoof.store_id === 'river-rd');
}
/* Minting and rotating are writes and need a real session, like everything else here. Source-
   shaped: what they check is the gate at the top of a function, and the assertions two lines below
   in section 3 exercise the rest of them. */
['storeLinks_', 'storeLinkRotate_'].forEach(fn => {
  const f = G.grab(fn);
  ok(fn + ' needs a signed-in session', /gxAuth_\(p\.token\)/.test(f) && /needsAuth: true/.test(f));
  ok('  …and an editing role', /EDIT_ROLES\.indexOf\(String\(auth\.role\)\) < 0/.test(f));
});
ok('the kiosk read is not secret-gated either — the URL token is the whole credential',
   G.grab('storeView_').indexOf('GX_SECRET_PROP') < 0);
/* ── AND IT HAS TO BE REACHABLE, which is a separate fact from being safe ────────────────────
   The router is private-by-default: PUBLIC_ACTIONS is a short closed list and anything absent
   from it is answered "Not signed in" BEFORE its handler runs. So the first deploy of this route
   returned auth_required to every kiosk — the handler was correct and simply never reached. */
ok('storeView is on the public list, or no kiosk can reach it',
   /var PUBLIC_ACTIONS = \[[^\]]*'storeView'/.test(gs));
ok('  …and it is the ONLY new name on it — minting still needs a session',
   !/PUBLIC_ACTIONS = \[[^\]]*storeLinks/.test(gs)
   && !/PUBLIC_ACTIONS = \[[^\]]*storeLinkRotate/.test(gs));

/* ══════════════════ 2b. WHAT IS ON THE BOARD TODAY, RESOLVED AT READ TIME ══════════════════ */
ok('a closed program never shows on a kiosk',
   !board.programs.some(x => x.program_id === 'closed-0801'));
ok('a program that has not started yet does not either',
   !board.programs.some(x => x.program_id === 'future-1001'));
ok('nor one that runs at another store',
   !board.programs.some(x => x.program_id === 'bend-only'));
ok('the soonest to end is listed first — that is the one worth pushing today',
   board.programs.map(x => x.program_id).join(',') === 'gron-0905,mule-0831');
ok('the board states the date it resolved against', board.today === '2026-09-10');
{
  /* The window is inclusive at both ends: a program ending today is still running today. */
  const endsToday = kiosk({ programs: [Object.assign({}, PROGRAMS[0],
    { start_date: '2026-09-10', end_date: '2026-09-10' })] }).storeView_({ t: 'live-token' });
  ok('a program that starts and ends today is on the board', endsToday.programs.length === 1);
  const ended = kiosk({ programs: [Object.assign({}, PROGRAMS[0],
    { start_date: '2026-08-01', end_date: '2026-09-09' })] }).storeView_({ t: 'live-token' });
  ok('  …and one that ended yesterday is not', ended.programs.length === 0);
  const noStores = kiosk({ stores: [] }).storeView_({ t: 'live-token' });
  ok('a store registry that did not answer falls back to the slug rather than a blank name',
     noStores.store_name === 'river-rd');
}

/* ── THE PAGE ITSELF ─────────────────────────────────────────────────────────────────────────────
   Source-shaped from here down, and deliberately: store.js paints a DOM and store.html is markup.
   The route above is what decides what can leak; these pin that the page has not grown a sign-in,
   a personal link, or a money formatter. */
ok('the kiosk page never reads the personal route',
   sjs.indexOf("'flyer'") < 0 && /jsonp\('storeView'/.test(sjs));
ok('  …and has no sign-in of any kind',
   !/spiff_session/.test(sjs) && !/renderGate/.test(sjs) && !/password/i.test(sjs));
ok('  …and says so in the markup, so the next reader does not add one',
   /no sign-in/.test(shtml) && /never shows anyone's earnings/.test(shtml));
ok('nothing on the kiosk renders money for a PERSON',
   !/money\(/.test(grab(sjs, 'board')));
/* MOVED 2026-09-16 from "draws no bar when there is no personal goal". That rule was right when
   the bar could only mean "units against YOUR goal" — with no goal, a full-width empty track read
   as "you have sold nothing", so the bar was hidden. The redesign gives a goal-less (per-unit)
   program a bar scaled to the LEADER, which means "how you compare" and is the only question the
   screen can answer there. What has to stay true is that nothing is measured against a goal that
   does not exist: no `/goal` suffix and no hit state. */
{
  const b = grab(sjs, 'board');
  ok('a per-unit program\'s bars are scaled to the leader, not to a goal of zero',
     /goal > 0 \? goal : \(leader \|\| 1\)/.test(b));
  ok('  …and nothing is measured against a goal that does not exist',
     /goal > 0 \? '<small>\//.test(b) && /goal > 0 \? \(hits/.test(b));
}
ok('it reads the hourly cache, not a live Dutchie pull — six kiosks polling sell-through would crawl',
   /progressRowsFor_\(/.test(G.grab('storePeople_')) && G.grab('storePeople_').indexOf('sellthrough_') < 0);

/* ══════════════════ 3. ONE LINK PER STORE, PERMANENT ══════════════════ */
const links = grab(gs, 'storeLinks_');
ok('links are keyed on the store, not on a program',
   /STORE_LINK_HEADERS = \['store_id', 'token'/.test(gs) && links.indexOf('program_id') < 0);
/* What the link resolves to at read time — which programs, in which order — is exercised against
   the running route in section 2b; it is not restated here. */
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
   /id="settingsBack"/.test(html) && /<div id="settingsBack"[\s\S]*?id="kioskBody"/.test(html.replace('class="modal-back" ', '')));
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
   /var EDITABLE_FIELDS = \[[\s\S]*?'pitch_json'\s*\n\];/.test(gs));
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
   /Nothing running right now/.test(sjs));
/* A SHARED screen must not send the room to a page that needs a personal sign-in — most readers
   cannot follow that where they are standing, and it invited somebody to sign in on a kiosk
   everybody uses. Removed 2026-09-08 (Sky), alongside the nav entry. */
/* STRENGTHENED 2026-09-16: there is no footer at all now. It used to be checked against the
   RENDERED footer rather than the file, because the comment above it names My SPIFF to explain the
   removal and a bare substring search flagged that prose — the same care applies to the check
   below, which looks for the CLASS, not for the words. */
ok('the kiosk has no footer to send the room to a personal login',
   sjs.indexOf('st-foot') < 0);
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

/* ══════════════════ 6. THE BOARD REDESIGN (2026-09-16) ══════════════════
 * design_handoff_spiff_kiosk_board. The people were a footnote under the figures and are now the
 * centerpiece: ranked, 46px rows, the store's own color on the attainment track. Three of these
 * are behavior, not paint, and each reverses something this file used to assert — so each says
 * what it replaced.
 */
{
  const bd = grab(sjs, 'board');
  const pp = grab(sjs, 'programPanel');

  /* THE THIRD FIGURE. Two before (goal, payout); now what it pays, how far to go, and how long is
     left — the three things a budtender acts on, confirmed with Sky. */
  ok('the program panel carries three figures, the clock among them',
     (pp.match(/st-fig-v/g) || []).length === 3 && /daysLeft\(p\.end_date, today\)/.test(pp));
  ok('  …and the clock turns gold at three days out, where it changes what somebody does today',
     /left <= 3 \? ' is-soon'/.test(pp));
  ok('  …counted inclusive of the end date, like the operator app', /\+ 1;/.test(grab(sjs, 'daysLeft')));

  /* RANKED. The rank number beside a name has to be the position the row is actually in, so the
     page sorts rather than trusting the order a payload arrived in — even though the engine sorts
     too, and section 1b holds that end of it. */
  ok('the board ranks the room, most sold first', /people\.sort\(/.test(bd) && /st-bt-r/.test(bd));
  ok('  …with a stable tiebreak, so equal rows do not swap between refreshes',
     /localeCompare/.test(bd));
  ok('a row that has hit reads as done from arm\'s reach — the whole row, not a tick',
     /is-hit/.test(bd) && /\.st-bt\.is-hit \{ background: var\(--gx-green-soft\)/.test(scss));
  ok('  …and the glow stops for anyone who asked for less motion',
     /prefers-reduced-motion[\s\S]{0,200}st-bt\.is-hit[\s\S]{0,60}animation: none/.test(scss));

  /* THE STORE LINE. Context under the title, not a headline — nobody sells against a chain figure.
     Absent rather than "42 of 0" when the program carried no store goal. */
  ok('the store\'s own number sits under the board title in its registry color',
     /st-store-bar/.test(bd) && /var\(--st-color/.test(scss) && /--st-color:/.test(grab(sjs, 'render')));
  ok('  …and is absent, not zero, when the program set no store goal', /storeGoal\s*\n?\s*\?/.test(bd));

  /* ONE PROGRAM. The two-column grid is gone — only one ever runs at a store, and a layout built
     for a case that does not happen is a layout nobody sees rendered. Two would STACK, though:
     hiding the second to protect a layout would take a live program off a shop floor. */
  /* The SELECTOR and the class the page would set, not the words — both files explain the removal
     in prose above the code, and a test that cries about a comment is one people learn to loosen. */
  ok('the two-column grid for a second program is gone',
     !/\.st-wrap\.is-multi\s*\{/.test(scss) && !/'\s*is-multi'/.test(sjs)
     && grab(sjs, 'render').indexOf('is-multi') < 0);
  ok('  …but a second program would still be drawn, not dropped',
     /list\.map\(function \(p\)/.test(grab(sjs, 'render')));

  /* NO CHROME OF ITS OWN. The kiosk modal already says "SPIFF · Century" and carries Close and a
     closing timer. Sky, 2026-09-16, chose to drop the "as of 11:00am" stamp with it — so the
     assertion that used to require it is gone rather than quietly inverted. What replaced it is
     this: the page states no freshness it cannot keep, and the figures are still the hourly cache
     (section 1b), not a live pull. */
  ok('the page draws no header of its own over the modal\'s',
     sjs.indexOf('st-store"') < 0 && sjs.indexOf('st-count') < 0);
  ok('  …and claims no freshness now that it does not show one', !/as of /.test(sjs));

  /* THE FIRST SECOND is skeleton geometry, not the word "Loading". */
  /* Checked as RENDERED text and as the class — the comment above the markup names the word
     "Loading" to explain why it is not there. */
  ok('the boot state is skeleton geometry matching the layout',
     /sp-skel st-skel-fig/.test(shtml) && /sp-skel st-skel-row/.test(shtml)
     && !/>\s*Loading/.test(shtml) && shtml.indexOf('fl-boot') < 0);
}

/* ══════════════════ 6b. NOTHING RUNNING IS STILL A SCREEN ══════════════════
 * The empty board used to be a dead page. It now says how the store finished the last one — which
 * only the engine knows, so the page must not infer it. Run for real, because the interesting half
 * is which program is chosen and what attainment is measured against. */
{
  const CLOSED = { program_id: 'wyld-0824', vendor: 'Wyld', program_name: 'Wyld 5pc Gummies',
                   status: 'closed', start_date: '2026-08-24', end_date: '2026-09-06',
                   stores_json: ['river-rd'], target_json: { by_store: { 'river-rd': 50 } } };
  const OLDER  = Object.assign({}, CLOSED, { program_id: 'gron-0810', program_name: 'Grön older',
                                             end_date: '2026-08-23' });
  const rows = [{ program_id: 'wyld-0824', store_id: 'river-rd', employee_id: 'e1', name: 'SKYLER P',
                  units: 33, target: 5, hit: true, earned: 25, refreshed_at: '2026-09-06 20:00:00' },
                { program_id: 'wyld-0824', store_id: 'river-rd', employee_id: 'e2', name: 'TAWNY R',
                  units: 23, target: 5, hit: true, earned: 25, refreshed_at: '2026-09-06 20:00:00' },
                { program_id: 'wyld-0824', store_id: 'bend', employee_id: 'e7', name: 'ELSEWHERE',
                  units: 99, target: 5, hit: true, earned: 25, refreshed_at: '2026-09-06 20:00:00' }];
  const quiet = kiosk({ programs: [CLOSED, OLDER, PROGRAMS[3], PROGRAMS[4]], rows })
                  .storeView_({ t: 'live-token' });

  ok('a store with nothing running still gets an answer, not a blank',
     quiet.ok === true && quiet.programs.length === 0 && !!quiet.last_program);
  ok('  …naming the program that finished most recently, not the first one found',
     quiet.last_program.program_name === 'Wyld 5pc Gummies' && quiet.last_program.end_date === '2026-09-06');
  ok('  …with how THIS store did, measured the way the live board measures it',
     quiet.last_program.store_pct === 112);
  ok('  …counting only this store\'s rows, never the chain\'s',
     JSON.stringify(quiet.last_program).indexOf('99') < 0);
  const LAST_ALLOWED = ['vendor', 'program_name', 'end_date', 'store_pct'];
  ok('  …and carrying nothing a finished program has no business putting on a wall',
     Object.keys(quiet.last_program).every(k => LAST_ALLOWED.indexOf(k) >= 0));

  /* No percentage rather than a wrong one, and no chip rather than a guessed one. */
  const noGoal = kiosk({ programs: [Object.assign({}, CLOSED, { target_json: {} })], rows })
                   .storeView_({ t: 'live-token' });
  ok('a program that set no store goal reports no percentage rather than a made-up one',
     !('store_pct' in noGoal.last_program));
  const none = kiosk({ programs: [PROGRAMS[3]] }).storeView_({ t: 'live-token' });
  ok('a store that has never run one gets the two lines and no chip', !('last_program' in none));
  /* A closed program whose end date has not passed is a closed-early program, not the last one to
     finish — and it is still the future to a screen reading dates as text. */
  const early = kiosk({ programs: [PROGRAMS[2]] }).storeView_({ t: 'live-token' });
  ok('a program closed ahead of its end date is not offered as the last one to finish',
     !('last_program' in early));
  ok('the chip is not computed at all while something is running — it costs a read',
     !('last_program' in board));
  ok('the page joins its name with the same rule a live program uses, not a second one',
     /programLabel\(last\)/.test(grab(sjs, 'emptyBoard')));

  /* ── THE HANDOFF MUST NOT CONTRADICT THE ROUTE (2026-09-17) ──────────────────────────────────
     The kiosk-board handoff shipped in the SAME commit as this field (v1.429) saying `storeView`
     "does not return" it, and told the reader to drop the chip instead. Leaderboard read that,
     believed it, and shipped the plain empty state to six wall screens — then asked us to build
     what was already live. A doc nobody can contradict costs the next reader a day.

     The keys come from the route as RUN, not from a list written here, so adding one to
     lastClosedFor_ without documenting it fails. */
  const HANDOFF = fs.readFileSync(
    __dirname + '/../design_handoff_spiff_kiosk_board/README.md', 'utf8');
  const undocumented = Object.keys(quiet.last_program).filter(k => HANDOFF.indexOf(k) < 0);
  ok('the handoff documents every field the empty board actually returns' +
     (undocumented.length ? ' — missing ' + undocumented.join(', ') : ''),
     HANDOFF.indexOf('last_program') >= 0 && undocumented.length === 0);
  /* The exact sentence that misled them, and any re-wording of it. A field the route returns must
     never be described to a consumer as absent. */
  ok('  …and never tells a consumer the route lacks a field it returns',
     !/storeView[^.\n]{0,60}(does not return|doesn't return|does not carry|doesn't carry)/i
        .test(HANDOFF));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nstore view: all passed');
process.exit(fail ? 1 : 0);
