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
    programs:  []
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
      state.stores = (s && s.stores) || [];

      var e = await GX.jsonp('employees', {});
      state.employees = (e && e.employees) || [];

      conn('GX Core', 'connected');
    } catch (err) {
      conn('offline', 'GX Core unreachable');
      console.error('[spiff] GX Core load failed:', err);
    }
  }

  /* -------------------------------------------------------------- programs */

  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  async function loadPrograms() {
    var list  = $('#programsList');
    var empty = $('#programsEmpty');
    try {
      var r = await ENG.jsonp('programs', {});
      state.programs = (r && r.programs) || [];
    } catch (err) {
      console.error('[spiff] programs load failed:', err);
      empty.hidden = false;
      list.hidden = true;
      $('#programsEmpty p').textContent = "Couldn't reach the SPIFF engine.";
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

    var rows = state.programs.map(function (p) {
      var a   = p.actual_json;
      var pay = (p.payout_json && p.payout_json.amount) || 0;
      var tgt = (p.target_json && p.target_json.units) || 0;
      var cost = p.cost_json || {};

      // A program whose paid rate diverged from the modelled rate is worth seeing at a
      // glance — it changes what the vendor was actually billed.
      var rateFlag = a && a.rate_changed
        ? ' <span class="flag" title="Modelled at ' + money(pay) + ', settled at ' + money(a.spiff_amount) + '">rate ' + money(pay) + '&rarr;' + money(a.spiff_amount) + '</span>'
        : '';

      return '<tr>'
        + '<td><b>' + esc(p.title) + '</b>' + rateFlag + '</td>'
        + '<td>' + esc(p.vendor) + '</td>'
        + '<td><span class="status is-' + esc(p.status) + '">' + esc(p.status) + '</span></td>'
        + '<td class="num">' + money(pay) + '</td>'
        + '<td class="num">' + money(cost.per_unit) + (cost.mode === 'blended' ? ' <span class="hint" title="' + esc(cost.source_label) + '">blended</span>' : '') + '</td>'
        + '<td class="num">' + tgt.toLocaleString() + '</td>'
        + '<td class="num">' + (a ? a.units_sold.toLocaleString() : '&mdash;') + '</td>'
        + '<td class="num">' + (a ? a.bts_hit : '&mdash;') + '</td>'
        + '<td class="num ' + (a && a.roi < 0 ? 'neg' : '') + '">' + (a ? money(a.roi) : '&mdash;') + '</td>'
        + '<td class="num">' + (p.stores_json || []).length + '</td>'
        + '</tr>';
    }).join('');

    list.innerHTML =
      '<table class="grid"><thead><tr>'
      + '<th>Program</th><th>Vendor</th><th>Status</th><th class="num">SPIFF</th><th class="num">Cost/unit</th>'
      + '<th class="num">Target</th><th class="num">Sold</th><th class="num">BTs hit</th><th class="num">ROI</th><th class="num">Stores</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
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
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    wireTabs();
    wirePrograms();
    showTab('programs');
    loadShared();
    loadPrograms();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Exposed for the engine wiring that follows (see /gxwhatsnext for the build order).
  window.SPIFF = { state: state, GX: GX, app: APP, engine: function () { return ENGINE; } };

})();
