/* ─── The Deals page screen: the weekly lines and the brand tiles (Sky, 2026-11-02) ─────────────────
 * greencrosscanna.com/deals is filled from SPIFF and nobody edits it in Wix. Featured cards and vendor
 * days come from each program's marketing plan; THIS screen is the rest: the Tue–Sat schedule and the
 * brand logos. The engine's THE DEALS PAGE, PART 2 (apps-script/Code.gs) owns the rules; this only
 * draws them and sends what is typed.
 *
 * Lives in the Programs tab as a fourth view beside List / Calendar / Tasks, behind marketing.js's
 * switch (Sky, Mike and Tawny only, until it is flipped). The approve box is the screen's word only:
 * the engine signs every approval with the session and ignores anyone who is not an approver.
 * None of these calls is hedged: a hedged write runs twice. */
(function () {
  'use strict';
  var MK = function () { return window.SpiffMarketing || null; };
  var DAYS = ['TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'MON'];
  var S = { loaded: false, loading: false, ready: true, weekly: [], vendors: [], approvers: ['sky', 'mike', 'tawny'],
            msg: '', err: '', media: null, mediaFor: null, busy: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  /* wix:image://v1/<file>/<name>#… → the file on Wix's media server, for a thumbnail. */
  function wixSrc(v) {
    var m = /^wix:image:\/\/v1\/([^/]+)\//.exec(String(v || ''));
    return m ? 'https://static.wixstatic.com/media/' + m[1] : '';
  }
  /* marketing.js holds the copy rules the engine also holds (WIX_COPY_RULES_). Missing it is not a
     pass: the line is treated as unchecked rather than clean. */
  function copyProblem(texts) { var m = MK(); return m && m.copyProblem ? m.copyProblem(texts) : 'copy rules not loaded; reload the page'; }
  /* The same checks the engine makes before it lets a line be approved (siteProblem_). */
  function problemOf(s) {
    if (s.kind === 'vendor') {
      if (!String(s.brand || '').trim()) return 'the brand needs a name';
      if ([s.logo, s.logo_wide].some(function (u) { return u && !/^wix:image:\/\//.test(u); })) return 'a logo must be picked from or imported into Wix Media';
      return '';
    }
    if (DAYS.indexOf(s.day) < 0) return 'pick a day';
    if (!String(s.brand || '').trim()) return 'pick a brand';
    if (!/^(\$\d+(\.\d{2})?|\d{1,2}%)$/.test(String(s.amount || ''))) return 'the amount must be a straight discount, like $2 or 15%';
    if (!String(s.text || '').trim()) return 'say what it is off';
    var b = copyProblem([s.brand, s.amount, s.text]);
    return b ? 'breaks the OLCC copy rules ("' + b + '")' : '';
  }
  function stateChip(s) {
    var p = problemOf(s);
    if (p) return '<span class="st-chip st-bad">' + esc(p) + '</span>';
    if (S.approvers.indexOf(String(s.approved_by || '').toLowerCase()) >= 0)
      return '<span class="st-chip st-ok">On the page · approved by ' + esc(s.approved_by) + '</span>';
    return '<span class="st-chip st-wait">Waiting for Sky, Mike or Tawny to approve</span>';
  }

  function css() {
    if (document.getElementById('st-style')) return;
    var st = document.createElement('style');
    st.id = 'st-style';
    st.textContent = [
      '.st-wrap{display:flex;flex-direction:column;gap:18px}',
      '.st-sec{display:flex;flex-direction:column;gap:8px}',
      '.st-line{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px;border:1px solid var(--gx-line,#e3e5e8);border-radius:10px}',
      '.st-line .sp-in{min-width:0}',
      '.st-day{width:84px}.st-row{width:56px}.st-amt{width:76px}.st-brand{width:170px}.st-text{flex:1 1 260px}',
      '.st-chip{font-size:12px;padding:3px 8px;border-radius:999px}',
      '.st-ok{background:#e8f6d4;color:#2f5b00}.st-wait{background:#fff4d6;color:#7a5600}.st-bad{background:#fde3e1;color:#8a1c12}',
      '.st-logo{width:64px;height:64px;object-fit:contain;background:#14181D;border-radius:8px}',
      '.st-logo.wide{width:120px;height:48px}',
      '.st-media{display:flex;flex-wrap:wrap;gap:8px}',
      '.st-media button{border:1px solid var(--gx-line,#e3e5e8);background:#fff;border-radius:8px;padding:4px;cursor:pointer;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:2px}',
      '.st-media img{width:80px;height:40px;object-fit:contain;background:#14181D;border-radius:4px}',
      '@media (max-width:600px){.st-brand,.st-text{flex:1 1 100%;width:auto}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function weekLineHtml(s, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var approved = S.approvers.indexOf(String(s.approved_by || '').toLowerCase()) >= 0;
    return '<div class="st-line" data-st-key="' + esc(s.key) + '" data-st-kind="week">'
      + '<select class="sp-in st-day" data-f="day"' + ro + '>' + DAYS.map(function (d) {
          return '<option' + (d === s.day ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select>'
      + '<input class="sp-in st-row" data-f="row" type="number" min="1" max="9" value="' + esc(s.row || 1) + '" title="Order within the day"' + ro + '>'
      + '<input class="sp-in st-brand" data-f="brand" list="stBrands" value="' + esc(s.brand) + '" placeholder="Brand"' + ro + '>'
      + '<input class="sp-in st-amt" data-f="amount" value="' + esc(s.amount) + '" placeholder="$2"' + ro + '>'
      + '<input class="sp-in st-text" data-f="text" value="' + esc(s.text) + '" placeholder="OFF all 10-packs"' + ro + '>'
      + '<label class="sp-pill" title="' + (mayApprove ? 'Approve this line for the website' : 'Only Sky, Mike or Tawny can approve') + '">'
      +   '<input type="checkbox" data-f="approve"' + (approved ? ' checked' : '') + (mayApprove && ctx.canEdit ? '' : ' disabled') + '> Approved</label>'
      + stateChip(s)
      + (ctx.canEdit ? '<button class="gx-btn gx-btn-green" data-st-act="save">Save</button>'
          + (s.key ? '<button class="gx-btn" data-st-act="remove">Take off</button>' : '') : '')
      + '</div>';
  }

  function vendorHtml(s, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var approved = S.approvers.indexOf(String(s.approved_by || '').toLowerCase()) >= 0;
    var pic = function (f, wide) {
      var src = wixSrc(s[f]);
      return '<span style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">'
        + (src ? '<img class="st-logo' + (wide ? ' wide' : '') + '" src="' + esc(src) + '" alt="' + esc(s.brand) + '">'
               : '<span class="st-chip st-wait">' + (wide ? 'no wide logo' : 'no square logo') + '</span>')
        + (ctx.canEdit ? '<span><button class="gx-btn" data-st-act="pick" data-st-which="' + f + '">Pick</button> '
          + '<button class="gx-btn" data-st-act="drive" data-st-which="' + f + '">From Drive</button></span>' : '')
        + '<input type="hidden" data-f="' + f + '" value="' + esc(s[f]) + '"></span>';
    };
    var open = S.mediaFor && S.mediaFor.key === s.key;
    return '<div class="st-line" data-st-key="' + esc(s.key) + '" data-st-kind="vendor">'
      + '<input class="sp-in st-brand" data-f="brand" list="stBrands" value="' + esc(s.brand) + '" placeholder="Brand"' + (s.key ? ' title="Key: ' + esc(s.key) + '"' : '') + ro + '>'
      + pic('logo', false) + pic('logo_wide', true)
      + '<input class="sp-in st-brand" data-f="menu_slug" value="' + esc(s.menu_slug) + '" placeholder="menu slug (optional)" title="The brand\'s name on the online menu, e.g. bobsled-extracts"' + ro + '>'
      + '<label class="sp-pill"><input type="checkbox" data-f="approve"' + (approved ? ' checked' : '') + (mayApprove && ctx.canEdit ? '' : ' disabled') + '> Approved</label>'
      + stateChip(s)
      + (ctx.canEdit ? '<button class="gx-btn gx-btn-green" data-st-act="save">Save</button>' : '')
      + (open ? '<div style="flex-basis:100%">' + mediaHtml() + '</div>' : '')
      + '</div>';
  }

  function mediaHtml() {
    var m = S.mediaFor;
    if (!m) return '';
    if (m.mode === 'drive') {
      return '<div class="st-sec"><span class="sp-h4-note">Paste the Drive link of the ' + (m.which === 'logo_wide' ? 'wide (1000 × 400)' : 'square (600 × 600)')
        + ' logo, from the brand\'s folder under Marketing ▸ Vendors. PNG, JPG or SVG, 500 KB max.</span>'
        + '<span><input class="sp-in" id="stDrive" style="width:min(420px,100%)" placeholder="https://drive.google.com/file/d/…"> '
        + '<button class="gx-btn gx-btn-green" data-st-act="import">Import</button> <button class="gx-btn" data-st-act="mclose">Cancel</button></span></div>';
    }
    var list = S.media;
    return '<div class="st-sec"><span><input class="sp-in" id="stMediaQ" value="' + esc(m.q) + '" placeholder="Search Wix Media"> '
      + '<button class="gx-btn" data-st-act="msearch">Search</button> <button class="gx-btn" data-st-act="mclose">Cancel</button></span>'
      + (list === null ? '<span class="sp-h4-note">Searching…</span>'
        : !list.length ? '<span class="sp-h4-note">Nothing in Wix Media by that name.</span>'
        : '<div class="st-media">' + list.map(function (f, i) {
            return '<button data-st-act="mpick" data-st-i="' + i + '"><img src="' + esc(f.url || wixSrc(f.wix_image)) + '" alt=""><span>' + esc(f.name) + '</span></button>';
          }).join('') + '</div>')
      + '</div>';
  }

  function html(ctx) {
    if (!S.ready) return '<div class="mk-warn">The engine has not been updated yet, so the Deals page lines cannot load or save.</div>';
    if (!S.loaded) return '<p class="hint">Loading the deals page…</p>';
    var rules = '<div class="mk-spec"><b>Copy rules:</b> straight discounts only, “$X off [brand] on [day]”. '
      + 'Never BOGO, “buy one”, “free” cannabis or “with purchase”; no “best”, “#1”, “lowest”, health claims or em-dashes. '
      + 'No Green Cross house brands. Only Sky, Mike or Tawny can approve; anyone else\'s change takes the approval off.</div>';
    var brands = (ctx.brands || []).map(function (b) { return '<option value="' + esc(b.display_name) + '">'; }).join('');
    var waiting = S.weekly.concat(S.vendors).filter(function (s) {
      return s.key && S.approvers.indexOf(String(s.approved_by || '').toLowerCase()) < 0 && !problemOf(s);
    }).length;
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var all = ctx.canEdit && mayApprove && waiting
      ? '<span><button class="gx-btn gx-btn-green" data-st-act="approveall">Approve all ' + waiting + ' waiting</button> '
        + '<span class="sp-h4-note">Approves every saved line and brand that passes the copy rules. Unsaved edits are not included.</span></span>' : '';
    var week = S.weekly.slice().sort(function (a, b) { return DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (a.row || 0) - (b.row || 0); });
    return '<div class="st-wrap"><datalist id="stBrands">' + brands + '</datalist>'
      + '<div><h3 class="mk-h" style="margin:0">Deals page</h3>'
      + '<p class="sp-h4-note">What goes on greencrosscanna.com/deals besides the featured cards and vendor days. '
      + 'An approved line goes up on the next hourly run; until a line is approved, the page keeps showing what it shows now.</p>' + rules + all + '</div>'
      + (S.err ? '<div class="mk-warn">' + esc(S.err) + '</div>' : '') + (S.msg ? '<div class="mk-spec">' + esc(S.msg) + '</div>' : '')
      + '<section class="st-sec"><h4 class="mk-h" style="margin:0">Every week</h4>'
      + (week.length ? week.map(function (s) { return weekLineHtml(s, ctx); }).join('') : '<p class="hint">No weekly lines yet.</p>')
      + (ctx.canEdit ? '<span><button class="gx-btn" data-st-act="addweek">+ Add a weekly deal</button></span>' : '') + '</section>'
      + '<section class="st-sec"><h4 class="mk-h" style="margin:0">Brands and logos</h4>'
      + '<p class="sp-h4-note">Every card and weekly line on the page finds its logo here, by brand name or other spelling (other spellings come from Settings ▸ Brands).</p>'
      + S.vendors.slice().sort(function (a, b) { return String(a.brand).localeCompare(String(b.brand)); }).map(function (s) { return vendorHtml(s, ctx); }).join('')
      + (ctx.canEdit ? '<span><button class="gx-btn" data-st-act="addvendor">+ Add a brand</button></span>' : '') + '</section></div>';
  }

  function read(line) {
    var o = { key: line.dataset.stKey || '', kind: line.dataset.stKind };
    line.querySelectorAll('[data-f]').forEach(function (el) { o[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  }

  async function load(ctx) {
    if (S.loading) return;
    S.loading = true;
    try {
      var r = await ctx.call('siteDeals', {});
      S.ready = !!(r && r.ok && Array.isArray(r.weekly));
      if (S.ready) { S.weekly = r.weekly; S.vendors = r.vendors || []; S.approvers = r.approvers || S.approvers; }
    } catch (e) { S.err = String((e && e.message) || e); }
    S.loaded = true; S.loading = false;
    ctx.repaint();
  }

  function put(list, item) {
    var i = list.findIndex(function (x) { return x.key === item.key; });
    if (i >= 0) list[i] = item; else list.push(item);
  }

  async function act(name, line, btn, ctx) {
    S.err = ''; S.msg = '';
    try {
      if (name === 'addweek') { S.weekly.push({ key: '', kind: 'week', day: 'TUE', row: 1, brand: '', amount: '', text: '' }); return ctx.repaint(); }
      if (name === 'addvendor') { S.vendors.push({ key: '', kind: 'vendor', brand: '' }); return ctx.repaint(); }
      if (name === 'mclose') { S.mediaFor = null; return ctx.repaint(); }
      if (name === 'approveall') {
        if (!window.confirm('Approve every waiting line and brand for the deals page? They go up on the next hourly run.')) return;
        var a = await ctx.call('approveSiteDeals', {});
        S.loaded = false;
        S.msg = 'Approved ' + a.approved.length + '.' + (a.skipped.length ? ' Not approved, fix first: '
          + a.skipped.map(function (x) { return x.key + ' (' + x.problem + ')'; }).join('; ') + '.' : '') + ' They go up on the next hourly run.';
        var keep = S.msg;
        await load(ctx);
        S.msg = keep;
        return ctx.repaint();
      }
      if (name === 'save') {
        var it = read(line);
        var r = await ctx.call('saveSiteDeal', { item: JSON.stringify(it) });
        var list = it.kind === 'week' ? S.weekly : S.vendors;
        if (!it.key) { var i = list.findIndex(function (x) { return !x.key; }); if (i >= 0) list.splice(i, 1); }
        put(list, r.item);
        S.msg = r.problem ? 'Saved. Not going on the page yet: ' + r.problem + '.'
          : r.item.approved_by ? 'Saved and approved. It goes up on the next hourly run.' : 'Saved. It waits for Sky, Mike or Tawny to approve it.';
        return ctx.repaint();
      }
      if (name === 'remove') {
        if (!window.confirm('Take this line off the deals page? It comes off on the next hourly run.')) return;
        await ctx.call('removeSiteDeal', { key: line.dataset.stKey });
        S.weekly = S.weekly.filter(function (x) { return x.key !== line.dataset.stKey; });
        S.msg = 'Taken off. It leaves the page on the next hourly run.';
        return ctx.repaint();
      }
      if (name === 'pick' || name === 'drive') {
        var cur = read(line);
        S.mediaFor = { key: line.dataset.stKey, which: btn.dataset.stWhich, mode: name, q: (cur.brand || '').toLowerCase(), item: cur };
        S.media = null;
        ctx.repaint();
        if (name === 'pick') return act('msearch', null, null, ctx);
        return;
      }
      if (name === 'msearch') {
        var q = document.getElementById('stMediaQ');
        if (q) S.mediaFor.q = q.value;
        S.media = null; ctx.repaint();
        var m = await ctx.call('siteMedia', { q: S.mediaFor.q || 'logo' });
        S.media = m.files || [];
        return ctx.repaint();
      }
      if (name === 'mpick' || name === 'import') {
        var value = '';
        if (name === 'mpick') value = (S.media[+btn.dataset.stI] || {}).wix_image || '';
        else {
          var url = (document.getElementById('stDrive') || {}).value || '';
          var imp = await ctx.call('siteImportLogo', { url: url, which: S.mediaFor.which, brand: S.mediaFor.item.brand });
          if (imp.pending) { S.msg = imp.note; S.mediaFor = null; return ctx.repaint(); }
          value = imp.wix_image;
        }
        var target = S.vendors.filter(function (x) { return x.key === S.mediaFor.key; })[0];
        if (target) { Object.assign(target, S.mediaFor.item); target[S.mediaFor.which] = value; }
        S.mediaFor = null;
        S.msg = 'Logo picked. Save the brand to keep it.';
        return ctx.repaint();
      }
    } catch (e) { S.err = String((e && e.message) || e); ctx.repaint(); }
  }

  /* Draw into host. ctx = { call(action, params) → Promise of the engine's ok answer (throws otherwise),
     repaint(), user, canEdit, brands }. */
  function render(host, ctx) {
    css();
    if (!S.loaded) load(ctx);
    /* Keep what is typed and not saved across a repaint. */
    var typed = {};
    host.querySelectorAll('.st-line').forEach(function (l, i) { typed[i + '|' + l.dataset.stKey] = read(l); });
    host.innerHTML = html(ctx);
    host.querySelectorAll('.st-line').forEach(function (l, i) {
      var t = typed[i + '|' + l.dataset.stKey];
      if (!t) return;
      l.querySelectorAll('[data-f]').forEach(function (el) {
        if (el.type === 'hidden' || !(el.dataset.f in t)) return;
        if (el.type === 'checkbox') { if (!el.disabled) el.checked = !!t[el.dataset.f]; } else el.value = t[el.dataset.f];
      });
    });
    if (!host.__stWired) {
      host.__stWired = true;
      host.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-st-act]') : null;
        if (!b || !host.contains(b) || b.disabled) return;
        e.preventDefault();
        act(b.dataset.stAct, b.closest('.st-line'), b, host.__stCtx);
      });
    }
    host.__stCtx = ctx;
  }

  window.SpiffSite = { render: render, problemOf: problemOf, wixSrc: wixSrc, DAYS: DAYS };
})();
