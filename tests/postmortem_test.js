#!/usr/bin/env node
/* ─── Media post-mortem: the engine's routes and the report builder, run for real ─────────────────
 *
 *   RUN:  node tests/postmortem_test.js
 *
 * Mike enters each post and blast once; postmortem.js builds the vendor and internal reports from
 * those entries. What is checked:
 *   1. the engine's normalizePostmortem_/applyPostmortemOps_ and postmortem.js's normalize/applyOps
 *      are twins: the same input gives the same stored shape on both sides;
 *   2. savePostmortem_ / postmortemRead_: only an editor writes, into the `postmortems` tab and never
 *      `programs`; a delta applies on top of what is stored; an oversized report is refused;
 *   3. postmortemImages_ serves only images the program's own entries name;
 *   4. postmortemUpload_ and postmortemSave_: images only into the vendor folder, PDFs only into SPIFF
 *      Reports, each PDF recorded once (a retried POST is a replay, not a second report);
 *   5. the report, built from the Grön numbers in Mike's hand-made PDF: the same totals, lead line,
 *      page order and footers, and pages with nothing to show are left out.
 * That nothing paying reads these tabs is tests/marketing_pay_isolation_test.js's job.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./_gas');
const PM = require('../postmortem.js');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const PROG = { program_id: 'gron-202610', vendor: 'Grön', program_name: 'Grön SPIFF', start_date: '2026-10-26', end_date: '2026-11-08',
               marketing_json: { v: 1, d: { files: { url: 'https://drive.google.com/drive/folders/VENDORFOLDER123' } } } };
const IMG = (n) => 'IMGFILE' + String(n).padStart(6, '0');

function engine(role) {
  const programs = G.makeSheet(G.grabVar('PROGRAM_HEADERS'), []);
  const book = G.makeBook({ programs });
  programs.getParent = () => book;
  const drive = { created: [], folders: {} };
  const folder = (id) => ({
    createFile(blob) {
      const f = { id: 'NEWFILE' + (drive.created.length + 1) + 'xx', folder: id, blob };
      drive.created.push(f);
      return { getId: () => f.id, getUrl: () => 'https://drive.google.com/file/d/' + f.id + '/view' };
    },
  });
  const Utilities = Object.assign({}, G.Utilities, {
    base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    base64Encode: (b) => Buffer.from(b).toString('base64'),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name, getContentType: () => mime, getBytes: () => bytes }),
  });
  const api = G.load({
    real: ['pmTab_', 'pmSheet_', 'pmReportsSheet_', 'pmText_', 'pmNum_', 'pmIds_', 'normalizePostmortem_', 'applyPostmortemOps_',
           'pmFindRow_', 'pmRead_', 'pmReports_', 'pmFolderOf_', 'postmortemRead_', 'savePostmortem_', 'postmortemImages_',
           'postmortemUpload_', 'postmortemSave_', 'mktEditor_', 'mktVendorFolderId_', 'parseJson_'],
    vars: ['PM_TAB', 'PM_HEADERS', 'PM_REPORTS_TAB', 'PM_REPORT_HEADERS', 'PM_KINDS_', 'PM_STATS_', 'PM_NOTES_', 'PM_CHAN_FIELDS_',
           'PM_MAX_ITEMS_', 'PM_MAX_CELL_', 'PM_UPLOAD_MAX_', 'PM_PDF_MAX_', 'PM_IMAGE_BYTES_', 'EDIT_ROLES', 'REPORT_FOLDER_ID'],
    stubs: {
      dataSheet_: () => programs,
      gxAuth_: (t) => (t === 'good' ? { ok: true, user: 'mike', role: role || 'editor' } : { ok: false, error: 'bad token' }),
      getProgram_: (id) => (id === PROG.program_id ? { ok: true, program: JSON.parse(JSON.stringify(PROG)) } : { ok: false, error: 'No such program' }),
      normalizeMarketing_: (m) => m,
      vendorFolderFor_: () => null,
      nowStamp_: () => '2026-11-16 10:00:00',
      scrubSecrets_: (x) => String(x),
      pmImageData_: (id) => { if (id === IMG(9)) throw new Error('is not an image'); return 'data:image/png;base64,' + id; },
    },
    globals: {
      Utilities, console: { warn() {}, log() {} },
      GXCore: { roleCanEdit: (r) => ['editor', 'admin', 'director', 'manager'].indexOf(r) >= 0 },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
      DriveApp: { getFolderById: (id) => folder(id) },
    },
  });
  return { api, book, programs, drive };
}
const tab = (e, n) => (e.book.getSheetByName(n) ? e.book.getSheetByName(n).rows.slice(1) : []);
const save = (e, ops, tok) => e.api.savePostmortem_({ token: tok || 'good', id: PROG.program_id, patch: JSON.stringify({ ops }) });

/* The Grön program, as Mike reported it (Gron_SPIFF_Media_Postmortem.pdf, 2026-11-10). */
const GRON_OPS = [
  ['item', 'loy-1', { kind: 'loyalty', name: 'Grön two-week campaign', words: 'Two Tuesdays only: $4 off Pearls by Gron 10-packs.',
                       images: [IMG(1), IMG(2), IMG(3), IMG(4)], stats: { reach: 5750 } }],
  ['item', 'ig-1', { kind: 'ig', name: 'Something Big Today', images: [IMG(5)], stats: { views: 157, viewers: 95, interactions: 5, likes: 5, comments: 0, home: 147, profile: 10, accounts: 5, saves: 0, shares: 0 } }],
  ['item', 'ig-2', { kind: 'ig', name: 'Grön MEGA', images: [IMG(6)], stats: { views: 151, viewers: 83, interactions: 6, likes: 6, comments: 0, home: 143, profile: 8, accounts: 6, saves: 0, shares: 0 } }],
  ['item', 'ig-3', { kind: 'ig', name: 'Halloween Magic', images: [IMG(7)], stats: { views: 101, viewers: 57, interactions: 7, likes: 6, comments: 1, home: 91, profile: 10, accounts: 6, saves: 0, shares: 0 } }],
  ['item', 'ig-4', { kind: 'ig', name: 'Whose House? Grön’s House!', images: [IMG(8)], stats: { views: 97, viewers: 53, interactions: 4, likes: 4, comments: 0, home: 85, profile: 12, accounts: 4, saves: 0, shares: 0 } }],
  ['item', 'ig-5', { kind: 'ig', name: 'Grön Vendor Days', images: [IMG(10)], stats: { views: 86, viewers: 54, interactions: 4, likes: 4, comments: 0, home: 76, profile: 10, accounts: 4, saves: 0, shares: 0 } }],
  ['note', 'overview', 'All Instagram views came from followers. Viewer counts are reported separately for each post.'],
  ['note', 'loyalty', 'The blast featured the Pearls Tuesday offer, limited-release Halloween products, and five vendor-day stops.'],
];
const INTERNAL_OPS = [
  ['chan', 'email', { sent: '1.1K', delivered: '99%', open: '27%', ctr: '1%', revenue: '$78.33', unsubs: '4', roi: '$3,659.29' }],
  ['chan', 'sms', { sent: '5.5K', delivered: '98%', ctr: '26%', revenue: '$34.17', unsubs: '92', roi: '$22,557.55' }],
  ['note', 'standout', 'SMS had a 26% click-through rate and 92 unsubscribes.'],
  ['send', { title: 'Grön SPIFF blast Oct 26 / $4 Pearls Tuesdays', record_count: 5750, audience: 6750, images: [IMG(11), IMG(12)] }],
  ['note', 'reconcile', 'Dutchie marked the combined email/SMS campaign Sent.\nThe row displayed 5.75K of 6.75K.'],
];

console.log('\n1. the engine and the screen store the same thing');
{
  const e = engine();
  const messy = { items: [
    { id: 'ok-1', kind: 'tiktok', name: '  x  ', words: 'w'.repeat(2000), images: ['short', IMG(1), IMG(1), IMG(2)], stats: { views: '1,234', likes: -3, bogus: 9, reach: '' } },
    { id: 'BAD ID', kind: 'ig' }, { id: 'ok-1', kind: 'ig', name: 'dupe' },
  ], notes: { overview: ' hi ', nope: 'x' }, channels: { email: { sent: '1.1K', junk: 'x' }, fax: { sent: 1 } },
     send: { record_count: '5,750', audience: 'lots', images: [IMG(3), IMG(4), IMG(5)] }, extra: true };
  const a = e.api.normalizePostmortem_(messy), b = PM.normalize(messy);
  ok('normalize: identical on both sides', JSON.stringify(a) === JSON.stringify(b));
  ok('  …unknown type becomes Instagram, bad ids and duplicates dropped', a.items.length === 1 && a.items[0].kind === 'ig');
  ok('  …"1,234" is read as 1234, a negative and an unknown stat are not kept', a.items[0].stats.views === 1234 && !('likes' in a.items[0].stats) && !('bogus' in a.items[0].stats));
  ok('  …wording capped, images de-duplicated, bad ids dropped', a.items[0].words.length === 1500 && a.items[0].images.join() === [IMG(1), IMG(2)].join());
  ok('  …only known notes, channels and send fields; send keeps two screenshots', !a.notes.nope && !a.channels.fax && !a.channels.email.junk
     && a.send.record_count === 5750 && !('audience' in a.send) && a.send.images.length === 2 && !a.extra);
  const ops = GRON_OPS.concat(INTERNAL_OPS, [['move', 'ig-3', -1], ['item', 'ig-5', null], ['move', 'ig-1', -1]]);
  ok('applyOps: identical on both sides', JSON.stringify(e.api.applyPostmortemOps_({}, ops)) === JSON.stringify(PM.applyOps({}, ops)));
}

console.log('\n2. saving and reading');
{
  const v = engine('viewer');
  ok('a viewer is refused', /cannot/.test(save(v, GRON_OPS).error) && tab(v, 'postmortems').length === 0);
  ok('a bad token says to sign in', engine().api.savePostmortem_({ token: 'nope', id: PROG.program_id, patch: '{"ops":[]}' }).needsAuth === true);
  const e = engine();
  ok('no operations is refused', save(e, []).ok === false);
  ok('an unknown program is refused', e.api.savePostmortem_({ token: 'good', id: 'nope', patch: JSON.stringify({ ops: GRON_OPS }) }).ok === false);
  const r = save(e, GRON_OPS);
  ok('it saves, stamped with who', r.ok && r.data.items.length === 6 && r.updated_by === 'mike');
  ok('  …into its OWN tab, one row, never programs', tab(e, 'postmortems').length === 1 && e.programs.rows.length === 1);
  const r2 = save(e, [['note', 'sources', 'Instagram Insights.'], ['move', 'ig-2', -1]]);
  ok('a later delta applies on top of what is stored', r2.ok && r2.data.items.length === 6 && r2.data.notes.overview && r2.data.notes.sources === 'Instagram Insights.'
     && r2.data.items[1].id === 'ig-2' && tab(e, 'postmortems').length === 1);
  const read = e.api.postmortemRead_({ token: 'good', id: PROG.program_id });
  ok('the read returns it, with the vendor folder', read.ok && read.data.items.length === 6 && /VENDORFOLDER123/.test(read.folder_url) && read.reports.length === 0);
  const big = [];
  /* All 30 slots full of wording: the six already stored are rewritten too, so the cap is what refuses. */
  const ids = ['loy-1', 'ig-1', 'ig-2', 'ig-3', 'ig-4', 'ig-5'];
  for (let i = 0; ids.length < 30; i++) ids.push('big-' + i);
  ids.forEach((id) => big.push(['item', id, { kind: 'ig', name: 'n', words: 'w'.repeat(1500) }]));
  ok('more than one cell can hold is refused, and nothing changes', save(e, big).ok === false && JSON.parse(tab(e, 'postmortems')[0][1]).items.length === 6);
}

console.log('\n3. the images route serves only this program\'s images');
{
  const e = engine();
  save(e, GRON_OPS.concat(INTERNAL_OPS, [['item', 'bad', { kind: 'ig', name: 'x', images: [IMG(9)] }]]));
  const r = e.api.postmortemImages_({ token: 'good', id: PROG.program_id, ids: [IMG(1), IMG(11), 'SOMEONEELSESFILE01', IMG(9)].join(',') });
  ok('named images come back as data', r.ok && r.images[IMG(1)] && r.images[IMG(11)]);
  ok('  …a file the entries do not name is not served', !r.images.SOMEONEELSESFILE01);
  ok('  …and one Drive will not read is reported, not fatal', r.failed.length === 1 && r.failed[0].id === IMG(9));
  ok('a viewer is refused', engine('viewer').api.postmortemImages_({ token: 'good', id: PROG.program_id, ids: IMG(1) }).ok === false);
}

console.log('\n4. uploads and saved PDFs');
{
  const e = engine();
  const png = Buffer.from('fakepng').toString('base64');
  ok('a non-image upload is refused', e.api.postmortemUpload_({ token: 'good', id: PROG.program_id, mime: 'application/pdf', data: png }).ok === false);
  const up = e.api.postmortemUpload_({ token: 'good', id: PROG.program_id, mime: 'image/png', name: 'a/b.png', data: png });
  ok('an image goes into the vendor folder', up.ok && e.drive.created[0].folder === 'VENDORFOLDER123' && e.drive.created[0].blob.name === 'a-b.png');
  ok('a viewer cannot upload', engine('viewer').api.postmortemUpload_({ token: 'good', id: PROG.program_id, mime: 'image/png', data: png }).ok === false);

  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  ok('something that is not a PDF is refused', e.api.postmortemSave_({ token: 'good', id: PROG.program_id, pdf: png }).ok === false);
  const s = e.api.postmortemSave_({ token: 'good', id: PROG.program_id, version: 'internal', pdf, nonce: 'n-1' });
  const REPORTS = G.grabVar('REPORT_FOLDER_ID');
  ok('a PDF is filed in SPIFF Reports', s.ok && e.drive.created[1].folder === REPORTS);
  ok('  …named for the vendor and version', s.report.name === 'Green Cross SPIFF Media Postmortem (Internal) - Grön - 111626.pdf');
  ok('  …and recorded once', tab(e, 'postmortem_reports').length === 1 && tab(e, 'postmortem_reports')[0][2] === 'internal');
  const again = e.api.postmortemSave_({ token: 'good', id: PROG.program_id, version: 'internal', pdf, nonce: 'n-1' });
  ok('a retried POST is a replay, not a second report or file', again.replay === true && tab(e, 'postmortem_reports').length === 1 && e.drive.created.length === 2);
  e.api.postmortemSave_({ token: 'good', id: PROG.program_id, version: 'vendor', pdf, nonce: 'n-2' });
  const list = e.api.postmortemRead_({ token: 'good', id: PROG.program_id }).reports;
  ok('past reports are listed newest first', list.length === 2 && list[0].version === 'vendor' && list[1].version === 'internal');
  ok('nothing was written to programs', e.programs.rows.length === 1);
}

console.log('\n5. the report, from the Grön numbers');
{
  const data = PM.applyOps({}, GRON_OPS);
  const s = PM.summary(data);
  ok('loyalty reach 5.75K', PM.fmtK(s.reach) === '5.75K');
  ok('Instagram views 592 across 5 posts', s.igViews === 592 && s.ig.length === 5);
  ok('Instagram interactions 26 = 25 likes and 1 comment', s.igInteractions === 26 && s.igLikes === 25 && s.igComments === 1);
  ok('the lead line says what Mike wrote', PM.leadLine(s) === 'Something Big Today led in views (157). Halloween Magic led in interactions (7).');
  ok('fmtK: 1100 → 1.1K, 592 → 592, 6750 → 6.75K, 1250000 → 1.25M',
     PM.fmtK(1100) === '1.1K' && PM.fmtK(592) === '592' && PM.fmtK(6750) === '6.75K' && PM.fmtK(1250000) === '1.25M');
  ok('the window reads October 26 to November 8, 2026', PM.dateRange('2026-10-26', '2026-11-08') === 'October 26 to November 8, 2026');
  ok('  …and names both years when it crosses one', PM.dateRange('2026-12-28', '2027-01-10') === 'December 28, 2026 to January 10, 2027');

  const imgs = {}; [1, 2, 3, 4, 5, 6, 7, 8, 10].forEach((n) => { imgs[IMG(n)] = 'data:image/png;base64,AAAA'; });
  const vend = PM.reportHtml(data, PROG, 'vendor', imgs, { logo: 'pm-logo.png' });
  const pages = vend.split('<article class="pmr-page">').length - 1;
  ok('vendor version: 3 pages, as Mike\'s', pages === 3 && /01 \/ 03/.test(vend) && /03 \/ 03/.test(vend));
  ok('  …Overview, then the posts, then the blast', vend.indexOf('SPIFF Media Postmortem.') < vend.indexOf('The Instagram posts.') && vend.indexOf('The Instagram posts.') < vend.indexOf('The loyalty blast.'));
  ok('  …the three tiles and the table', /<b>5\.75K<\/b><span>Loyalty customers reached/.test(vend) && /<b>592<\/b><span>Instagram views<\/span><small>Across 5 posts/.test(vend)
     && /<b>26<\/b><span>Instagram interactions<\/span><small>25 likes and 1 comment/.test(vend)
     && /<td>Loyalty blast<\/td><td>Grön two-week campaign<\/td><td>5\.75K customers reached<\/td><td>Unavailable<\/td>/.test(vend));
  ok('  …"6 likes · 1 comment", not "1 comments"', /6 likes · 1 comment<br>/.test(vend) && !/1 comments/.test(vend));
  ok('  …"Five published creatives" and "no saves or shares … five posts"', /Five published creatives and their individual results/.test(vend)
     && /No saves or shares were recorded across the five posts\./.test(vend));
  ok('  …the blast images in reading order, numbered', /01<\/figcaption>[\s\S]*04<\/figcaption>/.test(vend));
  ok('  …a partner recap, with no internal page', /Partner campaign recap/.test(vend) && !/Internal campaign review|Email &amp; SMS|Campaign send review/.test(vend));
  ok('  …headed Green Cross × Grön, the window under the title', /Green Cross × Grön/.test(vend) && /October 26 to November 8, 2026/.test(vend));
  ok('  …and the default sources line', /Sources \/ Green Cross loyalty campaign reporting and Instagram Insights\./.test(vend));

  const full = PM.applyOps(data, INTERNAL_OPS);
  const intl = PM.reportHtml(full, PROG, 'internal', imgs, {});
  const order = ['SPIFF Media Postmortem.', 'Email &amp; SMS performance.', 'Campaign send review.', 'The Instagram posts.', 'The loyalty blast.'].map((t) => intl.indexOf(t));
  ok('internal version: 5 pages in Mike\'s order', (intl.split('<article class="pmr-page">').length - 1) === 5 && order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])));
  ok('  …the channel table with "Not shown" for the blank SMS open rate', /<td>Open \/ view rate<\/td><td>27%<\/td><td>Not shown<\/td>/.test(intl));
  ok('  …the send tiles with the gap worked out (1K)', /<b>5\.75K<\/b><span>Campaign record count/.test(intl) && /<b>6\.75K<\/b><span>Listed audience/.test(intl) && /<b>1K<\/b><span>Gap in displayed counts/.test(intl));
  ok('  …one line per reconciliation point', /Dutchie marked the combined email\/SMS campaign Sent\.<\/p><p class="pmr-body">The row displayed/.test(intl));
  ok('  …and the internal footer', /Internal campaign review/.test(intl) && !/Partner campaign recap/.test(intl));
  ok('a missing image draws as a black box, not a broken link', /<div class="pmr-img"><i><\/i><\/div>/.test(PM.reportHtml(data, PROG, 'vendor', {}, {})));
  ok('the internal pages are left out when nothing is typed for them', (PM.reportHtml(data, PROG, 'internal', imgs, {}).split('<article').length - 1) === 3);
  ok('nothing entered builds no report', PM.reportHtml({}, PROG, 'vendor', {}, {}) === '');

  const many = PM.applyOps({}, Array.from({ length: 7 }, (_, i) => ['item', 'p' + i, { kind: 'ig', name: 'Post ' + i, stats: { views: 10 + i } }]));
  const mh = PM.reportHtml(many, PROG, 'vendor', {}, {});
  ok('seven posts take two posts pages (five fit on one)', /The Instagram posts\./.test(mh) && /The Instagram posts, continued\./.test(mh) && (mh.split('<article').length - 1) === 3);
  ok('no blast entered: no loyalty tile or page', !/Loyalty customers reached|The loyalty blast/.test(mh));
  ok('saves and shares left blank are not reported as zero', !/No saves or shares/.test(mh));
  ok('imageIds asks for the first post image, the blast images, and screenshots only for internal',
     PM.imageIds(full, 'vendor').join() === [IMG(1), IMG(2), IMG(3), IMG(4), IMG(5), IMG(6), IMG(7), IMG(8), IMG(10)].join()
     && PM.imageIds(full, 'internal').slice(-2).join() === [IMG(11), IMG(12)].join());
  ok('every page is drawn at the PDF\'s landscape size', new RegExp('width:' + PM.PAGE_W + 'px;height:' + PM.PAGE_H + 'px').test(PM.REPORT_CSS) && PM.PAGE_W > PM.PAGE_H);
  ok('the download name matches the engine\'s', PM.fileName(PROG, 'internal', new Date(2026, 10, 16)) === 'Green Cross SPIFF Media Postmortem (Internal) - Grön - 111626.pdf');
}

console.log('\n6. the screen');
{
  const html = PM.formHtml({ data: PM.applyOps({}, GRON_OPS), reports: [] }, { canEdit: true });
  ok('the form shows every entry with its numbers', (html.match(/data-pm-item="/g) || []).length === 6 && /value="157"/.test(html));
  ok('  …and both PDF buttons', /data-pm-pdf="vendor"/.test(html) && /data-pm-pdf="internal"/.test(html));
  const ro = PM.formHtml({ data: PM.applyOps({}, GRON_OPS), reports: [] }, { canEdit: false });
  ok('read-only: no PDF, add, remove or upload controls', !/data-pm-pdf|data-pm-add|data-pm-del|data-pm-upload/.test(ro));
  /* SOURCE-SHAPED (markup and wiring cannot run here). */
  const js = fs.readFileSync(path.join(__dirname, '..', 'spiff.js'), 'utf8');
  const hedge = (js.match(/var ENGINE_HEDGE_READS = \{([\s\S]*?)\};/) || [])[1] || '';
  ok('no post-mortem route is hedged on the client (a hedged write runs twice)', !/postmortem/i.test(hedge));
  ok('the fold is shown only behind the Marketing switch', /if \(!p \|\| !PM \|\| !mkOn\(\)\)/.test(js));
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ok('index.html loads postmortem.js and has the fold', /<script src="postmortem\.js\?v=/.test(index) && /id="calcPostmortemFold"/.test(index));
  ok('the logo it prints is in the repo', fs.existsSync(path.join(__dirname, '..', 'pm-logo.png')));
  const gs = G.GS;
  ok('the engine routes are wired', /case 'postmortem':\s+out = postmortemRead_/.test(gs) && /case 'savePostmortem':/.test(gs)
     && /case 'postmortemImages':/.test(gs) && /case 'postmortemUpload':\s+out = postmortemUpload_\(body\)/.test(gs) && /case 'postmortemSave':/.test(gs));
}

console.log('\n7. the loyalty blast, pulled from the Dutchie capture');
{
  /* The capture file as the Dutchie Connector writes it (CampaignResults.gs), holding the Grön blast
     with the numbers its campaign_results tool reported on 2026-11-16, another vendor's blast in the
     window and one long before it. */
  const day = (d, e, s) => ({ d, e: Object.assign({ rec: 0, del: 0, fail: 0, open: 0, click: 0, unsub: 0, ord: 0, rev: 0, on_ord: 0, on_rev: 0 }, e),
                                 s: Object.assign({ rec: 0, del: 0, fail: 0, click: 0, verified: 0, unsub: 0, ord: 0, rev: 0, on_ord: 0, on_rev: 0 }, s),
                                 p: { rec: 0, open: 0, ord: 0, rev: 0, on_ord: 0, on_rev: 0 }, direct: { ord: 0, rev: 0 } });
  const gron = { id: 101, name: 'Gron SPIFF blast Oct 26: $4 Pearls Tuesdays', send_utc: '2026-10-26T22:54:02', waterfall: false,
                 channels: { e: { to_send: 1948, sent: 950 }, s: { to_send: 4802, sent: 4802 } },
                 days: [day(0, { rec: 937, del: 925, fail: 12, open: 242, click: 7, unsub: 3, ord: 100, rev: 3000 }, { rec: 4802, del: 4717, fail: 41, click: 1223, unsub: 91, ord: 257, rev: 9045.96 }),
                        day(6, {}, {}), day(8, { ord: 40, rev: 1000 }, {})] };
  const other = { id: 102, name: 'Wyld weekend', send_utc: '2026-10-30T18:00:00', channels: { s: { to_send: 100, sent: 100 } }, days: [day(0, {}, { rec: 100, del: 99, click: 5 })] };
  const old = { id: 103, name: 'Gron summer', send_utc: '2026-07-01T18:00:00', channels: { s: { to_send: 9, sent: 9 } }, days: [] };
  const fileOf = (capturedAt) => JSON.stringify({ kind: 'gx_campaign_results', schema: 1, captured_at: capturedAt, received_at: capturedAt, campaigns: [gron, other, old] });

  function blastEngine(opts) {
    const o = opts || {};
    const opened = [];
    const mk = (id, name, content) => ({ getId: () => id, getName: () => name, isTrashed: () => false,
      getBlob: () => { opened.push(name); if (name !== 'gx-campaign-results.json') throw new Error('opened ' + name); return { getDataAsString: () => content }; } });
    const files = o.noFile ? [] : [mk('KEYFILE', 'gx-campaign-ingest-key.txt', 'secret'), mk('RESULTS', 'gx-campaign-results.json', fileOf(o.capturedAt || new Date().toISOString().slice(0, 19)))];
    const props = G.makeProps(o.props || {});
    const api = G.load({
      real: ['pmBlastFile_', 'pmFold_', 'pmShiftDay_', 'pmBlastDay_', 'pmBlastSummary_', 'postmortemBlasts_', 'mktEditor_'],
      vars: ['PM_BLAST_FOLDER_', 'PM_BLAST_FILE_', 'PM_BLAST_FILE_PROP', 'PM_BLAST_STALE_HOURS_', 'PM_BLAST_LEAD_DAYS_', 'PM_BLAST_ATTRIB_DAYS_', 'EDIT_ROLES'],
      stubs: {
        gxAuth_: (t) => (t === 'good' ? { ok: true, user: 'mike', role: o.role || 'editor' } : { ok: false, error: 'bad token' }),
        getProgram_: () => ({ ok: true, program: JSON.parse(JSON.stringify(PROG)) }),
        scrubSecrets_: (x) => String(x),
      },
      globals: {
        PropertiesService: props.PropertiesService, console: { warn() {}, log() {} },
        GXCore: { roleCanEdit: (r) => ['editor', 'admin', 'director', 'manager'].indexOf(r) >= 0 },
        DriveApp: {
          getFileById: (id) => { const f = files.filter((x) => x.getId() === id)[0]; if (!f) throw new Error('no file'); return f; },
          getFoldersByName: (n) => { let done = n !== 'GX Claude Exports'; return { hasNext: () => !done, next: () => { done = true; return {
            getFilesByName: (fn) => { const hit = files.filter((x) => x.getName() === fn); let i = 0; return { hasNext: () => i < hit.length, next: () => hit[i++] }; } }; } }; },
        },
      },
    });
    return { api, opened, props: props.props };
  }

  ok('a viewer is refused', blastEngine({ role: 'viewer' }).api.postmortemBlasts_({ token: 'good', id: PROG.program_id }).ok === false);
  const e = blastEngine();
  const r = e.api.postmortemBlasts_({ token: 'good', id: PROG.program_id });
  ok('it finds the Grön blast for vendor "Grön" (accents ignored)', r.ok && r.blasts.length === 1 && r.blasts[0].name === gron.name);
  ok('  …another vendor\'s blast in the window is offered separately', r.others.length === 1 && r.others[0].name === 'Wyld weekend');
  ok('  …and a blast from months before is not offered', JSON.stringify(r).indexOf('Gron summer') < 0);
  const b = r.blasts[0];
  ok('the totals match the connector\'s: 6,750 listed, 5,752 sent, 998 not sent', b.listed_audience === 6750 && b.sent_total === 5752 && b.not_sent === 998);
  ok('  …email 925 delivered, 242 opens; text 4,717 delivered, 1,223 clicks', b.email.delivered === 925 && b.email.opens === 242 && b.sms.delivered === 4717 && b.sms.clicks === 1223);
  ok('  …357 orders ($12,045.96) in the first 7 days, not the later ones', b.attributed.orders === 357 && b.attributed.revenue === 12045.96 && b.attributed.complete === true);
  ok('  …read in Oregon time: sent Oct 26', b.send_date === '2026-10-26');
  ok('only the results file is ever opened, never the ingest key', e.opened.length === 1 && e.opened[0] === 'gx-campaign-results.json');
  ok('  …and its id is remembered', e.props.PM_BLAST_FILE_ID === 'RESULTS');
  const trap = blastEngine({ props: { PM_BLAST_FILE_ID: 'KEYFILE' } });
  ok('a remembered id that names another file is not trusted', trap.api.postmortemBlasts_({ token: 'good', id: PROG.program_id }).ok && trap.opened.indexOf('gx-campaign-ingest-key.txt') < 0);
  ok('an old capture is flagged as stale', blastEngine({ capturedAt: '2026-10-01T00:00:00' }).api.postmortemBlasts_({ token: 'good', id: PROG.program_id }).stale === true);
  ok('  …a fresh one is not', r.stale === false);
  ok('no capture file says so, plainly', /No Dutchie blast results have been captured/.test(blastEngine({ noFile: true }).api.postmortemBlasts_({ token: 'good', id: PROG.program_id }).error));

  /* The screen: using that blast fills the entry and the internal pages. */
  const start = PM.applyOps({}, [['item', 'loy-1', { kind: 'loyalty', name: '', images: [IMG(1)], stats: {} }]]);
  const filled = PM.applyOps(start, PM.blastOps(start, 'loy-1', b));
  const it = filled.items[0];
  ok('the entry gets the reach (5,752 sent), the date and the blast name', it.stats.reach === 5752 && it.date === '2026-10-26' && it.name === gron.name.slice(0, 80));
  ok('  …says where it came from, and keeps the images Mike picked', /^Dutchie: Gron SPIFF blast/.test(it.ref) && it.images[0] === IMG(1));
  ok('the Email row: 950 sent, 97.4% delivered, 26.2% opened, 0.8% clicked, 3 unsubscribes',
     JSON.stringify(filled.channels.email) === JSON.stringify({ sent: '950', delivered: '97.4%', open: '26.2%', ctr: '0.8%', unsubs: '3' }));
  ok('the SMS row: 4.8K sent, 98.2% delivered, 25.9% clicked, 91 unsubscribes',
     JSON.stringify(filled.channels.sms) === JSON.stringify({ sent: '4.8K', delivered: '98.2%', ctr: '25.9%', unsubs: '91' }));
  ok('the send review: 5,752 of 6,750', filled.send.record_count === 5752 && filled.send.audience === 6750 && /Gron SPIFF blast/.test(filled.send.title));
  ok('  …with a reconciliation line and the orders line, while those notes are blank',
     filled.notes.reconcile === 'Dutchie sent 5.75K of the 6.75K listed (998 not sent).' && /357 orders \(\$12,045\.96\) in the 7 days after the send/.test(filled.notes.standout));
  const typed = PM.applyOps(start, [['note', 'reconcile', 'Mike wrote this.'], ['item', 'loy-1', { kind: 'loyalty', name: 'Mike named it', stats: {} }]]);
  const kept = PM.applyOps(typed, PM.blastOps(typed, 'loy-1', b));
  ok('a note or a name Mike typed is never overwritten', kept.notes.reconcile === 'Mike wrote this.' && kept.items[0].name === 'Mike named it');
  const html = PM.reportHtml(filled, PROG, 'internal', {}, {});
  ok('the internal report shows the pulled numbers and a 998 gap', /<b>998<\/b><span>Gap in displayed counts/.test(html) && /<td>Delivered<\/td><td>97\.4%<\/td><td>98\.2%<\/td>/.test(html));
  const form = PM.formHtml({ data: filled, reports: [] }, { canEdit: true });
  ok('the blast entry offers "Pull the numbers from Dutchie" and says where its numbers came from', /data-pm-blasts="loy-1"/.test(form) && /From Dutchie: Gron SPIFF blast/.test(form));
  ok('a stale capture is said out loud in the list', /more than two days old/.test(PM.blastListHtml({ ok: true, stale: true, captured_at: '2026-10-01T00:00:00', blasts: [], others: [], window: { from: 'a', to: 'b' } }, 'loy-1')));
  ok('the route is wired', /case 'postmortemBlasts':\s+out = postmortemBlasts_/.test(G.GS));
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
