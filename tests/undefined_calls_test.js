/* Every function spiff.js calls must be one it defines.
 *
 * WHY THIS EXISTS: a large block edit deleted pullReference()/pullReferenceFor() while leaving
 * the calls behind. The result was invisible — no console error the user would see, no failed
 * request to notice, the Calculator simply never pulled reference units and showed the
 * previously-saved numbers instead, which look exactly like a successful pull. It was found
 * only by checking the network tab for a request that was never made.
 *
 * A ReferenceError inside an async callback is silent in exactly this way, so "it would have
 * thrown" is not the safety net it sounds like.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');

/* Strip strings and comments first: a call written inside a template or a comment is not a
   call, and counting one would produce a failure nobody can act on. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

const declared = new Set();
for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/g)) declared.add(m[1]);
/* Object-literal methods (`api.close = ...`, `{ foo: function () {} }`) and any local binding
   are out of scope — this test is about TOP-LEVEL helpers, which is where the deletion class
   of bug lands. */
for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
/* Parameters of BOTH anonymous and named functions. Missing the named form flagged
   pullStore's own `onPartial` callback parameter as an undefined call. */
for (const m of code.matchAll(/function\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
  m[1].split(',').forEach(a => { const n = a.trim().split('=')[0].trim(); if (n) declared.add(n); });
}
/* Arrow-function params, single or parenthesised. */
for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
  m[1].split(',').forEach(a => { const n = a.trim().split('=')[0].trim(); if (n) declared.add(n); });
}
for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);

/* Globals a browser hands us, plus the shared GX layer. Anything NOT here and not declared is
   a call into thin air. */
const GLOBALS = new Set([
  'if','for','while','switch','catch','return','typeof','function','new','do','else','await',
  'Object','Array','String','Number','Boolean','Math','JSON','Date','Promise','RegExp','Error','Set','Map',
  'parseInt','parseFloat','isNaN','encodeURIComponent','decodeURIComponent','setTimeout','clearTimeout',
  'setInterval','clearInterval','alert','confirm','fetch','document','window','console','navigator',
  'sessionStorage','localStorage','requestAnimationFrame','KeyboardEvent','MouseEvent','Event','URL','Blob',
  'GXClient','GXTopNav','GXStores','GXAvatar','GXSession','GXChangelog','GXBugReport','GXDev','GXUpdateCheck',
]);

const called = new Map();
for (const m of code.matchAll(/(?:^|[^\w$.])([a-z_$][\w$]*)\s*\(/g)) {
  if (!called.has(m[1])) called.set(m[1], (code.slice(0, m.index).match(/\n/g) || []).length + 1);
}

const missing = [];
for (const [name, line] of called) {
  if (declared.has(name) || GLOBALS.has(name)) continue;
  missing.push(`${name}() called at ~line ${line} but never defined`);
}

if (missing.length) {
  console.error('undefined calls: FAILED');
  missing.forEach(m => console.error('  ✗ ' + m));
  process.exit(1);
}
console.log(`undefined calls: ${called.size} call sites checked against ${declared.size} bindings — all resolve`);
