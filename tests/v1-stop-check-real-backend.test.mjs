import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileSbx, receiptBackend} from './helpers/sandbox-receipt-fixture.mjs';
import {createStopCheck} from '../lib/v1/stop-check.mjs';
import {createStopEvidenceStore} from '../lib/v1/stop-evidence.mjs';

// Keep prepare/start/Stop/removal real. Only the sbx transport, independent
// supervisor and runtime bytes are fake; no provider sign-in or Docker is used.
test('the real backend stop check reaches guarded Stop and saves a receipt', {timeout: 20_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stop-check-real-'));
  const previous = {...process.env};
  t.after(async () => {
    for (const key of ['FARAVAN_SBX_BIN', 'FARAVAN_SCRATCH_ROOT', 'FARAVAN_SBX_HOME']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await rm(root, {recursive: true, force: true});
  });
  const stopped = join(root, 'stopped'), binary = join(root, 'sbx');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('status')) { console.log('Status: running'); process.exit(0); }
const command = process.argv.at(-1);
const config = JSON.parse(Buffer.from(command.match(/--config ([A-Za-z0-9+/=]+)/)[1], 'base64'));
fs.writeFileSync(${JSON.stringify(join(root, 'guard-config.json'))}, JSON.stringify(config));
console.log('faravan_stop_check_ready');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stopped)})) { clearInterval(timer); process.exit(0); } }, 10);
setTimeout(() => process.exit(1), 10000).unref();
`, {mode: 0o755});
  process.env.FARAVAN_SBX_BIN = binary;
  process.env.FARAVAN_SCRATCH_ROOT = join(root, 'scratch');
  process.env.FARAVAN_SBX_HOME = join(root, 'sbx-home');
  await mkdir(process.env.FARAVAN_SBX_HOME);
  const sbx = fileSbx(root), transport = sbx.run;
  sbx.run = async (args, options) => {
    if (args[0] === 'exec' && args.at(-1).includes(' stop ')) await writeFile(stopped, '');
    return transport(args, options);
  };
  const backend = receiptBackend(root, sbx, {guestRuntime: async () => ({dir: root, node: process.execPath, sha256: '0'.repeat(64)})});
  // Capability probing has its own tests; bind the sample to this fake CLI.
  backend.lenderCapabilities = async () => ({available: true, backend_id: 'docker-sbx', version: '9.9.9'});
  const errors = [], prepare = backend.prepare.bind(backend), start = backend.start.bind(backend);
  for (const [name, call] of [['prepare', prepare], ['start', start]]) backend[name] = async (...args) => {
    try { return await call(...args); } catch (error) {
      errors.push(`${error.code}: ${error.message}`);
      t.diagnostic(`${name} refused: ${errors.at(-1)}`);
      throw error;
    }
  };
  const store = createStopEvidenceStore({file: join(root, 'stop-evidence.json')});
  const result = await createStopCheck({backend, store, timeoutMs: 5000, stopAnswerMs: 1000})();
  assert.equal(result.ok, true, JSON.stringify({result, errors}));
  const config = JSON.parse(await readFile(join(root, 'guard-config.json'), 'utf8'));
  assert.equal(config.mode, 'generic');
  assert.equal(config.budget, null);
  const receipt = await store.current({backend_id: 'docker-sbx', sbx_version: '9.9.9'});
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.fallback, null);
  assert.equal(receipt.removed, true);
  assert.equal(sbx.created().length, 1);
  assert.deepEqual(sbx.read(), []);
});
