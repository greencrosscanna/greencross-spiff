/* ─── The shared harness: run the ENGINE's own code in node ──────────────────────────────────────
 *
 * Not a test. Required by the test files that execute Code.gs functions instead of reading them.
 *
 * WHY IT EXISTS. Half this suite was checking that code LOOKED right — that a call appears, that a
 * string is present — which proves a line exists and nothing about what it returns. The files that
 * DO run code (progress_cache, payout_math, status_roll, window_and_goal) each hand-rolled the same
 * three things first: a grab() that lifts a function out of Code.gs by name, an in-memory sheet,
 * and stubs for the Apps Script globals. Four copies is how they drift; a fifth was about to be
 * written for the delete and rename routes, which is what prompted this.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not fake the thing under test. A route is assembled
 * from its REAL source with its collaborators stubbed at the edges — the sheet, the clock, GX Core
 * — so what runs is the shipped code path, not a restatement of it in the test. A test that mirrors
 * the logic it is checking passes when the app breaks; see the note in client_view_test.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const GS = fs.readFileSync(GS_PATH, 'utf8');

/* Lift one function's source out of the engine, braces balanced. Anchored to the start of a line so
   `function deleteProgram_` cannot match `window.deleteProgram_` or a mention inside a comment. */
function grab(name, src) {
  const s = src || GS;
  const i = s.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('_gas.grab: no such function in Code.gs: ' + name);
  let d = 0;
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (!d) return s.slice(i, k + 1); }
  }
  throw new Error('_gas.grab: unbalanced braces in ' + name);
}

/* A top-level `var NAME = <literal>;` read as a VALUE — PROGRAM_HEADERS, EDIT_ROLES and friends.
   Read rather than copied: a header list copied into a test is a list that stops matching the
   sheet, and every row index in these routes is computed from it. */
function grabVar(name, src) {
  const s = src || GS;
  const m = s.match(new RegExp('\\nvar ' + name + '\\s*=\\s*([\\s\\S]*?);[^\\n]*\\n'));
  if (m) {
    /* Comments come out first: several of these declarations carry a block comment inside the
       literal (PROGRAM_HEADERS explains four of its columns) or a line comment after the
       semicolon, and both are syntax errors once the text is re-evaluated on its own. */
    /* The line-comment strip requires whitespace or a separator in front of the slashes, or it
       would swallow the rest of a URL: LOGO_ONLIGHT is 'https://…', and `//` there is the value. */
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
                     .replace(/(^|[\s;,)\]}])\/\/[^\n]*/g, '$1');
    return new Function('return ' + body + ';')();
  }
  /* A second declarator on one line — `var PITCH_MAX_TIPS = 5, PITCH_MAX_LEN = 240;`. Narrowed to a
     simple literal on purpose: anything with a comma inside it (an array, an object) has to be
     declared on its own line to be read here, rather than guessed at by counting brackets. */
  const one = s.match(new RegExp('[,\\s]' + name + '\\s*=\\s*([^,;\\n]+)[,;]'));
  if (one) return new Function('return ' + one[1] + ';')();
  throw new Error('_gas.grabVar: no such var in Code.gs: ' + name);
}

/* ── An in-memory Sheet ──────────────────────────────────────────────────────────────────────────
   Enough of the SpreadsheetApp surface for the routes that read a tab, write a cell, append a row
   and delete a row. Row and column numbers are 1-based, as they are in Apps Script: an off-by-one
   here would make a test agree with a bug. */
function makeSheet(headers, rows) {
  return {
    name: '(sheet)',
    rows: [(headers || []).slice()].concat((rows || []).map(r => r.slice())),
    getName() { return this.name; },
    getLastRow() { return this.rows.length; },
    getLastColumn() { return (this.rows[0] || []).length; },
    getMaxRows() { return Math.max(this.rows.length, 1); },
    getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
    appendRow(row) { this.rows.push(row.slice()); return this; },
    deleteRow(n) { this.rows.splice(n - 1, 1); return this; },
    setFrozenRows() { return this; },
    getRange(r, c, nr, nc) {
      const s = this;
      if (nr === undefined) { nr = 1; nc = 1; }
      if (nc === undefined) nc = 1;
      return {
        setValue(v) { return this.setValues([[v]]); },
        setValues(vals) {
          vals.forEach((row, i) => {
            const y = r - 1 + i;
            while (s.rows.length <= y) s.rows.push([]);
            const t = s.rows[y];
            while (t.length < c - 1) t.push('');
            row.forEach((v, j) => { t[c - 1 + j] = v; });
          });
          return this;
        },
        getValues() { return s.rows.slice(r - 1, r - 1 + nr).map(x => {
          const out = x.slice(c - 1, c - 1 + nc);
          while (out.length < nc) out.push('');
          return out;
        }); },
        setNumberFormat() { return this; },
        setFontWeight() { return this; },
      };
    },
  };
}

/* The spreadsheet a route reaches through dataSheet_().getParent(): enough for deletedSheet_ to
   find or create the tombstone tab. */
function makeBook(tabs) {
  const book = {
    sheets: Object.assign({}, tabs || {}),
    getSheetByName(n) { return this.sheets[n] || null; },
    insertSheet(n) { const sh = makeSheet([]); sh.name = n; this.sheets[n] = sh; return sh; },
  };
  Object.keys(book.sheets).forEach(n => { book.sheets[n].getParent = () => book; });
  const insert = book.insertSheet.bind(book);
  book.insertSheet = (n) => { const sh = insert(n); sh.getParent = () => book; return sh; };
  return book;
}

/* ── The Apps Script globals ─────────────────────────────────────────────────────────────────────
   Utilities.formatDate honors BOTH arguments deliberately: a mock that ignored the timezone would
   pass straight through the day-shifting bug the suite's date convention exists to prevent. */
const Utilities = {
  formatDate(d, tz, fmt) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    const day = `${p.year}-${p.month}-${p.day}`;
    if (fmt === 'yyyy-MM-dd') return day;
    /* The vendor PDF's filename follows the close-out folder's own precedent,
       "SPIFF_Sales Report - <Vendor> - MMDDYY.pdf", so this format is load-bearing rather than
       decorative: getting it wrong files the report under a name nobody looks for. */
    if (fmt === 'MMddyy') return `${p.month}${p.day}${p.year.slice(2)}`;
    return `${day} ${p.hour}:${p.minute}:${p.second}`;
  },
  sleep() {},
  getUuid() { return 'uuid-0000'; },
};

/* A cache that really stores, so "the write busts the cache" is a fact about behavior rather than
   about a line of source. `removed` records what a route cleared. */
function makeCache() {
  const store = {}, removed = [];
  const cache = {
    get: (k) => (k in store ? store[k] : null),
    put: (k, v) => { store[k] = v; },
    remove: (k) => { removed.push(k); delete store[k]; },
  };
  return { store, removed, CacheService: { getScriptCache: () => cache, getUserCache: () => cache } };
}

function makeProps(props) {
  const p = Object.assign({}, props || {});
  const api = {
    getProperty: (k) => (k in p ? p[k] : null),
    setProperty: (k, v) => { p[k] = v; return api; },
    deleteProperty: (k) => { delete p[k]; return api; },
    getProperties: () => Object.assign({}, p),
  };
  return { props: p, PropertiesService: { getScriptProperties: () => api, getUserProperties: () => api } };
}

/* ── Assemble a runnable slice of the engine ─────────────────────────────────────────────────────
 *
 *   load({
 *     real:   ['deleteProgram_', 'programToRow_'],   // lifted from Code.gs, VERBATIM
 *     vars:   ['PROGRAM_HEADERS', 'EDIT_ROLES'],     // read from Code.gs, or {NAME: value} to pin one
 *     stubs:  { dataSheet_: () => sheet },           // the edges: sheet, clock, GX Core
 *     globals:{ CacheService, PropertiesService },   // extra Apps Script globals
 *   })  ->  { deleteProgram_, programToRow_, ... }
 *
 * A stub is a real JS function living in the test, called through a thin shim, so a test can spy on
 * calls and their ORDER without the engine knowing it is being watched.
 */
function load(opts) {
  const o = opts || {};
  const stubs = o.stubs || {};
  const varDecls = [];
  const wanted = [];

  (o.vars || []).forEach(v => {
    if (typeof v === 'string') varDecls.push('var ' + v + ' = ' + JSON.stringify(grabVar(v)) + ';');
  });
  Object.keys(o.varValues || {}).forEach(k => {
    varDecls.push('var ' + k + ' = ' + JSON.stringify(o.varValues[k]) + ';');
  });

  const shims = Object.keys(stubs).map(n =>
    'function ' + n + '() { return __S.' + n + '.apply(this, arguments); }');

  const reals = (o.real || []).map(n => { wanted.push(n); return grab(n); });

  const src = [
    '"use strict";',
    varDecls.join('\n'),
    shims.join('\n'),
    reals.join('\n\n'),
    'return { ' + wanted.map(n => n + ': ' + n).join(', ') + ' };',
  ].join('\n');

  const globals = Object.assign({ Utilities }, o.globals || {});
  const names = ['__S'].concat(Object.keys(globals));
  const vals = [stubs].concat(Object.keys(globals).map(k => globals[k]));
  try {
    return new Function(names.join(','), src).apply(null, vals);
  } catch (e) {
    throw new Error('_gas.load: could not assemble [' + wanted.join(', ') + '] — ' + e.message);
  }
}

/* A recorder for call ORDER across stubs — "the copy was written before the row went" is an
   ordering claim, and ordering is exactly what a source-text check can only guess at. */
function trace() {
  const calls = [];
  return {
    calls,
    wrap(name, fn) { return function () { calls.push(name); return fn ? fn.apply(this, arguments) : undefined; }; },
    names() { return calls.slice(); },
    before(a, b) { return calls.indexOf(a) >= 0 && calls.indexOf(b) >= 0 && calls.indexOf(a) < calls.indexOf(b); },
  };
}

module.exports = { GS, grab, grabVar, makeSheet, makeBook, makeCache, makeProps, Utilities, load, trace };
