#!/usr/bin/env node
/* ─── The script property store can be read and the switches set without the editor ────────────────
 *
 *   RUN:  node tests/props_store_test.js
 *
 * Sky, 2026-11-02: WIX_PUBLISH_ON=1 was set in the editor twice and did not stick. GX Core had the
 * same symptom that day (a full property store makes editor saves fail silently). This RUNS the two
 * secret-gated routes against an in-memory store and checks:
 *   · propsReport says how full the store is and which keys are biggest, and never shows a value
 *     other than a switch's (the store holds secrets)
 *   · setSwitch is dry by default, only touches the named switches, only takes 1 or 0, and reports a
 *     write that did not read back (a full store) as a failure rather than a success
 */
'use strict';
const G = require('./_gas');

let fail = 0;
const ok = (l, c) => c ? console.log('  ✓ ' + l) : (fail++, console.log('  ✗ ' + l));

const P = G.makeProps({ GX_DEPLOY_SECRET: 's3cret', CLIENT_VIEW_PASSWORD: 'hunter2', 'mktassigned:a': 'x',
                        'mktassigned:b': 'y', BIG_BLOB: 'z'.repeat(9000), CAL_SYNC_ON: '1' });
const api = G.load({
  real: ['propsReport_', 'propsReportWeb_', 'setSwitchWeb_'],
  vars: ['PROPS_STORE_LIMIT_', 'PROP_SWITCHES_', 'GX_SECRET_PROP'],
  stubs: { scrubSecrets_: String },
  globals: { PropertiesService: P.PropertiesService },
});

console.log('\n1. the report');
{
  ok('wants the deploy secret', api.propsReportWeb_({ secret: 'no' }).error === 'Unauthorized');
  const r = api.propsReportWeb_({ secret: 's3cret' });
  ok('counts the keys and the bytes', r.keys === 6 && r.bytes > 9000 && r.limit_bytes === 500000);
  ok('the biggest key comes first', r.biggest[0].key === 'BIG_BLOB' && r.biggest[0].bytes === 'BIG_BLOB'.length + 9000);
  ok('per-key stamps are totaled by prefix', r.by_prefix.some(b => b.prefix === 'mktassigned:' && b.keys === 2));
  ok('it shows the switches', r.switches.CAL_SYNC_ON === '1' && r.switches.WIX_PUBLISH_ON === null);
  const text = JSON.stringify(r);
  ok('and never a value: no secret, no password', text.indexOf('s3cret') < 0 && text.indexOf('hunter2') < 0 && text.indexOf('zzzz') < 0);
}

console.log('\n2. setting a switch');
{
  ok('wants the deploy secret', api.setSwitchWeb_({ secret: 'no', name: 'WIX_PUBLISH_ON', value: '1' }).error === 'Unauthorized');
  const dry = api.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: '1' });
  ok('is dry by default', dry.dry === true && !('WIX_PUBLISH_ON' in P.props));
  ok('only the named switches', /not a switch/.test(api.setSwitchWeb_({ secret: 's3cret', name: 'GX_DEPLOY_SECRET', value: '1', apply: '1' }).error)
     && P.props.GX_DEPLOY_SECRET === 's3cret');
  ok('only 1 or 0', /1 \(on\) or 0/.test(api.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: 'yes', apply: '1' }).error));
  const on = api.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: ' 1 ', apply: '1' });
  ok('apply=1 writes it and reads it back', on.ok === true && on.now === '1' && P.props.WIX_PUBLISH_ON === '1');
  const off = api.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: '0', apply: '1' });
  ok('  …and 0 turns it off again', off.ok === true && off.was === '1' && P.props.WIX_PUBLISH_ON === '0');
}
{
  /* A full store: the write appears to succeed and nothing is held, the way an editor save failed. */
  const full = G.makeProps({ GX_DEPLOY_SECRET: 's3cret' });
  const store = full.PropertiesService.getScriptProperties();
  store.setProperty = () => store;
  const api2 = G.load({ real: ['setSwitchWeb_'], vars: ['PROP_SWITCHES_', 'GX_SECRET_PROP'], stubs: { scrubSecrets_: String },
                        globals: { PropertiesService: full.PropertiesService } });
  const r = api2.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: '1', apply: '1' });
  ok('a write that does not read back is a failure, and says to look at the report', r.ok === false && /propsReport/.test(r.error));
  store.setProperty = () => { throw new Error('You have exceeded the property storage quota.'); };
  const t = api2.setSwitchWeb_({ secret: 's3cret', name: 'WIX_PUBLISH_ON', value: '1', apply: '1' });
  ok('a write the store refuses says so', t.ok === false && /quota/.test(t.error));
}

console.log('\n3. both are secret-only routes');
ok('on SECRET_ACTIONS', ['propsReport', 'setSwitch'].every(a => G.grabVar('SECRET_ACTIONS').indexOf(a) >= 0));

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
