#!/usr/bin/env node
/* ─── A patch the engine silently ignores ─────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/editable_fields_test.js
 *
 * WHY
 * editProgram_ applies only the keys named in EDITABLE_FIELDS. Anything else is skipped WITHOUT A
 * WORD: the route returns ok, `changed` lists just the fields it did apply, and a caller that does
 * not read `changed` sees a successful save that did nothing.
 *
 * match_json and stores_json were missing from that list. match_json is WHAT THE SPIFF IS ON — the
 * brand, the category, the named products — so the one field that decides which sales count could
 * not be changed after a program was created.
 *
 * Sky changed Portland Heights from the Green Cross house brand to "all Portland Heights products"
 * twice on 2026-09-02. The button said Updated both times. The record kept the house brand, and
 * kept reporting 3,514 units of it against a real 242.
 *
 * THE CLASS OF BUG, worth stating because the list will grow again: the Calculator builds one
 * payload of nine model fields and the engine accepts seven of them. Nothing on either side
 * compares the two. So this file does.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
const js = fs.readFileSync(__dirname + '/../spiff.js', 'utf8');
function grab(src, name) {
  const i = src.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const EDITABLE = new Function('return ' +
  (gs.match(/var EDITABLE_FIELDS = (\[[\s\S]*?\]);/) || [])[1])();

/* THE ONE THAT COST A DAY. */
ok('match_json is editable — it is what the SPIFF is ON', EDITABLE.indexOf('match_json') >= 0);
ok('stores_json is editable — which stores the program ran in',
   EDITABLE.indexOf('stores_json') >= 0);
ok('payout_type is editable, not just payout_json — they are two columns and both are written',
   EDITABLE.indexOf('payout_type') >= 0);

/* EVERY FIELD THE CALCULATOR SENDS MUST BE ACCEPTED.
   This is the assertion that would have caught it: the payload and the whitelist are written in
   two files by two different hands, and nothing but this compares them. */
const payload = grab(js, 'calcModelPayload');
const sent = [];
payload.replace(/^\s{6}(\w+):/gm, (m, k) => { sent.push(k); return m; });
ok('the Calculator payload was read', sent.length >= 8);
sent.forEach(function (f) {
  ok('  the engine accepts ' + f, EDITABLE.indexOf(f) >= 0);
});

/* The record form's fields too — the other half of the screen saves through the same route. */
['status', 'start_date', 'end_date', 'contact_name', 'contact_email', 'actual_json']
  .forEach(function (f) {
    ok('the record form’s ' + f + ' is accepted', EDITABLE.indexOf(f) >= 0);
  });

/* Silence is the actual hazard: the route reports ok either way. Keep `changed` in the response so
   a caller CAN tell, even though the fix is to accept the field in the first place. */
const edit = grab(gs, 'editProgram_');
ok('editProgram_ reports which fields it actually applied', /res\.changed = changed/.test(edit));
ok('  …and says so plainly when a patch changed nothing', /unchanged: true/.test(edit));

/* ── THE PER-STORE BASELINE SPLIT ──
   A plan row calls these `base` and `n`. calc.stores calls them `baseline` and `bts`. The payload
   read the calc.stores names off a plan row, so every store's last-month figure saved as 0 while
   the chain total came out right — a record that looks correct in summary and is flat zero
   underneath. Every Calculator-written program carries it; the seeded ones do not, which is why it
   went unnoticed. */
ok('the baseline split reads `base` off a plan row, not `baseline`',
   /baseByStore\[s\.store_id\] = Number\(s\.base\) \|\| 0/.test(payload));
ok('  …and the headcount reads `n`, not `bts`',
   /basePerBt\[s\.store_id\]   = s\.n \? Math\.round\(\(Number\(s\.base\) \|\| 0\) \/ s\.n\) : 0/.test(payload));
ok('  …and nothing in the payload still reads the calc.stores names off a plan row',
   !/s\.baseline/.test(payload) && !/s\.bts\b/.test(payload));

console.log(fail ? '\n' + fail + ' FAILED' : '\neditable fields: all passed');
process.exit(fail ? 1 : 0);
