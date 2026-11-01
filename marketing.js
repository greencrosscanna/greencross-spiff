/* ─── The Marketing section of a SPIFF program (SPIFF 2.0, phase 1) ──────────────────────────────
 *
 * What a vendor signed up for, and the dated tasks that follow from it. Ported from Mike and Tawny's
 * Green Cross 360 planner; the plan is docs/plans/marketing-section.md.
 *
 * THE RECORD HOLDS ONLY WHAT A PERSON DECIDED: what is picked, for which stores, the details typed,
 * what is done, and any date moved by hand. Tasks, due dates, overdue flags and compliance notes are
 * computed here on every read and never stored, so moving a program's window moves every date with
 * it. The engine's normalizeMarketing_ enforces that on the way to the sheet.
 *
 * THE SWITCH. Merging puts screens live, so everything this file draws shows only to the users in
 * PREVIEW_USERS until VISIBLE_TO_EVERYONE is flipped. It is a curtain and not a lock: the engine's
 * edit-role check is what protects a save.
 *
 * NOTHING HERE TOUCHES PAY. The incentive item reads the program's own payout and writes nothing, and
 * sales results are SPIFF's own measurements rather than anything typed in this section.
 */
(function (root) {
  'use strict';

  var VISIBLE_TO_EVERYONE = false;
  var PREVIEW_USERS = ['sky'];

  function isVisible(session) {
    if (VISIBLE_TO_EVERYONE) return !!session;
    return !!session && PREVIEW_USERS.indexOf(String(session.user || '').toLowerCase()) >= 0;
  }

  var OWNERS = { INV: 'Tawny', DIR: 'Mike', MGR: 'Managers', VEN: 'Vendor' };

  var SECTIONS = [
    ['cust', 'Customers', 'What customers experience'],
    ['emp', 'Employees', 'Budtenders learn, wear and win'],
    ['mkt', 'Marketing', 'Email, text, social, online'],
    ['store', 'In-Store', 'What customers see walking in']
  ];

  /* A task is [id, owner, text, anchor, offset days, flags]. Anchor 's' counts from the start of the
     window and 'e' from its end. `each` fans out one task per store. `on` names the item's date
     field: once somebody types that date, the task follows it.

     THE IDS ARE THE STORED KEY. done and due are keyed on them, so a task can be reworded or moved
     around this list freely, but renaming an id orphans every tick already made against it. */
  var CORE = [
    ['core.menu', 'INV', 'Marketing menu filled in with the rep', 's', -21],
    ['core.plan', 'INV', 'Send the vendor plan to the rep', 's', -7],
    ['core.managers', 'DIR', 'Send managers the summary for this vendor', 's', -7],
    ['core.wrapup', 'DIR', 'Wrap-up notes on what ran', 'e', 10],
    ['core.results', 'INV', 'Share results with vendor; talk next cycle', 'e', 14]
  ];

  /* f is [type, key, label, options]. c is the Oregon compliance note shown on the item's card. */
  var ITEMS = {
    edu: { t: 'Budtender education', s: 'Training video and/or visit, plus samples', sec: 'emp',
      f: [['sel', 'format', 'Training format', ['Training video (recommended)', 'In person', 'Video plus in person']],
          ['date', 'date', 'In-person date']],
      c: 'Confirm how samples are handled and documented. Training content makes no health or medical claims.',
      k: [['edu.video', 'DIR', 'Collect training video and talking points from vendor', 's', -14],
          ['edu.samples', 'INV', 'Receive product samples (medical and non-medical)', 's', -10],
          ['edu.send', 'DIR', 'Send education materials to store managers', 's', -7],
          ['edu.train', 'MGR', 'Budtenders complete the training', 's', -1, { each: 1 }]] },
    shirts: { t: 'Staff swag (shirts / hats)', s: 'Staff wear the brand for the window', sec: 'emp',
      f: [['text', 'items', 'Items and sizes']],
      c: 'Branded apparel only. No health claims, nothing that appeals to minors.',
      k: [['shirts.receive', 'INV', 'Receive shirts / hats from vendor', 's', -10],
          ['shirts.send', 'INV', 'Distribute apparel to stores', 's', -5],
          ['shirts.wear', 'MGR', 'Staff wearing brand for the window', 's', 0, { each: 1 }]] },
    incentive: { t: 'Budtender incentive (SPIFF)', s: 'The payout set on this program', sec: 'emp', lock: 1,
      f: [],
      c: 'Confirm the incentive structure is within OLCC rules before staff hear about it.',
      k: [['incentive.terms', 'INV', 'Confirm incentive terms and store goals in writing', 's', -14],
          ['incentive.relay', 'DIR', 'Relay incentive details to managers and staff', 's', -7],
          ['incentive.cards', 'DIR', 'Order gift cards for payday', 'e', 1]] },
    prizes: { t: 'Other employee prizes', s: 'An extra prize beyond the SPIFF', sec: 'emp',
      f: [['text', 'prize', 'Prize and how it is won']],
      c: 'Prizes are not cannabis.',
      k: [['prizes.confirm', 'INV', 'Confirm the extra prize with vendor', 's', -14],
          ['prizes.award', 'DIR', 'Announce winner and present the prize', 'e', 2]] },
    email: { t: 'Email blast', s: 'One send to our list', sec: 'mkt',
      f: [['date', 'date', 'Send date']],
      c: 'Review copy and offer before sending. Prohibited under Oregon rules: BOGO, tiered spend thresholds, tied discounts, cannabis gift-with-purchase.',
      k: [['email.creative', 'DIR', 'Receive email creative and offer from vendor', 's', -14],
          ['email.review', 'DIR', 'Compliance review and proof approval', 's', -7],
          ['email.send', 'DIR', 'Send email blast', 's', 0, { on: 'date' }],
          ['email.stats', 'DIR', 'Record opens and clicks', 'e', 3]] },
    sms: { t: 'Text blast', s: 'One SMS send', sec: 'mkt',
      f: [['sel', 'cost', 'Cost model', ['Vendor credit', 'Vendor pays per text', 'We cover it']],
          ['date', 'date', 'Send date']],
      c: 'Review copy, offer and opt-in / opt-out wording. Same Oregon offer rules as email.',
      k: [['sms.cost', 'INV', 'Agree on cost model and vendor credit', 's', -14],
          ['sms.approve', 'DIR', 'Approve text copy and send time', 's', -5],
          ['sms.send', 'DIR', 'Send text blast', 's', 0, { on: 'date' }]] },
    social: { t: 'Social media', s: 'Posts on our accounts', sec: 'mkt',
      f: [['sel', 'maker', 'Who makes the posts', ['We do', 'Vendor supplies', 'Both']],
          ['text', 'dates', 'Post dates']],
      c: 'No health claims, nothing that appeals to minors, and each platform’s cannabis rules.',
      k: [['social.media', 'DIR', 'Receive vendor media, handles and tags', 's', -10],
          ['social.draft', 'DIR', 'Draft posts and get vendor approval', 's', -5],
          ['social.publish', 'DIR', 'Publish posts', 's', 0],
          ['social.links', 'DIR', 'Send post links to vendor', 'e', 2]] },
    ecom: { t: 'Online menu feature', s: 'Featured placement on the online menu', sec: 'mkt',
      f: [],
      c: 'Review the placement and any offer shown with it.',
      k: [['ecom.set', 'INV', 'Set featured placement on the online menu', 's', -1],
          ['ecom.remove', 'INV', 'Remove featured placement', 'e', 1]] },
    vday: { t: 'Vendor day', s: 'Rep in store, best 4–7 PM', sec: 'cust',
      f: [['date', 'date', 'Vendor day date'], ['text', 'time', 'Time (4–7 PM recommended)']],
      c: 'Review the vendor’s planned games and discounts before the day. Same Oregon offer rules.',
      k: [['vday.slots', 'INV', 'Set vendor day dates and slots per store', 's', -14],
          ['vday.confirm', 'INV', 'Confirm rep, dates and times with vendor', 's', -10],
          ['vday.relay', 'DIR', 'Relay schedule to managers', 's', -7],
          ['vday.held', 'MGR', 'Vendor day held', 's', 0, { each: 1, on: 'date' }],
          ['vday.photos', 'DIR', 'Collect photos and video', 'e', 3]] },
    raffle: { t: 'Customer raffle', s: 'Entries in store, one winner', sec: 'cust',
      f: [['text', 'prize', 'Prize'], ['date', 'date', 'Draw date']],
      c: 'Entry is not tied to a purchase and the prize is not cannabis.',
      k: [['raffle.rules', 'INV', 'Confirm raffle rules are OLCC-compliant', 's', -10],
          ['raffle.prize', 'INV', 'Receive the raffle prize', 's', -7],
          ['raffle.run', 'MGR', 'Run raffle and collect entries', 's', 0, { each: 1 }],
          ['raffle.draw', 'DIR', 'Draw winner and tell the vendor', 'e', 2, { on: 'date' }]] },
    swag: { t: 'Customer swag', s: 'Giveaways at the counter', sec: 'cust',
      f: [['text', 'items', 'Items and quantity']],
      c: 'Swag must not be cannabis, and nothing that appeals to minors.',
      k: [['swag.receive', 'INV', 'Receive customer swag; count it', 's', -10],
          ['swag.send', 'INV', 'Distribute swag to stores', 's', -5],
          ['swag.report', 'MGR', 'Report swag remaining', 'e', 1, { each: 1 }]] },
    case: { t: 'Featured case', s: 'Case / shelf placement', sec: 'store',
      f: [['text', 'notes', 'Case notes']],
      c: 'Shelf talkers: no health claims, nothing that appeals to minors.',
      k: [['case.space', 'INV', 'Confirm case space for each store', 's', -10],
          ['case.set', 'MGR', 'Featured placement set', 's', -1, { each: 1 }],
          ['case.reset', 'MGR', 'Case back to normal', 'e', 1, { each: 1 }]] },
    signage: { t: 'Signage & readerboard', s: 'Clings, flags, readerboard', sec: 'store',
      f: [],
      c: 'Review signs before they go up.',
      k: [['signage.receive', 'INV', 'Receive printed signage', 's', -7],
          ['signage.approve', 'DIR', 'Approve readerboard copy', 's', -5],
          ['signage.up', 'MGR', 'Signage up', 's', 0, { each: 1 }],
          ['signage.down', 'MGR', 'Signage down', 'e', 1, { each: 1 }]] },
    led: { t: 'LED sign board', s: 'Brand content on the LED', sec: 'store',
      f: [],
      c: 'Review LED content before it runs.',
      k: [['led.art', 'DIR', 'Receive and approve LED artwork', 's', -10],
          ['led.load', 'MGR', 'Load brand content', 's', -1, { each: 1 }],
          ['led.remove', 'MGR', 'Remove brand content', 'e', 1, { each: 1 }]] },
    counter: { t: 'Countertop ads', s: 'Checkout / daily buzz ads', sec: 'store',
      f: [],
      c: 'Review checkout ads.',
      k: [['counter.art', 'DIR', 'Receive and approve ad artwork', 's', -10],
          ['counter.place', 'DIR', 'Place countertop ads', 's', -2]] },
    bags: { t: 'Branded exit bags', s: 'Vendor-supplied bags', sec: 'store',
      f: [],
      c: 'Same read for bag artwork.',
      k: [['bags.receive', 'INV', 'Receive bags; count them', 's', -10],
          ['bags.report', 'MGR', 'Report bags remaining', 'e', 1, { each: 1 }]] }
  };

  /* ── Dates are TEXT, counted in whole days. UTC arithmetic only so a clock change cannot move one. */
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  function toUtc(s) { var a = String(s).split('-'); return Date.UTC(+a[0], +a[1] - 1, +a[2]); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function addDays(s, n) {
    if (!ISO.test(String(s || ''))) return '';
    var d = new Date(toUtc(s) + n * 864e5);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function daysBetween(a, b) { return Math.round((toUtc(b) - toUtc(a)) / 864e5); }
  function niceDate(s) {
    if (!ISO.test(String(s || ''))) return '';
    return new Date(toUtc(s)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  }

  /* ── Reading a program ───────────────────────────────────────────────────────────────────────── */
  function planOf(p) {
    var m = (p && p.marketing_json) || {};
    return { stores: m.stores || null, sel: m.sel || {}, skip: m.skip || {}, d: m.d || {},
             done: m.done || {}, due: m.due || {}, events: m.events || [], notes: m.notes || '' };
  }
  /* A program nobody has planned stays out of every count. Every program has core tasks on paper, so
     without this the 25 closed records and any program already running would all read as overdue
     for marketing nobody ever signed up for. */
  function hasPlan(p) { return !!(p && p.marketing_json); }

  function isOn(p, id) {
    if (ITEMS[id] && ITEMS[id].lock) return true;
    return !!planOf(p).sel[id];
  }
  function pickedItems(p) {
    return Object.keys(ITEMS).filter(function (id) { return !ITEMS[id].lock && isOn(p, id); });
  }

  /* Where marketing runs: what was chosen, else the program's own stores, else every store. */
  function storesOf(p, opts) {
    var plan = planOf(p);
    if (plan.stores && plan.stores.length) return plan.stores.slice();
    if (p && p.stores_json && p.stores_json.length) return p.stores_json.slice();
    return ((opts && opts.stores) || []).slice();
  }

  /* Every task as one row per store, so done state and date overrides have one key each:
     `task_id`, or `task_id@store_id` for a task each store does on its own. A date moved by hand
     wins, then the item's own typed date, then the window. */
  function tasksOf(p, opts) {
    var plan = planOf(p), stores = storesOf(p, opts), out = [];
    function push(itemId, row) {
      var flags = row[5] || {};
      var anchor = row[3] === 's' ? p.start_date : p.end_date;
      var typed = flags.on && itemId && plan.d[itemId] ? plan.d[itemId][flags.on] : '';
      var planned = ISO.test(String(typed || '')) ? typed : addDays(anchor, row[4]);
      (flags.each ? stores : [null]).forEach(function (store) {
        var key = store ? row[0] + '@' + store : row[0];
        var moved = plan.due[key] || plan.due[row[0]] || '';
        var done = plan.done[key] || null;
        out.push({ key: key, id: row[0], item: itemId, own: row[1], owner: OWNERS[row[1]] || row[1],
                   text: row[2], store: store, each: !!flags.each, due: moved || planned,
                   planned: planned, moved: !!moved, done: done });
      });
    }
    CORE.forEach(function (row) { push(null, row); });
    Object.keys(ITEMS).forEach(function (id) {
      if (isOn(p, id)) ITEMS[id].k.forEach(function (row) { push(id, row); });
    });
    return out;
  }

  /* One line per task, however many stores it fans out to. A task is late if ANY store is late, and
     counts once: six stores missing "Signage up" is one thing to chase, not six. */
  function groupTasks(tasks) {
    var by = {}, order = [];
    tasks.forEach(function (t) {
      var g = by[t.id];
      if (!g) {
        g = by[t.id] = { id: t.id, item: t.item, own: t.own, owner: t.owner, text: t.text, each: t.each,
                         rows: [], open: 0, due: '', moved: false, key: t.key };
        order.push(g);
      }
      g.rows.push(t);
      if (!t.done) g.open++;
      if (t.moved) g.moved = true;
    });
    order.forEach(function (g) {
      var dates = g.rows.filter(function (r) { return !g.open || !r.done; })
        .map(function (r) { return r.due; }).filter(Boolean).sort();
      g.due = dates[0] || '';
    });
    return order.sort(function (a, b) {
      if (a.due === b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    });
  }

  function phaseOf(g, p) {
    if (!g.due || !p.start_date || !p.end_date) return 'undated';
    if (g.due < p.start_date) return 'before';
    return g.due > p.end_date ? 'after' : 'during';
  }

  function lateOf(p, today, opts) {
    return groupTasks(tasksOf(p, opts)).filter(function (g) { return g.open && g.due && g.due < today; });
  }
  function nextOf(p, today, opts) {
    return groupTasks(tasksOf(p, opts)).filter(function (g) { return g.open && g.due >= today; })[0] || null;
  }
  function overdueTotal(programs, today, opts) {
    return (programs || []).reduce(function (n, p) {
      return n + (hasPlan(p) ? lateOf(p, today, opts).length : 0);
    }, 0);
  }

  /* The incentive follows the program. Nothing is typed, so there is no second copy of a payout. */
  function incentiveLine(p) {
    var pay = (p && p.payout_json) || {};
    var model = pay.model || (p && p.payout_type) || 'flat';
    var amount = Number(pay.amount != null ? pay.amount : pay.per_unit);
    if (!amount) return 'Set the payout in the Calculator above.';
    var money = '$' + amount.toLocaleString('en-US');
    return model === 'per_unit' ? money + ' per unit sold' : 'Flat ' + money + ' per budtender who hits their goal';
  }

  /* ── Changing a plan: small operations, not the whole record ─────────────────────────────────────
     Each click sends only what it changed, as [section, key, value]. Writes ride on GET here, and the
     live engine refuses a URL somewhere past 10,000 characters (measured 2026-11-01), which a whole
     plan with every task ticked would pass on the last day of a program. It also means two people
     ticking different tasks cannot overwrite each other. The engine's applyMarketingDelta_ applies
     the same operations to what is stored; a test holds the two together. */
  var OP_SECTIONS = { stores: 1, sel: 1, skip: 1, d: 1, done: 1, due: 1, events: 1, notes: 1 };
  function applyOps(plan, ops) {
    var out = JSON.parse(JSON.stringify(plan || {}));
    (ops || []).forEach(function (op) {
      var section = op[0], key = op[1], value = op[2];
      if (!OP_SECTIONS[section]) return;
      if (key === null || key === undefined) {
        if (value === null || value === undefined) delete out[section]; else out[section] = value;
        return;
      }
      if (!/^[a-z]/.test(String(key))) return;
      var map = out[section] && typeof out[section] === 'object' ? out[section] : (out[section] = {});
      if (value === null || value === undefined) delete map[key]; else map[key] = value;
    });
    return out;
  }

  function toggleItemOp(p, id) {
    if (!ITEMS[id] || ITEMS[id].lock) return [];
    return [['sel', id, isOn(p, id) ? null : true]];
  }
  /* The last store cannot be turned off: an empty list means "the program's stores", so the chip
     would spring back on, which reads as a broken button. */
  function toggleStoreOp(p, store, opts) {
    var now = storesOf(p, opts), i = now.indexOf(store);
    if (i >= 0 && now.length === 1) return [];
    if (i >= 0) now.splice(i, 1); else now.push(store);
    return [['stores', null, now]];
  }
  function detailOp(p, item, field, value) {
    var cur = JSON.parse(JSON.stringify(planOf(p).d[item] || {}));
    if (value === '' || value == null) delete cur[field]; else cur[field] = value;
    return [['d', item, cur]];
  }
  function doneOp(key, on, by, at) { return [['done', key, on ? { by: by, at: at } : null]]; }
  function dueOp(key, day) { return [['due', key, day || null]]; }

  /* One save at a time, in order. A retried or slow reply cannot land out of sequence, and clicks
     made while one is in flight go together in the next call. */
  function makeSaver(send, onState) {
    var pending = [], busy = false;
    function pump() {
      if (busy || !pending.length) return Promise.resolve();
      busy = true;
      var id = pending[0].id, batch = [];
      while (pending.length && pending[0].id === id && batch.length < 40) batch.push(pending.shift().op);
      onState('saving', null, id);
      return Promise.resolve().then(function () { return send(id, batch); }).then(function (res) {
        busy = false;
        onState(pending.length ? 'saving' : 'saved', res, id);
        return pump();
      }, function (err) {
        busy = false;
        pending = [];
        onState('failed', err, id);
      });
    }
    return {
      add: function (id, ops) {
        (ops || []).forEach(function (op) { pending.push({ id: id, op: op }); });
        return pump();
      }
    };
  }

  /* ── Drawing ─────────────────────────────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* The one line on a running card or a draft row. */
  function listLine(p, today, opts) {
    if (!hasPlan(p)) return '<div class="mk-mline"><b>Marketing</b><span class="mk-chip">not set up yet</span></div>';
    var late = lateOf(p, today, opts), nx = nextOf(p, today, opts), n = pickedItems(p).length;
    var soon = nx && daysBetween(today, nx.due) <= 3;
    return '<div class="mk-mline"><b>Marketing</b>'
      + '<span class="mk-chip">' + n + ' add-on' + (n === 1 ? '' : 's') + '</span>'
      + (late.length ? '<span class="mk-chip late">' + late.length + ' overdue</span>' : '')
      + (nx ? '<span class="mk-chip' + (soon ? ' soon' : '') + '">Next: ' + esc(nx.text) + ' &middot; '
            + esc(nx.owner) + ' &middot; ' + esc(niceDate(nx.due)) + '</span>' : '')
      + '</div>';
  }

  /* What the collapsed section says. */
  function foldNote(p, today, opts) {
    var n = pickedItems(p).length, late = lateOf(p, today, opts).length;
    if (!hasPlan(p)) return 'not set up yet';
    return n + ' add-on' + (n === 1 ? '' : 's') + (late ? ' · ' + late + ' overdue' : '');
  }

  function dueHtml(g, today) {
    if (!g.open) return '<span class="mk-due" title="Due ' + esc(niceDate(g.due)) + '">Done</span>';
    if (!g.due) return '<span class="mk-due">Needs a window</span>';
    var d = daysBetween(today, g.due), cls = '', lbl;
    if (d < 0) { lbl = (-d) + ' day' + (d === -1 ? '' : 's') + ' late'; cls = 'late'; }
    else if (d === 0) { lbl = 'today'; cls = 'soon'; }
    else if (d <= 3) { lbl = 'in ' + d + ' day' + (d === 1 ? '' : 's'); cls = 'soon'; }
    else lbl = niceDate(g.due);
    return '<span class="mk-due ' + cls + '" title="' + esc(niceDate(g.due)) + '">' + esc(lbl) + '</span>';
  }

  function taskHtml(g, p, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var due = dueHtml(g, ctx.today);
    if (ctx.canEdit && ctx.moving === g.id) {
      due = '<span class="mk-move"><input type="date" data-mk-due="' + esc(g.id) + '" value="' + esc(g.due) + '">'
          + (g.moved ? '<button type="button" class="mk-link" data-mk-unmove="' + esc(g.id) + '">Back to the plan date</button>' : '')
          + '</span>';
    } else if (ctx.canEdit) {
      due = '<button type="button" class="mk-link" data-mk-moving="' + esc(g.id) + '" title="Move this date">' + due + '</button>';
    }
    var item = g.item ? ITEMS[g.item].t : '';
    var box = g.each ? '<span></span>'
      : '<input type="checkbox" data-mk-task="' + esc(g.key) + '"' + (g.open ? '' : ' checked') + ro + '>';
    var stores = !g.each ? '' : '<div class="mk-task-stores">' + g.rows.map(function (r) {
      return '<button type="button" class="mk-store-tick' + (r.done ? ' on' : '') + '" data-mk-task="' + esc(r.key) + '"'
        + ' aria-pressed="' + (r.done ? 'true' : 'false') + '"' + ro + '>' + esc(ctx.storeName(r.store)) + '</button>';
    }).join('') + '</div>';
    var sub = [];
    if (item) sub.push(esc(item));
    if (g.each) sub.push('each store: ' + (g.rows.length - g.open) + ' of ' + g.rows.length);
    if (g.moved && g.open) sub.push('date moved by hand');
    return '<div class="mk-task' + (g.open ? '' : ' done') + '">' + box
      + '<span class="tx">' + esc(g.text) + (sub.length ? '<small>' + sub.join(' · ') + '</small>' : '') + stores + '</span>'
      + '<span class="mk-own o-' + esc(g.own) + '">' + esc(g.owner) + '</span>' + due + '</div>';
  }

  function fieldHtml(item, f, plan, ctx) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var val = (plan.d[item] || {})[f[1]];
    var data = ' data-mk-item="' + esc(item) + '" data-mk-field="' + esc(f[1]) + '"';
    if (f[0] === 'sel') {
      return '<label class="mk-fld">' + esc(f[2]) + '<select' + data + ro + '><option value="">Choose&hellip;</option>'
        + f[3].map(function (o) {
            return '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>';
          }).join('') + '</select></label>';
    }
    return '<label class="mk-fld">' + esc(f[2]) + '<input type="' + (f[0] === 'date' ? 'date' : 'text') + '"' + data
      + ' value="' + esc(val == null ? '' : val) + '"' + ro + '></label>';
  }

  /* The whole section for one program. ctx: { today, canEdit, engineReady, stores:[{store_id,name}],
     storeName(id), moving }. */
  function sectionHtml(p, ctx) {
    var plan = planOf(p), opts = { stores: ctx.stores.map(function (s) { return s.store_id; }) };
    var on = storesOf(p, opts), ro = ctx.canEdit ? '' : ' disabled';

    var picker = SECTIONS.map(function (sec) {
      return '<div class="mk-sec"><h5>' + esc(sec[1]) + '</h5><p>' + esc(sec[2]) + '</p>'
        + Object.keys(ITEMS).filter(function (id) { return ITEMS[id].sec === sec[0]; }).map(function (id) {
            var it = ITEMS[id], live = isOn(p, id);
            return '<button type="button" class="mk-opt' + (live ? ' on' : '') + (it.lock ? ' lock' : '') + '" data-mk-pick="' + esc(id) + '"'
              + ' aria-pressed="' + (live ? 'true' : 'false') + '"' + (it.lock ? ' disabled' : ro) + '>'
              + '<span class="box"></span><span>' + esc(it.t)
              + '<small>' + esc(it.lock ? 'Set by the program’s payout' : it.s) + '</small></span></button>';
          }).join('') + '</div>';
    }).join('');

    var chips = ctx.stores.map(function (s) {
      return '<button type="button" class="' + (on.indexOf(s.store_id) >= 0 ? 'on' : '') + '" data-mk-store="' + esc(s.store_id) + '"' + ro + '>' + esc(s.name) + '</button>';
    }).join('');

    var cards = Object.keys(ITEMS).filter(function (id) { return isOn(p, id); }).map(function (id) {
      var it = ITEMS[id];
      var body = it.lock
        ? '<p class="mk-sub mk-incentive">' + esc(incentiveLine(p)) + '. Payout, goals and stores come from the Calculator above; sales results are SPIFF’s own measurements.</p>'
        : it.f.map(function (f) { return fieldHtml(id, f, plan, ctx); }).join('');
      return '<div class="mk-item"><h6>' + esc(it.t) + '</h6>' + body + '<div class="mk-comp">' + esc(it.c) + '</div></div>';
    }).join('');

    var groups = groupTasks(tasksOf(p, opts));
    var open = groups.filter(function (g) { return g.open; }).length;
    var phases = [['before', 'Before it starts'], ['during', 'While it runs'], ['after', 'After it ends'], ['undated', 'No date yet']];
    var tasks = phases.map(function (ph) {
      var rows = groups.filter(function (g) { return phaseOf(g, p) === ph[0]; });
      if (!rows.length) return '';
      return '<div class="mk-phase">' + esc(ph[1]) + '<span>' + rows.length + '</span></div>'
        + rows.map(function (g) { return taskHtml(g, p, ctx); }).join('');
    }).join('');

    return (ctx.engineReady ? '' : '<div class="mk-warn">The engine has not been updated yet, so nothing here can save. It shows what the section will do.</div>')
      + '<div class="mk-card"><h3 class="mk-h">What is ' + esc(p.vendor || 'this vendor') + ' in for?</h3>'
      + '<p class="mk-sub">Tick what the vendor signed up for. The tasks and dates below fill in on their own.</p>'
      + '<div class="mk-grid4">' + picker + '</div>'
      + '<h5 class="mk-stores-h">Which stores?</h5><div class="mk-stores">' + chips + '</div></div>'
      + '<div class="mk-card"><h3 class="mk-h">Details</h3>'
      + '<p class="mk-sub">Only what’s needed for the items picked above. Each one carries its Oregon compliance check.</p>'
      + '<div class="mk-items">' + cards + '</div></div>'
      + '<div class="mk-card"><div class="mk-row2"><div><h3 class="mk-h">Tasks</h3>'
      + '<p class="mk-sub mk-tight">Dates count from the window. Move the window and every date moves with it.</p></div>'
      + '<span class="mk-pill">' + open + ' open of ' + groups.length + '</span></div>' + tasks + '</div>'
      + '<div class="mk-status" data-mk-status role="status"></div>';
  }

  /* Clicks and edits for one mounted section, delegated so a repaint keeps working. */
  function wire(host, api) {
    if (host.__mkWired) return;
    host.__mkWired = true;
    host.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled || !host.contains(t)) return;
      var p = api.program();
      if (!p) return;
      if (t.dataset.mkPick) return api.apply(toggleItemOp(p, t.dataset.mkPick));
      if (t.dataset.mkStore) return api.apply(toggleStoreOp(p, t.dataset.mkStore, api.opts()));
      if (t.dataset.mkMoving) return api.moving(t.dataset.mkMoving);
      if (t.dataset.mkUnmove) return api.apply(dueOp(t.dataset.mkUnmove, null));
      if (t.dataset.mkTask) return api.tick(t.dataset.mkTask, !planOf(p).done[t.dataset.mkTask]);
    });
    host.addEventListener('change', function (e) {
      var t = e.target, p = api.program();
      if (!p || !t.dataset) return;
      if (t.dataset.mkTask) return api.tick(t.dataset.mkTask, t.checked);
      if (t.dataset.mkDue) return api.apply(dueOp(t.dataset.mkDue, t.value));
      if (t.dataset.mkItem) return api.apply(detailOp(p, t.dataset.mkItem, t.dataset.mkField, t.value));
    });
  }

  /* ── PHASE 2: the Calendar and Tasks views, and penciled brands ──────────────────────────────────
     A pencil holds a slot for a brand that has not signed up. It is NOT a program: it has no tasks, no
     kiosk card and no pay, and it lives in its own engine tab that nothing paying anybody reads. This
     file only draws pencils and builds the operations; the engine stores them. */
  function shortDate(s) {
    if (!ISO.test(String(s || ''))) return '';
    return new Date(toUtc(s)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  }
  function dow(s) { return new Date(toUtc(s)).getUTCDay(); }
  function monthStart(today, offset) {
    var a = String(today).split('-'), d = new Date(Date.UTC(+a[0], +a[1] - 1 + (offset || 0), 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-01';
  }
  function hueOf(s) {
    var h = 0, t = String(s || '');
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
    return h;
  }

  /* Bars: a program with a window, and every pencil. Programs take the top lanes so the official
     schedule reads as one line and pencils stack beneath it. */
  function barsOf(programs, pencils) {
    function byStart(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }
    var bars = (programs || []).filter(function (p) {
      return ISO.test(String(p.start_date || '')) && ISO.test(String(p.end_date || '')) && p.end_date >= p.start_date;
    }).map(function (p) {
      return { id: p.program_id, label: p.vendor || p.program_name || 'Program', start: p.start_date, end: p.end_date,
               kind: p.status === 'active' ? 'run' : p.status === 'closed' ? 'done' : 'draft' };
    }).sort(byStart);
    var pens = (pencils || []).filter(function (x) {
      return ISO.test(String(x.start_date || '')) && ISO.test(String(x.end_date || '')) && x.end_date >= x.start_date;
    }).map(function (x) {
      return { id: x.pencil_id, label: x.brand, start: x.start_date, end: x.end_date, kind: 'pencil' };
    }).sort(byStart);
    return bars.concat(pens);
  }
  function assignLanes(bars) {
    var lanes = [];
    bars.forEach(function (b) {
      var l = 0;
      while (lanes[l] && lanes[l].some(function (o) { return o.start <= b.end && o.end >= b.start; })) l++;
      (lanes[l] = lanes[l] || []).push(b);
      b.lane = l;
    });
    return bars;
  }

  /* What else is running or penciled in that window. Warns; it never blocks. */
  function overlapNames(programs, pencils, start, end, skipId) {
    var names = [];
    (programs || []).forEach(function (p) {
      if (p.status !== 'closed' && p.start_date && p.end_date && p.start_date <= end && p.end_date >= start) names.push(p.vendor || p.program_name);
    });
    (pencils || []).forEach(function (x) {
      if (x.pencil_id !== skipId && x.start_date <= end && x.end_date >= start) names.push(x.brand + ' (penciled)');
    });
    return names;
  }
  function overlapHtml(programs, pencils, start, end, skipId) {
    var o = start && end ? overlapNames(programs, pencils, start, end, skipId) : [];
    return o.length ? '<div class="mk-warn">Also in this period: ' + esc(o.join(', ')) + '.</div>' : '';
  }

  function weekHtml(ws, mo, bars, ctx) {
    var we = addDays(ws, 6), h = '<div class="mk-wk"><div class="bg">', i;
    for (i = 0; i < 7; i++) {
      var d = addDays(ws, i), out = +d.slice(5, 7) !== mo;
      h += '<button type="button" tabindex="-1" aria-label="Pencil a brand around ' + esc(shortDate(d)) + '" data-mk-day="' + d + '"'
        + ' class="' + (out ? 'out ' : '') + (d === ctx.today ? 'today' : '') + '"' + (ctx.canEdit && !out ? '' : ' disabled') + '></button>';
    }
    h += '</div>';
    for (i = 0; i < 7; i++) {
      var d2 = addDays(ws, i), inMonth = +d2.slice(5, 7) === mo;
      h += '<div class="dn" style="grid-column:' + (i + 1) + (inMonth ? '' : ';visibility:hidden') + '">' + (+d2.slice(8, 10)) + '</div>';
    }
    bars.forEach(function (b) {
      if (b.end < ws || b.start > we) return;
      var s = Math.max(0, daysBetween(ws, b.start)), e = Math.min(6, daysBetween(ws, b.end));
      var cls = 'mk-vb ' + b.kind + (b.start >= ws ? ' l' : '') + (b.end <= we ? ' r' : '');
      var act = b.kind === 'pencil' ? 'data-mk-pencil="' + esc(b.id) + '"' : 'data-mk-open="' + esc(b.id) + '"';
      var word = b.kind === 'pencil' ? 'Penciled, not official' : b.kind === 'run' ? 'Running' : b.kind === 'done' ? 'Closed' : 'Draft';
      h += '<button type="button" class="' + cls + '" ' + act + ' style="--h:' + hueOf(b.label) + ';grid-column:' + (s + 1) + '/' + (e + 2) + ';grid-row:' + (2 + b.lane) + '"'
        + ' title="' + esc(b.label + ' · ' + word + ' · ' + shortDate(b.start) + ' to ' + shortDate(b.end)) + '">'
        + (b.kind === 'pencil' ? '&#9998; ' : '') + esc(b.label) + '</button>';
    });
    return h + '</div>';
  }

  /* Three months, as whole weeks, with one bar per program across the days of each week it spans.
     ctx: { today, canEdit, offset }. */
  function calendarHtml(programs, pencils, ctx) {
    var offset = ctx.offset || 0, months = [0, 1, 2].map(function (n) { return monthStart(ctx.today, offset + n); });
    var first = months[0], gridStart = addDays(first, -dow(first));
    var lastM = months[2], lastD = addDays(monthStart(lastM, 1), -1);
    var gridEnd = addDays(lastD, 6 - dow(lastD));
    var bars = assignLanes(barsOf(programs, pencils).filter(function (b) { return b.end >= gridStart && b.start <= gridEnd; }));
    var legend = '<div class="mk-legend"><span><i class="lg run"></i>Running</span><span><i class="lg draft"></i>Draft</span>'
      + '<span><i class="lg done"></i>Closed</span><span><i class="lg pencil"></i>Penciled, not official</span></div>';
    var nav = '<span class="mk-seg"><button type="button" data-mk-nav="-1" aria-label="Earlier">&lsaquo;</button>'
      + '<button type="button" data-mk-nav="0">Today</button><button type="button" data-mk-nav="1" aria-label="Later">&rsaquo;</button></span>';
    var body = months.map(function (m) {
      var mo = +m.slice(5, 7), ws = addDays(m, -dow(m)), weeks = '', lastDay = addDays(monthStart(m, 1), -1);
      while (ws <= lastDay) { weeks += weekHtml(ws, mo, bars, ctx); ws = addDays(ws, 7); }
      var label = new Date(toUtc(m)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
      return '<div class="mk-month"><h3>' + esc(label) + '</h3><div class="mk-dow">'
        + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (d) { return '<span>' + d + '</span>'; }).join('')
        + '</div>' + weeks + '</div>';
    }).join('');
    return '<div class="mk-row2"><h3 class="mk-h" style="margin:0">Calendar</h3><div class="mk-row2 mk-acts">' + nav
      + (ctx.canEdit ? '<button type="button" class="gx-btn gx-btn-green" data-mk-act="penadd">&#9998; Pencil a brand</button>' : '') + '</div></div>'
      + legend + '<p class="mk-sub">' + (ctx.canEdit ? 'Click an empty day to pencil a brand there. ' : '') + 'Click a bar to open it.</p>'
      + '<div class="mk-cal-scroll"><div class="mk-cal">' + body + '</div></div>';
  }

  /* ── Tasks across every program, grouped by who owns them ──────────────────────────────────────
     Open tasks only, from programs that have a marketing plan and are not closed. The same derived
     tasks as the program screen, so a date moved there is moved here. */
  function openTasksAcross(programs, opts) {
    var out = [];
    (programs || []).forEach(function (p) {
      if (!hasPlan(p) || p.status === 'closed') return;
      groupTasks(tasksOf(p, opts)).forEach(function (g) { if (g.open) out.push({ p: p, g: g }); });
    });
    return out;
  }
  function tasksAcrossHtml(programs, ctx) {
    var opts = { stores: ctx.stores.map(function (s) { return s.store_id; }) };
    var rows = openTasksAcross(programs, opts), ro = ctx.canEdit ? '' : ' disabled';
    var owners = ['INV', 'DIR', 'MGR', 'VEN'];
    var seg = '<span class="mk-seg"><button type="button" data-mk-owner=""' + (ctx.owner ? '' : ' class="is-on"') + '>Everyone</button>'
      + owners.slice(0, 3).map(function (o) {
          return '<button type="button" data-mk-owner="' + o + '"' + (ctx.owner === o ? ' class="is-on"' : '') + '>' + esc(OWNERS[o]) + '</button>';
        }).join('') + '</span>';
    var shown = rows.filter(function (r) { return !ctx.owner || r.g.own === ctx.owner; });
    var groups = owners.map(function (o) {
      var mine = shown.filter(function (r) { return r.g.own === o; }).sort(function (a, b) {
        if (a.g.due === b.g.due) return 0;
        if (!a.g.due) return 1;
        if (!b.g.due) return -1;
        return a.g.due < b.g.due ? -1 : 1;
      });
      if (!mine.length) return '';
      return '<div class="mk-phase">' + esc(OWNERS[o]) + '<span>' + mine.length + '</span></div>' + mine.map(function (r) {
        var g = r.g, p = r.p, sub = [esc(p.vendor || p.program_name)];
        if (g.item) sub.push(esc(ITEMS[g.item].t));
        if (g.each) sub.push('each store: ' + (g.rows.length - g.open) + ' of ' + g.rows.length);
        var pid = esc(p.program_id);
        var box = g.each ? '<span></span>'
          : '<input type="checkbox" data-mk-xtask="' + esc(g.key) + '" data-mk-prog="' + pid + '"' + ro + ' aria-label="Mark done">';
        var stores = !g.each ? '' : '<div class="mk-task-stores">' + g.rows.map(function (t) {
          return '<button type="button" class="mk-store-tick' + (t.done ? ' on' : '') + '" data-mk-xtask="' + esc(t.key) + '" data-mk-prog="' + pid + '"'
            + ' aria-pressed="' + (t.done ? 'true' : 'false') + '"' + ro + '>' + esc(ctx.storeName(t.store)) + '</button>';
        }).join('') + '</div>';
        return '<div class="mk-task">' + box + '<span class="tx">' + esc(g.text) + '<small>' + sub.join(' · ') + '</small>' + stores + '</span>'
          + '<button type="button" class="mk-link" data-mk-open="' + pid + '" title="Open this program">Open</button>' + dueHtml(g, ctx.today) + '</div>';
      }).join('');
    }).join('');
    return '<div class="mk-row2"><div><h3 class="mk-h">Open tasks, every program</h3>'
      + '<p class="mk-sub mk-tight">Soonest first within each person. Tick one off here or on its program.</p></div>' + seg + '</div>'
      + '<div class="mk-card">' + (groups || '<p class="mk-sub">Nothing open.</p>') + '</div>';
  }

  /* ── Penciled brands ─────────────────────────────────────────────────────────────────────────── */
  function pencilListHtml(pencils, ctx) {
    if (!pencils || !pencils.length) return '';
    return '<div class="mk-label">Penciled <span>' + pencils.length + ' holding a slot, not official</span></div>'
      + '<div class="mk-rows mk-pen-rows">' + pencils.slice().sort(function (a, b) { return a.start_date < b.start_date ? -1 : 1; }).map(function (x) {
          var past = x.start_date <= ctx.today;
          return '<div class="mk-row" data-mk-pencil="' + esc(x.pencil_id) + '" tabindex="0" role="button">'
            + '<div><div class="n">&#9998; ' + esc(x.brand) + '</div><div class="s">' + esc(niceDate(x.start_date)) + ' &rarr; ' + esc(niceDate(x.end_date)) + '</div></div>'
            + '<div class="s">' + esc(x.note || '') + '</div>'
            + '<span class="mk-pill mk-pen-pill">' + (past ? 'STARTED, NOT LOCKED' : 'PENCILED') + '</span></div>';
        }).join('') + '</div>';
  }

  function periodOptions(periods, selected, useEnd) {
    return periods.map(function (q) {
      var v = useEnd ? q.end : q.start;
      return '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + esc(shortDate(q.start) + ' – ' + shortDate(q.end)) + '</option>';
    }).join('');
  }
  function periodAround(periods, day) {
    var hit = null;
    periods.forEach(function (q) { if (day && q.start <= day && q.end >= day) hit = q; });
    return hit || periods[0];
  }

  /* ctx: { periods:[{start,end}] ascending, programs, pencils, day, error } */
  function pencilFormHtml(ctx) {
    var q = periodAround(ctx.periods, ctx.day);
    return '<h3 class="mk-h">Pencil a brand</h3><p class="mk-sub">Holds the slot on the calendar. It stays unofficial until someone locks it in: no tasks, nothing on kiosks, nothing in pay.</p>'
      + '<label class="mk-fld">Brand<input id="mkPfBrand" type="text" maxlength="80" placeholder="Brand name"></label>'
      + '<div class="mk-2col"><label class="mk-fld">First pay period<select id="mkPfFirst" data-mk-pf>' + periodOptions(ctx.periods, q.start, false) + '</select></label>'
      + '<label class="mk-fld">Last pay period<select id="mkPfLast" data-mk-pf>' + periodOptions(ctx.periods, q.end, true) + '</select></label></div>'
      + '<label class="mk-fld">Note (optional)<input id="mkPfNote" type="text" maxlength="300" placeholder="For example: waiting on their budget"></label>'
      + '<div id="mkPfWarn">' + (ctx.error ? '<div class="mk-warn">' + esc(ctx.error) + '</div>' : '') + overlapHtml(ctx.programs, ctx.pencils, q.start, q.end) + '</div>'
      + '<div class="mk-dlg-act"><button type="button" class="gx-btn gx-btn-green" data-mk-act="pensave">Pencil it in</button>'
      + '<button type="button" class="gx-btn" data-mk-act="dlgclose">Cancel</button></div>';
  }

  /* A slot that has started is not activated or moved: it says so, and offers new dates to lock in. */
  function pencilDetailHtml(x, ctx) {
    var past = x.start_date <= ctx.today, h = '';
    h += '<h3 class="mk-h">&#9998; ' + esc(x.brand) + '</h3><p class="mk-sub">Penciled for ' + esc(shortDate(x.start_date)) + ' – ' + esc(shortDate(x.end_date))
      + ' by ' + esc(x.created_by || 'someone') + (x.created_at ? ' on ' + esc(shortDate(x.created_at.slice(0, 10))) : '') + '. Not official yet.</p>';
    if (x.note) h += '<p class="mk-note">' + esc(x.note) + '</p>';
    var win = '';
    if (past) {
      var fut = ctx.periods.filter(function (q) { return q.start > ctx.today; });
      var span = 1;
      ctx.periods.forEach(function (q, i) { if (q.start === x.start_date) ctx.periods.forEach(function (r, j) { if (r.end === x.end_date) span = j - i + 1; }); });
      var firstIdx = fut.length ? ctx.periods.indexOf(fut[0]) : 0, lastIdx = Math.min(ctx.periods.length - 1, firstIdx + Math.max(1, span) - 1);
      h += '<div class="mk-warn">This slot has already started. It has not been activated and will not be. Lock it in with new dates, or release it.</div>';
      win = '<div class="mk-2col"><label class="mk-fld">New first pay period<select id="mkLkFirst">' + periodOptions(ctx.periods, ctx.periods[firstIdx].start, false) + '</select></label>'
        + '<label class="mk-fld">New last pay period<select id="mkLkLast">' + periodOptions(ctx.periods, ctx.periods[lastIdx].end, true) + '</select></label></div>';
    }
    h += overlapHtml(ctx.programs, ctx.pencils, x.start_date, x.end_date, x.pencil_id) + win;
    h += '<div id="mkPfWarn">' + (ctx.error ? '<div class="mk-warn">' + esc(ctx.error) + '</div>' : '') + '</div>';
    h += ctx.canEdit
      ? '<div class="mk-dlg-act"><button type="button" class="gx-btn gx-btn-green" data-mk-act="penlock" data-mk-id="' + esc(x.pencil_id) + '">Lock it in</button>'
        + '<button type="button" class="gx-btn" data-mk-act="penrelease" data-mk-id="' + esc(x.pencil_id) + '">Release the slot</button>'
        + '<button type="button" class="gx-btn" data-mk-act="dlgclose">Close</button></div>'
        + '<p class="mk-sub" style="margin:12px 0 0">Locking in makes this a draft program with no payout set yet. Its marketing tasks and dates start from there.</p>'
      : '<div class="mk-dlg-act"><button type="button" class="gx-btn" data-mk-act="dlgclose">Close</button></div><p class="mk-sub" style="margin:12px 0 0">Sign in as an editor to lock it in or release it.</p>';
    return h;
  }

  /* Clicks for the Calendar, Tasks and pencil dialog, delegated so a repaint keeps working. */
  function wireViews(host, api) {
    if (host.__mkViewsWired) return;
    host.__mkViewsWired = true;
    host.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button,[data-mk-pencil],[data-mk-open],[data-mk-view]') : null;
      if (!t || t.disabled || !host.contains(t)) return;
      var d = t.dataset;
      if (d.mkView) return api.view(d.mkView);
      if (d.mkNav !== undefined) return api.nav(+d.mkNav);
      if (d.mkOwner !== undefined) return api.owner(d.mkOwner);
      if (d.mkXtask) return api.tick(d.mkProg, d.mkXtask, t.tagName === 'INPUT' ? t.checked : !t.classList.contains('on'));
      if (d.mkDay) return api.penAdd(d.mkDay);
      if (d.mkAct) return api.act(d.mkAct, d.mkId || '');
      if (d.mkPencil) return api.pencil(d.mkPencil);
      if (d.mkOpen) return api.open(d.mkOpen);
    });
    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.mkXtask && t.type === 'checkbox') return api.tick(t.dataset.mkProg, t.dataset.mkXtask, t.checked);
      if (t.dataset.mkPf !== undefined) return api.pfChange();
    });
  }

  var api = {
    shortDate: shortDate, barsOf: barsOf, assignLanes: assignLanes, overlapNames: overlapNames, overlapHtml: overlapHtml,
    calendarHtml: calendarHtml, openTasksAcross: openTasksAcross, tasksAcrossHtml: tasksAcrossHtml,
    pencilListHtml: pencilListHtml, pencilFormHtml: pencilFormHtml, pencilDetailHtml: pencilDetailHtml,
    wireViews: wireViews, monthStart: monthStart,
    isVisible: isVisible, SECTIONS: SECTIONS, ITEMS: ITEMS, CORE: CORE, OWNERS: OWNERS,
    addDays: addDays, daysBetween: daysBetween, planOf: planOf, hasPlan: hasPlan, isOn: isOn,
    pickedItems: pickedItems, storesOf: storesOf, tasksOf: tasksOf, groupTasks: groupTasks,
    phaseOf: phaseOf, lateOf: lateOf, nextOf: nextOf, overdueTotal: overdueTotal,
    incentiveLine: incentiveLine, applyOps: applyOps, toggleItemOp: toggleItemOp,
    toggleStoreOp: toggleStoreOp, detailOp: detailOp, doneOp: doneOp, dueOp: dueOp,
    makeSaver: makeSaver, listLine: listLine, foldNote: foldNote, sectionHtml: sectionHtml, wire: wire
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpiffMarketing = api;
})(this);
