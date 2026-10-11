#!/usr/bin/env node
/* ─── No function name is declared twice in one scope ─────────────────────────────────────────────
 *
 *   RUN:  node tests/duplicate_functions_test.js
 *
 * SOURCE-SHAPED: by nature — it is a STATIC ANALYZER. The defect it guards is not a wrong answer
 * from a function, it is which function a NAME resolves to, and that is a fact about the source.
 *
 * WHY
 * Function declarations hoist, and when one scope declares a name twice the LATER declaration
 * replaces the earlier one for every caller in that scope — silently, in every browser, with no
 * error at load and nothing in the console. spiff.js did it twice:
 *
 *   copyText (found 2026-10-10, live)   `copyText(text)` → Promise<boolean>, and 3,000 lines later
 *       `copyText(text, btn, label)` beside the gift-card buy list. Every Copy button that awaited
 *       the first was calling the second: it got undefined ("Copy failed") while the link had
 *       usually reached the clipboard. Sky found it on a kiosk link.
 *   daysBetween (found the same day)    two bodies that agree on every well-formed date and differ
 *       on a missing or malformed one (NaN against 0). The later one had been winning; the earlier
 *       was dead. Removed in v1.460 with no change to any result.
 *
 * Neither failed a test, because each test lifts ONE function out of the file by name and runs it —
 * which finds the first declaration, the one the page never calls.
 *
 * HOW IT TELLS SCOPES APART, AND WHERE THAT STOPS. It walks the source with comments, strings,
 * template literals and regex literals skipped, keeping a stack of open `{`. A declaration's scope
 * is the innermost `{ … }` it sits directly inside (the file itself at depth 0). Two declarations
 * of one name in the SAME block are flagged. The same name in different blocks is legal and is not
 * flagged — a helper called `row` nested in two different functions is two functions. That means
 * one real case is NOT caught: the same name declared in two sibling blocks of one function (inside
 * two different `if`s, say), where sloppy-mode hoisting can still collide. Neither file does that
 * today; the limit is stated rather than guessed around. A `function name(` that is an EXPRESSION
 * (after `=`, `(`, `,`, `:`, `return` …) binds nothing in the enclosing scope and is ignored.
 *
 * The walker checks itself first (section 0) and refuses to pass a file it cannot balance: a
 * scanner that lost its place would report "no duplicates" for any file at all.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const EXPR_PREV_CHARS = '=(,:?!&|+-*/%<>~^[';
const EXPR_PREV_WORDS = ['return', 'typeof', 'new', 'void', 'delete', 'in', 'of', 'case', 'throw', 'yield', 'await', 'default'];
const REGEX_PREV_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PREV_WORDS = ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'];

/* → { decls: [{name, scope, line}], balanced: bool } */
function scan(src) {
  const decls = [];
  const stack = [];                 // positions of open braces; scope id = top of stack, or 0
  let i = 0, line = 1;
  let lastSig = '', lastWord = '', prevSigBeforeWord = '';
  const n = src.length;
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = src[i], two = src.substr(i, 2);
    if (c === '\n') { line++; i++; continue; }
    if (two === '//') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (two === '/*') {
      const j = src.indexOf('*/', i + 2), end = j < 0 ? n : j + 2;
      line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') line++; j++; }
      i = j + 1; lastSig = c; lastWord = ''; continue;
    }
    if (c === '/' && (lastSig === '' || REGEX_PREV_CHARS.indexOf(lastSig) >= 0 || REGEX_PREV_WORDS.indexOf(lastWord) >= 0)) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      i = j + 1; lastSig = '/'; lastWord = ''; continue;
    }
    if (isId(c)) {
      let j = i; while (j < n && isId(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'function') {
        /* What stood before `function` (looking through an `async` in front of it). */
        const before = lastWord === 'async' ? { ch: prevSigBeforeWord, word: '' } : { ch: lastSig, word: lastWord };
        const m = /^\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j, j + 200));
        const isExpr = EXPR_PREV_CHARS.indexOf(before.ch) >= 0 && before.ch !== ''
                    || EXPR_PREV_WORDS.indexOf(before.word) >= 0;
        if (m && !isExpr) decls.push({ name: m[1], scope: stack.length ? stack[stack.length - 1] : 0, line: line });
      }
      prevSigBeforeWord = lastSig;
      lastWord = word; lastSig = word[word.length - 1]; i = j; continue;
    }
    if (c === '{') stack.push(i + 1);
    else if (c === '}') stack.pop();
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }
  return { decls: decls, balanced: stack.length === 0 };
}

/* → [{name, lines: [..]}] for names declared more than once in one scope */
function duplicates(src) {
  const r = scan(src), by = {};
  r.decls.forEach(d => { const k = d.scope + '\u0000' + d.name; (by[k] = by[k] || []).push(d); });
  return {
    balanced: r.balanced, count: r.decls.length,
    dups: Object.keys(by).filter(k => by[k].length > 1)
      .map(k => ({ name: by[k][0].name, lines: by[k].map(d => d.line) })),
  };
}

/* ══ 0. the walker, checked against cases with known answers ══ */
console.log('\n0. the walker flags what it should and nothing else');
const names = (src) => duplicates(src).dups.map(d => d.name).sort().join(',');
ok('two declarations in one scope are flagged',
   names('function a(){}\nfunction b(){}\nfunction a(x){}') === 'a');
ok('  …with both line numbers', JSON.stringify(duplicates('function a(){}\n\nfunction a(){}').dups[0].lines) === '[1,3]');
ok('the same inside an IIFE, which is how spiff.js is built',
   names('(function(){\n  function a(){}\n  async function a(){}\n})();') === 'a');
ok('the same name nested in two DIFFERENT functions is legal and not flagged',
   names('function one(){ function row(){} }\nfunction two(){ function row(){} }') === '');
ok('an inner function sharing its outer function\'s name is not flagged',
   names('function a(){ function a(){} }') === '');
ok('a named function EXPRESSION binds nothing and is not flagged',
   names('function a(){}\nvar x = function a(){};\nfoo(function a(){});\nvar o = { k: function a(){} };') === '');
ok('`return function a(){}` is an expression too', names('function a(){ return function a(){}; }') === '');
ok('a declaration inside a comment or a string is ignored',
   names('function a(){}\n// function a(){}\n/* function a(){} */\nvar s = "function a(){}", t = \'function a(){}\';') === '');
ok('braces inside strings, templates and regex literals do not move the scope',
   names('function f(){ var s = "}{", t = `}{`, r = /[{}]\\//.test(s); }\nfunction g(){}\nfunction g(){}') === 'g');
ok('a comment containing an apostrophe does not swallow the code after it',
   names('// it\'s fine\nfunction a(){}\nfunction a(){}') === 'a');
ok('unbalanced source is reported as such, not passed', duplicates('function a(){').balanced === false);

/* ══ 1 and 2. the shipped files ══ */
function check(label, rel) {
  const file = path.join(__dirname, '..', rel);
  const text = fs.readFileSync(file, 'utf8');
  const r = duplicates(text);
  /* An independent count the walker cannot fool: lines that simply BEGIN `function name(`. It
     over-counts by any such line inside a comment, so the walker must land within 10% below it —
     a walker that lost its place inside a string or a regex would miss far more than that, and
     would otherwise report a clean file by not looking at most of it. */
  const byLine = text.split('\n').filter(l => /^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)).length;
  console.log('\n' + label + ' — ' + r.count + ' function declarations scanned (' + byLine + ' by plain line count)');
  ok(rel + ' parses to balanced braces (otherwise the scan proves nothing)', r.balanced);
  ok(rel + ': the walker saw the declarations a plain line count sees', byLine > 0 && r.count >= byLine * 0.9 && r.count <= byLine * 1.1 + 2);
  ok('no function name is declared twice in one scope in ' + rel
     + (r.dups.length ? ' — FOUND: ' + r.dups.map(d => d.name + ' (lines ' + d.lines.join(', ') + ')').join('; ') : ''),
     r.dups.length === 0);
}
check('1. spiff.js', 'spiff.js');
check('2. apps-script/Code.gs', 'apps-script/Code.gs');
/* The other pages are small and separate files, but the same trap is open in each. */
['client.js', 'flyer.js', 'store.js'].forEach((f, i) => check((3 + i) + '. ' + f, f));

console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
process.exit(fail ? 1 : 0);
