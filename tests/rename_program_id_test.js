#!/usr/bin/env node
/* ─── Re-keying a program moves everything keyed on it ────────────────────────────────────────────
 *
 *   RUN:  node tests/rename_program_id_test.js
 *
 * Sky, 2026-09-08: "update id green-cross-test-202608 to reflect the Portland Heights program."
 * That program is the real Portland Heights fortnight (Aug 17–30, 242 units, $181.50, closed and
 * paid); it carries a test-shaped id only because ids are minted from the name at creation and it
 * was created while named "Green Cross test".
 *
 * WHY THIS NEEDS A ROUTE AND A TEST, and not a cell edit. `program_id` is a FOREIGN KEY:
 *
 *   · `spiff_progress` keys every measurement row on it — 38 rows for this program.
 *   · `?action=progress` DROPS any cached row whose program_id is absent from `programs`, counting
 *     it in orphan_rows.
 *   · GX Crew's incentive column and the Leaderboard kiosks read that route.
 *   · Core's `spiff_publications` now carries the id inside the published payload.
 *
 * Editing the cell in `programs` and stopping would strand 38 rows carrying $181.50 — the BeGOAT
 * failure of 2026-08-31 reproduced exactly (25 stranded rows, $350, fourteen people showing as
 * owed $25 for a fortnight already paid). `deleteProgram` exists because a program is not one row;
 * a rename is the same fact.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const ren = grab('renameProgramId_');

/* ══════════════════ 1. EVERYTHING KEYED ON THE ID MOVES ══════════════════ */
ok('the cached measurement rows are re-pointed, not left behind',
   /repointProgressRows_\(from, to\)/.test(ren));
const rep = grab('repointProgressRows_');
ok('  …by writing the id COLUMN only, so a settled program\'s figures do not change',
   /sh\.getRange\(i \+ 1, 1\)\.setValue\(to\)/.test(rep) && rep.indexOf('earned') < 0);
ok('  …and it reports how many it moved', /return moved;/.test(rep));
/* Order is the whole safety argument. */
ok('the measurements move BEFORE the program row',
   ren.indexOf('repointProgressRows_') < ren.indexOf('idCol + 1).setValue(to)'));
ok('  …so a half-run leaves visible orphans rather than silently vanished money',
   /read as orphans/.test(ren));
ok('Core is republished, so its payload stops carrying the old id',
   /publishSpiffToCore_\(/.test(ren));
ok('  …and a failed republish is reported, not thrown away',
   /republish to Core failed/.test(ren));
ok('the programs cache is cleared so the new id is visible at once',
   /invalidatePrograms_\(\)/.test(ren));
/* An earlier draft called a function that does not exist, AFTER both halves had moved. */
/* Checked as a CALL, not a substring: the comment above it names the function to explain why it
   is gone, and flagging that would be a test crying about prose. */
ok('  …and nothing calls an invalidator that does not exist',
   !/^\s*invalidateProgressCache_\(\);/m.test(gs)
   && !/^function invalidateProgressCache_/m.test(gs));

/* ══════════════════ 2. IT CANNOT MERGE TWO PROGRAMS ══════════════════ */
/* There is already a portland-heights-2026-03-30-2026-04-12; landing on an id in use would pool
   two fortnights of earnings under one key. */
ok('an id already in use is refused',
   /getProgram_\(to\)\.ok/.test(ren) && /already exists/.test(ren));
ok('a no-op rename is refused rather than tombstoned',
   /from === to/.test(ren));
ok('both ids are required', /id and to are both required/.test(ren));
ok('the new id is slugged, so it cannot be minted with spaces or capitals',
   /slug_\(String\(p\.to/.test(ren));

/* ══════════════════ 3. THE SAME GATES AS DELETING ══════════════════ */
ok('it needs a real session, not just the deploy secret',
   /gxAuth_\(p\.token\)/.test(ren) && /needsAuth: true/.test(ren));
ok('  …and an editing role', /EDIT_ROLES\.indexOf\(String\(auth\.role\)\) < 0/.test(ren));
ok('  …and the program NAME typed back, checked server-side',
   /String\(p\.confirm \|\| ''\)\.trim\(\) !== want/.test(ren));
ok('  …because writes ride on GET and a URL gets pasted and re-fetched',
   /pasted, bookmarked and re-fetched/.test(ren));
ok('dry by default — nothing moves without apply=1',
   /String\(p\.apply \|\| ''\) !== '1'/.test(ren) && /dry: true/.test(ren));
ok('  …and the dry run says how many rows it would move',
   /progress_rows_to_move/.test(ren));
ok('the old row is tombstoned to deleted_programs before anything moves',
   ren.indexOf('deletedSheet_().appendRow') < ren.indexOf('repointProgressRows_'));
ok('  …recording that it was a rename and to what',
   /'renamed to ' \+ to/.test(ren));
ok('it is registered as a route, or none of this is reachable',
   /case 'renameProgramId': out = renameProgramId_\(p\);/.test(gs));
/* Session-gated, so it must NOT be on the secret-only list — that would weaken it to a URL. */
ok('  …and NOT on the secret-only list, which would drop the session requirement',
   !/SECRET_ACTIONS = \[[^\]]*renameProgramId/.test(gs));

/* ══════════════════ 4. CLOSED IS RENAMEABLE, UNLIKE DELETABLE ══════════════════ */
/* A delete removes money that was reported and paid. A rename moves the same money to a key that
   says what it is — and this program is closed, so refusing would make the bad id permanent. */
ok('a closed program can be renamed',
   !/status[^\n]*=== 'closed'[^\n]*return \{ ok: false/.test(ren));
ok('  …and the reasoning is written down, next to the delete that does refuse',
   /A\s+\* delete removes money that was reported and paid/.test(ren.replace(/\n/g, '\n'))
   || /delete removes money that was reported and paid/.test(gs));
/* Deleting still refuses closed — this must not have loosened that. */
ok('deleting a closed program is still refused',
   /it ran, was reported to the vendor and was/.test(grab('deleteProgram_')));

/* ══════════════════ 5. IT DOES NOT GO THROUGH THE SAVE PATH ══════════════════ */
/* saveProgram_ clears a program's measurements when the fields that define what it measured move
   (see the comment at listProgramsCached_). A re-key must NOT trip that: the numbers are correct
   and only the key is changing. Writing the cell directly is what avoids it. */
ok('the program row is re-keyed by a direct cell write, not through saveProgram_',
   /setValue\(to\)/.test(ren) && ren.indexOf('saveProgram_') < 0);

console.log(fail ? '\n' + fail + ' FAILED' : '\nrename program id: all passed');
process.exit(fail ? 1 : 0);
