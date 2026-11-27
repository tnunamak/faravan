import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {telemetryApp} from './helpers/telemetry-app.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/faravan', import.meta.url));

test('unattended update status cannot acknowledge the disclosure', {timeout: 60000}, async t => {
  const {f, tel} = await telemetryApp(t, {level: null});
  const home = await f.home('owner');
  assert.equal(tel.view().notice.pending, true);
  await run(process.execPath, [cli, 'update', 'status', '--json'], {env: {
    ...process.env, FARAVAN_HOME: home, DO_NOT_TRACK: '0',
    FARAVAN_NO_TELEMETRY: '0', FARAVAN_NO_AUTOSTART: '1',
  }});
  assert.equal(tel.view().notice.pending, true);
  assert.equal(tel.view().effective, 'off');
});
