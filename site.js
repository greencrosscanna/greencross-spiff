/* ─── The Deals page screen: the weekly lines and the brand tiles (Sky, 2026-11-02) ─────────────────
 * greencrosscanna.com/deals is filled from SPIFF and nobody edits it in Wix. Featured cards and vendor
 * days come from each program's marketing plan; THIS screen is the rest: the Tue–Sat schedule and the
 * brand logos. The engine's THE DEALS PAGE, PART 2 (apps-script/Code.gs) owns the rules; this only
 * draws them and sends what is typed.
 *
 * Lives in the Programs tab as a fourth view beside List / Calendar / Tasks, behind marketing.js's
 * switch (Sky, Mike and Tawny only, until it is flipped). The approve switch is the screen's word only:
 * the engine signs every approval with the session and ignores anyone who is not an approver.
 * None of these calls is hedged: a hedged write runs twice.
 *
 * Layout (Sky, 2026-11-03, "SPIFF Deals Page Editor" canvas): status counts that filter, weekly lines
 * grouped by day, brands as logo cards, and a preview of the weekly section as the site will show it. */
(function () {
  'use strict';
  var MK = function () { return window.SpiffMarketing || null; };
  var DAYS = ['TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'MON'];
  var DAY_NAMES = { TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday', MON: 'Monday' };
  var S = { loaded: false, loading: false, ready: true, weekly: [], vendors: [], approvers: ['sky', 'mike', 'tawny'],
            msg: '', err: '', media: null, mediaFor: null, busy: '', filter: 'all', q: '', uid: 0, typed: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  /* Every item gets a screen-only id, so what is typed survives a repaint even when a filter hides
     lines or a new line has no key yet. Never sent: read() collects [data-f] fields only. */
  function tag(s) { if (!s._uid) s._uid = 'u' + (++S.uid); return s; }
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
  function isApproved(s) { return S.approvers.indexOf(String(s.approved_by || '').toLowerCase()) >= 0; }
  /* new (never saved) | bad (cannot be approved) | ok (approved, on the page) | wait */
  function statusOf(s) {
    if (!s.key) return 'new';
    if (problemOf(s)) return 'bad';
    return isApproved(s) ? 'ok' : 'wait';
  }
  function pill(s) {
    var st = statusOf(s);
    if (st === 'new') return '<span class="st-pill st-new">Not saved yet</span>';
    if (st === 'bad') return '<span class="st-pill st-bad">Needs a fix</span>';
    if (st === 'ok') return '<span class="st-pill st-ok" title="Approved by ' + esc(s.approved_by) + '">On the page</span>';
    return '<span class="st-pill st-wait">Waiting for approval</span>';
  }
  function shown(s) { return S.filter === 'all' || !s.key || statusOf(s) === S.filter; }
  function vendorFor(brand) {
    var f = fold(brand);
    return f ? S.vendors.filter(function (v) { return fold(v.brand) === f; })[0] || null : null;
  }
  function thumb(brand) {
    var v = vendorFor(brand), src = v ? wixSrc(v.logo_wide) || wixSrc(v.logo) : '';
    return '<span class="st-thumb" aria-hidden="true">' + (src ? '<img src="' + esc(src) + '" alt="">'
      : '<span>' + esc(String(brand || '?').slice(0, 10).toUpperCase()) + '</span>') + '</span>';
  }
  var ICON = {
    plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
    out: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>',
    pic: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/></svg>'
  };

  function css() {
    if (document.getElementById('st-style')) return;
    var st = document.createElement('style');
    st.id = 'st-style';
    var MT = 'font-family:Montserrat,var(--gx-font,system-ui),sans-serif;';
    st.textContent = [
      '.st-wrap{display:flex;flex-direction:column;gap:16px}',
      '.st-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px}',
      '.st-title{margin:0;' + MT + 'font-weight:900;font-size:24px;letter-spacing:-.3px;text-transform:uppercase}',
      '.st-sub{margin:4px 0 0;max-width:640px;font-size:13px;color:var(--gx-text-dim)}',
      '.st-stats{display:flex;flex-wrap:wrap;gap:8px}',
      '.st-stat{flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid var(--gx-border);border-radius:10px;background:var(--gx-surface);color:var(--gx-text);font:inherit;text-align:left;cursor:pointer}',
      '.st-stat:hover{border-color:var(--gx-border-strong)}',
      '.st-stat.is-on{border-color:var(--st-c);background:var(--gx-surface-2)}',
      '.st-stat-l{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--st-c)}',
      '.st-stat-l::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--st-c)}',
      '.st-stat-n{' + MT + 'font-weight:800;font-size:24px;line-height:1}',
      '.st-rules{border:1px solid var(--gx-border);border-radius:10px;background:var(--gx-surface);font-size:13px}',
      '.st-rules summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:10px 14px;cursor:pointer;list-style:none}',
      '.st-rules summary::-webkit-details-marker{display:none}',
      '.st-rules summary b{color:var(--gx-gold)}',
      '.st-rules summary span{color:var(--gx-text-dim)}',
      '.st-rules ul{margin:0;padding:0 14px 12px 30px;color:var(--gx-text-dim);display:flex;flex-direction:column;gap:3px}',
      '.st-cols{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}',
      '.st-main{flex:999 1 600px;min-width:0;display:flex;flex-direction:column;gap:16px}',
      '.st-side{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:8px}',
      '.st-card{border:1px solid var(--gx-border);border-radius:12px;background:var(--gx-surface);overflow:hidden}',
      '.st-card-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;padding:12px 14px;border-bottom:1px solid var(--gx-border)}',
      '.st-h{margin:0;' + MT + 'font-weight:800;font-size:14px;letter-spacing:.5px;text-transform:uppercase}',
      '.st-note{font-size:12px;color:var(--gx-text-dim)}',
      '.st-day+.st-day{border-top:1px solid var(--gx-border)}',
      '.st-dayh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px 6px}',
      '.st-dayh h5{margin:0;' + MT + 'font-weight:900;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gx-text-dim)}',
      '.st-ghost{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--gx-text-dim);font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.st-ghost:hover{color:var(--gx-text);border-color:var(--gx-border-strong)}',
      '.st-empty{margin:0 14px 12px;padding:10px 12px;border:1px dashed var(--gx-border-strong);border-radius:8px;font-size:13px;color:var(--gx-text-mute)}',
      '.st-line{margin:0 10px 8px;padding:10px;border:1px solid var(--gx-border);border-radius:10px;background:var(--gx-surface-2);display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}',
      '.st-line.is-wait{border-color:var(--gx-gold-line)}',
      '.st-line.is-bad{border-color:rgba(239,68,68,.55);background:var(--gx-red-soft)}',
      '.st-line .sp-in{min-width:0}',
      '.st-line .st-row{width:52px}.st-line .st-amt{width:72px;text-align:center;font-weight:700}.st-line .st-brand{width:150px}.st-line .st-text{flex:1 1 220px;width:auto}.st-line .st-dsel{width:78px}',
      '.st-thumb{flex:none;width:60px;height:30px;border-radius:5px;background:#14181D;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.st-thumb img{width:56px;height:26px;object-fit:contain;display:block}',
      '.st-thumb span{color:#fff;' + MT + 'font-weight:800;font-size:9px;letter-spacing:.3px}',
      '.st-pill{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}',
      '.st-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.st-ok{background:var(--gx-green-soft);color:var(--gx-green)}',
      '.st-wait{background:rgba(212,168,71,.12);color:var(--gx-gold)}',
      '.st-bad{background:var(--gx-red-soft);color:var(--gx-red)}',
      '.st-new{background:var(--gx-surface-3);color:var(--gx-text-dim)}',
      '.st-sw{position:relative;flex:none;display:inline-flex;align-items:center;gap:8px;min-height:32px;font-size:13px;color:var(--gx-text-dim);cursor:pointer}',
      '.st-sw input{position:absolute;opacity:0;width:1px;height:1px;margin:0}',
      '.st-track{position:relative;flex:none;width:34px;height:20px;border-radius:999px;background:var(--gx-border-strong);transition:background .15s}',
      '.st-track::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--gx-text);transition:left .15s}',
      '.st-sw input:checked+.st-track{background:var(--gx-green)}',
      '.st-sw input:checked+.st-track::after{left:17px;background:var(--gx-green-ink,#06210f)}',
      '.st-sw input:focus-visible+.st-track{outline:2px solid var(--gx-green);outline-offset:2px}',
      '.st-sw input:disabled+.st-track{opacity:.35}',
      '.st-sw input:disabled~span:last-child{opacity:.6}',
      '.st-acts{display:flex;gap:6px;margin-left:auto}',
      '.st-prob{flex-basis:100%;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--gx-red)}',
      '.st-prob.is-new{color:var(--gx-text-dim)}',
      '.st-by{flex-basis:100%;font-size:12px;color:var(--gx-text-mute)}',
      '.st-search{width:200px}',
      '.st-brands{padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}',
      '.st-line.st-bcard{margin:0;padding:0;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:0;overflow:hidden}',
      '.st-bcard.is-open{grid-column:1/-1}',
      '.st-bwide{height:84px;background:#14181D;display:flex;align-items:center;justify-content:center;padding:10px 14px;box-sizing:border-box}',
      '.st-bwide img{max-width:100%;height:64px;object-fit:contain;display:block}',
      '.st-bempty{height:74px;margin:10px 10px 0;border:1px dashed var(--gx-border-strong);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12px;color:var(--gx-text-dim)}',
      '.st-bbody{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}',
      '.st-bname{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 8px}',
      '.st-bname .sp-in{flex:1 1 130px;min-width:0;font-weight:700}',
      '.st-blogos{display:flex;flex-wrap:wrap;gap:8px}',
      '.st-blogo{flex:1 1 100px;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--gx-text-mute)}',
      '.st-blogo img{width:40px;height:40px;object-fit:contain;background:#14181D;border-radius:6px}',
      '.st-blogo .st-bbtns{display:flex;gap:4px;flex-wrap:wrap}',
      '.st-bfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.st-media{display:flex;flex-wrap:wrap;gap:8px}',
      '.st-media button{border:1px solid var(--gx-border);background:var(--gx-surface);color:var(--gx-text);border-radius:8px;padding:4px;cursor:pointer;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:2px}',
      '.st-media img{width:80px;height:40px;object-fit:contain;background:#14181D;border-radius:4px}',
      '.st-pick{padding:10px 12px 12px;border-top:1px solid var(--gx-border);display:flex;flex-direction:column;gap:8px}',
      '.st-side-h{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.st-side-h h4{margin:0;' + MT + 'font-weight:800;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--gx-text-dim)}',
      '.st-side-h a{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;color:var(--gx-green);text-decoration:none}',
      '.st-prev{border:1px solid var(--gx-border);border-radius:12px;overflow:hidden;background:#F3F2F0;color:#14181D}',
      '.st-prev-h{background:#95D500;padding:12px 14px;' + MT + 'font-weight:900;font-size:22px;line-height:.95;letter-spacing:-.8px}',
      '.st-prev-b{padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.st-prev-d{display:flex;gap:8px;align-items:flex-start}',
      '.st-prev-d>b{flex:0 0 40px;padding-top:9px;' + MT + 'font-weight:900;font-size:16px;line-height:1}',
      '.st-prev-rows{flex:1 1 auto;min-width:0;background:#fff;border:1px solid #E2E2DF;border-radius:6px;overflow:hidden}',
      '.st-prev-r{display:flex;align-items:stretch}',
      '.st-prev-r+.st-prev-r{border-top:1px solid #E2E2DF}',
      '.st-prev-r.is-wait{opacity:.4}',
      '.st-prev-r .st-thumb{width:68px;height:auto;min-height:44px;border-radius:0}',
      '.st-prev-r .st-thumb img{width:60px;height:28px}',
      '.st-prev-t{flex:1 1 auto;min-width:0;padding:6px 10px;display:flex;align-items:center;gap:8px;' + MT + 'font-weight:700;font-size:12px;line-height:1.25}',
      '.st-prev-t strong{flex:none;font-weight:900;font-size:17px}',
      '.st-prev-none{padding:16px 12px;font-size:13px;color:#3C434B}',
      '@media (max-width:600px){.st-line .st-brand,.st-line .st-text{flex:1 1 100%;width:auto}.st-acts{margin-left:0}.st-search{width:100%}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function weekLineHtml(s, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var st = statusOf(s), p = problemOf(s);
    return '<div class="st-line' + (st === 'bad' ? ' is-bad' : st === 'wait' ? ' is-wait' : '') + '" data-st-key="' + esc(s.key) + '" data-st-uid="' + esc(s._uid) + '" data-st-kind="week">'
      + thumb(s.brand)
      + '<input class="sp-in st-brand" data-f="brand" list="stBrands" value="' + esc(s.brand) + '" placeholder="Brand" aria-label="Brand"' + ro + '>'
      + '<input class="sp-in st-amt" data-f="amount" value="' + esc(s.amount) + '" placeholder="$2" aria-label="Amount"' + ro + '>'
      + '<input class="sp-in st-text" data-f="text" value="' + esc(s.text) + '" placeholder="OFF all 10-packs" aria-label="What it is off"' + ro + '>'
      + '<select class="sp-in st-dsel" data-f="day" aria-label="Day" title="Day"' + ro + '>' + DAYS.map(function (d) {
          return '<option' + (d === s.day ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select>'
      + '<input class="sp-in st-row" data-f="row" type="number" min="1" max="9" value="' + esc(s.row || 1) + '" aria-label="Order within the day" title="Order within the day"' + ro + '>'
      + pill(s)
      + '<label class="st-sw" title="' + (mayApprove ? 'Approve this line for the website' : 'Only Sky, Mike or Tawny can approve') + '">'
      +   '<input type="checkbox" data-f="approve"' + (isApproved(s) ? ' checked' : '') + (mayApprove && ctx.canEdit ? '' : ' disabled') + '>'
      +   '<span class="st-track"></span><span>Approved</span></label>'
      + (ctx.canEdit ? '<span class="st-acts"><button class="gx-btn gx-btn-green" data-st-act="save">Save</button>'
          + (s.key ? '<button class="gx-btn" data-st-act="remove">Take off</button>' : '') + '</span>' : '')
      + (p && st !== 'ok' ? '<div class="st-prob' + (st === 'new' ? ' is-new' : '') + '">' + ICON.warn + '<span>' + esc(p.charAt(0).toUpperCase() + p.slice(1)) + '.</span></div>' : '')
      + (st === 'ok' ? '<div class="st-by">Approved by ' + esc(s.approved_by) + '</div>' : '')
      + '</div>';
  }

  function vendorHtml(s, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var st = statusOf(s), p = problemOf(s);
    var open = S.mediaFor && S.mediaFor.uid === s._uid;
    var wide = wixSrc(s.logo_wide), square = wixSrc(s.logo);
    var pic = function (f, label) {
      var src = wixSrc(s[f]);
      return '<span class="st-blogo"><span>' + label + '</span>'
        + (f === 'logo' && src ? '<img src="' + esc(src) + '" alt="' + esc(s.brand) + ' square logo">' : '')
        + (ctx.canEdit ? '<span class="st-bbtns"><button class="gx-btn" data-st-act="pick" data-st-which="' + f + '">Pick</button>'
          + '<button class="gx-btn" data-st-act="drive" data-st-which="' + f + '">From Drive</button></span>' : '')
        + '<input type="hidden" data-f="' + f + '" value="' + esc(s[f]) + '"></span>';
    };
    return '<div class="st-line st-bcard' + (open ? ' is-open' : '') + (st === 'bad' ? ' is-bad' : st === 'wait' ? ' is-wait' : '')
      + '" data-st-key="' + esc(s.key) + '" data-st-uid="' + esc(s._uid) + '" data-st-kind="vendor" data-st-name="' + esc(fold(s.brand)) + '">'
      + (wide || square ? '<div class="st-bwide"><img src="' + esc(wide || square) + '" alt="' + esc(s.brand) + ' logo"></div>'
          : '<div class="st-bempty">' + ICON.pic + '<span>No logo yet · wide is 1000 × 400</span></div>')
      + '<div class="st-bbody">'
      +   '<div class="st-bname"><input class="sp-in" data-f="brand" list="stBrands" value="' + esc(s.brand) + '" placeholder="Brand" aria-label="Brand"' + (s.key ? ' title="Key: ' + esc(s.key) + '"' : '') + ro + '>' + pill(s) + '</div>'
      +   '<div class="st-blogos">' + pic('logo_wide', 'Wide logo') + pic('logo', 'Square logo') + '</div>'
      +   '<input class="sp-in" data-f="menu_slug" value="' + esc(s.menu_slug) + '" placeholder="Menu slug (optional)" aria-label="Menu slug" title="The brand\'s name on the online menu, e.g. bobsled-extracts"' + ro + '>'
      +   (p && st !== 'ok' ? '<div class="st-prob' + (st === 'new' ? ' is-new' : '') + '">' + ICON.warn + '<span>' + esc(p.charAt(0).toUpperCase() + p.slice(1)) + '.</span></div>' : '')
      +   '<div class="st-bfoot"><label class="st-sw"><input type="checkbox" data-f="approve"' + (isApproved(s) ? ' checked' : '') + (mayApprove && ctx.canEdit ? '' : ' disabled') + '>'
      +     '<span class="st-track"></span><span>Approved</span></label>'
      +     (ctx.canEdit ? '<button class="gx-btn gx-btn-green" data-st-act="save">Save</button>' : '') + '</div>'
      + '</div>'
      + (open ? '<div class="st-pick">' + mediaHtml() + '</div>' : '')
      + '</div>';
  }

  function mediaHtml() {
    var m = S.mediaFor;
    if (!m) return '';
    if (m.mode === 'drive') {
      return '<span class="st-note">Paste the Drive link of the ' + (m.which === 'logo_wide' ? 'wide (1000 × 400)' : 'square (600 × 600)')
        + ' logo, from the brand\'s folder under Marketing ▸ Vendors. PNG, JPG or SVG, 500 KB max.</span>'
        + '<span><input class="sp-in" id="stDrive" style="width:min(420px,100%)" placeholder="https://drive.google.com/file/d/…"> '
        + '<button class="gx-btn gx-btn-green" data-st-act="import">Import</button> <button class="gx-btn" data-st-act="mclose">Cancel</button></span>';
    }
    var list = S.media;
    return '<span><input class="sp-in" id="stMediaQ" value="' + esc(m.q) + '" placeholder="Search Wix Media"> '
      + '<button class="gx-btn" data-st-act="msearch">Search</button> <button class="gx-btn" data-st-act="mclose">Cancel</button></span>'
      + (list === null ? '<span class="st-note">Searching…</span>'
        : !list.length ? '<span class="st-note">Nothing in Wix Media by that name.</span>'
        : '<div class="st-media">' + list.map(function (f, i) {
            return '<button data-st-act="mpick" data-st-i="' + i + '"><img src="' + esc(f.url || wixSrc(f.wix_image)) + '" alt=""><span>' + esc(f.name) + '</span></button>';
          }).join('') + '</div>');
  }

  /* The weekly section as the site will draw it once the waiting lines are approved: approved lines
     solid, waiting ones faded, lines that cannot be approved left out. */
  function previewHtml(week) {
    var groups = [];
    week.forEach(function (s) {
      var st = statusOf(s);
      if (st !== 'ok' && st !== 'wait') return;
      var g = groups[groups.length - 1];
      if (!g || g.day !== s.day) groups.push(g = { day: s.day, rows: [] });
      g.rows.push(s);
    });
    var body = groups.length ? groups.map(function (g) {
      return '<div class="st-prev-d"><b>' + esc(g.day) + '</b><div class="st-prev-rows">' + g.rows.map(function (s) {
        var text = String(s.text || ''), off = /^OFF\s/i.test(text);
        return '<div class="st-prev-r' + (statusOf(s) === 'wait' ? ' is-wait' : '') + '">' + thumb(s.brand)
          + '<span class="st-prev-t"><strong>' + esc(s.amount) + (off ? ' OFF' : '') + '</strong>' + esc(off ? text.replace(/^OFF\s+/i, '') : text) + '</span></div>';
      }).join('') + '</div></div>';
    }).join('') : '<p class="st-prev-none">No weekly deals yet.</p>';
    return '<aside class="st-side" aria-label="Preview of the weekly deals on the website">'
      + '<div class="st-side-h"><h4>On the site after the next update</h4>'
      + '<a href="https://www.greencrosscanna.com/deals" target="_blank" rel="noopener">Open live page ' + ICON.out + '</a></div>'
      + '<div class="st-prev"><div class="st-prev-h">EVERY WEEK</div><div class="st-prev-b">' + body + '</div></div>'
      + '<span class="st-note">Faded lines are waiting for approval. Until a line is approved, the page keeps showing what it shows now.</span>'
      + '</aside>';
  }

  function html(ctx) {
    if (!S.ready) return '<div class="mk-warn">The engine has not been updated yet, so the Deals page lines cannot load or save.</div>';
    if (!S.loaded) return '<p class="hint">Loading the deals page…</p>';
    S.weekly.forEach(tag); S.vendors.forEach(tag);
    var all = S.weekly.concat(S.vendors).filter(function (s) { return s.key; });
    var n = { all: all.length, ok: 0, wait: 0, bad: 0 };
    all.forEach(function (s) { n[statusOf(s)]++; });
    var mayApprove = S.approvers.indexOf(String(ctx.user || '').toLowerCase()) >= 0;
    var approveAll = ctx.canEdit && mayApprove && n.wait
      ? '<button class="gx-btn gx-btn-green" data-st-act="approveall" title="Approves every saved line and brand that passes the copy rules. Unsaved edits are not included.">'
        + ICON.check + ' Approve all ' + n.wait + ' waiting</button>' : '';
    var stat = function (key, label, color) {
      return '<button type="button" class="st-stat' + (S.filter === key ? ' is-on' : '') + '" style="--st-c:' + color + '" data-st-act="filter" data-st-filter="' + key + '" aria-pressed="' + (S.filter === key) + '">'
        + '<span class="st-stat-l">' + label + '</span><span class="st-stat-n">' + n[key] + '</span></button>';
    };
    var rules = '<details class="st-rules"><summary><b>OLCC copy rules</b><span>Straight discounts only, like “$2 off Grön on Tuesday”. Every line is checked before it can be approved.</span></summary><ul>'
      + '<li>Never BOGO, “buy one”, “free” cannabis or “with purchase”.</li>'
      + '<li>No “best”, “#1”, “lowest”, health claims or em-dashes.</li>'
      + '<li>No Green Cross house brands.</li>'
      + '<li>Only Sky, Mike or Tawny can approve. Anyone else\'s change takes the approval off.</li></ul></details>';
    var brands = (ctx.brands || []).map(function (b) { return '<option value="' + esc(b.display_name) + '">'; }).join('');
    var week = S.weekly.slice().sort(function (a, b) { return DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (a.row || 0) - (b.row || 0); });
    var FN = { all: 'All lines', ok: 'Showing what is on the page', wait: 'Showing what is waiting for approval', bad: 'Showing what needs a fix' };
    var dayBlocks = DAYS.map(function (d) {
      var lines = week.filter(function (s) { return s.day === d && shown(s); });
      var has = week.some(function (s) { return s.day === d; });
      if (!lines.length && (S.filter !== 'all' || (!has && d === 'MON'))) return '';
      return '<div class="st-day"><div class="st-dayh"><h5>' + DAY_NAMES[d] + '</h5>'
        + (ctx.canEdit ? '<button type="button" class="st-ghost" data-st-act="addweek" data-st-day="' + d + '">' + ICON.plus + ' Add a ' + DAY_NAMES[d] + ' deal</button>' : '') + '</div>'
        + (lines.length ? lines.map(function (s) { return weekLineHtml(s, ctx); }).join('') : '<p class="st-empty">No deal on ' + DAY_NAMES[d] + ' yet.</p>')
        + '</div>';
    }).join('');
    var vendors = S.vendors.filter(shown).sort(function (a, b) { return String(a.brand).localeCompare(String(b.brand)); });
    return '<div class="st-wrap"><datalist id="stBrands">' + brands + '</datalist>'
      + '<div class="st-head"><div><h3 class="st-title">Deals page</h3>'
      +   '<p class="st-sub">The weekly deals and brand logos on greencrosscanna.com/deals. Featured cards and vendor days come from each program. An approved line goes up on the next hourly update.</p></div>'
      +   approveAll + '</div>'
      + (S.err ? '<div class="mk-warn">' + esc(S.err) + '</div>' : '') + (S.msg ? '<div class="mk-spec">' + esc(S.msg) + '</div>' : '')
      + '<div class="st-stats" role="group" aria-label="Filter by status">'
      +   stat('all', 'All', 'var(--gx-text-dim)') + stat('ok', 'On the page', 'var(--gx-green)')
      +   stat('wait', 'Waiting for approval', 'var(--gx-gold)') + stat('bad', 'Needs a fix', 'var(--gx-red)') + '</div>'
      + rules
      + '<div class="st-cols"><div class="st-main">'
      +   '<section class="st-card"><div class="st-card-h"><h4 class="st-h">Every week</h4><span class="st-note">' + FN[S.filter] + '</span></div>'
      +     (dayBlocks || '<p class="st-empty" style="margin:12px 14px">Nothing here for this filter.</p>') + '</section>'
      +   '<section class="st-card"><div class="st-card-h"><div><h4 class="st-h">Brands and logos</h4>'
      +     '<span class="st-note">Every card and weekly line finds its logo here, by brand name or other spelling (other spellings come from Settings ▸ Brands).</span></div>'
      +     '<span style="display:flex;gap:8px;flex-wrap:wrap"><input class="sp-in st-search" id="stBrandQ" type="search" placeholder="Search brands" aria-label="Search brands" value="' + esc(S.q) + '">'
      +     (ctx.canEdit ? '<button class="gx-btn" data-st-act="addvendor">' + ICON.plus + ' Add a brand</button>' : '') + '</span></div>'
      +     '<div class="st-brands">' + (vendors.length ? vendors.map(function (s) { return vendorHtml(s, ctx); }).join('') : '<p class="st-empty" style="margin:0">No brands here for this filter.</p>') + '</div></section>'
      + '</div>' + previewHtml(week) + '</div></div>';
  }

  function read(line) {
    var o = { key: line.dataset.stKey || '', kind: line.dataset.stKind };
    line.querySelectorAll('[data-f]').forEach(function (el) { o[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  }
  function byUid(uid) { return S.weekly.concat(S.vendors).filter(function (x) { return x._uid === uid; })[0] || null; }
  /* The brand search hides cards in place, so the box keeps focus while typing. */
  function applySearch(host) {
    var q = fold(S.q);
    host.querySelectorAll('.st-bcard').forEach(function (c) { c.hidden = !!q && (c.dataset.stName || '').indexOf(q) < 0 && c.dataset.stKey !== ''; });
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

  function put(list, item, uid) {
    item._uid = uid;
    var i = list.findIndex(function (x) { return x._uid === uid || (item.key && x.key === item.key); });
    if (i >= 0) list[i] = item; else list.push(item);
  }

  async function act(name, line, btn, ctx) {
    S.err = ''; S.msg = '';
    try {
      if (name === 'filter') { S.filter = btn.dataset.stFilter || 'all'; return ctx.repaint(); }
      if (name === 'addweek') { S.filter = 'all'; S.weekly.push(tag({ key: '', kind: 'week', day: btn.dataset.stDay || 'TUE', row: 1, brand: '', amount: '', text: '' })); return ctx.repaint(); }
      if (name === 'addvendor') { S.filter = 'all'; S.vendors.push(tag({ key: '', kind: 'vendor', brand: '' })); return ctx.repaint(); }
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
        var it = read(line), uid = line.dataset.stUid;
        var r = await ctx.call('saveSiteDeal', { item: JSON.stringify(it) });
        put(it.kind === 'week' ? S.weekly : S.vendors, r.item, uid);
        line.remove();
        delete S.typed[uid];
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
        S.mediaFor = { uid: line.dataset.stUid, which: btn.dataset.stWhich, mode: name, q: (cur.brand || '').toLowerCase(), item: cur };
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
        var target = byUid(S.mediaFor.uid);
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
    /* Keep what is typed and not saved across a repaint, by the screen-only id. It is kept in S, not
       on the item, so a line a filter hides gets its typing back when it shows again, and the counts
       and preview go on describing what is SAVED. */
    host.querySelectorAll('.st-line').forEach(function (l) { S.typed[l.dataset.stUid] = read(l); });
    host.innerHTML = html(ctx);
    host.querySelectorAll('.st-line').forEach(function (l) {
      var t = S.typed[l.dataset.stUid];
      if (!t) return;
      l.querySelectorAll('[data-f]').forEach(function (el) {
        if (el.type === 'hidden' || !(el.dataset.f in t)) return;
        if (el.type === 'checkbox') { if (!el.disabled) el.checked = !!t[el.dataset.f]; } else el.value = t[el.dataset.f];
      });
    });
    applySearch(host);
    if (!host.__stWired) {
      host.__stWired = true;
      host.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-st-act]') : null;
        if (!b || !host.contains(b) || b.disabled) return;
        e.preventDefault();
        act(b.dataset.stAct, b.closest('.st-line'), b, host.__stCtx);
      });
      host.addEventListener('input', function (e) {
        if (e.target && e.target.id === 'stBrandQ') { S.q = e.target.value; applySearch(host); }
      });
    }
    host.__stCtx = ctx;
  }

  window.SpiffSite = { render: render, problemOf: problemOf, wixSrc: wixSrc, DAYS: DAYS };
})();
