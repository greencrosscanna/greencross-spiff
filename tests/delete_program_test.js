#!/usr/bin/env node
/* ─── Deleting a program takes its measurements with it ──────────────────────────────────────────
 *
 *   RUN:  node tests/delete_program_test.js
 *
 * WHY
 * Sky, 2026-09-06: "need a way to delete a program, specifically the Wyld 10pc. it never happened
 * so we can delete it." The reason it is a ROUTE and not a spreadsheet gesture is that a program is
 * not one row.
 *
 * Its measurements live in `spiff_progress`, keyed on program_id, and ?action=progress is read by
 * GX Crew's incentive column and the Leaderboard kiosks. Delete the program row by hand and those
 * rows survive it — orphans carrying `earned` dollars for a program that no longer exists. That is
 * precisely the BeGOAT failure of 2026-08-31: 25 stranded rows, $350 of earnings, fourteen people
 * showing as owed $25 for a fortnight already paid. `orphan_rows` exists to CATCH that shape; a
 * hand-delete manufactures it deliberately. So the row and its measurements go together or the
 * route is worse than useless.
 *
 * The other three rules are about what deletion must never become:
 *  - a CLOSED program cannot be deleted at all. It ran, was measured, was reported to the vendor
 *    and was paid — the same reasoning that makes closed terminal in the status roll and locks its
 *    goals in the Calculator.
 *  - the confirmation is checked SERVER-SIDE. Writes here ride on GET, and a URL is a thing that
 *    gets pasted, bookmarked and re-fetched; a disabled button is a claim about a screen.
 *  - nothing is destroyed. The row is copied to `deleted_programs` BEFORE it is removed, so a
 *    failure between the two leaves a duplicate rather than a hole.
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

console.log('engine');
const del = grab(gs, 'deleteProgram_');

/* ── the whole point: measurements go too ── */
ok('the measured progress rows are dropped with the program',
   /dropProgressRows_\(\s*p\.id\s*\)/.test(del));
ok('  …and the programs cache is invalidated, so the list does not keep serving it',
   /invalidatePrograms_\(\)/.test(del));
ok('  …and a failure to drop them is REPORTED, not swallowed — orphans are the failure mode',
   /warning/.test(del) && /dropError/.test(del));

/* ── closed is not deletable ── */
ok('a CLOSED program is refused',
   /status[^\n]*toLowerCase\(\)\s*===\s*'closed'/.test(del) && /ok:\s*false/.test(del));
ok('  …and the refusal says why, rather than reading as a bug',
   /reported to the vendor/.test(del));

/* ── the confirmation is a control, not a dialog ── */
ok('the typed name is compared SERVER-SIDE against the stored program name',
   /p\.confirm/.test(del) && /program_name/.test(del));
ok('  …so an id alone cannot delete anything, however the URL was arrived at',
   /Type the program name exactly to confirm/.test(del));

/* ── nothing is destroyed ── */
ok('the row is tombstoned to deleted_programs', /deletedSheet_\(\)\.appendRow/.test(del));
ok('  …BEFORE the live row is removed, so a half-failure duplicates rather than loses',
   del.indexOf('deletedSheet_().appendRow') < del.indexOf('sh.deleteRow'));
ok('  …stamped with who deleted it and when', /auth\.user,\s*nowStamp_\(\)/.test(del));
ok('the tombstone tab carries the deletion columns on top of the program columns',
   /DELETED_HEADERS\s*=\s*PROGRAM_HEADERS\.concat\(\['deleted_by',\s*'deleted_at',\s*'deleted_reason'\]\)/.test(gs));

/* ── who may call it ── */
ok('it checks a real session itself — a deploy secret alone cannot delete',
   /gxAuth_\(p\.token\)/.test(del));
ok('  …and demands an edit role', /EDIT_ROLES\.indexOf\(String\(auth\.role\)\)\s*<\s*0/.test(del));
ok('it is NOT public', !/PUBLIC_ACTIONS[^\n]*deleteProgram/.test(gs));
ok('it is NOT a secret-only machine route', !/SECRET_ACTIONS[^\n]*deleteProgram/.test(gs));
ok('routed on doGet (writes ride on GET here) and on doPost',
   (gs.match(/case 'deleteProgram':/g) || []).length === 2);

console.log('frontend');
const ui = grab(js, 'renderRecord');
const fn = grab(js, 'deleteProgram');

ok('the delete control is behind the same role gate as every other write',
   /if \(canEdit\(\)\) \{[\s\S]*?btnDelete/.test(ui));
ok('a closed program is TOLD why it cannot be deleted, not silently given no button',
   /closed\s*$|var closed = String\(p\.status/.test(ui) && /stays in History/.test(ui));
ok('the button starts disabled', /id="btnDelete" disabled/.test(ui));
ok('  …and only enables when the typed name matches exactly',
   /del\.disabled = box\.value\.trim\(\) !== want/.test(ui));
ok('  …and the click re-checks it rather than trusting the attribute',
   /if \(box\.value\.trim\(\) !== want\) return;/.test(ui));
ok('the confirm name is sent to the engine', /confirm: name/.test(fn));
ok('the Calculator lets go of the deleted program before the repaint',
   fn.indexOf('calc.editingId = null') < fn.indexOf('syncRecordMount()'));
ok('every surface that lists programs is repainted',
   ['loadPrograms', 'renderPrograms', 'renderHistory', 'fillProgramPickers', 'syncRecordMount']
     .every(f => fn.includes(f)));
ok('an expired session reopens sign-in instead of reading as a failed delete',
   /needsAuth/.test(fn) && /openSignIn\(\)/.test(fn));

console.log(fail ? '\ndelete program: FAILED' : '\ndelete program: OK');
process.exit(fail ? 1 : 0);
