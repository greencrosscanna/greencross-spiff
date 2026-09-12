/* GX SPIFF — the kiosk view.
 *
 * Sky, 2026-09-08: "for Staff to be able to click a SPIFF button from the Kiosk and see the
 * details (payout out, goal, etc) plus a few Selling tips writen by Tawny, hence the request for
 * bullet points."
 *
 * ONE LINK PER STORE, PERMANENT. The token in the URL identifies the SCREEN, not a program — so
 * the same URL sits in a kiosk forever and resolves to whatever is running at that store today.
 * A link minted per program would need re-pasting into six kiosks every time a SPIFF ended, and
 * the first time somebody forgot, a kiosk would show a finished program as though it were live.
 *
 * IT SHOWS NAMES AND PROGRESS SINCE 2026-09-11, and that reversed what this file used to say.
 * Sky's call, confirmed here directly: the kiosk's SPIFF button now opens this page in a popup
 * instead of Leaderboard's own panel, so the per-person bars that lived in that panel moved here.
 * The reason it is not a new exposure: the Leaderboard board on the SAME wall screen already
 * carries every person's SPIFF units and target on their staff card, all day.
 *
 * WHAT IT STILL DELIBERATELY DOES NOT SHOW: anyone's EARNINGS, and no vendor cost, investment or
 * ROI — a customer can read this over the counter, and money per person is the half that reads
 * worst there. The engine's `storeView` route returns none of it, so this page cannot leak it even
 * if it is edited carelessly later: scope lives on the server and this file only has to render
 * honestly. The personal view is flyer.html, which keeps its sign-in and shows what YOU are owed.
 */
'use strict';
(function () {

  var ENGINE = 'https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec';
  var ENG = GXClient(ENGINE);

  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) {
    var v = Number(n) || 0;
    return '$' + (Math.round(v * 100) / 100).toLocaleString(undefined,
      { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  /* Dates arrive as TEXT (YYYY-MM-DD) and are formatted by hand rather than through Date — a
     Date constructor on that string parses as UTC and renders the day before in Los Angeles. */
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function prettyDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? MON[Number(m[2]) - 1] + ' ' + Number(m[3]) : String(s || '');
  }
  /* Inclusive of the end date and counted on whole days, the same rule the operator app uses:
     a program running through the 30th has one day left on the 30th, not none. */
  function daysLeft(endYmd, todayYmd) {
    var a = String(todayYmd).split('-'), b = String(endYmd).split('-');
    if (a.length !== 3 || b.length !== 3) return null;
    var d = Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / 864e5) + 1;
    return d < 0 ? null : d;
  }

  /* THE NAME IS JOINED HERE THE SAME WAY THE OPERATOR APP JOINS IT — vendor in front, unless the
     name already starts with it. The seeded programs carry the vendor in their names because
     Tawny's SPIF docs were titled that way, so a naive prefix would read "Wyld - Wyld 10pc".
     Kept in step with programLabel() in spiff.js deliberately: the kiosk and the operator screen
     must call a program the same thing or a staff question becomes unanswerable. */
  function programLabel(p) {
    var name = String(p.program_name || '').trim(), vendor = String(p.vendor || '').trim();
    if (!vendor) return name;
    if (!name) return vendor;
    if (name.toLowerCase().indexOf(vendor.toLowerCase()) === 0) return name;
    return vendor + ' - ' + name;
  }

  function msg(title, note) {
    $('#main').innerHTML =
      '<div class="fl-card fl-card-msg">'
      +   '<h1 class="fl-h1">' + esc(title) + '</h1>'
      +   (note ? '<p class="fl-note">' + esc(note) + '</p>' : '')
      + '</div>';
  }

  function card(p, today) {
    var perUnit = String(p.payout_type || 'flat').toLowerCase() === 'per_unit';
    var left = daysLeft(p.end_date, today);
    /* The goal a budtender can act on is THEIRS. The store's number is shown underneath as
       context, not as the headline — nobody sells against a chain figure. */
    var bt = Number(p.bt_goal) || 0;
    var store = Number(p.store_goal) || 0;

    return '<article class="st-card">'
      + '<header class="st-head">'
      +   '<div class="st-vendor">' + esc(p.vendor || '') + '</div>'
      +   '<h2 class="st-name">' + esc(programLabel(p)) + '</h2>'
      +   '<div class="st-when">'
      +     '<span class="fl-tag is-live">Running now</span>'
      +     '<span class="st-dates">' + esc(prettyDay(p.start_date)) + ' &ndash; ' + esc(prettyDay(p.end_date))
      +       (left == null ? '' : ' &middot; ' + left + (left === 1 ? ' day left' : ' days left'))
      +     '</span>'
      +   '</div>'
      + '</header>'

      + (p.product ? '<div class="st-product"><span class="st-product-l">Sell</span>'
                   + '<b>' + esc(p.product) + '</b></div>' : '')

      /* THE TWO NUMBERS THAT MATTER, and nothing else in this row. Per-unit programs have no
         individual target to clear — everyone earns from the first unit — so showing a goal of
         0 would read as "you are not in this one". Say what it actually pays instead. */
      + '<div class="st-figs">'
      +   (perUnit
            ? '<div class="st-fig is-pay"><div class="st-fig-v">' + money(p.payout) + '</div>'
              + '<div class="st-fig-l">for every unit you sell</div></div>'
            : '<div class="st-fig"><div class="st-fig-v">' + (bt ? bt.toLocaleString() : '&mdash;') + '</div>'
              + '<div class="st-fig-l">' + (bt ? 'units to hit your bonus' : 'no personal goal set') + '</div></div>'
              + '<div class="st-fig is-pay"><div class="st-fig-v">' + money(p.payout) + '</div>'
              + '<div class="st-fig-l">when you hit it</div></div>')
      + '</div>'

      + (store ? '<div class="st-store-goal">Store target: <b>' + store.toLocaleString()
               + '</b> units</div>' : '')

      /* TAWNY'S TIPS. The reason this page exists beyond the numbers — the numbers say what the
         deal is, these say how to sell it. Absent rather than an empty heading when she has not
         written any: a "Selling tips" label over nothing reads as a broken page. */
      /* THE TEAM, one row each. Everyone at the store is here, including whoever has not sold any
         yet — a board that lists only sellers cannot tell you whether you are behind or missing.
         No money per person: this screen faces the room. */
      + crew(p)

      + ((p.tips || []).length
          ? '<div class="st-tips">'
            + '<div class="st-tips-h">How to sell it</div>'
            + '<ul class="st-tip-list">'
            +   p.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
            + '</ul>'
            + '</div>'
          : '')
      + '</article>';
  }

  /* "2026-09-11 11:00:32" → "11:00am". The figures come from the hourly refresh, not live, and a
     board that does not say so is a board that gets trusted to the minute. */
  function prettyStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return '';
    var h = Number(m[4]), ap = h >= 12 ? 'pm' : 'am';
    return ((h % 12) || 12) + ':' + m[5] + ap;
  }

  function crew(p) {
    var people = p.people || [];
    if (!people.length) return '';
    var goal = Number(p.bt_goal) || 0;
    var perUnit = String(p.payout_type || 'flat').toLowerCase() === 'per_unit';
    var at = prettyStamp(p.measured_at);

    return '<div class="st-crew">'
      + '<div class="st-crew-h">'
      +   '<span>' + (perUnit ? 'Sold so far' : 'How everyone is doing') + '</span>'
      +   (at ? '<span class="st-crew-at">as of ' + esc(at) + '</span>' : '')
      + '</div>'
      + people.map(function (e) {
          var units = Number(e.units) || 0;
          /* Against a goal of zero there is nothing to draw — a full-width empty track reads as
             "you have sold nothing" on a program that has no personal target at all. */
          var pct = goal > 0 ? Math.max(0, Math.min(100, (units / goal) * 100)) : 0;
          return '<div class="st-bt' + (e.hit ? ' is-hit' : '') + '">'
            + '<span class="st-bt-n">' + esc(e.name) + '</span>'
            + (goal > 0
                ? '<span class="st-bt-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>'
                : '<span class="st-bt-bar is-none"></span>')
            + '<span class="st-bt-u">' + units.toLocaleString()
            +   (goal > 0 ? '<small>/' + goal.toLocaleString() + '</small>' : '')
            + '</span>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  function render(d) {
    var list = d.programs || [];
    if (!list.length) {
      msg('No SPIFF running right now',
          'Nothing on the board at ' + (d.store_name || 'this store') + ' today. '
          + 'Check back — this screen updates on its own.');
      return;
    }
    $('#main').innerHTML =
      /* Two columns only when there are two programs — see store.css. One program in a
         two-column grid rendered at half width beside an empty half, which reads as a card that
         failed to load rather than a chain running one SPIFF. */
      '<div class="st-wrap' + (list.length > 1 ? ' is-multi' : '') + '">'
      + '<div class="st-top">'
      +   '<span class="st-store">' + esc(d.store_name || d.store_id) + '</span>'
      +   '<span class="st-count">' + list.length + (list.length === 1 ? ' program' : ' programs') + ' running</span>'
      + '</div>'
      + list.map(function (p) { return card(p, d.today); }).join('')
      /* No pointer to My SPIFF (Sky, 2026-09-08). This is a SHARED screen: sending the room to a
         page that needs a personal sign-in is an instruction most readers cannot follow where
         they are standing, and it invited somebody to sign in on a kiosk everybody uses. */
      + '<p class="st-foot">Ask Tawny about any of these.</p>'
      + '</div>';
  }

  async function load() {
    var t = new URLSearchParams(location.search).get('t') || '';
    if (!t) {
      msg('This link is incomplete', 'Ask Tawny for this store’s SPIFF link.');
      return;
    }
    try {
      var r = await ENG.jsonp('storeView', { t: t }, { timeoutMs: 20000, retries: 2 });
      /* The engine says WHY — a revoked link and a store with nothing running are different
         facts, and telling somebody the wrong one sends them looking in the wrong place. */
      if (!r || !r.ok) { msg('This SPIFF board is unavailable', (r && r.error) || 'Please try again.'); return; }
      render(r);
    } catch (e) {
      /* A kiosk reloads on its own and nobody is standing there to read a stack trace. Say the
         plain thing and let the refresh below have another go. */
      msg('Can’t reach the SPIFF board', 'It will try again shortly.');
    }
  }

  /* A KIOSK IS NEVER RELOADED BY HAND, so it refreshes itself. Ten minutes: goals and tips
     change when Tawny edits them, which is rarely, and this screen shows nothing that moves by
     the minute — no live sell-through, no earnings. Frequent polling would buy nothing and put
     six shop screens on the engine's neck all day. */
  var REFRESH_MS = 10 * 60 * 1000;
  setInterval(load, REFRESH_MS);
  /* …and immediately when the screen is woken, so a kiosk that slept overnight is not showing
     yesterday's program to the morning shift. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });

  load();
})();
