#!/usr/bin/env node
/* ─── A bug that files but is never announced must not be silent ──────────────────────────────────
 *
 *   RUN:  node tests/bug_mail_fallback_test.js
 *
 * WHAT WAS WRONG. GX Core owns the bug email as of v310 and swallows its own mail failure on
 * purpose — a filed report has succeeded, and failing the call would throw a good row away over a
 * notification. Nothing else anywhere mentions it. SPIFF read neither `mail_error` nor
 * `mail_skipped` (0 hits across the whole repo, checked 2026-09-10), so a report that reached the
 * board and reached nobody's inbox looked exactly like one that worked. `mail_skipped` is the worse
 * half: no watch address plus a reporter with no address on file means nothing FAILED and nobody
 * was told.
 *
 * THE TRAP THIS FILE EXISTS FOR, because getting it wrong re-creates the duplicate-email bug
 * THROUGH the fix for it: gxIngestBug returns at its `priorBug` branch ABOVE the send, so a deduped
 * repeat carries NO mail field at all. Reading "no `mailed`" as failure would turn every /exec
 * redirect chain — measured re-executing one request up to three times — into three separate
 * "nobody was told" emails. `deduped` MUST be checked first.
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM LEADERBOARD'S VERSION. Leaderboard returns ok:true whatever
 * happens, so its reporter is actively misled and its unfiled notice is the only record anyone
 * tried. SPIFF has always returned the failure to the browser and gx-bugreport.js shows it. The
 * notice here therefore exists to preserve the TEXT — which lives in one browser modal and dies if
 * the reporter closes it — not to correct a false receipt. The assertions below pin that the return
 * contract to the browser is unchanged, because quietly adopting Leaderboard's ok:true would make
 * SPIFF lie to reporters in exchange for an email.
 *
 * These run the real functions out of Code.gs.
 */
'use strict';
const fs = require('fs');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const gs = fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8');
function grab(name) {
  const i = gs.search(new RegExp('\\nfunction ' + name + '\\s*\\('));
  if (i < 0) throw new Error('missing ' + name);
  let d = 0;
  for (let k = gs.indexOf('{', i); k < gs.length; k++) {
    if (gs[k] === '{') d++; else if (gs[k] === '}') { d--; if (!d) return gs.slice(i, k + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/* ── A harness that runs the real reportBug_ over a fake Core and a fake mailer ───────────────── */
let SENT, ONCE_CALLS, INGEST;
function run(ingest, p) {
  SENT = []; ONCE_CALLS = []; INGEST = ingest;
  const src = grab('bugUnfiled_') + '\n' + grab('bugUnannounced_') + '\n' + grab('reportBug_')
            + '\n; return reportBug_;';
  const fn = new Function(
    'GXCore', 'gxAuth_', 'bugNotify_', 'bugMailOnce_', 'nowStamp_',
    src)(
    { gxIngestBug: INGEST },
    () => ({ ok: true, user: 'tawny' }),
    (subject, lead, user, pp, title, desc) => SENT.push({ subject, lead: lead.join('\n'), title, desc }),
    (user, title, desc, kind) => { ONCE_CALLS.push(kind); return true; },
    () => '2026-09-10 12:00:00');
  return fn(p);
}
const REPORT = { title: 'Save button does nothing', desc: 'clicked twice', priority: 'high',
                 appVer: '1.398', context: 'TypeError: x is not a function' };

/* ══════════════════ 1. THE ORDINARY CASE SENDS NOTHING ══════════════════ */
let r = run(() => ({ ok: true, id: 'bug_1', mailed: true }), REPORT);
ok('a filed-and-mailed report sends no fallback', SENT.length === 0);
ok('  …and still returns the id to the browser', r.ok === true && r.id === 'bug_1');

/* ══════════════════ 2. FILED BUT NOBODY TOLD ══════════════════ */
r = run(() => ({ ok: true, id: 'bug_2', mail_error: 'Invalid email: undefined' }), REPORT);
ok('a mail_error raises the unannounced notice', SENT.length === 1);
ok('  …telling Sky NOT to re-file, because the row is there', /do NOT re-file/.test(SENT[0].lead));
ok('  …and naming the id so he can go and look at it', /bug_2/.test(SENT[0].lead));
ok('  …while the browser still gets a plain success', r.ok === true && r.id === 'bug_2');

/* mail_skipped is the half that reads as fine. Nothing failed; nobody was told. */
r = run(() => ({ ok: true, id: 'bug_3', mail_skipped: 'no recipient configured' }), REPORT);
ok('a mail_skipped raises it too — silence is not success', SENT.length === 1
   && /skipped/.test(SENT[0].lead));

/* ══════════════════ 3. THE DEDUPE TRAP ══════════════════ */
r = run(() => ({ ok: true, id: 'bug_2', deduped: true }), REPORT);
ok('a DEDUPED repeat sends nothing, though it carries no mail field', SENT.length === 0);
ok('  …and does not even reach the once-guard, so it cannot burn the mark',
   ONCE_CALLS.length === 0);
/* The ordering is the whole point: deduped must be tested before the missing mail field is. */
const ua = grab('bugUnannounced_');
ok('  …because deduped is checked BEFORE the mail fields',
   ua.indexOf('res.deduped') < ua.indexOf('mail_error'));

/* ══════════════════ 4. NOTHING FILED AT ALL ══════════════════ */
r = run(() => ({ ok: false, error: 'app required' }), REPORT);
ok('a refusal raises the unfiled notice', SENT.length === 1 && /NOT ON THE BUG BOARD/.test(SENT[0].lead));
ok('  …quoting why Core refused', /app required/.test(SENT[0].lead));
ok('  …and the browser STILL gets the failure, not a false receipt',
   r.ok === false && /app required/.test(r.error));

r = run(() => { throw new Error('DNS go boom'); }, REPORT);
ok('a throw raises it as well', SENT.length === 1 && /could not be reached/.test(SENT[0].lead));
ok('  …and the browser still gets the failure', r.ok === false && /DNS go boom/.test(r.error));

/* The two notices say opposite things, so they must never share a de-dupe mark. */
run(() => ({ ok: false, error: 'nope' }), REPORT);
const unfiledKind = ONCE_CALLS[0];
run(() => ({ ok: true, id: 'x', mail_error: 'nope' }), REPORT);
ok('the two notices mark separate keys, so neither suppresses the other',
   unfiledKind === 'unfiled' && ONCE_CALLS[0] === 'unannounced');

/* ══════════════════ 5. MAIL MAY NEVER BREAK THE REPORT ══════════════════ */
SENT = [];
const notify = new Function('MailApp', 'nowStamp_', grab('bugNotify_') + '; return bugNotify_;')(
  { sendEmail: () => { throw new Error('quota exhausted'); } }, () => 'now');
let threw = false;
try { notify('s', ['l'], 'u', REPORT, 't', 'd'); } catch (e) { threw = true; }
ok('a send that throws is swallowed — mail is the enhancement, the report is the thing', !threw);

/* ══════════════════ 6. THE ONCE-GUARD FAILS OPEN ══════════════════ */
const once = (cache, lock) => new Function('Utilities', 'LockService', 'CacheService',
  grab('bugMailOnce_') + '; return bugMailOnce_;')(
  { computeDigest: () => [1, 2, 3], DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
    base64EncodeWebSafe: () => 'KEY' },
  { getScriptLock: lock }, { getScriptCache: () => cache });

let store = {};
const good = once({ get: k => store[k], put: (k, v) => { store[k] = v; } },
                  () => ({ waitLock() {}, releaseLock() {} }));
ok('the first ask for a kind is allowed', good('u', 't', 'd', 'unfiled') === true);
ok('  …and an immediate repeat is not', good('u', 't', 'd', 'unfiled') === false);

const brokenCache = once({ get: () => { throw new Error('cache down'); }, put: () => {} },
                         () => ({ waitLock() {}, releaseLock() {} }));
ok('a broken cache sends anyway — better a duplicate email than a silent bug',
   brokenCache('u', 't', 'd', 'unfiled') === true);

let store2 = {};
const busyLock = once({ get: k => store2[k], put: (k, v) => { store2[k] = v; } },
                      () => ({ waitLock() { throw new Error('busy'); }, releaseLock() {} }));
ok('a lock it cannot take does not stop the send', busyLock('u', 't', 'd', 'unfiled') === true);

/* ══════════════════ 7. THE QUOTA THIS CANNOT ESCAPE IS REPORTED ══════════════════ */
ok('diag reports the remaining mail quota, since an exhausted one defeats the fallback',
   /d\.mailQuota = MailApp\.getRemainingDailyQuota\(\)/.test(grab('diag_')));

/* ══════════════════ 8. STILL ONE TRANSPORT ══════════════════
   The whole reason `deduped` is trusted above. A second transport (an HTTP ingest_bug alongside the
   library call) takes a different lock — the library call takes THIS script's, an HTTP ingest takes
   Core's — and Core's de-dupe stops covering us. If this ever fails, read the comment above
   bugUnfiled_ before touching anything else. */
/* COMMENTS ARE STRIPPED FIRST, and the first cut of this failed because of it: the comment above
   bugUnfiled_ explains the single-transport property, and saying the words "ingest_bug" made the
   grep find itself. A check that a note about a rule can break is not checking the rule. */
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*(\/\/|\*).*$/gm, ' ');
const files = ['/../apps-script/Code.gs', '/../spiff.js', '/../index.html', '/../client.html',
               '/../flyer.html'].map(f => strip(fs.readFileSync(__dirname + f, 'utf8'))).join('\n');
ok('SPIFF still files through exactly one transport', !/ingest_bug/.test(files));
ok('  …the bound library call', /GXCore\.gxIngestBug\('spiff'/.test(gs));

console.log(fail ? `\n✗ ${fail} failed` : '\n✓ bug mail fallback: all passed');
process.exit(fail ? 1 : 0);
