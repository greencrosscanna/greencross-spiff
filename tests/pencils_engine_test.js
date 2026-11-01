#!/usr/bin/env node
/* ─── Penciled brands, run through the engine's real routes ───────────────────────────────────────
 *
 *   RUN:  node tests/pencils_engine_test.js
 *
 * savePencil_, releasePencil_, lockPencil_ and pencilsRead_ run from their real source with the sheets,
 * the clock and GX Core stubbed at the edges. What is checked:
 *   · only an editor session writes anything;
 *   · a pencil is whole pay periods, first start to last end;
 *   · a pencil lives in its own tab and a lock-in is a DRAFT program with nothing owed;
 *   · a start date that has passed does nothing: the route never looks at the clock.
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PH = G.grabVar('PROGRAM_HEADERS');
const PEN_H = G.grabVar('PENCIL_HEADERS');
const pcol = (n) => PEN_H.indexOf(n);
const col = (n) => PH.indexOf(n);

function engine(role, today) {
  const programs = G.makeSheet(PH, []);
  const book = G.makeBook({ programs });
  programs.getParent = () => book;
  const auth = { ok: true, user: 'tawny', role: role || 'editor' };
  const api = G.load({
    real: ['pencilSheet_', 'rowToPencil_', 'readPencils_', 'pencilsRead_', 'periodEndOf_', 'pencilWindowError_',
           'pencilEditor_', 'findPencilRow_', 'closePencil_', 'savePencil_', 'releasePencil_', 'lockPencil_',
           'periodStartFor_', 'createProgram_', 'createIsReplay_', 'canonJson_', 'getProgram_', 'listPrograms_',
           'saveProgram_', 'programToRow_', 'rowToProgram_', 'normalizeMarketing_', 'normalizePitch_', 'parseJson_',
           'textDate_', 'slug_', 'stripDerivedActuals_'],
    vars: ['PENCILS_TAB', 'PENCIL_HEADERS', 'PROGRAM_HEADERS', 'EDIT_ROLES'],
    stubs: {
      dataSheet_: () => programs,
      gxAuth_: (t) => (t === 'good' ? auth : { ok: false, error: 'bad token' }),
      payPeriodCfg_: () => ({ anchor: '2026-05-11', days: 14 }),
      nowStamp_: () => (today || '2026-10-14') + ' 09:00:00',
      today_: () => today || '2026-10-14',
      annotateActuals_: () => {}, annotateUnmeasurable_: () => {},
      invalidatePrograms_: () => {}, brandMatchCheck_: () => ({ checked: false }),
      measurementInvalidatedBy_: () => [], dropProgressRows_: () => 0,
    },
    globals: { console: { warn() {}, log() {} } },
  });
  return { api, programs, book };
}
const pencilRows = (e) => (e.book.getSheetByName('pencils') ? e.book.getSheetByName('pencils').rows.slice(1) : []);

/* 2026-05-11 + 14k days: Oct 12 starts a period, Oct 25 ends it, Nov 8 ends the next. */
const W = { start_date: '2026-11-09', end_date: '2026-11-22' };

console.log('\n1. only an editor writes');
{
  const e = engine('viewer');
  for (const [name, args] of [['savePencil_', Object.assign({ token: 'good', brand: 'Wyld' }, W)],
                              ['releasePencil_', { token: 'good', id: 'x' }], ['lockPencil_', { token: 'good', id: 'x' }]]) {
    const r = e.api[name](args);
    ok(name + ': a viewer is refused', r.ok === false && /cannot/.test(r.error));
  }
  ok('  …and nothing was written, not even the tab', pencilRows(e).length === 0);
  const r = e.api.savePencil_(Object.assign({ token: 'nope', brand: 'Wyld' }, W));
  ok('a bad token says to sign in', r.ok === false && r.needsAuth === true);
}

console.log('\n2. a pencil is whole pay periods');
{
  const e = engine();
  const bad = (over) => e.api.savePencil_(Object.assign({ token: 'good', brand: 'Wyld' }, W, over));
  ok('a start in the middle of a period is refused', bad({ start_date: '2026-11-10' }).ok === false);
  ok('an end in the middle of a period is refused', bad({ end_date: '2026-11-20' }).ok === false);
  ok('an end before the start is refused', bad({ start_date: '2026-11-23', end_date: '2026-11-22' }).ok === false);
  ok('a blank brand is refused', bad({ brand: '  ' }).ok === false);
  ok('a text that is not a date is refused', bad({ start_date: 'soon' }).ok === false);
  ok('  …and every refusal wrote nothing', pencilRows(e).length === 0);
  const two = bad({ end_date: '2026-12-06' });
  ok('two periods in a row are fine', two.ok === true && two.pencil.end_date === '2026-12-06');
}

console.log('\n3. saving');
{
  const e = engine();
  const r = e.api.savePencil_(Object.assign({ token: 'good', brand: '  Mule Extracts ', note: 'waiting on budget' }, W));
  ok('it saves, stamped with who and when', r.ok && r.created && r.pencil.created_by === 'tawny' && r.pencil.created_at.indexOf('2026-10-14') === 0);
  const row = pencilRows(e)[0];
  ok('  …into its OWN tab, one row', pencilRows(e).length === 1 && row[pcol('brand')] === 'Mule Extracts');
  ok('  …and not into programs', e.programs.rows.length === 1);
  ok('  …as penciled, dates as text', row[pcol('status')] === 'penciled' && row[pcol('start_date')] === W.start_date);
  const again = e.api.savePencil_(Object.assign({ token: 'good', brand: 'mule extracts', note: 'x' }, W));
  ok('the same call again is a replay, not a second pencil', again.ok && again.replay === true && pencilRows(e).length === 1);
  e.api.savePencil_(Object.assign({ token: 'good', brand: 'Magic Number' }, W));
  ok('a second brand in the same period is allowed (overlap warns, never blocks)', pencilRows(e).length === 2);
  const list = e.api.pencilsRead_();
  ok('the read serves both', list.ok && list.pencils.length === 2);
}

console.log('\n4. releasing a slot');
{
  const e = engine();
  const id = e.api.savePencil_(Object.assign({ token: 'good', brand: 'Wyld' }, W)).pencil.pencil_id;
  const r = e.api.releasePencil_({ token: 'good', id });
  ok('it releases', r.ok && r.released === true);
  ok('  …the read no longer serves it', e.api.pencilsRead_().pencils.length === 0);
  ok('  …but the row stays, marked released, with who', pencilRows(e)[0][pcol('status')] === 'released' && pencilRows(e)[0][pcol('closed_by')] === 'tawny');
  ok('releasing again changes nothing', e.api.releasePencil_({ token: 'good', id }).released === false);
  ok('an unknown slot is a clear no', e.api.releasePencil_({ token: 'good', id: 'nope' }).ok === false);
}

console.log('\n5. locking it in');
{
  const e = engine();
  const id = e.api.savePencil_(Object.assign({ token: 'good', brand: 'Mule Extracts' }, W)).pencil.pencil_id;
  const r = e.api.lockPencil_({ token: 'good', id, stores: JSON.stringify(['bend', 'center']) });
  ok('it makes a program', r.ok && r.locked && r.program_id);
  const prog = e.programs.rows[1];
  ok('  …a DRAFT, never active', prog[col('status')] === 'draft');
  ok('  …for the brand, in the pencil\'s window', prog[col('vendor')] === 'Mule Extracts'
     && prog[col('start_date')] === W.start_date && prog[col('end_date')] === W.end_date);
  ok('  …with nothing owed to anybody', JSON.parse(prog[col('payout_json')]).amount === 0
     && JSON.parse(prog[col('target_json')]).budtenders === 0);
  ok('  …on the stores it was given', prog[col('stores_json')] === '["bend","center"]');
  ok('the pencil is closed as locked, pointing at the program', pencilRows(e)[0][pcol('status')] === 'locked'
     && pencilRows(e)[0][pcol('program_id')] === r.program_id);
  ok('  …and is off the read', e.api.pencilsRead_().pencils.length === 0);
  const again = e.api.lockPencil_({ token: 'good', id });
  ok('locking twice does not make a second program', again.ok === false && e.programs.rows.length === 2);
}

console.log('\n6. a start date that has passed');
{
  const e = engine('editor', '2026-11-15');
  const r = e.api.savePencil_(Object.assign({ token: 'good', brand: 'Late Brand' }, W));
  ok('a pencil can be read once its start has passed', r.ok);
  const read = e.api.pencilsRead_();
  ok('  …it is still there, untouched and still penciled', read.pencils.length === 1 && read.pencils[0].status === 'penciled');
  ok('  …and no program appeared', e.programs.rows.length === 1);
  const id = read.pencils[0].pencil_id;
  const moved = e.api.lockPencil_({ token: 'good', id, start_date: '2026-11-23', end_date: '2026-12-06' });
  ok('lock it in with new dates', moved.ok && e.programs.rows[1][col('start_date')] === '2026-11-23');
  const bad = engine('editor', '2026-11-15');
  const id2 = bad.api.savePencil_(Object.assign({ token: 'good', brand: 'Off Grid' }, W)).pencil.pencil_id;
  const off = bad.api.lockPencil_({ token: 'good', id: id2, start_date: '2026-11-24', end_date: '2026-12-06' });
  ok('new dates must still be whole pay periods', off.ok === false && bad.programs.rows.length === 1);
  ok('  …and a refused lock leaves the slot', bad.api.pencilsRead_().pencils.length === 1);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\npencils engine: all passed');
process.exit(fail ? 1 : 0);
