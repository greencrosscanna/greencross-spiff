/* ─── Media post-mortem: Mike's after-program report to the vendor (Mike 2026-11-10, Sky 2026-11-16) ──
 *
 * Mike enters each Instagram post and loyalty blast once (name, wording, images, numbers); this file
 * builds the report from those entries, in the GX Design System look Sky approved
 * (https://claude.ai/artifact/2L3qgHDYkWQGg9TBZLhxGJ), in two versions:
 *   vendor   — Overview · The posts · The loyalty blast          (footer "Partner campaign recap")
 *   internal — the same plus Email & SMS performance and Campaign send review, after the Overview
 *              (footer "Internal campaign review")
 * A page with nothing to show is left out of both.
 *
 * THE PDF IS DRAWN HERE, IN THE BROWSER. Google's HTML-to-PDF converter cannot do landscape pages or
 * this layout, so each 1250 × 917 page is rendered with html2canvas and placed into a landscape PDF
 * with jsPDF (both loaded only when a PDF is made). The images come from the engine as data, which
 * is what lets the canvas be exported at all. The PDF is downloaded and also filed in SPIFF Reports,
 * with a row so past reports stay listed under the program.
 *
 * WHAT IS STORED is only what Mike typed or picked; every total, the "led in views" line and which
 * pages appear are worked out here on every build. normalize / applyOps are twins of the engine's
 * normalizePostmortem_ / applyPostmortemOps_ (tests/postmortem_test.js runs both on the same input).
 *
 * Shown only to the Marketing preview users (marketing.js's switch); the engine's editor check is
 * the lock. Nothing that pays anybody reads any of this.
 */
(function (root) {
  'use strict';

  var KINDS = { ig: 'Instagram post', loyalty: 'Loyalty blast', other: 'Other post' };
  var STATS = ['views', 'viewers', 'interactions', 'likes', 'comments', 'saves', 'shares', 'home', 'profile', 'accounts', 'reach'];
  var NOTES = ['overview', 'posts', 'loyalty', 'standout', 'reconcile', 'sources'];
  var CHAN_FIELDS = ['sent', 'delivered', 'open', 'ctr', 'revenue', 'unsubs', 'roi'];
  var CHAN_LABELS = { sent: 'Sent', delivered: 'Delivered', open: 'Open / view rate', ctr: 'Click-through rate',
                      revenue: 'Direct revenue', unsubs: 'Unsubscribes', roi: 'ROI as displayed' };
  var STAT_LABELS = { views: 'Views', viewers: 'Viewers', interactions: 'Interactions', likes: 'Likes', comments: 'Comments',
                      saves: 'Saves', shares: 'Shares', home: 'From Home', profile: 'From Profile', accounts: 'Accounts engaged',
                      reach: 'Loyalty customers reached' };
  var POST_STATS = ['views', 'viewers', 'interactions', 'likes', 'comments', 'saves', 'shares', 'home', 'profile', 'accounts'];
  var DEFAULT_SOURCES = 'Green Cross loyalty campaign reporting and Instagram Insights.';
  var POSTS_PER_PAGE = 5, ROWS_PER_OVERVIEW = 9, LOYALTY_IMAGES = 4;
  var MAX_ITEMS = 30;
  var PAGE_W = 1250, PAGE_H = 917;
  var LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
              'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'];
  var FONTS = 'https://fonts.googleapis.com/css2?family=Figtree:wght@700;900&family=Work+Sans:wght@400;500;600&display=swap';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── WHAT MAY BE STORED (twin of the engine's normalizePostmortem_) ─────────────────────────── */
  function text(v, n) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, n); }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(String(v).replace(/[,\s]/g, ''));
    return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  }
  function ids(list, max) {
    return (Array.isArray(list) ? list : []).map(function (x) { return String(x || '').trim(); })
      .filter(function (x, i, a) { return /^[A-Za-z0-9_-]{10,80}$/.test(x) && a.indexOf(x) === i; }).slice(0, max);
  }
  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    var items = (Array.isArray(d.items) ? d.items : []).map(function (it) {
      it = it && typeof it === 'object' ? it : {};
      var id = String(it.id || '');
      if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
      var stats = {}, src = it.stats && typeof it.stats === 'object' ? it.stats : {};
      STATS.forEach(function (k) { var n = num(src[k]); if (n !== null) stats[k] = n; });
      return { id: id, kind: KINDS[it.kind] ? it.kind : 'ig', name: text(it.name, 80),
               date: /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')) ? String(it.date) : '',
               words: text(it.words, 1500), images: ids(it.images, 6), stats: stats, ref: text(it.ref, 200),
               email_id: /^\d{1,10}$/.test(String(it.email_id || '')) ? String(it.email_id) : '' };
    }).filter(function (it, i, a) {
      return it && a.map(function (x) { return x && x.id; }).indexOf(it.id) === i;
    }).slice(0, MAX_ITEMS);
    var notes = {}, n = d.notes && typeof d.notes === 'object' ? d.notes : {};
    NOTES.forEach(function (k) { var t = text(n[k], 600); if (t) notes[k] = t; });
    var chans = {}, c = d.channels && typeof d.channels === 'object' ? d.channels : {};
    ['email', 'sms'].forEach(function (ch) {
      var row = {}, s = c[ch] && typeof c[ch] === 'object' ? c[ch] : {};
      CHAN_FIELDS.forEach(function (k) { var t = text(s[k], 24); if (t) row[k] = t; });
      if (Object.keys(row).length) chans[ch] = row;
    });
    var s0 = d.send && typeof d.send === 'object' ? d.send : {}, send = {};
    var title = text(s0.title, 120); if (title) send.title = title;
    var rc = num(s0.record_count); if (rc !== null) send.record_count = rc;
    var au = num(s0.audience); if (au !== null) send.audience = au;
    var si = ids(s0.images, 2); if (si.length) send.images = si;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(s0.date || ''))) send.date = String(s0.date);
    var sd = days(s0.days); if (sd.length) send.days = sd;
    return { v: 1, items: items, notes: notes, channels: chans, send: send };
  }
  /* Twin of the engine's pmDays_. */
  function days(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(function (x) {
      var d = Math.floor(Number(x && x.d)), o = num(x && x.o);
      return d >= 0 && d < 14 && o !== null ? { d: d, o: o } : null;
    }).filter(function (x) { if (!x || seen[x.d]) return false; seen[x.d] = true; return true; })
      .sort(function (a, b) { return a.d - b.d; });
  }

  /* Twin of the engine's applyPostmortemOps_. */
  function applyOps(data, ops) {
    var d = JSON.parse(JSON.stringify(normalize(data)));
    (Array.isArray(ops) ? ops : []).forEach(function (op) {
      if (!Array.isArray(op)) return;
      var at = d.items.map(function (x) { return x.id; }).indexOf(String(op[1]));
      if (op[0] === 'item') {
        if (op[2] === null) { if (at >= 0) d.items.splice(at, 1); return; }
        var it = Object.assign({}, op[2] || {}, { id: String(op[1]) });
        if (at >= 0) d.items[at] = it; else d.items.push(it);
      } else if (op[0] === 'move' && at >= 0) {
        var to = at + (Number(op[2]) < 0 ? -1 : 1);
        if (to >= 0 && to < d.items.length) { var x = d.items.splice(at, 1)[0]; d.items.splice(to, 0, x); }
      } else if (op[0] === 'note' && NOTES.indexOf(op[1]) >= 0) {
        d.notes[op[1]] = op[2];
      } else if (op[0] === 'chan' && (op[1] === 'email' || op[1] === 'sms')) {
        d.channels[op[1]] = op[2];
      } else if (op[0] === 'send') {
        d.send = op[1];
      }
    });
    return normalize(d);
  }

  /* ── THE NUMBERS ─────────────────────────────────────────────────────────────────────────── */
  /* 5750 → "5.75K", 1100 → "1.1K", 592 → "592", 1250000 → "1.25M". */
  function fmtK(n) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    var a = Math.abs(n);
    var cut = function (x) { return String(Math.round(x * 100) / 100).replace(/\.0+$/, ''); };
    if (a >= 1e6) return cut(n / 1e6) + 'M';
    if (a >= 1e3) return cut(n / 1e3) + 'K';
    return String(Math.round(n * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  var WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  function countWord(n) { return WORDS[n] || String(n); }
  /* n may arrive already formatted ("1", "5.75K"), so "one" is decided on its value, not its type. */
  function plural(n, one, many) { return n + ' ' + (String(n) === '1' ? one : (many || one + 's')); }

  function has(it, k) { return it.stats && typeof it.stats[k] === 'number'; }
  function sum(list, k) { return list.reduce(function (s, it) { return s + (has(it, k) ? it.stats[k] : 0); }, 0); }
  function anyHas(list, k) { return list.some(function (it) { return has(it, k); }); }

  function summary(data) {
    var d = normalize(data);
    var posts = d.items.filter(function (it) { return it.kind !== 'loyalty'; });
    var ig = d.items.filter(function (it) { return it.kind === 'ig'; });
    var loyalty = d.items.filter(function (it) { return it.kind === 'loyalty'; });
    var lead = function (k) {
      var best = null;
      posts.forEach(function (it) { if (has(it, k) && (!best || it.stats[k] > best.stats[k])) best = it; });
      return best && best.stats[k] > 0 ? { name: best.name || 'Untitled', value: best.stats[k], id: best.id } : null;
    };
    return {
      posts: posts, ig: ig, loyalty: loyalty,
      reach: anyHas(loyalty, 'reach') ? sum(loyalty, 'reach') : null,
      igViews: anyHas(ig, 'views') ? sum(ig, 'views') : null,
      igInteractions: anyHas(ig, 'interactions') ? sum(ig, 'interactions') : null,
      igLikes: anyHas(ig, 'likes') ? sum(ig, 'likes') : null,
      igComments: anyHas(ig, 'comments') ? sum(ig, 'comments') : null,
      leadViews: posts.length > 1 ? lead('views') : null,
      leadInteractions: posts.length > 1 ? lead('interactions') : null,
      /* Only when every post HAS both numbers and they are all zero: a blank is not a zero. */
      noSavesShares: posts.length > 0 && posts.every(function (it) {
        return has(it, 'saves') && has(it, 'shares') && it.stats.saves === 0 && it.stats.shares === 0;
      })
    };
  }

  function leadLine(s) {
    var v = s.leadViews, i = s.leadInteractions;
    if (v && i && v.id === i.id) return v.name + ' led in views (' + fmtK(v.value) + ') and interactions (' + fmtK(i.value) + ').';
    var out = [];
    if (v) out.push(v.name + ' led in views (' + fmtK(v.value) + ').');
    if (i) out.push(i.name + ' led in interactions (' + fmtK(i.value) + ').');
    return out.join(' ');
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /* "October 26 to November 8, 2026"; the year twice only when the window crosses one. */
  function dateRange(start, end) {
    var a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(start || '')), b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(end || ''));
    var day = function (m, withYear) { return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + (withYear ? ', ' + m[1] : ''); };
    if (a && b) return day(a, a[1] !== b[1]) + ' to ' + day(b, true);
    if (a) return day(a, true);
    if (b) return day(b, true);
    return '';
  }

  function chunk(list, n) { var out = []; for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
  function paras(t) { return String(t || '').split(/\n+/).filter(Boolean); }

  /* ── THE REPORT ───────────────────────────────────────────────────────────────────────────────
     prog: { vendor, program_name, start_date, end_date }. images: { driveId: dataUri } (a missing
     image draws as a plain black box, so a report still builds while one is unreadable). */
  function pagesOf(data, prog, version) {
    var d = normalize(data), s = summary(d), internal = version === 'internal';
    var pages = [];
    if (d.items.length) {
      chunk(d.items, ROWS_PER_OVERVIEW).forEach(function (rows, i) { pages.push({ kind: 'overview', rows: rows, first: i === 0 }); });
    }
    if (internal && Object.keys(d.channels).length) pages.push({ kind: 'channels' });
    if (internal && Object.keys(d.send).length) pages.push({ kind: 'send' });
    chunk(s.posts, POSTS_PER_PAGE).forEach(function (list, i) { pages.push({ kind: 'posts', list: list, first: i === 0 }); });
    /* A blast page shows its creative; with no images (and no summary on the first) it would be one
       number on an empty page, and that number is already on the Overview. */
    s.loyalty.forEach(function (it, i) {
      if (it.images.length || (i === 0 && d.notes.loyalty)) pages.push({ kind: 'loyalty', item: it, first: i === 0 });
    });
    return pages;
  }

  function reportHtml(data, prog, version, images, opts) {
    var d = normalize(data), s = summary(d), internal = version === 'internal';
    var o = opts || {}, imgs = images || {};
    prog = prog || {};
    var pages = pagesOf(d, prog, version);
    if (!pages.length) return '';
    var vendor = String(prog.vendor || prog.program_name || 'Vendor');
    var range = dateRange(prog.start_date, prog.end_date);
    var foot = internal ? 'Internal campaign review' : 'Partner campaign recap';
    var total = pages.length;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    var img = function (id, alt) {
      var src = id && imgs[id];
      return src ? '<img src="' + esc(src) + '" alt="' + esc(alt || '') + '">' : '<i></i>';
    };
    var counters = { posts: 0 };

    var head = function (n, section, title, sub) {
      return '<div class="pmr-hd"><div>'
        + (o.logo ? '<img class="pmr-logo" src="' + esc(o.logo) + '" alt="Green Cross">' : '')
        + '<div class="pmr-eye">Green Cross × ' + esc(vendor) + '</div>'
        + '<h2>' + esc(title) + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>'
        + '<div class="pmr-folio">' + two(n) + '<small>' + esc(section) + '</small></div></div>';
    };
    var footer = function (n) {
      return '<div class="pmr-ft"><span>Green Cross Cannabis Emporium / ' + foot + '</span><span>' + two(n) + ' / ' + two(total) + '</span></div>';
    };
    var tile = function (big, label, small) {
      return '<div class="pmr-tile"><b>' + esc(big) + '</b><span>' + esc(label) + '</span>' + (small ? '<small>' + esc(small) + '</small>' : '') + '</div>';
    };
    var rowOf = function (it) {
      var reach = it.kind === 'loyalty';
      var mid = reach ? (has(it, 'reach') ? fmtK(it.stats.reach) + ' customers reached' : 'Not recorded')
                      : (has(it, 'views') ? plural(fmtK(it.stats.views), 'view') : 'Not recorded');
      var inter = has(it, 'interactions') ? fmtK(it.stats.interactions) : 'Unavailable';
      return '<tr><td>' + esc(KINDS[it.kind]) + '</td><td>' + esc(it.name || 'Untitled') + '</td><td>' + esc(mid) + '</td><td>' + esc(inter) + '</td></tr>';
    };

    var body = pages.map(function (pg, i) {
      var n = i + 1, h = '';
      if (pg.kind === 'overview') {
        h += head(n, 'Overview', pg.first ? 'SPIFF Media Postmortem.' : 'Performance, continued.', range);
        h += '<div class="pmr-bd">';
        if (pg.first) {
          var tiles = [];
          if (s.reach !== null) tiles.push(tile(fmtK(s.reach), 'Loyalty customers reached', s.loyalty.length > 1 ? 'Across ' + plural(s.loyalty.length, 'blast') : 'Loyalty blast'));
          if (s.igViews !== null) tiles.push(tile(fmtK(s.igViews), 'Instagram views', 'Across ' + plural(s.ig.length, 'post')));
          if (s.igInteractions !== null) {
            var bits = [];
            if (s.igLikes !== null) bits.push(plural(fmtK(s.igLikes), 'like'));
            if (s.igComments !== null) bits.push(plural(fmtK(s.igComments), 'comment'));
            tiles.push(tile(fmtK(s.igInteractions), 'Instagram interactions', bits.join(' and ')));
          }
          if (tiles.length) h += '<div class="pmr-tiles n' + tiles.length + '">' + tiles.join('') + '</div>';
        }
        h += '<div class="pmr-h3">Performance by blast and post</div>'
          + '<table><thead><tr><th>Media type</th><th>Creative</th><th>Views / loyalty reach</th><th>Interactions</th></tr></thead><tbody>'
          + pg.rows.map(rowOf).join('') + '</tbody></table>';
        if (pg.first) {
          var ll = leadLine(s);
          if (ll) h += '<p class="pmr-lead">' + esc(ll) + '</p>';
          paras(d.notes.overview).forEach(function (t) { h += '<p class="pmr-note">' + esc(t) + '</p>'; });
          h += '<p class="pmr-note">Sources / ' + esc(d.notes.sources || DEFAULT_SOURCES) + '</p>';
        }
        h += '</div>';
      } else if (pg.kind === 'channels') {
        /* Numbers pulled from a Dutchie blast are that blast's own; typed ones are dashboard totals. */
        var pulled = d.items.some(function (it) { return it.kind === 'loyalty' && /^Dutchie: /.test(it.ref); });
        h += head(n, 'Dutchie', 'Email & SMS performance.',
          pulled ? 'Dutchie campaign results' + (d.send.title ? ' / ' + d.send.title : '')
                 : 'Dutchie channel dashboards' + (range ? ' / ' + range : ''));
        var em = d.channels.email || {}, sm = d.channels.sms || {};
        var shown = CHAN_FIELDS.filter(function (k) { return em[k] || sm[k]; });
        h += '<div class="pmr-bd"><table class="pmr-chan"><thead><tr><th>' + (pulled ? 'Campaign metric' : 'Dashboard metric') + '</th><th>Email</th><th>SMS</th></tr></thead><tbody>'
          + shown.map(function (k) {
            return '<tr><td>' + esc(CHAN_LABELS[k]) + '</td><td>' + esc(em[k] || 'Not shown') + '</td><td>' + esc(sm[k] || 'Not shown') + '</td></tr>';
          }).join('') + '</tbody></table>';
        if (d.notes.standout) {
          h += '<div class="pmr-h3">What stood out</div>';
          paras(d.notes.standout).forEach(function (t) { h += '<p class="pmr-body">' + esc(t) + '</p>'; });
        }
        h += pulled
          ? '<p class="pmr-note">Scope / This blast\'s own numbers from Dutchie. Delivered is a share of what was sent; open and click rates are shares of what was delivered.</p>'
          : '<p class="pmr-note">Scope / These are dashboard totals for the date window. Campaign-only engagement and revenue require a campaign export.</p>';
        if (em.roi || sm.roi) h += '<p class="pmr-note">ROI / Dutchie displays dollar values. Verify its calculation before comparing ROI or using it as revenue.</p>';
        h += '</div>';
      } else if (pg.kind === 'send') {
        var sd = d.send;
        h += head(n, 'Send review', 'Campaign send review.', sd.title || '');
        h += '<div class="pmr-bd">';
        var st = [];
        if (typeof sd.record_count === 'number') st.push(tile(fmtK(sd.record_count), 'Campaign record count', ''));
        if (typeof sd.audience === 'number') st.push(tile(fmtK(sd.audience), 'Listed audience', ''));
        if (typeof sd.record_count === 'number' && typeof sd.audience === 'number') {
          st.push(tile(fmtK(Math.abs(sd.audience - sd.record_count)), 'Gap in displayed counts', ''));
        }
        if (st.length) h += '<div class="pmr-tiles n' + st.length + '">' + st.join('') + '</div>';
        if (d.notes.reconcile) {
          h += '<div class="pmr-h3">Send reconciliation</div>';
          paras(d.notes.reconcile).forEach(function (t) { h += '<p class="pmr-body">' + esc(t) + '</p>'; });
        }
        /* Pulled from Dutchie: the day-by-day chart takes the screenshots' place (it is the same
           blast's own numbers, where a dashboard screenshot is the whole date window). */
        if ((sd.days || []).length) {
          h += chartHtml(sd);
        } else if ((sd.images || []).length) {
          h += '<div class="pmr-shots">' + sd.images.map(function (id) {
            return '<figure><figcaption>Dashboard screenshot</figcaption>' + img(id, 'Dashboard screenshot') + '</figure>';
          }).join('') + '</div>';
        }
        h += '</div>';
      } else if (pg.kind === 'posts') {
        var allIg = s.posts.every(function (it) { return it.kind === 'ig'; });
        var t = allIg ? 'The Instagram posts' : 'The posts';
        h += head(n, allIg ? 'Instagram' : 'Posts', t + (pg.first ? '.' : ', continued.'),
          pg.first ? countWord(s.posts.length) + ' published creative' + (s.posts.length === 1 ? '' : 's') + ' and ' + (s.posts.length === 1 ? 'its' : 'their') + ' individual results' : '');
        h += '<div class="pmr-bd"><div class="pmr-posts">' + pg.list.map(function (it) {
          counters.posts++;
          var big = ['views', 'viewers', 'interactions'].filter(function (k) { return has(it, k); }).map(function (k) {
            return '<b>' + esc(fmtK(it.stats[k])) + '</b><span>' + k + '</span>';
          }).join('');
          var lines = [];
          var lc = [];
          if (has(it, 'likes')) lc.push(plural(fmtK(it.stats.likes), 'like'));
          if (has(it, 'comments')) lc.push(plural(fmtK(it.stats.comments), 'comment'));
          if (lc.length) lines.push(lc.join(' · '));
          var hp = [];
          if (has(it, 'home')) hp.push(fmtK(it.stats.home) + ' Home');
          if (has(it, 'profile')) hp.push(fmtK(it.stats.profile) + ' Profile');
          if (hp.length) lines.push(hp.join(' · '));
          if (has(it, 'accounts')) lines.push(plural(fmtK(it.stats.accounts), 'account') + ' engaged');
          return '<div class="pmr-post"><div class="pmr-img">' + img(it.images[0], it.name) + '</div><div class="pmr-pb">'
            + '<h4>' + esc(it.name || 'Untitled') + '</h4>' + (big ? '<div class="pmr-st">' + big + '</div>' : '')
            + (lines.length ? '<p>' + lines.map(esc).join('<br>') + '</p>' : '') + '</div></div>';
        }).join('') + '</div>';
        var last = counters.posts >= s.posts.length;
        if (last && d.notes.posts) paras(d.notes.posts).forEach(function (x) { h += '<p class="pmr-note">' + esc(x) + '</p>'; });
        else if (last && s.noSavesShares) h += '<p class="pmr-note">No saves or shares were recorded across the ' + (s.posts.length === 1 ? 'post' : countWord(s.posts.length).toLowerCase() + ' posts') + '.</p>';
        h += '</div>';
      } else if (pg.kind === 'loyalty') {
        var it = pg.item;
        h += head(n, 'Loyalty', s.loyalty.length > 1 ? (it.name || 'The loyalty blast') + '.' : 'The loyalty blast.',
          it.images.length > 1 ? 'Original campaign creative, shown in reading order from left to right' : 'Original campaign creative');
        h += '<div class="pmr-bd">';
        if (has(it, 'reach')) h += '<div class="pmr-big"><b>' + esc(fmtK(it.stats.reach)) + '</b><span>loyalty customers reached</span></div>';
        if (pg.first && d.notes.loyalty) paras(d.notes.loyalty).forEach(function (x) { h += '<p class="pmr-note">' + esc(x) + '</p>'; });
        var shown = it.images.slice(0, LOYALTY_IMAGES);
        if (shown.length) {
          h += '<div class="pmr-blast n' + shown.length + '">' + shown.map(function (id, k) {
            return '<figure><div>' + img(id, 'Blast image ' + (k + 1)) + '</div><figcaption>' + two(k + 1) + '</figcaption></figure>';
          }).join('') + '</div>';
        }
        h += '</div>';
      }
      return '<article class="pmr-page">' + h + footer(n) + '</article>';
    }).join('');
    return '<div class="pmr">' + body + '</div>';
  }

  /* ── THE ORDERS CHART (send review) ──────────────────────────────────────────────────────────
     One series, so no legend: the title names it. Green bars on the report's black panel, square
     except a small rounded top, one recessive axis with three ticks, only the tallest bar labeled.
     Plain HTML, not SVG, because html2canvas draws boxes faithfully. */
  function niceMax(m) {
    if (!(m > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(m))), steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= m) return steps[i] * p;
    return 10 * p;
  }
  function weekLine(list) {
    var at = {}; list.forEach(function (x) { at[x.d] = x.o; });
    var avg = function (lo) {
      var s = 0;
      for (var d = lo; d < lo + 7; d++) { if (!(d in at)) return null; s += at[d]; }
      return Math.round(s / 7 * 10) / 10;
    };
    var a = avg(0), b = avg(7);
    if (a === null) return '';
    if (b === null) return 'Week 1 averaged ' + fmtK(a) + ' orders a day. Week 2 is not over yet.';
    var line = 'Week 1 averaged ' + fmtK(a) + ' orders a day; week 2 averaged ' + fmtK(b) + '.';
    if (b > 0 && Math.abs(a - b) / b < 0.1) return line + ' About the same both weeks, so most of these orders are members\' regular buying.';
    if (b > 0 && a > b) return line + ' Week 1 ran ' + Math.round((a - b) / b * 100) + '% above week 2.';
    return line;
  }
  function chartHtml(send) {
    var list = days(send.days);
    if (!list.length) return '';
    var top = niceMax(Math.max.apply(null, list.map(function (x) { return x.o; })));
    var best = list.reduce(function (m, x) { return x.o > m.o ? x : m; }, list[0]);
    var label = function (d) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(send.date || ''));
      if (!m) return 'Day ' + d;
      var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + d));
      return (t.getUTCMonth() + 1) + '/' + t.getUTCDate();
    };
    var bars = list.map(function (x) {
      var pct = Math.max(0, Math.min(100, x.o / top * 100));
      return '<div class="pmr-col"><div class="pmr-barbox">'
        + (x === best ? '<span class="pmr-val" style="bottom:' + pct + '%">' + esc(fmtK(x.o)) + '</span>' : '')
        + '<div class="pmr-bar" style="height:' + pct + '%"></div></div><span class="pmr-day">' + esc(label(x.d)) + '</span></div>';
    }).join('');
    var ticks = [top, top / 2, 0].map(function (v) { return '<span>' + esc(fmtK(v)) + '</span>'; }).join('');
    var wl = weekLine(list);
    return '<div class="pmr-chart"><div class="pmr-chart-h">Orders by blast recipients, day by day</div>'
      + '<div class="pmr-chart-s">The first bar is the send day. Any purchase by a recipient counts, as Dutchie counts it, so this is not lift.</div>'
      + '<div class="pmr-plot"><div class="pmr-ticks">' + ticks + '</div><div class="pmr-bars">' + bars + '</div></div>'
      + (wl ? '<div class="pmr-chart-s pmr-weeks">' + esc(wl) + '</div>' : '') + '</div>';
  }

  /* Every image id the report will draw, so the engine is asked for those and no others. */
  function imageIds(data, version) {
    var d = normalize(data), out = [];
    d.items.forEach(function (it) {
      if (it.kind === 'loyalty') out = out.concat(it.images.slice(0, LOYALTY_IMAGES));
      else if (it.images[0]) out.push(it.images[0]);
    });
    if (version === 'internal') out = out.concat(d.send.images || []);
    return out.filter(function (x, i, a) { return a.indexOf(x) === i; });
  }

  /* ── PULLING A BLAST FROM DUTCHIE ─────────────────────────────────────────────────────────────
     `blast` is one row of the engine's postmortemBlasts (the connector's capture, summed). Picking it
     fills the loyalty entry's reach, and the internal pages' Email & SMS table and send counts from the
     same blast. Images, the summary note and anything Mike typed in the notes are left as they are;
     the two notes are written only while they are blank. */
  function pct(a, b) {
    if (!b || a === null || a === undefined) return '';
    return String(Math.round(a / b * 1000) / 10).replace(/\.0$/, '') + '%';
  }
  function money(v) { return '$' + Number(v || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function blastOps(data, itemId, blast) {
    var d = normalize(data), b = blast || {};
    var it = d.items.filter(function (x) { return x.id === itemId; })[0];
    if (!it) return [];
    var next = JSON.parse(JSON.stringify(it));
    next.kind = 'loyalty';
    if (!next.name) next.name = String(b.name || '').slice(0, 80);
    if (b.send_date) next.date = b.send_date;
    if (typeof b.sent_total === 'number') next.stats.reach = b.sent_total;
    next.ref = ('Dutchie: ' + (b.name || '') + (b.send_date ? ' (' + b.send_date + ')' : '')).slice(0, 200);
    /* The blast's own email, drawn as the creative while Mike has picked no images (connector 1.9.0). */
    next.email_id = b.has_email && /^\d{1,10}$/.test(String(b.id || '')) ? String(b.id) : '';
    var ops = [['item', itemId, next]];
    var e = b.email, s = b.sms, n = function (v) { return typeof v === 'number' ? fmtK(v) : ''; };
    if (e) ops.push(['chan', 'email', { sent: n(e.sent), delivered: pct(e.delivered, e.sent), open: pct(e.opens, e.delivered),
                                        ctr: pct(e.clicks, e.delivered), unsubs: n(e.unsubscribes) }]);
    if (s) ops.push(['chan', 'sms', { sent: n(s.sent), delivered: pct(s.delivered, s.sent), ctr: pct(s.clicks, s.delivered),
                                      unsubs: n(s.unsubscribes) }]);
    var send = Object.assign({}, d.send, { title: String(b.name || '').slice(0, 120), date: b.send_date || '', days: b.daily || [] });
    if (typeof b.sent_total === 'number') send.record_count = b.sent_total;
    if (typeof b.listed_audience === 'number') send.audience = b.listed_audience;
    ops.push(['send', send]);
    if (!d.notes.reconcile && b.not_sent > 0 && typeof b.sent_total === 'number' && typeof b.listed_audience === 'number') {
      ops.push(['note', 'reconcile', 'Dutchie sent ' + fmtK(b.sent_total) + ' of the ' + fmtK(b.listed_audience) + ' listed (' + fmtK(b.not_sent) + ' not sent).']);
    }
    var a = b.attributed;
    if (!d.notes.standout && a && a.orders > 0) {
      ops.push(['note', 'standout', 'Recipients placed ' + fmtK(a.orders) + ' orders (' + money(a.revenue) + ') in the ' + a.days
        + ' days after the send, as Dutchie counts it. That is any purchase by a recipient, not lift.'
        + (a.complete ? '' : ' The ' + a.days + ' days are not over yet.')]);
    }
    return ops;
  }

  function blastListHtml(r, itemId) {
    if (!r) return '<p class="mk-sub" role="status">Reading the Dutchie blast results&hellip;</p>';
    if (!r.ok) return '<div class="mk-warn">' + esc(r.error || 'Could not read the Dutchie blast results.') + '</div>';
    var row = function (b, i, group) {
      var line = [b.send_date];
      if (typeof b.sent_total === 'number') line.push(fmtK(b.sent_total) + ' sent' + (typeof b.listed_audience === 'number' ? ' of ' + fmtK(b.listed_audience) : ''));
      if (b.has_email) line.push('email saved');
      return '<li><button type="button" class="gx-btn" data-pm-useblast="' + esc(itemId + '|' + group + '|' + i) + '">Use this</button> '
        + '<b>' + esc(b.name || 'Unnamed blast') + '</b> <span class="mk-sub">' + esc(line.join(' · ')) + '</span></li>';
    };
    var when = r.captured_at ? 'Dutchie numbers captured ' + String(r.captured_at).slice(0, 16).replace('T', ' ') + ' UTC.' : '';
    var h = (r.stale ? '<div class="mk-warn">These Dutchie numbers are more than two days old: the nightly capture may have stopped. ' + esc(when) + '</div>'
                     : '<p class="mk-sub">' + esc(when) + '</p>');
    if (r.blasts.length) h += '<ul class="pm-blasts">' + r.blasts.map(function (b, i) { return row(b, i, 'blasts'); }).join('') + '</ul>';
    else h += '<p class="mk-sub">No blast named for this vendor was sent between ' + esc(r.window.from) + ' and ' + esc(r.window.to) + '.</p>';
    if (r.others.length) {
      h += '<details><summary class="mk-sub">Other blasts sent in that time (' + r.others.length + ')</summary><ul class="pm-blasts">'
        + r.others.map(function (b, i) { return row(b, i, 'others'); }).join('') + '</ul></details>';
    }
    return h + '<p class="mk-sub">Using one fills this blast\'s reach and the internal Email &amp; SMS and send-review numbers. Pick the blast images yourself.</p>';
  }

  function fileName(prog, version, now) {
    var t = now || new Date();
    var mm = ('0' + (t.getMonth() + 1)).slice(-2), dd = ('0' + t.getDate()).slice(-2), yy = String(t.getFullYear()).slice(2);
    return 'Green Cross SPIFF Media Postmortem' + (version === 'internal' ? ' (Internal)' : '') + ' - '
      + String((prog && (prog.vendor || prog.program_name)) || 'Brand').replace(/[\\/]/g, '-') + ' - ' + mm + dd + yy + '.pdf';
  }

  /* The report's look: the GX Design System (black, cement, one green, square, Gotham-style caps).
     Sized in em of a 1250-px page so the PDF and the preview are the same layout. */
  var REPORT_CSS = [
    '.pmr{--g:#94d600;--k:#090d11;--c:#e8e8e8;--w:#fff;--at:#3f6a12;--mu:#4a5056;--disp:"Gotham","Figtree","Work Sans",Arial,sans-serif;--txt:"Work Sans",Arial,sans-serif;display:grid;gap:24px;font-family:var(--txt);font-weight:500;color:var(--k)}',
    '.pmr-page{width:' + PAGE_W + 'px;height:' + PAGE_H + 'px;font-size:12.5px;background:var(--c);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}',
    '.pmr-page *{box-sizing:border-box}',
    '.pmr-hd{background:var(--k);color:var(--w);padding:1.8em 4.4em;display:grid;grid-template-columns:1fr auto;gap:0 2em;align-items:start}',
    '.pmr-logo{height:3em;display:block;margin-bottom:1.2em}',
    '.pmr-eye{font-family:var(--disp);font-weight:900;text-transform:uppercase;color:var(--g);font-size:1.25em;letter-spacing:.06em}',
    '.pmr-hd h2{font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:4em;line-height:.93;margin:.2em 0 .25em}',
    '.pmr-hd p{margin:0;font-size:1.35em;color:#c9cdd1;font-weight:400}',
    '.pmr-folio{font-family:var(--disp);font-weight:900;color:var(--g);font-size:1.6em;text-align:right;line-height:1}',
    '.pmr-folio small{display:block;font-size:.55em;letter-spacing:.08em;color:var(--w);margin-top:.5em;text-transform:uppercase}',
    '.pmr-bd{padding:1.6em 4.4em 0;flex:1;display:flex;flex-direction:column;gap:1em;min-height:0}',
    '.pmr-ft{padding:.9em 4.4em 1.5em;display:flex;justify-content:space-between;font-size:.95em;font-weight:400}',
    '.pmr-ft span{border-top:.75px solid var(--k);padding-top:.6em}',
    '.pmr-ft span:first-child{flex:1;margin-right:2em}',
    '.pmr-ft span:last-child{font-family:var(--disp);font-weight:900}',
    '.pmr-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:1.6em}',
    '.pmr-tiles.n1{grid-template-columns:1fr 2fr}.pmr-tiles.n2{grid-template-columns:repeat(2,1fr)}',
    '.pmr-tile{background:var(--k);color:var(--w);padding:1.1em 1.6em 1.2em}',
    '.pmr-tile b{display:block;font-family:var(--disp);font-weight:900;font-size:3.4em;line-height:1;color:var(--g)}',
    '.pmr-tile span{display:block;font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:1.1em;letter-spacing:.04em;margin-top:.6em}',
    '.pmr-tile small{display:block;color:#c9cdd1;font-size:1em;margin-top:.3em;font-weight:400}',
    '.pmr-h3{display:flex;align-items:center;gap:.7em;font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:1.8em;margin:.2em 0 0}',
    '.pmr-h3:before{content:"";width:1.1em;height:.14em;background:var(--k)}',
    '.pmr table{width:100%;border-collapse:collapse;font-size:1.35em;background:var(--w)}',
    '.pmr th{background:var(--k);color:var(--w);font-family:var(--disp);font-weight:900;text-transform:uppercase;text-align:left;font-size:.7em;letter-spacing:.06em;padding:.8em 1.2em}',
    '.pmr td{padding:.5em 1.2em;border-bottom:.75px solid var(--k);font-variant-numeric:tabular-nums}',
    '.pmr table.pmr-chan{font-size:1.5em}.pmr table.pmr-chan td{padding:.6em 1.2em}',
    '.pmr-lead{font-size:1.45em;font-weight:600;margin:0}',
    '.pmr-body{font-size:1.35em;margin:0;line-height:1.4}',
    '.pmr-note{font-size:1.2em;color:var(--mu);margin:0;font-weight:400}',
    '.pmr-posts{display:grid;grid-template-columns:repeat(5,1fr);gap:1.6em}',
    '.pmr-post{background:var(--w)}',
    '.pmr-img{aspect-ratio:1/1;background:var(--k);display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.pmr-img img{max-width:100%;max-height:100%;display:block}',
    '.pmr i{display:block;width:100%;height:100%;background:var(--k)}',
    '.pmr-pb{padding:1.1em 1.1em 1.2em;font-size:1.2em}',
    '.pmr-pb h4{font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:1.1em;line-height:1.05;margin:0 0 .8em;min-height:2.2em}',
    '.pmr-st{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:.15em .6em}',
    '.pmr-st b{font-family:var(--disp);font-weight:900;font-size:2em;line-height:1.05}',
    '.pmr-st span{color:var(--mu);font-weight:400}',
    '.pmr-pb p{margin:.8em 0 0;padding-top:.7em;border-top:.75px solid var(--k);font-size:.95em;color:var(--mu);line-height:1.65;font-weight:400}',
    '.pmr-big{display:flex;align-items:baseline;gap:.6em}',
    '.pmr-big b{font-family:var(--disp);font-weight:900;font-size:4.6em;line-height:1}',
    '.pmr-big span{font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:1.5em;color:var(--at)}',
    '.pmr-blast{display:grid;grid-template-columns:repeat(4,1fr);gap:1.6em;flex:1;min-height:0}',
    '.pmr-blast.n1{grid-template-columns:1fr}.pmr-blast.n2{grid-template-columns:repeat(2,1fr)}.pmr-blast.n3{grid-template-columns:repeat(3,1fr)}',
    '.pmr-blast figure{margin:0;display:flex;flex-direction:column;min-height:0}',
    '.pmr-blast figure>div{flex:1;min-height:0;background:var(--w);display:flex;align-items:center;justify-content:center;overflow:hidden;padding:.6em}',
    '.pmr-blast img{max-width:100%;max-height:100%;display:block}',
    '.pmr-blast figcaption,.pmr-shots figcaption{font-size:1em;color:var(--mu);margin-top:.5em;font-weight:400;text-transform:uppercase;letter-spacing:.06em}',
    '.pmr-shots{display:grid;grid-template-columns:1fr 1fr;gap:1.6em;flex:1;min-height:0}',
    '.pmr-shots figure{margin:0;display:flex;flex-direction:column-reverse;justify-content:flex-end;min-height:0}',
    '.pmr-shots img{max-width:100%;max-height:22em;display:block;background:var(--w)}',
    '.pmr-shots i{height:18em}',
    '.pmr-chart{background:var(--k);color:var(--w);padding:1.3em 1.6em 1.2em;flex:1;min-height:0;display:flex;flex-direction:column}',
    '.pmr-chart-h{font-family:var(--disp);font-weight:900;text-transform:uppercase;font-size:1.25em;letter-spacing:.04em}',
    '.pmr-chart-s{color:#c9cdd1;font-size:1.05em;font-weight:400;margin-top:.3em}',
    '.pmr-weeks{color:var(--w);font-weight:500;font-size:1.15em;margin-top:.7em}',
    '.pmr-plot{flex:1;min-height:12em;display:flex;gap:.8em;margin-top:1em}',
    '.pmr-ticks{display:flex;flex-direction:column;justify-content:space-between;color:#8b9196;font-size:.95em;text-align:right;padding-bottom:1.6em;font-variant-numeric:tabular-nums}',
    '.pmr-bars{flex:1;display:flex;gap:2px;align-items:stretch;border-bottom:.75px solid #4a5056}',
    '.pmr-col{flex:1;display:flex;flex-direction:column;min-width:0}',
    '.pmr-barbox{flex:1;position:relative;display:flex;align-items:flex-end;justify-content:center}',
    '.pmr-bar{width:72%;background:var(--g);border-radius:4px 4px 0 0}',
    '.pmr-val{position:absolute;left:0;right:0;text-align:center;font-family:var(--disp);font-weight:900;font-size:1.05em;margin-bottom:.3em;transform:translateY(-.2em)}',
    '.pmr-day{text-align:center;color:#8b9196;font-size:.9em;padding-top:.5em;height:1.6em}'
  ].join('\n');

  /* ── THE PDF ─────────────────────────────────────────────────────────────────────────────── */
  var libsP = null;
  function loadScript(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = ok; s.onerror = function () { no(new Error('Could not load ' + src.split('/').slice(-1)[0])); };
      document.head.appendChild(s);
    });
  }
  function ensureFonts() {
    if (document.getElementById('pmrFonts')) return;
    var l = document.createElement('link');
    l.id = 'pmrFonts'; l.rel = 'stylesheet'; l.href = FONTS;
    document.head.appendChild(l);
  }
  function ensureCss() {
    if (document.getElementById('pmrCss')) return;
    var st = document.createElement('style');
    st.id = 'pmrCss'; st.textContent = REPORT_CSS;
    document.head.appendChild(st);
  }
  function loadLibs() {
    if (!libsP) {
      libsP = LIBS.reduce(function (p, src) { return p.then(function () { return loadScript(src); }); }, Promise.resolve())
        .catch(function (e) { libsP = null; throw e; });
    }
    return libsP;
  }

  /* html → a landscape PDF Blob, one page per .pmr-page. */
  async function htmlToPdf(html) {
    ensureFonts(); ensureCss();
    await loadLibs();
    var stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + PAGE_W + 'px;pointer-events:none';
    stage.innerHTML = html;
    document.body.appendChild(stage);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var imgs = Array.prototype.slice.call(stage.querySelectorAll('img'));
      await Promise.all(imgs.map(function (im) {
        return im.complete ? null : new Promise(function (ok) { im.onload = im.onerror = ok; });
      }));
      var JsPDF = root.jspdf && root.jspdf.jsPDF;
      if (!JsPDF || !root.html2canvas) throw new Error('The PDF tools did not load');
      var pdf = new JsPDF({ orientation: 'landscape', unit: 'px', format: [PAGE_W, PAGE_H], hotfixes: ['px_scaling'], compress: true });
      var pages = stage.querySelectorAll('.pmr-page');
      for (var i = 0; i < pages.length; i++) {
        var canvas = await root.html2canvas(pages[i], { scale: 2, backgroundColor: '#e8e8e8', logging: false, useCORS: true });
        if (i) pdf.addPage([PAGE_W, PAGE_H], 'landscape');
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, PAGE_W, PAGE_H);
      }
      return pdf.output('blob');
    } finally {
      stage.remove();
    }
  }

  /* ── THE BLAST'S OWN EMAIL, AS PANELS ─────────────────────────────────────────────────────────
     A loyalty entry pulled from Dutchie carries email_id; while Mike has picked no images, the report
     shows that email cut into up to four panels in reading order, as he laid it out by hand. The
     panels are drawn on demand and never stored: what is stored is only which blast. */
  var PANEL_PREFIX = 'emailpanel-';
  function panelKey(emailId, k) { return PANEL_PREFIX + emailId + '-' + k; }
  /* A copy of the data for drawing, with the panels standing in as images, plus their image map. */
  function withEmailPanels(data, panels) {
    var d = normalize(data), map = {};
    d.items.forEach(function (it) {
      var urls = it.kind === 'loyalty' && !it.images.length && it.email_id && (panels || {})[it.email_id];
      if (!urls || !urls.length) return;
      it.images = urls.slice(0, LOYALTY_IMAGES).map(function (u, k) { map[panelKey(it.email_id, k)] = u; return panelKey(it.email_id, k); });
    });
    return { data: d, images: map };
  }
  /* How many panels: whichever count (1 to 4) shows the email biggest in the loyalty page's image row
     (about 1140 × 515 px, columns 20 px apart). A tall email gets four narrow panels, as Mike laid
     out Grön's; a short one gets fewer, larger ones. */
  function panelCount(w, h) {
    var r = h / Math.max(w, 1), best = 1, bestScale = 0;
    for (var n = 1; n <= LOYALTY_IMAGES; n++) {
      var scale = Math.min((1140 - (n - 1) * 20) / n, 515 / (r / n));
      if (scale > bestScale) { bestScale = scale; best = n; }
    }
    return best;
  }

  async function emailToPanels(html) {
    await loadLibs();
    var W = 600;
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');   // no scripts run inside it
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + W + 'px;height:1200px;border:0';
    document.body.appendChild(frame);
    try {
      await new Promise(function (ok) { frame.onload = ok; setTimeout(ok, 10000); frame.srcdoc = html; });
      var doc = frame.contentDocument;
      if (!doc || !doc.body) throw new Error('the email would not open');
      await Promise.all(Array.prototype.slice.call(doc.images).map(function (im) {
        return im.complete ? null : new Promise(function (ok) { im.onload = im.onerror = ok; setTimeout(ok, 8000); });
      }));
      var H = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1);
      frame.style.height = H + 'px';
      var canvas = await root.html2canvas(doc.body, { scale: 2, backgroundColor: '#ffffff', logging: false, width: W, height: H, windowWidth: W, windowHeight: H });
      var n = panelCount(canvas.width, canvas.height), step = Math.ceil(canvas.height / n), out = [];
      for (var k = 0; k < n; k++) {
        var part = document.createElement('canvas');
        part.width = canvas.width; part.height = Math.min(step, canvas.height - k * step);
        part.getContext('2d').drawImage(canvas, 0, k * step, canvas.width, part.height, 0, 0, canvas.width, part.height);
        out.push(part.toDataURL('image/jpeg', 0.9));
      }
      return out;
    } finally {
      frame.remove();
    }
  }

  function blobToBase64(blob) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')); };
      r.onerror = function () { no(r.error || new Error('Could not read the file')); };
      r.readAsDataURL(blob);
    });
  }

  /* ── THE FORM ────────────────────────────────────────────────────────────────────────────── */
  function newId() { return 'pm-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 46656).toString(36); }

  function statFields(it, ro) {
    var keys = it.kind === 'loyalty' ? ['reach'] : POST_STATS;
    return '<div class="pm-stats">' + keys.map(function (k) {
      var v = has(it, k) ? it.stats[k] : '';
      return '<label class="mk-fld">' + esc(STAT_LABELS[k]) + '<input type="text" inputmode="numeric" data-pm-s="' + k + '" value="' + esc(v) + '"' + ro + '></label>';
    }).join('') + '</div>';
  }

  function thumbsHtml(target, list, max, ro) {
    var tiles = list.map(function (id) {
      return '<span class="pm-thumb"><img src="https://lh3.googleusercontent.com/d/' + esc(id) + '=s200" alt="" loading="lazy" width="72" height="72">'
        + (ro ? '' : '<button type="button" class="pm-x" aria-label="Remove this image" data-pm-unimg="' + esc(target + '|' + id) + '">&times;</button>') + '</span>';
    }).join('');
    var room = list.length < max;
    return '<div class="pm-imgs" data-pm-target="' + esc(target) + '">' + (tiles || '<span class="mk-sub">No images yet.</span>')
      + (ro || !room ? '' : ' <button type="button" class="gx-btn" data-pm-pick="' + esc(target) + '">Choose from vendor folder</button>'
        + ' <label class="gx-btn pm-upl">Upload<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-pm-upload="' + esc(target) + '" hidden></label>')
      + '</div><div class="pm-grid" data-pm-grid="' + esc(target) + '"></div>';
  }

  function itemHtml(it, i, n, ro) {
    var maxImgs = it.kind === 'loyalty' ? LOYALTY_IMAGES : 1;
    return '<div class="pm-item" data-pm-item="' + esc(it.id) + '">'
      + '<div class="pm-item-h"><b>' + esc(KINDS[it.kind]) + (it.name ? ': ' + esc(it.name) : '') + '</b>'
      + (ro ? '' : '<span class="pm-item-tools">'
        + '<button type="button" class="gx-btn" data-pm-up="' + esc(it.id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&uarr;</button>'
        + '<button type="button" class="gx-btn" data-pm-down="' + esc(it.id) + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move down">&darr;</button>'
        + '<button type="button" class="gx-btn" data-pm-del="' + esc(it.id) + '">Remove</button></span>') + '</div>'
      + '<div class="pm-row">'
      + '<label class="mk-fld">Type<select data-pm-f="kind"' + ro + '>' + Object.keys(KINDS).map(function (k) {
          return '<option value="' + k + '"' + (k === it.kind ? ' selected' : '') + '>' + esc(KINDS[k]) + '</option>';
        }).join('') + '</select></label>'
      + '<label class="mk-fld pm-grow">Name<input type="text" maxlength="80" data-pm-f="name" value="' + esc(it.name) + '" placeholder="' + (it.kind === 'loyalty' ? 'e.g. Grön two-week campaign' : 'e.g. Something Big Today') + '"' + ro + '></label>'
      + '<label class="mk-fld">Posted<input type="date" data-pm-f="date" value="' + esc(it.date) + '"' + ro + '></label></div>'
      + '<label class="mk-fld">Wording (the caption or blast copy, kept for the record)<textarea rows="3" maxlength="1500" data-pm-f="words"' + ro + '>' + esc(it.words) + '</textarea></label>'
      + '<div class="mk-fld">' + (it.kind === 'loyalty' ? 'Blast images, in reading order (up to 4 show)' : 'Image') + thumbsHtml('item:' + it.id, it.images, maxImgs, ro) + '</div>'
      + (it.kind === 'loyalty'
        ? '<div class="pm-pull">' + (ro ? '' : '<button type="button" class="gx-btn" data-pm-blasts="' + esc(it.id) + '">Pull the numbers from Dutchie</button> ')
          + (it.ref ? '<span class="mk-sub">From ' + esc(it.ref) + '</span>' : '')
          + (it.email_id && !it.images.length ? '<p class="mk-sub">The report shows this blast\'s own email from Dutchie, in panels. Pick images above to use your own instead.</p>' : '')
          + '<div data-pm-blastbox="' + esc(it.id) + '"></div></div>'
        : '')
      + statFields(it, ro) + '</div>';
  }

  function formHtml(st, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    if (st.error) return '<div class="mk-warn">' + esc(st.error) + '</div>';
    if (!st.data) return '<p class="mk-sub" role="status">Loading the post-mortem&hellip;</p>';
    var d = st.data, n = d.items.length;
    var h = '<p class="mk-sub">Add each Instagram post and loyalty blast from this program with its numbers. '
      + 'The report works out the totals and which post led. Saved as you go.</p>';
    h += d.items.map(function (it, i) { return itemHtml(it, i, n, ro); }).join('');
    if (ctx.canEdit) {
      h += '<div class="pm-add">Add: <button type="button" class="gx-btn" data-pm-add="ig">Instagram post</button>'
        + ' <button type="button" class="gx-btn" data-pm-add="loyalty">Loyalty blast</button>'
        + ' <button type="button" class="gx-btn" data-pm-add="other">Other post</button></div>';
    }
    var note = function (k, label, ph, rows) {
      return '<label class="mk-fld">' + esc(label) + '<textarea rows="' + (rows || 2) + '" maxlength="600" data-pm-note="' + k + '" placeholder="' + esc(ph || '') + '"' + ro + '>' + esc(d.notes[k] || '') + '</textarea></label>';
    };
    h += '<h4 class="pm-h">Notes in the report</h4>'
      + note('overview', 'Overview note', 'e.g. All Instagram views came from followers.')
      + note('loyalty', 'Loyalty blast summary', 'e.g. The blast featured the Pearls Tuesday offer and five vendor-day stops.')
      + note('posts', 'Posts note (leave blank to let the report say "no saves or shares" when that is true)', '')
      + note('sources', 'Sources', DEFAULT_SOURCES, 1);
    h += '<details class="pm-internal"' + (Object.keys(d.channels).length || Object.keys(d.send).length ? ' open' : '') + '><summary>Internal pages (not in the vendor version)</summary>'
      + '<p class="mk-sub">Email &amp; SMS dashboard numbers from Dutchie, typed as shown (e.g. 1.1K, 99%, $78.33).</p>'
      + '<div class="pm-chan"><span></span><b>Email</b><b>SMS</b>' + CHAN_FIELDS.map(function (k) {
          var cell = function (ch) {
            return '<input type="text" maxlength="24" aria-label="' + esc(ch.toUpperCase() + ' ' + CHAN_LABELS[k]) + '" data-pm-chan="' + ch + '" data-pm-cf="' + k + '" value="' + esc((d.channels[ch] || {})[k] || '') + '"' + ro + '>';
          };
          return '<span>' + esc(CHAN_LABELS[k]) + '</span>' + cell('email') + cell('sms');
        }).join('') + '</div>'
      + note('standout', 'What stood out', '', 3)
      + '<h4 class="pm-h">Campaign send review</h4>'
      + '<div class="pm-row"><label class="mk-fld pm-grow">Campaign<input type="text" maxlength="120" data-pm-send="title" value="' + esc(d.send.title || '') + '" placeholder="e.g. Grön SPIFF blast Oct 26 / $4 Pearls Tuesdays"' + ro + '></label>'
      + '<label class="mk-fld">Record count<input type="text" inputmode="numeric" data-pm-send="record_count" value="' + esc(d.send.record_count == null ? '' : d.send.record_count) + '"' + ro + '></label>'
      + '<label class="mk-fld">Listed audience<input type="text" inputmode="numeric" data-pm-send="audience" value="' + esc(d.send.audience == null ? '' : d.send.audience) + '"' + ro + '></label></div>'
      + note('reconcile', 'Send reconciliation', 'One line per point.', 4)
      + '<div class="mk-fld">Dashboard screenshots (up to 2)' + thumbsHtml('send', d.send.images || [], 2, ro) + '</div>'
      + '</details>';
    h += '<div class="pm-actions">'
      + '<button type="button" class="gx-btn" data-pm-preview="vendor">Preview vendor version</button>'
      + '<button type="button" class="gx-btn" data-pm-preview="internal">Preview internal version</button>'
      + (ctx.canEdit ? '<button type="button" class="gx-btn gx-btn-green" data-pm-pdf="vendor">Vendor PDF</button>'
        + '<button type="button" class="gx-btn gx-btn-green" data-pm-pdf="internal">Internal PDF</button>' : '')
      + '<span class="mk-sub" role="status" data-pm-status>' + esc(st.status || '') + '</span></div>'
      + '<div class="pm-preview" data-pm-previewbox></div>';
    h += '<h4 class="pm-h">Past reports</h4>' + (st.reports && st.reports.length
      ? '<ul class="pm-reports">' + st.reports.map(function (r) {
          return '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.name) + '</a>'
            + ' <span class="mk-sub">' + esc((r.version === 'internal' ? 'Internal' : 'Vendor') + ' · ' + r.made_by + ' · ' + String(r.made_at).slice(0, 16)) + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="mk-sub">None yet. Each PDF made here is saved to SPIFF Reports and listed here.</p>');
    return h;
  }

  function gridHtml(r, chosen) {
    if (!r) return '<p class="mk-sub" role="status">Looking in the vendor folder&hellip;</p>';
    if (!r.ok) return '<div class="mk-warn">' + esc(r.error || 'Could not read the vendor folder.') + '</div>';
    if (!r.folder_url) return '<p class="mk-sub">This program has no vendor folder yet. Upload an image and one is made.</p>';
    var open = ' <a href="' + esc(r.folder_url) + '" target="_blank" rel="noopener noreferrer">Open the folder</a>';
    if (!(r.files || []).length) return '<p class="mk-sub">No images in the vendor folder yet.' + open + '</p>';
    return '<div class="mk-imggrid" role="list">' + r.files.map(function (f) {
      var on = chosen.indexOf(f.id) >= 0;
      return '<button type="button" role="listitem" class="mk-imgtile' + (on ? ' on' : '') + '" data-pm-choose="' + esc(f.id) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(f.name) + '">'
        + '<img src="https://lh3.googleusercontent.com/d/' + esc(f.id) + '=s240" alt="" loading="lazy" width="96" height="96">'
        + '<span>' + esc(f.name) + '</span></button>';
    }).join('') + '</div><p class="mk-sub">Newest first. Click to add.' + open + '</p>';
  }

  /* ── THE CONTROLLER ──────────────────────────────────────────────────────────────────────────
     api (from spiff.js): program(), canEdit(), jsonp(action, params, opts), post(body),
     folderImages(program), logo. One mount per host; show(program) when the open program changes. */
  function mount(host, api) {
    var st = { pid: '', data: null, reports: [], error: '', status: '', grids: {}, blastLists: {}, queue: [], busy: false, images: {} };
    var stale = function (pid) { return pid !== st.pid; };

    function paint() { host.innerHTML = formHtml(st, { canEdit: api.canEdit() }); }
    function status(t, bad) {
      st.status = t;
      var el = host.querySelector('[data-pm-status]');
      if (el) { el.textContent = t; el.classList.toggle('is-bad', !!bad); }
    }

    async function load(force) {
      var p = api.program();
      if (!p) return;
      if (p.program_id === st.pid && st.data && !force) return;
      var pid = p.program_id;
      if (pid !== st.pid) { st = { pid: pid, data: null, reports: [], error: '', status: '', grids: {}, blastLists: {}, queue: [], busy: false, images: {} }; paint(); }
      try {
        var r = await api.jsonp('postmortem', { id: pid }, { timeoutMs: 30000, retries: 1 });
        if (stale(pid)) return;
        if (!r || !r.ok) { st.error = (r && r.error) || 'Could not load the post-mortem.'; paint(); return; }
        st.data = normalize(r.data); st.reports = r.reports || []; st.error = '';
        paint();
      } catch (e) {
        if (stale(pid)) return;
        st.error = 'Could not load the post-mortem: ' + String((e && e.message) || e);
        paint();
      }
    }

    /* Saves go one at a time, oldest first, each batch small enough for a URL. */
    function save(ops, repaint) {
      st.data = applyOps(st.data, ops);
      if (repaint) paint();
      st.queue = st.queue.concat(ops);
      flush();
    }
    async function flush() {
      if (st.busy || !st.queue.length) return;
      var pid = st.pid, batch = [st.queue.shift()];
      while (st.queue.length && JSON.stringify(batch.concat([st.queue[0]])).length < 4000) batch.push(st.queue.shift());
      st.busy = true;
      status('Saving…');
      try {
        var r = await api.jsonp('savePostmortem', { id: pid, patch: JSON.stringify({ ops: batch }) }, { timeoutMs: 30000, retries: 0 });
        if (stale(pid)) return;
        if (!r || !r.ok) throw new Error((r && r.error) || 'save failed');
        status(st.queue.length ? 'Saving…' : 'Saved.');
      } catch (e) {
        if (stale(pid)) return;
        st.queue = [];
        status('Not saved: ' + String((e && e.message) || e) + '. Reloading what is stored.', true);
        st.busy = false;
        return load(true);
      }
      st.busy = false;
      flush();
    }

    function itemOf(id) { return (st.data.items || []).filter(function (x) { return x.id === id; })[0]; }
    function targetList(target) {
      if (target === 'send') return (st.data.send.images || []).slice();
      var it = itemOf(target.replace(/^item:/, ''));
      return it ? it.images.slice() : [];
    }
    function targetMax(target) {
      if (target === 'send') return 2;
      var it = itemOf(target.replace(/^item:/, ''));
      return it && it.kind === 'loyalty' ? LOYALTY_IMAGES : 1;
    }
    function setTarget(target, list) {
      if (target === 'send') return save([['send', Object.assign({}, st.data.send, { images: list })]], true);
      var it = itemOf(target.replace(/^item:/, ''));
      if (it) save([['item', it.id, Object.assign({}, it, { images: list })]], true);
    }
    function addImage(target, id) {
      var list = targetList(target);
      if (list.indexOf(id) >= 0) list = list.filter(function (x) { return x !== id; });
      else if (targetMax(target) === 1) list = [id];
      else if (list.length < targetMax(target)) list.push(id);
      setTarget(target, list);
    }

    async function openGrid(target) {
      var box = host.querySelector('[data-pm-grid="' + target + '"]');
      if (!box) return;
      box.innerHTML = gridHtml(null, []);
      var r;
      try { r = await api.folderImages(api.program()); }
      catch (e) { r = { ok: false, error: 'Could not read the vendor folder: ' + String((e && e.message) || e) }; }
      st.grids[target] = r;
      box = host.querySelector('[data-pm-grid="' + target + '"]');
      if (box) box.innerHTML = gridHtml(r, targetList(target));
    }

    async function openBlasts(itemId, btn) {
      var pid = st.pid, box = host.querySelector('[data-pm-blastbox="' + itemId + '"]');
      if (!box) return;
      box.innerHTML = blastListHtml(null, itemId);
      if (btn) btn.disabled = true;
      var r;
      try { r = await api.jsonp('postmortemBlasts', { id: pid }, { timeoutMs: 45000, retries: 1 }); }
      catch (e) { r = { ok: false, error: 'Could not read the Dutchie blast results: ' + String((e && e.message) || e) }; }
      if (stale(pid)) return;
      st.blastLists[itemId] = r;
      box = host.querySelector('[data-pm-blastbox="' + itemId + '"]');
      if (box) box.innerHTML = blastListHtml(r, itemId);
      if (btn) btn.disabled = false;
    }

    async function upload(target, file) {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) return status('That image is over 10 MB.', true);
      var pid = st.pid;
      status('Uploading ' + file.name + '…');
      try {
        var data = await blobToBase64(file);
        var r = await api.post({ action: 'postmortemUpload', id: pid, name: file.name, mime: file.type, data: data });
        if (stale(pid)) return;
        if (r && r.ok === false) throw new Error(r.error || 'upload failed');
        var id = r && r.file_id;
        if (!id) {
          /* The reply could not be read (Apps Script POST replies are not always readable cross-site):
             find the file by name in the folder instead. */
          var list = await api.folderImages(api.program());
          var hit = list && list.ok && (list.files || []).filter(function (f) { return f.name === file.name; })[0];
          id = hit && hit.id;
        }
        if (!id) throw new Error('it did not show up in the vendor folder');
        addImage(target, id);
        status('Uploaded ' + file.name + ' to the vendor folder.');
      } catch (e) {
        if (!stale(pid)) status('Upload not confirmed: ' + String((e && e.message) || e), true);
      }
    }

    async function fetchImages(version) {
      var want = imageIds(st.data, version).filter(function (id) { return !st.images[id]; });
      var failed = [];
      for (var i = 0; i < want.length; i += 4) {
        var r = await api.jsonp('postmortemImages', { id: st.pid, ids: want.slice(i, i + 4).join(',') }, { timeoutMs: 60000, retries: 1 });
        if (!r || !r.ok) throw new Error((r && r.error) || 'could not read the images');
        Object.keys(r.images || {}).forEach(function (k) { st.images[k] = r.images[k]; });
        failed = failed.concat(r.failed || []);
      }
      return failed;
    }

    /* Each blast whose email stands in for its images, drawn once per open program. */
    async function ensurePanels() {
      st.emailPanels = st.emailPanels || {};
      var notes = [];
      var want = st.data.items.filter(function (it) {
        return it.kind === 'loyalty' && it.email_id && !it.images.length && !st.emailPanels[it.email_id];
      });
      for (var i = 0; i < want.length; i++) {
        var id = want[i].email_id;
        try {
          var r = await api.jsonp('postmortemBlastEmail', { id: st.pid, blast: id }, { timeoutMs: 60000, retries: 1 });
          if (!r || !r.ok) throw new Error((r && r.error) || 'could not read it');
          st.emailPanels[id] = await emailToPanels(r.html);
          if (r.failed) notes.push(plural(r.failed, 'picture') + ' in the blast email could not be loaded.');
        } catch (e) {
          st.emailPanels[id] = [];
          notes.push('The blast email could not be drawn: ' + String((e && e.message) || e) + '.');
        }
      }
      return notes;
    }
    function view() {
      var v = withEmailPanels(st.data, st.emailPanels);
      return { data: v.data, images: Object.assign({}, st.images, v.images) };
    }

    function progOf() {
      var p = api.program() || {};
      return { vendor: p.vendor, program_name: p.program_name || p.title, start_date: p.start_date, end_date: p.end_date };
    }

    async function preview(version) {
      var box = host.querySelector('[data-pm-previewbox]');
      if (!box) return;
      if (box.dataset.shown === version) { box.innerHTML = ''; box.dataset.shown = ''; return; }
      ensureFonts(); ensureCss();
      status('Building the preview…');
      try {
        var failed = await fetchImages(version);
        var notes = await ensurePanels();
        var v = view();
        var html = reportHtml(v.data, progOf(), version, v.images, { logo: api.logo });
        if (!html) { status('Add a post or blast first.', true); return; }
        box.dataset.shown = version;
        box.innerHTML = '<div class="pm-scale">' + html + '</div>';
        var scale = Math.min(1, (box.clientWidth || PAGE_W) / PAGE_W);
        var inner = box.firstChild;
        inner.style.transform = 'scale(' + scale + ')';
        inner.style.height = (inner.scrollHeight * scale) + 'px';
        var warn = (failed.length ? [plural(failed.length, 'image') + ' could not be read and show as black boxes.'] : []).concat(notes);
        status(warn.join(' '), !!warn.length);
      } catch (e) {
        status('Could not build the preview: ' + String((e && e.message) || e), true);
      }
    }

    async function makePdf(version, btn) {
      var pid = st.pid;
      if (!st.data || !st.data.items.length) return status('Add a post or blast first.', true);
      if (st.queue.length || st.busy) return status('Still saving. Try again in a moment.', true);
      if (btn) btn.disabled = true;
      try {
        status('Reading the images…');
        var failed = await fetchImages(version);
        if (failed.length && !root.confirm(plural(failed.length, 'image') + ' could not be read and would print as black boxes. Make the PDF anyway?')) {
          status('Not made.'); return;
        }
        status('Drawing the pages…');
        var notes = await ensurePanels();
        if (notes.length && !root.confirm(notes.join(' ') + ' Make the PDF anyway?')) { status('Not made.'); return; }
        var v = view();
        var html = reportHtml(v.data, progOf(), version, v.images, { logo: api.logo });
        var blob = await htmlToPdf(html);
        var name = fileName(progOf(), version);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
        status('Downloaded. Saving a copy to SPIFF Reports…');
        var nonce = newId();
        var r = await api.post({ action: 'postmortemSave', id: pid, version: version, pdf: await blobToBase64(blob), nonce: nonce });
        if (r && r.ok === false) throw new Error(r.error || 'save failed');
        /* Whatever the reply said, the list is read back from the engine: that is what is on file. */
        var back = await api.jsonp('postmortem', { id: pid }, { timeoutMs: 30000, retries: 1 });
        if (stale(pid)) return;
        if (back && back.ok) st.reports = back.reports || [];
        var filed = (st.reports || []).some(function (x) { return x.nonce === nonce; });
        paint();
        status(filed ? 'Downloaded and saved to SPIFF Reports.' : 'Downloaded, but the copy in SPIFF Reports is not confirmed. Make it again to retry.', !filed);
      } catch (e) {
        if (!stale(pid)) status('Not finished: ' + String((e && e.message) || e), true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    host.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || !host.contains(t) || !st.data) return;
      var ds = t.dataset;
      if (ds.pmPreview) return preview(ds.pmPreview);
      if (ds.pmPdf) return makePdf(ds.pmPdf, t);
      if (!api.canEdit()) return;
      if (ds.pmAdd) {
        if (st.data.items.length >= MAX_ITEMS) return status('A report holds up to ' + MAX_ITEMS + ' entries.', true);
        var id = newId();
        return save([['item', id, { kind: ds.pmAdd, name: '', words: '', images: [], stats: {} }]], true);
      }
      if (ds.pmDel) {
        var it = itemOf(ds.pmDel);
        if (it && (it.name || it.images.length || Object.keys(it.stats).length) && !root.confirm('Remove ' + (it.name || 'this entry') + ' from the report?')) return;
        return save([['item', ds.pmDel, null]], true);
      }
      if (ds.pmUp) return save([['move', ds.pmUp, -1]], true);
      if (ds.pmDown) return save([['move', ds.pmDown, 1]], true);
      if (ds.pmPick) return openGrid(ds.pmPick);
      if (ds.pmBlasts) return openBlasts(ds.pmBlasts, t);
      if (ds.pmUseblast) {
        var parts = ds.pmUseblast.split('|'), list = st.blastLists[parts[0]];
        var blast = list && list.ok && (list[parts[1]] || [])[Number(parts[2])];
        if (!blast) return;
        save(blastOps(st.data, parts[0], blast), true);
        return status('Filled from Dutchie: ' + (blast.name || 'the blast') + '. Check the numbers, then pick the blast images.');
      }
      if (ds.pmUnimg) {
        var bar = ds.pmUnimg.lastIndexOf('|');
        var target = ds.pmUnimg.slice(0, bar), fid = ds.pmUnimg.slice(bar + 1);
        return setTarget(target, targetList(target).filter(function (x) { return x !== fid; }));
      }
      if (ds.pmChoose) {
        var grid = t.closest('[data-pm-grid]');
        if (grid) addImage(grid.dataset.pmGrid, ds.pmChoose);
      }
    });

    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t.dataset || !st.data || !api.canEdit()) return;
      if (t.dataset.pmUpload) { var f = t.files && t.files[0]; t.value = ''; return upload(t.dataset.pmUpload, f); }
      var box = t.closest('[data-pm-item]');
      if (box && (t.dataset.pmF || t.dataset.pmS)) {
        var it = itemOf(box.dataset.pmItem);
        if (!it) return;
        var next = JSON.parse(JSON.stringify(it));
        if (t.dataset.pmF) next[t.dataset.pmF] = t.value;
        if (t.dataset.pmS) { var n = num(t.value); if (n === null) delete next.stats[t.dataset.pmS]; else next.stats[t.dataset.pmS] = n; }
        /* A new type changes the fields and how many images it takes, so that one repaints. */
        var retype = t.dataset.pmF === 'kind';
        if (retype && next.kind !== 'loyalty') next.images = next.images.slice(0, 1);
        return save([['item', it.id, next]], retype || t.dataset.pmF === 'name');
      }
      if (t.dataset.pmNote) return save([['note', t.dataset.pmNote, t.value]], false);
      if (t.dataset.pmChan) {
        var row = Object.assign({}, st.data.channels[t.dataset.pmChan] || {});
        row[t.dataset.pmCf] = t.value;
        return save([['chan', t.dataset.pmChan, row]], false);
      }
      if (t.dataset.pmSend) {
        var s = Object.assign({}, st.data.send);
        s[t.dataset.pmSend] = t.value;
        return save([['send', s]], false);
      }
    });

    return { show: function () { return load(false); }, reload: function () { return load(true); },
             state: function () { return st; } };
  }

  var api = {
    KINDS: KINDS, STATS: STATS, NOTES: NOTES, CHAN_FIELDS: CHAN_FIELDS, DEFAULT_SOURCES: DEFAULT_SOURCES,
    PAGE_W: PAGE_W, PAGE_H: PAGE_H, REPORT_CSS: REPORT_CSS, LIBS: LIBS,
    normalize: normalize, applyOps: applyOps, fmtK: fmtK, summary: summary, leadLine: leadLine, dateRange: dateRange,
    pagesOf: pagesOf, reportHtml: reportHtml, imageIds: imageIds, fileName: fileName, formHtml: formHtml, gridHtml: gridHtml,
    blastOps: blastOps, blastListHtml: blastListHtml, withEmailPanels: withEmailPanels, panelCount: panelCount,
    emailToPanels: emailToPanels, toPdf: htmlToPdf, mount: mount
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpiffPostmortem = api;
})(this);
