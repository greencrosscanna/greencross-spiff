#!/usr/bin/env node
/* ─── A test runs the code, or says why it cannot ─────────────────────────────────────────────────
 *
 *   RUN:  node tests/suite_shape_test.js
 *
 * Sky, 2026-09-09: "flip the test ratio — tests that run the code, not tests that grep for it."
 *
 * WHAT WENT WRONG, AND WHY A RULE ALONE WOULD NOT HOLD IT. Most of this suite used to assert that
 * code LOOKED a certain way: that a call appears, that a string is present, that one line sits
 * above another. None of the five bugs found on 2026-09-08/09 would have been caught by any of
 * them, and several tests written that same day FAILED because their regex matched their own
 * explanatory comment — the tell that the assertion was about prose rather than behavior.
 *
 * Eleven files were converted over 2026-09-15 and the money paths now execute. The thing that
 * rots is the NEXT file: writing a regex is faster than building a harness, always, and nothing
 * notices for months. So this file is the ratchet.
 *
 * WHAT IT ASKS. Every tests/*_test.js either
 *   · EXECUTES engine or page code — it requires ./_gas, or assembles source with new Function/vm —
 *   · or carries the line `SOURCE-SHAPED:` in its header, followed by the reason,
 *   · or is a verbatim shared test from gx-theme, whose header says where it came from — see SHARED
 *     below, and note that the declaration is then core-admin's to write, not ours.
 *
 * The marker is not a loophole, it is the point: a file that cannot run its subject should say so
 * where the next reader will see it, rather than looking like coverage. Three shapes legitimately
 * cannot run here and all three are declared below — a static analyzer over the source, markup and
 * click wiring that needs a browser, and an architecture guard whose whole claim is that something
 * is ABSENT from a file, which no amount of execution can show.
 *
 * It deliberately does NOT count assertions or enforce a ratio. A number would be gamed by adding
 * cheap executed checks; what matters is that a file has a harness at all, or has been made to
 * argue for why it does not.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => /_test\.js$/.test(f) && f !== path.basename(__filename)).sort();

/* Reading the file is fine HERE: the subject of this test is the suite's own shape, which is a
   fact about the files. It is the one place where source text is the thing being measured. */
const EXECUTES = /require\(['"]\.\/_gas['"]\)|new Function\(|require\(['"]vm['"]\)|vm\.run/;
const MARKER = /SOURCE-SHAPED:\s*\S/;
/* A THIRD WAY TO BE DECLARED: the file is a verbatim copy of a gx-theme shared test, and its shape
   is not this repo's decision to make.
 *
 * `tests/exit_scrub_test.js` is the case. It is a static analyzer — it finds every reply and every
 * mail exit in the engine and asks whether that one scrubs — so it genuinely cannot run its subject,
 * which is the shape the marker exists to declare, and its own header says so at length. What it
 * does not carry is the literal token, because the file belongs to core-admin: five apps run the
 * same copy and editing ours would fork a test whose whole value is that every app runs the same one.
 *
 * MATCHED ON THE PROVENANCE LINE, NOT ON A FILENAME. A name list would exempt whatever anybody
 * later called `exit_scrub_test.js`; this exempts a file that states upstream ownership in its
 * header, which is the thing that makes the marker somebody else's to add. Asked of core-admin
 * 2026-09-17 — when the token lands upstream this clause can go, and nothing breaks if it does. */
const SHARED = /synced from greencross-gx-theme\//;

const silent = [];
files.forEach(f => {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (EXECUTES.test(src) || MARKER.test(src) || SHARED.test(src)) return;
  silent.push(f);
});
ok('every test file runs the code, or says in its header why it cannot' +
   (silent.length ? ' — ' + silent.join(', ') : ''), silent.length === 0);

/* A marker with no reason after it is the loophole this would otherwise open. */
const bare = [];
files.forEach(f => {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = /SOURCE-SHAPED:([^\n]*)/.exec(src);
  if (m && m[1].trim().length < 20) bare.push(f);
});
ok('a declared file gives a real reason, not the marker on its own' +
   (bare.length ? ' — ' + bare.join(', ') : ''), bare.length === 0);

/* The harness is required, not optional: it exists so the next conversion does not hand-roll a
   fifth in-memory sheet. */
ok('the shared harness is still here for the next one', fs.existsSync(path.join(dir, '_gas.js')));
const users = files.filter(f => /require\(['"]\.\/_gas['"]\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
ok('  …and is what the converted files are built on', users.length >= 15);

/* The suite is what the pre-push hook runs, so a file that cannot be parsed at all is worse than a
   weak one: it takes the gate down with it. Wrapped in an async function and stripped of its
   shebang — several of these await at the top level, which is legal in a module and not inside a
   bare Function body, and failing them for that would be this file crying about syntax it chose. */
const broken = files.filter(f => {
  const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^#![^\n]*\n/, '');
  try { new Function('return (async () => {\n' + src + '\n})'); return false; }
  catch (e) { return true; }
});
ok('every test file at least parses' + (broken.length ? ' — ' + broken.join(', ') : ''),
   broken.length === 0);

console.log('\n  ' + files.length + ' test files · ' + users.length + ' on the shared harness');
console.log(fail ? '\n' + fail + ' FAILED' : '\nsuite shape: all passed');
process.exit(fail ? 1 : 0);
