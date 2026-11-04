#!/usr/bin/env node
/* ─── The deals page's Featured image is picked with a click, and its description fills itself ─────
 *
 *   RUN:  node tests/web_image_picker_test.js
 *
 * Sky, 2026-11-03: "can we make the image box a selection tool, so that it's easier for the user to
 * click & select? and, Image description should be auto populated" — source: the vendor's Drive folder.
 * This RUNS the engine's webImages_ against a fake Drive, and the screen's own picker, click wiring and
 * description rule from marketing.js:
 *   · the list is the program's vendor folder (its files link, else the vendor's folder, never made
 *     here) plus one level of subfolders; a file that breaks the Featured image spec carries the reason
 *   · it is an editor's read: a viewer is refused, nothing is written
 *   · a click on a tile saves that file's Drive link; a greyed tile cannot be picked
 *   · the description follows the headline only while blank or still its own text; typed text stays
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

/* ── the engine ─────────────────────────────────────────────────────────────────────────────── */
function engine(o) {
  const queries = [];
  const prog = Object.assign({ program_id: 'all-products-202610', vendor: 'Gron', end_date: '2026-11-08',
    marketing_json: { v: 1, sel: { web: true }, d: { files: { url: 'https://drive.google.com/drive/folders/FOLDERaaaaaaaaaaaa' } } } }, o.prog || {});
  const api = G.load({
    real: ['webFolderId_', 'webImages_', 'wixImageProblem_', 'normalizeMarketing_'],
    vars: ['WEB_IMAGES_MAX_', 'WEB_IMAGES_SUBFOLDERS_', 'WIX_FEATURED_SPEC_'],
    stubs: {
      mktEditor_: () => (o.viewer ? { fail: { ok: false, error: 'Your role (viewer) cannot edit the deals page' } } : { auth: { user: 'tawny' } }),
      getProgram_: (id) => (id === prog.program_id ? { ok: true, program: JSON.parse(JSON.stringify(prog)) } : { ok: false, error: 'not found' }),
      vendorFolderFor_: (v, make) => { if (make) throw new Error('the picker must never make a folder'); return o.vendorFolder || null; },
      driveList_: (q, fields) => {
        queries.push(q);
        if (o.driveFails) throw new Error('Drive said 403');
        if (/application\/vnd\.google-apps\.folder/.test(q)) return o.subfolders || [];
        return o.files || [];
      },
      scrubSecrets_: (x) => String(x),
    },
  });
  return { api, queries };
}
const sq = (id, name, w, mime, size) => ({ id, name, mimeType: mime || 'image/png', size: String(size || 500000),
  imageMediaMetadata: { width: w, height: w } });

console.log('\n1. the engine lists the vendor folder');
{
  const e = engine({ subfolders: [{ id: 'SUBbbbbbbbbbbbbbbb' }],
    files: [sq('IMG1aaaaaaaaaaaaaaaaaaaa', 'Gron_Pearls_Week_1200.png', 1200), sq('IMG2aaaaaaaaaaaaaaaaaaaa', 'banner.png', 800),
            Object.assign(sq('IMG3aaaaaaaaaaaaaaaaaaaa', 'wide.jpg', 1200, 'image/jpeg'), { imageMediaMetadata: { width: 1920, height: 1080 } })] });
  const r = e.api.webImages_({ id: 'all-products-202610', token: 't' });
  ok('answers ok with the program\'s own folder link', r.ok && r.folder_url === 'https://drive.google.com/drive/folders/FOLDERaaaaaaaaaaaa');
  ok('looks in the folder and its subfolders, images only, never trashed',
     /'FOLDERaaaaaaaaaaaa' in parents or 'SUBbbbbbbbbbbbbbbb' in parents/.test(e.queries[1]) && /mimeType contains 'image\/'/.test(e.queries[1]) && /trashed = false/.test(e.queries[1]));
  ok('each file comes with a Drive file link the publisher can read', r.files[0].url === 'https://drive.google.com/file/d/IMG1aaaaaaaaaaaaaaaaaaaa/view'
     && MK.driveFileId(r.files[0].url) === 'IMG1aaaaaaaaaaaaaaaaaaaa');
  ok('a file that meets the spec has no problem', r.files[0].problem === '' && r.files[0].width === 1200);
  ok('a too-small one says why', /1080/.test(r.files[1].problem));
  ok('a non-square one says why', /square/.test(r.files[2].problem));
}
{
  const e = engine({ prog: { marketing_json: { v: 1, sel: { web: true }, d: {} } },
    vendorFolder: { id: 'VENDORfffffffffffff', url: 'https://drive.google.com/drive/folders/VENDORfffffffffffff' }, files: [] });
  const r = e.api.webImages_({ id: 'all-products-202610' });
  ok('with no files link it falls back to the vendor\'s folder, without making one', r.ok && r.folder_url.indexOf('VENDORfffffffffffff') > 0 && r.files.length === 0);
}
{
  const r = engine({ prog: { marketing_json: { v: 1, d: {} } } }).api.webImages_({ id: 'all-products-202610' });
  ok('no folder at all is an empty answer that says so, not an error', r.ok && r.why === 'no_folder' && !r.folder_url);
}
{
  const r = engine({ viewer: true }).api.webImages_({ id: 'all-products-202610' });
  ok('a viewer is refused', r.ok === false && /viewer/.test(r.error));
  const d = engine({ driveFails: true }).api.webImages_({ id: 'all-products-202610' });
  ok('a Drive failure is an error, never an empty folder', d.ok === false && /403/.test(d.error));
}
{
  const many = Array.from({ length: 75 }, (_, i) => sq('MANY' + String(i).padStart(20, '0'), i + '.png', 1200));
  ok('the list is capped', engine({ files: many }).api.webImages_({ id: 'all-products-202610' }).files.length === G.grabVar('WEB_IMAGES_MAX_'));
}
ok('the route is wired, and is not secret-only', /case 'webImages':\s+out = webImages_\(p\)/.test(G.GS)
   && G.grabVar('SECRET_ACTIONS').indexOf('webImages') < 0);

/* ── the description ─────────────────────────────────────────────────────────────────────────── */
console.log('\n2. the image description fills itself');
const prog = (web) => ({ program_id: 'x', end_date: '2026-11-08', marketing_json: { v: 1, sel: { web: true }, d: { web: web || {} } } });
const web = (ops) => ops[0][2];
ok('headline + run', MK.autoAlt(prog(), 'Grön Pearls week') === 'Grön Pearls week, through Nov 8');
ok('no headline, no description', MK.autoAlt(prog(), '  ') === '');
ok('typing a headline fills a blank description', web(MK.webDetailOp(prog(), 'headline', 'Grön Pearls week')).alt === 'Grön Pearls week, through Nov 8');
ok('changing the headline moves a description it filled',
   web(MK.webDetailOp(prog({ headline: 'A', alt: 'A, through Nov 8' }), 'headline', 'B')).alt === 'B, through Nov 8');
ok('a description someone typed is left alone',
   web(MK.webDetailOp(prog({ headline: 'A', alt: 'Three boxes of Pearls' }), 'headline', 'B')).alt === 'Three boxes of Pearls');
ok('picking an image fills a blank description from the headline',
   web(MK.webDetailOp(prog({ headline: 'A' }), 'image', 'https://drive.google.com/file/d/IMG1aaaaaaaaaaaaaaaaaaaa/view')).alt === 'A, through Nov 8');
ok('typing the description itself is kept as typed', web(MK.webDetailOp(prog({ headline: 'A', alt: 'A, through Nov 8' }), 'alt', 'Mine')).alt === 'Mine');
ok('clearing the headline clears a description it filled', !('alt' in web(MK.webDetailOp(prog({ headline: 'A', alt: 'A, through Nov 8' }), 'headline', ''))));
ok('never past the limit', MK.autoAlt(prog(), 'x'.repeat(200)).length === MK.COPY_LIMITS.alt);

/* ── the picker on screen ────────────────────────────────────────────────────────────────────── */
console.log('\n3. the picker');
const files = [{ id: 'IMG1aaaaaaaaaaaaaaaaaaaa', name: 'pearls.png', width: 1200, height: 1200, url: 'https://drive.google.com/file/d/IMG1aaaaaaaaaaaaaaaaaaaa/view', problem: '' },
               { id: 'IMG2aaaaaaaaaaaaaaaaaaaa', name: 'tiny.png', width: 800, height: 800, url: 'https://drive.google.com/file/d/IMG2aaaaaaaaaaaaaaaaaaaa/view', problem: 'is 800 × 800; a side must be 1080 to 2400 px' }];
const grid = MK.imageGridHtml({ ok: true, folder_url: 'https://drive.google.com/drive/folders/F', files }, files[0].url);
ok('a tile per image, with a thumbnail', (grid.match(/class="mk-imgtile/g) || []).length === 2 && grid.indexOf('lh3.googleusercontent.com/d/IMG1aaaaaaaaaaaaaaaaaaaa') > 0);
ok('the picked one is marked', /mk-imgtile on"[^>]*data-mk-imgchoose="https:\/\/drive.google.com\/file\/d\/IMG1/.test(grid));
ok('a greyed one is disabled and says why', /mk-imgtile bad"[^>]*disabled/.test(grid) && grid.indexOf('This image is 800 × 800') > 0);
ok('an empty folder says so and links it', /No images/.test(MK.imageGridHtml({ ok: true, folder_url: 'https://drive.google.com/drive/folders/F', files: [] })));
ok('a failed read shows the error', /mk-warn/.test(MK.imageGridHtml({ ok: false, error: 'Drive said 403' })));
const field = MK.imageFieldHtml('', { canEdit: true });
ok('the field has the pick button and still takes a pasted link', /data-mk-imgpick="1"/.test(field) && /data-mk-item="web" data-mk-field="image"/.test(field));
ok('a viewer gets no pick button', !/data-mk-imgpick/.test(MK.imageFieldHtml('', { canEdit: false })));
ok('a wix:image already in Wix Media previews from Wix',
   MK.wixImagePreview('wix:image://v1/1d2b4b_7c574ca1480a478b9af507bca8c9d34a~mv2.png/x.png#originWidth=1200') === 'https://static.wixstatic.com/media/1d2b4b_7c574ca1480a478b9af507bca8c9d34a~mv2.png');

/* The click wiring, run through marketing.js's own wire() against a minimal host. */
(async () => {
  const handlers = {};
  const host = { addEventListener: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); }, contains: () => true };
  const gridEl = { innerHTML: '' };
  const fld = { querySelector: () => gridEl };
  const applied = [], asked = [];
  const p = prog({ headline: 'Grön Pearls week' });
  MK.wire(host, { program: () => p, apply: (ops) => applied.push(ops), plan() {}, tick() {}, moving() {},
                  images: (pp) => { asked.push(pp.program_id); return Promise.resolve({ ok: true, folder_url: 'https://drive.google.com/drive/folders/F', files }); } });
  const btn = (data) => ({ dataset: data, disabled: false, closest(sel) { return sel === 'button' ? this : sel === '.mk-imgfld' ? fld : null; } });
  const click = (b) => handlers.click.map(fn => fn({ target: b }));
  const pick = btn({ mkImgpick: '1' });
  await Promise.all(click(pick));
  ok('"Choose from vendor folder" asks the engine for this program and draws the tiles',
     asked[0] === 'x' && (gridEl.innerHTML.match(/mk-imgtile/g) || []).length >= 2 && pick.disabled === false);
  click(btn({ mkImgchoose: files[0].url }));
  const sent = applied[0] && applied[0][0];
  ok('a click on a tile saves its Drive link and fills the description',
     sent && sent[0] === 'd' && sent[1] === 'web' && sent[2].image === files[0].url && sent[2].alt === 'Grön Pearls week, through Nov 8');
  const change = (data, value) => handlers.change.map(fn => fn({ target: { dataset: data, value } }));
  change({ mkItem: 'web', mkField: 'headline' }, 'Grön week');
  ok('typing a headline goes through the same description rule', applied[1][0][2].alt === 'Grön week, through Nov 8');

  console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
