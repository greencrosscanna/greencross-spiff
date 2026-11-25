#!/usr/bin/env node
/* ─── "Make square": a greyed Featured image is fixed in one click ─────────────────────────────────
 *
 *   RUN:  node tests/make_square_test.js
 *
 * Sky, 2026-11-24: vendor art arrives 1122 × 1232 and the picker greys it out. A greyed tile now has
 * a "Make square" button: the browser pads the picture to a square with its own edge color (never
 * cropped), sizes it to 1200 × 1200, and the engine files the copy beside the original and the screen
 * picks it. This RUNS the engine's webImageSource_ / webSquareSave_ against a fake Drive, and
 * marketing.js's layout, edge color, grid markup and click wiring:
 *   · both routes serve or write only a file in THIS program's vendor folder listing; a viewer is refused
 *   · the copy must be a real JPG or PNG under 2 MB, is filed in the original's own folder, and saving
 *     the same original twice answers the copy already made instead of a second file
 *   · the layout fits the long side to 1200 and centers the picture: nothing is cut off
 *   · a greyed tile with a known size gets the button; a good tile does not
 *   · the click fetches, draws, saves, picks the copy and redraws; a lost reply finds it by name
 * The canvas drawing itself (squareImage) needs a browser and is not run here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;

const FOLDER = 'FOLDERaaaaaaaaaaaa';
const TALL = { id: 'TALLaaaaaaaaaaaaaaaaaaaa', name: 'In-House-Lineup.jpg', mimeType: 'image/jpeg', size: '900000',
               imageMediaMetadata: { width: 1122, height: 1232 } };
const JPG = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
const PNG = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3];
const b64 = (arr) => Buffer.from(arr).toString('base64');

function engine(o) {
  o = o || {};
  const made = [], folderFiles = o.existing || [];
  const prog = { program_id: 'green-cross-10pks-all-products-202611', vendor: 'Green Cross',
    marketing_json: { v: 1, sel: { web: true }, d: { files: { url: 'https://drive.google.com/drive/folders/' + FOLDER } } } };
  const DriveApp = {
    getFolderById: (id) => ({
      getFilesByName: (n) => { const l = folderFiles.filter(f => f.name === n); let i = 0; return { hasNext: () => i < l.length, next: () => l[i++] }; },
      createFile: (blob) => {
        let desc = '';
        const f = { id: 'NEW' + made.length, folder: id, blob, getId: () => 'NEWFILEaaaaaaaaaaaaaaaa' + made.length,
                    setDescription: (d) => { desc = d; f.desc = d; }, getDescription: () => desc };
        made.push(f); return f;
      },
    }),
  };
  const Utilities = {
    base64Decode: (s) => { if (s === '!bad') throw new Error('bad'); return Array.from(Buffer.from(s, 'base64')).map(x => (x > 127 ? x - 256 : x)); },
    newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  const api = G.load({
    real: ['webFolderId_', 'webFolderOf_', 'webPickerFile_', 'webImageSource_', 'webSquareSave_', 'folderImages_',
           'wixImageProblem_', 'normalizeMarketing_'],
    vars: ['WEB_IMAGES_MAX_', 'WEB_IMAGES_SUBFOLDERS_', 'WIX_FEATURED_SPEC_', 'WEB_SQUARE_TAG_'],
    stubs: {
      mktEditor_: () => (o.viewer ? { fail: { ok: false, error: 'Your role (viewer) cannot edit the deals page' } } : { auth: { user: 'tawny' } }),
      getProgram_: (id) => (id === prog.program_id ? { ok: true, program: JSON.parse(JSON.stringify(prog)) } : { ok: false, error: 'not found' }),
      vendorFolderFor_: () => null,
      driveList_: (q) => (/google-apps\.folder/.test(q) ? [] : [TALL]),
      driveApi_: (m, p) => { if (/fields=parents/.test(p)) return { parents: [o.parent || FOLDER] }; throw new Error('unexpected ' + p); },
      pmImageData_: (id) => 'data:image/jpeg;base64,' + b64(JPG) + '#' + id,
      scrubSecrets_: (x) => String(x),
    },
    globals: { DriveApp, Utilities, LockService },
  });
  return { api, made };
}
const P = { id: 'green-cross-10pks-all-products-202611', token: 't' };

console.log('\n1. the engine hands over only this program\'s pictures');
{
  const e = engine();
  const r = e.api.webImageSource_(Object.assign({ file: TALL.id }, P));
  ok('a picture in the vendor folder comes back as data, with its name and size', r.ok && /^data:image\/jpeg;base64,/.test(r.data)
     && r.name === TALL.name && r.width === 1122 && r.height === 1232);
  ok('a file that is not in the folder listing is refused', engine().api.webImageSource_(Object.assign({ file: 'ELSEWHEREaaaaaaaaaaaaaaa' }, P)).ok === false);
  ok('no file is refused', engine().api.webImageSource_(P).ok === false);
  ok('a viewer is refused', engine({ viewer: true }).api.webImageSource_(Object.assign({ file: TALL.id }, P)).ok === false);
}

console.log('\n2. the square copy is filed beside the original, once');
{
  const e = engine();
  const r = e.api.webSquareSave_(Object.assign({ file: TALL.id, mime: 'image/jpeg', data: b64(JPG) }, P));
  ok('it is filed in the original\'s folder as "<name> (square).jpg"', r.ok && e.made.length === 1 && e.made[0].folder === FOLDER
     && r.name === 'In-House-Lineup (square).jpg' && e.made[0].blob.mime === 'image/jpeg');
  ok('the answer is a Drive file link the picker and the publisher read', /^https:\/\/drive\.google\.com\/file\/d\/NEWFILE\w+\/view$/.test(r.url)
     && MK.driveFileId(r.url) === r.file_id);
  ok('it is tagged with the original it came from', e.made[0].desc === G.grabVar('WEB_SQUARE_TAG_') + TALL.id);
  ok('the screen names the copy the same way the engine does', MK.squareName(TALL.name, 'image/jpeg') === r.name
     && MK.squareName('logo.png', 'image/png') === 'logo (square).png');
}
{
  const had = { name: 'In-House-Lineup (square).jpg', isTrashed: () => false, getDescription: () => G.grabVar('WEB_SQUARE_TAG_') + TALL.id, getId: () => 'HADaaaaaaaaaaaaaaaaaaaa' };
  const e = engine({ existing: [had] });
  const r = e.api.webSquareSave_(Object.assign({ file: TALL.id, mime: 'image/jpeg', data: b64(JPG) }, P));
  ok('saving the same original again answers the copy already made, no second file', r.ok && r.replay && r.file_id === 'HADaaaaaaaaaaaaaaaaaaaa' && e.made.length === 0);
  const other = { name: had.name, isTrashed: () => false, getDescription: () => 'hand-made', getId: () => 'X' };
  const e2 = engine({ existing: [other] });
  ok('  …a hand-made file with the same name is not mistaken for it', e2.api.webSquareSave_(Object.assign({ file: TALL.id, mime: 'image/jpeg', data: b64(JPG) }, P)).ok && e2.made.length === 1);
}
{
  const save = (extra, o) => { const e = engine(o); return { r: e.api.webSquareSave_(Object.assign({ file: TALL.id }, P, extra)), e }; };
  ok('a PNG copy is a .png', save({ mime: 'image/png', data: b64(PNG) }).r.name === 'In-House-Lineup (square).png');
  ok('a type other than JPG or PNG is refused', save({ mime: 'image/webp', data: b64(JPG) }).r.ok === false);
  ok('bytes that are not the type claimed are refused', save({ mime: 'image/jpeg', data: b64(PNG) }).r.ok === false);
  ok('an empty upload is refused', save({ mime: 'image/jpeg', data: '' }).r.ok === false);
  ok('an upload that does not decode is refused', save({ mime: 'image/jpeg', data: '!bad' }).r.ok === false);
  const big = JPG.concat(new Array(2097152).fill(0));
  ok('a copy over 2 MB is refused', save({ mime: 'image/jpeg', data: b64(big) }).r.ok === false);
  const far = save({ file: 'ELSEWHEREaaaaaaaaaaaaaaa', mime: 'image/jpeg', data: b64(JPG) });
  ok('a file outside the vendor folder is never written beside', far.r.ok === false && far.e.made.length === 0);
  const v = save({ mime: 'image/jpeg', data: b64(JPG) }, { viewer: true });
  ok('a viewer writes nothing', v.r.ok === false && v.e.made.length === 0);
}
ok('the read is a GET route, not secret-only; the save is a signed-in POST',
   /case 'webImageSource':\s+out = webImageSource_\(p\)/.test(G.GS) && /case 'webSquareSave':\s+out = webSquareSave_\(body\)/.test(G.GS)
   && G.grabVar('SECRET_ACTIONS').indexOf('webImageSource') < 0);
ok('SOURCE-SHAPED: neither route is hedged (a hedged write runs twice)',
   !/webImageSource|webSquareSave/.test(fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8').match(/var ENGINE_HEDGE_READS = \{[^}]*\}/)[0]));

console.log('\n3. the square is laid out with nothing cut off');
{
  const t = MK.squareLayout(1122, 1232);
  ok('a tall picture: its height becomes 1200 and it is centered left to right', t.side === 1200 && t.dh === 1200 && t.dy === 0
     && t.dw === Math.round(1122 * 1200 / 1232) && t.dx === Math.floor((1200 - t.dw) / 2) && t.pad === 'x');
  const w = MK.squareLayout(1536, 815);
  ok('a wide picture: its width becomes 1200 and it is centered top to bottom', w.dw === 1200 && w.dx === 0 && w.dh === Math.round(815 * 1200 / 1536) && w.pad === 'y');
  const s = MK.squareLayout(600, 600);
  ok('a small square one is sized up to 1200', s.dw === 1200 && s.dh === 1200 && s.dx === 0 && s.dy === 0);
  ok('every layout fits inside the square', [t, w, s].every(L => L.dx >= 0 && L.dy >= 0 && L.dx + L.dw <= 1200 && L.dy + L.dh <= 1200));
  ok('1200 is inside the Featured spec', 1200 >= MK.FEATURED_SPEC.min && 1200 <= MK.FEATURED_SPEC.max);
}
{
  /* 4 × 2 picture: left column red, right column blue, middle green. A tall pad samples the side
     columns only, so green never leaks into the fill. */
  const px = [];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) px.push(...(x === 0 ? [200, 0, 0, 255] : x === 3 ? [0, 0, 100, 255] : [0, 255, 0, 255]));
  ok('the fill is the average of the edges being padded', MK.edgeColor(px, 4, 2, 'x') === 'rgb(100,0,50)');
  const clear = new Array(4 * 2 * 4).fill(0);
  ok('a see-through edge falls back to white', MK.edgeColor(clear, 4, 2, 'x') === 'rgb(255,255,255)');
}

console.log('\n4. the button on the tile');
const files = [
  { id: 'GOODaaaaaaaaaaaaaaaaaaaa', name: 'good.png', width: 1200, height: 1200, url: 'https://drive.google.com/file/d/GOODaaaaaaaaaaaaaaaaaaaa/view', problem: '' },
  { id: TALL.id, name: TALL.name, width: 1122, height: 1232, url: 'https://drive.google.com/file/d/' + TALL.id + '/view', problem: 'is 1122 × 1232, and it must be square' },
  { id: 'SMALLaaaaaaaaaaaaaaaaaaa', name: 'logo.png', width: 600, height: 600, url: 'https://drive.google.com/file/d/SMALLaaaaaaaaaaaaaaaaaaa/view', problem: 'is 600 × 600; a side must be 1080 to 2400 px' },
  { id: 'NOSIZEaaaaaaaaaaaaaaaaaa', name: 'new.jpg', width: 0, height: 0, url: 'https://drive.google.com/file/d/NOSIZEaaaaaaaaaaaaaaaaaa/view', problem: 'has no readable size yet' }];
const grid = MK.imageGridHtml({ ok: true, folder_url: 'https://drive.google.com/drive/folders/F', files }, '');
ok('a not-square tile says "Make square"; a square-but-wrong-size one says "Resize to fit"',
   grid.indexOf('data-mk-imgfix="' + TALL.id + '"') > 0 && MK.fixLabel(files[1]) === 'Make square' && MK.fixLabel(files[2]) === 'Resize to fit');
ok('a good tile and one with no size yet get no button', MK.fixLabel(files[0]) === '' && MK.fixLabel(files[3]) === ''
   && (grid.match(/data-mk-imgfix=/g) || []).length === 2);
ok('the greyed tile itself still cannot be picked', /mk-imgtile bad"[^>]*disabled/.test(grid));

(async () => {
  const handlers = {};
  const host = { addEventListener: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); }, contains: () => true };
  const run = async (o) => {
    const gridEl = { innerHTML: '' }, note = { textContent: '' };
    const cell = { querySelector: () => note };
    const applied = [], calls = [];
    const p = { program_id: 'gc', end_date: '2026-12-06', marketing_json: { v: 1, sel: { web: true }, d: { web: { headline: 'Green Cross 10 Pack Gummies' } } } };
    const h = { addEventListener: (k, fn) => { (handlers[k + o.tag] = handlers[k + o.tag] || []).push(fn); }, contains: () => true };
    MK.wire(h, { program: () => p, apply: (ops) => applied.push(ops), plan() {}, tick() {}, moving() {},
      images: () => { calls.push('images'); return Promise.resolve({ ok: true, folder_url: 'F', files: o.listAfter || files }); },
      imageSource: (pp, id) => { calls.push('source:' + id); return Promise.resolve(o.source || { ok: true, name: TALL.name, data: 'data:image/jpeg;base64,AAAA' }); },
      squareImage: (data, mime) => { calls.push('draw:' + mime); return Promise.resolve({ mime: 'image/jpeg', data: 'BBBB' }); },
      squareSave: (pp, id, sq) => { calls.push('save:' + id + ':' + sq.data); return Promise.resolve(o.saved === undefined ? { ok: true, url: 'https://drive.google.com/file/d/SQaaaaaaaaaaaaaaaaaaaaaa/view', name: 'In-House-Lineup (square).jpg' } : o.saved); } });
    const b = { dataset: { mkImgfix: TALL.id }, disabled: false,
      closest(sel) { return sel === 'button' ? this : sel === '.mk-imgcell' ? cell : sel === '[data-mk-imggrid]' ? gridEl : null; } };
    await Promise.all(handlers['click' + o.tag].map(fn => fn({ target: b })));
    return { applied, calls, note, gridEl, b };
  };
  const a = await run({ tag: 'a' });
  ok('the click fetches the picture, draws it, saves the copy, in that order',
     a.calls.slice(0, 3).join(' ') === 'source:' + TALL.id + ' draw:image/jpeg save:' + TALL.id + ':BBBB');
  ok('then picks the copy and fills the description', a.applied.length === 1 && a.applied[0][0][2].image === 'https://drive.google.com/file/d/SQaaaaaaaaaaaaaaaaaaaaaa/view'
     && a.applied[0][0][2].alt === 'Green Cross 10 Pack Gummies, through Dec 6');
  ok('  …says so on the tile and redraws the grid with the copy marked', /Picked/.test(a.note.textContent) && a.calls[3] === 'images' && /mk-imgtile/.test(a.gridEl.innerHTML));
  const lost = await run({ tag: 'b', saved: null, listAfter: files.concat([{ id: 'SQbbbbbbbbbbbbbbbbbbbbbb', name: 'In-House-Lineup (square).jpg', width: 0, height: 0,
    url: 'https://drive.google.com/file/d/SQbbbbbbbbbbbbbbbbbbbbbb/view', problem: 'has no readable size yet' }]) });
  ok('a reply the browser cannot read: the copy is found in the folder by its name and picked',
     lost.applied.length === 1 && lost.applied[0][0][2].image === 'https://drive.google.com/file/d/SQbbbbbbbbbbbbbbbbbbbbbb/view');
  const bad = await run({ tag: 'c', source: { ok: false, error: 'That image is not in this program\'s vendor folder.' } });
  ok('a refusal is shown on the tile, nothing is picked, and the button works again',
     bad.applied.length === 0 && /not in this program/.test(bad.note.textContent) && bad.b.disabled === false);
  const gone = await run({ tag: 'd', saved: null, listAfter: files });
  ok('  …a lost reply with no copy in the folder says so rather than picking anything', gone.applied.length === 0 && /may not have saved/.test(gone.note.textContent));

  console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
