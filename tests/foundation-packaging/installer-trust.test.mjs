import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Exercise only the non-secret checker and dependency preflight from the real
// installer. This is not signature acceptance or an installer integration test.
const source = await readFile(new URL('../../bin/faravan-install.sh', import.meta.url), 'utf8');
function shellFunction(name) {
  const match = source.match(new RegExp('^' + name + '\\(\\) \\{\\n[\\s\\S]*?^\\}', 'm'));
  assert(match, name + ' must remain present');
  return match[0];
}
const preflight = shellFunction('need') + '\n' + shellFunction('preflight_linux_dependencies');
function probe(missing, rawin = true) {
  // No command can download, unpack or install. Calls are synthetic and logged.
  const script = [
    'set -eu',
    'die() { printf "%s\\n" "$*" >&2; exit 41; }',
    'command() { [ "$1" = -v ] || exit 92; printf "probe:%s\\n" "$2" >&2; [ "$2" != "$MISSING" ]; }',
    'openssl() { printf "%s\\n" "$HELP"; }',
    preflight,
    'CHANNEL=preview',
    'preflight_linux_dependencies',
    'echo RUNNABLE',
  ].join('\n');
  return spawnSync('/bin/sh', ['-c', script], {
    env: { PATH: '/usr/bin:/bin', MISSING: missing, HELP: rawin ? '-rawin' : 'old openssl' },
    encoding: 'utf8', timeout: 5000,
  });
}
test('preflight fails at the first missing tool before runnable output', () => {
  for (const tool of ['python3', 'curl', 'tar', 'openssl', 'base64']) {
    const r = probe(tool);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 41, r.stderr);
    assert.match(r.stderr, new RegExp("need '" + tool + "'"));
    assert.doesNotMatch(r.stdout, /RUNNABLE/);
  }
});
test('old verifier fails closed; complete tools reach runnable boundary', () => {
  const old = probe('', false);
  assert.equal(old.status, 41);
  assert.match(old.stderr, /needs OpenSSL 3/);
  assert.doesNotMatch(old.stdout, /RUNNABLE/);
  const good = probe('');
  assert.equal(good.error, undefined);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), 'RUNNABLE');
});
test('Linux support check invokes preflight before its runnable message', () => {
  const body = shellFunction('check_linux');
  assert(body.indexOf('preflight_linux_dependencies') >= 0);
  assert(body.indexOf('preflight_linux_dependencies') < body.indexOf('This computer can run Faravan.'));
});
test('existing manifest content checker accepts fixed bytes and rejects corruption', async () => {
  const checker = source.match(/^RELEASE_CHECK_PY='([\s\S]*?)^'$/m)?.[1];
  assert(checker, 'existing Python manifest checker');
  const home = await mkdtemp(join(tmpdir(), 'faravan-manifest-fixture-'));
  try {
    const payload = Buffer.from('fixed synthetic release payload\n');
    const manifest = {
      schema: 1, version: '1.0.0',
      sha256: createHash('sha256').update(payload).digest('hex'),
      size: payload.length,
    };
    const manifestPath = join(home, 'update.json'), payloadPath = join(home, 'payload');
    const invoke = () => spawnSync('python3', ['-I', '-c', checker, manifestPath, 'tarball', payloadPath, '0.1.0'], {
      encoding: 'utf8', timeout: 5000,
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(payloadPath, payload);
    let r = invoke();
    assert.equal(r.error, undefined, 'Python is a required verifier runtime, not a skip');
    assert.equal(r.status, 0, r.stderr);
    await writeFile(payloadPath, 'corrupt');
    r = invoke(); assert.notEqual(r.status, 0); assert.match(r.stderr, /does not match/);
    await writeFile(payloadPath, payload);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    r = invoke(); assert.notEqual(r.status, 0); assert.match(r.stderr, /does not match/);
    await writeFile(manifestPath, '{invalid');
    r = invoke(); assert.notEqual(r.status, 0); assert.match(r.stderr, /not valid JSON/);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, schema: 2 }));
    r = invoke(); assert.notEqual(r.status, 0); assert.match(r.stderr, /unsupported schema/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
