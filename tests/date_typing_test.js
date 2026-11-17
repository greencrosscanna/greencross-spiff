/* A date box must not save while its year is still being typed (Mike, 2026-11-17).
   Chrome fires `change` on each keystroke in the year once the date is valid, so typing 2026 sends
   0002, 0020, 0202, 2026. Saving the first re-draws the box and the post date sticks at year 0002.
   Runs the real `wire` change handler from marketing.js with a fake host. */
const fs = require('fs'), path = require('path'), vm = require('vm');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) fails++; };

const ctx = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'marketing.js'), 'utf8'), ctx);
const MK = ctx.SpiffMarketing;
const p = { program_id: 'gron-1', marketing_json: '' };

function harness() {
  const applied = [];
  const host = { __mkWired: false, addEventListener(t, f) { this[t] = f; }, contains: () => true };
  MK.wire(host, { program: () => p, plan() {}, apply: (op) => applied.push(op), opts() { return {}; }, moving() {}, tick() {} });
  const type = (value, dataset) => host.change({ target: { type: 'date', value, dataset } });
  return { applied, type };
}

console.log('\n1. a social post date');
{
  const h = harness(), ds = { mkRitem: 'social', mkRow: '0', mkRfield: 'date' };
  ['0002-11-09', '0020-11-09', '0202-11-09'].forEach((v) => h.type(v, ds));
  ok('a half-typed year saves nothing', h.applied.length === 0);
  h.type('2026-11-09', ds);
  ok('the finished year saves once', h.applied.length === 1);
  h.type('', ds);
  ok('clearing the box still saves', h.applied.length === 2);
}

console.log('\n2. a vendor day date and a moved due date');
{
  const h = harness();
  h.type('0002-12-01', { mkVday: '0', mkVfield: 'date' });
  h.type('0020-12-01', { mkDue: 'core.stock' });
  ok('half-typed years save nothing', h.applied.length === 0);
  h.type('2026-12-01', { mkVday: '0', mkVfield: 'date' });
  h.type('2026-12-01', { mkDue: 'core.stock' });
  ok('finished years save', h.applied.length === 2);
}

console.log('\n3. a text box is untouched');
{
  ok('a text field is never held', MK.halfTypedDate({ type: 'text', value: '0002' }) === false);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
