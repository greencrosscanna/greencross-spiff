// <gc-deals> — the Weekly Deals section of greencrosscanna.com/deals, as a Wix custom element.
// The Wix page code reads four CMS collections and hands them over raw as one JSON `data`
// attribute: { vendors, featured, days, week }. Everything else (sorting, dropping past vendor
// days, matching logos, layout) happens here, so the page code stays a few lines.
// Design: the approved "Deals Page Redesign" canvas (Sky, 2026-11-02).
(function () {
  if (customElements.get('gc-deals')) return;

  var BASE = 'https://greencrosscanna.github.io/greencross-spiff/wix/';
  var LIME = '#95D500';
  // Fallback tile colors, used only when a Vendors item has no Brand Color.
  var COLORS = { gron: '#7CD4CA', wyld: '#1E271B', goodtide: '#1E271B', muleextracts: '#E1E2E0',
    verdantleaf: '#E1E2E0', freshy: '#1A1919', bobsled: '#4197C6', hellavated: '#3A1A4A' };

  var fold = function (s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  // Wix image fields come back as wix:image://v1/<mediaId>/<name>#…; a pasted link stays a URL.
  var img = function (u) {
    if (!u) return '';
    if (typeof u === 'object') u = u.src || u.url || '';
    u = String(u);
    if (u.indexOf('wix:image://') === 0) return 'https://static.wixstatic.com/media/' + u.split('/')[3];
    return u;
  };
  var day10 = function (d) { return d ? String(d.$date || d).slice(0, 10) : ''; };
  var todayLA = function () {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  };
  // Rich text from the CMS is the team's own HTML; keep only simple formatting tags.
  var rich = function (html) {
    return String(html || '').replace(/<(?!\/?(p|strong|b|em|i|br|span)\b)[^>]*>/gi, '');
  };

  var CSS = [
    '.gcd{background:#F3F2F0 url(' + BASE + 'grit.png?v=2) repeat;background-size:1600px 1600px;color:#14181D;font-family:"Work Sans",Arial,sans-serif;font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}',
    '.gcd *{box-sizing:border-box}',
    '.gcd h1,.gcd h2,.gcd h3,.gcd p{margin:0}',
    '.gcd .mt{font-family:Montserrat,Arial,sans-serif}',
    '.gcd-wrap{max-width:1200px;margin:0 auto;padding:0 16px}',
    '.gcd-hero{background:' + LIME + '}',
    '.gcd-hero .gcd-wrap{padding-top:40px;padding-bottom:44px}',
    '.gcd-tag{display:inline-block;padding:6px 12px;background:#14181D;color:#fff;border-radius:6px;font-weight:800;font-size:13px;letter-spacing:1.5px}',
    '.gcd-h1{margin-top:14px!important;font-weight:900;font-size:84px;line-height:.92;letter-spacing:-2px}',
    '.gcd-sec{padding-top:40px}',
    '.gcd-h2{margin:0 0 20px!important;padding:14px 18px 12px;background:#14181D;color:#fff;border-radius:8px;font-weight:900;font-size:40px;line-height:1;letter-spacing:-1px}',
    '.gcd-feat{background:#14181D;color:#fff;border-radius:10px;overflow:hidden;display:flex;flex-wrap:wrap;margin-bottom:24px}',
    '.gcd-feat-img{flex:1 1 420px;align-self:flex-start;min-width:0;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fff;display:block}',
    '.gcd-feat-body{flex:1 1 380px;min-width:0;padding:28px 24px;display:flex;flex-direction:column;gap:18px}',
    '.gcd-feat-top{display:flex;align-items:center;gap:14px}',
    '.gcd-feat-logo{width:160px;height:64px;object-fit:contain;border-radius:6px;flex:none}',
    '.gcd-pill{padding:4px 10px;border-radius:5px;background:' + LIME + ';color:#14181D;font-weight:900;font-size:12px;letter-spacing:1.5px}',
    '.gcd-thru{font-weight:800;font-size:13px;letter-spacing:1px;color:#C9CED4}',
    '.gcd-feat h3{font-weight:900;font-size:32px;line-height:1.05;letter-spacing:-.5px;text-transform:uppercase}',
    '.gcd-offers p{margin:0 0 10px!important;font-size:16px;color:#EEF0F2}',
    '.gcd-offers strong,.gcd-offers b{font-family:Montserrat,Arial,sans-serif;font-weight:900;font-size:26px;color:' + LIME + ';margin-right:10px}',
    '.gcd-btn{display:flex;align-items:center;justify-content:center;min-height:56px;padding:0 16px;border-radius:6px;background:#fff;color:#14181D;font-weight:800;font-size:14px;letter-spacing:1px;text-decoration:none;text-align:center}',
    '.gcd-fine{font-size:13px;color:#AEB4BB}',
    '.gcd-days{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.gcd-day{background:#fff;border:1px solid #E2E2DF;border-radius:8px;overflow:hidden;display:flex;flex-wrap:wrap;align-items:stretch}',
    '.gcd-date{flex:0 0 64px;background:' + LIME + ';display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 0;line-height:1}',
    '.gcd-date span:first-child{font-weight:800;font-size:12px;letter-spacing:1.5px}',
    '.gcd-date span:last-child{font-weight:900;font-size:21px;margin-top:4px}',
    '.gcd-dlogo{flex:0 0 180px;min-height:72px;display:flex;align-items:center;justify-content:center}',
    '.gcd-dlogo img{width:180px;height:72px;object-fit:contain;display:block}',
    '.gcd-dbody{flex:1 1 0;min-width:0;padding:12px 14px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px}',
    '.gcd-store{font-weight:900;font-size:18px;line-height:1.15;text-transform:uppercase}',
    '.gcd-time{margin-top:2px!important;font-size:15px;font-weight:500;color:#3C434B}',
    '.gcd-deal{flex:none;padding:5px 9px;border-radius:6px;background:#14181D;color:#fff;font-weight:900;font-size:14px}',
    '.gcd-offer{font-size:14px;line-height:1.3;color:#3C434B}',
    '.gcd-name{color:#fff;font-weight:900;font-size:15px;letter-spacing:.5px;padding:0 8px;text-align:center}',
    '.gcd-week{display:flex;flex-direction:column;gap:14px}',
    '.gcd-wday{display:flex;flex-wrap:wrap;align-items:center;gap:6px 24px}',
    '.gcd-wday+.gcd-wday{padding-top:14px;border-top:2px solid #D9D9D5}',
    '.gcd-wday h3{flex:0 0 160px;font-weight:900;font-size:52px;line-height:1;letter-spacing:-1.5px}',
    '.gcd-rows{flex:1 1 320px;min-width:0;background:#fff;border:1px solid #E2E2DF;border-radius:6px;overflow:hidden}',
    '.gcd-row{display:flex;align-items:stretch}',
    '.gcd-row+.gcd-row{border-top:1px solid #E2E2DF}',
    '.gcd-wlogo{flex:0 0 150px;min-height:104px;display:flex;align-items:center;justify-content:center}',
    '.gcd-wlogo img{width:150px;height:auto;max-height:100%;object-fit:contain;display:block}',
    '.gcd-wbody{flex:1 1 auto;min-width:0;padding:12px 18px;display:flex;align-items:center;gap:12px}',
    '.gcd-amt{flex:none;min-width:52px;display:flex;flex-direction:column;align-items:center;line-height:1}',
    '.gcd-amt b{font-family:Montserrat,Arial,sans-serif;font-weight:900;font-size:34px}',
    '.gcd-amt i{font-style:normal;margin-top:3px;font-family:Montserrat,Arial,sans-serif;font-weight:900;font-size:13px;letter-spacing:2px}',
    '.gcd-wtext{font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:16px;line-height:1.25}',
    '.gcd-hr{height:6px;margin:0 0 32px;border:0;background:#14181D;border-radius:3px}',
    '.gcd-every{background:' + LIME + ';border-radius:10px;overflow:hidden;display:flex;flex-wrap:wrap;align-items:stretch}',
    '.gcd-every img{flex:0 0 132px;width:132px;min-height:120px;object-fit:cover;display:block}',
    '.gcd-every-body{flex:1 1 300px;min-width:0;padding:20px 24px;display:flex;flex-wrap:wrap;gap:14px 40px;align-items:center}',
    '.gcd-every h3{font-weight:900;font-size:34px;letter-spacing:-1px}',
    '.gcd-every p{flex:1 1 220px;min-width:0;font-weight:500}',
    '.gcd-every strong{font-family:Montserrat,Arial,sans-serif;font-weight:900;font-size:22px}',
    '.gcd-foot{display:flex;flex-wrap:wrap;gap:24px 48px;align-items:center;padding-top:40px;padding-bottom:64px}',
    '.gcd-foot>div:first-child{flex:2 1 420px;min-width:0}',
    '.gcd-foot>div:last-child{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:10px;align-items:flex-start}',
    '.gcd-foot h3{margin-bottom:8px!important;font-weight:900;font-size:14px;letter-spacing:1.5px}',
    '.gcd-menu{display:inline-flex;align-items:center;min-height:50px;padding:0 26px;background:#14181D;color:' + LIME + ';font-weight:900;font-size:14px;letter-spacing:1px;text-decoration:none;border-radius:6px}',
    '@media (max-width:600px){',
    '.gcd-h1{font-size:60px}.gcd-h2{font-size:30px}.gcd-feat h3{font-size:26px}',
    '.gcd-dlogo{order:-1;flex:1 0 100%;min-height:64px}.gcd-dlogo img{width:auto;height:64px}',
    '.gcd-wday h3{flex-basis:100%;font-size:40px}',
    '.gcd-wlogo{flex-basis:120px}.gcd-wlogo img{width:120px}',
    '.gcd-btn{white-space:normal}',
    '}'
  ].join('\n');

  function ensureHead() {
    if (document.getElementById('gcd-style')) return;
    var f = document.createElement('link');
    f.rel = 'stylesheet';
    f.href = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800;900&family=Work+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(f);
    var s = document.createElement('style');
    s.id = 'gcd-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function build(data) {
    var vendors = data.vendors || [];
    var byKey = {};
    vendors.forEach(function (v) {
      var rec = { name: v.title, logo: img(v.logoWide || v.logo), color: v.brandColor || COLORS[fold(v.title)] || '#14181D' };
      if (v._id) byKey['id:' + v._id] = rec;
      byKey[fold(v.title)] = rec;
      (v.aliases || []).forEach(function (a) { byKey[fold(a)] = rec; });
    });
    var vendorOf = function (item) {
      var ref = item.vendorRef;
      if (ref && typeof ref === 'object') ref = ref._id;
      return (ref && byKey['id:' + ref]) || byKey[fold(item.title)] || { name: item.title, logo: '', color: '#14181D' };
    };
    var tile = function (v, cls) {
      return '<div class="' + cls + '" style="background:' + esc(v.color) + '">' +
        (v.logo ? '<img src="' + esc(v.logo) + '" alt="' + esc(v.name) + '" loading="lazy">'
                : '<span class="gcd-name mt">' + esc(v.name) + '</span>') + '</div>';
    };

    var today = todayLA();
    var days = (data.days || []).filter(function (d) { return day10(d.date) >= today; })
      .sort(function (a, b) {
        return day10(a.date) < day10(b.date) ? -1 : day10(a.date) > day10(b.date) ? 1 : (a.sortTime || 0) - (b.sortTime || 0);
      });
    var featured = (data.featured || []).filter(function (f) { return f.live === true || f.live === 'true'; })
      .filter(function (f) { return !f.endDate || day10(f.endDate) >= today; })
      .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });

    var h = '<div class="gcd">';
    h += '<section class="gcd-hero"><div class="gcd-wrap"><span class="gcd-tag mt">ALL SIX STORES</span>' +
      '<h1 class="gcd-h1 mt">WEEKLY<br>DEALS</h1></div></section>';

    if (featured.length) {
      h += '<section class="gcd-sec"><div class="gcd-wrap">';
      featured.forEach(function (f) {
        var v = vendorOf(f);
        var n = days.filter(function (d) { return (f.programId && d.programId === f.programId) || vendorOf(d).name === v.name; }).length;
        h += '<article class="gcd-feat">' +
          (f.image ? '<img class="gcd-feat-img" src="' + esc(img(f.image)) + '" alt="' + esc(f.imageAltText || f.headline) + '">' : '') +
          '<div class="gcd-feat-body"><div class="gcd-feat-top">' +
          (v.logo ? '<img class="gcd-feat-logo" src="' + esc(v.logo) + '" alt="' + esc(v.name) + ' logo" style="background:' + esc(v.color) + '">' : '') +
          '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-start"><span class="gcd-pill mt">FEATURED</span>' +
          (f.throughLabel ? '<span class="gcd-thru mt">' + esc(String(f.throughLabel).toUpperCase()) + '</span>' : '') + '</div></div>' +
          '<h3 class="mt">' + esc(f.headline) + '</h3>' +
          '<div class="gcd-offers">' + rich(f.offerLines) + '</div>' +
          (n ? '<a class="gcd-btn mt" href="#gcd-vendordays">SEE ' + n + ' ' + esc(String(v.name).toUpperCase()) + ' VENDOR DAY' + (n > 1 ? 'S' : '') + ' ↓</a>' : '') +
          (f.finePrint ? '<p class="gcd-fine">' + esc(f.finePrint) + '</p>' : '') +
          '</div></article>';
      });
      h += '</div></section>';
    }

    if (days.length) {
      h += '<section class="gcd-sec" id="gcd-vendordays"><div class="gcd-wrap"><h2 class="gcd-h2 mt">VENDOR DAYS</h2><ol class="gcd-days">';
      days.forEach(function (d) {
        var v = vendorOf(d);
        h += '<li class="gcd-day"><div class="gcd-date mt"><span>' + esc(d.dayLabel) + '</span><span>' + esc(d.dateLabel) + '</span></div>' +
          tile(v, 'gcd-dlogo') +
          '<div class="gcd-dbody"><div style="flex:1 1 180px;min-width:0"><p class="gcd-store mt">' + esc(d.store || 'All stores') + '</p>' +
          '<p class="gcd-time">' + esc(d.time) + '</p></div>' +
          '<div style="flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:10px">' +
          (d.deal ? '<span class="gcd-deal mt">' + esc(d.deal) + '</span>' : '') +
          (d.offer ? '<span class="gcd-offer">' + esc(d.offer) + '</span>' : '') + '</div></div></li>';
      });
      h += '</ol></div></section>';
    }

    var week = (data.week || []).slice().sort(function (a, b) {
      return (a.daySort || 0) - (b.daySort || 0) || (a.rowSort || 0) - (b.rowSort || 0);
    });
    if (week.length) {
      var groups = [];
      week.forEach(function (w) {
        var g = groups[groups.length - 1];
        if (!g || g.day !== w.day) groups.push(g = { day: w.day, rows: [] });
        g.rows.push(w);
      });
      h += '<section class="gcd-sec"><div class="gcd-wrap"><h2 class="gcd-h2 mt">EVERY WEEK</h2><div class="gcd-week">';
      groups.forEach(function (g) {
        h += '<div class="gcd-wday"><h3 class="mt">' + esc(g.day) + '</h3><div class="gcd-rows">';
        g.rows.forEach(function (r) {
          var text = String(r.text || '');
          var off = /^OFF\s/i.test(text);
          if (off) text = text.replace(/^OFF\s+(\w)/i, function (m, c) { return c.toUpperCase(); });
          h += '<div class="gcd-row">' + tile(vendorOf(r), 'gcd-wlogo') +
            '<div class="gcd-wbody"><div class="gcd-amt"><b>' + esc(r.amount) + '</b>' + (off ? '<i>OFF</i>' : '') + '</div>' +
            '<span class="gcd-wtext">' + esc(text) + '</span></div></div>';
        });
        h += '</div></div>';
      });
      h += '</div></div></section>';
    }

    h += '<section class="gcd-sec"><div class="gcd-wrap"><hr class="gcd-hr"><div class="gcd-every">' +
      '<img src="' + BASE + 'gc-icon.png" alt="">' +
      '<div class="gcd-every-body"><h3 class="mt">EVERY DAY</h3>' +
      '<p><strong>15% OFF</strong> for veterans with a valid veteran ID.</p>' +
      '<p><strong>5% BACK</strong> with Green Cross Plus.<br>1 point for every $1. 20 points is $1 off.</p>' +
      '</div></div></div></section>';

    h += '<section><div class="gcd-wrap gcd-foot"><div><h3 class="mt">THE FINE PRINT</h3>' +
      '<p style="font-size:14px;color:#3C434B">Deals apply at all six stores and can change without notice. Available while supplies last. ' +
      'Discounts cannot be combined unless noted. Customers must be 21 or older with a valid government ID.</p></div>' +
      '<div><p style="font-weight:600">Today\'s full list of specials is on the live menu.</p>' +
      '<a class="gcd-menu mt" href="' + esc(data.menuUrl || '/menu') + '" target="_top">SHOP THE LIVE MENU</a></div></div></section>';

    return h + '</div>';
  }

  class GcDeals extends HTMLElement {
    static get observedAttributes() { return ['data']; }
    connectedCallback() {
      ensureHead();
      this.render();
      var self = this;
      window.addEventListener('resize', function () { self.clearHeader(); });
    }
    attributeChangedCallback() { this.render(); }
    render() {
      var raw = this.getAttribute('data');
      if (!raw) { this.innerHTML = ''; return; }
      try { this.innerHTML = build(JSON.parse(raw)); this.clearHeader(); }
      catch (e) { this.innerHTML = ''; console.error('[gc-deals]', e); }
    }
    // The Wix site header floats over the top of the page, so the lime band would start under it.
    // Push the band's text down by however much of the header covers this element.
    clearHeader() {
      var wrap = this.querySelector('.gcd-hero .gcd-wrap');
      var head = document.getElementById('SITE_HEADER') || document.querySelector('header');
      if (!wrap || !head) return;
      // Page positions, not screen ones: the header is sticky, so on a scrolled page its screen
      // position says nothing about where it sat over this element at the top.
      var cover = head.offsetHeight - (this.getBoundingClientRect().top + window.scrollY);
      wrap.style.paddingTop = (40 + Math.max(0, Math.min(cover, 200))) + 'px';
    }
  }
  customElements.define('gc-deals', GcDeals);
  // The Wix editor kept publishing this element under its placeholder tag even with "gc-deals"
  // set in Element Attributes (seen 2026-11-02 on the test site). Nothing else defines that tag
  // once our Server URL replaces Wix's placeholder script, so answer to it too.
  if (!customElements.get('wix-default-custom-element')) {
    customElements.define('wix-default-custom-element', class extends GcDeals {});
  }
})();
