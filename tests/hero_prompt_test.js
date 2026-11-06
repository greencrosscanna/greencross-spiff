#!/usr/bin/env node
/* ─── The hero image prompt: one fixed template, filled from the program's copy ──────────────────
 *
 *   RUN:  node tests/hero_prompt_test.js
 *
 * Sky, 2026-11-05: "build an image create prompt so we can quickly and consistently create the hero
 * image for deals". This RUNS heroPrompt() from marketing.js and checks:
 *   · the prompt states the Featured image spec (1200 x 1200, center 1080 safe zone, empty logo area)
 *   · it carries the headline, offer lines and the through-date exactly as typed
 *   · copy that breaks an OLCC rule (or a missing headline/vendor) produces NO prompt, only the reason
 *   · a known brand gets its tile color; an unknown one does not invent one
 *   · nothing in the template itself trips the copy rules the engine enforces
 * The button wiring is screen markup and cannot run here (it is covered by reading, not by a regex).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;

const prog = (o) => Object.assign({ program_id: 'gron-202611', vendor: 'Grön', end_date: '2026-11-08',
  marketing_json: { v: 1, sel: { web: true }, d: { web: { headline: 'Grön Pearls week' } },
    rows: { web: [{ text: '$4 off Pearls 10-packs, Tuesday Nov 3' }, { text: '30% off Grön at Commercial St, 1 to 3:30 PM' }] } } }, o || {});

console.log('— a normal program');
const r = MK.heroPrompt(prog(), { d: { web: { headline: 'Grön Pearls week' } } });
ok('it builds', r.ok === true);
ok('says 1200 x 1200', /1200 x 1200/.test(r.text));
ok('names the center 1080 safe zone', /1080 x 1080/.test(r.text));
ok('reserves an empty logo corner and forbids drawing a logo', /top-left/.test(r.text) && /Do not draw any logo/.test(r.text));
ok('carries the headline exactly', r.text.indexOf('"Grön Pearls week"') > -1);
ok('carries both offer lines exactly', r.text.indexOf('"$4 off Pearls 10-packs, Tuesday Nov 3"') > -1 && r.text.indexOf('"30% off Grön at Commercial St, 1 to 3:30 PM"') > -1);
ok('carries the through date', /Through Nov 8/.test(r.text));
ok('Grön gets its teal', r.text.indexOf('#7CD4CA') > -1);
ok('the prompt passes the OLCC copy rules itself', MK.copyProblem([r.text.replace(/Do not include:.*\n/, '')]) === '');
ok('no em-dash anywhere', r.text.indexOf('—') === -1);

console.log('— refusals');
const bad = MK.heroPrompt(prog({ marketing_json: { v: 1, d: { web: { headline: 'Buy one get one' } }, rows: {} } }), { d: { web: { headline: 'BOGO Pearls' } } });
ok('a rule-breaking headline makes no prompt', bad.ok === false && /bogo/.test(bad.why));
const badLine = MK.heroPrompt(prog({ marketing_json: { v: 1, d: { web: { headline: 'Pearls' } }, rows: { web: [{ text: 'Free pre-roll' }] } } }), { d: { web: { headline: 'Pearls' } } });
ok('a rule-breaking offer line makes no prompt', badLine.ok === false && /free/.test(badLine.why));
ok('no headline makes no prompt', MK.heroPrompt(prog(), { d: { web: {} } }).ok === false);
ok('no vendor makes no prompt', MK.heroPrompt(prog({ vendor: '' }), { d: { web: { headline: 'X' } } }).ok === false);

console.log('— unknown brand');
const u = MK.heroPrompt(prog({ vendor: 'Strainz', marketing_json: { v: 1, rows: {} } }), { d: { web: { headline: 'Strainz week' } } });
ok('builds without inventing a color', u.ok && !/#[0-9A-Fa-f]{6}\b.*solid/.test(u.text) && /own colors/.test(u.text));
ok('no through line when there is no end date', !/Through/.test(MK.heroPrompt(prog({ end_date: '' }), { d: { web: { headline: 'X' } } }).text));

process.exit(fail ? 1 : 0);
