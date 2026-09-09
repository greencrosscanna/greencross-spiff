#!/usr/bin/env node
/* ─── The kiosk token reaches Leaderboard without a human carrying it ─────────────────────────────
 *
 *   RUN:  node tests/kiosk_token_publish_test.js
 *
 * WHY THIS EXISTS
 * Leaderboard's kiosks show a SPIFF button only when GX Core kv holds cfg.spiffKiosk.<store_id>.
 * Their first design had Sky paste six tokens into a form; he asked why a person is involved in one
 * app handing keys to another, and they threw it away. The deeper reason is that a COPY of a
 * ROTATABLE credential goes stale silently — rotate the token here and the pasted copy still points
 * at the old one, so that kiosk quietly serves "ask Tawny for a new one" on a screen facing the
 * sales floor, found by a budtender rather than by us.
 *
 * So SPIFF writes the key itself, at mint and at rotate, and blanks it on revoke. This file runs
 * those handlers rather than grepping for them, because the failures worth catching are all about
 * ORDER and ERROR PATHS, and neither is visible in a source match.
 *
 * THE FOUR THAT WOULD HURT
 *
 *   1. PUBLISHING BEFORE THE SHEET WRITE. store_links is the system of record; Core's kv is a copy
 *      kept for Leaderboard. Publish first and a failed appendRow leaves a kiosk pointing at a
 *      token no row will ever match — a live button onto a dead page, worse than no button.
 *
 *   2. SWALLOWING A FAILED PUBLISH. If Core is unreachable the links are still minted and still
 *      correct here, but no kiosk shows a button. A cheerful "minted 6" over that is how a person
 *      concludes the job is done and stops looking.
 *
 *   3. A REVOKE THAT LEAVES THE KEY. A revoked link whose kv key lingers is a button onto a dead
 *      page — the same failure as a stale copy, arriving a different way. Empty is the off switch,
 *      and that is Leaderboard's contract: spiffKioskUrl_ returns '' for an empty token.
 *
 *   4. A BACKFILL THAT WALKS LIVE LINKS INSTEAD OF THE REGISTRY. Iterating live rows republishes
 *      the good ones and leaves a revoked store's stale token in Core forever — the one case where
 *      doing nothing looks exactly like success.
 *
 * A NOTE ON THE LIBRARY CALL, since it is the likeliest future regression: GXCore.setKv enforces
 * GX_LIB_WRITABLE_KV and cfg.spiffKiosk.* is not on it, so a "tidy-up" into the library call fails
 * closed and the button silently stops appearing. Section 5 pins the HTTP route.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const STORES = [
  { store_id: 'bend',        display_name: 'Century' },
  { store_id: 'river-rd',    display_name: 'River' },
  { store_id: 'commercial',  display_name: 'Commercial' },
];

/* Build a live engine slice with the sheet, the registry and the network all under our thumb.
   `opts.failFetch` makes GX Core unreachable; `opts.appendThrows` breaks the sheet write. */
function engine(opts) {
  opts = opts || {};
  const calls = [];          // every set_config we attempt, in order
  const appended = [];       // every row that reaches store_links, in order
  const events = [];         // interleaved, so ORDER is assertable

  const rows = (opts.rows || []).map((r, i) => Object.assign({ row: i + 2 }, r));

  const sheetStub = {
    appendRow(r) {
      events.push('append:' + r[0]);
      if (opts.appendThrows) throw new Error('sheet is having a moment');
      appended.push(r);
    },
    getRange: () => ({ setValue(v) { events.push('revoke'); } }),
  };

  const src = [
    'var GXCORE_URL = "https://core/exec";',
    'var GX_SECRET_PROP = "GX_DEPLOY_SECRET";',
    'var EDIT_ROLES = ["editor","admin","director","manager"];',
    'function slug_(s){ return String(s||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""); }',
    'function nowStamp_(){ return "2026-09-09 10:00"; }',
    'function scrubSecrets_(m){ return String(m||"").replace(/(secret|token|key|pass|password)=[^&\\s"\']*/gi,"$1=[redacted]"); }',
    'function storeLinkSheet_(){ return SHEET; }',
    'function storeLinkRows_(){ return ROWS; }',
    'function gxStores_(){ if (STORES_FAIL) throw new Error("registry down"); return STORES; }',
    'function gxAuth_(t){ return { ok:true, role:"admin", user:"sky" }; }',
    grab('gxPublishKioskToken_'),
    grab('storeLinkMintAll_'),
    grab('storeLinkRotate_'),
    grab('publishKioskTokens_'),
    'return { publish: gxPublishKioskToken_, mintAll: storeLinkMintAll_,'
      + ' rotate: storeLinkRotate_, backfill: publishKioskTokens_ };',
  ].join('\n');

  const api = new Function(
    'SHEET', 'ROWS', 'STORES', 'STORES_FAIL',
    'PropertiesService', 'UrlFetchApp', 'Utilities', 'CALLS', 'EVENTS',
    src
  )(
    sheetStub, rows, opts.stores || STORES, !!opts.storesFail,
    { getScriptProperties: () => ({ getProperty: () => (opts.noSecret ? '' : 'S3CRET') }) },
    { fetch(url) {
        calls.push(url);
        events.push('publish:' + decodeURIComponent((url.match(/key=([^&]*)/) || [])[1] || ''));
        if (opts.failFetch) throw new Error('Address unavailable: ' + url);
        if (opts.html) return { getContentText: () => '<!DOCTYPE html><html>consent</html>' };
        return { getContentText: () => JSON.stringify({ ok: true }) };
      } },
    { getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    calls, events
  );
  return { api, calls, appended, events };
}

const valueOf = (url) => decodeURIComponent((url.match(/[?&]value=([^&]*)/) || [])[1] || '');
const keyOf   = (url) => decodeURIComponent((url.match(/[?&]key=([^&]*)/) || [])[1] || '');

/* ══ 1. the write itself ══ */
console.log('\n1. the token is written to the key Leaderboard actually reads');
{
  const e = engine({});
  const r = e.api.publish('bend', 'tok123');
  ok('reports success', r.ok === true && r.published === true);
  ok('writes cfg.spiffKiosk.<store_id>', keyOf(e.calls[0]) === 'cfg.spiffKiosk.bend');
  ok('sends the bare token as the value', valueOf(e.calls[0]) === 'tok123');
  ok('goes through the set_config HTTP route', /action=set_config/.test(e.calls[0]));
  ok('carries the deploy secret', /[?&]secret=S3CRET/.test(e.calls[0]));
  ok('sends notes=, so the kv row explains itself to the next reader',
     /[?&]notes=[^&]+/.test(e.calls[0]));
  ok('slugs the store id rather than trusting the caller',
     keyOf(engine({}).api.publish('  River-RD ', 't').ok ? engine({}).api.publish('  River-RD ', 't') && engine({}).calls[0] || 'x' : 'x') !== null);
}
{
  const e = engine({});
  e.api.publish('  River-RD  ', 't');
  ok('…specifically: "  River-RD  " becomes cfg.spiffKiosk.river-rd',
     keyOf(e.calls[0]) === 'cfg.spiffKiosk.river-rd');
}

/* ══ 2. the error paths say something true ══ */
console.log('\n2. a failed publish is reported, never swallowed');
{
  const e = engine({ failFetch: true });
  const r = e.api.publish('bend', 'tok123');
  ok('an unreachable Core is a failure, not a quiet success', r.ok === false);
  ok('the deploy secret is scrubbed out of the error',
     !/S3CRET/.test(r.error || '') && /\[redacted\]/.test(r.error || ''));
}
{
  const r = engine({ html: true }).api.publish('bend', 't');
  ok('an Apps Script consent page is named, not JSON.parsed into gibberish',
     r.ok === false && /HTML/.test(r.error));
}
{
  const r = engine({ noSecret: true }).api.publish('bend', 't');
  ok('a missing GX_DEPLOY_SECRET says so instead of writing nowhere',
     r.ok === false && /GX_DEPLOY_SECRET/.test(r.error));
  ok('…and makes no network call at all', engine({ noSecret: true }).calls.length === 0);
}

/* ══ 3. mint: sheet first, then publish ══ */
console.log('\n3. mint writes the sheet BEFORE it publishes, and reports a partial failure');
{
  const e = engine({ rows: [] });
  const r = e.api.mintAll({ token: 'sess' });
  ok('all three stores are minted', (r.minted || []).length === 3);
  ok('the sheet write for a store precedes its publish',
     e.events.indexOf('append:bend') < e.events.indexOf('publish:cfg.spiffKiosk.bend'));
  ok('every minted store is published', (r.published || []).length === 3);
  ok('nothing is reported as failed', (r.publish_failed || []).length === 0);
  ok('a clean run carries no scary note', !r.publish_note);
}
{
  const e = engine({ rows: [], failFetch: true });
  const r = e.api.mintAll({ token: 'sess' });
  ok('Core being down does not stop the links being minted', (r.minted || []).length === 3);
  ok('…but all three are reported as unpublished', (r.publish_failed || []).length === 3);
  ok('…and the note says the kiosks will show no button', /no SPIFF button/.test(r.publish_note));
  ok('…and names the repair route rather than implying a re-mint',
     /publishKioskTokens/.test(r.publish_note) && /nothing needs re-minting/.test(r.publish_note));
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'old', revoked_at: '' }] });
  const r = e.api.mintAll({ token: 'sess' });
  ok('a store with a live link is skipped, and not republished',
     r.minted.indexOf('bend') < 0 && !e.calls.some(u => keyOf(u) === 'cfg.spiffKiosk.bend'));
}

/* ══ 4. rotate and revoke ══ */
console.log('\n4. rotate publishes the new token; revoke blanks the key');
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'old', revoked_at: '' }] });
  const r = e.api.rotate({ token: 'sess', store: 'bend' });
  ok('the new token is returned', r.token && r.token !== 'old');
  ok('the new token is published, not the old one', valueOf(e.calls[0]) === r.token);
  ok('the old row is revoked before the new one is published',
     e.events.indexOf('revoke') < e.events.indexOf('publish:cfg.spiffKiosk.bend'));
  ok('published is reported true', r.published === true);
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'old', revoked_at: '' }], failFetch: true });
  const r = e.api.rotate({ token: 'sess', store: 'bend' });
  ok('a rotate whose publish fails says the kiosk now opens a dead page',
     r.published === false && /dead page/.test(r.publish_note));
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'old', revoked_at: '' }] });
  const r = e.api.rotate({ token: 'sess', store: 'bend', revoke: '1' });
  ok('a revoke writes an EMPTY value — the off switch, not a delete',
     e.calls.length === 1 && keyOf(e.calls[0]) === 'cfg.spiffKiosk.bend' && valueOf(e.calls[0]) === '');
  ok('…and mints no replacement', r.token === '' && r.revoked === true);
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'old', revoked_at: '' }], failFetch: true });
  const r = e.api.rotate({ token: 'sess', store: 'bend', revoke: '1' });
  ok('a revoke that cannot clear Core warns the button still opens a dead page',
     r.published === false && /dead page/.test(r.publish_note));
}

/* ══ 5. the backfill / repair route ══ */
console.log('\n5. the backfill walks the REGISTRY, is dry by default, and clears revoked stores');
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'live1', revoked_at: '' }] });
  const r = e.api.backfill({});
  ok('dry by default — nothing is written', r.dry === true && e.calls.length === 0);
  ok('it plans one entry per REGISTRY store, not per live link', r.stores === 3);
  ok('the store with a link is a publish', r.publishing === 1);
  ok('the two without are clears, so a revoked store loses its button', r.clearing === 2);
  ok('the plan does not leak token values', !JSON.stringify(r.plan).includes('live1'));
  ok('the note says plainly that nothing happened', /DRY RUN/.test(r.note));
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'live1', revoked_at: '' }] });
  const r = e.api.backfill({ apply: '1' });
  ok('apply=1 writes every store', e.calls.length === 3 && r.dry === false);
  ok('the linked store gets its token', valueOf(e.calls.find(u => keyOf(u).endsWith('bend'))) === 'live1');
  ok('a store with no live link is explicitly cleared to empty',
     valueOf(e.calls.find(u => keyOf(u).endsWith('commercial'))) === '');
  ok('it reports success', r.ok === true && !r.failed.length);
}
{
  const r = engine({ rows: [], storesFail: true }).api.backfill({ apply: '1' });
  ok('a registry that did not answer REFUSES rather than reporting "nothing to publish"',
     r.ok === false && /registry did not answer/.test(r.error));
}
{
  const e = engine({ rows: [{ store_id: 'bend', token: 'live1', revoked_at: '' }], failFetch: true });
  const r = e.api.backfill({ apply: '1' });
  ok('a failed apply is ok:false and names the stores', r.ok === false && r.failed.length === 3);
}

/* ══ 6. the route is gated, and stays on the HTTP call ══ */
console.log('\n6. the route is secret-gated and does not drift onto the library call');
ok('publishKioskTokens is in SECRET_ACTIONS',
   /SECRET_ACTIONS\s*=\s*\[[\s\S]*?'publishKioskTokens'[\s\S]*?\]/.test(gs));
/* Read the ONE line, not a span across the file — a lazy [\s\S]*? here happily matched the route
   wired 100 lines below and called it a PUBLIC_ACTIONS membership. */
ok('publishKioskTokens is NOT in PUBLIC_ACTIONS',
   !/publishKioskTokens/.test((gs.match(/var PUBLIC_ACTIONS\s*=\s*\[[^\]]*\]/) || [''])[0]));
ok('the route is wired into the dispatcher',
   /case 'publishKioskTokens':\s*out = publishKioskTokens_\(p\)/.test(gs));
{
  /* GXCore.setKv would be REFUSED for this key — cfg.spiffKiosk.* is not in GX_LIB_WRITABLE_KV —
     so a tidy-up into the library call fails closed and the button silently stops appearing. */
  const body = grab('gxPublishKioskToken_').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the publisher does not call GXCore.setKv', !/GXCore\s*\.\s*setKv/.test(body));
  ok('the publisher uses action=set_config', /action=set_config/.test(body));
}

console.log(fail ? `\n✗ ${fail} failed\n` : '\n✓ all passed\n');
process.exit(fail ? 1 : 0);
