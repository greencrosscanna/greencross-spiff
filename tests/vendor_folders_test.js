#!/usr/bin/env node
/* ─── One upload folder per vendor, made and linked by the engine ────────────────────────────────
 *
 *   RUN:  node tests/vendor_folders_test.js
 *
 * Sky, 2026-11-02: every vendor gets a folder under Marketing ▸ Vendors that anyone with the link can
 * add files to, and its link sits on the vendor's programs. The engine's real code runs here against
 * a fake Drive: a new program makes its vendor's folder, a second program for the same vendor reuses
 * it, names fold ("National Cannabis Co." is "National Cannabis Co"), the backfill is dry unless told,
 * leaves closed programs alone, and never overwrites a link somebody set.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

function fakeDrive(existing) {
  let n = 0;
  const made = [], shared = [];
  const mk = (name, access, perm) => {
    const f = { id: 'f' + (++n), name, access: access || 'PRIVATE', perm: perm || 'VIEW',
      getName() { return this.name; }, getId() { return this.id; },
      getSharingAccess() { return this.access; }, getSharingPermission() { return this.perm; },
      setSharing(a, p) { this.access = a; this.perm = p; shared.push(this.name); } };
    return f;
  };
  const kids = (existing || []).map(e => mk(e.name, e.access, e.perm));
  const parent = {
    getFolders() { let i = 0; return { hasNext: () => i < kids.length, next: () => kids[i++] }; },
    createFolder(name) { const f = mk(name); kids.push(f); made.push(name); return f; }
  };
  const DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' },
    Permission: { EDIT: 'EDIT', VIEW: 'VIEW' },
    getFolderById: (id) => { if (id !== G.grabVar('VENDOR_FOLDERS_PARENT')) throw new Error('wrong folder ' + id); return parent; }
  };
  /* Sharing goes through the Drive REST API (DriveApp.setSharing is refused on a shared drive). */
  const calls = [];
  const UrlFetchApp = {
    fetch(url, o) {
      calls.push({ url, o });
      const id = (url.match(/files\/([^/]+)\/permissions/) || [])[1];
      const f = kids.filter(k => k.id === id)[0];
      const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
      if (!f) return reply(404, { error: 'no such file' });
      if (!/supportsAllDrives=true/.test(url)) return reply(404, { error: 'shared drive item needs supportsAllDrives' });
      if (o.method === 'get') return reply(200, { permissions: f.access === 'ANYONE_WITH_LINK' ? [{ type: 'anyone', role: f.perm === 'EDIT' ? 'writer' : 'reader' }] : [] });
      const b = JSON.parse(o.payload);
      if (b.type === 'anyone' && b.role === 'writer') { f.access = 'ANYONE_WITH_LINK'; f.perm = 'EDIT'; shared.push(f.name); }
      return reply(200, { id: 'p1' });
    }
  };
  const ScriptApp = { getOAuthToken: () => 'tok' };
  return { DriveApp, UrlFetchApp, ScriptApp, kids, made, shared, calls };
}

function engine(o) {
  const drive = fakeDrive(o.folders);
  const saved = [];
  const programs = (o.programs || []).map(p => JSON.parse(JSON.stringify(p)));
  const api = G.load({
    real: ['vendorFold_', 'vendorFolderFor_', 'withVendorFolder_', 'vendorFoldersRun_', 'normalizeMarketing_',
           'driveApi_', 'anyoneCanAdd_', 'shareAnyoneCanAdd_'],
    vars: ['VENDOR_FOLDERS_PARENT', 'MKT_PEOPLE_', 'DRIVE_PERMS_URL_'],
    stubs: {
      gxStores_: () => [{ store_id: 'portland-rd', display_name: 'Portland Rd' }],
      listPrograms_: () => programs,
      getProgram_: (id) => { const p = programs.filter(x => x.program_id === id)[0]; return p ? { ok: true, program: JSON.parse(JSON.stringify(p)) } : { ok: false }; },
      saveProgram_: (p) => { saved.push(p); return { ok: true }; },
      brandsRead_: () => (o.brandsFail ? { ok: false } : { ok: true, brands: o.brands || [] }),
      scrubSecrets_: (x) => String(x),
    },
    globals: { DriveApp: drive.DriveApp, UrlFetchApp: drive.UrlFetchApp, ScriptApp: drive.ScriptApp },
  });
  return { api, drive, saved };
}

const P = (id, vendor, status, mj) => ({ program_id: id, vendor, status: status || 'draft', marketing_json: mj || null });

console.log('\n1. a folder for a vendor');
{
  const e = engine({ folders: [{ name: 'Gron' }] });
  const a = e.api.vendorFolderFor_('Gron', true);
  ok('an existing folder is found by name, not made again', e.drive.made.length === 0 && a.id === 'f1' && !a.created);
  ok('  …and opened so anyone with the link can add files', e.drive.kids[0].access === 'ANYONE_WITH_LINK' && e.drive.kids[0].perm === 'EDIT' && a.shared);
  ok('  …its link is a Drive folder link', a.url === 'https://drive.google.com/drive/folders/f1');
  const again = e.api.vendorFolderFor_('gron', true);
  ok('asked again, it changes nothing', !again.created && !again.shared && e.drive.shared.length === 1);
  const post = e.drive.calls.filter(c => c.o.method === 'post')[0];
  ok('the share is one "anyone, writer" permission, not findable by search, sent with the token',
     JSON.stringify(JSON.parse(post.o.payload)) === '{"type":"anyone","role":"writer","allowFileDiscovery":false}'
     && post.o.headers.Authorization === 'Bearer tok' && /supportsAllDrives=true/.test(post.url));
  const b = e.api.vendorFolderFor_('National Cannabis Co.', true);
  const c = e.api.vendorFolderFor_('National Cannabis Co', true);
  ok('"National Cannabis Co." and "National Cannabis Co" are one folder, named without the dot',
     e.drive.made.join('|') === 'National Cannabis Co' && b.id === c.id);
  ok('a blank vendor gets nothing', e.api.vendorFolderFor_('  ', true) === null && e.drive.made.length === 1);
  const d = engine({}).api.vendorFolderFor_('Wyld', false);
  ok('a dry look makes nothing and says it would', d.dry && d.created && !d.url);
}

console.log('\n2. a new program gets its vendor\'s link');
{
  const src = G.grab('createProgram_');
  ok('createProgram_ finds or makes the folder and links it', /vendorFolderFor_\(draft\.vendor, true\)/.test(src) && /withVendorFolder_\(draft\.marketing_json/.test(src));
  ok('  …inside a try, so Drive can never stop a program being created', /try \{[\s\S]*vendorFolderFor_[\s\S]*\} catch \(e\)/.test(src));
  const e = engine({});
  const m = e.api.withVendorFolder_(null, 'https://drive.google.com/drive/folders/x');
  ok('the link lands in the plan as d.files.url', m && m.d.files.url === 'https://drive.google.com/drive/folders/x');
  ok('  …and a link already set is never overwritten', e.api.withVendorFolder_({ d: { files: { url: 'mine' } } }, 'theirs') === null);
}

console.log('\n3. the backfill for every vendor already known');
{
  const programs = [P('gron-1', 'Gron', 'active'), P('old', 'Gron', 'closed'), P('nc', 'National Cannabis Co.', 'draft'),
                    P('house', 'Green Cross', 'draft'), P('store', 'Portland Heights', 'draft'),
                    P('set', 'Wyld', 'draft', { d: { files: { url: 'https://drive.google.com/drive/folders/mine' } } })];
  const brands = [{ brand_id: 'mule-extracts', display_name: 'Mule Extracts', active: true }, { brand_id: 'gone', display_name: 'Gone Co', active: false }];
  let e = engine({ programs, brands, folders: [{ name: 'Gron' }] });
  const dry = e.api.vendorFoldersRun_(false);
  ok('dry: it writes nothing, makes nothing, shares nothing', e.saved.length === 0 && e.drive.made.length === 0 && e.drive.shared.length === 0 && dry.dry);
  ok('  …and names every vendor, from programs and the brand list', dry.folders.map(f => f.name).sort().join('|') === 'Gron|Mule Extracts|National Cannabis Co|Wyld');
  ok('  …leaving out our own name, a store, and a brand switched off', !dry.folders.some(f => /Green Cross|Portland|Gone/.test(f.name)));
  ok('  …and lists the programs it would link: not closed, not already set', dry.linked.sort().join('|') === 'gron-1|nc');
  e = engine({ programs, brands, folders: [{ name: 'Gron' }] });
  const run = e.api.vendorFoldersRun_(true);
  ok('apply: it makes the missing folders and opens every one', e.drive.made.sort().join('|') === 'Mule Extracts|National Cannabis Co|Wyld'
     && e.drive.kids.every(k => k.access === 'ANYONE_WITH_LINK' && k.perm === 'EDIT'));
  ok('  …and links the two programs, each to its own vendor\'s folder', e.saved.length === 2
     && e.saved.filter(p => p.program_id === 'gron-1')[0].marketing_json.d.files.url === 'https://drive.google.com/drive/folders/f1'
     && /folders\/f\d$/.test(e.saved.filter(p => p.program_id === 'nc')[0].marketing_json.d.files.url));
  ok('  …the closed program and the one with its own link are untouched', !e.saved.some(p => p.program_id === 'old' || p.program_id === 'set'));
  ok('  …and it reports success', run.ok && !run.dry && run.errors.length === 0);
  e = engine({ programs: [P('g', 'Gron')], brandsFail: true });
  const noBrands = e.api.vendorFoldersRun_(false);
  ok('if Core\'s brand list is down, the programs\' vendors still get done, and it says so', noBrands.brands_read === false && noBrands.folders.length === 1);
  e = engine({ programs: [P('g', 'Gron')], folders: [{ name: 'Gron' }] });
  e.drive.UrlFetchApp.fetch = () => ({ getResponseCode: () => 403, getContentText: () => '{"error":"sharing is off for this drive"}' });
  const refused = e.api.vendorFoldersRun_(true);
  ok('if Drive refuses the share, it says so and links nothing', !refused.ok && /403/.test(refused.errors[0]) && e.saved.length === 0);
}

console.log('\n4. the route and the screen');
{
  const route = (G.GS.match(/case 'vendorFolders':[\s\S]*?break;/) || [''])[0];
  ok('the backfill route needs the deploy secret', /GX_SECRET_PROP/.test(route) && /Unauthorized/.test(route));
  ok('  …and is dry unless apply=1', /vendorFoldersRun_\(String\(p\.apply \|\| ''\) === '1'\)/.test(route));
  const ctx = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
  const MK = ctx.SpiffMarketing;
  const linkOnly = { start_date: '2026-10-01', end_date: '2026-10-14', marketing_json: { v: 1, sel: {}, d: { files: { url: 'https://drive.google.com/drive/folders/x' } }, done: {}, due: {}, events: [], notes: '' } };
  ok('a program whose plan is only the folder link is not counted as planned', MK.overdueTotal([linkOnly], '2026-11-02', {}) === 0
     && /not set up yet/.test(MK.listLine(linkOnly, '2026-11-02', {})));
  const real = { start_date: '2026-10-01', end_date: '2026-10-14', marketing_json: { sel: { email: true }, d: { files: { url: 'x' } } } };
  ok('  …but one with anything picked still is', MK.overdueTotal([real], '2026-11-02', {}) > 0);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nvendor folders: all passed');
process.exit(fail ? 1 : 0);
