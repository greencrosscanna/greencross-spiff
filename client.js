/* GX SPIFF — vendor client view.
 *
 * The read-only page a vendor opens themselves. Tawny sends a per-program link; the rep
 * enters their own email plus the shared password and sees the proposal — what the SPIFF
 * costs them and what it moves.
 *
 * Access needs BOTH: a forwarded link opens nothing without the rep's email on file, and
 * the password alone opens nothing without a link or a matching email. The token scopes
 * to one program, so a vendor cannot reach another brand's numbers by editing the address.
 *
 * Deliberately separate from spiff.js: no admin surface, no program list, and no engine
 * action beyond `clientView`.
 */
'use strict';
(function () {

  var ENGINE = 'https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec';
  var ENG = GXClient(ENGINE);

  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function num(n) { return (Number(n) || 0).toLocaleString(); }

  function token() {
    var m = location.search.match(/[?&]t=([a-zA-Z0-9]+)/);
    return m ? m[1] : '';
  }

  // Access is the rep's own email plus the shared password — so a forwarded link alone
  // opens nothing, and the password alone opens nothing.
  async function open(tok) {
    var pass  = $('#cvPass').value;
    var email = $('#cvEmail').value.trim();
    if (!email || !pass) { $('#cvMsg').textContent = 'Enter your email and the password.'; return; }

    $('#cvMsg').textContent = 'Opening…';
    try {
      // The engine reads a sheet and may hit GX Core; 8s is too tight for a cold call,
      // and each retry repeats the work. Fewer tries, more patience.
      var r = await ENG.jsonp('clientView', { t: tok || token(), email: email, pass: pass },
                              { timeoutMs: 25000, retries: 2 });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not open this proposal.');
      if (r.choices) { renderChoices(r.choices); return; }
      render(r.program);
    } catch (err) {
      $('#cvMsg').textContent = String(err.message || err);
    }
  }

  // A rep on more than one program picks which to open.
  function renderChoices(list) {
    $('#cvMsg').textContent = '';
    var g = $('#gate');
    g.insertAdjacentHTML('beforeend',
      '<div class="client-choices"><h2>Your proposals</h2>'
      + list.map(function (c) {
          return '<button class="gx-btn client-choice" data-t="' + esc(c.token) + '">'
            + esc(c.name) + (c.period ? ' <span>' + esc(c.period) + '</span>' : '') + '</button>';
        }).join('')
      + '</div>');
    g.querySelectorAll('.client-choice').forEach(function (b) {
      b.addEventListener('click', function () { open(b.dataset.t); });
    });
  }

  function render(p) {
    $('#gate').hidden = true;
    var v = $('#view');
    v.hidden = false;

    var period = p.start_date ? esc(p.start_date) + ' – ' + esc(p.end_date || '') : 'Dates to be confirmed';
    var invest = p.results ? p.results.investment : null;

    // Lead with the ask and the movement — this is a pitch, not a data dump.
    var hero = p.results
      ? [ stat('Units sold', num(p.results.units_sold)),
          stat('Budtenders who hit', num(p.results.budtenders_hit)),
          stat('SPIFF each', money(p.results.rate_paid)),
          stat('Total credit', money(invest), 'accent') ]
      : [ stat('Target units', num(p.target_units)),
          stat('Unit lift', '+' + num(p.unit_lift)),
          stat('SPIFF per budtender', money(p.spiff_per_budtender)),
          stat('Added revenue', money(p.revenue_increase), 'accent') ];

    // Totals shown explicitly. These are BEFORE/TARGET figures — they do not sum to
    // "units sold", which counts the program period itself. Leaving a reader to work
    // that out invites them to distrust the whole report.
    var baseTotal = 0, tgtTotal = 0;
    var rows = (p.by_store || []).map(function (s) {
      baseTotal += Number(s.baseline) || 0;
      tgtTotal  += Number(s.target) || 0;
      return '<tr><td>' + esc(s.store) + '</td><td class="n">' + num(s.baseline)
        + '</td><td class="n strong">' + num(s.target) + '</td></tr>';
    }).join('');
    if (rows) {
      rows += '<tr class="total"><td>Total</td><td class="n">' + num(baseTotal)
            + '</td><td class="n strong">' + num(tgtTotal) + '</td></tr>';
    }

    v.innerHTML =
        '<h1>' + esc(p.name) + '</h1>'
      + '<p class="client-sub">' + esc(p.vendor) + ' &middot; ' + period
      +   (p.contact_name ? ' &middot; prepared for ' + esc(p.contact_name) : '') + '</p>'
      + '<div class="client-hero">' + hero.join('') + '</div>'
      + (p.results
          ? '<p class="client-note">These are final results. The credit above is what Green Cross is '
            + 'requesting against the next order.</p>'
          : '<p class="client-note">Green Cross is proposing a ' + money(p.spiff_per_budtender)
            + ' SPIFF per budtender who reaches their individual target. Budtenders who hit earn the '
            + 'bounty; the program is funded as a credit against our next order.</p>')
      + (rows
          ? '<h2>By store</h2><div class="grid-wrap"><table class="grid client-grid"><thead><tr>'
            + '<th>Store</th><th class="n">Before SPIFF</th><th class="n">Goal</th>'
            + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
            + '<p class="client-fine">"Before SPIFF" is each store\'s sell-through in the '
            + 'comparable period before the program; "Goal" is the target it was set. '
            + (p.results ? 'Units sold above counts the program period itself, so it will not match these columns.' : '')
            + '</p>'
          : '');
  }

  function stat(label, value, tone) {
    return '<div class="client-stat' + (tone ? ' is-' + tone : '') + '">'
      + '<span>' + esc(label) + '</span><b>' + value + '</b></div>';
  }

  function boot() {
    $('#cvGo').addEventListener('click', function () { open(); });
    $('#cvPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
    $('#cvEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#cvPass').focus(); });
    $('#cvEmail').focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
