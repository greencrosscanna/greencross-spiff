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
  async function loadShared() {
    try {
      var s = await GX.jsonp('stores', {});
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
  var progFilter = { q: '', scope: 'active', store: '' };

  /* state.stores is the registry GX Core just handed us, so it is preferred over GXStores --
     GXStores.load() is fired off at boot and may not have answered yet, and a store rendering
     grey for the first second reads as a broken colour rather than a slow one. GXStores stays
     as the fallback so a store missing from this app's payload still gets its suite colour. */
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

  /* Store pills come from the GX Core registry, so a store added in Command Center shows up
     here on the next load with its own colour. The count is programs touching that store. */
  function renderStorePills() {
    var host = $('#progStores');
    if (!host) return;
    var tally = {};
    state.programs.forEach(function (p) {
      (p.stores_json || []).forEach(function (sid) { tally[sid] = (tally[sid] || 0) + 1; });
    });
    host.innerHTML = state.stores.map(function (st) {
      var id = st.store_id, n = tally[id] || 0;
      return '<button type="button" class="sp-pill' + (progFilter.store === id ? ' is-on' : '')
        + '" data-store="' + esc(id) + '" style="--dot:' + esc(st.color || '#5e6864') + '">'
        + '<span class="sp-dot"></span>' + esc(st.display_name || id)
        + '<span class="sp-pill-n">' + n + '</span></button>';
    }).join('');
  }

  function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }

  /* Search and store still narrow the closed tail — only the STATUS scope is ignored for it.
     Typing a vendor and still seeing unrelated closed programs would read as a broken search. */
  function progMatchesExceptScope(p) {
    if (progFilter.store && (p.stores_json || []).indexOf(progFilter.store) < 0) return false;
    if (progFilter.q) {
      var hay = ((p.program_name || '') + ' ' + (p.vendor || '') + ' ' + (p.title || '')).toLowerCase();
      if (hay.indexOf(progFilter.q) < 0) return false;
    }
    return true;
  }

  function progMatches(p) {
    if (progFilter.scope !== 'all' && p.status !== progFilter.scope) return false;
    if (progFilter.store && (p.stores_json || []).indexOf(progFilter.store) < 0) return false;
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
  function paceOf(p) {
    var a = p.actual_json || {}, tgt = (p.target_json && p.target_json.units) || 0;
    var sold = a.units_sold || 0;
    var frac = tgt ? sold / tgt : 0;
    var elapsed = null;
    if (p.start_date && p.end_date) {
      var d0 = Date.parse(p.start_date), d1 = Date.parse(p.end_date), now = Date.now();
      if (d1 > d0) elapsed = Math.max(0, Math.min(1, (now - d0) / (d1 - d0)));
    }
    return { frac: frac, elapsed: elapsed, sold: sold, target: tgt,
             ahead: elapsed == null ? frac >= 1 : frac >= elapsed };
  }

  function renderPrograms() {
    var empty = $('#programsEmpty');
    var stats = $('#progStats'), run = $('#progRunning'), closed = $('#progClosed');
    if (!stats) return;

    if (!state.programs.length) {
      empty.hidden = false;
      stats.innerHTML = ''; run.innerHTML = ''; closed.innerHTML = '';
      return;
    }
    empty.hidden = true;
    renderStorePills();

    var all      = state.programs;
    var visible  = sortPrograms(all.filter(progMatches));
    var running  = all.filter(function (p) { return p.status === 'active'; });
    var needCheck = all.filter(function (p) {
      var a = p.actual_json;
      return a && ((a.duplicate_of && a.duplicate_of.length) || a.rate_changed);
    }).length;

    /* ---- stat strip. Only figures carrying a judgement take a colour. */
    var atStake = running.reduce(function (n, p) {
      var pay = (p.payout_json && p.payout_json.amount) || 0;
      return n + pay * ((p.target_json && p.target_json.budtenders) || 0);
    }, 0);
    var netReturn = all.reduce(function (n, p) { return n + ((p.actual_json && p.actual_json.roi) || 0); }, 0);
    var closedN = all.filter(function (p) { return p.status === 'closed'; }).length;

    stats.innerHTML =
        statTile(running.length, 'running now', '')
      + statTile(money(atStake), 'at stake for budtenders', '')
      + statTile((netReturn >= 0 ? '+' : '') + money(netReturn), 'net return, ' + all.length + ' programs',
                 netReturn >= 0 ? 'is-pos' : 'is-neg')
      + statTile(needCheck, 'records need checking', needCheck ? 'is-warn' : '');

    /* ---- the one running program, as a hero.
       The hero obeys the filter like everything else. It used to render unconditionally, which
       meant searching "kaprikorn" left the Wyld hero sitting on top of the one matching row,
       and picking scope=Closed showed an ACTIVE program under a Closed filter -- the screen
       contradicting the control the user had just set. */
    var heroes = running.filter(progMatches);
    run.innerHTML = heroes.map(heroCard).join('');

    /* ---- everything else, dense.
       Under the default "Active" scope this is a TAIL, not the filtered list: the running
       program is the answer to "how are we doing", and the last few closed ones are the
       context for it. Filtering them out entirely (which "Active" literally means) would
       leave the screen looking like the app has one program in it. Pick any other scope and
       this becomes the real filtered list. */
    var TAIL = 3;
    var tail = progFilter.scope === 'active';
    var rest = tail
      ? sortPrograms(all.filter(function (p) {
          return p.status !== 'active' && progMatchesExceptScope(p);
        })).slice(0, TAIL)
      : visible.filter(function (p) { return p.status !== 'active'; });

    var heading = tail ? 'Closed' : (progFilter.scope === 'all' ? 'All programs' : cap(progFilter.scope));
    var note = tail
      ? closedN + ' program' + (closedN === 1 ? '' : 's')
      : rest.length + ' program' + (rest.length === 1 ? '' : 's');

    closed.innerHTML = rest.length
      ? '<div class="sp-head"><h2>' + heading + '</h2>'
        + '<span class="sp-head-note">' + note + '</span>'
        + '<a class="sp-head-link" href="#" data-goto="history">see all in History</a></div>'
        + '<div class="sp-list">' + rest.map(listRow).join('') + '</div>'
      : (heroes.length ? '' : '<div class="sp-notice">Nothing matches that filter. '
          + closedN + ' closed program' + (closedN === 1 ? '' : 's') + ' in History.</div>');
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

  function heroCard(p) {
    var a = p.actual_json || {}, t = p.target_json || {}, pay = (p.payout_json && p.payout_json.amount) || 0;
    var cost = p.cost_json || {};
    var pace = paceOf(p);
    var bts = t.budtenders || 0;
    var hit = a.bts_hit || 0;

    var stores = (p.stores_json || []).map(function (sid) {
      return '<span class="sp-store-tag" style="--dot:' + esc(storeColor(sid)) + '">'
           + '<span class="sp-dot"></span>' + esc(storeName(sid)) + '</span>';
    }).join('');

    /* Days left, said plainly. "day 12 of 16" beats a date range you have to subtract. */
    var dayNote = '';
    if (pace.elapsed != null && p.end_date) {
      var total = Math.round((Date.parse(p.end_date) - Date.parse(p.start_date)) / 864e5) + 1;
      var day   = Math.max(1, Math.min(total, Math.round(pace.elapsed * total)));
      var left  = Math.max(0, total - day);
      dayNote = '<span class="sp-head-note"><span class="sp-live-dot"></span>day ' + day + ' of ' + total
              + ' &middot; ' + left + ' day' + (left === 1 ? '' : 's') + ' left</span>';
    }

    /* The verdict names the gap in UNITS and DAYS, because that is the only form of it
       anyone can act on -- "70% of goal" tells Tawny nothing she can call a vendor about. */
    var verdict = '', vcls = 'is-ahead', vtext = '';
    if (pace.target) {
      var short = Math.max(0, pace.target - pace.sold);
      if (pace.ahead) { vtext = 'On pace'; vcls = 'is-ahead'; }
      else { vtext = 'Just behind pace'; vcls = 'is-behind'; }
      verdict = '<span class="sp-verdict-pill ' + vcls + '">' + vtext + '</span>'
              + '<span class="sp-hero-verdict">' + (short
                  ? short.toLocaleString() + ' units still to go.'
                  : 'Goal already met.') + '</span>';
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
      +       fig('Sold', (a.units_sold || 0).toLocaleString(), 'of ' + (pace.target || 0).toLocaleString(), '')
      +       fig('Budtenders', hit, 'of ' + bts + ' hit', '')
      +       fig('Earned so far', money(pay * hit), money(pay * bts) + ' if all ' + bts + ' land it', 'is-pos')
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

  function fig(label, v, sub, cls) {
    return '<div><div class="sp-fig-l">' + esc(label) + '</div>'
         + '<div class="sp-fig-v ' + cls + '">' + esc(String(v)) + '</div>'
         + '<div class="sp-fig-sub">' + esc(sub) + '</div></div>';
  }

  function paceBar(pace) {
    var pctFill = Math.max(0, Math.min(100, pace.frac * 100));
    var line = pace.elapsed == null ? '' :
      '<div class="sp-bar-pace" style="left:' + (pace.elapsed * 100).toFixed(1) + '%"></div>';
    return '<div class="sp-bar' + (pace.ahead ? ' is-ahead' : '') + '">'
      +   '<div class="sp-bar-fill" style="width:' + pctFill.toFixed(1) + '%"></div>' + line
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
  /* per_unit is REAL and shipped (Hapy Kitchen paid $1/unit) — do not assume flat. */
  /* FLAT IS THE DEFAULT, and anything unrecognised resolves to it. `tiered` is schema'd but
     unimplemented, and a blank or unknown payout_type must not leave the Calculator modelling
     a mode the engine will not honour. */
  function normalModel(v) {
    var m = String(v || '').toLowerCase();
    return m === 'per_unit' ? 'per_unit' : 'flat';
  }

  function payoutLabel(p) {
    var m = (p.payout_json && p.payout_json.model) || 'flat';
    return m === 'per_unit' ? 'per unit' : (m === 'tiered' ? 'tiered' : 'flat per budtender');
  }

  function listRow(p) {
    var a = p.actual_json, t = p.target_json || {};
    var pay = (p.payout_json && p.payout_json.amount) || 0;
    var tgt = t.units || 0;
    var dupe = a && a.duplicate_of && a.duplicate_of.length;
    var rate = a && a.rate_changed;

    var dots = (p.stores_json || []).map(function (sid) {
      return '<span class="sp-dot" style="--dot:' + esc(storeColor(sid)) + '" title="' + esc(storeName(sid)) + '"></span>';
    }).join('');

    var sold = '&mdash;';
    if (a) {
      var d = (a.units_sold || 0) - tgt;
      sold = (a.units_sold || 0).toLocaleString()
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
      + '<div class="sp-num">' + sold + '</div>'
      + '<div class="sp-num">' + (a ? (a.bts_hit || 0) + ' / ' + (t.budtenders || 0) : '&mdash;') + '</div>'
      + '<div class="sp-num sp-money ' + (a ? (a.roi >= 0 ? 'is-pos' : 'is-neg') : '') + '">' + roi + '</div>'
      + '<div><span class="sp-chip is-' + esc(p.status) + '">' + esc(p.status) + '</span></div>'
      + '</div>';
  }

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

  async function importCalculator(btn) {
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      var r = await ENG.jsonp('importCalc', { token: (session() || {}).token });
      if (!r || !r.ok) throw new Error((r && r.error) || 'import failed');
      await loadPrograms();
      if (r.skipped && r.skipped.length) {
        console.info('[spiff] skipped tabs:', r.skipped);
      }
    } catch (err) {
      console.error('[spiff] import failed:', err);
      btn.textContent = 'Import failed — see console';
      setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 4000);
      return;
    }
    btn.textContent = label;
    btn.disabled = false;
  }

  function wirePrograms() {
    var b = $('#btnImportCalc');
    if (b) b.addEventListener('click', function () { importCalculator(b); });

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

    /* Store pills toggle: clicking the active one clears the filter rather than leaving
       you stuck on one store with no visible way back. */
    var pills = $('#progStores');
    if (pills) pills.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-store]');
      if (!btn) return;
      progFilter.store = (progFilter.store === btn.dataset.store) ? '' : btn.dataset.store;
      renderPrograms();
    });

    /* Hero + list are re-rendered wholesale, so delegate from the panel, not the nodes. */
    var panel = $('#panel-programs');
    if (panel) {
      panel.addEventListener('click', function (e) {
        var go = e.target.closest('[data-goto]');
        if (go) { e.preventDefault(); showTab(go.dataset.goto); return; }
        var ed = e.target.closest('[data-edit]');
        if (ed) { openRecord(ed.dataset.edit); return; }
        var row = e.target.closest('.sp-row[data-id]');
        if (row) openRecord(row.dataset.id);
      });
      panel.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
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
     Normalises what can be normalised; returns null for what cannot, so the caller can show
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

  /* A date field that keeps a bad value visible instead of eating it. */
  function dateField(label, key, value) {
    var iso = toISODate(value);
    if (iso === null) {
      return '<label class="sp-fld"><span>' + esc(label) + '</span>'
        + '<input class="sp-in" data-key="' + esc(key) + '" type="text" value="' + esc(value) + '"'
        + (canEdit() ? '' : ' readonly') + '>'
        + '<span class="sp-cost-warn">Not a date this app can read &mdash; retype it as '
        + 'YYYY-MM-DD.</span></label>';
    }
    return recField(label, key, iso, 'date');
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

    var pps = payPeriodOptions(p.pay_period_start || p.start_date);
    var ppNow = periodIndexOf(today());
    var ppOpts = [{ v: '', l: 'Custom dates…' }].concat(pps.map(function (x) {
      var rel = x.index === ppNow ? ' · current' : (x.index > ppNow ? ' · upcoming' : '');
      return { v: x.start, l: periodLabel(x) + rel };
    }));

    /* The pay period a program's dates already fall in, so the dropdown opens on the right row
       instead of "Custom dates…" for every historical record. Only claims a match when the
       dates line up EXACTLY — a program that ran Aug 16→31 is not the Aug 17→30 period, and
       quietly snapping it to one would move a closed program's window. */
    var ppSel = '';
    if (p.start_date && p.end_date) {
      var cand = periodByIndex(periodIndexOf(p.start_date));
      if (cand.start === p.start_date && cand.end === p.end_date) ppSel = cand.start;
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
      +   selField('Pay period', '', ppSel, ppOpts).replace('data-key=""', 'id="rPayPeriod"')
      +   '<span class="sp-fld-note">Choosing a period fills the dates below. They stay editable — not every program lines up with payroll.</span>'
      +   dateField('Start date', 'start_date', p.start_date)
      +   dateField('End date', 'end_date', p.end_date)
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

    /* Vendor still autocompletes here — it is identity, not modelling, and a program filed
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

    var ppSelEl = $('#rPayPeriod');
    if (ppSelEl) ppSelEl.addEventListener('change', function () {
      if (!ppSelEl.value) return;                     // "Custom dates…" leaves them alone
      var per = periodByIndex(periodIndexOf(ppSelEl.value));
      $('#recordBody [data-key="start_date"]').value = per.start;
      $('#recordBody [data-key="end_date"]').value = per.end;
    });

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
      /* Never turn a date that HAD a value into an empty one. dateField now keeps unreadable
         dates visible, so a blank here means the browser refused the value — not that anyone
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
    editingId: null, // set when the Calculator is updating an EXISTING program, not modelling a new one
    window: null,    // that program's dates, carried for display only — the record owns them
    product: null,   // {label, brand, filter_text, products[], skus, qty} — the SPIFF's subject
    refRun: null,    // identity of the in-flight reference pull, so a stale one can be dropped
    stores: []       // [{ store_id, name, baseline, bts, refState, refUnits }]
  };

  /* No participation flag any more. Every store runs every program, so the old tick-box was a
     control nobody used -- and it let a store be silently dropped from the model while its row
     stayed visible. Stores come from the GX Core registry; a seventh appears on its own. */
  function calcInit() {
    if (calc.stores.length || !state.stores.length) return;
    calc.stores = state.stores.map(function (s) {
      return { store_id: s.store_id, name: s.display_name || s.store_id, baseline: 0, bts: 6 };
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

    var baseRev   = baseUnits * cost;
    var targetRev = target * cost;
    var revInc    = targetRev - baseRev;
    /* What the vendor funds AT MOST. Flat pays a bounty per budtender who hits; per_unit pays
       on every unit sold, so its ceiling scales with the target instead of the headcount. */
    var invest    = calc.model === 'per_unit'
      ? (Number(calc.spiff) || 0) * target
      : (Number(calc.spiff) || 0) * bts;

    return {
      on: on, baseUnits: baseUnits, bts: bts, ratio: ratio,
      baseRev: baseRev, targetRev: targetRev,
      unitInc: target - baseUnits,
      revInc: revInc,
      growth: baseUnits ? (target - baseUnits) / baseUnits : 0,
      invest: invest,
      roi: revInc - invest,
      roiPct: invest ? (revInc - invest) / invest : 0
    };
  }

  /* "It scales with success" — the panel the Calculator never had.
     ASSUMPTION, stated because it is not derivable from the sheet: a budtender who hits
     contributes their full goal, one who misses contributes their reference. That is the only
     reading that invents no behaviour -- any smoother curve would be a number we made up and
     then showed to a vendor. Everything else here follows from it arithmetically. */
  function scaleRows(m) {
    var bts = m.bts;
    if (!bts || !m.baseUnits) return [];
    var perBtRef  = m.baseUnits / bts;
    var perBtGoal = (Number(calc.target) || 0) / bts;
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

  function recalc(changedIds) {
    var m = calcModel();
    var pending = refPending();

    /* ---- stat strip. Only the ROI card is tinted; it is the figure being argued for. */
    var stats = $('#calcStats');
    if (stats) stats.innerHTML =
        cstat('You fund, at most', money(m.invest),
              calc.model === 'per_unit'
                ? money(calc.spiff) + ' on each of ' + (Number(calc.target) || 0).toLocaleString() + ' units'
                : 'only if all ' + m.bts + ' reach their target', '')
      + cstat('Your revenue increase', money(m.revInc), money(m.baseRev) + ' → ' + money(m.targetRev), '')
      + cstat('Your return', m.invest ? pctWhole(m.roiPct) : '—',
              money(m.roi) + ' net of the bounty', m.roi < 0 ? 'is-neg' : 'is-hero')
      + cstat('Unit lift', (m.unitInc > 0 ? '+' : '') + m.unitInc.toLocaleString(),
              pct(m.growth) + ' over last month', '');

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
      var tgtPct  = span ? Math.max(0, Math.min(100, ((Number(calc.target) || 0) / span) * 100)) : 0;
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
      if (gEl && document.activeElement !== gEl) gEl.value = live ? Math.round(m.growth * 100) : 0;
      if (!draggingGoal) range.value = Math.max(0, Math.min(GOAL_MAX, Math.round(m.growth * 100)));
      /* Three states, not two. `live` folds "no base" together with "still loading", and using
         it for the caption told someone who had just picked a product to go and pick one. */
      foot.innerHTML = '<span>' + m.baseUnits.toLocaleString() + ' sold last month</span>'
        + (pending
            ? '<span>waiting on Dutchie&hellip;</span>'
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
      var perExtra = m.unitInc > 0 ? m.invest / m.unitInc : null;
      var breakEven = (Number(calc.cost) || 0) ? Math.ceil(m.invest / (Number(calc.cost) || 0)) : null;
      minis.innerHTML =
          mini('Your cost per extra unit', perExtra == null ? '—' : money(perExtra),
               perExtra == null ? 'set a target above last month'
                                : money(m.invest) + ' across ' + m.unitInc.toLocaleString() + ' extra units')
        + mini('Break-even', breakEven == null ? '—' : breakEven.toLocaleString() + ' units',
               'against last month, chain-wide');
    }

    /* ---- the merged per-store table */
    var tbl = $('#calcTable');
    if (tbl) {
      var body = m.on.map(function (st, i) {
        var base = Number(st.baseline) || 0;
        var n    = Number(st.bts) || 0;
        var goal = Math.round(base * m.ratio);
        var perNow  = n ? Math.round(base / n) : null;
        var perGoal = n ? Math.round(goal / n) : null;
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
          + '<td class="num strong">' + (perGoal == null ? '—' : perGoal.toLocaleString()) + '</td>'
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
        + '<th class="num">per BT goal</th><th class="num">BT unit increase</th>'
        + '<th class="num">Goal value</th></tr></thead><tbody>'
        + body
        + '<tr class="sp-total"><td>Total · ' + m.on.length + ' store' + (m.on.length === 1 ? '' : 's')
        +   ', ' + m.bts + ' budtender' + (m.bts === 1 ? '' : 's') + '</td>'
        +   '<td class="num">' + m.baseUnits.toLocaleString() + '</td>'
        +   '<td class="num goal">' + (Number(calc.target) || 0).toLocaleString() + '</td>'
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
    var waitEl = $('#calcWaiting');
    if (waitEl) {
      waitEl.hidden = !pending;
      if (pending) waitEl.innerHTML = '<span class="sp-live-dot"></span>pulling last month&rsquo;s sales &mdash; '
        + pending + ' of ' + calc.stores.length + ' store' + (calc.stores.length === 1 ? '' : 's') + ' to go';
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
  function pctWhole(n) { return Math.round((Number(n) || 0) * 100) + '%'; }

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
      st[el.dataset.f] = Number(el.value) || 0;
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
      if (r) pullReferenceFor(Number(r.dataset.refretry));
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
        : '<div class="sp-pick-empty">No vendor in stock matches that.</div>';
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
    } catch (e) { console.error('[spiff] catalog brands failed:', e); }
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
       recognise, sitting where "Gummy" belongs. Anything carrying a digit, colon, slash,
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
    calc.stores = reg.map(function (st) {
      var b = (base.by_store || {})[st.store_id];
      var perBt = (base.per_bt || {})[st.store_id];
      return {
        store_id: st.store_id, name: st.display_name || st.store_id,
        baseline: b || 0,
        bts: perBt ? Math.max(1, Math.round((b || 0) / perBt)) : 6
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

    var perBt = m.bts ? Math.round(calc.target / m.bts) : 0;
    var ask = calc.model === 'per_unit'
      ? 'a <b>' + money(calc.spiff) + '</b> bounty on every unit a budtender sells'
      : 'a <b>' + money(calc.spiff) + '</b> bounty per budtender who reaches their own target';

    var cards = m.on.map(function (st) {
      var base = Number(st.baseline) || 0;
      var n    = Number(st.bts) || 0;
      var goal = Math.round(base * m.ratio);
      var add  = goal - base;
      var span = goal || 1;
      var havePct = Math.max(0, Math.min(100, (base / span) * 100));
      return '<div class="sp-pstore" style="--dot:' + esc(storeColor(st.store_id)) + '">'
        + '<div class="sp-pstore-h"><span class="sp-dot"></span>' + esc(st.name) + '</div>'
        + '<div class="sp-pstore-n"><span class="sp-pstore-v">' + goal.toLocaleString() + '</span>'
        +   '<span class="sp-pstore-u">units' + (n ? ' · ' + Math.round(goal / n) + ' each' : '') + '</span></div>'
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
        ? (Number(calc.target) || 0).toLocaleString() + ' units × ' + money(calc.spiff)
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
      +       m.bts + ' budtenders, ' + (Number(calc.target) || 0).toLocaleString() + ' units</h1>'
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
      var perBt = (base.per_bt || {})[s.store_id];
      return {
        store_id: s.store_id, name: s.display_name || s.store_id,
        baseline: b || 0,
        bts: perBt ? Math.max(1, Math.round((b || 0) / perBt)) : 6
      };
    });
    $('#cName').value = calc.name; $('#cVendor').value = calc.vendor;
    $('#cCost').value = calc.cost; $('#cSpiff').value = calc.spiff;
    $('#cTarget').value = calc.target;
    $$('#cModel button').forEach(function (x) { x.classList.toggle('is-on', x.dataset.model === calc.model); });
    var m = calcModel();
    $('#cGrowth').value = m.baseUnits ? Math.round(m.growth * 100) : 0;
    recalc();
  }

  async function saveCalcProgram() {
    if (!canEdit()) { $('#btnAuth').click(); return; }
    var m = calcModel();
    if (!calc.name) { alert('Give the program a name first.'); return; }

    var byStore = Object.create(null), perBt = Object.create(null);
    var baseByStore = Object.create(null), basePerBt = Object.create(null);
    m.on.forEach(function (s) {
      byStore[s.store_id] = Math.round((Number(s.baseline) || 0) * m.ratio);
      perBt[s.store_id]   = s.bts ? Math.round(Math.round(s.baseline / s.bts) * m.ratio) : 0;
      /* The per-store LAST-MONTH split is saved too. It is what openInCalculator reads back,
         so without it a second trip through Edit parameters would open on zeroed references
         and recompute a different target than the one the vendor agreed to. */
      baseByStore[s.store_id] = Number(s.baseline) || 0;
      basePerBt[s.store_id]   = s.bts ? Math.round((Number(s.baseline) || 0) / s.bts) : 0;
    });

    var btn = $('#calcSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      /* UPDATE when we arrived from a record, CREATE otherwise. Without this the "Edit
         parameters" route silently forked a duplicate off the program Tawny thought she was
         updating, leaving two records with the same name and different numbers — and the
         close-out would have been run against whichever one got opened. */
      var r = calc.editingId
        ? await ENG.jsonp('editProgram', {
            token: (session() || {}).token, id: calc.editingId,
            patch: JSON.stringify({
              program_name: calc.name, vendor: calc.vendor,
              cost_json:   { mode: 'flat', per_unit: Number(calc.cost) || 0, source_label: 'calculator' },
              payout_type: calc.model,
              payout_json: { amount: Number(calc.spiff) || 0, model: calc.model },
              match_json:  matchOf(calc.product),
              stores_json: m.on.map(function (x) { return x.store_id; }),
              baseline_json: { units: m.baseUnits, revenue: m.baseRev, by_store: baseByStore, per_bt: basePerBt },
              target_json: { units: Number(calc.target) || 0, revenue: m.targetRev,
                             budtenders: m.bts, by_store: byStore, per_bt: perBt }
            })
          })
        : await ENG.jsonp('createProgram', {
        token: (session() || {}).token,
        program: JSON.stringify({
          program_name: calc.name, vendor: calc.vendor,
          cost_json:   { mode: 'flat', per_unit: Number(calc.cost) || 0, source_label: 'calculator' },
          /* The model is SAVED now. It used to be hardcoded 'flat', so a per-unit program
             (Hapy Kitchen paid $1/unit) came back out of the datastore looking flat — which
             is exactly how the imported history came to look uniformly flat. */
          payout_type: calc.model,
          payout_json: { amount: Number(calc.spiff) || 0, model: calc.model },
          match_json:  matchOf(calc.product),
          stores_json: m.on.map(function (s) { return s.store_id; }),
          baseline_json: { units: m.baseUnits, revenue: m.baseRev, by_store: baseByStore, per_bt: basePerBt },
          /* budtenders is what Programs divides the payout by; without it the hero showed
             "of 0 hit" and an earned-so-far of $0 on a program that was paying out. */
          target_json:   { units: Number(calc.target) || 0, revenue: m.targetRev,
                           budtenders: m.bts, by_store: byStore, per_bt: perBt }
        })
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
    });
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
    if (!p) { $('#repBody').innerHTML = '<p class="hint">No closed programs yet.</p>'; return; }

    var a    = p.actual_json || {};
    var rate = a.spiff_amount || (p.payout_json || {}).amount || 0;
    var owed = (a.bts_hit || 0) * rate;

    var suspect = a.duplicate_of && a.duplicate_of.length
      ? '<div class="notice is-warn"><b>Check these numbers before sending.</b> This program\'s actuals are '
        + 'identical to <b>' + esc(a.duplicate_of.join(', ')) + '</b> and may be copied from another tab. '
        + 'A vendor credit built on them would be wrong.</div>'
      : '';

    var mail = { subject: '', body: '' };
    try {
      var r = await ENG.jsonp('emailDraft', { token: (session() || {}).token, id: p.program_id });
      if (r && r.ok) mail = r;
    } catch (e) { console.error('[spiff] email draft failed:', e); }

    $('#repBody').innerHTML = suspect
      + '<div class="rep-grid">'
      +   '<div class="rep-card">'
      +     '<h4>What the vendor owes</h4>'
      +     '<div class="rep-owed"><b>' + money(owed) + '</b>'
      +       '<span>' + (a.bts_hit || 0) + ' budtenders × ' + money(rate) + '</span></div>'
      +     '<dl class="rep-facts">'
      +       '<dt>Units sold</dt><dd>' + (a.units_sold || 0).toLocaleString() + '</dd>'
      +       '<dt>Target</dt><dd>' + ((p.target_json || {}).units || 0).toLocaleString() + '</dd>'
      +       '<dt>Period</dt><dd>' + (p.start_date ? esc(p.start_date) + ' → ' + esc(p.end_date || '') : '—') + '</dd>'
      +     '</dl>'
      +     '<button class="gx-btn gx-btn-green" data-act="pdf">Save PDF to Drive</button>'
      +     '<p class="hint">Files it in the SPIFF close-out folder as '
      +       '<code>SPIFF_Sales Report - ' + esc(p.vendor) + ' - MMDDYY.pdf</code>.</p>'
      +   '</div>'
      +   '<div class="rep-card">'
      +     '<h4>Vendor email &mdash; draft</h4>'
      +     '<input class="gx-input" id="repSubj" value="' + esc(mail.subject) + '" readonly>'
      +     '<textarea class="gx-input rep-mail" id="repMail" rows="14" readonly>' + esc(mail.body) + '</textarea>'
      +     '<button class="gx-btn" data-act="copy">Copy email</button>'
      +     '<p class="hint">Copy into your mail client, attach the PDF, and send it yourself. '
      +       'The app has no ability to email a vendor.</p>'
      +   '</div>'
      +   '<div class="rep-card">'
      +     '<h4>Gift cards</h4>'
      +     '<div class="rep-owed"><b>' + money(owed) + '</b><span>to buy in gift cards</span></div>'
      +     '<p class="hint">Per-budtender names need sell-through detail, which arrives with the '
      +       'Progress tab. This program recorded <b>' + (a.bts_hit || 0) + '</b> budtenders at '
      +       money(rate) + ' each.</p>'
      +   '</div>'
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
        histStat(list.length, list.length === 1 ? 'program' : 'programs')
      + histStat(t.units.toLocaleString(), 'units sold')
      + histStat(money(t.spend), 'paid in SPIFF')
      + histStat(money(t.roi), 'net return', t.roi < 0 ? 'neg' : 'pos');

    if (!list.length) { $('#hList').innerHTML = '<p class="hint">Nothing matches.</p>'; return; }

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

    $('#hList').innerHTML = keys.map(function (k) {
      return '<div class="hist-group"><h3>' + esc(monthLabel(k)) + '</h3>'
        + groups[k].map(histRow).join('') + '</div>';
    }).join('');
  }

  function histStat(value, label, tone) {
    return '<div class="hist-stat' + (tone ? ' is-' + tone : '') + '"><b>' + value + '</b><span>' + esc(label) + '</span></div>';
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
    var flags = '';
    if ((a.duplicate_of || []).length) flags += '<span class="flag is-warn">actuals may be copied</span>';
    if (a.rate_changed) flags += '<span class="flag">rate ' + money((p.payout_json || {}).amount) + '&rarr;' + money(a.spiff_amount) + '</span>';
    if (p.edited_by) flags += '<span class="flag is-ok">corrected by ' + esc(p.edited_by) + '</span>';

    return '<div class="hist-row" data-id="' + esc(p.program_id) + '" tabindex="0">'
      + '<div class="hist-main"><b>' + esc(p.program_name || p.title) + '</b>'
      +   '<span class="hist-sub">' + esc(p.vendor) + ' · ' + esc(p.start_date || '—') + ' → ' + esc(p.end_date || '—') + '</span>'
      +   (flags ? '<div class="hist-flags">' + flags + '</div>' : '')
      + '</div>'
      + '<div class="hist-nums">'
      +   '<span><b>' + (a.units_sold || 0).toLocaleString() + '</b> sold</span>'
      +   '<span><b>' + (a.bts_hit || 0) + '</b> hit × ' + money(rate) + '</span>'
      +   '<span class="' + (a.roi < 0 ? 'neg' : '') + '"><b>' + money(a.roi) + '</b> ROI</span>'
      + '</div></div>';
  }

  /* -------------------------------------------------------------- progress
   *
   * The budtender matrix the SPIFF_Sales Report builds by hand — six Dutchie exports
   * pasted into six tabs. Here it is one call.
   */

  function wireProgress() {
    $('#pgProgram').addEventListener('change', loadProgress);
    $('#pgRefresh').addEventListener('click', loadProgress);
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
    sel.innerHTML = sortPrograms(state.programs).map(function (p) {
      return '<option value="' + esc(p.program_id) + '">' + esc(p.program_name || p.title) + '</option>';
    }).join('');
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

  async function loadProgress() {
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
    pgRun = { prog: prog, id: id, windows: windows, stores: stores,
              results: Object.create(null), failed: Object.create(null), pulling: Object.create(null) };
    stores.forEach(function (st) { pgRun.pulling[st] = 1; });

    renderPgLive(prog, windows, stores);
    paintProgress();

    await Promise.all(stores.map(function (st) { return pullOneStore(st); }));
    pgRun.done = true;
    paintProgress();
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
      var left = '';
      if (running && prog.end_date) {
        var d = Math.max(0, Math.round((Date.parse(prog.end_date) - Date.now()) / 864e5));
        left = ' · ' + d + ' day' + (d === 1 ? '' : 's') + ' left';
      }
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
    $('#pgNote').innerHTML = esc(prettyDay(prog.start_date)) + ' → ' + esc(prettyDay(prog.end_date))
      + ' · green means that person has already earned the bounty.'
      + (missing > 0
          ? ' Totals cover the ' + back + ' store' + (back === 1 ? '' : 's') + ' that ' + (back === 1 ? 'has' : 'have') + ' come back.'
          : '');

    $('#pgBody').innerHTML = '<div class="sp-pg-grid">' + stores.map(pgCard).join('') + '</div>';
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
  /* Chrome is not session state: start the clock and load store colours at boot so the header is
     never showing placeholder dashes, signed in or out. */
  function startChrome() {
    if (window.GXTopNav) GXTopNav.startClock();
    if (window.GXStores) GXStores.load(GXCORE).catch(function () { /* colours are a nicety */ });
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

  /* Inheriting the host's token is AUTHENTICATION and never becomes AUTHORISATION: it proves who
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
    // Sequential, not parallel. Two GXClients firing in the same tick is what exposed the
    // shared callback-name collision; staggering them keeps SPIFF correct even on a client
    // that hasn't picked up the fix yet.
    renderProgramsSkeleton();
    loadShared().then(calcInit).then(loadPrograms).then(function () { fillCalcLoad(); fillReportPicker(); fillHistoryFilters(); fillProgressPicker(); initBugReport(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for the engine wiring that follows (see /gxwhatsnext for the build order).
  window.SPIFF = { state: state, GX: GX, app: APP, engine: function () { return ENGINE; } };

})();
