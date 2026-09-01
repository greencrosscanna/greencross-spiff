/* GX SPIFF — front end.
 *
 * Vendor-funded budtender incentives, end to end: model a program with the vendor (Calculator),
 * watch it fill from Dutchie sell-through (Progress), close it out into a vendor report + payouts
 * (Reports), and keep every past program findable (History).
 *
 * Replaces two spreadsheets:
 *   • "Green Cross SPIFF Calculator"  — 19 vendor tabs of ROI math
 *   • "SPIFF_Sales Report" (v1.4)     — 6 store tabs of pasted Dutchie exports + a budtender matrix
 *
 * All GX Core traffic goes through GXClient (retry-aware — GX Core's /exec second hop 404s ~6% of
 * the time; see gx-client.js). Never hand-roll a JSONP call here.
 */
'use strict';
(function () {

  /* ---------------------------------------------------------------- config */
  var GXCORE = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
  var APP    = 'spiff';
  // This app's own Apps Script engine. Same two-hop /exec as GX Core, so it gets the
  // same retry-aware client rather than a hand-rolled fetch.
  var ENGINE = 'https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec';

  var GX  = GXClient(GXCORE);
  // Single-sourced from the ?v=N cache-buster on this script tag, the same value deploy.sh records,
  // so the version shown to a user cannot drift from the version that shipped.
  /* The suite version format is vMAJOR.BBB, so the fraction is NOT optional decoration — it is the
     build counter. `(\d+)` stopped at the dot and reported plain "v1" for ?v=1.280, which is the
     exact bug deploy.sh had against this same file (see gx-theme/tests/deploy_version_test.js).
     Silent, too: "v1" is a plausible-looking version, so nothing about the header looked wrong. */
  var APP_VERSION = (function () {
    var m = /[?&]v=(\d+(?:\.\d+)?)/.exec((document.currentScript && document.currentScript.src) || '');
    return m ? 'v' + m[1] : 'dev';
  })();
  var ENG = GXClient(ENGINE);

  /* ----------------------------------------------------------------- state */
  var state = {
    tab:       'programs',
    stores:    [],   // from GX Core — canonical, never hardcoded
    employees: [],   // from GX Core — SPIFF READS the roster, never writes it
    programs:  [],
    record:    null  // program open in the record modal
  };

  /* ------------------------------------------------------------------ util */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function conn(status, detail) {
    var el = $('#conn');
    if (!el) return;
    el.textContent = '● ' + status;
    el.className = 'conn is-' + (detail || status).replace(/\s+/g, '-');
    el.title = detail || status;
  }

  /* ------------------------------------------------------------------ tabs */
  function showTab(name) {
    state.tab = name;
    $$('#tabs .gx-topnav-tab').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === name); });
    $$('.panel').forEach(function (p) { p.classList.toggle('is-active', p.id === 'panel-' + name); });
    /* Each tab filters different things, so each owns its own sub-nav bar and only the
       active one is in the layout. Hidden with [hidden] so it takes no height. */
    $$('.sp-subnav').forEach(function (b) { b.hidden = b.id !== subnavIdFor(name); });

    /* Progress pulls itself. Making someone press Refresh to see the thing the tab is named
       after is a step that exists only because the fetch is slow — and the fetch being slow is
       the reason to start it the moment the tab is opened, not a reason to wait for a click.
       Only ONCE per program though: re-entering the tab must not restart six ~9s pulls. */
    if (name === 'progress' && $('#pgProgram') && $('#pgProgram').value
        && (!pgRun || pgRun.id !== $('#pgProgram').value)) {
      loadProgress();
    }
  }
  function subnavIdFor(tab) {
    return 'subnav' + tab.charAt(0).toUpperCase() + tab.slice(1);
  }

  function wireTabs() {
    var bar = $('#tabs');
    if (bar) bar.addEventListener('click', function (e) {
      var b = e.target.closest('.gx-topnav-tab');
      if (!b) return;
      // A tab carrying data-href is a link-out (the budtender flyer), not a panel. Guard on
      // dataset.tab too — a tab with neither would otherwise showTab(undefined) and blank the app.
      if (b.dataset.href) { window.open(b.dataset.href, '_blank', 'noopener'); return; }
      if (b.dataset.tab) showTab(b.dataset.tab);
    });
  }

  /* ------------------------------------------------------- GX Core loaders */
  // Stores and employees are shared truth. Pull them; don't re-hardcode store names — Command
  // Center edits must flow through on the next load.
  async function loadShared(opts) {
    try {
      var s = await GX.jsonp('stores', {}, opts || {});
      if (!s || !Array.isArray(s.stores)) throw new Error('stores: unexpected response');
      state.stores = s.stores;

      // NOTE: the roster is NOT fetched here. GX Core exposes no public `employees`
      // action — it lives behind the bound GXCore library, so only the engine can read
      // it. This used to call action=employees and silently swallow "Unknown action",
      // leaving state.employees permanently empty while looking fine.
      conn('GX Core', 'connected');
    } catch (err) {
      conn('offline', 'GX Core unreachable');
      console.error('[spiff] GX Core load failed:', err);
    }
  }

  /* -------------------------------------------------------------- programs */

  /* Cents are all-or-nothing. maximumFractionDigits alone renders 479.5 as "$479.5", which
     reads as a truncated number rather than a price — money shows either no decimals or two,
     never one. Whole amounts stay clean ($475, not $475.00). */
  function money(n) {
    var v = Number(n) || 0;
    var cents = Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 && Math.round(v * 100) % 100 !== 0;
    /* Sign OUTSIDE the symbol: "$-412" is not how a negative amount is written, and a negative
       ROI is exactly where it shows up. */
    var opts = (cents || v % 1 !== 0)
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumFractionDigits: 0 };
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', opts);
  }
  /* Whole dollars, for a headline figure. The net-return tile sums ROI across every program and
     landed on things like "-$1,284.53" — three characters of precision nobody reads on a KPI card,
     on a number that is a sum of estimates anyway. Rounds, never truncates, so the tile and a
     detailed view of the same figure cannot disagree by a dollar in opposite directions. */
  function money0(n) { return money(Math.round(Number(n) || 0)); }
  // The sheet stores ROI % as a fraction (0.3588 = 35.88%).
  function pct(n) { return ((Number(n) || 0) * 100).toFixed(1) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  /* Reads carry the session token now. They did not used to: the engine served programs,
     sell-through, the roster and payout totals to anyone with the /exec URL, which ships in
     index.html on public Pages. The gate was real but it guarded the wrong server. */
  async function loadPrograms() {
    var list  = $('#programsList');
    var empty = $('#programsEmpty');
    try {
      var r = await ENG.jsonp('programs', { token: (session() || {}).token });
      /* This is the FIRST read after boot, so it is where a bad session surfaces. Now that the
         engine actually checks, "Couldn't load programs: Invalid session" would leave someone
         staring at an empty app shell holding a token that will never work again -- the answer
         to that is the sign-in gate, not an error message. Route it the same way boot does:
         no_access is a grant problem and gets the panel, everything else gets the gate. */
      if (r && r.needsAuth) {
        var who = (session() || {}).user;
        clearSession();
        if (r.code === 'no_access') renderNoAccess(who);
        else renderGate(r.error || 'Please sign in again');
        return;
      }
      // Insist on the shape we asked for. Treating any object as success turns a wrong
      // or errored response into a silent empty table, which reads as "no data" — the
      // failure mode that hid a JSONP callback collision.
      if (!r || !r.ok || !Array.isArray(r.programs)) {
        throw new Error((r && r.error) || 'Engine returned an unexpected response');
      }
      state.programs = r.programs;
    } catch (err) {
      console.error('[spiff] programs load failed:', err);
      empty.hidden = false;
      list.hidden = true;
      $('#programsEmpty p').textContent = 'Couldn’t load programs: ' + (err.message || err);
      return;
    }
    renderPrograms();
  }

  /* ---------------------------------------------------------- programs (1a) */
  /* Filter state for the sub-nav. Kept OUT of state.programs so filtering never mutates
     the loaded set -- "Active" showing nothing must still leave History able to see 21. */
  var progFilter = { q: '', scope: 'active' };

  /* state.stores is the registry GX Core just handed us, so it is preferred over GXStores --
     GXStores.load() is fired off at boot and may not have answered yet, and a store rendering
     gray for the first second reads as a broken color rather than a slow one. GXStores stays
     as the fallback so a store missing from this app's payload still gets its suite color. */
  function storeRow(id) {
    var k = String(id || '').toLowerCase();
    for (var i = 0; i < state.stores.length; i++) {
      if (String(state.stores[i].store_id || '').toLowerCase() === k) return state.stores[i];
    }
    return null;
  }
  function storeColor(id) {
    var r = storeRow(id);
    if (r && r.color) return r.color;
    try { return (window.GXStores && GXStores.color(id)) || 'var(--gx-text-mute)'; }
    catch (e) { return 'var(--gx-text-mute)'; }
  }
  function storeName(id) {
    var r = storeRow(id);
    if (r && r.display_name) return r.display_name;
    try { return (window.GXStores && GXStores.name(id)) || id; }
    catch (e) { return id; }
  }

  function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }

  /* Search and store still narrow the closed tail — only the STATUS scope is ignored for it.
     Typing a vendor and still seeing unrelated closed programs would read as a broken search. */
  function progMatchesExceptScope(p) {
    if (progFilter.q) {
      var hay = ((p.program_name || '') + ' ' + (p.vendor || '') + ' ' + (p.title || '')).toLowerCase();
      if (hay.indexOf(progFilter.q) < 0) return false;
    }
    return true;
  }

  function progMatches(p) {
    if (progFilter.scope !== 'all' && p.status !== progFilter.scope) return false;
    if (progFilter.q) {
      var hay = ((p.program_name || '') + ' ' + (p.vendor || '') + ' ' + (p.title || '')).toLowerCase();
      if (hay.indexOf(progFilter.q) < 0) return false;
    }
    return true;
  }

  /* Skeletons replace every "Loading…" string. The geometry MATCHES the real thing --
     four stat tiles, a hero, three rows -- so nothing shifts when the data lands. */
  function renderProgramsSkeleton() {
    var stats = $('#progStats'), run = $('#progRunning'), closed = $('#progClosed');
    var drafts = $('#progDrafts');
    if (drafts) drafts.innerHTML = '';
    if (stats) stats.innerHTML = Array(4).join(',').split(',').map(function () {
      return '<div class="sp-stat"><div class="sp-skel" style="height:23px;width:60%"></div>'
           + '<div class="sp-skel sp-skel-line" style="width:80%;margin-top:8px"></div></div>';
    }).join('');
    if (run) run.innerHTML = '<div class="sp-hero"><div class="sp-skel" style="height:22px;width:220px"></div>'
      + '<div class="sp-skel sp-skel-line" style="width:340px;margin-top:12px"></div>'
      + '<div class="sp-skel" style="height:9px;margin-top:24px"></div></div>';
    if (closed) closed.innerHTML = '';
  }

  /* Pace: how far through the window we are, against how much has sold. The two together
     are the only honest read -- 70% sold is good on day 4 and bad on day 14. */
  function paceOf(p, live) {
    var a = p.actual_json || {}, tgt = (p.target_json && p.target_json.units) || 0;
    var sold = live ? live.units : (a.units_sold || 0);
    var frac = tgt ? sold / tgt : 0;
    /* TEXT-DATE ARITHMETIC, and the end date is INCLUSIVE. Date.parse('2026-08-30') is UTC
       midnight while Date.now() is local, so subtracting them mixed two clocks — and treating
       the end as an instant rather than a whole day lost the last day of every program. A
       program running the 17th to the 30th is 14 selling days, not 13. */
    var elapsed = null;
    if (p.start_date && p.end_date) {
      var total = daysBetween(p.start_date, p.end_date) + 1;
      if (total > 0) {
        var doneDays = daysBetween(p.start_date, today()) + 1;
        elapsed = Math.max(0, Math.min(1, doneDays / total));
      }
    }
    return { frac: frac, elapsed: elapsed, sold: sold, target: tgt,
             /* MET is not the same as AHEAD. Ahead of pace on day 3 is encouraging; past the
                goal is the thing worth interrupting for, and it gets the brighter treatment
                Sales and Leaderboard use for a cleared target. */
             met: tgt > 0 && frac >= 1,
             ahead: elapsed == null ? frac >= 1 : frac >= elapsed };
  }

  function renderPrograms() {
    var empty = $('#programsEmpty');
    var stats = $('#progStats'), run = $('#progRunning'), closed = $('#progClosed');
    var draftsEl = $('#progDrafts');
    if (!stats) return;

    if (!state.programs.length) {
      empty.hidden = false;
      stats.innerHTML = ''; run.innerHTML = ''; closed.innerHTML = '';
      if (draftsEl) draftsEl.innerHTML = '';
      return;
    }
    empty.hidden = true;

    var all      = state.programs;
    var visible  = sortPrograms(all.filter(progMatches));
    var running  = all.filter(function (p) { return p.status === 'active'; });
    var needCheck = all.filter(function (p) {
      var a = p.actual_json;
      return a && ((a.duplicate_of && a.duplicate_of.length) || a.rate_changed);
    }).length;

    /* ---- stat strip. Only figures carrying a judgement take a color. */
    var atStake = running.reduce(function (n, p) {
      var pay = (p.payout_json && p.payout_json.amount) || 0;
      return n + pay * ((p.target_json && p.target_json.budtenders) || 0);
    }, 0);
    var netReturn = all.reduce(function (n, p) { return n + ((p.actual_json && p.actual_json.roi) || 0); }, 0);
    var closedN = all.filter(function (p) { return p.status === 'closed'; }).length;

    stats.innerHTML =
        statTile(running.length, 'running now', '')
      + statTile(money(atStake), 'at stake for budtenders', '')
      + statTile((netReturn >= 0 ? '+' : '') + money0(netReturn), 'net return, ' + all.length + ' programs',
                 netReturn >= 0 ? 'is-pos' : 'is-neg')
      + statTile(needCheck, 'records need checking', needCheck ? 'is-warn' : '');

    /* ---- the one running program, as a hero.
       The hero obeys the filter like everything else. It used to render unconditionally, which
       meant searching "kaprikorn" left the Wyld hero sitting on top of the one matching row,
       and picking scope=Closed showed an ACTIVE program under a Closed filter -- the screen
       contradicting the control the user had just set. */
    var heroes = running.filter(progMatches);
    run.innerHTML = heroes.map(heroCard).join('');

    /* ---- everything else, dense, and under the default "Active" scope split in two.
       Three sections is the shape of the page Sky asked for: the running program is the
       answer to "how are we doing", the DRAFTS are the ones still being set up (the only
       other thing you can act on), and the last few closed ones are the context. Filtering
       them out entirely (which "Active" literally means) would leave the screen looking like
       the app has one program in it.

       Drafts used to be folded into this same tail under a "Closed" heading, where they both
       sat under the wrong word AND could push real closed programs out of the top three.
       Pick any other scope and the bottom section becomes the real filtered list, as before. */
    var TAIL = 4;
    var tail = progFilter.scope === 'active';
    var drafts = tail
      ? sortPrograms(all.filter(function (p) {
          return p.status === 'draft' && progMatchesExceptScope(p);
        }))
      : [];
    var rest = tail
      ? sortPrograms(all.filter(function (p) {
          return p.status === 'closed' && progMatchesExceptScope(p);
        })).slice(0, TAIL)
      : visible.filter(function (p) { return p.status !== 'active'; });

    if (draftsEl) draftsEl.innerHTML = drafts.length
      ? listSection('Drafts', drafts.length + ' program' + (drafts.length === 1 ? '' : 's'), drafts, '')
      : '';

    var heading = tail ? 'Closed' : (progFilter.scope === 'all' ? 'All programs' : cap(progFilter.scope));
    var note = tail
      ? 'last ' + rest.length + ' of ' + closedN
      : rest.length + ' program' + (rest.length === 1 ? '' : 's');

    closed.innerHTML = rest.length
      ? listSection(heading, note, rest, 'see all in History')
      : (heroes.length || drafts.length ? '' : '<div class="sp-notice">Nothing matches that filter. '
          + closedN + ' closed program' + (closedN === 1 ? '' : 's') + ' in History.</div>');
  }

  /* One headed block of rows. Shared so the Drafts and Closed sections cannot drift apart --
     they are the same object in two states, and a row that looks different in one of them is
     a row you have to re-learn. `link` empty means no History link, which is right for drafts:
     History is closed programs only. */
  function listSection(heading, note, rows, link) {
    return '<div class="sp-head"><h2>' + esc(heading) + '</h2>'
      + '<span class="sp-head-note">' + esc(note) + '</span>'
      + (link ? '<a class="sp-head-link" href="#" data-goto="history">' + esc(link) + '</a>' : '')
      + '</div>'
      + '<div class="sp-list' + (canEdit() ? ' can-share' : '') + '">'
      + rows.map(listRow).join('') + '</div>';
  }

  function newProgram() {
    calc.name = ''; calc.vendor = ''; calc.cost = 10; calc.spiff = 25;
    calc.target = 0; calc.model = 'flat';
    /* Leaving these behind is how a "new" program inherits the last one's product and, worse,
       its editingId — which would make Save overwrite the program you thought you had left. */
    calc.product = null; calc.editingId = null; calc.window = null; calc.refRun = null;
    /* Reference units reset to 0, budtender counts do NOT: headcount is a property of the
       store, not of the program being modelled, so re-typing it every time would be busywork. */
    calc.stores = state.stores.map(function (st) {
      var prev = calc.stores.filter(function (x) { return x.store_id === st.store_id; })[0];
      return { store_id: st.store_id, name: st.display_name || st.store_id,
               baseline: 0, bts: (prev && prev.bts) || 6 };
    });
    $('#cName').value = ''; $('#cVendor').value = '';
    $('#cCost').value = calc.cost; $('#cSpiff').value = calc.spiff;
    $('#cTarget').value = 0; $('#cGrowth').value = 0;
    var load = $('#calcLoad'); if (load) load.value = '';
    $$('#cModel button').forEach(function (x) { x.classList.toggle('is-on', x.dataset.model === 'flat'); });
    $$('#cTarget, #cGrowth').forEach(function (x) { x.classList.remove('sp-driving'); });
    if (calcPicker) { calcPicker.setChosen(null); calcPicker.setVendorSilently(''); }
    renderCalcEditing();
    showTab('calculator');
    recalc();
    $('#cName').focus();
  }

  function statTile(v, label, cls) {
    return '<div class="sp-stat ' + cls + '"><div class="sp-stat-v">' + esc(String(v)) + '</div>'
         + '<div class="sp-stat-l">' + esc(label) + '</div></div>';
  }

  /* Live totals for a program, taken from the SAME pull the Progress tab uses. Sharing it is
     the point: two independent fetches of the same sell-through would eventually disagree, and
     the hero and Progress disagreeing about what a program has sold is the kind of thing that
     ends up in a vendor report. Returns null when there is nothing live yet, so the caller can
     fall back to the recorded actuals rather than showing zeros. */
  /* The CACHED progress table, refreshed hourly by an engine trigger. The landing page reads
     this instead of fanning out six live sell-through calls, which is what made it take a
     minute: each store walks its date windows sequentially at ~9s a call, so a fortnight-long
     program is two windows per store and the page sat there for the slowest chain.
     The cache answers in ~4s with every store already in it. Live figures still win when the
     Progress tab has pulled them — see liveTotals — so the landing page is never STALER than
     what the user has already looked at, just cheaper when they have not. */
  var progCache = null;

  async function loadProgressCache() {
    try {
      var r = await ENG.jsonp('progress', { token: (session() || {}).token }, { timeoutMs: 30000, retries: 1 });
      if (!r || !r.ok || !(r.rows || []).length) return null;
      var by = Object.create(null);
      r.rows.forEach(function (row) {
        var g = by[row.program_id] || (by[row.program_id] = {
          units: 0, hit: 0, bts: 0, stores: Object.create(null), rows: [], refreshed_at: row.refreshed_at
        });
        /* Kept per program so Reports can name the budtenders on the gift-card list. That list
           used to say "per-budtender names need sell-through detail, which arrives with the
           Progress tab" — the detail is here now, and a buy list without names is a list
           nobody can take to a till. */
        g.rows.push(row);
        g.units += Number(row.units) || 0;
        if (row.hit) g.hit++;
        g.bts++;
        g.stores[row.store_id] = 1;
      });
      progCache = by;
      renderPrograms();
      return by;
    } catch (e) {
      console.warn('[spiff] progress cache unavailable:', e);
      return null;
    }
  }

  /* Cached totals for a program, shaped like liveTotals so the hero does not care which it got. */
  function cachedTotals(programId, storeCount) {
    var g = progCache && progCache[programId];
    if (!g) return null;
    var n = Object.keys(g.stores).length;
    return { units: g.units, hit: g.hit, bts: g.bts, back: n, pending: 0,
             stores: storeCount || n, cached: true, at: g.refreshed_at };
  }

  function liveTotals(programId) {
    if (!pgRun || pgRun.id !== programId) return null;
    var units = 0, hit = 0, bts = 0, back = 0, pending = 0;
    pgRun.stores.forEach(function (st) {
      if (pgRun.pulling[st]) pending++;
      var r = pgRun.results[st];
      if (!r) return;
      units += r.units; hit += r.hit; bts += r.budtenders;
      if (!pgRun.pulling[st] && !pgRun.failed[st]) back++;
    });
    if (!back && !pending) return null;
    return { units: units, hit: hit, bts: bts, back: back, pending: pending,
             stores: pgRun.stores.length };
  }

  function heroCard(p) {
    var a = p.actual_json || {}, t = p.target_json || {}, pay = (p.payout_json && p.payout_json.amount) || 0;
    var cost = p.cost_json || {};
    var live = liveTotals(p.program_id) || cachedTotals(p.program_id, (p.stores_json || []).length);
    /* A RUNNING program has no recorded actuals — those are written at close-out — so the hero
       was rendering 0 sold, an empty bar and "N units to go" equal to the whole target. Live
       Dutchie figures are what the screen is actually about. */
    var pace = paceOf(p, live);
    var bts = t.budtenders || 0;
    var hit = live ? live.hit : (a.bts_hit || 0);
    /* Shimmer only while NOTHING has come back. Once even one store has answered the figures
       are real, just partial — and the verdict line says how partial. Holding them back until
       all six land would blank the hero for ten seconds on every load. */
    var waiting = !!(live && live.pending && !live.back);

    var stores = (p.stores_json || []).map(function (sid) {
      return '<span class="sp-store-tag" style="--dot:' + esc(storeColor(sid)) + '">'
           + '<span class="sp-dot"></span>' + esc(storeName(sid)) + '</span>';
    }).join('');

    /* Days left, said plainly. "day 12 of 16" beats a date range you have to subtract. */
    var dayNote = '';
    if (p.start_date && p.end_date) {
      var total = daysBetween(p.start_date, p.end_date) + 1;
      var day   = Math.max(1, Math.min(total, daysBetween(p.start_date, today()) + 1));
      dayNote = '<span class="sp-head-note"><span class="sp-live-dot"></span>day ' + day + ' of ' + total
              + ' &middot; ' + daysLeftLabel(p.end_date) + '</span>' + coverageNote(live, p);
    }

    /* The verdict names the gap in UNITS and DAYS, because that is the only form of it
       anyone can act on -- "70% of goal" tells Tawny nothing she can call a vendor about. */
    var verdict = '', vcls = 'is-ahead', vtext = '';
    if (pace.target) {
      var short = Math.max(0, pace.target - pace.sold);
      if (pace.met) { vtext = 'Goal met'; vcls = 'is-met'; }
      else if (pace.ahead) { vtext = 'On pace'; vcls = 'is-ahead'; }
      else { vtext = 'Just behind pace'; vcls = 'is-behind'; }
      var cover = '';   // coverage now lives in the head, where it is visible before the numbers
      verdict = '<span class="sp-verdict-pill ' + vcls + '">' + vtext + '</span>'
              + '<span class="sp-hero-verdict">' + (short
                  ? short.toLocaleString() + ' units still to go.'
                  : 'Goal already met.') + cover + '</span>';
    }

    return '<div class="sp-head"><h2>Running now</h2>' + dayNote + '</div>'
      + '<div class="sp-hero" data-id="' + esc(p.program_id) + '">'
      +   '<div class="sp-hero-top">'
      +     '<div class="sp-hero-id">'
      +       '<div class="sp-hero-title"><h3>' + esc(p.program_name || p.title) + '</h3>'
      +         '<span class="sp-chip is-active">active</span></div>'
      +       '<div class="sp-hero-meta"><span>' + esc(p.vendor) + '</span><span class="sp-sep">&middot;</span>'
      +         '<span class="sp-num">' + esc(prettyRange(p)) + '</span><span class="sp-sep">&middot;</span>'
      +         '<span class="sp-num">' + money(pay) + ' ' + esc(payoutLabel(p)) + '</span>'
      +         (cost.per_unit ? '<span class="sp-sep">&middot;</span><span class="sp-num">' + money(cost.per_unit) + '/unit</span>' : '')
      +       '</div>'
      +       '<div class="sp-hero-stores">' + stores + '</div>'
      +     '</div>'
      +     '<div class="sp-hero-figs">'
      +       fig('Sold', waiting ? null : (live ? live.units : (a.units_sold || 0)).toLocaleString(), 'of ' + (pace.target || 0).toLocaleString(), '')
      +       fig('Budtenders', waiting ? null : hit, 'of ' + bts + ' hit', '')
      +       fig('Earned so far', waiting ? null : money(pay * hit), money(pay * bts) + ' if all ' + bts + ' land it', 'is-pos')
      +     '</div>'
      +   '</div>'
      +   '<div class="sp-hero-bar">' + paceBar(pace) + '</div>'
      +   '<div class="sp-hero-foot">' + verdict
      +     '<span class="sp-hero-actions">'
      +       '<button class="gx-btn" data-goto="progress">Open progress</button>'
      +       '<button class="gx-btn" data-edit="' + esc(p.program_id) + '">Edit record</button>'
      +     '</span>'
      +   '</div>'
      + '</div>';
  }

  /* Days remaining, counted on WHOLE LOCAL DAYS and inclusive of the end date. The old form
     subtracted a UTC-parsed end date from a local now and rounded, which reported "1 day left"
     on the 28th for a program running through the 30th — it was measuring a 1.2-day instant
     gap instead of counting the 29th and the 30th. */
  function daysLeftLabel(end) {
    var n = daysBetween(today(), end);
    if (n < 0)  return 'ended';
    if (n === 0) return 'last day';
    return n + ' day' + (n === 1 ? '' : 's') + ' left';
  }

  /* HOW MUCH OF THE CHAIN THESE FIGURES COVER, stated on the landing page and counting up as
     stores land. Sky opened Progress and only then discovered two stores had not reported —
     the hero had been quietly showing four stores' sales as if they were the whole chain, and
     a short bar is indistinguishable from a slow one. Partial coverage is now impossible to
     miss without leaving the page. */
  function coverageNote(live, p) {
    if (!live) return '<span class="sp-head-note">waiting on Dutchie&hellip;</span>';
    var total = live.stores || (p.stores_json || []).length || 0;
    if (!total) return '';
    if (live.back >= total && !live.pending) {
      return '<span class="sp-head-note">' + (live.cached
        ? 'all ' + total + ' stores &middot; as of ' + esc(shortTime(live.at))
        : 'all ' + total + ' stores &middot; live') + '</span>';
    }
    return '<span class="sp-head-note is-partial"><span class="sp-live-dot"></span>'
      + live.back + ' of ' + total + ' stores in &mdash; totals below are incomplete</span>';
  }

  /* The cache stamps a full JS date string; the hero only needs the clock. */
  function shortTime(v) {
    var m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m) return String(v || '').slice(0, 16);
    var h = Number(m[1]), ap = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + m[2] + ' ' + ap;
  }

  function fig(label, v, sub, cls) {
    /* null means the pull has not answered yet. A zero would read as "nothing sold", which on
       a running program is a different and much more alarming claim. */
    var body = v == null
      ? '<span class="sp-shim" style="width:64px;height:22px"></span>'
      : esc(String(v));
    return '<div><div class="sp-fig-l">' + esc(label) + '</div>'
         + '<div class="sp-fig-v ' + cls + '">' + body + '</div>'
         + '<div class="sp-fig-sub">' + esc(sub) + '</div></div>';
  }

  function paceBar(pace) {
    var pctFill = Math.max(0, Math.min(100, pace.frac * 100));
    var markPct = pace.elapsed == null ? null : Math.max(0, Math.min(100, pace.elapsed * 100));
    var line = markPct == null ? '' :
      '<div class="sp-bar-pace" style="left:' + markPct.toFixed(1) + '%"></div>';
    /* --seg is the hash expressed as a share of the FILL, because the glowing ::after lives
       inside the fill. Only meaningful when the fill has actually passed the hash. */
    var over = markPct != null && pctFill > markPct;
    var seg = over ? Math.max(0, Math.min(100, (markPct / pctFill) * 100)) : 100;
    return '<div class="sp-bar' + (pace.met ? ' is-met' : '') + (over ? ' is-over' : '') + '">'
      +   '<div class="sp-bar-fill" style="width:' + pctFill.toFixed(1) + '%;--seg:' + seg.toFixed(1) + '%"></div>' + line
      + '</div>'
      + '<div class="sp-bar-foot"><span>' + pace.sold.toLocaleString() + ' sold &middot; '
      +   Math.round(pace.frac * 100) + '% of goal</span>'
      + (pace.elapsed == null ? '<span></span>'
          : '<span>pace line &middot; ' + Math.round(pace.elapsed * 100) + '% of the window elapsed</span>')
      + '<span>' + pace.target.toLocaleString() + ' goal</span></div>';
  }

  /* Dates are TEXT (YYYY-MM-DD). Split, never new Date(str) — that parses as UTC and
     renders the day before in our timezone. Same rule as flyer.js. */
  function prettyDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return String(s || '');
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return MON[Number(m[2]) - 1] + ' ' + Number(m[3]);
  }
  function prettyRange(p) {
    if (!p.start_date) return 'no period';
    return prettyDay(p.start_date) + ' → ' + (p.end_date ? prettyDay(p.end_date) : '?');
  }
  /* The same range, but carrying the YEAR — for lists that mix them. prettyRange is used where
     the surrounding card already establishes when the program ran; a flat dropdown of 26
     programs spanning 2025 and 2026 does not, and "Meraki Gardens · Sep 1 → Sep 14" appears
     twice in it with nothing to tell the two apart. */
  function prettyRangeY(p) {
    if (!p.start_date) return 'no dates';
    var y = String(p.end_date || p.start_date).slice(0, 4);
    return prettyDay(p.start_date) + ' → ' + (p.end_date ? prettyDay(p.end_date) : '?') + ', ' + y;
  }
  /* per_unit is REAL and shipped (Hapy Kitchen paid $1/unit) — do not assume flat. */
  /* FLAT IS THE DEFAULT, and anything unrecognized resolves to it. `tiered` is schema'd but
     unimplemented, and a blank or unknown payout_type must not leave the Calculator modeling
     a mode the engine will not honor. */
  function normalModel(v) {
    var m = String(v || '').toLowerCase();
    return m === 'per_unit' ? 'per_unit' : 'flat';
  }

  function payoutLabel(p) {
    var m = (p.payout_json && p.payout_json.model) || 'flat';
    return m === 'per_unit' ? 'per unit' : (m === 'tiered' ? 'tiered' : 'flat per budtender');
  }

  /* What a LIST ROW should show for sold / budtenders-hit.
   *
   * The hero already did this and the row never did: actuals are written at CLOSE-OUT, so a
   * running program has none, and the row rendered 0 sold and "0 / 0" hit while the hero above it
   * — reading the same program from the progress cache — showed 117 sold and 18 hit. Two numbers
   * for one program on one screen, and the smaller one looked like a settled fact.
   *
   * Precedence is by STATUS, not by which source happens to be populated:
   *   • closed  — actual_json WINS. It is the figure that was reconciled and paid; a later cache
   *               refresh must never appear to restate what a vendor was already invoiced.
   *   • running — the cache wins. There is nothing settled to contradict, and the live number is
   *               the entire point of looking.
   * Falls through either way, so a closed program that predates the cache still shows its
   * actuals and a running one with a cold cache still shows a dash rather than a confident 0. */
  function rowTotals(p) {
    var a = p.actual_json, t = p.target_json || {};
    var cache = liveTotals(p.program_id) || cachedTotals(p.program_id, (p.stores_json || []).length);
    var settled = a && a.units_sold != null;

    if (p.status !== 'active' && settled) {
      return { units: a.units_sold || 0, hit: a.bts_hit || 0,
               bts: t.budtenders || 0, live: false };
    }
    if (cache) {
      /* COVERAGE TRAVELS WITH THE FIGURE. The cache is filled one store per call, so it is
         routinely PARTIAL — on 2026-08-29 it held 1 of 6 stores and 110 units for a program that
         had actually sold 3,183. The hero has always said "1 of 6 stores — totals below are
         incomplete"; the row said nothing, so the first cut of this function turned a sixth of a
         program into a confident total. A partial number presented as a whole one is worse than
         the 0 it replaced: the 0 at least looked wrong. */
      var total   = cache.stores || (p.stores_json || []).length || 0;
      var back    = cache.back || 0;
      var partial = total > 0 && back < total;
      /* target_json.budtenders is the PLANNED headcount and is often unset on a running program,
         which is the other half of "0 / 0". The cache knows how many actually sold. */
      return { units: cache.units, hit: cache.hit,
               bts: t.budtenders || cache.bts || 0, live: true,
               partial: partial, back: back, stores: total, at: cache.at || '' };
    }
    if (settled) {
      return { units: a.units_sold || 0, hit: a.bts_hit || 0,
               bts: t.budtenders || 0, live: false };
    }
    return null;                    // nothing to show — the row renders a dash, not a zero
  }

  function listRow(p) {
    var a = p.actual_json, t = p.target_json || {};
    var pay = (p.payout_json && p.payout_json.amount) || 0;
    var tgt = t.units || 0;
    var tot = rowTotals(p);
    var dupe = a && a.duplicate_of && a.duplicate_of.length;
    var rate = a && a.rate_changed;

    var dots = (p.stores_json || []).map(function (sid) {
      return '<span class="sp-dot" style="--dot:' + esc(storeColor(sid)) + '" title="' + esc(storeName(sid)) + '"></span>';
    }).join('');

    /* A live figure and a settled one must not be indistinguishable: one can still move, the
       other is what a vendor was invoiced. The cue is deliberately quiet — a tooltip and a
       hairline — because this column is scanned, not studied.
       A PARTIAL figure gets a louder one. It is not merely provisional, it is arithmetically
       wrong until the rest of the stores land, and it must not be read off the screen. */
    var liveTip = '';
    if (tot && tot.partial) {
      liveTip = ' title="INCOMPLETE — ' + tot.back + ' of ' + tot.stores + ' stores measured'
              + (tot.at ? ', as of ' + esc(shortTime(tot.at)) : '')
              + '. The rest have not been swept yet, so this is lower than the real figure."';
    } else if (tot && tot.live) {
      liveTip = ' title="Live from the progress cache — actuals are recorded at close-out"';
    }
    var sold = '&mdash;';
    if (tot) {
      var d = tot.units - tgt;
      sold = tot.units.toLocaleString()
           + (tgt ? '<span class="sp-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">'
                    + (d > 0 ? '+' : '') + d.toLocaleString() + '</span>' : '');
    }
    var roi = a ? (a.roi >= 0 ? '+' : '') + money(a.roi) : '&mdash;';

    return '<div class="sp-row' + (dupe ? ' is-suspect' : rate ? ' is-flagged' : '')
      + '" data-id="' + esc(p.program_id) + '" tabindex="0" role="button">'
      + '<div><div class="sp-row-name">' + esc(p.program_name || p.title) + '</div>'
      +   '<div class="sp-row-sub">' + esc(p.vendor) + ' &middot; ' + esc(prettyRange(p)) + '</div>'
      +   (dupe ? '<span class="sp-flag is-bad" title="Identical units sold, budtenders hit and investment as '
                  + esc(a.duplicate_of.join(', ')) + ' — likely a copied tab, verify before it reaches a vendor">'
                  + 'actuals match ' + esc(a.duplicate_of.join(', ')) + ' &mdash; verify</span>' : '')
      +   (rate && !dupe ? '<span class="sp-flag is-warn" title="Modelled at ' + money(pay)
                  + ', settled at ' + money(a.spiff_amount) + '">rate ' + money(pay)
                  + ' &rarr; ' + money(a.spiff_amount) + '</span>' : '')
      + '</div>'
      + '<div class="sp-row-dots">' + dots + '</div>'
      + '<div class="sp-num">' + money(pay) + '</div>'
      + '<div class="sp-num' + (tot && tot.live ? ' is-live' : '')
      +   (tot && tot.partial ? ' is-partial' : '') + '"' + liveTip + '>'
      +   sold + (tot && tot.partial ? '<span class="sp-partial-flag">' + tot.back + '/' + tot.stores + '</span>' : '')
      +   '</div>'
      + '<div class="sp-num' + (tot && tot.live ? ' is-live' : '')
      +   (tot && tot.partial ? ' is-partial' : '') + '"' + liveTip + '>'
      +   (tot ? tot.hit + ' / ' + tot.bts : '&mdash;') + '</div>'
      + '<div class="sp-num sp-money ' + (a ? (a.roi >= 0 ? 'is-pos' : 'is-neg') : '') + '">' + roi + '</div>'
      + '<div><span class="sp-chip is-' + esc(p.status) + '">' + esc(p.status) + '</span></div>'
      + shareCell(p)
      + '</div>';
  }

  /* The vendor link, reachable from the row instead of only from the bottom of the record panel.
     It was already built — engine route, gate page, mint/revoke — but the only way to reach it was
     to know it was down there, so in practice nobody did. Sky, 2026-08-29.

     Rendered for editors ONLY, same gate as the record-panel block: minting exposes a program to an
     outside party. `.sp-list` carries can-share so the column collapses entirely for a viewer
     rather than leaving them a dead gutter. */
  function shareCell(p) {
    if (!canEdit()) return '';
    var has = !!p.share_token;
    var noEmail = !String(p.contact_email || '').trim();
    /* A token on a program with no contact_email is a DEAD LINK: clientView_ matches the rep's own
       email against contact_email before it looks at the token, so the vendor gets the same generic
       "does not match" a wrong password gives — no clue that the fault is ours. Say so here rather
       than let a broken link get emailed. */
    var title = noEmail ? 'Set a contact email on this program first — without one the link opens nothing'
              : has     ? 'Copy the vendor link'
                        : 'Create a vendor link';
    return '<div class="sp-row-share">'
      + '<button class="sp-share' + (has ? ' has-link' : '') + (noEmail ? ' is-blocked' : '')
      +   '" data-share="' + esc(p.program_id) + '" title="' + esc(title) + '"'
      +   ' aria-label="' + esc(title) + '">' + (has ? ICON_LINK : ICON_SHARE) + '</button>'
      + '</div>';
  }

  var ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/>'
    + '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/></svg>';
  var ICON_LINK  = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>'
    + '<path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';

  /* Active programs first — they're the ones you can still act on — then newest to
     oldest. Undated records sort last rather than pretending to be old. */
  function sortPrograms(list) {
    var rank = { active: 0, draft: 1, closed: 2 };
    return list.slice().sort(function (a, b) {
      var ra = rank[a.status] != null ? rank[a.status] : 3;
      var rb = rank[b.status] != null ? rank[b.status] : 3;
      if (ra !== rb) return ra - rb;
      if (!a.start_date && !b.start_date) return 0;
      if (!a.start_date) return 1;
      if (!b.start_date) return -1;
      return b.start_date.localeCompare(a.start_date);
    });
  }

  function wirePrograms() {
    /* "+ New program" was inert: the button has been in the markup since Programs was built
       and NO handler was ever attached to it (`git log -S btnNewProgram -- spiff.js` finds
       nothing). Creating a program only ever happened through the Calculator's "Save as
       program", so that is where this goes — with the model cleared, which is the difference
       between "new" and just switching tabs onto whatever was last modelled. */
    var nb = $('#btnNewProgram');
    if (nb) nb.addEventListener('click', newProgram);

    /* ---- sub-nav. Every control re-renders from the SAME loaded set; nothing refetches,
       so filtering is instant and a filter can never lose data. */
    var q = $('#progSearch');
    if (q) q.addEventListener('input', function () {
      progFilter.q = q.value.trim().toLowerCase();
      renderPrograms();
    });

    var scope = $('#progScope');
    if (scope) scope.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-scope]');
      if (!btn) return;
      progFilter.scope = btn.dataset.scope;
      $$('#progScope button').forEach(function (x) { x.classList.toggle('is-on', x === btn); });
      renderPrograms();
    });

    /* Hero + list are re-rendered wholesale, so delegate from the panel, not the nodes. */
    var panel = $('#panel-programs');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var go = e.target.closest('[data-goto]');
        if (go) { e.preventDefault(); showTab(go.dataset.goto); return; }
        /* BEFORE the row handler, and it stops there. The button sits inside a row whose own click
           opens the record, so without this you would copy a link and get the panel over the top
           of the confirmation you were trying to read. */
        var sh = e.target.closest('[data-share]');
        if (sh) { e.preventDefault(); e.stopPropagation(); rowShare(sh); return; }
        var ed = e.target.closest('[data-edit]');
        if (ed) { openRecord(ed.dataset.edit); return; }
        var row = e.target.closest('.sp-row[data-id]');
        if (row) openRecord(row.dataset.id);
      });
      panel.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target.closest('[data-share]')) return;   // the button handles its own activation
        var row = e.target.closest('.sp-row[data-id]');
        if (row) { e.preventDefault(); openRecord(row.dataset.id); }
      });
    }

    var list = $('#programsList');
    if (list) {
      list.addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]');
        if (tr) openRecord(tr.dataset.id);
      });
      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var tr = e.target.closest('tr[data-id]');
        if (tr) { e.preventDefault(); openRecord(tr.dataset.id); }
      });
    }

    $('#recordClose').addEventListener('click', closeRecord);
    $('#recordCancel').addEventListener('click', closeRecord);
    $('#recordBack').addEventListener('click', function (e) { if (e.target.id === 'recordBack') closeRecord(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeRecord(); });
    $('#recordSignIn').addEventListener('click', renderSignIn);
    $('#recordSave').addEventListener('click', saveRecord);
  }

  /* ------------------------------------------------------------- the record */

  // Session lives in sessionStorage, not localStorage: this is a credentialed admin
  // session and the machine may not be Tawny's own.
  function session() {
    try {
      var s = JSON.parse(sessionStorage.getItem('spiff_session') || 'null');
      if (s && s.expiresAt && new Date(s.expiresAt) < new Date()) { clearSession(); return null; }
      return s;
    } catch (e) { return null; }
  }
  function setSession(s) { try { sessionStorage.setItem('spiff_session', JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { sessionStorage.removeItem('spiff_session'); } catch (e) {} }
  function canEdit() {
    var s = session();
    return !!(s && ['admin', 'editor', 'director'].indexOf(s.role) >= 0);
  }

  /* Sign-in belongs in the topbar, reachable from any surface — filing a report from
     Reports shouldn't send you hunting for a program record to sign in from. */
  function renderAuthChip() {
    var b = $('#btnAuth'), slot = $('#userSlot');
    if (!b) return;
    var s = session();
    // Signed OUT: keep the plain Sign in button -- SPIFF is fully readable without a session, so the
    // header must not imply otherwise. Signed IN: the shared avatar+name chip, same as every app.
    b.hidden = !!s;
    if (!slot) return;
    if (!s) { slot.innerHTML = ''; return; }
    var name = s.name || s.user || '';
    // Real avatar when the roster has one; GXAvatar owns the DiceBear rules.
    var ava = window.GXAvatar ? GXAvatar.chip(s.avatar, name) : null;
    var connEl = document.getElementById('conn');
    // Menu built from CONFIG by the shared component -- adding an item later (Settings, when it
    // exists) is one entry here, and it matches every other app automatically.
    // Guarded: the shared scripts come from Pages with a 10-minute cache, so there is always a
    // window where this app has shipped and the shared layer it calls has not arrived yet. An
    // unguarded call throws inside boot() and takes the WHOLE app down over a header detail.
    if (!window.GXTopNav || !GXTopNav.renderUser) {
      // Degrade to the plain Sign in button rather than nothing. Hiding it AND failing to draw the
      // chip leaves the user with no account control at all -- a worse outcome than the old button.
      b.hidden = false; slot.innerHTML = ''; return;
    }
    if (window.GXChangelog) {
      GXChangelog.init({ app: 'spiff', title: 'GX SPIFF', version: APP_VERSION });
    }
    GXTopNav.renderUser(slot, {
      name: name,
      role: s.role || '',
      avatar: ava,
      /* Staff change their own face from the chip (core-admin note, 2026-08-28). Opt-in per app,
         and the row only renders because this object is here — an Avatar row with no way to save
         would be the SPIFF gear all over again.
         No `seed`: the session carries no employee_number, and a name-derived seed is exactly what
         pinning exists to stop mattering. The stored config's own seed wins regardless, so the only
         thing this affects is the preview.
         set_my_avatar takes no ref — the employee is resolved from the session — so this can only
         ever write the caller's own face, which is why it is safe to offer a viewer. */
      avatarEdit: {
        token:  s.token,
        app:    APP,
        client: GX,
        config: s.avatar || null,
        onSaved: function (cfg) {
          /* Write it back to the SESSION, not just the tray. Without this the next renderAuthChip
             — a sign-in state change, a tab switch — repaints from the stale session and the face
             someone just chose reverts in front of them. */
          var cur = session();
          if (cur) { cur.avatar = cfg; setSession(cur); }
          renderAuthChip();
        }
      },
      items: [
        // No action -> a static info row. GX Core status is diagnostic: checked when something looks
        // wrong, not worth a permanent slot in the header.
        { label: connEl ? connEl.textContent.trim() : 'GX Core' },
        { action: 'version', label: 'Version', value: APP_VERSION },
        { action: 'logout',  label: 'Sign out', danger: true }
      ]
    });
    // Keep the status row live: #conn is written to by the app, so refresh the row when the menu opens
    // rather than leaving whatever was true at render time.
    var btn = slot.querySelector('.gx-user-btn');
    if (btn) btn.addEventListener('click', function () {
      var src = document.getElementById('conn');
      var row = slot.querySelector('.gx-user-menu .gx-user-item');
      if (src && row) row.textContent = src.textContent.trim();
    });
  }

  /* The shared header emits gx-topnav:action; what each action MEANS stays here. */
  document.addEventListener('gx-topnav:action', function (e) {
    var a = e.detail && e.detail.action;
    if (a === 'logout') {
      clearSession();
      // Back to the gate: with SPIFF gated, an unauthenticated app shell is not a state to leave a
      // user sitting in.
      location.reload();
    }
    // No 'version' branch: GXTopNav opens the shared release-history popup by default
    // (gx-changelog.js). It used to alert() the number back, which told you nothing you could not
    // already read on the row you clicked — and blocked the page to do it.
  });

  // Delegated from document rather than bound to the button: sign-in is the entry point
  // for every write in the app, so it must not depend on when (or whether) a particular
  // wiring step ran. A direct listener here proved flaky on first click after load.
  function wireAuthChip() {
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#btnAuth')) return;
      if (session()) {
        clearSession();
        renderAuthChip();
        if (state.record) renderRecord(state.record);
        return;
      }
      state.record = null;
      $('#recordTitle').textContent = 'Sign in';
      $('#recordSub').textContent = 'SPIFF records are edited by Tawny and Sky.';
      // The record modal's Close button is redundant beside the corner x on the sign-in view.
      var closeBtn = $('#recordCancel'); if (closeBtn) closeBtn.hidden = true;
      $('#recordMsg').textContent = '';
      $('#recordBack').hidden = false;
      renderSignIn();
    });
  }

  function openRecord(id) {
    var p = state.programs.filter(function (x) { return x.program_id === id; })[0];
    if (!p) return;
    var closeBtn = $('#recordCancel'); if (closeBtn) closeBtn.hidden = false;   // hidden by the sign-in view
    state.record = p;
    $('#recordTitle').textContent = p.program_name || p.title;
    $('#recordSub').textContent = p.vendor + ' · tab "' + p.title + '"' + (p.source ? ' · ' + p.source : '');
    $('#recordMsg').textContent = '';
    renderRecord(p);
    $('#recordBack').hidden = false;
  }

  function closeRecord() {
    $('#recordBack').hidden = true;
    state.record = null;
  }

  function field(label, key, value, type) {
    var ro = canEdit() ? '' : ' readonly';
    return '<label class="fld"><span>' + esc(label) + '</span>'
      + '<input class="gx-input" data-key="' + esc(key) + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + ro + '></label>';
  }

  /* <input type="date"> accepts ONLY yyyy-mm-dd. Hand it anything else and it renders EMPTY —
     silently — and an empty date field then patches the stored value to ''. Three of the 23
     live programs carry non-ISO dates (two blank, one "8/17/26" whose end date is the corrupt
     "8/3026"), so opening those records and pressing Save would have wiped the window a
     closed program was paid against.
     Normalizes what can be normalized; returns null for what cannot, so the caller can show
     the raw value rather than pretend there is none. */
  function toISODate(v) {
    var raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
    if (m) {
      var yy = Number(m[3]);
      var year = m[3].length === 2 ? (yy >= 70 ? 1900 + yy : 2000 + yy) : yy;
      var mo = Number(m[1]), da = Number(m[2]);
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        return year + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
      }
    }
    return null;                       // unparseable — "8/3026" lands here
  }

  /* A date the app DERIVES rather than accepts. Still carries data-key, so collectPatch saves it
     with everything else and there is no second save path to disagree with the first. `readonly`
     rather than `disabled` on purpose: a disabled input is skipped by the collector, which would
     mean picking a pay period changed what the screen showed and nothing that was stored. */
  function roDateField(label, key, value) {
    var iso = toISODate(value);
    return '<label class="sp-fld"><span>' + esc(label) + '</span>'
      + '<input class="sp-in is-derived" data-key="' + esc(key) + '" type="date" value="'
      + esc(iso === null ? '' : iso) + '" readonly tabindex="-1">'
      + (iso === null
          ? '<span class="sp-cost-warn">Stored as &ldquo;' + esc(value) + '&rdquo;, which is not a '
            + 'date this app can read. Pick a pay period above to replace it.</span>'
          : '')
      + '</label>';
  }

  function planCell(label, value) {
    return '<div class="sp-plan-c"><div class="sp-plan-l">' + esc(label) + '</div>'
      + '<div class="sp-plan-v">' + esc(String(value == null ? '—' : value)) + '</div></div>';
  }

  function selField(label, key, value, opts) {
    var ro = canEdit() ? '' : ' disabled';
    return '<label class="sp-fld"><span>' + esc(label) + '</span>'
      + '<select class="sp-in" data-key="' + esc(key) + '"' + ro + '>'
      + opts.map(function (o) {
          return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(value == null ? '' : value) ? ' selected' : '')
            + '>' + esc(o.l) + '</option>';
        }).join('')
      + '</select></label>';
  }

  function recField(label, key, value, type, cls) {
    var ro = canEdit() ? '' : ' readonly';
    return '<label class="sp-fld ' + (cls || '') + '"><span>' + esc(label) + '</span>'
      + '<input class="sp-in ' + (type === 'number' ? 'sp-num-in' : '') + '" data-key="' + esc(key)
      + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : value) + '"' + ro + '></label>';
  }

  function renderRecord(p) {
    var a = p.actual_json || {};
    var warn = '';

    if (a.duplicate_of && a.duplicate_of.length) {
      warn += '<div class="sp-notice is-bad"><span class="sp-notice-l">Actuals look copied</span>'
        + 'Identical units sold, budtenders hit and investment as <b>' + esc(a.duplicate_of.join(', ')) + '</b>. '
        + 'Duplicating a tab copies its typed cells while formulas recalculate, so these numbers may belong to '
        + 'another program. Pull live actuals below, or correct them by hand — the vendor close-out PDF in Drive '
        + 'is the reliable source.</div>';
    }
    if (a.rate_changed) {
      warn += '<div class="sp-notice is-warn"><span class="sp-notice-l">Rate differs</span>'
        + 'Modelled at ' + money(p.payout_json && p.payout_json.amount)
        + ', settled at ' + money(a.spiff_amount) + '.</div>';
    }
    if (!p.contact_email) {
      warn += '<div class="sp-notice is-warn"><span class="sp-notice-l">No contact email</span>'
        + 'A vendor link opens nothing without it &mdash; the rep signs in with their own address.</div>';
    }
    if (p.edited_by) {
      warn += '<div class="sp-notice"><span class="sp-notice-l">Hand-corrected</span>'
        + 'By <b>' + esc(p.edited_by) + '</b> on ' + esc(p.edited_at)
        + '. Re-importing the Calculator will not overwrite this record.</div>';
    }

    /* ── WHEN IT RUNS: PAY PERIODS, NOT FREE DATES ──
       Sky, 2026-08-31: "remove custom dates option, only allow PPs". A SPIFF is settled against
       payroll, so a window that ends mid-period is a program whose payout lands in a fortnight
       nobody can reconcile it to. The dates are now DERIVED from the periods picked and shown
       read-only, rather than typed beside a dropdown that also filled them — two controls for
       one fact, where the looser one silently won.
       TWO selects, not one, because a program may run longer than a fortnight: Buddies ran
       2026-06-22 → 2026-07-19, which is two whole periods. One select could only have expressed
       that by rounding it down to fourteen days. */
    var pps = payPeriodOptions(p.pay_period_start || p.start_date);
    var ppNow = periodIndexOf(today());
    var span = periodSpanOf(p.start_date, p.end_date);
    var offGrid = !!(p.start_date && p.end_date && !span);

    function ppOptsFor(selIdx) {
      var out = pps.map(function (x) {
        var rel = x.index === ppNow ? ' · current' : (x.index > ppNow ? ' · upcoming' : '');
        return { v: String(x.index), l: periodLabel(x) + rel };
      });
      /* A record already off the grid keeps its own dates. Offering only grid rows would make
         the first touch of this control rewrite a closed program's window. */
      if (offGrid) out.unshift({ v: '', l: 'Keep the dates below (does not match a pay period)' });
      if (selIdx !== null && !out.some(function (o) { return o.v === String(selIdx); })) {
        out.push({ v: String(selIdx), l: periodLabel(periodByIndex(selIdx)) });
      }
      return out;
    }
    var fromSel = span ? String(span.from) : (offGrid ? '' : String(ppNow));
    var toSel   = span ? String(span.to)   : (offGrid ? '' : String(ppNow));

    if (offGrid) {
      warn += '<div class="sp-notice is-warn"><span class="sp-notice-l">Window is not a pay period</span>'
        + 'This program runs ' + esc(prettyDay(p.start_date)) + ' → ' + esc(prettyDay(p.end_date))
        + ', which does not line up with payroll. It is kept exactly as it is — new programs are '
        + 'set by pay period. Picking periods below will replace these dates.</div>';
    }

    $('#recordBody').innerHTML = warn
      + '<h4 class="sp-h4">The program</h4>'
      + '<div class="sp-flds">'
      +   recField('Program name', 'program_name', p.program_name, 'text', 'is-wide')
      +   '<div class="sp-fld sp-pick"><span>Vendor</span>'
      +     '<div class="sp-pick-input"><input id="rVendor" autocomplete="off" placeholder="Start typing a brand…"'
      +       (canEdit() ? '' : ' readonly') + ' role="combobox" aria-expanded="false" aria-controls="rVendorMenu"></div>'
      +     '<div class="sp-pick-menu" id="rVendorMenu" role="listbox" hidden></div></div>'
      +   selField('Status', 'status', p.status, [
            { v: 'draft', l: 'Draft — not started' },
            { v: 'active', l: 'Active — running now' },
            { v: 'closed', l: 'Closed — paid out' }
          ])
      + '</div>'

      + '<h4 class="sp-h4">When it runs</h4>'
      + '<div class="sp-flds">'
      +   selField('First pay period', '', fromSel, ppOptsFor(span ? span.from : null))
            .replace('data-key=""', 'id="rPPFrom"')
      +   selField('Last pay period', '', toSel, ppOptsFor(span ? span.to : null))
            .replace('data-key=""', 'id="rPPTo"')
      +   '<span class="sp-fld-note">Pick the same period twice for a normal two-week program. '
      +     'The dates below follow from this — a SPIFF is settled against payroll, so its window '
      +     'is whole pay periods.</span>'
      +   roDateField('Start date', 'start_date', p.start_date)
      +   roDateField('End date', 'end_date', p.end_date)
      + '</div>'

      /* THE PLAN IS READ-ONLY HERE, and that is the point of the split. Everything below was
         a flatter, worse copy of the Calculator: one target box against its per-store table,
         one cost box against a picker that sources cost from Dutchie, no reference pull, no
         scales panel. Two editors for one set of numbers means two answers to "what is this
         program", and the weaker one wins whenever it is the one someone happens to open.
         So this states the plan and hands off; identity, dates, contact and actuals — the
         things the Calculator has no view of — stay editable right here. */
      + '<div class="sp-h4-row"><h4 class="sp-h4">The plan</h4>'
      +   '<span class="sp-h4-note">modelled in the Calculator</span>'
      +   (canEdit()
            ? '<button type="button" class="gx-btn" id="rEditParams" style="margin-left:auto">Edit parameters &rarr;</button>'
            : '')
      + '</div>'
      + '<div class="sp-plan">'
      +   planCell('Featured product', p.match_json && (p.match_json.filter_text || (p.match_json.products || []).join(', '))
                   ? ((p.match_json.brand ? p.match_json.brand + ' · ' : '')
                      + (p.match_json.filter_text || (p.match_json.products || []).join(', ')))
                   : '— not set —')
      +   planCell('Payout', money((p.payout_json || {}).amount) + ' ' + payoutLabel(p))
      +   planCell('Cost per unit', money((p.cost_json || {}).per_unit))
      +   planCell('Target units', ((p.target_json || {}).units || 0).toLocaleString())
      +   planCell('Last month units', ((p.baseline_json || {}).units || 0).toLocaleString())
      +   planCell('Budtenders', (p.target_json || {}).budtenders || '—')
      + '</div>'

      + '<h4 class="sp-h4">Contact</h4>'
      + '<div class="sp-flds">'
      +   recField('Vendor contact', 'contact_name', p.contact_name)
      +   recField('Contact email', 'contact_email', p.contact_email)
      + '</div>'

      + '<div class="sp-h4-row"><h4 class="sp-h4">Actuals</h4>'
      +   '<span class="sp-h4-note" id="rActualsNote">what was really sold in the window above</span>'
      +   '<button type="button" class="gx-btn" id="rPullActuals" style="margin-left:auto">Pull live from Dutchie</button>'
      + '</div>'
      + '<div class="sp-flds" id="rActuals">'
      +   recField('Units sold', 'actual_json.units_sold', a.units_sold, 'number')
      +   recField('Budtenders hitting goal', 'actual_json.bts_hit', a.bts_hit, 'number')
      +   recField('Rate paid', 'actual_json.spiff_amount', a.spiff_amount, 'number')
      +   recField('Investment', 'actual_json.investment', a.investment, 'number')
      +   recField('ROI $', 'actual_json.roi', a.roi, 'number')
      +   recField('ROI % (decimal)', 'actual_json.roi_pct', a.roi_pct, 'number')
      + '</div>';

    /* Vendor still autocompletes here — it is identity, not modeling, and a program filed
       under a brand we do not carry is a data problem this screen owns. */
    recPicker = mountPicker({
      vendor: '#rVendor', vendorMenu: '#rVendorMenu'
    });
    /* Show the vendor this program is already filed under. Without this the field reads as a
       blank waiting for input, which invites retyping a value that is already correct — and a
       vendor typed slightly differently is a program that no longer groups with its own history. */
    if (recPicker) recPicker.setVendorSilently(p.vendor || '');

    /* The saved match travels in a hidden field so collectPatch picks it up with everything
       else, instead of needing its own save path that could disagree about what changed. */
    $('#recordBody').insertAdjacentHTML('beforeend',
      '<input type="hidden" data-key="match_json" value="' + esc(JSON.stringify(p.match_json || {})) + '">');

    /* The two period selects drive the dates, and keep themselves in order: picking a LAST
       period before the first would describe a window that ends before it begins, and the
       engine would happily store it. Whichever one the user just moved is the one respected;
       the other follows. */
    var ppFrom = $('#rPPFrom'), ppTo = $('#rPPTo');
    function syncPeriodDates(moved) {
      if (!ppFrom || !ppTo) return;
      if (ppFrom.value === '' || ppTo.value === '') return;   // "keep the dates" on a legacy row
      var a = Number(ppFrom.value), b = Number(ppTo.value);
      if (b < a) { if (moved === 'from') { ppTo.value = String(a); b = a; }
                   else { ppFrom.value = String(b); a = b; } }
      $('#recordBody [data-key="start_date"]').value = periodByIndex(a).start;
      $('#recordBody [data-key="end_date"]').value   = periodByIndex(b).end;
    }
    if (ppFrom) ppFrom.addEventListener('change', function () { syncPeriodDates('from'); });
    if (ppTo)   ppTo.addEventListener('change', function () { syncPeriodDates('to'); });

    var pull = $('#rPullActuals');
    if (pull) pull.addEventListener('click', function () { pullActuals(p, pull); });

    var toCalc = $('#rEditParams');
    if (toCalc) toCalc.addEventListener('click', function () { openInCalculator(p); });

    // Minting a vendor link exposes this program to an outside party, so it sits behind
    // the same role gate as editing and says plainly what it does.
    if (canEdit()) {
      $('#recordBody').insertAdjacentHTML('beforeend',
        '<h4>Vendor link</h4>'
        + '<p class="hint">A read-only page showing only this program. To open it they enter '
        + '<b>their own email</b> and the shared password — so set the contact email above first, '
        + 'or the link opens nothing.</p>'
        + '<div class="share-row">'
        +   '<button class="gx-btn" id="btnShare">' + (p.share_token ? 'Copy vendor link' : 'Create vendor link') + '</button>'
        +   (p.share_token ? '<button class="gx-btn" id="btnRevoke">Revoke</button>' : '')
        +   '<input class="gx-input" id="shareUrl" readonly hidden>'
        + '</div>');
      $('#btnShare').addEventListener('click', function () { makeShare(p, this); });
      if (p.share_token) $('#btnRevoke').addEventListener('click', function () { revokeShare(p, this); });
    }

    var s = session();
    $('#recordSave').hidden   = !canEdit();
    $('#recordSignIn').hidden = canEdit();
    $('#recordMsg').textContent = s
      ? 'Signed in as ' + s.user + (canEdit() ? ' (' + s.role + ')' : ' — role ' + s.role + ' cannot edit')
      : 'Read-only. Sign in to correct this record.';
  }

  function clientUrl(tok) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'client.html?t=' + tok;
  }

  /* Copy that works when execCommand does not. The record panel could lean on a visible <input> to
     select; a row has none, and a hidden one is not selectable in every browser. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through — a denied permission is not a reason to give up */ }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /* Row-level share. Mints on first use and copies every time, so one control does the whole job —
     there is no second click to hunt for, which was the point of moving this out of the panel.
     Revoking stays in the record panel: it is destructive and belongs where the program is open in
     front of you, not one stray click from a list. */
  async function rowShare(btn) {
    var id = btn.dataset.share;
    var p  = (state.programs || []).filter(function (x) { return x.program_id === id; })[0];
    if (!p) return;

    if (!String(p.contact_email || '').trim()) {
      /* Refuses rather than minting a link that cannot open. Opens the record on the program so the
         missing field is in front of them, instead of an error they have to act on from memory. */
      flashShare(btn, 'Needs a contact email', false);
      setTimeout(function () { openRecord(id); }, 900);
      return;
    }

    btn.disabled = true;
    try {
      var tok = p.share_token;
      if (!tok) {
        var r = await ENG.jsonp('shareLink', { token: (session() || {}).token, id: p.program_id });
        if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
        tok = r.token;
        p.share_token = tok;
        btn.classList.add('has-link');
        btn.innerHTML = ICON_LINK;
      }
      flashShare(btn, await copyText(clientUrl(tok)) ? 'Link copied' : 'Link ready', true);
    } catch (err) {
      console.error('[spiff] share failed:', err);
      flashShare(btn, 'Failed — try the record panel', false);
    }
    btn.disabled = false;
  }

  /* A row has nowhere to put a message, so the confirmation rides on the button itself and clears
     itself. Silence after a copy reads as a no-op, and the user clicks again. */
  function flashShare(btn, msg, good) {
    var cell = btn.parentNode;
    var old  = cell.querySelector('.sp-share-msg');
    if (old) old.remove();
    var tip = document.createElement('span');
    tip.className = 'sp-share-msg' + (good ? '' : ' is-bad');
    tip.textContent = msg;
    cell.appendChild(tip);
    setTimeout(function () { if (tip.parentNode) tip.remove(); }, 2600);
  }

  async function makeShare(p, btn) {
    btn.disabled = true;
    try {
      var r = await ENG.jsonp('shareLink', { token: (session() || {}).token, id: p.program_id });
      if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
      p.share_token = r.token;
      var box = $('#shareUrl');
      box.hidden = false;
      box.value = clientUrl(r.token);
      box.select();
      try { document.execCommand('copy'); btn.textContent = 'Link copied'; }
      catch (e) { btn.textContent = 'Link ready — copy it'; }
    } catch (err) {
      btn.textContent = 'Failed: ' + (err.message || err);
    }
    btn.disabled = false;
  }

  async function revokeShare(p, btn) {
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    try {
      var r = await ENG.jsonp('shareLink', { token: (session() || {}).token, id: p.program_id, revoke: '1' });
      if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
      p.share_token = '';
      btn.textContent = 'Revoked';
      var box = $('#shareUrl'); if (box) { box.hidden = true; box.value = ''; }
      $('#btnShare').textContent = 'Create vendor link';
    } catch (err) {
      btn.textContent = 'Failed';
      console.error('[spiff] revoke failed:', err);
    }
    btn.disabled = false;
  }

  // Credentials go to GX Core, which owns sign-on; SPIFF never stores a password.
  function renderSignIn() {
    $('#recordBody').innerHTML =
      // No explanatory paragraph: the modal header (#recordSub) already says exactly this and the body
      // was repeating it word for word. Fields use the shared .gx-login-field/.gx-input so this reads
      // as the same sign-in as every other app rather than a third treatment.
      '<div class="signin">'
      + '<label class="gx-login-field"><span>User</span>'
      +   '<input class="gx-input" id="siUser" autocomplete="username"></label>'
      + '<label class="gx-login-field"><span>Password</span>'
      +   '<input class="gx-input" id="siPass" type="password" autocomplete="current-password"></label>'
      + '<button class="gx-btn gx-btn-green gx-login-submit" id="siGo">Sign in</button>'
      + '</div>';
    $('#recordSave').hidden = true;
    $('#recordSignIn').hidden = true;
    $('#siGo').addEventListener('click', doSignIn);
    $('#siPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
    $('#siUser').focus();
  }

  async function doSignIn() {
    var user = $('#siUser').value.trim();
    var pass = $('#siPass').value;
    if (!user || !pass) { $('#recordMsg').textContent = 'Enter your user and password.'; return; }
    $('#recordMsg').textContent = 'Signing in…';
    try {
      var r = await GX.jsonp('login', { user: user, pass: pass, app: APP });
      // Same `code` contract as the full-page gate, but NOT the same treatment: this modal is
      // reached from an app the user is already reading, so a full-page takeover would be a
      // worse answer than a plain sentence. Say the true thing and leave them where they are.
      if (r && r.code === 'no_access') {
        $('#recordMsg').textContent = 'Your account does not have access to SPIFF. Ask Sky to grant it.';
        return;
      }
      if (!r || !r.ok) throw new Error((r && r.error) || 'Sign-in failed');
      // r.user is the SLUG ('sky'); r.displayName is the person's name, and avatarConfig is their
      // roster avatar. The chip showed the slug and bare initials because neither was stored.
      setSession({ user: r.user, name: r.displayName || r.user, avatar: r.avatarConfig || null,
                   role: r.role, token: r.token, expiresAt: r.expiresAt });
      $('#recordMsg').textContent = '';
      renderAuthChip();
      if (state.record) renderRecord(state.record);
      else { closeRecord(); if (state.tab === 'reports') renderReport(); }
    } catch (err) {
      $('#recordMsg').textContent = String(err.message || err);
    }
  }

  // Collect only what actually changed, so an edit to one field can't silently rewrite
  // the rest of the record.
  function collectPatch(p) {
    var patch = Object.create(null), nested = Object.create(null);
    $$('#recordBody [data-key]').forEach(function (el) {
      var key = el.dataset.key, raw = el.value.trim();
      var val = el.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
      var parts = key.split('.');
      /* match_json travels as a JSON STRING in a hidden input so it rides the same collector as
         everything else. It needs parsing back to an object, and comparing STRUCTURALLY — the
         default comparison stringifies the stored object to "[object Object]", which never
         equals the JSON text, so the field would be reported dirty on every save and overwrite
         a hand-tuned filter with itself. */
      if (key === 'match_json') {
        var parsed;
        try { parsed = JSON.parse(raw || '{}'); } catch (e) { return; }
        if (JSON.stringify(parsed) !== JSON.stringify(p.match_json || {})) patch.match_json = parsed;
        return;
      }
      /* Never turn a date that HAD a value into an empty one. The dates are derived from the
         pay-period selects now, so a blank here means one of them was never resolved — not that anyone
         chose to clear it, and the difference is a closed program's payout window. */
      if ((key === 'start_date' || key === 'end_date') && raw === '' && p[key]) return;
      if (parts.length === 1) {
        if (String(p[key] == null ? '' : p[key]) !== String(raw)) patch[key] = val;
      } else {
        var obj = nested[parts[0]] || (nested[parts[0]] = Object.assign({}, p[parts[0]] || {}));
        obj[parts[1]] = val;
      }
    });
    Object.keys(nested).forEach(function (k) {
      // A draft with no actuals leaves those inputs blank — don't turn that into an
      // actuals object full of nulls.
      var empty = Object.keys(nested[k]).every(function (f) {
        return nested[k][f] === null || nested[k][f] === '';
      });
      if (empty && !p[k]) return;
      if (JSON.stringify(nested[k]) !== JSON.stringify(p[k] || {})) patch[k] = nested[k];
    });
    return patch;
  }

  function matchOf(chosen) {
    return chosen
      ? { brand: chosen.brand || '', category: '', filter_text: chosen.filter_text || '',
          products: chosen.products || [] }
      : { brand: '', category: '', filter_text: '', products: [] };
  }

  /* Live actuals. Fans out one sell-through request per store over the program's OWN window and
     aggregates — the same route Progress uses, so the two can never disagree about what a
     program sold. Fills the fields rather than saving: these numbers go to a vendor, so a human
     reads them before they are committed. */
  async function pullActuals(p, btn) {
    var stores = p.stores_json || [];
    var from = ($('#recordBody [data-key="start_date"]') || {}).value || p.start_date;
    var to   = ($('#recordBody [data-key="end_date"]')   || {}).value || p.end_date;
    var note = $('#rActualsNote');
    if (!from || !to) { note.textContent = 'set a start and end date first'; return; }
    if (!stores.length) { note.textContent = 'this program has no stores'; return; }

    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Pulling…';
    $('#rActuals').classList.add('is-busy');

    var windows = dateWindows(from, to, PROGRESS_WINDOW_DAYS);
    var got = 0, failed = [];
    var units = 0, hit = 0, bts = 0;

    await Promise.all(stores.map(async function (st) {
      try {
        var r = await pullStore(p.program_id, st, windows, null);
        units += r.units; hit += r.hit; bts += r.budtenders;
        got++;
        note.textContent = 'pulled ' + got + ' of ' + stores.length + ' stores…';
      } catch (e) { failed.push(storeName(st)); }
    }));

    $('#rActuals').classList.remove('is-busy');
    btn.disabled = false; btn.textContent = label;

    if (!got) {
      note.innerHTML = '<span style="color:var(--gx-red)">nothing came back &mdash; fields left alone</span>';
      return;
    }

    var rate   = Number(($('#recordBody [data-key="payout_json.amount"]') || {}).value) || 0;
    var cost   = Number(($('#recordBody [data-key="cost_json.per_unit"]') || {}).value) || 0;
    var base   = Number(($('#recordBody [data-key="baseline_json.units"]') || {}).value) || 0;
    var invest = rate * hit;                        // paid only on budtenders who actually hit
    var roi    = (units - base) * cost - invest;    // same identity the Calculator models on

    setRecField('actual_json.units_sold', units);
    setRecField('actual_json.bts_hit', hit);
    setRecField('actual_json.spiff_amount', rate);
    setRecField('actual_json.investment', Math.round(invest * 100) / 100);
    setRecField('actual_json.roi', Math.round(roi * 100) / 100);
    setRecField('actual_json.roi_pct', invest ? Math.round((roi / invest) * 10000) / 10000 : 0);

    /* Says WHAT IT COVERS, always. A partial pull that reports a total without naming the gap
       is how a vendor gets invoiced against four stores' sales as though it were six. */
    note.innerHTML = 'pulled ' + prettyDay(from) + ' → ' + prettyDay(to)
      + ' · ' + got + ' of ' + stores.length + ' stores · ' + bts + ' budtenders'
      + (failed.length
          ? ' · <span style="color:var(--gx-red)">missing ' + esc(failed.join(', '))
            + ' — these totals undercount</span>'
          : '')
      + ' · nothing saved until you press Save changes';
  }

  function setRecField(key, v) {
    var el = $('#recordBody [data-key="' + key + '"]');
    if (!el) return;
    el.value = v;
    el.classList.remove('sp-changed');
    void el.offsetWidth;
    el.classList.add('sp-changed');
  }

  async function saveRecord() {
    var p = state.record;
    if (!p) return;
    var patch = collectPatch(p);
    if (!Object.keys(patch).length) { $('#recordMsg').textContent = 'Nothing changed.'; return; }

    $('#recordMsg').textContent = 'Saving…';
    try {
      var r = await ENG.jsonp('editProgram', {
        token: (session() || {}).token, id: p.program_id, patch: JSON.stringify(patch)
      });
      if (!r || !r.ok) {
        if (r && r.needsAuth) { clearSession(); renderSignIn(); }
        throw new Error((r && r.error) || 'Save failed');
      }
      $('#recordMsg').textContent = 'Saved (' + (r.changed || []).join(', ') + ')';
      await loadPrograms();
      renderPrograms();
      renderHistory();
      /* Close on success, per Sky. The modal staying open after a save invites a second press
         of a button that now has nothing to do, and leaves the list underneath looking stale
         even though it has already been refreshed. Brief pause so the confirmation is readable
         rather than a flash. */
      setTimeout(closeRecord, 550);
    } catch (err) {
      $('#recordMsg').textContent = String(err.message || err);
    }
  }

  /* --------------------------------------------------------- the calculator
   *
   * The vendor ROI model — a sales tool as much as a form. Every formula here is the
   * Calculator sheet's, verified against the imported programs:
   *
   *   revenue        = units × cost per unit        (the vendor's take, as the sheet means it)
   *   investment     = SPIFF × budtenders
   *   ROI $          = revenue increase − investment      ← identity holds on all 22 programs
   *   ROI %          = ROI $ / investment
   *   store target   = round(store baseline × targetUnits / baselineUnits)
   *   per-budtender  = round(that store's figure / its budtenders)
   *
   * Budtenders default to an even split across participating stores, which is what the
   * sheet assumes; it reproduces 109 of 125 historical per-budtender targets. The 16
   * misses are stores that don't staff evenly, so each store's count is editable. The
   * roster would settle it, but GX Core exposes no public `employees` action — the
   * engine will have to read it through the GXCore library.
   */

  var calc = {
    name: '', vendor: '', cost: 10, spiff: 25, target: 0,
    model: 'flat',   // 'flat' | 'per_unit' — per_unit is real; see payoutLabel/CLAUDE.md
    editingId: null, // set when the Calculator is updating an EXISTING program, not modeling a new one
    window: null,    // that program's dates, carried for display only — the record owns them
    product: null,   // {label, brand, filter_text, products[], skus, qty} — the SPIFF's subject
    refRun: null,    // identity of the in-flight reference pull, so a stale one can be dropped
    stores: []       // [{ store_id, name, baseline, bts, refState, refUnits }]
  };

  /* ── HOW MANY BUDTENDERS DID THIS STORE HAVE? ─────────────────────────────────────────────
     Three sources, best first, because the good one only exists on programs saved since
     2026-09-01.

       1. What was SAVED. Exact, and the only one that is not an inference.
       2. Derived from the program's own goal: a store goal IS per_bt x headcount by construction,
          so dividing them back gives the headcount exactly. Available on every historical row.
       3. Derived from LAST MONTH's pair — which is what this used to do, alone, and it is wrong
          often enough to matter. Both of those numbers were rounded before they were stored, so
          a store with 9 units across 6 people stored per_bt 2 (1.5 rounded), and 9/2 reconstructs
          5 people. Everything downstream then re-derived off a headcount nobody had.

     Falls back to 6 only when there is nothing at all to read. */
  function btsForStore(id, tgt, base) {
    var saved = (tgt.bts_by_store || {})[id];
    if (saved > 0) return Math.max(1, Math.round(Number(saved)));

    var goal = Number((tgt.by_store || {})[id] || 0);
    var tPer = Number((tgt.per_bt   || {})[id] || 0);
    if (goal > 0 && tPer > 0) return Math.max(1, Math.round(goal / tPer));

    var b    = Number((base.by_store || {})[id] || 0);
    var bPer = Number((base.per_bt   || {})[id] || 0);
    if (b > 0 && bPer > 0) return Math.max(1, Math.round(b / bPer));

    return 6;
  }

  /* No participation flag any more. Every store runs every program, so the old tick-box was a
     control nobody used -- and it let a store be silently dropped from the model while its row
     stayed visible. Stores come from the GX Core registry; a seventh appears on its own. */
  function calcInit() {
    if (calc.stores.length || !state.stores.length) return;
    calc.stores = state.stores.map(function (s) {
      /* perBtSet null = this store tracks the typed target. A number pins it — see calcModel. */
      return { store_id: s.store_id, name: s.display_name || s.store_id, baseline: 0, bts: 6,
               perBtSet: null };
    });
    recalc();
  }

  function calcModel() {
    var on = calc.stores;
    var baseUnits = on.reduce(function (n, s) { return n + (Number(s.baseline) || 0); }, 0);
    var bts       = on.reduce(function (n, s) { return n + (Number(s.bts) || 0); }, 0);
    var target    = Number(calc.target) || 0;
    var cost      = Number(calc.cost) || 0;
    var ratio     = baseUnits ? target / baseUnits : 0;

    /* THE PER-BUDTENDER GOAL IS THE PRIMITIVE, NOT THE STORE TOTAL. A budtender is told one
       whole number; nobody is asked to sell 8.83 units. So the store's goal is that number
       times its headcount, and the chain's ask is the sum of the stores'.
       Deriving it the other way round -- store total first, per-BT by division -- is what put
       "goal 53 · 6 BTs · 9 each" on a row in front of a vendor: three numbers that do not
       multiply, because 53/6 rounds up to 9 and 9x6 is 54. Reported by Sky 2026-08-31.
       `ratio` still comes from the TYPED target: that is the key the ask is split by. What
       comes back out is what the split actually adds up to. */
    var plan = on.map(function (st) {
      var b = Number(st.baseline) || 0;
      var n = Number(st.bts) || 0;
      var want = b * ratio;
      /* THE PER-BT GOAL IS OVERRIDABLE, per store (Sky, 2026-08-31: "so Tawny can fine tune as
         needed, ie tune down commercial and tune up another store"). The split by last month's
         volume is a starting point, not an answer — a store mid-remodel, or one that just took
         on three new budtenders, gets a number its people can actually reach, and the chain
         total follows from the stores rather than the other way round.
         null means "no override": the store tracks the typed target like it always did, so
         moving the target still moves every store that has not been pinned. */
      var over = st.perBtSet;
      var pinned = over != null && over !== '';
      var perBt = pinned ? Math.max(0, Math.round(Number(over) || 0)) : (n ? Math.round(want / n) : 0);
      return {
        store_id: st.store_id, name: st.name, base: b, n: n,
        perBt:  n ? perBt : null,
        pinned: pinned && n > 0,
        /* No budtenders at a store is not a goal of zero -- the store still has to sell it.
           Fall back to its unrounded share so the chain total does not silently lose it. */
        goal:   n ? perBt * n : Math.round(want),
        perNow: n ? Math.round(b / n) : null
      };
    });
    var goalUnits = plan.reduce(function (t, r) { return t + r.goal; }, 0);

    var baseRev   = baseUnits * cost;
    /* Everything downstream prices goalUnits, never the typed target: the money argued in
       front of a vendor has to be the money for the goal we are actually going to set. */
    var targetRev = goalUnits * cost;
    var revInc    = targetRev - baseRev;
    /* What the vendor funds AT MOST. Flat pays a bounty per budtender who hits; per_unit pays
       on every unit sold, so its ceiling scales with the target instead of the headcount. */
    var invest    = calc.model === 'per_unit'
      ? (Number(calc.spiff) || 0) * goalUnits
      : (Number(calc.spiff) || 0) * bts;

    return {
      on: on, baseUnits: baseUnits, bts: bts, ratio: ratio,
      plan: plan, goalUnits: goalUnits, typed: target,
      baseRev: baseRev, targetRev: targetRev,
      unitInc: goalUnits - baseUnits,
      revInc: revInc,
      growth: baseUnits ? (goalUnits - baseUnits) / baseUnits : 0,
      /* The growth the CONTROLS echo, which is the typed one. Feeding them the reconciled
         figure instead would nudge the thumb a point on every release -- a control moving
         itself after the drag ended, and the number Tawny set quietly rewritten. */
      typedGrowth: baseUnits ? (target - baseUnits) / baseUnits : 0,
      invest: invest,
      roi: revInc - invest,
      roiPct: invest ? (revInc - invest) / invest : 0
    };
  }

  /* "It scales with success" — the panel the Calculator never had.
     ASSUMPTION, stated because it is not derivable from the sheet: a budtender who hits
     contributes their full goal, one who misses contributes their reference. That is the only
     reading that invents no behavior -- any smoother curve would be a number we made up and
     then showed to a vendor. Everything else here follows from it arithmetically. */
  function scaleRows(m) {
    var bts = m.bts;
    if (!bts || !m.baseUnits) return [];
    var perBtRef  = m.baseUnits / bts;
    var perBtGoal = m.goalUnits / bts;
    var cost = Number(calc.cost) || 0;
    var steps = [bts, Math.round(bts * .75), Math.round(bts * .5), Math.round(bts * .2), 0];
    var seen = {};
    return steps.filter(function (n) {
      if (n < 0 || seen[n]) return false; seen[n] = 1; return true;
    }).map(function (hit) {
      var units = hit * perBtGoal + (bts - hit) * perBtRef;
      var funds = calc.model === 'per_unit'
        ? (Number(calc.spiff) || 0) * units
        : (Number(calc.spiff) || 0) * hit;
      var gain  = (units - m.baseUnits) * cost;
      return {
        hit: hit, label: hit === bts ? 'All ' + bts : (hit === 0 ? 'Nobody' : hit + ' of ' + bts),
        funds: funds, units: Math.round(units),
        net: Math.round(gain - funds),
        ret: funds ? (gain - funds) / funds : null
      };
    });
  }

  /* How many stores are still answering. Every figure below the picker is derived from the
     reference total, so while ANY store is outstanding the whole lower half of the screen is
     showing arithmetic on an incomplete base. */
  function refPending() {
    return calc.stores.filter(function (st) { return st.refState === 'loading'; }).length;
  }
  /* Counted separately from pending, because a store that ANSWERED WITH A REFUSAL is not slow,
     it is missing -- and six of them is not six retries to click, it is one outage to name. */
  function refFailed() {
    return calc.stores.filter(function (st) { return st.refState === 'error'; }).length;
  }

  function recalc(changedIds) {
    var m = calcModel();
    var pending = refPending();

    /* ---- stat strip. Only the ROI card is tinted; it is the figure being argued for. */
    /* NOTHING TO COMPUTE FROM IS NOT A RESULT OF ZERO. With no product picked there is no
       last-month figure, so revenue increase, return and unit lift have no basis — and the
       arithmetic still produced confident numbers: a fresh Calculator was announcing
       "Your return −100%" and "Break-even 90 units" off a budtender count that is only a
       per-store default of 6. On a screen that gets turned around to face a vendor, that is
       worse than blank. An em dash says "not yet"; −100% says "this deal loses money". */
    var hasBase = m.baseUnits > 0;
    var hasAsk  = hasBase && (Number(calc.target) || 0) > 0;

    var stats = $('#calcStats');
    if (stats) stats.innerHTML =
        cstat('You fund, at most', hasAsk ? money(m.invest) : '—',
              !hasAsk ? 'set a product and a target first'
                : calc.model === 'per_unit'
                  ? money(calc.spiff) + ' on each of ' + m.goalUnits.toLocaleString() + ' units'
                  : 'only if all ' + m.bts + ' reach their target', '')
      + cstat('Your revenue increase', hasAsk ? money(m.revInc) : '—',
              hasAsk ? money(m.baseRev) + ' → ' + money(m.targetRev) : 'needs last month and a target', '')
      + cstat('Your return', hasAsk && m.invest ? pctWhole(m.roiPct) : '—',
              hasAsk ? money(m.roi) + ' net of the bounty' : 'once there is an ask to price',
              !hasAsk ? '' : m.roi < 0 ? 'is-neg' : 'is-hero')
      /* Unit lift needs an ASK, not just a base — the same rule as the three cards beside it,
         which it was left out of. A product pulled with no target yet leaves the model's target
         at 0, so this card read −100.0% over last month under a headline of −1,000: the app
         telling a vendor their product had stopped selling outright, when in fact nothing had
         been asked for yet. Zero is not a target, and an em dash says "not yet". */
      + cstat('Unit lift', hasAsk ? (m.unitInc > 0 ? '+' : '') + m.unitInc.toLocaleString() : '—',
              hasAsk ? pct(m.growth) + ' over last month'
                : hasBase ? 'set a target to see the lift' : 'pick a product to pull last month', '');

    /* ---- the goal bar, which is also the goal CONTROL.
       The track is a units axis: 0 .. lastMonth × (1 + GOAL_MAX). That makes the dark segment
       (what the stores already sell) a fixed share of the track and the bright segment the ask,
       so dragging right is literally "ask for more".
       Updated by SETTING STYLES, never innerHTML — rebuilding this node would destroy the range
       input inside it, and with it the drag in progress. */
    var base = $('#cGoalBase'), add = $('#cGoalAdd'), range = $('#cGoalRange'), foot = $('#cGoalFoot');
    if (base && add && range) {
      var span = m.baseUnits * (1 + GOAL_MAX / 100);
      var basePct = span ? (m.baseUnits / span) * 100 : 0;
      var tgtPct  = span ? Math.max(0, Math.min(100, (m.typed / span) * 100)) : 0;
      base.style.width = basePct.toFixed(2) + '%';
      add.style.left   = basePct.toFixed(2) + '%';
      add.style.width  = Math.max(0, tgtPct - basePct).toFixed(2) + '%';
      /* THE SLIDER SPANS ONLY THE GROWTH REGION — it starts at the right edge of existing
         sales and runs to the end of the track. A native range thumb travels its element's
         full width, so sizing the element to the growth region is what puts 0% exactly on
         the boundary and makes negative growth unreachable: min=0 IS the base edge. Laying
         it across the whole bar instead would park "no growth" at the far left, implying
         the stores sell nothing, and let a drag left ask a vendor to fund a decline. */
      range.style.left = basePct.toFixed(2) + '%';
      range.style.width = Math.max(0, 100 - basePct).toFixed(2) + '%';
      /* No reference yet means nothing to grow FROM: a slider off a base of zero produces a
         goal of zero however far it is dragged, which reads as a broken control. */
      /* Disabled while the pull is in flight as well as when there is no base at all: dragging
         against a total that is still growing sets a target off a number that no longer exists
         by the time the drag ends. */
      var live = m.baseUnits > 0 && !pending;
      range.disabled = !live;
      $('#cGoalBar').classList.toggle('is-off', !live);
      /* Target units, Growth % and the slider are three views of ONE number, so recalc is where
         they are reconciled — otherwise each stays right only on the path that happens to write
         it, and the screen shows a 1,330 target next to 0% growth. Neither the field being typed
         in nor a thumb mid-drag is overwritten: correcting a control while someone is using it
         is worse than letting it lag by a keystroke. */
      var gEl = $('#cGrowth');
      if (gEl && document.activeElement !== gEl) gEl.value = live ? Math.round(m.typedGrowth * 100) : 0;
      if (!draggingGoal) range.value = Math.max(0, Math.min(GOAL_MAX, Math.round(m.typedGrowth * 100)));
      /* Three states, not two. `live` folds "no base" together with "still loading", and using
         it for the caption told someone who had just picked a product to go and pick one. */
      /* A target BELOW last month is a real state and it is said out loud, not clamped away.
         It happens the moment a fresh pull lands: a program saved against an older, smaller
         reference now asks for less than the product already sells. The slider cannot show it
         (min is 0), so the first drag silently "fixes" it to 0% — which is how a program gets
         re-pitched at a number nobody decided on. Naming it is the difference between Tawny
         choosing a new target and the app choosing one for her. */
      /* And a target of ZERO is not a target below last month — it is no target. Without the
         second test this fired the gold warning the instant a product was pulled, telling Tawny
         her ask was 1,000 units short of a number she had not chosen yet. */
      var below = m.baseUnits > 0 && (Number(calc.target) || 0) > 0 && m.unitInc < 0;
      /* WHERE THE TWO NUMBERS ARE RECONCILED. The field above holds what Tawny asked for;
         the table below totals what whole budtender goals actually come to. They differ by a
         few units whenever the split does not divide evenly, and every figure on the screen
         prices the second one -- so it is said here, once, rather than left as two totals a
         vendor can spot and nobody can explain. */
      var drift = m.baseUnits > 0 && m.typed > 0 && m.goalUnits !== m.typed
        ? '<span>goal lands at ' + m.goalUnits.toLocaleString() + ' &mdash; whole budtender goals, '
          + (m.goalUnits > m.typed ? '+' : '&minus;') + Math.abs(m.goalUnits - m.typed) + '</span>'
        : '';
      foot.innerHTML = '<span>' + m.baseUnits.toLocaleString() + ' sold last month</span>' + drift
        + (pending
            ? '<span>waiting on Dutchie&hellip;</span>'
            : below
              ? '<span style="color:var(--gx-gold)">target is ' + Math.abs(m.unitInc).toLocaleString()
                + ' BELOW last month &mdash; set a new one</span>'
              : m.baseUnits > 0
                ? '<span class="is-add">' + (m.unitInc > 0 ? '+' + m.unitInc.toLocaleString() + ' asked for' : 'no increase asked') + '</span>'
                : '<span>pick a product to pull it</span>');
    }

    /* ---- scales-with-success */
    var scale = $('#calcScale');
    if (scale) {
      var rows = scaleRows(m);
      scale.innerHTML = rows.length
        ? '<table class="sp-tbl"><thead><tr><th>Budtenders who hit</th><th class="num">You fund</th>'
          + '<th class="num">Units that implies</th><th class="num">Your net gain</th></tr></thead><tbody>'
          + rows.map(function (r, i) {
              var lead = i === 0;
              return '<tr><td class="' + (lead ? 'strong' : 'dim') + '">' + esc(r.label) + '</td>'
                + '<td class="num ' + (lead ? 'strong' : 'dim') + '">' + money(r.funds) + '</td>'
                + '<td class="num dim">' + r.units.toLocaleString() + '</td>'
                /* "costs you nothing" is true ONLY when nothing is funded. Printing it wherever
                   net <= 0 put it on a row funding $475 for zero extra units — the exact
                   opposite of what happened, on a screen a vendor is reading. A negative net
                   is shown as the negative it is. */
                + '<td class="num ' + (r.funds <= 0 ? 'dim' : r.net > 0 ? 'pos' : 'neg') + '">'
                + (r.funds <= 0 ? 'costs you nothing' : money(r.net)) + '</td></tr>';
            }).join('')
          + '</tbody></table>'
        : '<table class="sp-tbl"><tbody><tr><td class="dim">Set a reference and a target to see how the cost scales.</td></tr></tbody></table>';
    }

    /* The percentage return is INVARIANT under a flat bounty -- funds and the units they buy
       both scale with the number who hit, so the ratio cancels. Printing it down a column would
       repeat one figure four times and read as a broken table; said once, it is a stronger claim
       than a declining curve would be. */
    var argue = $('#calcArgue');
    if (argue) {
      var inv = m.invest && m.unitInc > 0 ? pctWhole(m.roiPct) : null;
      /* Second person: this screen is turned around and shown to the vendor, so it addresses
         them directly. "their number" stays third person on purpose — that one is the
         BUDTENDER, and switching it would read as the vendor having a sales target. */
      argue.innerHTML = 'You only pay a bounty on a budtender who actually reaches their number, so your '
        + 'downside is capped and your cost rises only alongside the sell-through that pays for it.'
        + (inv && calc.model === 'flat'
            ? ' Your percentage return does not move with the hit rate &mdash; it stays at <b>' + inv
              + '</b> whether ' + Math.round(m.bts * .2) + ' budtenders hit or all ' + m.bts
              + ' do, because you fund exactly the results you get.'
            : '');
    }

    /* ---- the two questions a vendor asks next */
    var minis = $('#calcMinis');
    if (minis) {
      var perExtra = (hasAsk && m.unitInc > 0) ? m.invest / m.unitInc : null;
      /* Break-even was the loudest of these: 90 units, stated flatly, off an investment that
         only existed because every store defaults to six budtenders. */
      var breakEven = (hasAsk && (Number(calc.cost) || 0)) ? Math.ceil(m.invest / (Number(calc.cost) || 0)) : null;
      minis.innerHTML =
          mini('Your cost per extra unit', perExtra == null ? '—' : money(perExtra),
               perExtra == null ? 'set a target above last month'
                                : money(m.invest) + ' across ' + m.unitInc.toLocaleString() + ' extra units')
        + mini('Break-even', breakEven == null ? '—' : breakEven.toLocaleString() + ' units',
               breakEven == null ? 'needs last month and a target' : 'against last month, chain-wide');
    }

    /* ---- the merged per-store table */
    var tbl = $('#calcTable');
    if (tbl) {
      var body = m.plan.map(function (row, i) {
        var st = m.on[i];
        var base = row.base, n = row.n;
        var goal = row.goal;
        var perNow  = row.perNow;
        var perGoal = row.perBt;
        /* The number a budtender is actually told: how many MORE than usual, each. "Sell 74"
           means nothing without knowing they already sell 53; "sell 21 more" is the ask. */
        var perLift = (perNow == null || perGoal == null) ? null : perGoal - perNow;
        return '<tr>'
          + '<td><span class="sp-store-cell" style="--dot:' + esc(storeColor(st.store_id)) + '">'
          +   '<span class="sp-dot"></span>' + esc(st.name) + '</span></td>'
          + '<td class="num">' + refCell(st, i, base) + '</td>'
          + '<td class="num strong">' + goal.toLocaleString() + '</td>'
          + '<td class="num"><input class="sp-in sp-num-in narrow" type="number" min="0" data-i="' + i + '" data-f="bts" value="' + n + '" aria-label="Budtenders, ' + esc(st.name) + '"></td>'
          + '<td class="num dim">' + (perNow == null ? '—' : perNow.toLocaleString()) + '</td>'
          + '<td class="num">' + (perGoal == null ? '—'
              : '<span class="sp-pin-cell' + (row.pinned ? ' is-pinned' : '') + '">'
                + '<input class="sp-in sp-num-in narrow" type="number" min="0" data-i="' + i + '"'
                +   ' data-f="perBtSet" value="' + perGoal + '"'
                +   ' aria-label="Per-budtender goal, ' + esc(st.name) + '">'
                + (row.pinned
                    ? '<button type="button" class="sp-pin-x" data-unpin="' + i + '"'
                      + ' title="Back to the split by last month">&#10005;</button>'
                    : '')
              + '</span>') + '</td>'
          + '<td class="num' + (perLift > 0 ? ' pos' : ' dim') + '">'
          +   (perLift == null ? '—' : (perLift > 0 ? '+' : '') + perLift.toLocaleString()) + '</td>'
          + '<td class="num dim">' + money(goal * (Number(calc.cost) || 0)) + '</td>'
          + '</tr>';
      }).join('');
      /* An empty store list is not "no stores" — it is GX Core's registry not having answered.
         Rendering a bare table with a 0-store total looked like a configured-and-empty app, so
         the reference pull silently could not run and nothing said so. This is the one place
         that failure becomes visible. */
      if (!m.on.length) {
        tbl.innerHTML = '<table class="sp-tbl"><tbody><tr><td>'
          + '<div class="sp-notice is-warn" style="border:0;padding:2px 0">'
          + '<span class="sp-notice-l">Store list unavailable</span>'
          + 'GX Core has not returned the store registry, so there is nothing to model against '
          + 'and last-month figures cannot be pulled. '
          + '<button type="button" class="gx-btn" id="calcRetryStores">Retry</button></div>'
          + '</td></tr></tbody></table>';
        var rs = $('#calcRetryStores');
        if (rs) rs.addEventListener('click', async function () {
          rs.disabled = true; rs.textContent = 'Retrying…';
          await loadShared();
          calc.stores = [];
          calcInit();
          recalc();
        });
        return;
      }

      tbl.innerHTML =
        '<table class="sp-tbl"><thead><tr><th>Store</th><th class="num">Last month</th>'
        + '<th class="num">Goal</th><th class="num">BTs</th><th class="num">per BT now</th>'
        + '<th class="num" title="Editable — type a number to pin this store\u2019s goal">per BT goal</th>'
        + '<th class="num">BT unit increase</th>'
        + '<th class="num">Goal value</th></tr></thead><tbody>'
        + body
        + '<tr class="sp-total"><td>Total · ' + m.on.length + ' store' + (m.on.length === 1 ? '' : 's')
        +   ', ' + m.bts + ' budtender' + (m.bts === 1 ? '' : 's') + '</td>'
        +   '<td class="num">' + m.baseUnits.toLocaleString() + '</td>'
        +   '<td class="num goal">' + m.goalUnits.toLocaleString() + '</td>'
        +   '<td class="num">' + m.bts + '</td><td></td><td></td>'
        +   '<td class="num' + (m.unitInc > 0 ? ' goal' : '') + '">'
        +     (m.bts ? (m.unitInc > 0 ? '+' : '') + Math.round(m.unitInc / m.bts).toLocaleString() : '—') + '</td>'
        +   '<td class="num">' + money(m.targetRev) + '</td></tr>'
        + '</tbody></table>';
    }

    /* Dim what is waiting. The stat strip, the goal and the per-store table all read from the
       reference total; the scales panel and the two mini-cards do too. The product picker and
       the deal fields are NOT dimmed — those are the controls Tawny may want to change while
       the pull runs, and freezing them would make the wait feel like a hang. */
    ['#calcStats', '#calcGoalWrap', '#calcTable', '#calcScale', '#calcMinis'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.classList.toggle('is-awaiting', pending > 0);
    });
    /* THE PULL FAILING IS A HEADLINE, NOT A TOOLTIP. Each cell has said "couldn't pull —
       retry" with the reason on hover since the reference pull was built, which is right for
       one store having a bad minute. When EVERY store refuses -- Dutchie 401ing chain-wide,
       2026-08-31 -- six identical retry links read as six flaky calls rather than one thing
       being down, and the reason stays hidden behind a hover nobody performs. */
    var failed = refFailed();
    var waitEl = $('#calcWaiting');
    if (waitEl) {
      var allOut = !pending && calc.stores.length > 0 && failed === calc.stores.length;
      waitEl.hidden = !pending && !failed;
      waitEl.classList.toggle('is-err', !pending && failed > 0);
      if (pending) {
        waitEl.innerHTML = '<span class="sp-live-dot"></span>pulling last month&rsquo;s sales &mdash; '
          + pending + ' of ' + calc.stores.length + ' store' + (calc.stores.length === 1 ? '' : 's') + ' to go';
      } else if (failed) {
        var why = (calc.stores.filter(function (st) { return st.refState === 'error'; })[0] || {}).refErr || '';
        waitEl.innerHTML = allOut
          ? 'last month&rsquo;s sales could not be read for ANY store &mdash; every figure below is '
            + 'waiting on that, not measuring zero. ' + esc(why)
          : failed + ' of ' + calc.stores.length + ' stores did not answer &mdash; the totals below '
            + 'are short those stores. ' + esc(why);
      }
    }

    var hint = $('#cPayoutHint');
    if (hint) hint.textContent = calc.model === 'per_unit'
      ? 'You pay ' + money(calc.spiff) + ' on every unit that budtender sells, from the first one.'
      : 'You pay ' + money(calc.spiff) + ' to each budtender who reaches their own target — and nothing for one who doesn’t.';

    pulse(changedIds);
  }

  /* One gxpulse on the figures a change actually moved. Removing the class and forcing a
     reflow re-arms it; without that, a second edit in a row would not animate at all. */
  function pulse(ids) {
    if (!ids || !ids.length) return;
    ids.forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      el.classList.remove('sp-changed');
      void el.offsetWidth;
      el.classList.add('sp-changed');
    });
  }

  /* A return in the hundreds of percent does not need a tenth of a point, and "695.8%" next to
     a 64px headline reads as false precision. pct() keeps the decimal for the record tables. */
  function pctWhole(n) {
    /* Grouped: a vendor return runs into the thousands of percent (2,521% on Mule), and an
       ungrouped "2521%" is a number you have to count the digits of. */
    return Math.round((Number(n) || 0) * 100).toLocaleString('en-US') + '%';
  }

  /* Each store's reference cell owns its own state. It stays an EDITABLE input in every
     outcome -- a pull that fails or returns a figure Tawny knows is wrong must never leave
     her unable to type the number she came in with. The shimmer replaces the input only
     while that store is genuinely in flight. */
  /* Fan out one request per store, exactly like Progress and for the same measured reason: the
     sell-through pull is ~9s a store against a ~60s /exec ceiling. Each cell shimmers until its
     own store answers, so five stores are not held up by the slowest. */
  async function pullReference() {
    if (!calc.product) return;
    if (!calc.stores.length) return;
    var run = (calc.refRun = {});
    calc.stores.forEach(function (st) { st.refState = 'loading'; });
    recalc();
    await Promise.all(calc.stores.map(function (st, i) { return pullReferenceFor(i, run); }));
  }

  /* One store. Also the retry path, so a store that timed out is re-pulled on its own instead
     of re-running all six — the same rule Progress follows, and here it matters more because
     each call is ~9 seconds. */
  async function pullReferenceFor(i, run) {
    var st = calc.stores[i], p = calc.product;
    if (!st || !p) return;
    if (!run) run = calc.refRun || (calc.refRun = {});
    st.refState = 'loading';
    recalc();
    try {
      var r = await ENG.jsonp('refunits', {
        token: (session() || {}).token, store: st.store_id,
        brand: p.brand, filter_text: p.filter_text,
        products: (p.products || []).join(',')
      }, { timeoutMs: 65000, retries: 1 });
      if (calc.refRun !== run) return;            // a newer product was picked mid-flight
      if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
      if (typeof r.reference !== 'number') throw new Error('engine returned no reference figure');
      st.baseline = r.reference;
      st.refUnits = typeof r.units === 'number' ? r.units : null;
      st.refState = 'ok';
    } catch (e) {
      if (calc.refRun !== run) return;
      st.refState = 'error';
      st.refErr = e.message || String(e);
    }
    if (calc.refRun !== run) return;
    /* The growth echo has to follow every arrival: it is a percentage OF the reference total,
       which just changed underneath it. */
    var base = calcModel().baseUnits;
    $('#cGrowth').value = base ? Math.round(((calc.target - base) / base) * 100) : 0;
    recalc();
  }

  function refCell(st, i, base) {
    if (st.refState === 'loading') return '<span class="sp-shim" aria-label="loading"></span>';
    var input = '<input class="sp-in sp-num-in" type="number" min="0" data-i="' + i
      + '" data-f="baseline" value="' + base + '" aria-label="Reference units, ' + esc(st.name) + '">';
    if (st.refState === 'error') {
      return input + '<div class="sp-ref-src is-err" data-refretry="' + i + '" title="'
        + esc(st.refErr || '') + '">couldn\u2019t pull \u2014 retry</div>';
    }
    /* Guarded, because this caption is the ONLY thing standing between a malformed engine
       reply and a blank Calculator: refState is set to 'ok' from a response whose `units` is
       merely expected to be a number, and reading .toLocaleString() off undefined throws
       inside a .map() that builds every row — one absent field took the whole table down. */
    if (st.refState === 'ok') {
      return input + (typeof st.refUnits === 'number'
        ? '<div class="sp-ref-src">' + st.refUnits.toLocaleString() + ' in 28d \u00f7 2</div>'
        : '<div class="sp-ref-src">pulled from Dutchie</div>');
    }
    return input;
  }

  function cstat(label, value, sub, cls) {
    return '<div class="sp-cstat ' + cls + '"><span class="sp-cstat-l">' + esc(label) + '</span>'
      + '<span class="sp-cstat-v">' + esc(String(value)) + '</span>'
      + '<span class="sp-cstat-s">' + esc(sub) + '</span></div>';
  }
  function mini(label, value, sub) {
    return '<div class="sp-mini"><div class="sp-mini-l">' + esc(label) + '</div>'
      + '<div class="sp-mini-v">' + esc(String(value)) + '</div>'
      + '<div class="sp-mini-s">' + esc(sub) + '</div></div>';
  }

  /* Which stat cards a given input actually moves, so the gxpulse lands on those and not
     on the whole strip. A pulse on everything says nothing about what changed. */
  var PULSE_ALL = ['#calcStats'];

  /* The slider's ceiling, in percent growth. 150% covers every program in the imported
     history with headroom; the typed Growth field is NOT capped by it, and a value past the
     ceiling simply pins the thumb rather than being clamped back down — the number Tawny
     typed must never be quietly rewritten by a control she did not touch. */
  var GOAL_MAX = 150;
  var draggingGoal = false;
  var calcPicker = null, recPicker = null;

  function wireCalculator() {
    ['cName', 'cVendor', 'cCost', 'cSpiff'].forEach(function (id) {
      $('#' + id).addEventListener('input', function () {
        calc[{ cName: 'name', cVendor: 'vendor', cCost: 'cost', cSpiff: 'spiff' }[id]] = $('#' + id).value;
        recalc(id === 'cName' || id === 'cVendor' ? null : PULSE_ALL);
      });
    });

    /* Payout model. Switching it changes what "vendor funds" even means, so it recomputes
       the whole strip rather than just the amount. */
    var seg = $('#cModel');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-model]');
      if (!b) return;
      calc.model = b.dataset.model;
      $$('#cModel button').forEach(function (x) { x.classList.toggle('is-on', x === b); });
      recalc(PULSE_ALL);
    });

    // Target units and growth % are two views of one number — editing either updates the
    // other, so Tawny can pitch "1,200 units" or "+40%" whichever way the vendor thinks.
    // The one being typed in takes the green ring so it is clear which is driving.
    $('#cTarget').addEventListener('input', function () {
      calc.target = Number($('#cTarget').value) || 0;
      var base = calcModel().baseUnits;
      $('#cGrowth').value = base ? Math.round(((calc.target - base) / base) * 100) : 0;
      driving('#cTarget');
      recalc(PULSE_ALL);
    });
    $('#cGrowth').addEventListener('input', function () {
      var base = calcModel().baseUnits;
      calc.target = Math.round(base * (1 + (Number($('#cGrowth').value) || 0) / 100));
      $('#cTarget').value = calc.target;
      driving('#cGrowth');
      recalc(PULSE_ALL);
    });

    /* The slider is the third view of the same number. `input` fires on every pixel of a drag,
       so the whole model repaints live — which is the point: the vendor watches ROI move while
       the ask is being found. draggingGoal stops recalc writing the thumb back mid-drag, which
       would fight the pointer. */
    var range = $('#cGoalRange');
    if (range) {
      var startDrag = function () { draggingGoal = true; };
      var endDrag   = function () { draggingGoal = false; };
      range.addEventListener('pointerdown', startDrag);
      range.addEventListener('pointerup', endDrag);
      range.addEventListener('pointercancel', endDrag);
      range.addEventListener('blur', endDrag);
      range.addEventListener('input', function () {
        var basePct = Number(range.value) || 0;
        var base = calcModel().baseUnits;
        if (!base) return;
        calc.target = Math.round(base * (1 + basePct / 100));
        $('#cTarget').value = calc.target;
        $('#cGrowth').value = basePct;
        driving('#cGrowth');
        recalc(PULSE_ALL);
      });
      range.addEventListener('change', endDrag);
    }

    /* Per-store inputs live inside the table recalc() rebuilds, so listen on the wrapper.
       Rebuilding on every keystroke would blow away focus mid-type, so the edited field is
       restored afterwards -- see restoreFocus. */
    var tbl = $('#calcTable');
    if (tbl) tbl.addEventListener('input', function (e) {
      var el = e.target, i = el.dataset && el.dataset.i;
      if (i == null) return;
      var st = calc.stores[i];
      if (!st) return;
      /* An EMPTY per-BT goal means "go back to the split", not "a goal of zero". Running it
         through `Number(x) || 0` like the other fields would turn clearing the box into a
         store told to sell nothing, which the total would then quietly absorb. */
      if (el.dataset.f === 'perBtSet') {
        st.perBtSet = el.value.trim() === '' ? null : Math.max(0, Number(el.value) || 0);
      } else {
        st[el.dataset.f] = Number(el.value) || 0;
      }
      /* Editing a reference moves the total, so the growth echo has to follow it — the
         target is the number being held fixed here, not the percentage. */
      if (el.dataset.f === 'baseline') {
        var base = calcModel().baseUnits;
        $('#cGrowth').value = base ? Math.round(((calc.target - base) / base) * 100) : 0;
      }
      var key = el.dataset.i + '/' + el.dataset.f, pos = el.selectionStart;
      /* Typing over a pulled reference makes it Tawny's number, not Dutchie's — drop the
         provenance line rather than leave it captioning a figure it no longer describes. */
      st.refState = null;
      recalc(PULSE_ALL);
      restoreFocus(key, pos);
    });

    if (tbl) tbl.addEventListener('click', function (e) {
      var r = e.target.closest('[data-refretry]');
      if (r) { pullReferenceFor(Number(r.dataset.refretry)); return; }
      var u = e.target.closest('[data-unpin]');
      if (u) {
        var st = calc.stores[Number(u.dataset.unpin)];
        if (st) { st.perBtSet = null; recalc(PULSE_ALL); }
      }
    });

    calcPicker = mountPicker({
      vendor: '#cVendor', vendorMenu: '#cVendorMenu',
      product: '#cProduct', productMenu: '#cProductMenu',
      chosen: '#cChosen', hint: '#cProductHint',
      onVendor: function (name) { calc.vendor = name; },
      onProduct: function (chosen, cost) {
        calc.product = chosen;
        calc.cost = cost;
        $('#cCost').value = cost;
        recalc(PULSE_ALL);
        pullReference();
      }
    });

    $('#calcLoad').addEventListener('change', loadIntoCalc);
    $('#calcSave').addEventListener('click', saveCalcProgram);
    var pres = $('#calcPresent');
    if (pres) pres.addEventListener('click', enterPitch);
  }

  /* One document-level dismissal for every picker on the page, registered once rather than
     per mount — two mounts each adding their own listener would close the other's menu. */
  document.addEventListener('mousedown', function (e) {
    if (e.target.closest('.sp-pick')) return;
    [calcPicker, recPicker].forEach(function (x) { if (x) x.close(); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    [calcPicker, recPicker].forEach(function (x) { if (x) x.close(); });
  });

  function driving(sel) {
    ['#cTarget', '#cGrowth'].forEach(function (x) {
      var el = $(x); if (el) el.classList.toggle('sp-driving', x === sel);
    });
  }

  /* The per-store table is innerHTML-replaced on every keystroke, which destroys the node
     being typed into. Put the caret back where it was, or the field silently loses focus
     after one character and the next keystroke goes nowhere. */
  function restoreFocus(key, pos) {
    var parts = key.split('/');
    var el = document.querySelector('#calcTable input[data-i="' + parts[0] + '"][data-f="' + parts[1] + '"]');
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(pos, pos); } catch (e) { /* number inputs refuse this in some browsers */ }
  }

  /* ══════════════════════════════════════════════ PAY PERIODS ═══════════ */
  /* Pay periods are 14 days from a fixed anchor. Both constants come from GX CORE's public
     config (cfg.payPeriodAnchor / cfg.payPeriodDays) — the SAME values Leaderboard's incentive
     run uses. Hardcoding them here would put SPIFF's idea of a pay period on a different
     timeline from payroll's the first time Mike moves the anchor, and nothing would announce
     the drift; a SPIFF would just close against a fortnight nobody paid out on.
     The fallbacks match today's config so a Core hiccup degrades to the right answer rather
     than to no answer, and the app still says which it used. */
  var payCfg = { anchor: '2026-05-11', days: 14, live: false };

  async function loadPayPeriods() {
    try {
      var r = await GX.jsonp('config', {});
      if (r && r.ok && r.config) {
        var a = String(r.config['cfg.payPeriodAnchor'] || '').slice(0, 10);
        var d = Number(r.config['cfg.payPeriodDays']);
        if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { payCfg.anchor = a; payCfg.live = true; }
        if (d > 0) payCfg.days = d;
      }
    } catch (e) { console.warn('[spiff] pay-period config unavailable, using built-in anchor'); }
    return payCfg;
  }

  /* Day arithmetic in UTC, then formatted back — the same rule as everywhere else in this app.
     A local Date constructor shifts the day across a DST boundary, and Leaderboard has already
     paid for that lesson once: an anchor an hour before PT midnight formats as the day before. */
  function ymdPlus(ymd, n) {
    var q = String(ymd).split('-');
    var d = new Date(Date.UTC(Number(q[0]), Number(q[1]) - 1, Number(q[2]) + n));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
         + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function daysBetween(a, b) {
    var pa = String(a).split('-'), pb = String(b).split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 864e5);
  }

  /* Which period contains a date — floor for dates after the anchor, and a floor that still
     works BEFORE it (JS truncates toward zero, so -1/14 would land on period 0). */
  function periodIndexOf(ymd) {
    var diff = daysBetween(payCfg.anchor, ymd);
    return Math.floor(diff / payCfg.days);
  }
  function periodByIndex(i) {
    var start = ymdPlus(payCfg.anchor, i * payCfg.days);
    return { index: i, start: start, end: ymdPlus(start, payCfg.days - 1) };
  }
  function periodLabel(pp) {
    return prettyDay(pp.start) + ' → ' + prettyDay(pp.end);
  }

  /* Which whole pay periods a stored window spans, or null when it does not sit on the grid at
     all. Programs are picked as periods now (Sky, 2026-08-31: "remove custom dates option, only
     allow PPs"), but three live records predate that rule and MUST NOT be snapped onto it:
     `buddies-2026-06-22-2026-07-19` runs two whole periods, `green-cross-2025-08-11-2025-08-17`
     is a seven-day program, and the `wyld-0626` draft is a calendar month. Two of those are
     CLOSED and were reported to the vendor against the dates they hold; moving the window to
     make a dropdown tidy would change what a settled program says it measured. */
  function periodSpanOf(startYmd, endYmd) {
    if (!startYmd || !endYmd) return null;
    var a = periodByIndex(periodIndexOf(startYmd));
    if (a.start !== startYmd) return null;               // does not begin on a period boundary
    var b = periodByIndex(periodIndexOf(endYmd));
    if (b.end !== endYmd) return null;                   // does not end on one either
    return { from: a.index, to: b.index };
  }

  /* Past periods for the archive, plus a bounded run of future ones so a program can be set up
     before it starts. Capped at 10 ahead per Sky — an unbounded list is a scroll, not a choice. */
  var PP_FUTURE = 10, PP_PAST = 14;
  function payPeriodOptions(selectedStart) {
    var now = periodIndexOf(today());
    var out = [];
    for (var i = now + PP_FUTURE; i >= now - PP_PAST; i--) out.push(periodByIndex(i));
    /* A program whose dates predate the window still has to be selectable, or opening an old
       record silently re-points it at a period it never ran in. */
    if (selectedStart && !out.some(function (x) { return x.start === selectedStart; })) {
      out.push(periodByIndex(periodIndexOf(selectedStart)));
    }
    return out;
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
         + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ═══════════════════════════════════ FEATURED PRODUCT PICKER ══════════ */
  /* What the SPIFF is actually ON. Before this, vendor / cost per unit / reference units
     were all typed from memory, so a program could be modelled against sell-through that
     had nothing to do with the product being pitched.

     THE SELECTION IS A FILTER, NOT A LIST OF SKUs. Sky's normal case is "the SPIFF is on
     that price-tiered gummy, whatever the flavor", so a GROUP resolves to
     {brand, filter_text} — which matches every flavor, now and any added mid-program.
     GX Core's sell-through caps an explicit product list at FOUR, so a group of eight
     flavors is not expressible that way; picking one specific SKU uses `products` and
     stays inside the cap. Getting this backwards would silently under-count a program. */

  var pick = {
    brands: [],        // [{name, count}] from live in-stock Dutchie
    products: [],      // this vendor's in-stock products
    brand: '',         // the loaded brand, so we don't refetch per keystroke
    loading: false
  };

  /* ONE picker, mounted twice. The Calculator and the Edit Program modal ask the identical
     question — which product is this SPIFF on — so they run the same instance factory rather
     than two copies that drift. The catalog cache (`pick`) is shared across mounts, so opening
     the modal after using the Calculator costs no fetch at all. */
  function mountPicker(cfg) {
    var vEl  = $(cfg.vendor), vMenu = $(cfg.vendorMenu);
    var pEl  = cfg.product ? $(cfg.product) : null;
    var pMenu = cfg.productMenu ? $(cfg.productMenu) : null;
    var chosenHost = cfg.chosen ? $(cfg.chosen) : null, hintEl = cfg.hint ? $(cfg.hint) : null;
    /* VENDOR-ONLY is a supported mount. The Edit Program modal autocompletes the vendor —
       identity, which it owns — but sends product selection to the Calculator, so it has no
       product elements to bind. Requiring both would have silently returned null and left the
       vendor field a plain text box with no hint that anything was wrong. */
    if (!vEl) return null;
    var hasProduct = !!(pEl && pMenu);

    var open = Object.create(null);   // expanded groups, per mount
    var api = { chosen: null };

    function closeBoth() {
      vMenu.hidden = true;
      vEl.setAttribute('aria-expanded', 'false');
      if (hasProduct) { pMenu.hidden = true; pEl.setAttribute('aria-expanded', 'false'); }
    }

    function renderVendors(q) {
      var s2 = String(q || '').trim().toLowerCase();
      var list = pick.brands.filter(function (b) { return !s2 || b.name.toLowerCase().indexOf(s2) >= 0; }).slice(0, 40);
      vMenu.hidden = false;
      vEl.setAttribute('aria-expanded', 'true');
      vMenu.innerHTML = list.length
        ? list.map(function (b) {
            return '<div class="sp-pick-row" data-b="' + esc(b.name) + '" role="option">'
              + '<span class="sp-pick-spacer"></span><div class="sp-pick-body">'
              + '<div class="sp-pick-1"><span class="sp-pick-name">' + esc(b.name) + '</span></div></div>'
              + '<span class="sp-pick-cost">' + b.count + '</span></div>';
          }).join('')
        : '<div class="sp-pick-empty">' + (pick.catErr
            ? esc(pick.catErr)
            : 'No vendor in stock matches that.') + '</div>';
      if (pick.stale) vMenu.innerHTML += '<div class="sp-pick-empty">Dutchie is not answering &mdash; '
        + 'this is the last product list that read cleanly, so stock and cost may be out of date.</div>';
    }

    function renderProducts(q) {
      pMenu.hidden = false;
      pEl.setAttribute('aria-expanded', 'true');
      if (pick.loading) {
        pMenu.innerHTML = Array(5).join(',').split(',').map(function () {
          return '<div class="sp-pick-row"><span class="sp-pick-spacer"></span><div class="sp-pick-body">'
            + '<div class="sp-skel sp-skel-line" style="width:60%"></div></div></div>';
        }).join('');
        return;
      }
      var groups = groupProducts(matchProducts(q));
      if (!groups.length) {
        pMenu.innerHTML = '<div class="sp-pick-empty">Nothing in stock matches that for '
          + esc(pick.brand || 'this vendor') + '.</div>';
        return;
      }
      pMenu.innerHTML = groups.slice(0, 60).map(function (g, gi) {
        var p0 = g.items[0];
        if (g.items.length === 1) {
          return '<div class="sp-pick-row" data-g="' + gi + '" data-c="0" role="option">'
            + '<span class="sp-pick-spacer"></span>'
            + '<div class="sp-pick-body"><div class="sp-pick-1"><span class="sp-pick-name">'
            +   esc(p0.n) + '</span></div>'
            + '<div class="sp-pick-2">' + money(p0.price) + ' &middot; '
            +   esc([p0.c, p0.s].filter(Boolean).join(' · '))
            +   ' &middot; ' + p0.qty.toLocaleString() + ' in stock</div></div>'
            + '<span class="sp-pick-cost">' + money(p0.cost) + '</span></div>';
        }
        var isOpen = !!open[g.key];
        var out = '<div class="sp-pick-row' + (isOpen ? ' is-open' : '') + '" data-g="' + gi + '" data-c="-1" role="option">'
          + '<button type="button" class="sp-pick-chev" data-x="' + gi + '" title="Show flavors">&#9656;</button>'
          + '<div class="sp-pick-body"><div class="sp-pick-1">'
          +   '<span class="sp-pick-name">' + esc(p0.b) + ' &middot; ' + esc(g.noun) + '</span>'
          +   '<button type="button" class="sp-pick-n" data-x="' + gi + '" title="'
          +     g.items.length + ' flavors — the SPIFF covers all of them">' + g.items.length + '</button>'
          + '</div>'
          + '<div class="sp-pick-2">' + money(p0.price) + ' &middot; '
          +   esc([p0.c, p0.s].filter(Boolean).join(' · '))
          +   ' &middot; ' + groupQty(g).toLocaleString() + ' in stock</div></div>'
          + '<span class="sp-pick-cost">' + money(groupCost(g)) + '</span></div>';
        if (isOpen) out += g.items.map(function (x, ci) {
          return '<div class="sp-pick-row is-child" data-g="' + gi + '" data-c="' + ci + '" role="option">'
            + '<div class="sp-pick-body"><div class="sp-pick-1"><span class="sp-pick-name">'
            +   esc(x.n) + '</span></div>'
            + '<div class="sp-pick-2">' + x.qty.toLocaleString() + ' in stock</div></div>'
            + '<span class="sp-pick-cost">' + money(x.cost) + '</span></div>';
        }).join('');
        return out;
      }).join('');
      pMenu._groups = groups;
    }

    function renderChosen() {
      if (!chosenHost) return;
      if (!api.chosen) { chosenHost.innerHTML = ''; if (hintEl) hintEl.hidden = false; return; }
      if (hintEl) hintEl.hidden = true;
      var c = api.chosen;
      chosenHost.innerHTML = '<div class="sp-chosen"><div class="sp-chosen-b">'
        + '<div class="sp-chosen-n">' + esc(c.label) + '</div>'
        + '<div class="sp-chosen-m">'
        +   (c.skus > 1 ? c.skus + ' flavors &mdash; the SPIFF covers all of them' : 'this SKU only')
        +   ' &middot; ' + (c.qty || 0).toLocaleString() + ' in stock'
        +   (c.price ? ' &middot; ' + money(c.price) + ' on the shelf' : '')
        +   (c.category ? ' &middot; ' + esc(c.category) : '') + '</div>'
        + (c.costSuspect
            ? '<span class="sp-cost-warn">Dutchie lists a unit cost under a cent for this &mdash; check it before quoting a vendor.</span>'
            : '')
        + '</div><button type="button" class="gx-btn" data-unpick="1">Change</button></div>';
    }

    function choose(g, ci) {
      var whole = ci < 0, p0 = g.items[0];
      var cost = whole ? groupCost(g) : g.items[ci].cost;
      api.chosen = whole
        ? { label: p0.b + ' · ' + g.noun, brand: p0.b, filter_text: g.noun, products: [],
            skus: g.items.length, qty: groupQty(g), category: p0.c, price: p0.price,
            costSuspect: g.items.some(function (x) { return x.costSuspect; }) }
        : { label: g.items[ci].n, brand: p0.b, filter_text: '', products: [g.items[ci].n],
            skus: 1, qty: g.items[ci].qty, category: g.items[ci].c, price: g.items[ci].price,
            costSuspect: !!g.items[ci].costSuspect };
      pEl.value = '';
      closeBoth();
      renderChosen();
      if (cfg.onProduct) cfg.onProduct(api.chosen, Math.round(cost * 100) / 100);
    }

    async function setVendor(name) {
      vEl.value = name;
      closeBoth();
      if (!hasProduct) { if (cfg.onVendor) cfg.onVendor(name); return; }
      /* Changing vendor invalidates the product and everything derived from it. Leaving a
         Wyld product selected under vendor "Mule" is the kind of state that gets pitched. */
      api.chosen = null;
      renderChosen();
      pEl.disabled = false;
      pEl.placeholder = 'Search ' + name + '’s products…';
      if (cfg.onVendor) cfg.onVendor(name);
      await loadBrandProducts(name);
      pEl.focus();
      renderProducts('');
    }

    vEl.addEventListener('focus', async function () { await loadBrands(); renderVendors(vEl.value); });
    vEl.addEventListener('input', function () {
      if (cfg.onVendor) cfg.onVendor(vEl.value);
      renderVendors(vEl.value);
    });
    vMenu.addEventListener('mousedown', function (e) {
      var row = e.target.closest('[data-b]');
      if (!row) return;
      e.preventDefault();
      setVendor(row.dataset.b);
    });

    if (hasProduct) {
    /* Repaint whenever a catalog load starts or finishes, but only while this mount's menu is
       actually open — a background load must not pop a dropdown open on a screen nobody is
       looking at. */
    pickMounts.push(function () { if (!pMenu.hidden) renderProducts(pEl.value); });
    /* `|| pick.loading` matters: focusing mid-fetch used to render nothing at all, so the
       field sat blank with no indication anything was happening. */
    pEl.addEventListener('focus', function () { if (pick.brand || pick.loading) renderProducts(pEl.value); });
    pEl.addEventListener('input', function () { renderProducts(pEl.value); });
    pMenu.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var x = e.target.closest('[data-x]');
      if (x) {                                  // chevron / count pill expands, never selects
        var g = (pMenu._groups || [])[Number(x.dataset.x)];
        if (g) { open[g.key] = !open[g.key]; renderProducts(pEl.value); }
        return;
      }
      var row = e.target.closest('[data-g]');
      if (!row) return;
      var grp = (pMenu._groups || [])[Number(row.dataset.g)];
      if (grp) choose(grp, Number(row.dataset.c));
    });
    }
    if (chosenHost) chosenHost.addEventListener('click', function (e) {
      if (!e.target.closest('[data-unpick]')) return;
      api.chosen = null; renderChosen(); if (hasProduct) pEl.focus();
    });

    api.close = closeBoth;
    api.renderChosen = renderChosen;
    api.setVendorSilently = function (name) {
      vEl.value = name || '';
      if (!hasProduct) return;
      pEl.disabled = !name;
      if (!name) return;
      pEl.placeholder = 'Search ' + name + '’s products…';
      /* Await, then paint if the menu is open by the time it lands. The mount callback above
         covers the case where the user opened it while this was in flight. */
      loadBrandProducts(name).then(function () { if (!pMenu.hidden) renderProducts(pEl.value); });
    };
    api.setChosen = function (c) { api.chosen = c; renderChosen(); };
    return api;
  }

  async function loadBrands() {
    if (pick.brands.length) return pick.brands;
    try {
      /* 40s, not GXClient's 8s default. A cold catalog build measured ~14 SECONDS across six
         stores, so the default guaranteed a timeout on the first call after the six-hour cache
         expired — and a timeout here reads to the user as "this vendor has no products". */
      var r = await ENG.jsonp('catalog', { token: (session() || {}).token }, { timeoutMs: 40000, retries: 1 });
      if (r && r.ok) pick.brands = r.brands || [];
      /* `stale` means the engine kept the last catalog that read cleanly because the rebuild
         reached no store at all. The list is real but may be out of date, and a vendor picker
         that is quietly out of date is worse than one that says so. */
      pick.stale  = !!(r && r.stale);
      pick.catErr = (r && !r.ok) ? (r.error || 'the product list could not be read') : '';
    } catch (e) {
      pick.catErr = 'the product list could not be read';
      console.error('[spiff] catalog brands failed:', e);
    }
    return pick.brands;
  }

  /* Mounts register here so a load that lands AFTER the menu was opened still paints. Without
     it the product list stayed empty forever: the fetch takes seconds, the user focuses the
     field before it resolves, `pick.brand` is still empty so nothing renders, and nothing ever
     re-renders. The field looked alive and simply never filled — which is exactly what a
     vendor with no products looks like. */
  var pickMounts = [];

  async function loadBrandProducts(brand) {
    if (pick.brand === brand && pick.products.length) return pick.products;
    pick.loading = true;
    pickMounts.forEach(function (f) { f(); });
    try {
      var r = await ENG.jsonp('catalog', { token: (session() || {}).token, brand: brand },
                              { timeoutMs: 40000, retries: 1 });
      pick.products = (r && r.ok) ? (r.products || []) : [];
      pick.brand = brand;
    } catch (e) {
      pick.products = []; pick.brand = '';
      console.error('[spiff] catalog products failed:', e);
    }
    pick.loading = false;
    pickMounts.forEach(function (f) { f(); });
    return pick.products;
  }

  /* The product noun, with leading flavor/strain words dropped — "Sour Apple Sativa Gummy"
     and "Watermelon Hybrid Gummy" both reduce to "Gummy" and collapse into one row.
     Lifted from the Price Cards builder so the two pickers group identically. */
  function baseNoun(name) {
    var w = String(name || '').split('|')[0].trim().split(/\s+/).filter(Boolean);
    if (!w.length) return String(name || '');
    /* Walk in from the RIGHT past potency and ratio tokens. Taking the last word outright
       turned "Pineapple Gummy 1:1 THC/CBD" into the group "THC/CBD" — a heading no one would
       recognize, sitting where "Gummy" belongs. Anything carrying a digit, colon, slash,
       percent or a bare mg is a spec, not the product noun. */
    var i = w.length - 1;
    while (i > 0 && /[\d:%\/]|^mg$/i.test(w[i])) i--;
    if (i >= 1 && /^(pack|roll|aio|bar|joints?|blunts?)$/i.test(w[i])) return w.slice(i - 1, i + 1).join(' ');
    return w[i];
  }

  /* Group by brand + noun + PRICE. Price is in the key on purpose: a $5 gummy and a $6 gummy
     are different offers, and a SPIFF on "the $5 tier" must not sweep in the other. */
  function groupProducts(list) {
    var groups = [], by = Object.create(null);
    list.forEach(function (p) {
      var noun = baseNoun(p.n);
      var key = (p.b + '|' + noun + '|' + p.price).toLowerCase();
      if (!by[key]) {
        by[key] = { key: key, noun: noun.charAt(0).toUpperCase() + noun.slice(1), items: [] };
        groups.push(by[key]);
      }
      by[key].items.push(p);
    });
    return groups;
  }

  function matchProducts(q) {
    var s2 = String(q || '').trim().toLowerCase();
    if (!s2) return pick.products.slice(0, 400);
    return pick.products.filter(function (p) {
      return (p.n + ' ' + p.c).toLowerCase().indexOf(s2) >= 0;
    }).slice(0, 400);
  }

  /* A group's cost weighted by what is on the shelf — the same rule the engine uses when it
     merges batches, for the same reason: a stray unit at an odd cost must not move the quote. */
  function groupCost(g) {
    var q = 0, c = 0;
    g.items.forEach(function (p) { q += p.qty || 0; c += (p.cost || 0) * (p.qty || 0); });
    return q ? c / q : (g.items[0].cost || 0);
  }
  function groupQty(g) { return g.items.reduce(function (n, p) { return n + (p.qty || 0); }, 0); }

  /* ─────────────── record → Calculator hand-off ───────────────
     The modal owns identity, dates, contact and actuals; the Calculator owns the model. This
     is the seam between them. It carries EVERYTHING the Calculator needs, including the
     per-store references, so the target it shows is the target this program was actually set
     against rather than one recomputed from a fresh 28-day pull.

     UNSAVED EDITS IN THE MODAL ARE CARRIED TOO. Changing the payout here and then clicking
     through would otherwise model the old rate, and nothing on the Calculator would say so. */
  function openInCalculator(p) {
    var patch = collectPatch(p);
    var merged = Object.assign({}, p, patch);
    if (Object.keys(patch).length) {
      /* Say it plainly rather than silently binding unsaved values into the model. */
      $('#recordMsg').textContent = 'Carrying your unsaved changes to the Calculator.';
    }

    calc.editingId = p.program_id;
    calc.name   = merged.program_name || merged.title || '';
    calc.vendor = merged.vendor || '';
    calc.cost   = (merged.cost_json || {}).per_unit || 0;
    calc.spiff  = (merged.payout_json || {}).amount || 0;
    calc.model  = normalModel((merged.payout_json || {}).model || merged.payout_type);
    calc.target = (merged.target_json || {}).units || 0;
    calc.window = { start: merged.start_date || '', end: merged.end_date || '' };

    var mj = merged.match_json || {};
    calc.product = (mj.filter_text || (mj.products || []).length)
      ? { label: (mj.brand ? mj.brand + ' · ' : '') + (mj.filter_text || (mj.products || []).join(', ')),
          brand: mj.brand || '', filter_text: mj.filter_text || '', products: mj.products || [],
          skus: (mj.products || []).length || 0, qty: 0, category: mj.category || '' }
      : null;

    var base = merged.baseline_json || {};
    /* The registry is preferred, but the PROGRAM knows which stores it ran in. When GX Core's
       store call has failed, falling back to that is the difference between editing the program
       and staring at an empty table — and it is the same list the program was saved with. */
    var reg = state.stores.length
      ? state.stores
      : (merged.stores_json || []).map(function (id) { return { store_id: id, display_name: storeName(id) }; });
    var mTgt = merged.target_json || {};
    calc.stores = reg.map(function (st) {
      var b = (base.by_store || {})[st.store_id];
      /* The SAVED per-BT goal comes back as a pin. Re-deriving it from the target would quietly
         discard whatever tuning was done last time — the store rows would look right and be
         different numbers from the ones the vendor was shown. */
      var tgtPerBt = (mTgt.per_bt || {})[st.store_id];
      return {
        store_id: st.store_id, name: st.display_name || st.store_id,
        baseline: b || 0,
        bts: btsForStore(st.store_id, mTgt, base),
        perBtSet: tgtPerBt ? Number(tgtPerBt) : null
      };
    });

    $('#cName').value = calc.name;
    $('#cCost').value = calc.cost;
    $('#cSpiff').value = calc.spiff;
    $('#cTarget').value = calc.target;
    $$('#cModel button').forEach(function (x) { x.classList.toggle('is-on', x.dataset.model === calc.model); });
    if (calcPicker) {
      calcPicker.setVendorSilently(calc.vendor);
      calcPicker.setChosen(calc.product);
    }
    closeRecord();
    showTab('calculator');
    recalc(PULSE_ALL);
    renderCalcEditing();
  }

  /* The Calculator has to say WHICH program it is editing, or "Save as program" silently forks
     a duplicate off a record Tawny thought she was updating. */
  function renderCalcEditing() {
    var btn = $('#calcSave'), bar = $('#calcEditing');
    var editing = !!calc.editingId;
    if (btn) btn.textContent = editing ? 'Update this program' : 'Save as program';
    if (!bar) return;
    bar.hidden = !editing;
    if (!editing) return;
    var win = calc.window && calc.window.start
      ? prettyDay(calc.window.start) + ' → ' + prettyDay(calc.window.end || '?')
      : 'no dates set';
    bar.innerHTML = 'Editing <b>' + esc(calc.name || 'this program') + '</b> &middot; ' + esc(win)
      + ' <button type="button" class="gx-btn" id="calcStopEditing">Stop editing</button>';
    $('#calcStopEditing').addEventListener('click', function () {
      calc.editingId = null; calc.window = null;
      renderCalcEditing();
    });
  }

  /* ------------------------------------------------------- pitch mode (1c) */
  /* The Calculator, with the chrome taken away and the type scale raised, for showing a
     vendor across a desk. Nothing here is interactive except leaving -- a stray click in
     front of a vendor must not change a number that is being pitched. */
  function enterPitch() {
    var m = calcModel();
    if (!m.baseUnits || !calc.target) {
      alert('Set the reference units and a target before presenting.');
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'sp-pitch';
    wrap.id = 'spPitch';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'SPIFF proposal');

    var ask = calc.model === 'per_unit'
      ? 'a <b>' + money(calc.spiff) + '</b> bounty on every unit a budtender sells'
      : 'a <b>' + money(calc.spiff) + '</b> bounty per budtender who reaches their own target';

    var cards = m.plan.map(function (st) {
      var base = st.base;
      var n    = st.n;
      var goal = st.goal;
      var add  = goal - base;
      var span = goal || 1;
      var havePct = Math.max(0, Math.min(100, (base / span) * 100));
      return '<div class="sp-pstore" style="--dot:' + esc(storeColor(st.store_id)) + '">'
        + '<div class="sp-pstore-h"><span class="sp-dot"></span>' + esc(st.name) + '</div>'
        + '<div class="sp-pstore-n"><span class="sp-pstore-v">' + goal.toLocaleString() + '</span>'
        +   '<span class="sp-pstore-u">units' + (n ? ' · ' + st.perBt + ' each' : '') + '</span></div>'
        + '<div class="sp-pstore-bar">'
        +   '<div class="sp-pstore-have" style="width:' + havePct.toFixed(1) + '%"></div>'
        +   (add > 0 ? '<div class="sp-pstore-add" style="left:' + havePct.toFixed(1) + '%"></div>' : '')
        +   '<div class="sp-pstore-tick" style="left:' + havePct.toFixed(1) + '%"></div>'
        + '</div>'
        + '<div class="sp-pstore-f"><span class="now">' + base.toLocaleString() + ' today</span>'
        +   '<span class="add">' + (add >= 0 ? '+' : '') + add.toLocaleString() + '</span></div>'
        + '</div>';
    }).join('');

    var fundSub = pbig('You fund', money(m.invest),
      calc.model === 'per_unit'
        ? m.goalUnits.toLocaleString() + ' units × ' + money(calc.spiff)
        : m.bts + ' budtenders × ' + money(calc.spiff), '');
    var revSub = pbig('Your revenue moves', '+' + money(m.revInc),
      money(m.baseRev) + ' → ' + money(m.targetRev), '');
    var roiSub = pbig('Your return', m.invest ? pctWhole(m.roiPct) : '—',
      money(m.roi) + ' net of the bounty', m.roi < 0 ? '' : 'is-hero');

    wrap.innerHTML =
      '<div class="sp-pitch-bar">'
      +   '<img src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">'
      +   '<span class="sp-pitch-mark">SPIFF proposal</span>'
      +   '<span class="sp-pitch-right">'
      +     '<button class="gx-btn" id="pitchExit">Exit &#10005;</button>'
      +   '</span>'
      + '</div>'
      + '<div class="sp-pitch-body">'
      +   '<div>'
      +     (calc.vendor ? '<div class="sp-pitch-vendor">' + esc(calc.vendor) + '</div>' : '')
      +     '<h1 class="sp-pitch-h1">' + esc(calc.name || 'SPIFF proposal') + ' &mdash; '
      +       m.bts + ' budtenders, ' + m.goalUnits.toLocaleString() + ' units</h1>'
      +     '<p class="sp-pitch-lede">Green Cross is asking for ' + ask
      +       ' across ' + m.on.length + ' store' + (m.on.length === 1 ? '' : 's')
      +       ', funded as a credit against the next order.</p>'
      +   '</div>'
      +   '<div class="sp-pitch-3">' + fundSub + revSub + roiSub + '</div>'
      +   '<div><div class="sp-pitch-l">What each store is being asked for</div>'
      +     '<div class="sp-pstores">' + cards + '</div></div>'
      + '</div>';

    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    var exit = document.getElementById('pitchExit');
    exit.addEventListener('click', exitPitch);
    exit.focus();
    document.addEventListener('keydown', pitchKey);
  }

  /* Escape leaves, and it is captured here rather than relying on the record modal's handler --
     that one calls closeRecord and would do nothing while a pitch is up. */
  function pitchKey(e) { if (e.key === 'Escape') exitPitch(); }
  function exitPitch() {
    var w = document.getElementById('spPitch');
    if (w) w.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', pitchKey);
    var b = $('#calcPresent'); if (b) b.focus();
  }

  function pbig(label, value, sub, cls) {
    return '<div class="sp-pbig ' + cls + '"><div class="sp-pbig-l">' + esc(label) + '</div>'
      + '<div class="sp-pbig-v">' + esc(String(value)) + '</div>'
      + '<div class="sp-pbig-s">' + esc(sub) + '</div></div>';
  }

  // Model a new deal off a past one — "what if we ran Wyld again, but at $50?"
  function loadIntoCalc() {
    /* "Start from scratch…" is the empty option, and it used to return early — leaving every
       value from the LAST program loaded, including a per_unit payout, under a heading that
       says the model is new. Selecting it now genuinely resets. */
    if (!$('#calcLoad').value) { newProgram(); return; }
    var p = state.programs.filter(function (x) { return x.program_id === $('#calcLoad').value; })[0];
    if (!p) return;
    var base = p.baseline_json || {}, tgt = p.target_json || {};
    calc.name   = p.program_name || p.title;
    calc.vendor = p.vendor;
    calc.cost   = (p.cost_json || {}).per_unit || 0;
    calc.spiff  = (p.payout_json || {}).amount || 0;
    calc.model  = normalModel((p.payout_json || {}).model || p.payout_type);
    calc.target = tgt.units || 0;
    /* EVERY registry store, not just the ones this program ran in. The Calculator models a NEW
       deal; loading a past one seeds its numbers, it does not re-scope the chain. A store that
       sat out last time has a 0 reference here, which is visible and editable -- where the old
       `on` flag hid it behind an unticked box. */
    calc.stores = state.stores.map(function (s) {
      var b = (base.by_store || {})[s.store_id];
      var tgtPerBt = (tgt.per_bt || {})[s.store_id];
      return {
        store_id: s.store_id, name: s.display_name || s.store_id,
        baseline: b || 0,
        bts: btsForStore(s.store_id, tgt, base),
        perBtSet: tgtPerBt ? Number(tgtPerBt) : null
      };
    });
    $('#cName').value = calc.name; $('#cVendor').value = calc.vendor;
    $('#cCost').value = calc.cost; $('#cSpiff').value = calc.spiff;
    $('#cTarget').value = calc.target;
    $$('#cModel button').forEach(function (x) { x.classList.toggle('is-on', x.dataset.model === calc.model); });
    var m = calcModel();
    $('#cGrowth').value = m.baseUnits ? Math.round(m.typedGrowth * 100) : 0;
    recalc();
  }

  /* The nine model fields, built once. Create sends all of them because there is nothing to
     compare against; update sends only the ones that moved — see calcModelPatch. */
  function calcModelPayload(m) {
    var byStore = Object.create(null), perBt = Object.create(null);
    var baseByStore = Object.create(null), basePerBt = Object.create(null);
    var btsByStore = Object.create(null);
    /* SAVED FROM THE PLAN, so the record holds exactly what was on the screen. These two
       lines used to run their own arithmetic -- per_bt as round(round(base/bts) x ratio),
       against a table that showed round(round(base x ratio)/bts) -- two formulas for one
       number. per_bt is the threshold Progress judges a budtender against and pays on, so a
       program could be sold at one goal and settled at another. */
    m.plan.forEach(function (s) {
      byStore[s.store_id] = s.goal;
      perBt[s.store_id]   = s.perBt || 0;
      /* HEADCOUNT IS SAVED. It never used to be, and reopening a program had to guess it back by
         dividing last month's units by last month's per-budtender figure — two numbers that were
         already rounded when they were stored. The guess was wrong for 20 of the 26 live
         programs, so opening one and pressing Update rewrote its store goals: Meraki Gardens
         December went 90 units to 78 with nobody typing anything. */
      btsByStore[s.store_id] = Number(s.n) || 0;
      /* The per-store LAST-MONTH split is saved too. It is what openInCalculator reads back,
         so without it a second trip through Edit parameters would open on zeroed references
         and recompute a different target than the one the vendor agreed to. */
      baseByStore[s.store_id] = Number(s.baseline) || 0;
      basePerBt[s.store_id]   = s.bts ? Math.round((Number(s.baseline) || 0) / s.bts) : 0;
    });
    return {
      program_name: calc.name, vendor: calc.vendor,
      cost_json:   { mode: 'flat', per_unit: Number(calc.cost) || 0, source_label: 'calculator' },
      /* The model is SAVED. It used to be hardcoded 'flat', so a per-unit program (Hapy Kitchen
         paid $1/unit) came back out of the datastore looking flat — which is exactly how the
         imported history came to look uniformly flat. */
      payout_type: calc.model,
      payout_json: { amount: Number(calc.spiff) || 0, model: calc.model },
      match_json:  matchOf(calc.product),
      stores_json: m.on.map(function (x) { return x.store_id; }),
      baseline_json: { units: m.baseUnits, revenue: m.baseRev, by_store: baseByStore, per_bt: basePerBt },
      /* budtenders is what Programs divides the payout by; without it the hero showed
         "of 0 hit" and an earned-so-far of $0 on a program that was paying out. */
      target_json: { units: m.goalUnits, revenue: m.targetRev,
                     budtenders: m.bts, by_store: byStore, per_bt: perBt,
                     bts_by_store: btsByStore }
    };
  }

  /* Canonical JSON — object keys sorted, so two structurally identical values compare equal
     however they were built. The stored value came back out of the datastore and the candidate
     was just assembled on screen; nothing makes those two agree on key order, and a plain
     JSON.stringify comparison would call every field dirty every time, which is the whole
     failure this is here to remove. */
  function canonJson(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonJson).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonJson(v[k]);
    }).join(',') + '}';
  }

  /* ── ONLY WHAT MOVED ──────────────────────────────────────────────────────────────────────
     Update used to post all nine fields whether or not any of them had been touched. Pressing
     "Update this program" to correct a name therefore re-derived and re-wrote the target, the
     baseline and the per-store goals — including `per_bt`, which is the threshold Progress
     judges a budtender against and pays on. Every value was recomputed from the live screen, so
     nothing errored and the numbers all looked reasonable; a program could simply come out
     settled against a slightly different goal than the one the vendor agreed to. That exact
     class of bug has been paid for here once already, when the save ran its own rounding
     separate from the table's.

     The comparison is deliberately biased toward SENDING. A false "changed" costs one redundant
     column write, which is what happened on every save until now. A false "unchanged" silently
     drops an edit. So anything the canonical form cannot prove identical goes out. */
  function calcModelPatch(prog, payload) {
    var patch = Object.create(null);
    Object.keys(payload).forEach(function (k) {
      var next = payload[k], prev = prog[k];
      if (k === 'stores_json') {
        /* Order carries no meaning here — the registry's order is not the stored order, and
           re-writing six identical ids because they were listed differently is exactly the
           noise this function exists to stop. */
        var a = (next || []).slice().sort().join('|');
        var b = (Array.isArray(prev) ? prev.slice().sort() : []).join('|');
        if (a !== b) patch[k] = next;
        return;
      }
      if (typeof next === 'string') {
        if (String(prev == null ? '' : prev) !== next) patch[k] = next;
        return;
      }
      if (canonJson(next) !== canonJson(prev)) patch[k] = next;
    });
    return patch;
  }

  async function saveCalcProgram() {
    if (!canEdit()) { $('#btnAuth').click(); return; }
    var m = calcModel();
    if (!calc.name) { alert('Give the program a name first.'); return; }

    var payload = calcModelPayload(m);
    var btn = $('#calcSave');

    var patch = null;
    if (calc.editingId) {
      var prog = (state.programs || []).filter(function (x) {
        return x.program_id === calc.editingId;
      })[0];
      /* No stored copy to compare against means we cannot tell what moved, so send everything —
         the same thing this did before, and the safe direction of the two. */
      patch = prog ? calcModelPatch(prog, payload) : payload;
      if (!Object.keys(patch).length) {
        btn.textContent = 'Nothing changed';
        setTimeout(function () { renderCalcEditing(); }, 1800);
        return;
      }
    }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      /* UPDATE when we arrived from a record, CREATE otherwise. Without this the "Edit
         parameters" route silently forked a duplicate off the program Tawny thought she was
         updating, leaving two records with the same name and different numbers — and the
         close-out would have been run against whichever one got opened. */
      var r = calc.editingId
        ? await ENG.jsonp('editProgram', {
            token: (session() || {}).token, id: calc.editingId,
            patch: JSON.stringify(patch)
          })
        : await ENG.jsonp('createProgram', {
            token: (session() || {}).token,
            program: JSON.stringify(payload)
          });
      if (!r || !r.ok) throw new Error((r && r.error) || 'save failed');
      btn.textContent = calc.editingId ? 'Updated' : 'Saved';
      await loadPrograms();
      renderPrograms();
      fillCalcLoad();
    } catch (err) {
      btn.textContent = 'Save failed';
      console.error('[spiff] save program failed:', err);
    }
    setTimeout(function () { renderCalcEditing(); btn.disabled = false; }, 2500);
  }

  function fillCalcLoad() {
    var sel = $('#calcLoad');
    if (!sel) return;
    sel.innerHTML = '<option value="">Start from scratch…</option>'
      + sortPrograms(state.programs).map(function (p) {
        return '<option value="' + esc(p.program_id) + '">' + esc(p.program_name || p.title) + '</option>';
      }).join('');
  }

  /* -------------------------------------------------------------- close-out
   *
   * The loop: send the vendor a report → they credit us against the next buy → we turn
   * that credit into gift cards. The app drafts and files; a human sends.
   */

  function wireReports() {
    $('#repProgram').addEventListener('change', renderReport);
    $('#repBody').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'pdf')   fileReport(b);
      if (b.dataset.act === 'copy')  copyEmail(b);
      if (b.dataset.act === 'print') window.print();
      if (b.dataset.act === 'mailto') openInMail(b);
      if (b.dataset.act === 'cards')  copyCards(b);
      if (b.dataset.act === 'printcards') window.print();
    });
  }

  /* mailto: with the drafted subject and body. Deliberately does NOT send — it opens the
     user's own client with the message in it, which is the whole rule this app follows about
     vendors: a human presses send. Long bodies can exceed what some clients accept from a
     mailto, so the copy button stays the reliable path and says so. */
  function openInMail(btn) {
    var to = ($('#repTo') || {}).value || '';
    var subj = ($('#repSubj') || {}).value || '';
    var body = ($('#repMail') || {}).value || '';
    var url = 'mailto:' + encodeURIComponent(to)
      + '?subject=' + encodeURIComponent(subj)
      + '&body=' + encodeURIComponent(body);
    if (url.length > 1800) {
      btn.textContent = 'Too long — use Copy email';
      setTimeout(function () { btn.textContent = 'Open in mail ↗'; }, 2600);
      return;
    }
    window.location.href = url;
  }

  function copyCards(btn) {
    var rows = $$('#repBody .sp-card-row').map(function (el) {
      return el.querySelector('.sp-card-n').textContent + '\t'
           + el.querySelector('.sp-hist-lbl').textContent + '\t'
           + el.querySelector('.sp-card-v').textContent;
    });
    if (!rows.length) return;
    /* Tab-separated so it pastes into a sheet as columns — the list gets handed to whoever
       buys the cards, and they are not going to retype it. */
    copyText(rows.join('\n'), btn, 'Copy buy list');
  }

  function copyText(text, btn, label) {
    var done = function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = label; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing else to offer */ }
    ta.remove();
  }

  function fillReportPicker() {
    var sel = $('#repProgram');
    if (!sel) return;
    var closed = sortPrograms(state.programs.filter(function (p) { return p.actual_json; }));
    sel.innerHTML = closed.map(function (p) {
      return '<option value="' + esc(p.program_id) + '">' + esc(p.program_name || p.title) + '</option>';
    }).join('');
    if (closed.length) renderReport();
  }

  async function renderReport() {
    var p = state.programs.filter(function (x) { return x.program_id === $('#repProgram').value; })[0];
    var host = $('#repBody');
    if (!p) { host.innerHTML = '<div class="sp-notice">No closed programs yet.</div>'; return; }

    var a    = p.actual_json || {};
    var t    = p.target_json || {};
    var base = p.baseline_json || {};
    var rate = a.spiff_amount || (p.payout_json || {}).amount || 0;
    var cache = progCache && progCache[p.program_id];
    /* Prefer live/cached sell-through over the recorded actuals: a program being closed out
       today may never have had actuals written, and the recorded ones are what the importer
       flagged as possibly copied. */
    var hit   = cache ? cache.hit : (a.bts_hit || 0);
    var sold  = cache ? cache.units : (a.units_sold || 0);
    var owed  = hit * rate;
    var goal  = t.units || 0;
    var before = base.units || 0;
    var cost  = (p.cost_json || {}).per_unit || 0;
    var extra = sold - before;
    var added = extra * cost;
    var net   = added - owed;

    var chip = $('#repStatus');
    if (chip) chip.innerHTML = '<span class="sp-chip is-' + esc(p.status) + '">' + esc(p.status) + '</span>';

    var suspect = a.duplicate_of && a.duplicate_of.length
      ? '<div class="sp-notice is-bad"><span class="sp-notice-l">Check these numbers before sending</span>'
        + 'These actuals are identical to <b>' + esc(a.duplicate_of.join(', ')) + '</b> and may be copied '
        + 'from another tab. A vendor credit built on them would be wrong.</div>'
      : '';

    var mail = { subject: '', body: '' };
    try {
      var r = await ENG.jsonp('emailDraft', { token: (session() || {}).token, id: p.program_id });
      if (r && r.ok) mail = r;
    } catch (e) { console.error('[spiff] email draft failed:', e); }

    /* Per-store rollup for the vendor's table, from the same cached rows the gift list uses. */
    var byStore = Object.create(null);
    (cache && cache.rows || []).forEach(function (row) {
      var g = byStore[row.store_id] || (byStore[row.store_id] = { sold: 0, hit: 0, bts: 0 });
      g.sold += Number(row.units) || 0; g.bts++; if (row.hit) g.hit++;
    });
    var storeIds = Object.keys(byStore);
    var storeRows = storeIds.map(function (id) {
      var g = byStore[id];
      var bBefore = (base.by_store || {})[id] || 0;
      var bGoal   = (t.by_store || {})[id] || 0;
      return '<tr><td>' + esc(storeName(id)) + '</td>'
        + '<td class="num">' + bBefore.toLocaleString() + '</td>'
        + '<td class="num">' + bGoal.toLocaleString() + '</td>'
        + '<td class="num"><b>' + g.sold.toLocaleString() + '</b></td>'
        + '<td class="num">' + g.hit + ' / ' + g.bts + '</td></tr>';
    }).join('');

    host.innerHTML = suspect
      + '<div class="sp-rep-hero">'
      +   '<div><div class="sp-rep-owed-l">The vendor owes</div>'
      +     '<div class="sp-rep-owed-v">' + money(owed) + '</div>'
      +     '<div class="sp-rep-owed-s">' + hit + ' budtender' + (hit === 1 ? '' : 's') + ' &times; ' + money(rate) + '</div></div>'
      +   '<dl class="sp-rep-facts">'
      +     '<dt>Units sold</dt><dd>' + sold.toLocaleString() + '</dd>'
      +     '<dt>Goal</dt><dd>' + goal.toLocaleString()
      +       (goal ? ' <span class="' + (sold >= goal ? 'up' : 'down') + '">' + (sold - goal >= 0 ? '+' : '') + (sold - goal).toLocaleString() + '</span>' : '') + '</dd>'
      +     '<dt>Period</dt><dd>' + (p.start_date ? esc(prettyDay(p.start_date)) + ' → ' + esc(prettyDay(p.end_date || '')) : '—') + '</dd>'
      +     '<dt>Stores</dt><dd>' + (p.stores_json || []).map(function (id) {
              return '<span class="sp-dot" style="--dot:' + esc(storeColor(id)) + '" title="' + esc(storeName(id)) + '"></span>';
            }).join(' ') + '</dd>'
      +   '</dl>'
      +   '<div style="text-align:right"><div class="sp-rep-ret-l">Vendor&rsquo;s return</div>'
      +     '<div class="sp-rep-ret-v">' + (owed ? pctWhole(net / owed) : '—') + '</div>'
      +     '<div class="sp-rep-ret-s">' + money(added) + ' sell-through, net ' + money(net) + '</div></div>'
      + '</div>'

      /* ---- step 1: the artefact the vendor receives */
      + '<div class="sp-step" id="repStep1">'
      +   '<div class="sp-step-h"><span class="sp-step-n">1</span><h4>File the vendor report</h4>'
      +     '<span class="sp-step-note" id="repStep1Note">saved to the SPIFF Reports folder in Drive</span></div>'
      +   '<div class="sp-step-b">'
      +     '<div class="sp-paper" id="printArea">'
      +       '<div class="sp-paper-h"><div class="sp-paper-mark">GC</div>'
      +         '<div class="sp-paper-t"><h3>' + esc(p.program_name || p.title) + ' &mdash; SPIFF results</h3>'
      +           '<p>Green Cross Cannabis Emporium &middot; ' + esc(prettyDay(p.start_date)) + ' &ndash; '
      +             esc(prettyDay(p.end_date || '')) + '</p></div>'
      +         '<div class="sp-paper-credit"><div class="sp-paper-credit-l">Credit requested</div>'
      +           '<div class="sp-paper-credit-v">' + money(owed) + '</div></div></div>'
      +       '<div class="sp-paper-stats">'
      +         paperStat('Units sold', sold.toLocaleString(), goal ? (sold - goal >= 0 ? '+' : '') + (sold - goal).toLocaleString() + ' over goal' : '', sold >= goal)
      +         paperStat('Growth', before ? (extra >= 0 ? '+' : '') + Math.round((extra / before) * 100) + '%' : '—', before ? 'vs. ' + before.toLocaleString() + ' before' : '', extra > 0)
      +         paperStat('Added sell-through', money(added), extra.toLocaleString() + ' extra units', added > 0)
      +         paperStat('Return on SPIFF', owed ? pctWhole(net / owed) : '—', 'net ' + money(net), net > 0)
      +       '</div>'
      +       (storeRows
          ? '<table><thead><tr><th>Store</th><th class="num">Before</th><th class="num">Goal</th>'
            + '<th class="num">Sold</th><th class="num">Hit</th></tr></thead><tbody>' + storeRows
            + '<tr class="tot"><td>Total</td><td class="num">' + before.toLocaleString() + '</td>'
            + '<td class="num">' + goal.toLocaleString() + '</td><td class="num">' + sold.toLocaleString() + '</td>'
            + '<td class="num">' + hit + ' / ' + (cache ? cache.bts : (t.budtenders || 0)) + '</td></tr></tbody></table>'
          : '<p style="color:#5a635f;font-size:11.5px">Per-store detail appears once sell-through has been pulled for this program.</p>')
      +       '<div class="sp-paper-file">SPIFF_Sales Report - ' + esc(p.vendor) + ' - ' + esc(fileStamp(p)) + '.pdf'
      +         (p.contact_name ? ' &middot; prepared for ' + esc(p.contact_name) + ', ' + esc(p.vendor) : '') + '</div>'
      +     '</div>'
      +     '<div class="sp-step-actions">'
      +       '<button class="gx-btn gx-btn-green" data-act="pdf">Save PDF to Drive</button>'
      +       '<button class="gx-btn" data-act="print">Print</button>'
      +     '</div>'
      +   '</div></div>'

      /* ---- step 2: the message a human sends */
      + '<div class="sp-step" id="repStep2">'
      +   '<div class="sp-step-h"><span class="sp-step-n">2</span><h4>Send the vendor email</h4>'
      +     '<span class="sp-step-note">draft &mdash; you send it</span></div>'
      +   '<div class="sp-step-b">'
      +     '<div class="sp-mail-f">'
      +       '<label for="repTo">To</label><input class="sp-in" id="repTo" value="' + esc(p.contact_email || '') + '" placeholder="no contact email on this record">'
      +       '<label for="repSubj">Subject</label><input class="sp-in" id="repSubj" value="' + esc(mail.subject) + '">'
      +     '</div>'
      +     '<textarea class="sp-mail-body" id="repMail">' + esc(mail.body) + '</textarea>'
      +     '<div class="sp-step-actions">'
      +       '<button class="gx-btn" data-act="copy">Copy email</button>'
      +       '<button class="gx-btn" data-act="mailto">Open in mail &#8599;</button>'
      +     '</div>'
      +     '<p class="sp-step-hint">The app cannot email a vendor. Attach the PDF and send it yourself.</p>'
      +   '</div></div>'

      /* ---- step 3: what staff actually get */
      + '<div class="sp-step" id="repStep3">'
      +   '<div class="sp-step-h"><span class="sp-step-n">3</span><h4>Buy the gift cards</h4>'
      +     '<span class="sp-step-note">' + money(owed) + ' &middot; ' + hit + ' card' + (hit === 1 ? '' : 's') + ' at ' + money(rate) + '</span></div>'
      +   '<div class="sp-step-b">' + giftList(p, cache, rate) + '</div></div>';

    var to = $('#repTo');
    if (to && !p.contact_email) to.classList.add('sp-driving');
  }

  function paperStat(label, value, sub, good) {
    return '<div class="sp-paper-s' + (good ? ' is-pos' : '') + '"><div class="sp-paper-s-l">' + esc(label) + '</div>'
      + '<div class="sp-paper-s-v">' + esc(String(value)) + '</div>'
      + '<div class="sp-paper-s-s">' + esc(sub) + '</div></div>';
  }

  /* MMDDYY, matching the filenames already in the SPIFF Reports folder
     (SPIFF_Sales Report - Gron - 092925.pdf) so the close-outs keep sorting together. */
  function fileStamp(p) {
    var d = String(p.end_date || today()).split('-');
    return d.length === 3 ? d[1] + d[2] + d[0].slice(2) : '';
  }

  /* The buy list, by name and store. Only budtenders who actually HIT — paying someone who
     missed is the one thing this program promises not to do. */
  function giftList(p, cache, rate) {
    var winners = (cache && cache.rows || []).filter(function (r) { return r.hit; });
    if (!winners.length) {
      return '<div class="sp-notice"><span class="sp-notice-l">No names yet</span>'
        + 'Pull this program on the Progress tab and the buy list fills in with who earned what.</div>';
    }
    winners.sort(function (x, y) { return String(x.store_id).localeCompare(String(y.store_id)) || String(x.name).localeCompare(String(y.name)); });
    return '<div class="sp-cards">' + winners.map(function (w) {
        return '<div class="sp-card-row" style="--dot:' + esc(storeColor(w.store_id)) + '">'
          + '<span class="sp-dot"></span>'
          + '<span class="sp-card-n">' + esc(w.name) + '</span>'
          + '<span class="sp-hist-lbl">' + esc(storeName(w.store_id)) + '</span>'
          + '<span class="sp-card-v">' + money(w.earned || rate) + '</span></div>';
      }).join('') + '</div>'
      + '<div class="sp-step-actions">'
      +   '<button class="gx-btn" data-act="cards">Copy buy list</button>'
      +   '<button class="gx-btn" data-act="printcards">Print</button>'
      + '</div>';
  }

  async function fileReport(btn) {
    if (!canEdit()) { $('#btnAuth').click(); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var r = await ENG.jsonp('buildReport', { token: (session() || {}).token, id: $('#repProgram').value });
      if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
      btn.textContent = 'Saved to Drive';
      btn.insertAdjacentHTML('afterend', ' <a class="hint" href="' + esc(r.url) + '" target="_blank" rel="noopener">open ' + esc(r.name) + '</a>');
    } catch (err) {
      btn.textContent = 'Failed — ' + (err.message || err);
      console.error('[spiff] report failed:', err);
    }
    setTimeout(function () { btn.disabled = false; }, 1500);
  }

  function copyEmail(btn) {
    var t = $('#repMail');
    t.select();
    try { document.execCommand('copy'); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Select and copy manually'; }
    setTimeout(function () { btn.textContent = 'Copy email'; }, 2000);
  }

  /* --------------------------------------------------------------- history
   *
   * The lookup surface: "what did we run 9 pay periods ago", "last time we did a Wyld
   * SPIFF". Grouped by month so a period reads as a unit, and the same record modal
   * opens from here — this is where legacy records get corrected, so the fix is one
   * click from the thing that looks wrong.
   */

  function wireHistory() {
    ['hSearch', 'hVendor', 'hYear', 'hSuspect'].forEach(function (id) {
      var el = $('#' + id);
      if (el) el.addEventListener('input', renderHistory);
    });
    $('#hList').addEventListener('click', function (e) {
      var row = e.target.closest('[data-id]');
      if (row) openRecord(row.dataset.id);
    });
  }

  function fillHistoryFilters() {
    var vendors = Object.create(null), years = Object.create(null);
    state.programs.forEach(function (p) {
      if (p.vendor) vendors[p.vendor] = 1;
      if (p.start_date) years[p.start_date.slice(0, 4)] = 1;
    });
    $('#hVendor').innerHTML = '<option value="">All vendors</option>'
      + Object.keys(vendors).sort().map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    $('#hYear').innerHTML = '<option value="">All time</option>'
      + Object.keys(years).sort().reverse().map(function (y) { return '<option>' + esc(y) + '</option>'; }).join('');
    renderHistory();
  }

  function renderHistory() {
    var q       = ($('#hSearch').value || '').trim().toLowerCase();
    var vendor  = $('#hVendor').value;
    var year    = $('#hYear').value;
    var suspect = $('#hSuspect').checked;

    var list = state.programs.filter(function (p) {
      var a = p.actual_json;
      if (suspect && !(a && ((a.duplicate_of || []).length || a.rate_changed))) return false;
      if (vendor && p.vendor !== vendor) return false;
      if (year && (p.start_date || '').slice(0, 4) !== year) return false;
      if (q) {
        var hay = ((p.vendor || '') + ' ' + (p.program_name || '') + ' ' + (p.title || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    // Totals answer "what has this vendor cost us and returned" without opening anything.
    var t = list.reduce(function (acc, p) {
      var a = p.actual_json || {};
      acc.units  += a.units_sold || 0;
      acc.spend  += (a.bts_hit || 0) * (a.spiff_amount || (p.payout_json || {}).amount || 0);
      acc.roi    += a.roi || 0;
      return acc;
    }, { units: 0, spend: 0, roi: 0 });

    $('#hStats').innerHTML =
        statTile(list.length.toLocaleString(), list.length === 1 ? 'program on record' : 'programs on record', '')
      + statTile(t.units.toLocaleString(), 'units sold', '')
      + statTile(money(t.spend), 'paid in SPIFF', '')
      + statTile((t.roi >= 0 ? '+' : '') + money(t.roi), 'net return', t.roi < 0 ? 'is-neg' : 'is-pos');

    if (!list.length) {
      $('#hList').innerHTML = '<div class="sp-hist-empty">Nothing matches those filters.</div>';
      return;
    }

    // Group by month — a pay period lives inside one, and it makes "9 periods ago"
    // countable by eye.
    var groups = Object.create(null);   // keys are YYYY-MM, but no map earns a prototype
    sortPrograms(list).forEach(function (p) {
      var k = p.start_date ? p.start_date.slice(0, 7) : 'No period';
      (groups[k] = groups[k] || []).push(p);
    });

    var keys = Object.keys(groups).sort(function (a, b) {
      if (a === 'No period') return 1;
      if (b === 'No period') return -1;
      return b.localeCompare(a);
    });

    /* Each month carries its own totals in the sticky header. Scrolling to "9 periods ago"
       and seeing what that month cost and returned is the question this screen exists for —
       having to add the rows up by eye would defeat it. */
    $('#hList').innerHTML = keys.map(function (k) {
      var g = groups[k];
      var m = g.reduce(function (acc, p) {
        var a = p.actual_json || {};
        acc.spend += (a.bts_hit || 0) * (a.spiff_amount || (p.payout_json || {}).amount || 0);
        acc.roi   += a.roi || 0;
        return acc;
      }, { spend: 0, roi: 0 });
      return '<div class="sp-month"><h3>' + esc(monthLabel(k)) + '</h3>'
        + '<span class="sp-month-sum">' + g.length + ' program' + (g.length === 1 ? '' : 's')
        +   ' &middot; ' + money(m.spend) + ' paid &middot; ' + (m.roi >= 0 ? '+' : '') + money(m.roi) + '</span></div>'
        + '<div class="sp-hist-list">' + g.map(histRow).join('') + '</div>';
    }).join('');
  }


  function monthLabel(k) {
    if (k === 'No period') return 'No period recorded';
    var m = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var parts = k.split('-');
    return m[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  function histRow(p) {
    var a    = p.actual_json || {};
    var rate = a.spiff_amount || (p.payout_json || {}).amount || 0;
    var tgt  = (p.target_json || {}).units || 0;
    var sold = a.units_sold || 0;
    var d    = tgt ? sold - tgt : null;
    var dupe = (a.duplicate_of || []).length;

    var flag = '';
    if (dupe) flag = '<span class="sp-flag is-bad" title="Identical actuals to '
      + esc(a.duplicate_of.join(', ')) + '">actuals match ' + esc(a.duplicate_of.join(', ')) + ' &mdash; verify</span>';
    else if (a.rate_changed) flag = '<span class="sp-flag is-warn">rate ' + money((p.payout_json || {}).amount)
      + ' &rarr; ' + money(a.spiff_amount) + '</span>';

    return '<div class="sp-hist-row' + (dupe ? ' is-suspect' : p.edited_by ? ' is-edited' : '')
      + '" data-id="' + esc(p.program_id) + '" tabindex="0" role="button">'
      + '<div><div class="sp-hist-n">' + esc(p.program_name || p.title)
      +   (p.edited_by ? '<span class="sp-tag-edited">corrected by ' + esc(p.edited_by) + '</span>' : '') + '</div>'
      +   '<div class="sp-hist-s">' + esc(p.vendor) + ' &middot; '
      +     esc(p.start_date ? prettyDay(p.start_date) : '—') + ' &rarr; '
      +     esc(p.end_date ? prettyDay(p.end_date) : '—') + '</div>'
      +   (flag ? '<div>' + flag + '</div>' : '')
      + '</div>'
      + '<div class="num"><b>' + sold.toLocaleString() + '</b> <span class="sp-hist-lbl">sold</span>'
      +   (d == null ? '' : ' <span class="sp-delta ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '') + d.toLocaleString() + '</span>') + '</div>'
      + '<div class="num"><b>' + (a.bts_hit || 0) + '</b> <span class="sp-hist-lbl">hit &times; ' + money(rate) + '</span></div>'
      + '<div class="num sp-money ' + (a.roi < 0 ? 'is-neg' : 'is-pos') + '"><b>'
      +   (a.roi >= 0 ? '+' : '') + money(a.roi) + '</b> <span class="sp-hist-lbl">ROI</span></div>'
      + '</div>';
  }

  /* -------------------------------------------------------------- progress
   *
   * The budtender matrix the SPIFF_Sales Report builds by hand — six Dutchie exports
   * pasted into six tabs. Here it is one call.
   */

  function wireProgress() {
    $('#pgProgram').addEventListener('change', loadProgress);
    /* Refresh means REFRESH: it goes past the cache, or the one control that exists to get newer
       numbers would hand back the same ones it just showed. */
    $('#pgRefresh').addEventListener('click', function () { loadProgress({ force: true }); });
    /* Retry is delegated: the card it lives on is replaced on every repaint. Retrying ONE
       store re-pulls only that store — re-running the whole grid to fix one card would
       throw away five good results and cost another full round of Dutchie calls. */
    $('#pgBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-retry]');
      if (b) pullOneStore(b.dataset.retry);
    });
  }

  function fillProgressPicker() {
    var sel = $('#pgProgram');
    if (!sel) return;
    var list = sortPrograms(state.programs);
    /* The date range rides along with the name. Programs repeat — Meraki Gardens, Mule and
       Hellavated each ran more than once — so the name alone made the picker a guess about
       which one you were opening, and Progress is exactly the screen where the window IS the
       question being asked. */
    sel.innerHTML = list.map(function (p) {
      return '<option value="' + esc(p.program_id) + '">'
        + esc(p.program_name || p.title) + ' · ' + esc(prettyRangeY(p)) + '</option>';
    }).join('');
    /* Default to the RUNNING program, not whatever sorts first. sortPrograms already puts
       active ahead of draft and closed, but being explicit keeps this true if that order ever
       changes — Progress is a screen about the program happening now. */
    var running = list.filter(function (p) { return p.status === 'active'; })[0];
    if (running) sel.value = running.program_id;
  }

  // Cost is per store AND per volume: measured 9s for a quiet store across a whole
  // month, 49s for a busy one, and Google terminates /exec near 60s. So: stores run in
  // parallel, each walking its own date windows sequentially, and the grid fills in as
  // results land instead of blocking on the slowest store.
  var PROGRESS_WINDOW_DAYS = 10;

  function dateWindows(from, to, days) {
    var out = [], cur = from;
    while (cur <= to) {
      var end = addDays(cur, days - 1);
      if (end > to) end = to;
      out.push([cur, end]);
      cur = addDays(end, 1);
    }
    return out.length ? out : [[from, to]];
  }

  function addDays(d, n) {
    var p = d.split('-');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }

  async function pullStore(id, store, windows, onPartial) {
    var merged = null;
    for (var i = 0; i < windows.length; i++) {
      var r = await ENG.jsonp('sellthrough',
        { token: (session() || {}).token, id: id, store: store, from: windows[i][0], to: windows[i][1] },
        { timeoutMs: 65000, retries: 1 });
      if (!r || !r.ok) throw new Error((r && r.error) || 'failed');
      merged = merged ? mergeWindow(merged, r) : r;
      if (onPartial) onPartial(merged);
    }
    return merged;
  }

  // Same person can appear in several windows; sum them, then re-decide who hit.
  function mergeWindow(a, b) {
    /* Keyed on the budtender NAME from Dutchie -- data we do not control. On a plain object,
       k="constructor" makes `!by[k]` false because the INHERITED member is truthy, so the
       initialiser is skipped and the += lands on the Object constructor itself. This is the
       frontend twin of the same merge in the engine; both are null-prototype now. */
    var by = Object.create(null);
    a.rows.concat(b.rows).forEach(function (e) {
      var k = e.name;
      if (!by[k]) by[k] = { name: e.name, employee_id: e.employee_id, store_id: e.store_id, units: 0, revenue: 0, target: e.target };
      by[k].units   += e.units;
      by[k].revenue += e.revenue;
    });
    var rows = Object.keys(by).map(function (k) { return by[k]; });
    var hit = 0, units = 0;
    rows.forEach(function (e) {
      e.hit = e.target > 0 && e.units >= e.target;
      if (e.hit) hit++;
      units += e.units;
    });
    rows.sort(function (x, y) { return y.units - x.units; });
    return { ok: true, store_id: a.store_id, from: a.from, to: b.to, target: a.target, rate: a.rate,
             rows: rows, units: units, hit: hit, budtenders: rows.length };
  }

  /* Kept so Refresh and a per-store Retry can re-enter without re-picking the program. */
  var pgRun = null;

  /* ── A CLOSED PROGRAM'S NUMBERS CANNOT CHANGE, SO STOP RE-BUYING THEM ──
     Sky, 2026-08-31: "it would be smart to cache the previous program progress data for quicker
     load times, it's not a lot of data to save." Opening a past program costs six stores' worth of
     Dutchie windows — measured 9s for a quiet store and 49s for a busy one — to arrive at figures
     that have not moved since the day it closed.

     ONLY CLOSED PROGRAMS ARE CACHED, and that is the whole safety argument. A draft or an active
     one is a live measurement whose value IS its freshness; serving yesterday's ticks for a running
     SPIFF is the same class of error as the kiosk drawing on a closed one.

     DELIBERATELY BROWSER-LOCAL, not written back to the shared `spiff_progress` cache. That cache
     is what GX Crew pays people from and what the Leaderboard kiosks draw, and the only way for a
     browser to fill it would be a route that accepts client-supplied earnings — a page could then
     post any number it liked into a payroll screen. The engine already refreshes a named closed
     program server-side when a vendor report needs one (refreshSpiffProgress_ takes `only`
     whatever the status); this is a convenience in front of that, not a replacement for it. */
  var PG_CACHE_KEY = 'gx.spiff.progress.v1';
  var PG_CACHE_MAX = 12;                  // a dozen programs of six store rows — kilobytes

  function pgCacheRead(id) {
    try {
      var all = JSON.parse(localStorage.getItem(PG_CACHE_KEY) || '{}');
      var hit = all[id];
      /* Tied to the WINDOW as well as the id. A program whose dates were corrected is a different
         measurement, and silently serving the old one under the new window is precisely the kind
         of wrong-but-plausible number this app exists to stop. */
      return hit && hit.v === 1 ? hit : null;
    } catch (e) { return null; }          // private mode, cleared storage, quota — all mean "no cache"
  }

  function pgCacheWrite(prog, results) {
    try {
      var all = JSON.parse(localStorage.getItem(PG_CACHE_KEY) || '{}');
      all[prog.program_id] = { v: 1, at: new Date().toISOString(),
                               from: prog.start_date, to: prog.end_date, results: results };
      var keys = Object.keys(all);
      if (keys.length > PG_CACHE_MAX) {
        keys.sort(function (a, b) { return String(all[a].at) < String(all[b].at) ? -1 : 1; })
            .slice(0, keys.length - PG_CACHE_MAX)
            .forEach(function (k) { delete all[k]; });
      }
      localStorage.setItem(PG_CACHE_KEY, JSON.stringify(all));
    } catch (e) { /* a cache that cannot be written is not an error worth showing anybody */ }
  }

  async function loadProgress(opts) {
    var id = $('#pgProgram').value;
    if (!id) return;
    var prog = state.programs.filter(function (x) { return x.program_id === id; })[0];
    if (!prog) return;
    if (!prog.start_date || !prog.end_date) {
      $('#pgBody').innerHTML = '<div class="sp-notice is-warn"><span class="sp-notice-l">No dates</span>'
        + 'This program has no date range. Set start and end dates on its record first.</div>';
      $('#pgStats').innerHTML = ''; $('#pgNote').textContent = '';
      return;
    }

    var stores  = prog.stores_json || [];
    var windows = dateWindows(prog.start_date, prog.end_date, PROGRESS_WINDOW_DAYS);
    var force   = !!(opts && opts.force);

    /* A closed program we have already measured, on the same window, renders straight away. */
    var cached = (!force && prog.status === 'closed') ? pgCacheRead(id) : null;
    if (cached && cached.from === prog.start_date && cached.to === prog.end_date
        && stores.every(function (st) { return cached.results[st]; })) {
      pgRun = { prog: prog, id: id, windows: windows, stores: stores,
                results: cached.results, failed: Object.create(null),
                pulling: Object.create(null), done: true, cachedAt: cached.at };
      renderPgLive(prog, windows, stores);
      paintProgress();
      return;
    }

    pgRun = { prog: prog, id: id, windows: windows, stores: stores,
              results: Object.create(null), failed: Object.create(null), pulling: Object.create(null) };
    stores.forEach(function (st) { pgRun.pulling[st] = 1; });

    renderPgLive(prog, windows, stores);
    paintProgress();

    await Promise.all(stores.map(function (st) { return pullOneStore(st); }));
    pgRun.done = true;
    paintProgress();

    /* Saved only when the program is closed AND every store came back. A part-failed pull cached
       would freeze one store's error into the record of a program that is finished — and the
       missing store would look like a store that sold nothing. */
    if (prog.status === 'closed' && !Object.keys(pgRun.failed).length
        && stores.every(function (st) { return pgRun.results[st]; })) {
      pgCacheWrite(prog, pgRun.results);
    }
  }

  /* One store's pull, isolated. Its own catch means a store that fails takes its own card
     down and nothing else -- the whole point of per-store failure. */
  async function pullOneStore(st) {
    if (!pgRun) return;
    var run = pgRun;
    delete run.failed[st];
    run.pulling[st] = 1;
    paintProgress();
    try {
      var r = await pullStore(run.id, st, run.windows, function (partial) {
        if (pgRun !== run) return;         // a newer pull started; drop this one's paint
        run.results[st] = partial;
        run.pulling[st] = run.windows.length > 1 ? 1 : 0;
        paintProgress();
      });
      if (pgRun !== run) return;
      run.results[st] = r;
    } catch (err) {
      if (pgRun !== run) return;
      run.failed[st] = err.message || String(err);
    }
    delete run.pulling[st];
    paintProgress();
  }

  function renderPgLive(prog, windows, stores) {
    var live = $('#pgLive');
    if (live) {
      var running = prog.status === 'active';
      var left = running && prog.end_date ? ' · ' + daysLeftLabel(prog.end_date) : '';
      live.innerHTML = running
        ? '<span class="sp-pg-live"><span class="sp-live-dot"></span>running' + esc(left) + '</span>'
        : '<span class="sp-chip is-' + esc(prog.status) + '">' + esc(prog.status) + '</span>';
    }
    var pulled = $('#pgPulled');
    if (pulled) pulled.textContent = 'Dutchie, ' + stores.length + ' store'
      + (stores.length === 1 ? '' : 's') + ' × ' + windows.length + ' window'
      + (windows.length === 1 ? '' : 's');
  }

  function paintProgress() {
    if (!pgRun) return;
    var run = pgRun, prog = run.prog, stores = run.stores;
    var rate = (prog.payout_json || {}).amount || 0;
    var target = (prog.target_json || {}).units || 0;
    var plannedBts = (prog.target_json || {}).budtenders || 0;

    var units = 0, hit = 0, bts = 0, back = 0;
    stores.forEach(function (st) {
      var r = run.results[st];
      if (!r) return;
      units += r.units; hit += r.hit; bts += r.budtenders;
      if (!run.pulling[st] && !run.failed[st]) back++;
    });
    var btsAll = plannedBts || bts;

    /* Totals cover only the stores that came back. Saying so is not a nicety -- an
       undercount that looks authoritative is how a vendor gets billed the wrong number. */
    $('#pgStats').innerHTML =
        pgStat(units.toLocaleString() + ' <small>/ ' + target.toLocaleString() + '</small>',
               'units sold', target ? units / target : 0, '')
      + pgStat(hit + ' <small>/ ' + btsAll + '</small>', 'budtenders at their target',
               btsAll ? hit / btsAll : 0, '')
      + pgStat(money(hit * rate), 'earned so far, ' + hit + ' × ' + money(rate), null, 'is-pos')
      + pgStat(money(btsAll * rate), 'if everyone lands it', null, '');

    var missing = stores.length - back;
    /* SAY WHEN THE NUMBERS ARE REMEMBERED RATHER THAN MEASURED. A cached figure and a live one
       look identical on screen, and "is this current?" is the first question anyone asks of a
       progress grid — so the answer is on it, next to the control that re-pulls. */
    var cachedNote = pgRun && pgRun.cachedAt
      ? ' · <b>saved figures</b> from ' + esc(String(pgRun.cachedAt).slice(0, 10))
        + ' — this program is closed, so they cannot have moved. Refresh re-pulls from Dutchie.'
      : '';
    $('#pgNote').innerHTML = esc(prettyDay(prog.start_date)) + ' → ' + esc(prettyDay(prog.end_date))
      + ' · green means that person has already earned the bounty.'
      + (missing > 0
          ? ' Totals cover the ' + back + ' store' + (back === 1 ? '' : 's') + ' that ' + (back === 1 ? 'has' : 'have') + ' come back.'
          : '')
      + cachedNote;

    $('#pgBody').innerHTML = '<div class="sp-pg-grid">' + stores.map(pgCard).join('') + '</div>';

    /* The Programs hero reads the same run, so it has to repaint as stores land — otherwise the
       landing page keeps showing an empty bar while Progress fills in behind it. Guarded on the
       panel existing rather than on which tab is showing: repainting a hidden panel is cheap and
       means switching back to Programs never shows a stale hero. */
    if ($('#progRunning') && state.programs.length) renderPrograms();
  }

  function pgStat(value, label, frac, cls) {
    return '<div class="sp-pgstat ' + cls + '"><div class="sp-pgstat-v">' + value + '</div>'
      + '<div class="sp-pgstat-l">' + esc(label) + '</div>'
      + (frac == null ? ''
         : '<div class="sp-pgstat-bar"><i style="width:' + Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%"></i></div>')
      + '</div>';
  }

  function pgCard(st) {
    var run = pgRun;
    var col = storeColor(st), name = storeName(st);
    var head = '<span class="sp-dot"></span><b>' + esc(name) + '</b>';

    /* FAILED -- keeps its own card and its own retry. The other five stay live. */
    if (run.failed[st]) {
      return '<div class="sp-pgcard is-failed" style="--dot:' + esc(col) + '">'
        + '<div class="sp-pgcard-h"><div class="sp-pgcard-t">' + head
        +   '<span class="sp-pgcard-state is-bad">failed</span></div></div>'
        + '<div class="sp-pg-fail"><p>' + esc(run.failed[st])
        +   ' Totals above exclude ' + esc(name) + ', so they undercount.</p>'
        +   '<button class="gx-btn" data-retry="' + esc(st) + '">Retry this store</button></div>'
        + '</div>';
    }

    var r = run.results[st];

    /* PULLING with nothing yet -- skeleton geometry matching a real card, so the layout
       does not jump when the data lands. No spinner, no "Loading…" string. */
    if (!r) {
      return '<div class="sp-pgcard" style="--dot:' + esc(col) + '">'
        + '<div class="sp-pgcard-h"><div class="sp-pgcard-t">' + head
        +   '<span class="sp-pgcard-state">pulling…</span></div>'
        +   '<div class="sp-pgbar is-pulling"><i style="width:50%"></i></div>'
        +   '<div class="sp-pgcard-f"><span>pulling from Dutchie…</span><span></span></div></div>'
        + '<div class="sp-pgcard-b">'
        +   '<div class="sp-skel" style="height:34px;margin:2px"></div>'
        +   '<div class="sp-skel" style="height:34px;margin:2px"></div>'
        +   '<div class="sp-skel" style="height:34px;margin:2px"></div>'
        + '</div></div>';
    }

    var partial = !!run.pulling[st];
    var per = r.target || 0;
    var goal = per * (r.budtenders || 0);
    var frac = goal ? r.units / goal : 0;
    var ahead = goal ? r.units >= goal : false;

    var rows = r.rows.length
      ? r.rows.map(function (e) {
          var short = (e.target || 0) - e.units;
          return '<div class="sp-bt' + (e.hit ? ' is-hit' : '') + '">'
            + '<span class="sp-bt-av">' + esc(initials(e.name)) + '</span>'
            + '<span class="sp-bt-n" title="' + esc(e.name) + '">' + esc(e.name) + '</span>'
            + (!e.hit && short > 0 ? '<span class="sp-bt-d">&minus;' + short + '</span>' : '')
            + '<span class="sp-bt-u">' + e.units.toLocaleString() + '</span>'
            + '</div>';
        }).join('')
      : '<div class="sp-bt"><span class="sp-bt-n">No matching sales yet</span></div>';

    return '<div class="sp-pgcard' + (ahead ? ' is-ahead' : '') + '" style="--dot:' + esc(col) + '">'
      + '<div class="sp-pgcard-h"><div class="sp-pgcard-t">' + head
      +   '<span class="sp-pgcard-u">' + r.units.toLocaleString() + ' units</span></div>'
      +   '<div class="sp-pgbar' + (partial ? ' is-pulling' : '') + '"><i style="width:'
      +     Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%"></i></div>'
      +   '<div class="sp-pgcard-f">'
      +     '<span class="' + (r.hit === r.budtenders && r.budtenders ? 'done' : '') + '">'
      +       r.hit + ' of ' + r.budtenders + ' hit</span>'
      +     '<span>' + (per ? per + ' each' : '') + '</span></div></div>'
      + '<div class="sp-pgcard-b">' + rows + '</div>'
      + '</div>';
  }

  /* Two initials from a Dutchie name. Names arrive as "Zach B" or "Zach Bradley" and
     occasionally as one word, which must not produce an empty circle. */
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* ------------------------------------------------------------------ boot */
  /* Chrome is not session state: start the clock and load store colors at boot so the header is
     never showing placeholder dashes, signed in or out. */
  function startChrome() {
    if (window.GXTopNav) GXTopNav.startClock();
    if (window.GXStores) GXStores.load(GXCORE).catch(function () { /* colors are a nicety */ });
  }

  /* Full-page sign-in gate. SPIFF holds compensation data, and it is heading INSIDE Inventory the way
     Price Cards did -- so it should behave like the apps it will live beside, not like a public page
     with an optional login. Uses the shared .gx-login, so it is the same sign-in as everywhere else. */
  function renderGate(errMsg) {
    document.body.classList.add('is-gated');
    var wrap = document.getElementById('authGate');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'authGate'; document.body.appendChild(wrap); }
    wrap.className = 'gx-login';
    wrap.innerHTML =
      '<div class="gx-login-card">' +
        '<div class="gx-login-head">' +
          '<img class="gx-login-mark" src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">' +
          '<div class="gx-login-sub">SPIFF</div>' +
        '</div>' +
        '<form class="gx-login-form" id="gateForm">' +
          '<label class="gx-login-field"><span>Username</span>' +
            '<input class="gx-input" id="gateUser" autocomplete="username" required></label>' +
          '<label class="gx-login-field"><span>Password</span>' +
            '<input class="gx-input" id="gatePass" type="password" autocomplete="current-password" required></label>' +
          '<button type="submit" class="gx-btn gx-btn-green gx-login-submit">Sign in</button>' +
          '<div class="gx-login-err">' + (errMsg || '') + '</div>' +
          // Nested, say WHY the host's session did not carry over. Inside an iframe a console
          // message is effectively invisible, and "just sign in again" hides a real failure.
          (GXTopNavEmbedded() && state.gateReason
            ? '<div style="margin-top:10px;font-size:11px;color:var(--gx-text-mute)">nested sign-in: '
              + state.gateReason + '</div>'
            : '') +
        '</form>' +
      '</div>';
    document.getElementById('gateForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = wrap.querySelector('button'), err = wrap.querySelector('.gx-login-err');
      var u = document.getElementById('gateUser').value.trim();
      var pw = document.getElementById('gatePass').value;
      btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
      try {
        var r = await GX.jsonp('login', { user: u, pass: pw, app: APP });
        // Branch on `code`, NEVER on `error`. GX Core v164 ships `error` as human prose it
        // reserves the right to reword, and `code` as the contract that will not change.
        // no_access means the password was RIGHT and there is simply no grant on SPIFF --
        // showing "Invalid username or password" there sends a legitimate user off to retry
        // a password that can never work.
        if (r && r.code === 'no_access') { wrap.remove(); renderNoAccess(u); return; }
        if (!r || !r.ok) throw new Error((r && r.error) || 'Sign-in failed');
        setSession({ user: r.user, name: r.displayName || r.user, avatar: r.avatarConfig || null,
                     role: r.role, token: r.token, expiresAt: r.expiresAt });
        wrap.remove();
        document.body.classList.remove('is-gated');
        start();
      } catch (e) {
        err.textContent = (e && e.message) || 'Sign-in failed';
        btn.disabled = false; btn.textContent = 'Sign in';
        document.getElementById('gatePass').value = '';
      }
    });
    document.getElementById('gateUser').focus();
  }

  /* The dead end this closes: a user who IS signed in, whose token is perfectly valid, and who
     simply holds no grant on SPIFF. Before GX Core v164 that was indistinguishable from a bad
     token, so the only thing we could do was show the sign-in gate -- which invites them to sign
     in again, succeed again, and land right back here. A loop that blames the user for a config
     gap. GX Core now returns code:"no_access" for exactly this case, so we can say the true
     thing instead: your sign-in worked, the grant is missing, here is who fixes it. */
  function renderNoAccess(who) {
    document.body.classList.add('is-gated');
    var gate = document.getElementById('authGate');
    if (gate) gate.remove();
    var wrap = document.createElement('div');
    wrap.id = 'noAccess';
    wrap.className = 'gx-login';
    wrap.innerHTML =
      '<div class="gx-login-card">' +
        '<div class="gx-login-head">' +
          '<img class="gx-login-mark" src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">' +
          '<div class="gx-login-sub">SPIFF</div>' +
        '</div>' +
        '<div class="noaccess-body">' +
          '<p class="noaccess-lead">You are signed in' + (who ? ' as <strong>' + esc(who) + '</strong>' : '') +
            ', but your account has not been granted SPIFF.</p>' +
          '<p class="noaccess-note">Nothing is wrong with your password. Access is granted per app in ' +
            'the GX Command Center &mdash; ask Sky to add SPIFF to your account, then reload.</p>' +
          '<button class="gx-btn" id="naOther">Sign in as someone else</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.getElementById('naOther').addEventListener('click', function () {
      clearSession();
      wrap.remove();
      renderGate();
    });
  }

  function GXTopNavEmbedded() {
    try { return window.GXTopNav ? GXTopNav.isEmbedded() : (window.self !== window.top); }
    catch (e) { return true; }
  }

  async function boot() {
    startChrome();
    // Gate FIRST: nothing loads and no request goes out until there is a session.
    if (session()) { start(); return; }

    /* Nested, inherit the host's sign-in rather than asking again. Different origin means separate
       storage, so without this a user signs in to Inventory and then again to SPIFF to reach one
       screen. The token is GX Core's and validates here because the signing secret is shared.
       Resolves null when standalone or when the host has no session, and then the gate shows. */
    if (window.GXSession) {
      var inherited = await GXSession.request(6000);
      if (inherited && inherited.token) {
        /* Deliberately do NOT copy the host's expiresAt. The host may have been signed in longer than
           its own token is valid for -- Inventory never enforces expiry -- and SPIFF's session() self-
           expires on that field, which would adopt the session and then drop it a moment later. The
           BACKEND is the authority on whether a token is still good: if it is not, the first call
           returns needsAuth and the gate appears with a real reason. */
        setSession({ user: inherited.user, name: inherited.displayName || inherited.user,
                     avatar: inherited.avatarConfig || null, role: inherited.role,
                     token: inherited.token });
        start();
        confirmInheritedGrant(inherited.token, inherited.user);
        return;
      }
      state.gateReason = inherited ? 'host replied with no token' : 'no reply from host';
    } else {
      state.gateReason = 'gx-session.js not loaded';
    }
    if (!GXTopNavEmbedded()) state.gateReason = 'standalone';
    // If the app is already running, never replace it with a gate. A late or duplicate boot showing
    // the login over a working screen is exactly the "it disappears then comes back" symptom.
    if (_started) return;
    renderGate();
  }

  /* Inheriting the host's token is AUTHENTICATION and never becomes AUTHORIZATION: it proves who
     the user is, not that they hold SPIFF. Inventory now gates the tab on the grant, so a
     no-grant user reaching us is rare -- revoked mid-session, or a host that nests without
     gating -- and this is the belt to that braces.

     Deliberately NON-BLOCKING, and fired AFTER start(). core-admin measured the grants round trip
     at ~7 SECONDS against the live two-hop /exec; making every boot wait on it to catch the rare
     case would tax everyone for the exception. So: start now, swap to the panel if the answer
     comes back no_access. Any OTHER outcome -- expired, invalid, Core unreachable -- is left
     alone on purpose. Those are the gate's business, and the write path already fails closed on
     them via gxAuth_; blanking a working screen because Core hiccuped is the failure mode we
     avoid everywhere else in the suite. */
  function confirmInheritedGrant(token, who) {
    GX.jsonp('validate', { app: APP, token: token }).then(function (r) {
      if (r && r.code === 'no_access') { clearSession(); renderNoAccess(who); }
    }).catch(function () { /* unreachable Core is not a no_access answer */ });
  }

  /* ------------------------------------------------------------ bug report
   * The button, the modal and the context snapshot are gx-theme's gx-bugreport.js. This is only
   * the wiring: who is reporting, what they were looking at, and how this app talks to its own
   * engine. No markup and no CSS here on purpose — .gx-bug-* is already in gx-theme.css, and a
   * local rule that beat it would quietly become the sixth private copy of a shared component.
   *
   * BUCKETING. `app` is 'spiff'. It was 'inventory' until 2026-08-27, on the reasoning that SPIFF is
   * an Inventory sub-app — true of the product, false of the bug board. GX Core's getBugs filters
   * strictly on `b.app === a` with no tab fallback, so ?action=bugs&app=spiff returned zero every
   * time while the linked note still arrived in the spiff chat: this app was told about bugs it
   * could not see. Price Cards already filed under its own key; the two now match.
   *
   * The ENGINE hardcodes app and tab (see reportBug_) and is the only thing that actually routes
   * anything: gx-bugreport.js documents `app` but never puts it in the payload, so the value here is
   * declaration, not transport. Changing it alone would have done NOTHING — the engine is the fix.
   * Keep it truthful anyway; the next person to read it will believe it.
   *
   * WHICH PANEL rides in the CONTEXT as `panel`, never as `tab`. `tab` is what GX Core buckets on,
   * and sending 'history' up there would file the report against an Inventory tab that does not
   * exist. The engine ignores any client-sent tab for exactly that reason.
   *
   * Guarded and idempotent, like the rest of the shared-script wiring: gx-bugreport.js loads by URL
   * from Pages behind a ~10-minute cache, so there is always a window where this app has shipped
   * and the layer it calls has not arrived. Called from start() AND from the end of the load chain,
   * so a late arrival still gets wired instead of being missed forever by one early attempt.
   */
  var _bugWired = false;
  function initBugReport() {
    if (_bugWired || !window.GXBugReport || !GXBugReport.init) return;
    GXBugReport.init({
      app:      'spiff',          // its own board — see above
      action:   'bugreport',       // must match the engine's doGet case
      /* Nested in Inventory, the host already paints a 🐞 in this exact corner, and its report
         lands in the SAME bucket: Inventory's handler maps only 'pricetags' to another app, so a
         bug filed from its SPIFF tab falls through to app=inventory / tab='spiff' too. Two
         identical floating buttons stacked on each other is worse than one. Standalone — Tawny's
         own Pages URL — ours is the only reporter on the page. */
      fab:      !GXTopNavEmbedded(),
      version:  function () { return APP_VERSION; },
      reporter: function () { return (session() || {}).user || ''; },
      context:  function () {
        return {
          subapp:   'spiff',
          panel:    state.tab || '',
          programs: state.programs.length,
          canEdit:  canEdit() ? 'yes' : '',
          embedded: GXTopNavEmbedded() ? 'yes' : ''
        };
      },
      /* Screenshot upload. Note this app's own comment below about writes riding on GET: a ~273KB
         base64 could never travel that way, which is why the image goes up on its own call. Still
         no second auth path — the shared uploader is handed THIS app's token. */
      uploadShot: GXBugReport.gxCoreUploader(GXCORE, function () {
        try { return (session() || {}).token || ''; } catch (e) { return ''; }
      }),
      submit: function (payload) {
        /* This app's own authenticated path, which is the point of `submit` being a function:
           the shared script never handles a token, so there is no second auth path to keep
           correct. Writes ride on GET here — JSONP is GET-only and Apps Script serves no CORS
           headers for POST. */
        var params = { token: (session() || {}).token };
        Object.keys(payload).forEach(function (k) { if (k !== 'action') params[k] = payload[k]; });
        return ENG.jsonp(payload.action, params, { timeoutMs: 20000, retries: 1 });
      }
    });
    // Stale-build toast. Same auth check as the reporter above: no point prompting a reload
    // behind a login overlay that covers the toast anyway.
    GXUpdateCheck.init({
      app:      'spiff',
      gxcore:   GXCORE,
      version:  function () { return APP_VERSION; },
      isAuthed: function () { try{return !!(session()||{}).token;}catch(e){return false;} },
    });
    _bugWired = true;
  }

  var _started = false;
  function start() {
    if (_started) return;   // never re-enter: a second pass would rewire every handler
    _started = true;
    wireAuthChip();     // first: every write path depends on it
    renderAuthChip();
    wireTabs();
    wirePrograms();
    wireCalculator();
    wireReports();
    wireHistory();
    wireProgress();
    showTab('programs');
    initBugReport();
    /* PARALLEL, and the chain it replaces is why this screen took thirty seconds.
       Each of these answers in 2-3s on its own, but they ran nose-to-tail — and worse, they ran
       BEHIND loadShared, which hits GX Core. When Core's stores call goes quiet, GXClient makes
       five attempts at an 8s timeout: forty seconds of nothing, with programs and the progress
       cache queued up behind a call whose only job is store names and colors.

       The old note here said sequential was deliberate, because two GXClients in one tick had
       once collided on a shared callback name. That was fixed: gx-client mints
       `__gx_<per-instance nonce>_<timestamp>_<counter>`, so two instances cannot collide. The
       caution outlived the bug.

       Each load renders as it lands, so the page fills in progressively instead of waiting for
       the slowest. Stores get a tighter budget than the default: they only decorate the screen,
       and they must never be the reason nothing appears on it. */
    renderProgramsSkeleton();

    var sharedP   = loadShared({ timeoutMs: 6000, retries: 1 }).then(calcInit);
    var programsP = loadPrograms().then(function () {
      fillCalcLoad(); fillReportPicker(); fillHistoryFilters(); fillProgressPicker();
    });
    var cacheP    = loadProgressCache();

    Promise.all([sharedP, programsP, cacheP]).then(function () {
      /* Re-render once everything is in: programs may have painted before store colors
         arrived, and the hero needs both to be complete. */
      renderPrograms();
      initBugReport();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for the engine wiring that follows (see /gxwhatsnext for the build order).
  window.SPIFF = { state: state, GX: GX, app: APP, engine: function () { return ENGINE; } };

})();
