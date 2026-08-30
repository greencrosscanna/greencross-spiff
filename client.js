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
  /* The sign goes BEFORE the dollar sign. Number#toLocaleString puts it after, so a net loss
     printed as "$-315" on a page that goes to a vendor. */
  function money(n) {
    var v = Number(n) || 0;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
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

    var period = p.start_date ? prettyDay(p.start_date) + ' – ' + prettyDay(p.end_date || '') : 'Dates to be confirmed';
    var r = p.results;

    /* Per-store rows carry the RESULT when there is one, and only the plan when there is not.
       A results page whose table still shows targets invites the reader to check the sum
       against the headline and find it does not tie. */
    /* A closed program has no rows in the progress cache — it is only ever swept while ACTIVE —
       so the per-store Sold/Hit columns had nothing behind them and printed 0 for every store,
       under a headline of 117 units sold. Show the columns only when there is something real to
       put in them; the totals are still stated above, and a missing breakdown is a far smaller
       problem than a breakdown that contradicts it. */
    var showRes = !!(r && p.has_store_results);
    var rows = '', baseTotal = 0, tgtTotal = 0, soldTotal = 0, hitTotal = 0, btTotal = 0;
    (p.by_store || []).forEach(function (s2) {
      baseTotal += Number(s2.baseline) || 0;
      tgtTotal  += Number(s2.target) || 0;
      soldTotal += Number(s2.sold) || 0;
      hitTotal  += Number(s2.hit) || 0;
      btTotal   += Number(s2.budtenders) || 0;
      /* vs goal, per store. The point of the table for a vendor is WHICH stores carried the
         program and which did not — a column of raw units makes them do that subtraction in
         their head, six times, and they will not. */
      var d = Number(s2.delta) || 0;
      rows += '<tr><td>' + esc(s2.store) + '</td>'
        + '<td class="n">' + num(s2.baseline) + '</td>'
        + '<td class="n">' + num(s2.target) + '</td>'
        + (showRes ? '<td class="n strong">' + num(s2.sold) + '</td>'
             + '<td class="n ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">'
             + (d > 0 ? '+' : '') + num(d) + '</td>'
             + '<td class="n">' + num(s2.hit) + ' / ' + num(s2.budtenders) + '</td>' : '')
        + '</tr>';
    });
    if (rows) {
      rows += '<tr class="total"><td>Total</td>'
        + '<td class="n">' + num(baseTotal) + '</td>'
        + '<td class="n">' + num(tgtTotal) + '</td>'
        + (showRes ? '<td class="n">' + num(soldTotal) + '</td>'
             + '<td class="n ' + (soldTotal - tgtTotal > 0 ? 'up' : soldTotal - tgtTotal < 0 ? 'down' : '') + '">'
             + (soldTotal - tgtTotal > 0 ? '+' : '') + num(soldTotal - tgtTotal) + '</td>'
             + '<td class="n">' + num(hitTotal) + ' / ' + num(btTotal) + '</td>' : '')
        + '</tr>';
    }

    var head =
        '<div class="cv-eyebrow">Prepared for ' + esc(p.vendor || '') + '</div>'
      + '<h1 class="cv-h1">' + esc(p.name) + '</h1>'
      + '<p class="cv-sub">' + esc(period)
      +   (p.contact_name ? ' · prepared for ' + esc(p.contact_name) : '')
      +   ' by Green Cross Cannabis Emporium</p>';

    setFoot(!!r);

    if (!r) {
      /* A PROPOSAL, not results. Same shape, but it must never imply anything has happened —
         so it leads with the ask rather than a return, and every figure is labelled as a plan. */
      v.innerHTML = head
        + '<div class="cv-roi"><div class="cv-roi-l">The proposal</div>'
        +   '<div class="cv-roi-v">' + money(p.spiff_per_budtender) + '</div>'
        +   '<p class="cv-roi-p">A <b>' + money(p.spiff_per_budtender) + '</b> bounty for each budtender '
        +     'who reaches their own target, across <b>' + num((p.by_store || []).length) + ' stores</b>. '
        +     'Budtenders who hit earn it; those who do not cost nothing. Funded as a credit against '
        +     'our next order.</p></div>'
        + '<div class="cv-stats">'
        +   cvStat('Target units', num(p.target_units), 'across the program', '')
        +   cvStat('Unit lift', '+' + num(p.unit_lift), 'over the prior period', '')
        +   cvStat('Budtenders', num(p.budtenders), 'each with their own target', '')
        +   cvStat('At most', money(p.investment), 'only if every one hits', 'is-credit')
        + '</div>'
        + storeTable(rows, false)
        + '<p class="cv-fine">&ldquo;Before SPIFF&rdquo; is each store&rsquo;s sell-through in the '
        +   'comparable period before the program; &ldquo;Goal&rdquo; is the target it would be set.</p>';
      return;
    }

    var credit  = Number(r.investment) || 0;
    var added   = Number(r.added_revenue) || 0;
    var net     = added - credit;
    var sold    = Number(r.units_sold) || 0;
    var before  = baseTotal;
    var extra   = before ? sold - before : 0;
    var growth  = before ? Math.round((extra / before) * 100) : null;
    var overGoal = tgtTotal ? sold - tgtTotal : null;

    var roiPct = credit ? Math.round((net / credit) * 100) : null;

    /* LEAD WITH THE STRONGEST TRUE RESULT — and only ever a true one.
     *
     * This page is a sales tool: Tawny sends it to ask a vendor to fund the next program. BeGoat
     * grew sell-through 352% over the prior period and cleared its goal, and the page led with
     * "-59%" because ROI happened to be the hard-coded headline. That is an own goal — the least
     * flattering true fact, in 54px, at the top.
     *
     * So the headline is CHOSEN: the best genuinely-positive claim available, in order of how much
     * a vendor cares. Nothing is invented and nothing is hidden — whichever metric does not win
     * the headline is still rendered below as a stat, INCLUDING a negative return. Reframing what
     * leads is fair; removing a number the vendor is entitled to see is not, and the sentence
     * under the headline still states the credit, the added revenue and the net in words.
     *
     * If nothing is positive, ROI leads and wears the loss styling. A page with no good news
     * should not go hunting for a flattering angle. */
    var headline = null;
    if (roiPct != null && roiPct > 0) {
      headline = { label: 'Return on the SPIFF', value: roiPct.toLocaleString('en-US') + '%', down: false };
    } else if (growth != null && growth > 0) {
      headline = { label: 'Sales growth over the prior period', value: '+' + growth + '%', down: false };
    } else if (overGoal != null && overGoal > 0) {
      headline = { label: 'Units over goal', value: '+' + num(overGoal), down: false };
    } else {
      headline = { label: 'Return on the SPIFF',
                   value: roiPct == null ? '—' : roiPct.toLocaleString('en-US') + '%',
                   down: roiPct != null && roiPct < 0 };
    }
    /* The return still gets stated whenever it is not the headline. This is the line that keeps
       the choice above honest — delete it and the page starts concealing rather than reframing. */
    var roiStat = (roiPct != null && headline.label !== 'Return on the SPIFF')
      ? cvStat('Return on the SPIFF', roiPct.toLocaleString('en-US') + '%',
               money(added) + ' back on ' + money(credit) + ' credited', roiPct < 0 ? 'is-down' : '')
      : '';

    v.innerHTML = head
      + '<div class="cv-roi' + (headline.down ? ' is-down' : '') + '"><div class="cv-roi-l">'
      +   esc(headline.label) + '</div>'
      +   '<div class="cv-roi-v">' + headline.value + '</div>'
      /* The same numbers again in a sentence. A percentage on its own is easy to disbelieve
         and hard to repeat to a colleague; the sentence is what gets forwarded. */
      +   '<p class="cv-roi-p">A <b>' + money(credit) + '</b> bounty moved <b>' + num(extra)
      +     ' extra units</b> — about <b>' + money(added) + '</b> of additional sell-through, a net <b>'
      +     money(net) + '</b> to ' + esc(p.vendor || 'you') + '.'
      +     (growth == null ? '' : ' Sales ran <b>' + growth + '% above</b> the comparable period before the program')
      /* SIGN-BLIND, AND IT SAID THE OPPOSITE OF THE TRUTH. overGoal is sold - target, so BeGoat's
         117 against a 120 goal gave -3 — and Math.abs turned that into "cleared the goal by 3
         units" on a page sent to the vendor. A program that MISSED its goal was telling the vendor
         it beat it. The wording now follows the sign, and a dead-on result reads as neither. */
      +     (overGoal == null ? ''
             : (growth == null ? ' Sales' : ' and')
               + (overGoal > 0 ? ' cleared the goal by ' + num(overGoal) + ' units'
                : overGoal < 0 ? ' finished ' + num(Math.abs(overGoal)) + ' units short of the goal'
                :                ' landed exactly on the goal'))
      +     '.</p></div>'
      + '<div class="cv-stats">'
      +   cvStat('Units sold', num(sold), tgtTotal ? 'goal ' + num(tgtTotal) + ' · ' + (overGoal >= 0 ? '+' : '') + num(overGoal) : '', '')
      +   cvStat('Growth over prior', growth == null ? '—' : (growth >= 0 ? '+' : '') + growth + '%',
                 before ? num(before) + ' → ' + num(sold) + ' units' : '', '')
      /* Read the headcount from the payload, not from a table that may have no result columns.
         btTotal is summed from the per-store rows, which are empty for a closed program — so this
         said "18 of 0". And when the headcount is genuinely unknown (target_json carries no
         budtender count on older imported programs) the comparison is DROPPED rather than
         asserting "of 0", which reads as a program nobody was enrolled in. */
      +   cvStat('Budtenders who hit', num(r.budtenders_hit),
                 (function () {
                   var of = btTotal || Number(r.budtenders) || Number(p.budtenders) || 0;
                   return (of ? 'of ' + num(of) + ' · ' : '') + money(r.rate_paid) + ' each';
                 })(), '')
      +   cvStat('Total credit', money(credit), 'requested against the next order', 'is-credit')
      +   roiStat
      + '</div>'
      + storeTable(rows, showRes)
      + '<p class="cv-fine">&ldquo;Before SPIFF&rdquo; is each store&rsquo;s sell-through in the comparable '
      +   'period before the program. &ldquo;Sold&rdquo; counts the program period itself. Figures come '
      +   'from Dutchie point-of-sale data.</p>';
  }

  /* The footer was hardcoded to "figures are estimates based on recent sell-through" — true of
     a proposal, and plainly false on a page showing a closed program's final numbers with a
     credit attached to them. A vendor reading "estimates" beside an invoice figure has every
     reason to query it. */
  function setFoot(isResults) {
    var el = document.getElementById('cvFoot');
    if (!el) return;
    el.textContent = isResults
      ? 'Green Cross Cannabis Emporium · final figures from Dutchie point-of-sale data.'
      : 'Green Cross Cannabis Emporium · figures are estimates based on recent sell-through.';
  }

  function storeTable(rows, withResults) {
    if (!rows) return '';
    return '<div class="cv-h2">By store</div><div class="cv-tbl-wrap"><table class="cv-tbl"><thead><tr>'
      + '<th>Store</th><th class="n">Before SPIFF</th><th class="n">Goal</th>'
      + (withResults ? '<th class="n">Sold</th><th class="n">vs goal</th><th class="n">Budtenders hit</th>' : '')
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cvStat(label, value, sub, cls) {
    return '<div class="cv-stat ' + cls + '"><div class="cv-stat-l">' + esc(label) + '</div>'
      + '<div class="cv-stat-v">' + value + '</div>'
      + (sub ? '<div class="cv-stat-s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /* Dates are TEXT (YYYY-MM-DD). Split, never new Date(str) — that parses as UTC and renders
     the day before in our timezone. Same rule as the rest of the app. */
  function prettyDay(s2) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s2 || ''));
    if (!m) return String(s2 || '');
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return MON[Number(m[2]) - 1] + ' ' + Number(m[3]);
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
