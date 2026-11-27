import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliRunner, runJourney } from '../scripts/journey-check.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const canned = () => ({
  'update.status': {owner:'development',state:'idle',automatic:false,currentVersion:'1.2.3'},
  'status.blockers': {can_lend: true, blockers: []},
  'agents.list': [{id: 'codex', signedIn: true, useForLending: true}],
  'readiness.get': {ready: true, checks: [{name: 'docker_login', ok: true}]},
  'doctor.run': {status: 'ready', checks: [{name: 'docker_login', ok: true}]},
  'lending.get': {enabled: false, circle: 'friends'},
  'circles.list': [{id: 'friends', name: 'Friends'}],
  'circles.check': {state: 'approved'},
  'lending.on': {enabled: true},
  'jobs.send_and_wait': {jobDigest: digest, done: true, job: {state: 'result-accepted'}, changes: {patch: 'NEVER PRINT PATCH'}},
  'jobs.receipt': {receipt: {self_reported: true}, checks: [{cmd: 'npm test', exit: 0, timed_out: false}]},
  'jobs.apply_preview': {status: 'dry_run', expect: {head: 'a'.repeat(40), branch: 'faravan/example'}},
  'jobs.apply': {status: 'applied'},
});
const send = ['--send', '/fake/repo', '--prompt', 'Synthetic prompt', '--yes'];
async function fake(argv = [], overrides = {}, dependencies = {}) {
  const values = {...canned(), ...overrides}, calls = [], lines = [];
  const code = await runJourney(argv, {
    env: {FARAVAN_HOME: '/synthetic/home', FARAVAN_NO_AUTOSTART: '0'},
    hasNpmTest: async () => true,
    runner: async (file, args, options) => {
      assert.equal(file, 'faravan');
      assert.deepEqual(args.slice(0, 2), ['ops', 'call']);
      assert.equal(args[3], '--input'); assert.equal(args[5], '--json');
      assert.equal(options.env.FARAVAN_HOME, '/synthetic/home');
      assert.equal(options.env.FARAVAN_NO_AUTOSTART, '1');
      assert.equal(options.env.FARAVAN_NO_AUTOSTART, '1');
      assert.equal(options.env.FARAVAN_NO_BROWSER, '1');
      assert.equal(options.env.FARAVAN_NO_BROWSER, '1');
      const op = args[2];
      const expectedTimeout = op === 'update.status' ? 10000 : op === 'jobs.send_and_wait' && args.includes('--yes') && args.includes('--input')
        ? (JSON.parse(args[4]).timeout_seconds === 0 ? 5000 : 300000)
        : op === 'jobs.cancel' ? 5000 : op === 'jobs.wait' ? 30000 : 300000;
      assert.equal(options.timeout, expectedTimeout);
      calls.push({op, input: JSON.parse(args[4]), yes: args.includes('--yes')});
      assert.ok(Object.hasOwn(values, op), 'Unexpected operation: ' + op);
      const value = values[op];
      if (value instanceof Error) throw value;
      return value?.cliReply ?? {code: 0, stdout: JSON.stringify(value), stderr: 'SECRET STDERR'};
    },
    write: line => lines.push(line),
    ...dependencies,
  });
  return {code, calls, output: lines.join('\n')};
}
const ops = result => result.calls.map(call => call.op);

test('all-pass read-only journey uses the public CLI and never starts work by default', async () => {
  const result = await fake();
  assert.equal(result.code, 0);
  assert.deepEqual(ops(result), ['update.status', 'status.blockers', 'agents.list', 'readiness.get', 'doctor.run', 'lending.get', 'circles.list', 'circles.check']);
  assert.match(result.output, /can_lend=true/);
  assert.match(result.output, /codex: signed_in=yes, selected=yes/);
  assert.match(result.output, /Active circle: Friends/);
  assert.match(result.output, /Host answers/);
  assert.match(result.output, /status\.blockers \| PASS \| \d+ \|/);
  assert.match(result.output, /step \| PASS\/FAIL\/SKIP \| ms \| detail/);
  assert.match(result.output, /RESULT PASS first_fail=none/);
  assert.doesNotMatch(result.output, /SECRET STDERR/);
});

test('first blocker and its fix op fail the journey without automatic remediation', async () => {
  const result = await fake([], {'status.blockers': {can_lend: false, blockers: [
    {kind: 'docker_signed_out', fix: {op: 'signin.start', input: {token: 'DO NOT PRINT'}}},
  ]}});
  assert.equal(result.code, 1);
  assert.match(result.output, /first=docker_signed_out; fix=signin.start/);
  assert.ok(!ops(result).includes('signin.start'));
  assert.doesNotMatch(result.output, /DO NOT PRINT/);
});

test('opt-in send includes npm verification and receipt, then only an apply dry-run', async () => {
  const result = await fake(send);
  assert.equal(result.code, 0);
  const job = result.calls.find(call => call.op === 'jobs.send_and_wait');
  assert.equal(job.yes, true);
  assert.deepEqual(job.input.verify, {cmd: 'npm test'});
  assert.equal(job.input.circle, 'friends');
  assert.equal(job.input.repo.path, '/fake/repo');
  assert.equal(job.input.prompt, 'Synthetic prompt');
  assert.ok(ops(result).includes('jobs.receipt'));
  assert.ok(ops(result).includes('jobs.apply_preview'));
  assert.ok(!ops(result).includes('jobs.apply'));
  assert.match(result.output, /Result=result-accepted/);
  assert.match(result.output, /checks=1, passed=1/);
  assert.doesNotMatch(result.output, /NEVER PRINT PATCH|Synthetic prompt|\/fake\/repo/);
});

test('failed and unfinished jobs fail and do not fetch or apply a result', async () => {
  for (const [state, done] of [['failed', true], ['claimed', false], ['cancelled', true]]) {
    const result = await fake(send, {'jobs.send_and_wait': {done, jobDigest: digest, job: {state}}});
    assert.equal(result.code, 1);
    assert.ok(!ops(result).includes('jobs.receipt'));
    assert.ok(!ops(result).includes('jobs.apply_preview'));
    assert.ok(!ops(result).includes('jobs.apply'));
  }
});

test('missing --yes prevents all CLI calls, before lending', async () => {
  for (const argv of [
    send.filter(flag => flag !== '--yes'),
    ['--lend-on'], [...send.filter(flag => flag !== '--yes'), '--apply'],
  ]) {
    const result = await fake(argv);
    assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
    assert.match(result.output, /--yes is required/);
  }
});

test('explicit lending flags reach their corresponding operations', async () => {
  const result = await fake(['--lend-on', '--yes']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.find(call => call.op === 'lending.on').yes, true);
  assert.ok(!ops(result).includes('jobs.send_and_wait'));
});

test('--apply passes the exact preview expectation and --yes after good checks', async () => {
  const result = await fake([...send, '--apply']);
  assert.equal(result.code, 0);
  assert.equal(result.calls.at(-1).op, 'jobs.apply');
  assert.equal(result.calls.at(-1).yes, true);
  assert.deepEqual(result.calls.at(-1).input.expect, canned()['jobs.apply_preview'].expect);
});

test('failed or absent requested verification blocks real apply, but still previews', async () => {
  for (const checks of [[], [{cmd: 'npm test', exit: 1, timed_out: false}], [{cmd: 'npm test', exit: 0, timed_out: true}], [{cmd: 'other', exit: 0, timed_out: false}]]) {
    const result = await fake([...send, '--apply'], {'jobs.receipt': {receipt: {}, checks}});
    assert.equal(result.code, 1);
    assert.ok(ops(result).includes('jobs.apply_preview'));
    assert.ok(!ops(result).includes('jobs.apply'));
  }
});

test('invalid preview or apply refusal fails instead of claiming success', async () => {
  for (const preview of [{status: 'changed'}, {status: 'dry_run'}]) {
    const result = await fake([...send, '--apply'], {'jobs.apply_preview': preview});
    assert.equal(result.code, 1); assert.ok(!ops(result).includes('jobs.apply'));
  }
  assert.equal((await fake([...send, '--apply'], {'jobs.apply': {status: 'changed'}})).code, 1);
});

test('no active circle or unreachable host blocks sending and lending without guessing', async () => {
  for (const overrides of [
    {'lending.get': {enabled: false, circle: null}},
    {'circles.list': [{id: 'other', name: 'Other'}]},
    {'circles.check': {cliReply: {code: 1, stdout: '{"message":"SECRET"}'}}},
    {'circles.check': {state: 'pending'}},
  ]) {
    const result = await fake([...send, '--lend-on'], overrides);
    assert.equal(result.code, 1);
    assert.ok(!ops(result).includes('jobs.send_and_wait'));
    assert.ok(!ops(result).includes('lending.on'));
    assert.doesNotMatch(result.output, /SECRET/);
  }
});

test('malformed responses, thrown runner errors, and CLI timeouts are contained', async () => {
  for (const cliReply of [{code: 0, stdout: 'TOKEN invalid JSON'}, {code: 5, stdout: '{}'}, {code: 0, stdout: 'null'}]) {
    const result = await fake([], {'status.blockers': {cliReply}});
    assert.equal(result.code, 1); assert.doesNotMatch(result.output, /TOKEN/);
  }
  const result = await fake([], {'agents.list': new Error('secret=NEVER_PRINT')});
  assert.equal(result.code, 1); assert.doesNotMatch(result.output, /NEVER_PRINT/);
});

test('only allowlisted summaries are printed, with secret and terminal-label redaction', async () => {
  const result = await fake(send, {
    'agents.list': [{id: 'SensitiveLabel', token: 'SensitiveLabel', signedIn: true, useForLending: true, password: 'PASSWORD'}],
    'circles.list': [{id: 'friends', name: '\u001b[31mSECRET', invite: 'https://secret.invalid/?token=VALUE'}],
    'jobs.receipt': {receipt: {token: 'HIDDEN', arbitrary: 'PRIVATE'}, checks: [{cmd: 'npm test', exit: 0, timed_out: false, summary: 'SECRET LOG', stdout: 'PRIVATE'}]},
  });
  assert.equal(result.code, 0);
  assert.match(result.output, /redacted label/);
  assert.doesNotMatch(result.output, /SensitiveLabel|PASSWORD|SECRET|HIDDEN|PRIVATE|VALUE|\u001b/);
});

test('argument failures and help never launch the CLI', async () => {
  for (const argv of [['--send'], ['--prompt', 'x'], ['--apply', '--yes'], ['--unknown'], ['--yes', '--yes'], ['--send', '/x', '--prompt', ' ', '--yes']]) {
    const result = await fake(argv); assert.equal(result.code, 1); assert.deepEqual(result.calls, []);
  }
  const result = await fake(['--help']); assert.equal(result.code, 0); assert.deepEqual(result.calls, []);
});

test('package inspection chooses fixed npm test without executing or echoing package content', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journey-package-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const argv = ['--send', dir, '--prompt', 'fake', '--yes'];
  for (const source of [null, '{}', '{"scripts":{"test":"echo SECRET && exit 1"}}']) {
    if (source !== null) await writeFile(join(dir, 'package.json'), source);
    const result = await fake(argv, {}, {hasNpmTest: undefined});
    assert.equal(result.code, 0);
    const input = result.calls.find(call => call.op === 'jobs.send_and_wait').input;
    assert.deepEqual(input.verify, source?.includes('scripts') ? {cmd: 'npm test'} : undefined);
    assert.doesNotMatch(result.output, /SECRET/);
  }
  await writeFile(join(dir, 'package.json'), '{broken');
  const result = await fake(argv, {}, {hasNpmTest: undefined});
  assert.equal(result.code, 1); assert.ok(!ops(result).includes('jobs.send_and_wait'));
});

test('installed sign-in probe prints only the URL host and cancels each started flow', async () => {
  const result = await fake(['--signin-probe'], {
    'agents.list': [
      {id: 'codex', signedIn: true, useForLending: true, lendingSignInTarget: true},
      {id: 'claude-code-subscription', signedIn: false, lendingSignInTarget: 'claude-code-subscription-lending'},
    ],
    'signin.start': {flowId: 'flow-private', status: 'awaiting_browser',
      url: 'https://login.example.test/private/path?token=token-value', code: 'ONE-TIME-CODE'},
    'signin.cancel': {cancelled: true},
  });
  assert.equal(result.code, 0);
  const starts = result.calls.filter(call => call.op === 'signin.start');
  const cancels = result.calls.filter(call => call.op === 'signin.cancel');
  assert.deepEqual(starts.map(call => call.input.target), [
    'docker', 'codex', 'claude-code-subscription', 'codex-lending', 'claude-code-subscription-lending',
  ]);
  assert.equal(cancels.length, starts.length);
  for (const target of ['docker', 'codex', 'claude-code-subscription', 'codex-lending', 'claude-code-subscription-lending'])
    assert.ok(result.output.includes(`signin.start[${target}]`), `row label for ${target}`);
  assert.match(result.output, /login\.example\.test/);
  assert.doesNotMatch(result.output, /private\/path|ONE-TIME-CODE|token-value|flow-private/);
});

test('installed sign-in probe reports the stable failure code and keeps credentials out of the table', async () => {
  const result = await fake(['--signin-probe'], {
    'signin.start': {cliReply: {code: 1, stdout: JSON.stringify({code: 'signin_failed', message: 'secret token-value'}), stderr: 'PRIVATE'}},
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /signin_failed/);
  assert.doesNotMatch(result.output, /token-value|PRIVATE/);
});

test('installed sign-in probe accepts an already signed-in result without a flow to cancel', async () => {
  const result = await fake(['--signin-probe'], {
    'signin.start': {status: 'complete', already_signed_in: true},
  });
  assert.equal(result.code, 0);
  assert.match(result.output, /Already signed in/);
  assert.equal(result.calls.filter(call => call.op === 'signin.cancel').length, 0);
});

test('pending sign-in requires a flow id and confirmed cancellation; failed starts with ids are cancelled', async () => {
  const missingId = await fake(['--signin-probe'], {
    'signin.start': {status: 'awaiting_browser', url: 'https://login.example.test/path'},
  });
  assert.equal(missingId.code, 1);
  assert.match(missingId.output, /cleanup unknown/i);
  assert.equal(missingId.calls.filter(call => call.op === 'signin.cancel').length, 0);

  for (const cancel of [{}, null, {cancelled: 'false'}]) {
    const result = await fake(['--signin-probe'], {
      'signin.start': {flowId: 'flow-private', status: 'awaiting_browser', url: 'https://login.example.test/'},
      'signin.cancel': cancel,
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /signin\.cancel\[docker\] \| FAIL/);
  }

  const failedStart = await fake(['--signin-probe'], {
    'signin.start': {cliReply: {code: 1, stdout: JSON.stringify({
      flowId: 'flow-private', status: 'failed', code: 'signin_failed',
    })}},
    'signin.cancel': {cancelled: true},
  });
  assert.equal(failedStart.code, 1);
  assert.equal(failedStart.calls.filter(call => call.op === 'signin.cancel').length, 3);
  assert.doesNotMatch(failedStart.output, /flow-private/);

  // The real app answers signin.cancel with the flow's view: {flowId, target, status, message}.
  for (const status of ['cancelled', 'complete', 'failed', 'timed_out']) {
    const real = await fake(['--signin-probe'], {
      'signin.start': {flowId: 'flow-private', status: 'awaiting_browser', url: 'https://login.example.test/'},
      'signin.cancel': {flowId: 'flow-private', target: 'docker', status, message: 'Sign-in cancelled.'},
    });
    assert.match(real.output, /signin\.cancel\[docker\] \| PASS/, status);
  }
  const stillOpen = await fake(['--signin-probe'], {
    'signin.start': {flowId: 'flow-private', status: 'awaiting_browser', url: 'https://login.example.test/'},
    'signin.cancel': {flowId: 'flow-private', target: 'docker', status: 'awaiting_browser'},
  });
  assert.match(stillOpen.output, /signin\.cancel\[docker\] \| FAIL/);
});

test('a structured sign-in error is one FAIL row with no cleanup-unknown row', async () => {
  const result = await fake(['--signin-probe'], {
    'signin.start': {cliReply: {code: 4, stdout: JSON.stringify({code: 'signin_failed', message: 'private detail'})}},
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /signin\.start\[codex\] \| FAIL \| \d+ \| code=signin_failed/);
  assert.doesNotMatch(result.output, /signin\.cleanup/);
  assert.doesNotMatch(result.output, /private detail/);
});

test('sign-in timeout or throw reports cleanup unknown and cannot pass', async () => {
  const failures = [
    await fake(['--signin-probe'], {'signin.start': new Error('private failure')}),
    await fake(['--signin-probe'], {'signin.start': {cliReply: {code: 5, stdout: '', stderr: 'private'}}}),
  ];
  for (const result of failures) {
    assert.equal(result.code, 1);
    assert.match(result.output, /cleanup unknown/i);
    assert.doesNotMatch(result.output, /private/);
  }
});

test('signed-out valid agents still contribute lending sign-in targets', async () => {
  const result = await fake(['--signin-probe'], {
    'agents.list': [{id: 'codex', signedIn: false, useForLending: true, lendingSignInTarget: true}],
  });
  assert.equal(result.code, 1);
  assert.ok(result.calls.some(call => call.op === 'signin.start' && call.input.target === 'codex-lending'));
});

test('unknown adapter ids, failure codes, and check names use fixed labels', async () => {
  const result = await fake(['--signin-probe'], {
    'agents.list': [
      {id: 'private-value-123', token: 'private-value-123', signedIn: false,
        useForLending: false, lendingSignInTarget: 'private-value-123-lending'},
      {id: 'private-value-456', signedIn: false, useForLending: false},
    ],
    'signin.start': {cliReply: {code: 1, stdout: JSON.stringify({code: 'private-value-123'})}},
    'doctor.run': {status: 'setup_required', checks: [{name: 'private-value-123', ok: false}]},
    'readiness.get': {ready: true, checks: [{name: 'private-value-123', ok: false}]},
  });
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, /private-value-123/);
  assert.match(result.output, /unknown_code/);
  assert.match(result.output, /unknown_check/);
  assert.match(result.output, /other-target/);
});

test('doctor and readiness are checked in both directions and check shapes are validated', async () => {
  for (const overrides of [
    {'readiness.get': {ready: true, checks: []}, 'doctor.run': {status: 'setup_required', checks: []}},
    {'readiness.get': {ready: false, checks: []}, 'doctor.run': {status: 'ready', checks: [{name: 'docker_login', ok: true}]}},
    {'readiness.get': {ready: true, checks: []}, 'doctor.run': {status: 'ready', checks: [{name: 'docker_login'}]}},
    {'readiness.get': {ready: true, checks: [{name: 'docker_login'}]}, 'doctor.run': {status: 'ready', checks: []}},
  ]) {
    const result = await fake([], overrides);
    assert.equal(result.code, 1);
    assert.match(result.output, /readiness\.doctor-consistency \| FAIL/);
  }
});

test('readiness ready with a failed doctor check and command remedy both fail by check name', async () => {
  const result = await fake([], {
    'readiness.get': {ready: true, checks: [{name: 'docker_login', ok: true}]},
    'doctor.run': {status: 'setup_required', checks: [
      {name: 'docker_login', ok: false, fix: 'Run `sbx login` and retry.'},
    ]},
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /readiness\.doctor-consistency.*docker_login/);
  assert.match(result.output, /doctor\.remedies.*docker_login/);
  assert.doesNotMatch(result.output, /sbx login|Run `/);
});

test('doctor remedy detection rejects plain commands, terminal instructions, typed commands, and code blocks', async () => {
  for (const fix of [
    'Use docker login to sign in.',
    'Open Terminal and continue.',
    'Type docker login and press Enter.',
    'Run npm test.',
    '```\ndocker login\n```',
  ]) {
    const result = await fake([], {
      'doctor.run': {status: 'setup_required', checks: [{name: 'docker_login', ok: false, fix}]},
      'readiness.get': {ready: false, checks: [{name: 'docker_login', ok: false}]},
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /doctor\.remedies \| FAIL/);
    assert.doesNotMatch(result.output, /Use docker login to sign in|Open Terminal and continue|Type docker login and press Enter|Run npm test|docker login\n/);
  }
});

test('doctor remedy detection accepts in-app steps that use the words run or type', async () => {
  for (const fix of ['Run the safety test using the app button.', 'Type your email in the sign-in window.']) {
    const result = await fake([], {
      'doctor.run': {status: 'setup_required', checks: [{name: 'docker_login', ok: false, fix}]},
      'readiness.get': {ready: false, checks: [{name: 'docker_login', ok: false}]},
    });
    assert.match(result.output, /doctor\.remedies \| PASS/, fix);
  }
});

test('a structured agents.list error still prints the table and probes the fixed sign-in targets', async () => {
  const result = await fake(['--signin-probe'], {
    'agents.list': {cliReply: {code: 1, stdout: JSON.stringify({code: 'unavailable'}), stderr: ''}},
  });
  assert.match(result.output, /agents\.list \| FAIL/);
  assert.match(result.output, /signin\.start\[docker\]/);
  assert.match(result.output, /RESULT FAIL/);
});

test('stop path cancels a sent job and requires a bounded cancelled result', async () => {
  const stopped = await fake([...send, '--stop'], {
    'jobs.send_and_wait': {done: false, jobDigest: digest, job: {state: 'claimed'}},
    'jobs.cancel': {compute_stopped: true},
    'jobs.wait': {done: true, job: {state: 'cancelled', status: 'Cancelled'}},
  });
  assert.equal(stopped.code, 0);
  assert.deepEqual(ops(stopped).slice(-3), ['jobs.send_and_wait', 'jobs.cancel', 'jobs.wait']);
  assert.deepEqual(stopped.calls.find(call => call.op === 'jobs.cancel').input, {digest, circle: 'friends'});
  assert.equal(stopped.calls.find(call => call.op === 'jobs.cancel').yes, true);
  assert.equal(stopped.calls.find(call => call.op === 'jobs.wait').input.timeout_seconds, 30);
  assert.equal(stopped.calls.find(call => call.op === 'jobs.cancel').input.timeout_seconds, undefined);
  assert.match(stopped.output, /RESULT PASS/);

  const timedOut = await fake([...send, '--stop'], {
    'jobs.send_and_wait': {done: false, jobDigest: digest, job: {state: 'claimed'}},
    'jobs.cancel': {compute_stopped: false},
    'jobs.wait': {done: false, job: {state: 'claimed', status: 'Stopping'}},
  });
  assert.equal(timedOut.code, 1);
  assert.match(timedOut.output, /jobs\.wait \| FAIL/);

  const cliTimeout = await fake([...send, '--stop'], {
    'jobs.send_and_wait': {done: false, jobDigest: digest, job: {state: 'claimed'}},
    'jobs.cancel': {compute_stopped: false},
    'jobs.wait': {cliReply: {code: 5, stdout: '{}'}},
  });
  assert.equal(cliTimeout.code, 1);
  assert.match(cliTimeout.output, /jobs\.wait \| FAIL.*Timed out/);

  for (const job of [
    {state: 'result-accepted', status: 'Stopped'},
    {state: 'mystery', status: 'Cancelled'},
    {state: 'cancelled', status: 'Finished'},
  ]) {
    const result = await fake([...send, '--stop'], {
      'jobs.send_and_wait': {done: false, jobDigest: digest, job: {state: 'claimed'}},
      'jobs.cancel': {compute_stopped: true}, 'jobs.wait': {done: true, job},
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /jobs\.wait \| FAIL/);
  }

  const failedSendWithDigest = await fake([...send, '--stop'], {
    'jobs.send_and_wait': {cliReply: {code: 1, stdout: JSON.stringify({jobDigest: digest, done: false})}},
    'jobs.cancel': {compute_stopped: true}, 'jobs.wait': {done: true, job: {state: 'cancelled'}},
  });
  assert.equal(failedSendWithDigest.code, 1);
  assert.match(failedSendWithDigest.output, /jobs\.send_and_wait \| FAIL/);
  assert.match(failedSendWithDigest.output, /jobs\.wait \| PASS/);
  assert.ok(ops(failedSendWithDigest).includes('jobs.cancel'));
  assert.deepEqual(failedSendWithDigest.calls.find(call => call.op === 'jobs.cancel').input, {digest, circle: 'friends'});
  assert.match(failedSendWithDigest.output, /wall-clock bound|deadline/i);
});

test('execFile timeout maps signal termination to timeout and escalates against SIGTERM resistance', async () => {
  const started = Date.now();
  const result = await cliRunner(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    timeout: 100, killGraceMs: 100, encoding: 'utf8', maxBuffer: 4096,
  });
  assert.equal(result.code, 5);
  assert.ok(Date.now() - started < 1500, `timeout took ${Date.now() - started}ms`);
});

test('execFile timeout still settles when a descendant keeps the output pipes open', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journey-pipes-'));
  const pidFile = join(dir, 'descendant.pid');
  t.after(async () => {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(dir, {recursive: true, force: true});
  });
  const started = Date.now();
  const result = await cliRunner(process.execPath, ['-e',
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {stdio: ['ignore', 1, 2]}); require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref(); setInterval(() => {}, 1000)",
    pidFile], {
    timeout: 100, killGraceMs: 100, encoding: 'utf8', maxBuffer: 4096,
  });
  assert.equal(result.code, 5);
  assert.ok(Date.now() - started < 1500, `timeout took ${Date.now() - started}ms`);
});

test('fixed table and JSON output never expose URL paths, auth codes, or token-like values', async () => {
  const lines = [];
  const result = await runJourney(['--signin-probe'], {
    runner: async (_file, args) => {
      const op = args[2];
      if (op === 'agents.list') return {code: 0, stdout: JSON.stringify(canned()[op]), stderr: ''};
      if (op === 'signin.start') return {code: 0, stdout: JSON.stringify({
        flowId: 'flow-id', status: 'awaiting_browser',
        url: 'https://login.example.test/never-print?token=abc123', code: 'NEVER-PRINT-CODE',
      }), stderr: ''};
      return {code: 0, stdout: JSON.stringify(op === 'signin.cancel' ? {cancelled: true} : canned()[op] ?? {}), stderr: ''};
    },
    write: line => lines.push(line),
  });
  assert.equal(result, 0);
  const table = lines.join('\n');
  assert.match(table, /step \| PASS\/FAIL\/SKIP \| ms \| detail/);
  assert.match(table, /RESULT PASS first_fail=none/);
  assert.doesNotMatch(table, /never-print|abc123|NEVER-PRINT-CODE|flow-id/);

  const jsonLines = [];
  await runJourney(['--json', '--signin-probe'], {
    runner: async (_file, args) => {
      const values = {...canned(),
        'signin.start': {flowId: 'json-private-flow', status: 'awaiting_browser',
          url: 'https://login.example.test/private/path?token=json-secret'},
        'signin.cancel': {cancelled: true},
      };
      return {code: 0, stdout: JSON.stringify(values[args[2]] ?? {}), stderr: ''};
    },
    write: line => jsonLines.push(line),
  });
  const report = JSON.parse(jsonLines.join('\n'));
  assert.equal(report.result, 'PASS');
  assert.equal(report.first_fail, null);
  assert.ok(Array.isArray(report.steps));
  assert.doesNotMatch(jsonLines.join('\n'), /private\/path|json-secret|json-private-flow/);
});

test('an installed binary stub is invoked only through public ops calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journey-installed-stub-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const binary = join(dir, 'faravan');
  const callsFile = join(dir, 'calls.jsonl');
  const source = `#!/usr/bin/env node
const {appendFileSync} = require('node:fs');
const [group, verb, op, , inputText] = process.argv.slice(2);
if (group !== 'ops' || verb !== 'call') process.exit(9);
appendFileSync(process.env.STUB_CALLS_FILE, JSON.stringify({op, input: JSON.parse(inputText),
  faravanNoBrowser: process.env.FARAVAN_NO_BROWSER, faravanNoBrowser: process.env.FARAVAN_NO_BROWSER}) + '\\n');
const values = {
  'update.status': {owner:'development',state:'idle',automatic:false,currentVersion:'1.2.3'},
  'status.blockers': {can_lend: true, blockers: []},
  'agents.list': [{id: 'codex', signedIn: true, useForLending: true}],
  'readiness.get': {ready: true, checks: []},
  'doctor.run': {status: 'ready', checks: []},
  'lending.get': {enabled: false, circle: 'friends'},
  'circles.list': [{id: 'friends', name: 'Friends'}],
  'circles.check': {state: 'approved'},
  'signin.start': {flowId: 'private-flow', status: 'awaiting_browser', url: 'https://login.example.test/private/path', code: 'PRIVATE-CODE'},
  'signin.cancel': {cancelled: true},
};
process.stdout.write(JSON.stringify(values[op] ?? {}));
`;
  await writeFile(binary, source, {mode: 0o755});
  await chmod(binary, 0o755);
  const table = [];
  const result = await runJourney(['--binary', binary, '--signin-probe', '--step-timeout-ms', '5000'], {
    env: {...process.env, STUB_CALLS_FILE: callsFile, FARAVAN_NO_BROWSER: '1'},
    write: line => table.push(line),
  });
  assert.equal(result, 0, table.join('\n'));
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => typeof call.op === 'string' && call.input && !('token' in call.input)));
  // The wrapper refuses to run a binary it cannot identify, so pass the candidate's canonical path and digest.
  const expect = ['--expect-path', await realpath(binary), '--expect-sha256', createHash('sha256').update(await readFile(binary)).digest('hex')];
  const wrapperOutput = execFileSync('sh', ['scripts/verify-installed.sh', binary, ...expect], {
    env: {...process.env, STUB_CALLS_FILE: callsFile}, encoding: 'utf8', timeout: 70000,
  });
  if (process.env.SHOW_JOURNEY_STUB_TABLE === '1') process.stdout.write(wrapperOutput);
  assert.match(wrapperOutput, /RESULT PASS first_fail=none/);
  assert.doesNotMatch(wrapperOutput, /private\/path|PRIVATE-CODE/);
  const wrappedCalls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(wrappedCalls.every(call => call.faravanNoBrowser === '1' && call.faravanNoBrowser === '1'));

  const jsonWrapper = execFileSync('sh', ['scripts/verify-installed.sh', binary, ...expect, '--expect-version', '1.2.3', '--json'], {
    env: {...process.env, STUB_CALLS_FILE: callsFile}, encoding: 'utf8', timeout: 70000,
  });
  const report = JSON.parse(jsonWrapper);
  assert.equal(report.result, 'PASS');
  assert.doesNotMatch(jsonWrapper, /private\/path|PRIVATE-CODE|private-flow/);
});


async function startupJourney(answer, argv=['--expect-version','1.2.3']) {
  let time=0;
  const calls=[],lines=[],sleeps=[];
  const code=await runJourney(['--step-timeout-ms','60000','--json',...argv],{
    now:()=>time,
    sleep:async ms=>{sleeps.push(ms);time+=ms;},
    write:line=>lines.push(line),
    runner:async(_file,args,options)=>{
      const op=args[2];calls.push({op,at:time,timeout:options.timeout});
      if(op==='update.status')return answer({time,options,advance:ms=>{time+=ms;}});
      assert.equal(options.timeout,60000,'later operations retain the caller step timeout');
      return {code:0,stdout:JSON.stringify(canned()[op]),stderr:''};
    },
  });
  return {code,time,calls,sleeps,report:JSON.parse(lines.join('\n')),output:lines.join('\n')};
}
const updateReply=currentVersion=>({code:0,stdout:JSON.stringify({...canned()['update.status'],currentVersion}),stderr:''});

test('startup waits for the expected version at second 120 without failing transient polls',async()=>{
  const result=await startupJourney(({time})=>time<120000?{code:1,stdout:'',stderr:'PRIVATE connection refused'}:updateReply('1.2.3'));
  assert.equal(result.code,0,result.output);
  assert.equal(result.time,120000,'success is immediate when the expected app answers');
  assert.equal(result.calls[0].op,'update.status');
  assert.equal(result.calls.find(c=>c.op==='status.blockers').at,120000);
  assert.equal(result.report.steps.filter(s=>s.step==='app.ready').length,1);
  assert.equal(result.report.steps[0].state,'PASS');
  assert.equal(result.report.steps[0].ms,120000);
  assert.doesNotMatch(result.output,/PRIVATE/);
});

test('startup never-answer control stops at one 300-second deadline with last observation',async()=>{
  const result=await startupJourney(({options,advance})=>{
    advance(options.timeout);return {code:5,stdout:'',stderr:'PRIVATE timeout'};
  });
  assert.equal(result.code,1);
  assert.equal(result.time,300000);
  assert.ok(result.calls.every(c=>c.op==='update.status'));
  assert.ok(result.calls.every(c=>c.timeout<=300000-c.at));
  assert.ok(result.sleeps.every(ms=>ms>0&&ms<=1000));
  assert.equal(result.report.first_fail,'app.ready');
  assert.match(result.report.steps[0].detail,/Waited 300 seconds.*last.*timed out/i);
  assert.doesNotMatch(result.output,/PRIVATE/);
});

test('startup wrong version cannot pass even when the app answers every poll',async()=>{
  const result=await startupJourney(()=>updateReply('1.2.2'));
  assert.equal(result.code,1);
  assert.equal(result.time,300000);
  assert.ok(result.calls.every(c=>c.op==='update.status'));
  assert.match(result.report.steps[0].detail,/Waited 300 seconds.*version=1\.2\.2/);
});

test('startup without expected version accepts an answered unknown version',async()=>{
  for(const version of [null,undefined]) {
    const result=await startupJourney(()=>updateReply(version),[]);
    assert.equal(result.code,0,result.output);
    assert.equal(result.calls[0].op,'update.status');
    assert.equal(result.time,0);
  }
});

test('startup rejects malformed answers and suppresses private values',async()=>{
  for(const reply of [{code:0,stdout:'{}'},updateReply('PRIVATE secret token'),{code:0,stdout:'PRIVATE invalid JSON'}]){
    const result=await startupJourney(()=>reply);
    assert.equal(result.code,1);
    assert.equal(result.time,300000);
    assert.equal(result.report.first_fail,'app.ready');
    assert.doesNotMatch(result.output,/PRIVATE|secret token/);
  }
});

test('startup rejects a matching reply returned after the deadline',async()=>{
  const result=await startupJourney(({advance})=>{advance(300001);return updateReply('1.2.3');});
  assert.equal(result.code,1);
  assert.equal(result.calls.length,1);
  assert.equal(result.report.first_fail,'app.ready');
});


test('startup validates every present optional update field', async t => {
  const bad = {
    candidate: 42, checkedAt: 42, nextCheckAt: 42, notesUrl: 42,
    waitingFor: 42, error: 42, currentVersion: 42, notes: 'not-a-list',
  };
  const cases = {...Object.fromEntries(Object.entries(bad).map(([key,value]) => [key,{[key]:value}])),
    'review example': {candidate:42,notes:'not-a-list'}, 'notes element': {notes:['ok',42]}, 'notes null': {notes:null}};
  for (const [name, fields] of Object.entries(cases)) await t.test(name, async () => {
    const result = await startupJourney(() => ({code:0, stdout:JSON.stringify({...canned()['update.status'],...fields})}));
    assert.equal(result.code, 1, name);
    assert.equal(result.time, 300000);
    assert.equal(result.report.first_fail, 'app.ready');
    assert.ok(result.calls.every(c => c.op === 'update.status'));
  });
});

test('startup accepts absent and valid optional update fields', async () => {
  for (const fields of [{}, {candidate:null,checkedAt:null,nextCheckAt:null,notesUrl:null,waitingFor:null,error:null,notes:[]},
    {candidate:'1.2.4',checkedAt:'today',nextCheckAt:'later',notesUrl:'https://example.test',waitingFor:'idle',error:'none',notes:['one','two']}]) {
    const result = await startupJourney(() => ({code:0, stdout:JSON.stringify({...canned()['update.status'],...fields})}));
    assert.equal(result.code, 0, result.output);
    assert.equal(result.time, 0);
  }
});

test('startup retries an old version and connection exceptions until the expected app answers',async()=>{
  const result=await startupJourney(({time})=>{
    if(time===0)return updateReply('1.2.2');
    if(time<120000)throw Object.assign(new Error('PRIVATE socket path'),{code:'ECONNREFUSED'});
    return updateReply('1.2.3');
  });
  assert.equal(result.code,0,result.output);
  assert.equal(result.time,120000);
  assert.equal(result.report.steps[0].state,'PASS');
  assert.doesNotMatch(result.output,/PRIVATE|socket path/);
});
