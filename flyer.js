/* GX SPIFF — the employee flyer.
 *
 * The standalone half of Sky's ruling: a SPIFF user with no Inventory access gets THIS, not the
 * operator app. One screen answering one question — what is running, what is my number, what do I
 * have coming. Once Send-to-Managers reaches ~12 managers, most SPIFF users will never see
 * anything else.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: vendor cost, ROI, investment, or any coworker's units. The
 * engine's `flyer` route already refuses to hand those over — it returns exactly the caller's own
 * row — so this page cannot leak them even if someone edits it carelessly later. Scope lives on
 * the server; this file only has to render honestly.
 */
'use strict';
(function () {

  var GXCORE = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
  var ENGINE = 'https://script.google.com/macros/s/AKfycbw0JUgI01c7iaJRnuQgHdjUazDPtyEiEHZvlYkjflLSIVMY7qs-0Bkv4gPoxt8o2e6JZw/exec';
  var APP    = 'spiff';

  var GX  = GXClient(GXCORE);
  var ENG = GXClient(ENGINE);

  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  /* Dates are TEXT (YYYY-MM-DD) everywhere in this app. Format by SPLITTING, never by
     new Date(str) — that parses as UTC and renders the day before in our timezone. */
  function prettyDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return String(s || '');
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return MON[Number(m[2]) - 1] + ' ' + Number(m[3]);
  }

  /* Same sessionStorage key and reasoning as the operator app: a credentialed session on a
     machine that may not be this person's own, so it dies with the tab. */
  function session() {
    try { return JSON.parse(sessionStorage.getItem('spiff_session') || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) { try { sessionStorage.setItem('spiff_session', JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { sessionStorage.removeItem('spiff_session'); } catch (e) {} }

  /* ------------------------------------------------------------------ gate */
  function renderGate(errMsg) {
    $('#main').innerHTML =
      '<div class="gx-login-card fl-card">' +
        '<div class="gx-login-head">' +
          '<img class="gx-login-mark" src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">' +
          '<div class="gx-login-sub">My SPIFF</div>' +
        '</div>' +
        '<form class="gx-login-form" id="gForm">' +
          '<label class="gx-login-field"><span>Username</span>' +
            '<input class="gx-input" id="gUser" autocomplete="username" required></label>' +
          '<label class="gx-login-field"><span>Password</span>' +
            '<input class="gx-input" id="gPass" type="password" autocomplete="current-password" required></label>' +
          '<button type="submit" class="gx-btn gx-btn-green gx-login-submit">Sign in</button>' +
          '<div class="gx-login-err">' + esc(errMsg || '') + '</div>' +
        '</form>' +
      '</div>';
    $('#gForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = $('#gForm button'), err = $('#gForm .gx-login-err');
      var u = $('#gUser').value.trim(), pw = $('#gPass').value;
      btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
      try {
        var r = await GX.jsonp('login', { user: u, pass: pw, app: APP });
        // Branch on `code`, never on `error` — same contract the operator app uses.
        if (r && r.code === 'no_access') { renderNoAccess(u); return; }
        if (!r || !r.ok) throw new Error((r && r.error) || 'Sign-in failed');
        setSession({ user: r.user, name: r.displayName || r.user, avatar: r.avatarConfig || null,
                     role: r.role, token: r.token });
        load();
      } catch (e) {
        err.textContent = (e && e.message) || 'Sign-in failed';
        btn.disabled = false; btn.textContent = 'Sign in';
        $('#gPass').value = '';
      }
    });
    $('#gUser').focus();
  }

  function renderNoAccess(who) {
    $('#main').innerHTML =
      '<div class="gx-login-card fl-card">' +
        '<div class="gx-login-head">' +
          '<img class="gx-login-mark" src="https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png" alt="Green Cross">' +
          '<div class="gx-login-sub">My SPIFF</div>' +
        '</div>' +
        '<div class="fl-msg">' +
          '<p class="fl-lead">You are signed in' + (who ? ' as <strong>' + esc(who) + '</strong>' : '') +
            ', but your account has not been granted SPIFF.</p>' +
          '<p class="fl-note">Nothing is wrong with your password. Ask Sky to add SPIFF to your ' +
            'account, then reload this page.</p>' +
          '<button class="gx-btn" id="flOther">Sign in as someone else</button>' +
        '</div>' +
      '</div>';
    $('#flOther').addEventListener('click', function () { clearSession(); renderGate(); });
  }

  /* --------------------------------------------------------------- the card */
  function renderFlyer(d) {
    /* No employee link. Sam Keck's gap exactly: a real account whose employees.user_id was
       never set. Say which field is empty rather than guessing a person by name — a near-miss
       there would show someone another person's earnings. */
    if (!d.linked) {
      /* The engine names the exact empty field, deliberately, so whoever fixes it knows where to
         look. But a budtender cannot act on "set user_id on your row" and should not be shown a
         column name — so the page says the actionable half and the diagnostic stays in the API
         response for Sky. */
      $('#main').innerHTML =
        '<div class="fl-card fl-card-msg">' +
          '<h1 class="fl-h1">We can\'t find your numbers yet</h1>' +
          '<p class="fl-note">Your account isn\'t linked to your employee record, so we can\'t tell ' +
            'which sales are yours. Ask Sky to link it &mdash; then reload this page.</p>' +
          '<button class="gx-btn" id="flOut">Sign out</button>' +
        '</div>';
      $('#flOut').addEventListener('click', signOut);
      return;
    }

    var who = (d.employee && d.employee.name) || 'You';

    if (!d.program) {
      $('#main').innerHTML =
        '<div class="fl-card fl-card-msg">' +
          '<h1 class="fl-h1">No SPIFF running right now</h1>' +
          '<p class="fl-note">' + esc(d.note || 'Nothing on the board yet.') +
            ' You\'ll see your target here as soon as one starts.</p>' +
          '<button class="gx-btn" id="flOut">Sign out</button>' +
        '</div>';
      $('#flOut').addEventListener('click', signOut);
      return;
    }

    var p = d.program, m = d.mine || {};
    var perUnit = String(p.payout_type || 'flat').toLowerCase() === 'per_unit';
    var units = Number(m.units) || 0, target = Number(m.target) || 0;
    var pct = target > 0 ? Math.min(100, Math.round((units / target) * 100)) : (units > 0 ? 100 : 0);

    /* is_current is the server's answer, not a guess from the dates. Saying "this program has
       ended" when it has not — or the reverse — is exactly the kind of wrong a budtender would
       act on, so the label follows the flag. */
    var when = prettyDate(p.start_date) + ' – ' + prettyDate(p.end_date);
    var status = d.is_current
      ? '<span class="fl-tag is-live">Running now</span><span class="fl-when">' + esc(when) + '</span>'
      : '<span class="fl-tag is-done">Finished</span><span class="fl-when">' + esc(when) + '</span>';

    var headline, sub;
    if (perUnit) {
      headline = money(m.payout);
      sub = units + (units === 1 ? ' unit' : ' units') + ' &times; ' + money(m.rate) + ' a unit';
    } else if (m.hit) {
      headline = money(m.payout);
      sub = 'You hit your target of ' + target + '.';
    } else {
      headline = money(0);
      sub = target > 0
        ? (Math.max(0, target - units)) + ' more to go — the bonus is ' + money(m.rate) + ' at ' + target + '.'
        : 'No target was set for you on this one.';
    }

    var storeName = (d.employee && d.employee.home_store) || '';
    var cleared = m.hit || (perUnit && units > 0);

    /* The bar carries the TARGET as a tick rather than treating it as the end of the track, so
       going past it is visible. A fill that stops at 100% tells someone who sold 81 against a
       target of 74 exactly the same thing as someone who sold 74. */
    var span = Math.max(units, target) || 1;
    var fillPct = Math.min(100, (units / span) * 100);
    var tickPct = target ? Math.min(100, (target / span) * 100) : null;

    $('#main').innerHTML =
      '<div class="fl-card">' +
        '<div class="fl-top">' +
          '<div class="fl-id">' +
            '<span class="fl-av">' + esc(initials(who)) + '</span>' +
            '<span><span class="fl-id-n">' + esc(who) + '</span>' +
              (storeName ? '<span class="fl-id-s">' + esc(prettyStore(storeName)) + '</span>' : '') +
            '</span>' +
          '</div>' +
          '<button class="gx-btn fl-out" id="flOut">Sign out</button>' +
        '</div>' +

        '<div class="fl-prog">' +
          '<div class="fl-vendor">' + esc(p.vendor || '') + '</div>' +
          '<h1 class="fl-h1">' + esc(p.name || p.vendor || 'SPIFF') + '</h1>' +
          '<div class="fl-status">' + status + '</div>' +
        '</div>' +

        '<div class="fl-hero' + (cleared ? ' is-paid' : '') + '">' +
          // NOT "on track for": that reads as a projection, and on a running program where the
          // target is not met yet it would pair the word "track" with $0 -- which sounds like a
          // verdict rather than a running total. This is simply what is banked today.
          '<div class="fl-earned-l">' + (d.is_current ? 'Earned so far' : 'You earned') + '</div>' +
          '<div class="fl-earned-v">' + headline + '</div>' +
          '<div class="fl-earned-s">' + sub + '</div>' +
        '</div>' +

        (perUnit ? '' :
          '<div class="fl-track' + (m.hit ? ' is-hit' : '') + '" role="img" aria-label="' +
              units + ' sold of a ' + target + ' target">' +
            '<div class="fl-track-fill" style="width:' + fillPct.toFixed(1) + '%"></div>' +
            (tickPct == null ? '' : '<div class="fl-track-tick" style="left:' + tickPct.toFixed(1) + '%"></div>') +
          '</div>' +
          '<div class="fl-track-f"><span>' + units + ' sold</span>' +
            (target
              ? '<span class="' + (m.hit ? 'cleared' : '') + '">target ' + target +
                  (m.hit ? ' · cleared' : ' · ' + Math.max(0, target - units) + ' to go') + '</span>'
              : '<span>no target set</span>') +
          '</div>') +

        '<div class="fl-cells">' +
          cell(units.toLocaleString(), 'you sold', false) +
          cell(target ? target.toLocaleString() : '—', 'your target', false) +
          cell(headline, d.is_current ? 'so far' : 'earned', cleared) +
        '</div>' +

        '<div id="flAlso"></div>' +

        '<p class="fl-foot">Figures come from Dutchie sell-through and settle when the program closes.</p>' +
      '</div>';

    $('#flOut').addEventListener('click', signOut);
    renderAlso(d.others || []);
  }

  function cell(v, k, paid) {
    return '<div class="fl-cell' + (paid ? ' is-paid' : '') + '">' +
      '<div class="fl-cell-v">' + v + '</div><div class="fl-cell-k">' + esc(k) + '</div></div>';
  }

  /* Two initials. Names arrive as "Zach B" or occasionally one word, which must not produce
     an empty circle. */
  function initials(name) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
    return (w[0][0] + w[w.length - 1][0]).toUpperCase();
  }

  function prettyStore(slug) {
    return String(slug || '').split('-').map(function (x) {
      return x.charAt(0).toUpperCase() + x.slice(1);
    }).join(' ');
  }

  /* ALSO RUNNING. A budtender can be earning on more than one SPIFF at once and only ever saw
     the one ending soonest, so a second program's money was invisible to the person earning
     it. Each figure is fetched SEPARATELY and after the main card is painted: one sell-through
     call runs ~9s, and putting three of them in front of the headline number would mean
     staring at nothing on a phone between customers. */
  async function renderAlso(others) {
    var host = document.getElementById('flAlso');
    if (!host || !others.length) return;
    host.innerHTML = '<div class="fl-also-h">Also running</div>' +
      others.map(function (o, i) {
        var per = String(o.payout_type || 'flat').toLowerCase() === 'per_unit';
        return '<div class="fl-also" id="flAlso' + i + '"><div class="fl-also-b">' +
          '<div class="fl-also-n">' + esc(o.name || o.vendor) + '</div>' +
          '<div class="fl-also-s">' + (per
            ? money(o.rate) + ' a unit · every unit pays'
            : money(o.rate) + ' if you hit your target') + '</div></div>' +
          '<div class="fl-also-v" id="flAlsoV' + i + '">…</div></div>';
      }).join('');

    for (var i = 0; i < others.length; i++) {
      /* Sequential, not parallel: these are ~9s server-side each and the engine is one
         Apps Script instance. Firing them together is how a phone page earns a timeout. */
      await fillAlso(others[i], i);
    }
  }

  async function fillAlso(o, i) {
    var el = document.getElementById('flAlsoV' + i);
    if (!el) return;
    try {
      var r = await ENG.jsonp('flyer', { token: (session() || {}).token, id: o.program_id },
                              { timeoutMs: 65000, retries: 1 });
      if (!r || !r.ok || !r.mine) throw new Error('no figure');
      var paid = r.mine.payout > 0;
      el.textContent = money(r.mine.payout);
      el.className = 'fl-also-v' + (paid ? ' is-paid' : '');
    } catch (e) {
      /* A dash, not a zero. "$0" is a claim about what this person has earned; a dash says the
         figure did not arrive, which is the true statement. */
      el.textContent = '—';
      el.title = 'Could not read this one just now';
    }
  }

  function signOut() { clearSession(); renderGate(); }

  /* ------------------------------------------------------------------ boot */
  async function load() {
    $('#main').innerHTML = '<div class="fl-boot">Pulling your numbers&hellip;</div>';
    try {
      /* Sell-through is measured at ~9s per store against Dutchie, so this is the slow call on
         the page and the reason for a real loading state rather than a spinner over an empty
         card. One store — the caller's — so it does not multiply. */
      var r = await ENG.jsonp('flyer', { token: (session() || {}).token },
                              { timeoutMs: 65000, retries: 1 });
      if (r && r.needsAuth) {
        var who = (session() || {}).user;
        clearSession();
        if (r.code === 'no_access') renderNoAccess(who);
        else renderGate(r.error || 'Please sign in again');
        return;
      }
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not load your SPIFF');
      renderFlyer(r);
    } catch (e) {
      $('#main').innerHTML =
        '<div class="fl-card fl-card-msg">' +
          '<h1 class="fl-h1">Couldn\'t load your SPIFF</h1>' +
          '<p class="fl-note">' + esc((e && e.message) || 'Something went wrong.') + '</p>' +
          '<button class="gx-btn" id="flRetry">Try again</button>' +
        '</div>';
      $('#flRetry').addEventListener('click', load);
    }
  }

  function boot() { if (session()) load(); else renderGate(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
