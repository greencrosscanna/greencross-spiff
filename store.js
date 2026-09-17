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
 * Sky's call, confirmed here directly: the kiosk's SPIFF button opened this page in a popup back
 * then, instead of Leaderboard's own panel, so the per-person bars that lived in that panel moved
 * here. It was not a new exposure because the Leaderboard board on the SAME wall screen already
 * carries every person's SPIFF units and target on their staff card, all day.
 *
 * THE KIOSK NO LONGER OPENS THIS PAGE AT ALL (Leaderboard v1.879, 2026-09-17). Leaderboard draws
 * its SPIFF panel natively from the `programs` sidecar and has deleted the iframe that used to
 * load this file, so nothing on a kiosk reaches this page any more. The reader left is whoever
 * opens the store link BY HAND — Sky or Tawny, on a phone or a laptop, checking what one of six
 * stores is showing. The link is still per store and still permanent; what changed is that
 * nothing frames this page any more, which is why it names its own store again below.
 *
 * WHAT IT STILL DELIBERATELY DOES NOT SHOW: anyone's EARNINGS, and no vendor cost, investment or
 * ROI. That did not loosen when the kiosk stopped loading it — the token in the URL is the whole
 * credential, so the link is forwardable and can be read over a counter either way, and money per
 * person is the half that reads worst there. The engine's `storeView` route returns none of it, so
 * this page cannot leak it even if it is edited carelessly later: scope lives on the server and
 * this file only has to render honestly. The personal view is flyer.html, which keeps its sign-in and shows what YOU are owed.
 *
 * REDESIGNED 2026-09-16 (design_handoff_spiff_kiosk_board). Three panels: what is running, where
 * everyone stands, how to sell it. The board was a footnote under the figures and is now the
 * centerpiece — ranked, because it is what staff come to the screen for.
 *
 * THE STORE NAME IS BACK ON THE PAGE (2026-09-17). It was dropped with that redesign for a reason
 * that has since expired: the kiosk modal framing this page already said "SPIFF · Century", and a
 * page repeating its own frame reads as two headers stacked. With the frame deleted, a board
 * opened by hand named no store anywhere — six stores, one identical-looking page. So it says
 * which store it is, once and quietly, not as the old 20px heading with a program count beside it.
 * The "as of" stamp and the footer line stay gone: those were separate de-cluttering calls and
 * neither of them depended on the frame.
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

  /* Every state that is not a board uses the same panel, so a kiosk showing a problem still looks
     like a screen somebody designed rather than a page that failed. */
  function msg(title, note, extra) {
    $('#main').innerHTML =
      '<div class="st-wrap">'
      + '<div class="st-msg">'
      +   '<div class="st-msg-h">' + esc(title) + '</div>'
      +   (note ? '<div class="st-msg-b">' + esc(note) + '</div>' : '')
      +   (extra || '')
      + '</div>'
      + '</div>';
  }

  /* ── 1. WHAT IS RUNNING ───────────────────────────────────────────────────────────────────── */
  function programPanel(p, today) {
    var perUnit = String(p.payout_type || 'flat').toLowerCase() === 'per_unit';
    var bt = Number(p.bt_goal) || 0;
    var left = daysLeft(p.end_date, today);

    /* A per-unit program has no individual target to clear — everyone earns from the first unit —
       so a goal of 0 would read as "you are not in this one". Say what it actually pays. */
    var goalFig = perUnit ? 'Any' : (bt ? bt.toLocaleString() : '&mdash;');
    var goalLabel = perUnit ? 'unit pays &mdash; no personal goal'
                            : (bt ? 'units to hit your bonus' : 'no personal goal set');
    var daysFig = left == null ? '&mdash;' : String(left);
    var daysLabel = (left == null ? 'ends ' : (left === 1 ? 'day left, ends ' : 'days left, ends '))
                  + esc(prettyDay(p.end_date));

    return '<article class="st-card">'
      + '<div class="st-vendor">' + esc(p.vendor || '') + '</div>'
      + '<h1 class="st-name">' + esc(programLabel(p)) + '</h1>'
      + '<div class="st-when">'
      +   '<span class="st-live">Running now</span>'
      +   '<span class="st-dates">' + esc(prettyDay(p.start_date)) + ' &ndash; ' + esc(prettyDay(p.end_date)) + '</span>'
      + '</div>'

      + (p.product ? '<div class="st-product"><span class="st-product-l">Sell</span>'
                   + '<b>' + esc(p.product) + '</b></div>' : '')

      /* THE THREE THINGS A BUDTENDER ACTS ON, and nothing else. What it pays, how far they have to
         go, how long they have. Three, not six: this is read from a few feet away between
         customers, and a strip of figures is a dashboard rather than an instruction. */
      + '<div class="st-figs">'
      +   '<div class="st-fig is-pay"><div class="st-fig-v">' + money(p.payout) + '</div>'
      +     '<div class="st-fig-l">' + (perUnit ? 'for every unit you sell' : 'when you hit your goal') + '</div></div>'
      +   '<div class="st-fig"><div class="st-fig-v">' + goalFig + '</div>'
      +     '<div class="st-fig-l">' + goalLabel + '</div></div>'
      /* The clock turns gold at three days out — the one figure on the screen that changes what
         somebody does today rather than what they know. */
      +   '<div class="st-fig' + (left != null && left <= 3 ? ' is-soon' : '') + '">'
      +     '<div class="st-fig-v">' + daysFig + '</div>'
      +     '<div class="st-fig-l">' + daysLabel + '</div></div>'
      + '</div>'
      + '</article>';
  }

  /* ── 2. THE BOARD ─────────────────────────────────────────────────────────────────────────────
     THE TEAM, ranked, one row each. Everyone at the store is here, including whoever has not sold
     any yet — a board that lists only sellers cannot tell you whether you are behind or missing.
     No money per person: this screen faces the room. */
  function board(p) {
    var people = (p.people || []).slice();
    if (!people.length) return '';
    var goal = Number(p.bt_goal) || 0;
    var storeGoal = Number(p.store_goal) || 0;

    /* The engine sorts too, and this repeats it on purpose rather than trusting the order a
       payload happened to arrive in — the ranking is the screen's own claim, and the rank number
       beside a name has to be the position the row is actually in. */
    people.sort(function (a, b) {
      var d = (Number(b.units) || 0) - (Number(a.units) || 0);
      return d || String(a.name).localeCompare(String(b.name));
    });

    var sold = people.reduce(function (s, e) { return s + (Number(e.units) || 0); }, 0);
    var hits = people.filter(function (e) { return !!e.hit; }).length;
    /* With no personal goal there is nothing to hit, so the count says what there IS to say. */
    var count = goal > 0 ? (hits + ' of ' + people.length + ' hit')
                         : (sold.toLocaleString() + (sold === 1 ? ' unit sold' : ' units sold'));
    var leader = Number(people[0] && people[0].units) || 0;

    return '<section class="st-board">'
      + '<div class="st-board-h">'
      +   '<div class="st-board-t">' + (goal > 0 ? 'Where everyone stands' : 'Sold so far') + '</div>'
      +   '<div class="st-board-n' + (goal > 0 && hits ? ' is-hit' : '') + '">' + esc(count) + '</div>'
      + '</div>'

      /* The store's number is context under the title, not a headline — nobody sells against a
         chain figure. Absent rather than "42 of 0" when no store goal was set. */
      + (storeGoal
          ? '<div class="st-store-row">'
            + '<span class="st-store-l">Store</span>'
            + '<span class="st-store-bar"><i style="width:'
            +   Math.max(0, Math.min(100, (sold / storeGoal) * 100)).toFixed(1) + '%"></i></span>'
            + '<span class="st-store-n">' + sold.toLocaleString() + ' of '
            +   storeGoal.toLocaleString() + ' units</span>'
            + '</div>'
          : '')

      + '<div class="st-rows">'
      + people.map(function (e, i) {
          var units = Number(e.units) || 0;
          var hit = !!e.hit;
          /* A per-unit program has no goal to draw against, so the bars are scaled to the leader —
             a row is then "how you compare", which is the only question the screen can answer. A
             full-width empty track against a goal of zero read as "you have sold nothing". */
          var ref = goal > 0 ? goal : (leader || 1);
          var pct = Math.max(0, Math.min(100, (units / ref) * 100));
          var state = hit ? ' is-hit' : (units ? ' is-selling' : '');
          return '<div class="st-bt' + state + '">'
            + '<span class="st-bt-r">' + (i + 1) + '</span>'
            + '<span class="st-bt-n">' + esc(e.name) + '</span>'
            + '<span class="st-bt-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>'
            + '<span class="st-bt-u">' + units.toLocaleString()
            +   (goal > 0 ? '<small>/' + goal.toLocaleString() + '</small>' : '')
            + '</span>'
            + '</div>';
        }).join('')
      + '</div>'
      + '</section>';
  }

  /* ── 3. TAWNY'S TIPS ──────────────────────────────────────────────────────────────────────────
     The reason this page exists beyond the numbers — the numbers say what the deal is, these say
     how to sell it. The whole panel is ABSENT rather than an empty heading when she has written
     none: a "How to sell it" label over nothing reads as a broken page. */
  function tips(p) {
    var list = p.tips || [];
    if (!list.length) return '';
    return '<section class="st-tips">'
      + '<div class="st-tips-h">How to sell it &middot; from Tawny</div>'
      + '<ol class="st-tip-list">'
      + list.map(function (t, i) {
          return '<li class="st-tip">'
            + '<span class="st-tip-n">' + (i + 1) + '</span>'
            + '<span class="st-tip-t">' + esc(t) + '</span>'
            + '</li>';
        }).join('')
      + '</ol>'
      + '</section>';
  }

  /* NOTHING RUNNING IS A SCREEN, not a blank. How the store finished the last one is the one thing
     worth saying to a room with no SPIFF on today — and it comes from the engine, which is the
     only place that knows it. No chip rather than a guessed one when it did not send it. */
  function emptyBoard(d) {
    var last = d.last_program;
    var chip = '';
    if (last && (last.program_name || last.vendor)) {
      chip = '<div class="st-last">'
        + '<span class="st-last-l">Last one</span>'
        /* Joined by the same rule as a live program, so the board calls a SPIFF one thing whether
           it is running or finished. */
        + '<span class="st-last-p">' + esc(programLabel(last))
        +   (last.end_date ? ', ended ' + esc(prettyDay(last.end_date)) : '') + '</span>'
        + (last.store_pct != null
            ? '<span class="st-last-r">store hit ' + Math.round(Number(last.store_pct)) + '%</span>'
            : '')
        + '</div>';
    }
    msg('Nothing running right now',
        'The next SPIFF at ' + (d.store_name || 'this store')
        + ' shows up here on its own. Nothing to do but sell.',
        chip);
  }

  function render(d) {
    var list = d.programs || [];
    if (!list.length) { emptyBoard(d); return; }

    /* ONE PROGRAM AT A TIME is the case this is designed for — Sky, 2026-09-16 — so there is no
       two-column grid any more. If the engine ever answers with two, they stack: hiding the second
       to protect a layout would take a live program off a shop floor. */
    $('#main').innerHTML =
      '<div class="st-wrap"'
      + (d.store_color ? ' style="--st-color:' + esc(d.store_color) + '"' : '') + '>'
      /* WHICH STORE THIS IS. Nothing frames this page any more, so the page says it — and the
         empty state has said it all along, in the sentence about the next SPIFF, which is how a
         live board ended up being the one view that named no store. The engine falls the name
         back to the slug, so this line is never blank on a board that answered. */
      + '<div class="st-where">' + esc(d.store_name || d.store_id || '') + '</div>'
      + list.map(function (p) {
          return programPanel(p, d.today) + board(p) + tips(p);
        }).join('')
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
     change when Tawny edits them, which is rarely, and the sell-through behind the board is the
     hourly cache, not a live pull. Frequent polling would buy nothing and put six shop screens on
     the engine's neck all day. */
  var REFRESH_MS = 10 * 60 * 1000;
  setInterval(load, REFRESH_MS);
  /* …and immediately when the screen is woken, so a kiosk that slept overnight is not showing
     yesterday's program to the morning shift. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });

  load();
})();
