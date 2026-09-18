#!/usr/bin/env node
/* ─── One call at open, not four ──────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/engine_boot_test.js
 *
 * WHY
 * SPIFF's screen opened with four back-to-back reads against its own /exec — `programs`, `brands`,
 * `progress`, `employees` (spiff.js start()). Apps Script serializes executions of one script, so
 * the four queued nose-to-tail rather than overlapping: 2.4s warm / 8.7s cold EACH (the comment
 * above listProgramsCached_ in Code.gs), and every one of the four paid its own gxAuth_ round trip
 * to GX Core on top. `bootAll_` answers all four from the SAME caches those routes already keep
 * warm, behind ONE guard_ check — see the block comment on it in Code.gs.
 *
 * WHAT THIS FILE RUNS. bootAll_ itself, assembled from its real source with its four collaborators
 * (listProgramsCached_, brandsRead_, gxEmployees_, spiffProgress_) stubbed at the edge — the same
 * rule _gas.js states: a route runs for real, its collaborators are stubbed, not the route itself.
 * That proves the thing that actually matters here: ONE call to each part, a failed part isolated
 * to its own slot, and the other three unaffected by it.
 *
 * WHAT IS SOURCE-SHAPED, and why: the four solo routes (`programs`, `brands`, `employees`,
 * `progress`) staying live and unchanged is an absence claim (no removed case in the router) that
 * doGet_test coverage does not exist for elsewhere either — checked by reading doGet's switch,
 * which is markup-shaped routing rather than a computation. `boot` itself is not secret-gated is
 * likewise a claim about which list it is absent from.
 */
'use strict';
const fs = require('fs');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = G.GS;

/* ── the assembly, run for real ─────────────────────────────────────────────────────────────────── */
function engine(opts) {
  const o = opts || {};
  const calls = { programs: 0, brands: 0, employees: 0, progress: 0 };
  const stubs = {
    listProgramsCached_: () => {
      calls.programs++;
      if (o.programsThrows) throw new Error('sheet read blew up');
      return o.programs || [];
    },
    brandsRead_: () => {
      calls.brands++;
      if (o.brandsThrows) throw new Error('GX Core brand list unavailable: secret=shh');
      return o.brands || { ok: true, brands: [] };
    },
    gxEmployees_: () => {
      calls.employees++;
      if (o.employeesThrows) throw new Error('roster unavailable');
      return o.employees || { ok: true, employees: [] };
    },
    spiffProgress_: () => {
      calls.progress++;
      if (o.progressThrows) throw new Error('progress sheet blew up');
      return o.progress || { ok: true, rows: [] };
    },
    /* The real scrubSecrets_ redacts a deploy secret out of an error message; a part failing here
       must come back scrubbed like every other exception-to-reply path in this engine (see doGet's
       catch). A trivial stand-in is enough to prove bootAll_ calls it rather than passing the raw
       message through. */
    scrubSecrets_: (m) => String(m).replace(/secret=\S+/, 'secret=[redacted]'),
  };
  const api = G.load({ real: ['bootAll_'], stubs: stubs });
  return Object.assign({}, api, { calls: calls });
}

console.log('\n1. the common case: four reads, four slots, one shot each');
let E = engine({ programs: [{ program_id: 'p1' }], brands: { ok: true, brands: [{ brand_id: 'b1' }] },
                  employees: { ok: true, employees: [{ employee_id: 'e1' }] },
                  progress: { ok: true, rows: [{ program_id: 'p1' }] } });
let out = E.bootAll_({ token: 'tok' });
ok('the envelope is ok', out.ok === true);
ok('programs comes back in the SAME shape the solo route uses',
   out.programs.ok === true && Array.isArray(out.programs.programs) && out.programs.programs[0].program_id === 'p1');
ok('brands is the solo brandsRead_ reply, untouched', out.brands.ok === true && out.brands.brands[0].brand_id === 'b1');
ok('employees is the solo gxEmployees_ reply, untouched', out.employees.ok === true && out.employees.employees[0].employee_id === 'e1');
ok('progress is the solo spiffProgress_ reply, untouched', out.progress.ok === true && out.progress.rows[0].program_id === 'p1');
ok('each of the four collaborators was asked exactly ONCE',
   E.calls.programs === 1 && E.calls.brands === 1 && E.calls.employees === 1 && E.calls.progress === 1);

console.log('\n2. one part failing does not take the other three down with it');
E = engine({ programs: [{ program_id: 'p1' }], brandsThrows: true,
             employees: { ok: true, employees: [] }, progress: { ok: true, rows: [] } });
out = E.bootAll_({ token: 'tok' });
ok('the envelope is still ok — a part failing is not the WHOLE call failing', out.ok === true);
ok('the failed part carries its own {ok:false, error} in its own slot',
   out.brands.ok === false && /brand list unavailable/.test(out.brands.error));
ok('  …scrubbed, same as every other exception-to-reply path', !/secret=shh/.test(out.brands.error));
ok('the three healthy parts still arrived, unaffected',
   out.programs.ok === true && out.employees.ok === true && out.progress.ok === true);

console.log('\n3. every part can fail independently, and all four failing is still one reply, not a throw');
E = engine({ programsThrows: true, brandsThrows: true, employeesThrows: true, progressThrows: true });
let threw = false;
try { out = E.bootAll_({ token: 'tok' }); } catch (e) { threw = true; }
ok('bootAll_ never throws — a caller (doGet) gets a reply either way', !threw);
ok('  …and every slot names its own failure',
   out.programs.ok === false && out.brands.ok === false && out.employees.ok === false && out.progress.ok === false);

/* ── architecture guards, source-shaped: absence of a thing across doGet's router ──────────────── */
console.log('\n4. wiring in the router (source-shaped — see header)');
ok('[source] `boot` routes to bootAll_ in doGet',
   /case 'boot':\s*out = bootAll_\(p\);/.test(gs));
ok('[source] `boot` is not on PUBLIC_ACTIONS — it still needs a session or the deploy secret',
   !new RegExp("PUBLIC_ACTIONS\\s*=\\s*\\[[^\\]]*'boot'").test(gs));
ok('[source] `boot` is not on SECRET_ACTIONS either — a signed-in browser can call it, like the four it replaces',
   !new RegExp("SECRET_ACTIONS\\s*=\\s*\\[[^\\]]*'boot'").test(gs));
ok('[source] the four solo routes it replaces are still wired, unchanged',
   ["case 'programs':", "case 'brands':", "case 'employees':", "case 'progress':"]
     .every(needle => gs.indexOf(needle) >= 0));

console.log('\n' + '─'.repeat(30));
console.log(fail ? fail + ' FAILED' : 'engine boot: all passed');
process.exit(fail ? 1 : 0);
