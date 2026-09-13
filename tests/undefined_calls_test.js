/* Every function the app calls must be one it defines — checked in BOTH halves.
 *
 * WHY THIS EXISTS: a large block edit deleted pullReference()/pullReferenceFor() while leaving
 * the calls behind. The result was invisible — no console error the user would see, no failed
 * request to notice, the Calculator simply never pulled reference units and showed the
 * previously-saved numbers instead, which look exactly like a successful pull. It was found
 * only by checking the network tab for a request that was never made.
 *
 * A ReferenceError inside an async callback is silent in exactly this way, so "it would have
 * thrown" is not the safety net it sounds like.
 *
 * IT COVERS apps-script/Code.gs SINCE 2026-09-12, and until then it did not — it read spiff.js
 * and nothing else. That gap was found while deleting the orphaned Calculator-importer island
 * from the engine (parseCalcTab_ and the ten functions reachable only through it). Deleting a
 * function whose last caller just went is the SAME bug this file was written for, pointed at the
 * other half of the app, and the engine half is worse: an Apps Script ReferenceError surfaces as
 * a JSONP call that returns an error object the UI renders as an empty state. Nothing in the
 * suite would have caught a wrong cut — every other engine test either evaluates Code.gs (which
 * only catches a SYNTAX error, not a missing callee on a branch nobody ran) or reads it as text
 * looking for a specific pattern.
 *
 * THE TOKENIZER IS NOT OPTIONAL, and a naive strip-with-regex is actively dangerous here. Code.gs
 * contains regex literals holding quote characters — `/['"]/`-shaped things. A stripper that
 * treats the first `'` it sees as a string opener swallows the rest of the file as one long
 * string, after which EVERY declaration past that point vanishes and every call in it reads as
 * undefined... or, far worse, reads as clean, depending on which side of the swap you are on.
 * That exact failure produced a confident, wrong answer during the 2026-09-12 cleanup: a naive
 * scan reported norm_ and doPost as dead. norm_ has two live callers in clientView_; doPost is
 * an entry point Google calls by name. Both would have been deleted on that evidence.
 * So: scan with a real tokenizer that knows regex-vs-division, and assert line alignment survives
 * it — a stripper that collapses newlines reports every line number wrong, which is how the same
 * bug hid the first time.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ── one tokenizer, two subjects ─────────────────────────────────────────────────────────────
   Blanks out comments and string/regex CONTENT while preserving every newline, so line numbers
   in a failure point at the real line. Regex-vs-division is decided by the previous significant
   token, the same way a JS parser does it. */
function blankOut(src) {
  let out = '', i = 0, prev = '';
  const n = src.length;
  const regexCanFollow = (t) => t === '' || /[({[,;:!&|?+\-*/%=~^<>]$/.test(t) ||
    /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(t);

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }

    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++; prev = 'X'; continue;
    }

    if (c === '/' && regexCanFollow(prev)) {
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') { j += 2; continue; }
        if (e === '\n') break;
        if (e === '[') inClass = true;
        else if (e === ']') inClass = false;
        else if (e === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        let k = j + 1;
        while (k < n && /[gimsuy]/.test(src[k])) k++;
        out += ' '.repeat(k - i); i = k; prev = 'X'; continue;
      }
    }

    out += c;
    if (!/\s/.test(c)) prev = (prev + c).slice(-12);
    i++;
  }
  return out;
}

function bindingsIn(code) {
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
  /* Arrow-function params, single or parenthesized. */
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    m[1].split(',').forEach(a => { const n = a.trim().split('=')[0].trim(); if (n) declared.add(n); });
  }
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  return declared;
}

const KEYWORDS = [
  'if','for','while','switch','catch','return','typeof','function','new','do','else','await','throw',
];
const STDLIB = [
  'Object','Array','String','Number','Boolean','Math','JSON','Date','Promise','RegExp','Error','Set','Map',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
];
/* Globals a browser hands us, plus the shared GX layer. */
const BROWSER = [
  'setTimeout','clearTimeout','setInterval','clearInterval','alert','confirm','fetch','document','window',
  'console','navigator','sessionStorage','localStorage','requestAnimationFrame','KeyboardEvent','MouseEvent',
  'Event','URL','Blob',
  'GXClient','GXTopNav','GXStores','GXAvatar','GXSession','GXChangelog','GXBugReport','GXDev','GXUpdateCheck',
];
/* Globals Apps Script hands the engine, plus the bound GX Core library. */
const APPS_SCRIPT = [
  'SpreadsheetApp','DriveApp','DocumentApp','UrlFetchApp','Utilities','PropertiesService','ScriptApp',
  'Session','LockService','HtmlService','ContentService','CacheService','MailApp','GmailApp','Logger',
  'GXCore',
];

const SUBJECTS = [
  { file: 'spiff.js',             globals: [...KEYWORDS, ...STDLIB, ...BROWSER] },
  { file: 'apps-script/Code.gs',  globals: [...KEYWORDS, ...STDLIB, ...APPS_SCRIPT] },
];

let failed = false;

for (const subject of SUBJECTS) {
  const src = fs.readFileSync(path.join(__dirname, '..', subject.file), 'utf8');
  const code = blankOut(src);

  /* A stripper that eats newlines reports every line number wrong and, worse, makes the
     containment checks built on those numbers silently meaningless. Assert it, don't hope. */
  if (code.split('\n').length !== src.split('\n').length) {
    console.error(`${subject.file}: FAILED — tokenizer changed the line count, every line number below would be wrong`);
    process.exit(1);
  }

  const declared = bindingsIn(code);
  const globals = new Set(subject.globals);

  const called = new Map();
  for (const m of code.matchAll(/(?:^|[^\w$.])([a-z_$][\w$]*)\s*\(/g)) {
    if (!called.has(m[1])) called.set(m[1], (code.slice(0, m.index).match(/\n/g) || []).length + 1);
  }

  const missing = [];
  for (const [name, line] of called) {
    if (declared.has(name) || globals.has(name)) continue;
    missing.push(`${name}() called at ~line ${line} but never defined`);
  }

  if (missing.length) {
    console.error(`undefined calls in ${subject.file}: FAILED`);
    missing.forEach(m => console.error('  ✗ ' + m));
    failed = true;
  } else {
    console.log(`undefined calls in ${subject.file}: ${called.size} call sites checked against ${declared.size} bindings — all resolve`);
  }
}

if (failed) process.exit(1);

/* A continuation line starting with `+` inside an ARGUMENT list is unary plus, not concatenation:
 *   fig('Sold', x,
 *   +     'of ' + n)      →  +('of ' + n)  →  NaN
 * It parses, it runs, and it renders "NaN" into the page. Cost two rounds here, both times while
 * splitting a long fig()/pbig() call across lines. Front end only — it is a rendering bug.
 */
const doublePlus = [];
fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8').split('\n').forEach((ln, i) => {
  if (/^\s*\+\s+\+/.test(ln)) doublePlus.push(`line ${i + 1}: ${ln.trim().slice(0, 70)}`);
});
if (doublePlus.length) {
  console.error('unary-plus concat: FAILED');
  doublePlus.forEach(d => console.error('  ✗ ' + d));
  process.exit(1);
}
console.log('unary-plus concat: no `+ +` continuations');
