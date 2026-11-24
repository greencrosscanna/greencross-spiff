/* ─── Per unit, once the goal is reached ──────────────────────────────────────────────────────────
 *
 * Tawny, 2026-11-24 (bug board): "When you open the program, it shows people have already hit their
 * goal by selling just one unit. It isn't using the numbers we set for the threshold as the goal."
 * The Green Cross 10pk program was per unit, and per unit paid from the first unit with no goal.
 * Sky's ruling: per unit AFTER the goal — every unit pays, the first ones included, but only once
 * the budtender reaches their store's per-budtender goal. Below it, $0.
 *
 * Runs the engine's real pay functions (progEarned_, progEarns_, snapshotStore_, payoutFactsOf_)
 * through the shared harness; only sell-through, the clock and the sheet are stubbed.
 */
'use strict';
const G = require('./_gas');
let failed = 0;
function ok(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; }

const api = G.load({
  real: ['progEarned_', 'progEarns_', 'payoutAfterGoal_', 'payoutModelOf_', 'payoutRateOf_',
         'snapshotStore_', 'payoutFactsOf_', 'moneyStr_', 'computePayouts_', 'textDate_', 'slug_'],
  stubs: {
    sellthrough_: () => ({ ok: true, units: 9, target: 5, rows: [
      { name: 'AT GOAL', employee_id: 'e1', units: 7, hit: true },
      { name: 'BELOW', employee_id: 'e2', units: 2, hit: false },
    ] }),
    writeSnapshot_: () => {},
    nowStamp_: () => '2026-11-24 14:00:00',
  },
});

const GATED = { payout_json: { model: 'per_unit', amount: 1, after_goal: true } };
const PLAIN = { payout_json: { model: 'per_unit', amount: 1 } };
const FLAT  = { payout_json: { model: 'flat', amount: 25 } };

/* ── what one person earns ── */
ok('below the goal earns nothing', api.progEarned_(GATED, 2, false) === 0);
ok('at the goal earns EVERY unit, the first ones included', api.progEarned_(GATED, 7, true) === 7);
ok('plain per unit still pays from the first unit', api.progEarned_(PLAIN, 2, false) === 2);
ok('flat is unchanged', api.progEarned_(FLAT, 7, true) === 25 && api.progEarned_(FLAT, 2, false) === 0);
ok('the flag stored as text still counts (sheet round-trip)',
   api.progEarned_({ payout_json: { model: 'per_unit', amount: 1, after_goal: 'true' } }, 2, false) === 0);
ok('the flag on a FLAT program changes nothing',
   api.progEarned_({ payout_json: { model: 'flat', amount: 25, after_goal: true } }, 7, true) === 25);

/* ── who counts as earning ── */
ok('after goal: only those at goal are earners',
   api.progEarns_(GATED, 2, false) === false && api.progEarns_(GATED, 7, true) === true);
ok('plain per unit: anyone who sold is an earner', api.progEarns_(PLAIN, 2, false) === true);

/* ── the measurement the close-out records from ── */
const prog = Object.assign({ program_id: 'green-cross-10pks', start_date: '2026-11-17',
  end_date: '2026-11-30', stores_json: ['bend'] }, GATED);
const r = api.snapshotStore_(prog, 'bend');
ok('a store snapshot pays only the budtender at goal', r.ok === true && r.earned === 7);
ok('  …and counts one earner, not two', r.earners === 1);

/* ── the vendor paper's arithmetic ── */
const f = api.payoutFactsOf_(Object.assign({}, GATED,
  { actual_json: { units_sold: 9, bts_hit: 1, spiff_amount: 1, investment: 7 } }));
ok('vendor paper owes the recorded investment', f.owed === 7);
ok('  …and does not flag it against units × rate, which would be the wrong rule', f.mismatch === null);
ok('  …and says who was paid', /reached their goal/.test(f.basis) && /once at goal/.test(f.rate_label));

/* ── the older helper stays a mirror ── */
const cp = api.computePayouts_(
  [{ store_id: 'bend', units: 7 }, { store_id: 'bend', units: 2 }],
  { bend: 5 }, { type: 'per_unit', per_unit: 1, after_goal: true });
ok('computePayouts_ applies the same gate', cp.total_owed === 7 && cp.lines[1].earned === 0);

console.log(failed ? '\n' + failed + ' FAILED' : '\nper unit after goal: all passed');
process.exit(failed ? 1 : 0);
