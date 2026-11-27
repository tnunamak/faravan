import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runV1Command } from '../lib/v1/cli.mjs';
import { LAN_WARNING } from '../lib/protocol/index.mjs';

const fakeDevice = () => {
  const calls = {joined: 0};
  return {calls, joinCircle: async (link, opts) => {
    await opts.onWarning(LAN_WARNING);
    calls.joined++;
    return {name: 'Kitchen', warning: LAN_WARNING, enrollment: {state: 'approved'}};
  }};
};
const run = async (argv, extra = {}) => {
  let stdout = '', stderr = '';
  const device = fakeDevice();
  const code = await runV1Command(argv, {device, stdout: {write: s => stdout += s}, stderr: {write: s => stderr += s}, ...extra});
  return {code, stdout, stderr, device};
};

test('L4: a LAN invite is refused without --accept-lan-warning (human and --json)', async () => {
  for (const extra of [[], ['--json']]) {
    const r = await run(['circle', 'join', 'link', ...extra]);
    assert.equal(r.code, 2);
    assert.equal(r.device.calls.joined, 0);
    assert.match(r.stdout + r.stderr, /--accept-lan-warning/);
  }
});

test('L4: --accept-lan-warning joins; the warning is shown (stderr) or included in --json output', async () => {
  const human = await run(['circle', 'join', 'link', '--accept-lan-warning']);
  assert.equal(human.code, 0);
  assert.equal(human.device.calls.joined, 1);
  assert.ok(human.stderr.includes(LAN_WARNING));
  const machine = await run(['circle', 'join', 'link', '--accept-lan-warning', '--json']);
  assert.equal(machine.code, 0);
  assert.equal(JSON.parse(machine.stdout).warning, LAN_WARNING);
});

test('L4: on a terminal an interactive "yes" joins and anything else refuses', async () => {
  const tty = text => { const s = new PassThrough(); s.isTTY = true; s.end(text); return s; };
  const yes = await run(['circle', 'join', 'link'], {stdin: tty('yes\n')});
  assert.equal(yes.code, 0); assert.equal(yes.device.calls.joined, 1);
  const no = await run(['circle', 'join', 'link'], {stdin: tty('no\n')});
  assert.equal(no.code, 2); assert.equal(no.device.calls.joined, 0);
  const json = await run(['circle', 'join', 'link', '--json'], {stdin: tty('yes\n')});
  assert.equal(json.code, 2, '--json never prompts');
});
