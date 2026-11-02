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
  /* Sign-in names as GX Core's roster holds them (app_roster for spiff, checked 2026-11-02). Mike
     runs every blast cycle from the Tasks view, Tawny sets the deals. */
  var PREVIEW_USERS = ['sky', 'mike', 'tawny'];

  function isVisible(session) {
    if (VISIBLE_TO_EVERYONE) return !!session;
    return !!session && PREVIEW_USERS.indexOf(String(session.user || '').toLowerCase()) >= 0;
  }

  var OWNERS = { INV: 'Tawny', DIR: 'Mike', SKY: 'Sky', MGR: 'Managers', VEN: 'Vendor' };
  /* Who a task can be handed to (Sky, 2026-11-02: these three only), and the owner code each one
     shows as. The engine's MKT_PEOPLE_ holds their addresses and the same three names. */
  var PEOPLE = { tawny: 'INV', mike: 'DIR', sky: 'SKY' };

  var SECTIONS = [
    ['cust', 'Customers', 'What customers experience'],
    ['emp', 'Employees', 'Budtenders learn, wear and win'],
    ['mkt', 'Marketing', 'Email, text, social, online'],
    ['store', 'In-Store', 'What customers see walking in']
  ];

  /* A task is [id, owner, text, anchor, offset days, flags]. Anchor 's' counts from the start of the
     window and 'e' from its end. `each` fans out one task per store. `on` names the item's date
     field: once somebody types that date, the task follows it. `unless` [field, value] drops the
     task while that detail holds that value. On an item marked `blast`, every 's' task counts back
     from the item's typed send date instead of the window's start. `vendor` marks a task only a
     vendor program has, which a holiday send leaves out.

     THE IDS ARE THE STORED KEY. done and due are keyed on them, so a task can be reworded or moved
     around this list freely, but renaming an id orphans every tick already made against it. */
  var CORE = [
    ['core.menu', 'INV', 'Marketing menu filled in with the rep', 's', -21],
    ['core.plan', 'INV', 'Send the vendor plan to the rep', 's', -7],
    ['core.managers', 'DIR', 'Send managers the summary for this vendor', 's', -7],
    ['core.wrapup', 'DIR', 'Wrap-up notes on what ran', 'e', 10],
    ['core.results', 'INV', 'Share results with vendor; talk next cycle', 'e', 14]
  ];

  /* The blast cycle (Sky, 2026-11-02). Send day is a Monday: the deal is locked the Wednesday
     before, copy and the Dutchie draft are ready Thursday, Sky approves the proofs at the Friday L10.
     These come once per program when an email or a text blast is picked, never twice for both, and
     count back from the earliest typed send date, else the window's start. */
  var BLAST = [
    ['blast.deal', 'INV', 'Deal and timeline set with the vendor, locked', 's', -5],
    ['blast.copy', 'DIR', 'Copy and Dutchie draft ready (with Sky and Claude)', 's', -4]
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
    /* Sky approves all customer copy, so the proof tasks are Mike's to send and tick once Sky has
       approved at the Friday L10; there is no separate Sky task. A blank "who makes the creative"
       keeps the creative task, which is how every plan saved before the field read. */
    email: { t: 'Email blast', s: 'One send to our list', sec: 'mkt', blast: 1,
      f: [['sel', 'maker', 'Who makes the creative', ['We do', 'Vendor supplies']],
          ['date', 'date', 'Send date']],
      c: 'Review copy and offer before sending. Prohibited under Oregon rules: BOGO, tiered spend thresholds, tied discounts, cannabis gift-with-purchase.',
      k: [['email.creative', 'DIR', 'Receive email creative and offer from vendor', 's', -14, { unless: ['maker', 'We do'], vendor: 1 }],
          ['email.review', 'DIR', 'Send email proof to Sky Thursday; tick when Sky approves at the Friday L10', 's', -3],
          ['email.send', 'DIR', 'Send at 11 AM, then check emails sent vs planned', 's', 0, { on: 'date' }],
          ['email.stats', 'DIR', 'Record opens and clicks', 'e', 3]] },
    sms: { t: 'Text blast', s: 'One SMS send', sec: 'mkt', blast: 1,
      f: [['sel', 'cost', 'Cost model', ['Vendor credit', 'Vendor pays per text', 'We cover it']],
          ['date', 'date', 'Send date']],
      c: 'Review copy, offer and opt-in / opt-out wording. Same Oregon offer rules as email.',
      k: [['sms.cost', 'INV', 'Agree on cost model and vendor credit', 's', -14, { vendor: 1 }],
          ['sms.approve', 'DIR', 'Send text proof to Sky Thursday; tick when Sky approves at the Friday L10', 's', -3],
          ['sms.send', 'DIR', 'Send at 11 AM', 's', 0, { on: 'date' }]] },
    social: { t: 'Social media', s: 'Posts on our accounts', sec: 'mkt',
      f: [['sel', 'maker', 'Who makes the posts', ['We do', 'Vendor supplies', 'Both']]],
      list: { kind: 'date', label: 'Post dates', add: '+ Add a post date' },
      c: 'No health claims, nothing that appeals to minors, and each platform’s cannabis rules.',
      k: [['social.media', 'DIR', 'Receive vendor media, handles and tags', 's', -10],
          ['social.draft', 'DIR', 'Draft posts and get vendor approval', 's', -5],
          ['social.publish', 'DIR', 'Publish posts', 's', 0, { byDate: 1 }],
          ['social.links', 'DIR', 'Send post links to vendor', 'e', 2]] },
    ecom: { t: 'Online menu feature', s: 'Featured placement on the online menu', sec: 'mkt',
      f: [],
      c: 'Review the placement and any offer shown with it.',
      k: [['ecom.set', 'INV', 'Set featured placement on the online menu', 's', -1],
          ['ecom.remove', 'INV', 'Remove featured placement', 'e', 1]] },
    /* Several days, each at one store (or every store), are kept in the plan's own `vdays` list rather
       than in `d`. A plan saved before that holds one day as d.vday {date, time}; vdaysOf reads it. */
    vday: { t: 'Vendor day', s: 'Rep in store, best 4–7 PM', sec: 'cust', days: 1,
      f: [],
      c: 'Review the vendor’s planned games and discounts before the day. Same Oregon offer rules.',
      k: [['vday.slots', 'INV', 'Set vendor day dates and slots per store', 's', -14],
          ['vday.confirm', 'INV', 'Confirm rep, dates and times with vendor', 's', -10],
          ['vday.relay', 'DIR', 'Relay schedule to managers', 's', -7],
          ['vday.held', 'MGR', 'Vendor day held', 's', 0, { each: 1, vdays: 1 }],
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
      f: [],
      list: { kind: 'stores', label: 'Cases', add: '+ Add a case', ph: 'Which case, and what goes in it' },
      c: 'Shelf talkers: no health claims, nothing that appeals to minors.',
      k: [['case.space', 'INV', 'Confirm case space for each store', 's', -10],
          ['case.set', 'MGR', 'Featured placement set', 's', -1, { each: 1, rowStores: 1 }],
          ['case.reset', 'MGR', 'Case back to normal', 'e', 1, { each: 1, rowStores: 1 }]] },
    signage: { t: 'Signage & readerboard', s: 'Clings, flags, readerboard', sec: 'store',
      f: [],
      list: { kind: 'text', label: 'Signs', add: '+ Add a sign', ph: 'e.g. Window cling, readerboard copy' },
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
             done: m.done || {}, due: m.due || {}, events: m.events || [], vdays: m.vdays || [],
             rows: m.rows || {}, own: m.own || {}, notes: m.notes || '' };
  }

  /* An item's own list (post dates, signs, cases), as [{date?, text?, stores?}]. */
  function rowsOf(p, item) {
    var l = planOf(p).rows[item];
    return Array.isArray(l) ? l.map(function (r) {
      return { date: r.date || '', text: r.text || '', stores: Array.isArray(r.stores) ? r.stores.slice() : [] };
    }) : [];
  }

  /* The vendor days, as [{store, date, time}]. An empty store means every store on the plan. */
  function vdaysOf(p) {
    var plan = planOf(p);
    if (plan.vdays.length) return plan.vdays.map(function (v) { return { store: v.store || '', date: v.date || '', time: v.time || '' }; });
    var old = plan.d.vday || {};
    return old.date || old.time ? [{ store: '', date: old.date || '', time: old.time || '' }] : [];
  }
  /* A program nobody has planned stays out of every count. Every program has core tasks on paper, so
     without this the 25 closed records and any program already running would all read as overdue
     for marketing nobody ever signed up for. */
  function hasPlan(p) {
    var m = p && p.marketing_json;
    if (!m) return false;
    /* A vendor files link alone is not a plan: every new program gets one automatically. */
    return Object.keys(m).some(function (k) {
      if (k === 'v') return false;
      if (k === 'd') return Object.keys(m.d || {}).some(function (i) { return i !== 'files'; });
      var x = m[k];
      return Array.isArray(x) ? x.length > 0 : x && typeof x === 'object' ? Object.keys(x).length > 0 : !!x;
    });
  }

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
    function sendDay(itemId) {
      var day = (plan.d[itemId] || {}).date;
      return ISO.test(String(day || '')) ? day : '';
    }
    function push(itemId, row, from) {
      var flags = row[5] || {};
      if (flags.unless && itemId && (plan.d[itemId] || {})[flags.unless[0]] === flags.unless[1]) return;
      if (flags.vendor && p.holiday) return;
      var start = from || (itemId && ITEMS[itemId].blast && sendDay(itemId)) || p.start_date;
      var anchor = row[3] === 's' ? start : p.end_date;
      var typed = flags.on && itemId && plan.d[itemId] ? plan.d[itemId][flags.on] : '';
      var planned = ISO.test(String(typed || '')) ? typed : addDays(anchor, row[4]);
      /* A reassignment is per task, for every store and date it fans out to. */
      var person = PEOPLE[plan.own[row[0]]] ? plan.own[row[0]] : '';
      var own = person ? PEOPLE[person] : row[1];
      function emit(store, key, day, on) {
        var moved = plan.due[key] || plan.due[row[0]] || '';
        out.push({ key: key, id: row[0], item: itemId, own: own, owner: OWNERS[own] || own, defOwn: row[1], assigned: person,
                   text: row[2], store: store, each: !!flags.each || !!(flags.byDate && day), due: moved || on,
                   planned: on, moved: !!moved, done: plan.done[key] || null, day: day || '' });
      }
      /* One "held" row per vendor day per store, due on that day. A second day at the same store gets
         `.2` on its key so each has its own tick. With no dated day yet, every store waits on the window. */
      var days = flags.vdays ? vdaysOf(p).filter(function (v) { return ISO.test(String(v.date || '')); }) : [];
      if (days.length) {
        var seen = {};
        /* List order, not date order: changing a date must not hand one day's tick to another. */
        days.forEach(function (v) {
          (v.store ? [v.store] : stores).forEach(function (store) {
            seen[store] = (seen[store] || 0) + 1;
            emit(store, row[0] + '@' + store + (seen[store] > 1 ? '.' + seen[store] : ''), v.date, v.date);
          });
        });
        return;
      }
      /* One tick per post date, keyed on the date so removing one never moves another's tick. */
      var dates = flags.byDate ? rowsOf(p, itemId).map(function (r) { return r.date; })
        .filter(function (d, i, a) { return ISO.test(d) && a.indexOf(d) === i; }).sort() : [];
      if (dates.length) {
        dates.forEach(function (d) { emit(null, row[0] + '@' + d, d, d); });
        return;
      }
      /* Featured case: only the stores that have a case, once any case names a store. */
      var where = stores;
      if (flags.rowStores) {
        var named = [];
        rowsOf(p, itemId).forEach(function (r) { r.stores.forEach(function (s) { if (named.indexOf(s) < 0) named.push(s); }); });
        if (named.length) where = stores.filter(function (s) { return named.indexOf(s) >= 0; })
          .concat(named.filter(function (s) { return stores.indexOf(s) < 0; }));
      }
      (flags.each ? where : [null]).forEach(function (store) {
        emit(store, store ? row[0] + '@' + store : row[0], '', planned);
      });
    }
    /* A holiday send is the blast cycle alone: no program tasks, no incentive, nothing vendor-only. */
    if (!p.holiday) CORE.forEach(function (row) { push(null, row); });
    var blasts = Object.keys(ITEMS).filter(function (id) { return ITEMS[id].blast && isOn(p, id); });
    if (blasts.length) {
      var first = blasts.map(sendDay).filter(Boolean).sort()[0] || '';
      BLAST.forEach(function (row) { push(null, row, first); });
    }
    Object.keys(ITEMS).forEach(function (id) {
      if (p.holiday && !ITEMS[id].blast) return;
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
        g = by[t.id] = { id: t.id, item: t.item, own: t.own, owner: t.owner, defOwn: t.defOwn, assigned: t.assigned, text: t.text, each: t.each,
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
  var OP_SECTIONS = { stores: 1, sel: 1, skip: 1, d: 1, done: 1, due: 1, events: 1, vdays: 1, rows: 1, own: 1, notes: 1 };
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
  /* Vendor days go as the whole (short) list, which also retires the one-day d.vday a plan held before. */
  function vdaysOps(list) { return [['vdays', null, list.length ? list : null], ['d', 'vday', null]]; }
  function addVdayOp(p) { return vdaysOps(vdaysOf(p).concat([{ store: '', date: '', time: '' }])); }
  function removeVdayOp(p, i) { var l = vdaysOf(p); l.splice(+i, 1); return vdaysOps(l); }
  function setVdayOp(p, i, field, value) {
    var l = vdaysOf(p);
    if (!l[+i] || ['store', 'date', 'time'].indexOf(field) < 0) return [];
    l[+i][field] = String(value || '');
    return vdaysOps(l);
  }
  /* An item's list goes whole: it is short, and [rows, item, list] keeps the other items' lists. */
  function rowsOp(item, list) { return [['rows', item, list.length ? list : null]]; }
  function addRowOp(p, item) { return rowsOp(item, rowsOf(p, item).concat([{ date: '', text: '', stores: [] }])); }
  function removeRowOp(p, item, i) { var l = rowsOf(p, item); l.splice(+i, 1); return rowsOp(item, l); }
  function setRowOp(p, item, i, field, value) {
    var l = rowsOf(p, item);
    if (!l[+i] || ['date', 'text'].indexOf(field) < 0) return [];
    l[+i][field] = String(value || '');
    return rowsOp(item, l);
  }
  function toggleRowStoreOp(p, item, i, store) {
    var l = rowsOf(p, item), r = l[+i];
    if (!r || !store) return [];
    var at = r.stores.indexOf(store);
    if (at >= 0) r.stores.splice(at, 1); else r.stores.push(store);
    return rowsOp(item, l);
  }
  /* Handing a task to someone. Picking the person who owns it by default clears the override. */
  function assignOp(p, taskId, person) {
    var row = null;
    CORE.concat.apply(CORE.concat(BLAST), Object.keys(ITEMS).map(function (id) { return ITEMS[id].k; }))
      .forEach(function (r) { if (r[0] === taskId) row = r; });
    if (!row || (person && !PEOPLE[person])) return [];
    return [['own', taskId, person && PEOPLE[person] !== row[1] ? person : null]];
  }
  function ownerPicker(g, ctx) {
    var opts = [['', OWNERS[g.defOwn] || g.defOwn]];
    Object.keys(PEOPLE).forEach(function (who) { if (PEOPLE[who] !== g.defOwn) opts.push([who, OWNERS[PEOPLE[who]]]); });
    return '<select class="mk-own o-' + esc(g.own) + '" data-mk-assign="' + esc(g.id) + '" aria-label="Who owns this task">'
      + opts.map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === g.assigned ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
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
        + ' aria-pressed="' + (r.done ? 'true' : 'false') + '"' + ro + '>'
        + (r.store ? esc(ctx.storeName(r.store)) + (r.day ? ' &middot; ' + esc(shortDate(r.day)) : '') : esc(shortDate(r.day)))
        + '</button>';
    }).join('') + '</div>';
    var sub = [];
    if (item) sub.push(esc(item));
    if (g.each) sub.push((g.rows[0].store ? 'each store: ' : 'each date: ') + (g.rows.length - g.open) + ' of ' + g.rows.length);
    if (g.moved && g.open) sub.push('date moved by hand');
    return '<div class="mk-task' + (g.open ? '' : ' done') + '">' + box
      + '<span class="tx">' + esc(g.text) + (sub.length ? '<small>' + sub.join(' · ') + '</small>' : '') + stores + '</span>'
      + (ctx.canEdit ? ownerPicker(g, ctx) : '<span class="mk-own o-' + esc(g.own) + '">' + esc(g.owner) + '</span>') + due + '</div>';
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

  /* The vendor day card: one row per day, each with its store, date and time. */
  function vdayHtml(p, ctx, on) {
    var ro = ctx.canEdit ? '' : ' disabled';
    var rows = vdaysOf(p).map(function (v, i) {
      var ids = ctx.stores.filter(function (s) { return on.indexOf(s.store_id) >= 0 || s.store_id === v.store; });
      var data = ' data-mk-vday="' + i + '"';
      return '<div class="mk-vday">'
        + '<label class="mk-fld">Store<select' + data + ' data-mk-vfield="store"' + ro + '><option value="">All stores</option>'
        + ids.map(function (s) {
            return '<option value="' + esc(s.store_id) + '"' + (s.store_id === v.store ? ' selected' : '') + '>' + esc(s.name) + '</option>';
          }).join('') + '</select></label>'
        + '<label class="mk-fld">Date<input type="date"' + data + ' data-mk-vfield="date" value="' + esc(v.date) + '"' + ro + '></label>'
        + '<label class="mk-fld">Time<input type="text"' + data + ' data-mk-vfield="time" placeholder="4–7 PM" value="' + esc(v.time) + '"' + ro + '></label>'
        + (ctx.canEdit ? '<button type="button" class="mk-link mk-vdel" data-mk-vdel="' + i + '" aria-label="Remove this vendor day">Remove</button>' : '')
        + '</div>';
    }).join('');
    return (rows || '<p class="mk-sub">No days set yet.</p>')
      + (ctx.canEdit ? '<button type="button" class="gx-btn mk-vadd" data-mk-vadd="1">+ Add a vendor day</button>' : '');
  }

  /* The program's vendor files: one link to a Drive folder of art, posters and info sheets. Kept in
     d.files.url, so the engine stores it with no change. Internal only: the vendor plan never reads it. */
  function filesHtml(plan, ctx) {
    var url = String((plan.d.files || {}).url || ''), ro = ctx.canEdit ? '' : ' disabled';
    var open = /^https:\/\//i.test(url)
      ? '<a class="gx-btn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open folder</a>' : '';
    return '<div class="mk-files"><label class="mk-fld">Vendor files (Google Drive folder link)'
      + '<input type="url" data-mk-item="files" data-mk-field="url" placeholder="https://drive.google.com/drive/folders/…" value="' + esc(url) + '"' + ro + '></label>'
      + open + '</div>';
  }

  /* An item's list: a date per row, a line of text per row, or a line plus the stores it is at. */
  function listHtml(p, id, ctx, on) {
    var L = ITEMS[id].list, ro = ctx.canEdit ? '' : ' disabled';
    var data = function (i) { return ' data-mk-ritem="' + esc(id) + '" data-mk-row="' + i + '"'; };
    var rows = rowsOf(p, id).map(function (r, i) {
      var input = L.kind === 'date'
        ? '<input type="date"' + data(i) + ' data-mk-rfield="date" value="' + esc(r.date) + '" aria-label="' + esc(L.label) + '"' + ro + '>'
        : '<input type="text"' + data(i) + ' data-mk-rfield="text" placeholder="' + esc(L.ph || '') + '" value="' + esc(r.text) + '" aria-label="' + esc(L.label) + '"' + ro + '>';
      var pills = L.kind !== 'stores' ? '' : '<div class="mk-task-stores">' + ctx.stores.filter(function (s) {
          return on.indexOf(s.store_id) >= 0 || r.stores.indexOf(s.store_id) >= 0;
        }).map(function (s) {
          var hit = r.stores.indexOf(s.store_id) >= 0;
          return '<button type="button" class="mk-store-tick' + (hit ? ' on' : '') + '"' + data(i) + ' data-mk-rstore="' + esc(s.store_id) + '"'
            + ' aria-pressed="' + (hit ? 'true' : 'false') + '"' + ro + '>' + esc(s.name) + '</button>';
        }).join('') + '</div>';
      return '<div class="mk-lrow"><div class="mk-lrow-in">' + input
        + (ctx.canEdit ? '<button type="button" class="mk-link"' + data(i) + ' data-mk-rdel="1" aria-label="Remove">Remove</button>' : '')
        + '</div>' + pills + '</div>';
    }).join('');
    return '<div class="mk-fld">' + esc(L.label) + '</div>' + (rows || '<p class="mk-sub">None yet.</p>')
      + (ctx.canEdit ? '<button type="button" class="gx-btn mk-vadd" data-mk-radd="' + esc(id) + '">' + esc(L.add) + '</button>' : '');
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

    /* The incentive has no card: it has nothing to fill in, its payout is set in the Calculator. */
    var cards = Object.keys(ITEMS).filter(function (id) { return isOn(p, id) && !ITEMS[id].lock; }).map(function (id) {
      var it = ITEMS[id];
      var body = it.days ? vdayHtml(p, ctx, on)
        : it.f.map(function (f) { return fieldHtml(id, f, plan, ctx); }).join('') + (it.list ? listHtml(p, id, ctx, on) : '');
      /* No compliance note on the card (Sky, 2026-11-02): the workflows already carry those guardrails.
         `c` stays on each item as the record of what each one must respect. */
      return '<div class="mk-item"><h6>' + esc(it.t) + '</h6>' + body + '</div>';
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
      + '<p class="mk-sub">Only what’s needed for the items picked above.</p>'
      + filesHtml(plan, ctx)
      + '<div class="mk-items">' + cards + '</div></div>'
      + '<div class="mk-card"><div class="mk-row2"><div><h3 class="mk-h">Tasks</h3>'
      + '<p class="mk-sub mk-tight">Dates count from the window, and email and text tasks from their send date. Move either and the dates move with it.</p></div>'
      + '<span class="mk-pill">' + open + ' open of ' + groups.length + '</span></div>' + tasks + '</div>'
      + '<div class="mk-card"><h3 class="mk-h">Vendor plan and team</h3>'
      + '<p class="mk-sub">The plan is a page for the vendor: no staff names, pay or costs. Building or saving it sends nothing to anyone. '
      + 'The email goes to the Green Cross team only, after you confirm it.</p>'
      + '<div class="mk-actions">'
      + '<button type="button" class="gx-btn" data-mk-plan="view"' + (ctx.engineReady ? ro : ' disabled') + '>View vendor plan</button> '
      + '<button type="button" class="gx-btn" data-mk-plan="save"' + (ctx.engineReady ? ro : ' disabled') + '>' + (/^https:\/\/drive\.google\.com\//i.test(String((plan.d.files || {}).url || '')) ? 'Save to vendor folder' : 'Save to SPIFF Reports') + '</button> '
      + '<button type="button" class="gx-btn" data-mk-plan="notify"' + (ctx.engineReady ? ro : ' disabled') + '>Email the team…</button></div>'
      + '<div class="mk-status" data-mk-planstatus role="status"></div></div>'
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
      if (t.dataset.mkPlan) return api.plan(t.dataset.mkPlan, t);
      if (t.dataset.mkRadd) return api.apply(addRowOp(p, t.dataset.mkRadd));
      if (t.dataset.mkRdel) return api.apply(removeRowOp(p, t.dataset.mkRitem, t.dataset.mkRow));
      if (t.dataset.mkRstore) return api.apply(toggleRowStoreOp(p, t.dataset.mkRitem, t.dataset.mkRow, t.dataset.mkRstore));
      if (t.dataset.mkVadd) return api.apply(addVdayOp(p));
      if (t.dataset.mkVdel) return api.apply(removeVdayOp(p, t.dataset.mkVdel));
      if (t.dataset.mkPick) return api.apply(toggleItemOp(p, t.dataset.mkPick));
      if (t.dataset.mkStore) return api.apply(toggleStoreOp(p, t.dataset.mkStore, api.opts()));
      if (t.dataset.mkMoving) return api.moving(t.dataset.mkMoving);
      if (t.dataset.mkUnmove) return api.apply(dueOp(t.dataset.mkUnmove, null));
      if (t.dataset.mkTask) return api.tick(t.dataset.mkTask, !planOf(p).done[t.dataset.mkTask]);
    });
    host.addEventListener('change', function (e) {
      var t = e.target, p = api.program();
      if (!p || !t.dataset) return;
      if (t.dataset.mkAssign) return api.assign ? api.assign(t.dataset.mkAssign, t.value) : api.apply(assignOp(p, t.dataset.mkAssign, t.value));
      if (t.dataset.mkRfield) return api.apply(setRowOp(p, t.dataset.mkRitem, t.dataset.mkRow, t.dataset.mkRfield, t.value));
      if (t.dataset.mkVday) return api.apply(setVdayOp(p, t.dataset.mkVday, t.dataset.mkVfield, t.value));
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
  function barsOf(programs, pencils, ctx) {
    function byStart(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; }
    var name = (ctx && ctx.storeName) || function (s) { return s; };
    /* Each dated vendor day is a one-day marker under the programs, opening its program. */
    var vdays = [];
    (programs || []).forEach(function (p) {
      if (!isOn(p, 'vday')) return;
      vdaysOf(p).forEach(function (v) {
        if (!ISO.test(String(v.date || ''))) return;
        vdays.push({ id: p.program_id, label: (p.vendor || p.program_name || 'Vendor') + ' at ' + (v.store ? name(v.store) : 'all stores')
                       + (v.time ? ', ' + v.time : ''), start: v.date, end: v.date, kind: 'vday' });
      });
    });
    /* Holiday sends are one-day markers too, on their send date. */
    ((ctx && ctx.holidays) || []).forEach(function (h) {
      if (!ISO.test(String(h.send_date || ''))) return;
      vdays.push({ id: h.holiday_id, label: h.name + ' (' + channelWords(h) + ')', start: h.send_date, end: h.send_date, kind: 'holiday' });
    });
    vdays.sort(byStart);
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
    return bars.concat(vdays, pens);
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
      var act = b.kind === 'pencil' ? 'data-mk-pencil="' + esc(b.id) + '"'
        : b.kind === 'holiday' ? 'data-mk-holiday="' + esc(b.id) + '"' : 'data-mk-open="' + esc(b.id) + '"';
      var word = b.kind === 'pencil' ? 'Penciled, not official' : b.kind === 'vday' ? 'Vendor day' : b.kind === 'holiday' ? 'Holiday send'
        : b.kind === 'run' ? 'Running' : b.kind === 'done' ? 'Closed' : 'Draft';
      h += '<button type="button" class="' + cls + '" ' + act + ' style="--h:' + hueOf(b.label) + ';grid-column:' + (s + 1) + '/' + (e + 2) + ';grid-row:' + (2 + b.lane) + '"'
        + ' title="' + esc(b.label + ' · ' + word + ' · ' + shortDate(b.start) + ' to ' + shortDate(b.end)) + '">'
        + (b.kind === 'pencil' ? '&#9998; ' : b.kind === 'vday' ? '&#9733; ' : b.kind === 'holiday' ? '&#9993; ' : '') + esc(b.label) + '</button>';
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
    var bars = assignLanes(barsOf(programs, pencils, ctx).filter(function (b) { return b.end >= gridStart && b.start <= gridEnd; }));
    var legend = '<div class="mk-legend"><span><i class="lg run"></i>Running</span><span><i class="lg draft"></i>Draft</span>'
      + '<span><i class="lg done"></i>Closed</span><span><i class="lg vday"></i>Vendor day</span><span><i class="lg holiday"></i>Holiday send</span>'
      + '<span><i class="lg pencil"></i>Penciled, not official</span></div>';
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
      + (ctx.canEdit ? '<button type="button" class="gx-btn" data-mk-act="holadd">&#9993; Holiday send</button>'
        + '<button type="button" class="gx-btn gx-btn-green" data-mk-act="penadd">&#9998; Pencil a brand</button>' : '') + '</div></div>'
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
    var owners = ['INV', 'DIR', 'SKY', 'MGR', 'VEN'];
    var seg = '<span class="mk-seg"><button type="button" data-mk-owner=""' + (ctx.owner ? '' : ' class="is-on"') + '>Everyone</button>'
      + owners.slice(0, 4).map(function (o) {
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
        if (p.holiday) sub.splice(1, 0, 'Holiday send');
        var box = g.each ? '<span></span>'
          : '<input type="checkbox" data-mk-xtask="' + esc(g.key) + '" data-mk-prog="' + pid + '"' + ro + ' aria-label="Mark done">';
        var stores = !g.each ? '' : '<div class="mk-task-stores">' + g.rows.map(function (t) {
          return '<button type="button" class="mk-store-tick' + (t.done ? ' on' : '') + '" data-mk-xtask="' + esc(t.key) + '" data-mk-prog="' + pid + '"'
            + ' aria-pressed="' + (t.done ? 'true' : 'false') + '"' + ro + '>' + esc(ctx.storeName(t.store)) + '</button>';
        }).join('') + '</div>';
        return '<div class="mk-task">' + box + '<span class="tx">' + esc(g.text) + '<small>' + sub.join(' · ') + '</small>' + stores + '</span>'
          + (p.holiday ? '<button type="button" class="mk-link" data-mk-holiday="' + pid + '" title="Open this holiday send">Open</button>'
            : '<button type="button" class="mk-link" data-mk-open="' + pid + '" title="Open this program">Open</button>') + dueHtml(g, ctx.today) + '</div>';
      }).join('');
    }).join('');
    return '<div class="mk-row2"><div><h3 class="mk-h">Open tasks, every program</h3>'
      + '<p class="mk-sub mk-tight">Soonest first within each person. Tick one off here or on its program.</p></div>' + seg + '</div>'
      + '<div class="mk-card">' + (groups || '<p class="mk-sub">Nothing open.</p>') + '</div>';
  }

  /* ── Holiday sends ───────────────────────────────────────────────────────────────────────────────
     A holiday blast of our own: name, send date, email and/or text, note. NOT a program: it lives in
     the engine's own `holidays` tab, which nothing that pays anybody or feeds a kiosk reads. On the
     screen it is read AS a program that has only its blast items picked, so its tasks, dates,
     ticks and hand-offs are the vendor programs' own code: holidayProgram builds that view on every
     read, and only done / due / own are ever stored. Its program_id is the holiday's own id. */
  var CHANNEL_WORDS = { email: 'Email', sms: 'Text' };
  function channelWords(h) {
    return (h.channels || []).map(function (c) { return CHANNEL_WORDS[c] || c; }).join(' + ') || 'no channel';
  }
  function holidayProgram(h) {
    var m = h.marketing_json || {}, sel = {}, d = {};
    (h.channels || []).forEach(function (c) {
      if (!CHANNEL_WORDS[c]) return;
      sel[c] = true;
      d[c] = h.send_date ? { date: h.send_date } : {};
    });
    return { program_id: h.holiday_id, holiday: true, vendor: h.name, program_name: h.name, status: 'active',
             start_date: h.send_date, end_date: h.send_date, stores_json: [], note: h.note || '',
             marketing_json: { v: 1, sel: sel, d: d, done: m.done || {}, due: m.due || {}, own: m.own || {} } };
  }

  /* SUGGESTED SEND DATE (Sky, 2026-11-02): the cycle is built around a Monday send, so a holiday's
     send goes out the Monday BEFORE the holiday. Naming a known holiday fills that date in; any other
     date that is not a Monday gets the Monday before it offered. Only ever a suggestion: the person
     typing can set any date. Holidays are matched by name, each with its own date rule. */
  function nthWeekday(y, month, weekday, n) {   /* month 1-12, weekday 0=Sun; n<0 counts from the end */
    var first = y + '-' + pad(month) + '-01';
    if (n > 0) return addDays(first, (weekday - dow(first) + 7) % 7 + (n - 1) * 7);
    var last = addDays(monthStart(first, 1), -1);
    return addDays(last, -((dow(last) - weekday + 7) % 7));
  }
  var KNOWN_HOLIDAYS = [
    [/green wednesday/i, 'Green Wednesday', function (y) { return addDays(nthWeekday(y, 11, 4, 4), -1); }],
    [/black friday/i, 'Black Friday', function (y) { return addDays(nthWeekday(y, 11, 4, 4), 1); }],
    [/thanksgiving/i, 'Thanksgiving', function (y) { return nthWeekday(y, 11, 4, 4); }],
    [/christmas eve/i, 'Christmas Eve', function (y) { return y + '-12-24'; }],
    [/christmas|xmas/i, 'Christmas', function (y) { return y + '-12-25'; }],
    [/new year'?s eve|\bnye\b/i, 'New Year’s Eve', function (y) { return y + '-12-31'; }],
    [/valentine/i, 'Valentine’s Day', function (y) { return y + '-02-14'; }],
    [/4\/?20|four.?twenty/i, '4/20', function (y) { return y + '-04-20'; }],
    [/memorial day/i, 'Memorial Day', function (y) { return nthWeekday(y, 5, 1, -1); }],
    [/independence|4th of july|fourth of july|july 4/i, 'the Fourth of July', function (y) { return y + '-07-04'; }],
    [/labor day/i, 'Labor Day', function (y) { return nthWeekday(y, 9, 1, 1); }],
    [/halloween/i, 'Halloween', function (y) { return y + '-10-31'; }]
  ];
  /* The Monday strictly before a day (a Monday holiday sends the Monday a week earlier). */
  function mondayBefore(day) {
    if (!ISO.test(String(day || ''))) return '';
    return addDays(day, -((dow(day) + 6) % 7 || 7));
  }
  /* A known holiday's next date on or after today, by name. */
  function holidayOn(name, today) {
    var hit = KNOWN_HOLIDAYS.filter(function (h) { return h[0].test(String(name || '')); })[0];
    if (!hit || !ISO.test(String(today || ''))) return null;
    var y = +today.slice(0, 4), day = hit[2](y);
    if (day < today) day = hit[2](y + 1);
    return { label: hit[1], day: day };
  }
  /* { date, text }: what to suggest for this name and typed date, or null when nothing to say. The
     date is filled in by the screen only while the box is empty or still holds its own suggestion. */
  function sendSuggestion(name, typed, today) {
    var h = holidayOn(name, today);
    if (h) {
      var send = mondayBefore(h.day);
      return { date: send, text: 'Suggested: ' + niceDate(send) + ', the Monday before ' + h.label + ' (' + niceDate(h.day) + ').' };
    }
    if (ISO.test(String(typed || '')) && dow(typed) !== 1) {
      var mon = mondayBefore(typed);
      return { date: mon, text: 'Blasts go out on a Monday. Suggested: ' + niceDate(mon) + '.' };
    }
    return null;
  }
  function suggestionHtml(s, typed) {
    if (!s || s.date === typed) return s ? '<span>' + esc(s.text) + '</span>' : '';
    return '<span>' + esc(s.text) + '</span> <button type="button" class="mk-link" data-mk-act="holsuggest" data-mk-id="' + esc(s.date) + '">Use it</button>';
  }

  /* ctx: { today, canEdit, moving, storeName, error }. h null = a new one. */
  function holidayDialogHtml(h, ctx) {
    var on = function (c) { return !h || (h.channels || []).indexOf(c) >= 0; };
    var ro = ctx.canEdit ? '' : ' disabled';
    var html = '<h3 class="mk-h">&#9993; ' + (h ? esc(h.name) : 'New holiday send') + '</h3>'
      + '<p class="mk-sub">Our own email or text blast. It is not a vendor program: no pay, no kiosk, nothing in the status roll. '
      + 'Its tasks count back from the send date.</p>'
      + '<label class="mk-fld">Name<input id="mkHfName" type="text" maxlength="80" placeholder="For example: Thanksgiving" value="' + esc(h ? h.name : '') + '"' + ro + '></label>'
      + '<div class="mk-2col"><label class="mk-fld">Send date<input id="mkHfDate" type="date" value="' + esc(h ? h.send_date : '') + '"' + ro + '></label>'
      + '<div class="mk-fld">Channels<div class="mk-hf-ch">'
      + Object.keys(CHANNEL_WORDS).map(function (c) {
          return '<label><input type="checkbox" data-mk-hfch="' + c + '"' + (on(c) ? ' checked' : '') + ro + '> ' + CHANNEL_WORDS[c] + '</label>';
        }).join(' ') + '</div></div></div>'
      + '<p class="mk-sub mk-hf-hint" id="mkHfHint">' + (ctx.canEdit ? suggestionHtml(sendSuggestion(h ? h.name : '', h ? h.send_date : '', ctx.today), h ? h.send_date : '') : '') + '</p>'
      + '<label class="mk-fld">Note (optional)<input id="mkHfNote" type="text" maxlength="300" value="' + esc(h ? h.note : '') + '"' + ro + '></label>'
      + '<div id="mkPfWarn">' + (ctx.error ? '<div class="mk-warn">' + esc(ctx.error) + '</div>' : '') + '</div>';
    if (h) {
      var hp = holidayProgram(h), groups = groupTasks(tasksOf(hp, {}));
      html += '<div class="mk-phase">Tasks<span>' + groups.filter(function (g) { return g.open; }).length + ' open of ' + groups.length + '</span></div>'
        + groups.map(function (g) { return taskHtml(g, hp, ctx); }).join('');
    }
    html += ctx.canEdit
      ? '<div class="mk-dlg-act"><button type="button" class="gx-btn gx-btn-green" data-mk-act="holsave" data-mk-id="' + esc(h ? h.holiday_id : '') + '">' + (h ? 'Save changes' : 'Add it') + '</button>'
        + (h ? '<button type="button" class="gx-btn" data-mk-act="holcancel" data-mk-id="' + esc(h.holiday_id) + '">Cancel this send</button>' : '')
        + '<button type="button" class="gx-btn" data-mk-act="dlgclose">Close</button></div>'
      : '<div class="mk-dlg-act"><button type="button" class="gx-btn" data-mk-act="dlgclose">Close</button></div>';
    return html + '<div class="mk-status" data-mk-status role="status"></div>';
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
      var t = e.target.closest ? e.target.closest('button,[data-mk-pencil],[data-mk-holiday],[data-mk-open],[data-mk-view]') : null;
      if (!t || t.disabled || !host.contains(t)) return;
      var d = t.dataset;
      if (d.mkView) return api.view(d.mkView);
      if (d.mkNav !== undefined) return api.nav(+d.mkNav);
      if (d.mkOwner !== undefined) return api.owner(d.mkOwner);
      if (d.mkXtask) return api.tick(d.mkProg, d.mkXtask, t.tagName === 'INPUT' ? t.checked : !t.classList.contains('on'));
      if (d.mkDay) return api.penAdd(d.mkDay);
      if (d.mkAct) return api.act(d.mkAct, d.mkId || '');
      if (d.mkPencil) return api.pencil(d.mkPencil);
      if (d.mkHoliday) return api.holiday(d.mkHoliday);
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
    holidayProgram: holidayProgram, holidayDialogHtml: holidayDialogHtml, channelWords: channelWords,
    sendSuggestion: sendSuggestion, suggestionHtml: suggestionHtml, mondayBefore: mondayBefore, holidayOn: holidayOn,
    isVisible: isVisible, SECTIONS: SECTIONS, ITEMS: ITEMS, CORE: CORE, BLAST: BLAST, OWNERS: OWNERS,
    addDays: addDays, daysBetween: daysBetween, planOf: planOf, hasPlan: hasPlan, isOn: isOn,
    pickedItems: pickedItems, storesOf: storesOf, tasksOf: tasksOf, groupTasks: groupTasks,
    phaseOf: phaseOf, lateOf: lateOf, nextOf: nextOf, overdueTotal: overdueTotal,
    incentiveLine: incentiveLine, applyOps: applyOps, toggleItemOp: toggleItemOp,
    toggleStoreOp: toggleStoreOp, detailOp: detailOp, doneOp: doneOp, dueOp: dueOp,
    vdaysOf: vdaysOf, addVdayOp: addVdayOp, removeVdayOp: removeVdayOp, setVdayOp: setVdayOp,
    PEOPLE: PEOPLE, assignOp: assignOp,
    rowsOf: rowsOf, addRowOp: addRowOp, removeRowOp: removeRowOp, setRowOp: setRowOp, toggleRowStoreOp: toggleRowStoreOp,
    makeSaver: makeSaver, listLine: listLine, foldNote: foldNote, sectionHtml: sectionHtml, wire: wire
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpiffMarketing = api;
})(this);
