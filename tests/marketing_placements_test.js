#!/usr/bin/env node
/* ─── Featured placements are a list, and each one reaches the Tasks section ──────────────────────
 *
 *   RUN:  node tests/marketing_placements_test.js
 *
 * Tawny's bug (2026-11-03): "Featured placement set is not showing both options" — Featured Case and
 * Daily Buzz. Sky: several placements per program, and each one populates down to the to-do list.
 * marketing.js is loaded through vm exactly as on the page; tasksOf / groupTasks / sectionHtml RUN.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const c = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), c);
const MK = c.SpiffMarketing;

const STORES = ['bend', 'center', 'commercial'].map(s => ({ store_id: s, name: s }));
const prog = (rows, done) => ({
  program_id: 'kap', vendor: 'Kaprikorn', program_name: 'All', status: 'active',
  start_date: '2026-10-12', end_date: '2026-10-25', stores_json: ['bend', 'center'],
  marketing_json: { sel: { 'case': true }, rows: { 'case': rows }, done: done || {} },
});
const sets = (p) => MK.tasksOf(p, {}).filter(t => t.id === 'case.set');

console.log('\n1. the picker offers both placements and adds them');
{
  const sec = MK.sectionHtml(prog([]), { today: '2026-10-14', canEdit: true, offset: 0, stores: STORES, storeName: s => s, engineReady: true });
  ok('a Featured Case button', /data-mk-radd="case" data-mk-rpreset="Featured Case"/.test(sec));
  ok('a Daily Buzz button', /data-mk-radd="case" data-mk-rpreset="Daily Buzz"/.test(sec));
  ok('and a free-text Add for any other', /\+ Add another placement/.test(sec));
  const op = MK.addRowOp(prog([{ text: 'Featured Case', stores: [] }]), 'case', 'Daily Buzz');
  const rows = JSON.stringify(op);
  ok('adding a preset appends a row carrying its name', /Featured Case/.test(rows) && /Daily Buzz/.test(rows));
}

console.log('\n2. each placement becomes its own to-do, per store');
{
  const p = prog([{ text: 'Featured Case', stores: [] }, { text: 'Daily Buzz', stores: [] }]);
  const t = sets(p);
  ok('two placements x two stores = four set ticks', t.length === 4);
  ok('keys: first placement keeps the plain key, second gets .2',
     t.map(x => x.key).sort().join('|') === 'case.set@bend|case.set@bend.2|case.set@center|case.set@center.2');
  ok('the label rides on the task text', t.some(x => x.text === 'Featured placement set – Daily Buzz'));
  const g = MK.groupTasks(MK.tasksOf(p, {})).filter(x => x.id === 'case.set');
  ok('the to-do list shows one line per placement', g.length === 2);
  ok('the back-to-normal tasks follow the same way', MK.tasksOf(p, {}).filter(x => x.id === 'case.reset').length === 4);
}

console.log('\n3. stores, ticks and old plans');
{
  const p = prog([{ text: 'Featured Case', stores: ['center'] }, { text: 'Daily Buzz', stores: [] }]);
  const keys = sets(p).map(x => x.key).sort().join('|');
  ok('a placement naming a store runs only there; one naming none runs everywhere',
     keys === 'case.set@bend|case.set@center|case.set@center.2');
  const old = prog([{ text: 'Front case', stores: ['center'] }], { 'case.set@center': { by: 'tawny', at: '2026-10-13' } });
  const s = sets(old);
  ok('a plan saved before placements keeps its tick on the same key', s.length === 1 && s[0].key === 'case.set@center' && !!s[0].done);
  const relabeled = prog([{ text: 'Renamed', stores: [] }, { text: 'Daily Buzz', stores: [] }]);
  ok('editing a label does not move any key',
     sets(relabeled).map(x => x.key).sort().join('|') === sets(prog([{ text: 'A', stores: [] }, { text: 'B', stores: [] }])).map(x => x.key).sort().join('|'));
  const none = sets(prog([]));
  ok('no placement yet: every plan store, plain task text', none.length === 2 && none[0].text === 'Featured placement set');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
