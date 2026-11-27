import './helpers/no-browser.mjs';
import {testSbxRuntimeFields} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, readdir, stat, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DockerSbxBackend as RuntimeDockerSbxBackend } from '../lib/docker-backend.mjs';
import { collectOutputStream } from '../lib/output-collection.mjs';

class DockerSbxBackend extends RuntimeDockerSbxBackend {
  async _dispatchProtected(handle,signal,launch){await super.assertActive(handle);signal?.throwIfAborted();return launch();}
}

for (const ancestor of ['.wf-outputs', '.wf-outputs/nested']) {
  test(`output collection never writes through guest-controlled ${ancestor}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'output-boundary-test-'));
    const scratch = path.join(root, 'guest');
    const outside = path.join(root, 'outside');
    await mkdir(scratch); await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'unchanged');
    await mkdir(path.dirname(path.join(scratch, ancestor)), { recursive: true });
    await symlink(outside, path.join(scratch, ancestor));
    const bytes = Buffer.from('result\0\xff', 'latin1');
    const backend = new DockerSbxBackend({
      runCommand: async (args) => {
        if (args[0] === 'cp') await writeFile(args[2], bytes);
        return { code: 0, stdout: '', stderr: '' };
      },
      streamOutput: async function* () { yield bytes; },
    });
    try {
      const declared = ancestor.endsWith('nested') ? 'nested/result' : 'result';
      const result = await backend.collectDeclaredOutputs({ ...testSbxRuntimeFields(),sandbox_id: 'fixture', scratch_dir: scratch, _resources: { output_bytes: 100 } }, [declared]);
      assert.deepEqual(await readdir(outside), ['sentinel'], 'guest symlinks must cause zero outside writes');
      assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
      assert.deepEqual(result[0].bytes_content, bytes);
      assert.equal(result[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('staging replacement cannot redirect writes or hashing to a pathname', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'output-race-test-'));
  const sentinel = path.join(root, 'sentinel');
  await writeFile(sentinel, 'unchanged');
  let original;
  async function* stream() {
    yield Buffer.from('first');
    const directory = (await readdir(root)).find(name => name.startsWith('faravan-output-'));
    const output = path.join(root, directory, 'output');
    original = path.join(root, 'original');
    await rename(output, original);
    await symlink(sentinel, output);
    yield Buffer.from('second');
  }
  try {
    await assert.rejects(collectOutputStream(stream(), 100, { stageRoot: root }), { code: 'output_invalid' });
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
    assert.equal(await readFile(original, 'utf8'), 'firstsecond', 'writes retain the exclusive descriptor');
    assert.deepEqual((await readdir(root)).sort(), ['original', 'sentinel']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const infinite of [false, true]) {
  test(`output budget stops ${infinite ? 'an infinite' : 'an oversized'} transport and removes partial staging`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'output-cap-test-'));
    let cancelled = false;
    let written = 0;
    async function* stream() {
      try {
        yield Buffer.alloc(8);
        const directory = (await readdir(root))[0];
        written = (await stat(path.join(root, directory, 'output'))).size;
        if (infinite) while (true) yield Buffer.alloc(8);
        else yield Buffer.alloc(1024 * 1024);
      } finally { cancelled = true; }
    }
    try {
      await assert.rejects(collectOutputStream(stream(), 10, { stageRoot: root }), { code: 'output_too_large' });
      assert.equal(written, 8);
      assert.equal(cancelled, true);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('the real binary transport kills and reaps an oversized producer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'output-process-test-'));
  const bin = path.join(root, 'sbx');
  const pidFile = path.join(root, 'pid');
  await writeFile(bin, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfunction send(){if(process.stdout.write(Buffer.alloc(65536)))setImmediate(send);else process.stdout.once('drain',send)}send();\n`, { mode: 0o755 });
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = bin;
  try {
    const backend = new DockerSbxBackend();
    await assert.rejects(backend.collectDeclaredOutputs({ ...testSbxRuntimeFields(),sandbox_id: 'fixture', scratch_dir: root, _resources: { output_bytes: 10 } }, ['result']), { code: 'output_too_large' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'collection must wait for transport exit');
  } finally {
    if (previous === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a wall deadline cancels an idle output producer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'output-deadline-test-'));
  const bin = path.join(root, 'sbx');
  await writeFile(bin, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n', { mode: 0o755 });
  const previous = process.env.FARAVAN_SBX_BIN;
  process.env.FARAVAN_SBX_BIN = bin;
  const controller = new AbortController();
  const deadline = { controller, expired: false, cleanup: Promise.resolve({ removed: true }) };
  const timer = setTimeout(() => { deadline.expired = true; controller.abort(); }, 100);
  try {
    await assert.rejects(new DockerSbxBackend().collectDeclaredOutputs({ ...testSbxRuntimeFields(),sandbox_id: 'fixture', scratch_dir: root, _deadline: deadline, _resources: { output_bytes: 10 } }, ['result']), { code: 'wall_timeout' });
  } finally {
    clearTimeout(timer);
    if (previous === undefined) delete process.env.FARAVAN_SBX_BIN;
    else process.env.FARAVAN_SBX_BIN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
