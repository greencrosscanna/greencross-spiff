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
    $$('#tabs .tab').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === name); });
    $$('.panel').forEach(function (p) { p.classList.toggle('is-active', p.id === 'panel-' + name); });
  }

  function wireTabs() {
    var bar = $('#tabs');
    if (bar) bar.addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) showTab(b.dataset.tab);
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

  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  // The sheet stores ROI % as a fraction (0.3588 = 35.88%).
  function pct(n) { return ((Number(n) || 0) * 100).toFixed(1) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  async function loadPrograms() {
    var list  = $('#programsList');
    var empty = $('#programsEmpty');
    try {
      var r = await ENG.jsonp('programs', {});
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

  function renderPrograms() {
    var list  = $('#programsList');
    var empty = $('#programsEmpty');
    if (!state.programs.length) { empty.hidden = false; list.hidden = true; return; }

    empty.hidden = true;
    list.hidden = false;

    var rows = sortPrograms(state.programs).map(function (p) {
      var a   = p.actual_json;
      var pay = (p.payout_json && p.payout_json.amount) || 0;
      var tgt = (p.target_json && p.target_json.units) || 0;
      var cost = p.cost_json || {};

      // A program whose paid rate diverged from the modelled rate is worth seeing at a
      // glance — it changes what the vendor was actually billed.
      var rateFlag = a && a.rate_changed
        ? ' <span class="flag" title="Modelled at ' + money(pay) + ', settled at ' + money(a.spiff_amount) + '">rate ' + money(pay) + '&rarr;' + money(a.spiff_amount) + '</span>'
        : '';

      // Duplicated ROI panels in the source sheet. Shown, not hidden — these numbers
      // look plausible on their own, and quietly trusting them would put someone else's
      // result in a vendor report.
      var dupFlag = a && a.duplicate_of && a.duplicate_of.length
        ? ' <span class="flag is-warn" title="Identical units sold, budtenders hit and investment as: ' + esc(a.duplicate_of.join(', ')) + ' — likely a copied tab, verify before using">actuals match ' + esc(a.duplicate_of.join(', ')) + '</span>'
        : '';

      // Both ends, always — a lone start date reads like a one-day program.
      var period = p.start_date
        ? esc(p.start_date) + ' &rarr; ' + esc(p.end_date || '?')
        : '<span class="hint">no period</span>';

      // Sold against target, Inventory-velocity style: the number, and under it how far
      // over or short it landed. The delta is the point — "267" alone doesn't say
      // whether the program hit.
      var sold = '&mdash;';
      if (a) {
        var delta = a.units_sold - tgt;
        var dir   = delta > 0 ? 'up' : (delta < 0 ? 'down' : '');
        sold = '<span class="vel-primary">' + a.units_sold.toLocaleString() + '</span>'
             + (tgt ? '<span class="vel-trend ' + dir + '">' + (delta > 0 ? '+' : '') + delta.toLocaleString() + '</span>' : '');
      }

      return '<tr' + (dupFlag ? ' class="is-suspect"' : '') + ' data-id="' + esc(p.program_id) + '" tabindex="0">'
        + '<td>' + esc(p.vendor) + '</td>'
        + '<td class="period">' + period + '</td>'
        + '<td><b>' + esc(p.program_name || p.title) + '</b>'
        +   '<span class="tabname">' + esc(p.title) + '</span>' + rateFlag + dupFlag + '</td>'
        + '<td><span class="status is-' + esc(p.status) + '">' + esc(p.status) + '</span></td>'
        + '<td class="num">' + money(pay) + '</td>'
        + '<td class="num">' + money(cost.per_unit) + (cost.mode === 'blended' ? ' <span class="hint" title="' + esc(cost.source_label) + '">blended</span>' : '') + '</td>'
        + '<td class="num">' + tgt.toLocaleString() + '</td>'
        + '<td class="num vel-cell">' + sold + '</td>'
        + '<td class="num">' + (a ? a.bts_hit : '&mdash;') + '</td>'
        + '<td class="num ' + (a && a.roi < 0 ? 'neg' : '') + '">' + (a ? money(a.roi) : '&mdash;') + '</td>'
        + '<td class="num ' + (a && a.roi_pct < 0 ? 'neg' : '') + '">' + (a ? pct(a.roi_pct) : '&mdash;') + '</td>'
        + '<td class="num">' + (p.stores_json || []).length + '</td>'
        + '</tr>';
    }).join('');

    // The table scrolls inside its own container, never the page — this app also runs as
    // an iframe tab inside Inventory, where the viewport is narrower still.
    list.innerHTML =
      '<div class="grid-wrap"><table class="grid"><thead><tr>'
      + '<th>Vendor</th><th>Period</th><th>Program</th><th>Status</th><th class="num">SPIFF</th><th class="num">Cost/unit</th>'
      + '<th class="num">Target</th><th class="num">Sold</th><th class="num">BTs hit</th><th class="num">ROI</th>'
      + '<th class="num">ROI %</th><th class="num">Stores</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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
      var r = await ENG.jsonp('importCalc', {});
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
    return !!(s && ['admin', 'director'].indexOf(s.role) >= 0);
  }

  function openRecord(id) {
    var p = state.programs.filter(function (x) { return x.program_id === id; })[0];
    if (!p) return;
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

  function renderRecord(p) {
    var a = p.actual_json || {};
    var warn = '';

    if (a.duplicate_of && a.duplicate_of.length) {
      warn += '<div class="notice is-warn"><b>Actuals look copied.</b> Identical units sold, budtenders hit and '
        + 'investment as <b>' + esc(a.duplicate_of.join(', ')) + '</b>. Duplicating a tab copies its typed cells while '
        + 'formulas recalculate, so these numbers may belong to another program. Correct them here — the vendor '
        + 'close-out PDF in Drive is the reliable source.</div>';
    }
    if (a.rate_changed) {
      warn += '<div class="notice"><b>Rate differs.</b> Modelled at ' + money(p.payout_json && p.payout_json.amount)
        + ', actuals recorded at ' + money(a.spiff_amount) + '.</div>';
    }
    if (p.edited_by) {
      warn += '<div class="notice is-ok">Corrected by <b>' + esc(p.edited_by) + '</b> on ' + esc(p.edited_at)
        + '. Re-importing the Calculator will not overwrite this record.</div>';
    }

    $('#recordBody').innerHTML = warn
      + '<div class="fld-grid">'
      +   field('Vendor', 'vendor', p.vendor)
      +   field('Program name (Calculator A3)', 'program_name', p.program_name)
      +   field('Status', 'status', p.status)
      +   field('Start date', 'start_date', p.start_date)
      +   field('End date', 'end_date', p.end_date)
      +   field('Pay period', 'pay_period', p.pay_period)
      + '</div>'
      + '<h4>Plan</h4><div class="fld-grid">'
      +   field('SPIFF per budtender', 'payout_json.amount', (p.payout_json || {}).amount, 'number')
      +   field('Cost per unit', 'cost_json.per_unit', (p.cost_json || {}).per_unit, 'number')
      +   field('Target units', 'target_json.units', (p.target_json || {}).units, 'number')
      +   field('Baseline units', 'baseline_json.units', (p.baseline_json || {}).units, 'number')
      + '</div>'
      + '<h4>Actuals</h4><div class="fld-grid">'
      +   field('Units sold', 'actual_json.units_sold', a.units_sold, 'number')
      +   field('Budtenders hit', 'actual_json.bts_hit', a.bts_hit, 'number')
      +   field('Rate paid', 'actual_json.spiff_amount', a.spiff_amount, 'number')
      +   field('Investment', 'actual_json.investment', a.investment, 'number')
      +   field('ROI $', 'actual_json.roi', a.roi, 'number')
      +   field('ROI % (as decimal)', 'actual_json.roi_pct', a.roi_pct, 'number')
      + '</div>';

    var s = session();
    $('#recordSave').hidden   = !canEdit();
    $('#recordSignIn').hidden = canEdit();
    $('#recordMsg').textContent = s
      ? 'Signed in as ' + s.user + (canEdit() ? ' (' + s.role + ')' : ' — role ' + s.role + ' cannot edit')
      : 'Read-only. Sign in to correct this record.';
  }

  // Credentials go to GX Core, which owns sign-on; SPIFF never stores a password.
  function renderSignIn() {
    $('#recordBody').innerHTML =
      '<div class="signin">'
      + '<p>SPIFF records are edited by Tawny and Sky. Sign in with your Green Cross account.</p>'
      + '<label class="fld"><span>User</span><input class="gx-input" id="siUser" autocomplete="username"></label>'
      + '<label class="fld"><span>Password</span><input class="gx-input" id="siPass" type="password" autocomplete="current-password"></label>'
      + '<button class="gx-btn gx-btn-green" id="siGo">Sign in</button>'
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
      if (!r || !r.ok) throw new Error((r && r.error) || 'Sign-in failed');
      setSession({ user: r.user, role: r.role, token: r.token, expiresAt: r.expiresAt });
      $('#recordMsg').textContent = '';
      renderRecord(state.record);
    } catch (err) {
      $('#recordMsg').textContent = String(err.message || err);
    }
  }

  // Collect only what actually changed, so an edit to one field can't silently rewrite
  // the rest of the record.
  function collectPatch(p) {
    var patch = {}, nested = {};
    $$('#recordBody [data-key]').forEach(function (el) {
      var key = el.dataset.key, raw = el.value.trim();
      var val = el.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
      var parts = key.split('.');
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
      state.record = state.programs.filter(function (x) { return x.program_id === p.program_id; })[0] || p;
      renderRecord(state.record);
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
    stores: []   // [{ store_id, name, on, baseline, bts }]
  };

  function calcInit() {
    if (calc.stores.length || !state.stores.length) return;
    calc.stores = state.stores.map(function (s) {
      return { store_id: s.store_id, name: s.display_name || s.store_id, on: true, baseline: 0, bts: 6 };
    });
    renderCalcStores();
    recalc();
  }

  function calcModel() {
    var on = calc.stores.filter(function (s) { return s.on; });
    var baseUnits = on.reduce(function (n, s) { return n + (Number(s.baseline) || 0); }, 0);
    var bts       = on.reduce(function (n, s) { return n + (Number(s.bts) || 0); }, 0);
    var target    = Number(calc.target) || 0;
    var cost      = Number(calc.cost) || 0;
    var ratio     = baseUnits ? target / baseUnits : 0;

    var baseRev   = baseUnits * cost;
    var targetRev = target * cost;
    var revInc    = targetRev - baseRev;
    var invest    = (Number(calc.spiff) || 0) * bts;

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

  function recalc() {
    var m = calcModel();

    // Lead with what the vendor cares about: what it costs them, what it returns.
    $('#calcHero').innerHTML =
        heroStat('Investment', money(m.invest), (m.bts || 0) + ' budtenders × ' + money(calc.spiff))
      + heroStat('Revenue increase', money(m.revInc), money(m.baseRev) + ' → ' + money(m.targetRev))
      + heroStat('ROI', money(m.roi), pct(m.roiPct) + ' return', m.roi < 0 ? 'neg' : 'pos')
      + heroStat('Unit lift', (m.unitInc > 0 ? '+' : '') + m.unitInc.toLocaleString(), pct(m.growth) + ' over baseline');

    var rows = m.on.map(function (s) {
      var base = Number(s.baseline) || 0;
      var n    = Number(s.bts) || 0;
      var tgt  = Math.round(base * m.ratio);
      return '<tr>'
        + '<td>' + esc(s.name) + '</td>'
        + '<td class="num">' + base.toLocaleString() + '</td>'
        + '<td class="num">' + (n ? Math.round(base / n) : '&mdash;') + '</td>'
        + '<td class="num strong">' + tgt.toLocaleString() + '</td>'
        + '<td class="num strong">' + (n ? Math.round(Math.round(base / n) * m.ratio) : '&mdash;') + '</td>'
        + '<td class="num">' + money(tgt * (Number(calc.cost) || 0)) + '</td>'
        + '</tr>';
    }).join('');

    $('#calcTable').innerHTML = m.on.length
      ? '<div class="grid-wrap"><table class="grid"><thead><tr>'
        + '<th>Store</th><th class="num">Baseline</th><th class="num">Per BT</th>'
        + '<th class="num">Target</th><th class="num">Per BT</th><th class="num">Target value</th>'
        + '</tr></thead><tbody>' + rows
        + '<tr class="total"><td>Total</td><td class="num">' + m.baseUnits.toLocaleString() + '</td><td></td>'
        + '<td class="num strong">' + (Number(calc.target) || 0).toLocaleString() + '</td><td></td>'
        + '<td class="num">' + money(m.targetRev) + '</td></tr>'
        + '</tbody></table></div>'
      : '<p class="hint">Tick at least one store.</p>';
  }

  function heroStat(label, value, sub, tone) {
    return '<div class="hero-stat' + (tone ? ' is-' + tone : '') + '">'
      + '<span class="hero-label">' + esc(label) + '</span>'
      + '<span class="hero-value">' + value + '</span>'
      + '<span class="hero-sub">' + sub + '</span></div>';
  }

  function renderCalcStores() {
    $('#calcStores').innerHTML = calc.stores.map(function (s, i) {
      return '<div class="calc-store">'
        + '<label class="calc-store-on"><input type="checkbox" data-i="' + i + '" data-f="on"' + (s.on ? ' checked' : '') + '> ' + esc(s.name) + '</label>'
        + '<label class="fld"><span>Baseline units</span><input class="gx-input" type="number" data-i="' + i + '" data-f="baseline" value="' + (s.baseline || 0) + '"></label>'
        + '<label class="fld"><span>Budtenders</span><input class="gx-input" type="number" data-i="' + i + '" data-f="bts" value="' + (s.bts || 0) + '"></label>'
        + '</div>';
    }).join('');
  }

  function wireCalculator() {
    ['cName', 'cVendor', 'cCost', 'cSpiff'].forEach(function (id) {
      $('#' + id).addEventListener('input', function () {
        calc[{ cName: 'name', cVendor: 'vendor', cCost: 'cost', cSpiff: 'spiff' }[id]] = $('#' + id).value;
        recalc();
      });
    });

    // Target units and growth % are two views of one number — editing either updates the
    // other, so Tawny can pitch "1,200 units" or "+40%" whichever way the vendor thinks.
    $('#cTarget').addEventListener('input', function () {
      calc.target = Number($('#cTarget').value) || 0;
      var base = calcModel().baseUnits;
      $('#cGrowth').value = base ? Math.round(((calc.target - base) / base) * 100) : 0;
      recalc();
    });
    $('#cGrowth').addEventListener('input', function () {
      var base = calcModel().baseUnits;
      calc.target = Math.round(base * (1 + (Number($('#cGrowth').value) || 0) / 100));
      $('#cTarget').value = calc.target;
      recalc();
    });

    $('#calcStores').addEventListener('input', function (e) {
      var el = e.target, i = el.dataset.i;
      if (i == null) return;
      var s = calc.stores[i];
      if (el.dataset.f === 'on') s.on = el.checked;
      else s[el.dataset.f] = Number(el.value) || 0;
      if (el.dataset.f !== 'bts') {
        var base = calcModel().baseUnits;
        $('#cGrowth').value = base ? Math.round(((calc.target - base) / base) * 100) : 0;
      }
      recalc();
    });

    $('#calcLoad').addEventListener('change', loadIntoCalc);
    $('#calcSave').addEventListener('click', saveCalcProgram);
  }

  // Model a new deal off a past one — "what if we ran Wyld again, but at $50?"
  function loadIntoCalc() {
    var p = state.programs.filter(function (x) { return x.program_id === $('#calcLoad').value; })[0];
    if (!p) return;
    var base = p.baseline_json || {}, tgt = p.target_json || {};
    calc.name   = p.program_name || p.title;
    calc.vendor = p.vendor;
    calc.cost   = (p.cost_json || {}).per_unit || 0;
    calc.spiff  = (p.payout_json || {}).amount || 0;
    calc.target = tgt.units || 0;
    calc.stores = state.stores.map(function (s) {
      var b = (base.by_store || {})[s.store_id];
      var perBt = (base.per_bt || {})[s.store_id];
      return {
        store_id: s.store_id, name: s.display_name || s.store_id,
        on: (p.stores_json || []).indexOf(s.store_id) >= 0,
        baseline: b || 0,
        bts: perBt ? Math.max(1, Math.round((b || 0) / perBt)) : 6
      };
    });
    $('#cName').value = calc.name; $('#cVendor').value = calc.vendor;
    $('#cCost').value = calc.cost; $('#cSpiff').value = calc.spiff;
    $('#cTarget').value = calc.target;
    var m = calcModel();
    $('#cGrowth').value = m.baseUnits ? Math.round(m.growth * 100) : 0;
    renderCalcStores();
    recalc();
  }

  async function saveCalcProgram() {
    if (!canEdit()) { alert('Sign in from a program record to save — SPIFF programs are edited by Tawny and Sky.'); return; }
    var m = calcModel();
    if (!calc.name) { alert('Give the program a name first.'); return; }

    var byStore = {}, perBt = {};
    m.on.forEach(function (s) {
      byStore[s.store_id] = Math.round((Number(s.baseline) || 0) * m.ratio);
      perBt[s.store_id]   = s.bts ? Math.round(Math.round(s.baseline / s.bts) * m.ratio) : 0;
    });

    var btn = $('#calcSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var r = await ENG.jsonp('createProgram', {
        token: (session() || {}).token,
        program: JSON.stringify({
          program_name: calc.name, vendor: calc.vendor,
          cost_json:   { mode: 'flat', per_unit: Number(calc.cost) || 0, source_label: 'calculator' },
          payout_type: 'flat',
          payout_json: { amount: Number(calc.spiff) || 0 },
          stores_json: m.on.map(function (s) { return s.store_id; }),
          baseline_json: { units: m.baseUnits, revenue: m.baseRev },
          target_json:   { units: Number(calc.target) || 0, revenue: m.targetRev, by_store: byStore, per_bt: perBt }
        })
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'save failed');
      btn.textContent = 'Saved';
      await loadPrograms();
      fillCalcLoad();
    } catch (err) {
      btn.textContent = 'Save failed';
      console.error('[spiff] save program failed:', err);
    }
    setTimeout(function () { btn.textContent = 'Save as program'; btn.disabled = false; }, 2500);
  }

  function fillCalcLoad() {
    var sel = $('#calcLoad');
    if (!sel) return;
    sel.innerHTML = '<option value="">Start from scratch…</option>'
      + sortPrograms(state.programs).map(function (p) {
        return '<option value="' + esc(p.program_id) + '">' + esc(p.program_name || p.title) + '</option>';
      }).join('');
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    wireTabs();
    wirePrograms();
    wireCalculator();
    showTab('programs');
    // Sequential, not parallel. Two GXClients firing in the same tick is what exposed the
    // shared callback-name collision; staggering them keeps SPIFF correct even on a client
    // that hasn't picked up the fix yet.
    loadShared().then(calcInit).then(loadPrograms).then(fillCalcLoad);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for the engine wiring that follows (see /gxwhatsnext for the build order).
  window.SPIFF = { state: state, GX: GX, app: APP, engine: function () { return ENGINE; } };

})();
