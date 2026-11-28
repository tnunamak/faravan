import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RUN_FLAGS} from '../lib/v1/lender.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';
import {jobFraming, JOB_FRAMING_VERSION} from '../lib/harnesses/job-framing.mjs';

const prompt = "Render an interesting zoom of the mandelbrot set, cel shaded\nKeep 'quotes', $HOME and `literal` exactly.\n";
const workspace = "/work/project with 'quotes'";
// The harness name is an executable basename, not necessarily a valid POSIX
// shell function name (faravan-pi is one example). Only fixtures are on PATH.
function captureArgv(binary, command) {
  const bin = mkdtempSync(join(tmpdir(), 'faravan-framing-'));
  try {
    writeFileSync(join(bin, binary), "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", {mode: 0o700});
    // The suite's CLI tripwire admits a protected name only from a declared fake directory; this one is.
    const output = execFileSync('/bin/sh', ['-c', command], {env: {...process.env, PATH: bin, TEST_CLI_FAKE_DIR: bin}});
    return output.toString().split('\0').slice(0, -1);
  } finally {
    rmSync(bin, {recursive: true, force: true});
  }
}

for (const adapter of HARNESS_ADAPTERS) {
  test(`${adapter.spec.harness_id}: job framing preserves the person's prompt`, () => {
    const args=RUN_FLAGS[adapter.spec.harness_id]?.({model:'test-model',effort:'medium'})??[];
    const command = adapter.jobCommand({prompt, workspace, args});
    const binary = adapter.spec.entrypoint.split(' ')[0];
    const argv = captureArgv(binary, command);
    for (const arg of args) assert.ok(argv.includes(arg), 'run flags survive framing');
    if (binary === 'gh') {
      assert.equal(argv.at(-1), prompt, 'gh is a credential utility, not a coding agent');
      return;
    }
    if (binary === 'gemini') assert.equal(argv.at(-2),'-p','Gemini prompt option stays adjacent to its value after model flags');
    const framing = jobFraming(workspace);
    assert.ok(argv.some(arg => arg.includes(framing)));
    assert.ok(argv.some(arg => arg === prompt || arg.endsWith('\n\n' + prompt)), 'prompt is byte-for-byte intact');
    assert.ok(framing.split(/\s+/).length < 80);
    assert.match(framing, /only changes to files in this folder/i);
    assert.match(framing, /faravan-output\//);
    assert.match(framing, /older agents may use faravan-output\//);
    assert.match(framing, /never in \/tmp or your home/i);
    assert.match(framing, /reviews the changes/i);
    assert.equal(JOB_FRAMING_VERSION, 1);
  });
}

for (const kind of ['message', 'files']) {
  for (const adapter of HARNESS_ADAPTERS.filter(a => a.spec.harness_id !== 'gh-cli')) {
    test(`${adapter.spec.harness_id}: a ${kind} job is framed to return faravan-output/, not code changes`, () => {
      const command = adapter.jobCommand({prompt, workspace, result: kind});
      const binary = adapter.spec.entrypoint.split(' ')[0];
      const argv = captureArgv(binary, command);
      const framing = jobFraming(workspace, kind);
      assert.ok(argv.some(arg => arg.includes(framing)));
      assert.ok(argv.some(arg => arg === prompt || arg.endsWith('\n\n' + prompt)), 'prompt is byte-for-byte intact');
      assert.ok(framing.includes(workspace + '/faravan-output/'), 'names the primary absolute output folder');
      assert.match(framing, /or faravan-output\/ come back/i, 'retains the legacy folder as an accepted alias');
      assert.match(framing, /not code changes/i);
      assert.doesNotMatch(framing, /reviews the changes|report\.md/i, 'no special report file is requested');
      if (kind === 'message') assert.match(framing, /final message is what they read.*markdown/i);
      else assert.doesNotMatch(framing, /final message/i);
      assert.ok(framing.split(/\s+/).length < 90);
    });
  }
}

test('code-change framing is unchanged by an absent or branch result', () => {
  assert.equal(jobFraming(workspace, undefined), jobFraming(workspace));
  assert.equal(jobFraming(workspace, 'branch'), jobFraming(workspace));
  for (const kind of ['report', 'diff']) assert.throws(() => jobFraming(workspace, kind));
});

test('headless agents declare questions without pretending a run is still waiting',()=>{
  assert.match(jobFraming('/workspace'),/QUESTION:/);
  assert.match(jobFraming('/workspace'),/final message/);
});
