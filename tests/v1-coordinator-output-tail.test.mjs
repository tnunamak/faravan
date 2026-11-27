import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOutputTail} from '../lib/v1/coordinator-output.mjs';

// A host that never becomes ready keeps the coordinator's last lines, so the next failure can be diagnosed.
test('the output tail keeps the last lines across chunk boundaries and writes them private to the owner', async () => {
  const tail = createOutputTail(3);
  tail.push('one\ntwo');
  tail.push('-part\nthree\nfour');
  assert.deepEqual(tail.lines(), ['two-part', 'three', 'four']);
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-tail-'));
  const file = join(dir, 'coordinator-last-output.log');
  tail.writeTo(file);
  assert.equal(await readFile(file, 'utf8'), 'two-part\nthree\nfour\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('the output tail redacts pairing URLs, bearer headers and API keys before reads and writes', async () => {
  const tail = createOutputTail();
  const secrets = ['pairing-secret', 'bearer-secret', 'sk-synthetic-secret-value'];
  tail.push('ready on port 4900\n');
  tail.push('pair https://example.test/join?token=pairing-secret&room=private-room#private-fragment\n');
  tail.push('Authorization: Bearer bearer-secret\nkey sk-synthetic-secret-value\n');
  assert.deepEqual(tail.lines(), [
    'ready on port 4900',
    'pair https://example.test/join?token=[redacted]&room=[redacted]#[redacted]',
    'Authorization: Bearer [redacted]',
    'key [redacted]',
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-tail-redacted-'));
  const file = join(dir, 'coordinator-last-output.log');
  tail.writeTo(file);
  const written = await readFile(file, 'utf8');
  for (const secret of [...secrets, 'private-room', 'private-fragment']) {
    assert.ok(!tail.lines().join('\n').includes(secret));
    assert.ok(!written.includes(secret));
  }
  assert.equal(written, tail.lines().join('\n') + '\n');
});

test('the output tail redacts credential pairs and long secret shapes while preserving diagnostics', () => {
  const tail = createOutputTail();
  tail.push('token=short; password: "two words", api_key=another-secret access-token=opaque\n');
  tail.push('Authorization: Basic c3ludGhldGljOnNlY3JldA==\n');
  tail.push('hex ' + 'a1'.repeat(20) + ' base64 ' + 'Ab9+'.repeat(12) + '==\n');
  tail.push('{"password":"escaped \\"quote\\" secret","Authorization":"Bearer json-secret"}\n');
  tail.push('attempt=2 status=ready host=localhost:4900\n');
  assert.deepEqual(tail.lines(), [
    'token=[redacted]; password: "[redacted]", api_key=[redacted] access-token=[redacted]',
    'Authorization: Basic [redacted]',
    'hex [redacted] base64 [redacted]',
    '{"password":"[redacted]","Authorization":[redacted]}',
    'attempt=2 status=ready host=localhost:4900',
  ]);
});

test('the output tail redacts unfinished lines and secrets split across chunks', async () => {
  const tail = createOutputTail();
  tail.push('pair https://example.test/join?tok');
  tail.push('en=split-secret#split-fragment');
  assert.deepEqual(tail.lines(), ['pair https://example.test/join?token=[redacted]#[redacted]']);
  const dir = await mkdtemp(join(tmpdir(), 'coordinator-tail-partial-'));
  const file = join(dir, 'coordinator-last-output.log');
  tail.writeTo(file);
  assert.equal(await readFile(file, 'utf8'), tail.lines().join('\n') + '\n');
  tail.push('\nAuthorization: Bea');
  tail.push('rer split-bearer');
  assert.equal(tail.lines().at(-1), 'Authorization: Bearer [redacted]');
  tail.push('\nkey sk-split');
  tail.push('-synthetic-key\nordinary output');
  assert.deepEqual(tail.lines().slice(-2), ['key [redacted]', 'ordinary output']);
  tail.push('\npassword="unfinished secret');
  assert.equal(tail.lines().at(-1), 'password="[redacted]"');
  tail.writeTo(file);
  assert.ok(!(await readFile(file, 'utf8')).includes('unfinished secret'));
  tail.push(' continues" status=ready\n');
  assert.equal(tail.lines().at(-1), 'password="[redacted]" status=ready');
});
