import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_HARNESS, CODEX_LENDING_HARNESS, CLAUDE_CODE_HARNESS, CLAUDE_CODE_SUBSCRIPTION_HARNESS,
  CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS, CLAUDE_CODE_API_KEY_HARNESS, GH_CLI_HARNESS, GEMINI_HARNESS } from '../lib/harnesses.mjs';
import { agentAuthFailure } from '../lib/harnesses/shared.mjs';
import { hasProvenIndefiniteRefresh } from '../lib/harness-spec.mjs';

test('Codex and Claude Code declare native file generations with distinct sign-in commands', () => {
  assert.equal(CODEX_HARNESS.auth_strategy, 'provider-file-generation');
  assert.equal(CLAUDE_CODE_HARNESS.auth_strategy, 'provider-file-generation');
  // Distinct login commands even though the strategy label is the same —
  // the correction warns against treating auth as one solved case.
  assert.notEqual(CODEX_HARNESS.credential_discovery.login_command, CLAUDE_CODE_HARNESS.credential_discovery.login_command);
});

test('subscription adapters keep native owner specs and add same-id proxy lending specs',()=>{
  for(const [owner,lending] of [[CODEX_HARNESS,CODEX_LENDING_HARNESS],[CLAUDE_CODE_SUBSCRIPTION_HARNESS,CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS]]) {
    assert.equal(owner.auth_strategy,'provider-file-generation');
    assert.equal(lending.harness_id,owner.harness_id);
    assert.equal(lending.auth_strategy,'docker-native-oauth');
    assert.equal(lending.credential_in_guest,false);
    assert.equal(lending.oauth_refresh.refresh_owner,'docker-builtin');
    assert.equal(lending.credential_discovery.flow_shape,'host-url-flow');
  }
  assert.equal(CODEX_LENDING_HARNESS.credential_discovery.login_command,'sbx secret set -g openai --oauth --force');
  assert.equal(CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS.credential_discovery.login_command,'claude auth login --claudeai');
});

test('Codex and Claude Code both report an explicit auth mode, not just request success', () => {
  assert.equal(CODEX_HARNESS.login_status_probe.reports_auth_mode, true);
  assert.equal(CLAUDE_CODE_HARNESS.login_status_probe.reports_auth_mode, true);
  assert.match(CODEX_HARNESS.login_status_probe.mode_field_hint, /Logged in using ChatGPT/);
  assert.match(CLAUDE_CODE_HARNESS.login_status_probe.mode_field_hint, /loggedIn:true/);
});

test('file generations disclose guest exposure and do not claim indefinite proxy refresh', () => {
  assert.equal(hasProvenIndefiniteRefresh(CODEX_HARNESS), false);
  assert.equal(hasProvenIndefiniteRefresh(CLAUDE_CODE_HARNESS), false);
  assert.equal(CODEX_HARNESS.credential_in_guest,true);
  assert.equal(CLAUDE_CODE_HARNESS.credential_in_guest,true);
});

test('the gh-cli extensibility harness uses host-env-proxy, not docker-native-oauth (it is not a built-in agent)', () => {
  assert.equal(GH_CLI_HARNESS.auth_strategy, 'host-env-proxy');
  assert.notEqual(GH_CLI_HARNESS.install, 'codex');
  assert.notEqual(GH_CLI_HARNESS.install, 'claude');
});

test('gh-cli honestly declares no refresh is needed rather than claiming refresh safety it cannot prove', () => {
  assert.equal(GH_CLI_HARNESS.oauth_refresh.supports_refresh, false);
  assert.equal(GH_CLI_HARNESS.oauth_refresh.refresh_owner, 'none');
  assert.equal(hasProvenIndefiniteRefresh(GH_CLI_HARNESS), false);
});

test('none of the three harnesses claim host-file-proxy/host-env-proxy docker-builtin refresh (the exact bug the correction targets)', () => {
  for (const harness of [CODEX_HARNESS, CLAUDE_CODE_HARNESS, GH_CLI_HARNESS]) {
    if (['host-file-proxy', 'host-env-proxy'].includes(harness.auth_strategy)) {
      assert.notEqual(harness.oauth_refresh.refresh_owner, 'docker-builtin', `${harness.harness_id} must not claim docker-builtin refresh under ${harness.auth_strategy}`);
    }
  }
});

test('Codex and Claude Code both use scriptable host-url-flows', () => {
  assert.equal(CODEX_HARNESS.credential_discovery.flow_shape, 'host-url-flow');
  assert.equal(CLAUDE_CODE_HARNESS.credential_discovery.flow_shape, 'host-url-flow');
});

test('both scriptable flows declare their URL prompt pattern', () => {
  assert.ok(CODEX_HARNESS.credential_discovery.url_prompt_pattern);
  assert.equal(CLAUDE_CODE_HARNESS.credential_discovery.url_prompt_pattern, 'visit:');
});

test('CLAUDE_CODE_HARNESS default alias resolves to the subscription variant, matching product intent', () => {
  assert.equal(CLAUDE_CODE_HARNESS, CLAUDE_CODE_SUBSCRIPTION_HARNESS);
  assert.equal(CLAUDE_CODE_HARNESS.harness_id, 'claude-code-subscription');
});

test('Claude Code has two real, independently-classified auth strategies — a product tradeoff, not a default silently picked for the operator', () => {
  assert.equal(CLAUDE_CODE_SUBSCRIPTION_HARNESS.auth_strategy, 'provider-file-generation');
  assert.equal(CLAUDE_CODE_API_KEY_HARNESS.auth_strategy, 'docker-stored-secret');
  assert.notEqual(CLAUDE_CODE_SUBSCRIPTION_HARNESS.harness_id, CLAUDE_CODE_API_KEY_HARNESS.harness_id);
});

test('CLAUDE_CODE_SUBSCRIPTION_HARNESS: scriptable browser flow without indefinite refresh qualification', () => {
  assert.equal(CLAUDE_CODE_SUBSCRIPTION_HARNESS.credential_discovery.flow_shape, 'host-url-flow');
  assert.equal(hasProvenIndefiniteRefresh(CLAUDE_CODE_SUBSCRIPTION_HARNESS), false);
});

test('CLAUDE_CODE_API_KEY_HARNESS: static docker-stored-secret, honestly no refresh claimed, smooth like Codex', () => {
  assert.equal(CLAUDE_CODE_API_KEY_HARNESS.credential_discovery.secret_name, 'anthropic');
  assert.equal(CLAUDE_CODE_API_KEY_HARNESS.oauth_refresh.supports_refresh, false);
  assert.equal(CLAUDE_CODE_API_KEY_HARNESS.oauth_refresh.refresh_owner, 'none');
  assert.equal(hasProvenIndefiniteRefresh(CLAUDE_CODE_API_KEY_HARNESS), false);
});

test('Claude Code variants need DIFFERENT login-status probes — corrected after live UAT found /status does not work headlessly', () => {
  // Originally both variants shared one probe based on `/status`. Confirmed
  // directly against a real install that `/status` is a REPL-only slash
  // command, unavailable in --print (faravan's only headless mode):
  // `claude --print --dangerously-skip-permissions "/status"` returns
  // "/status isn't available in this environment." Each variant now has its
  // own probe using a signal that's actually checkable non-interactively —
  // and they are deliberately NOT the same signal, because
  // SBX_CRED_ANTHROPIC_MODE only reflects the docker-stored-secret path
  // (confirmed: it stays "none" through a successful subscription-authed
  // task run), so it cannot serve as the subscription variant's probe too.
  assert.notDeepEqual(CLAUDE_CODE_SUBSCRIPTION_HARNESS.login_status_probe, CLAUDE_CODE_API_KEY_HARNESS.login_status_probe);
  // The probe must not START with /status (a stray mention explaining why
  // it's avoided is fine — the comment text above legitimately says
  // "NOT /status"; what matters is the actual command isn't literally that).
  assert.equal(CLAUDE_CODE_SUBSCRIPTION_HARNESS.login_status_probe.command, 'claude auth status --json');
  assert.deepEqual(CLAUDE_CODE_SUBSCRIPTION_HARNESS.login_status_probe.success, { loggedIn: true, authMethod: 'claude.ai' });
  assert.match(CLAUDE_CODE_API_KEY_HARNESS.login_status_probe.mode_field_hint, /SBX_CRED_ANTHROPIC_MODE/);
});

test('gh-cli install is the kit manifest name (sbx run AGENT positional), not a file path — real sbx errors on a path/agent mismatch', () => {
  // Confirmed against a real sbx v0.35.0 install: `sbx run --name X shell
  // <path> --kit <kit-dir>` fails with 'agent name "shell" does not match
  // agent kit name "wf-gh-cli"' — the AGENT positional for a kind:sandbox
  // kit must equal the kit's own manifest `name`.
  assert.equal(GH_CLI_HARNESS.install, 'wf-gh-cli');
  assert.equal(/[/.]/.test(GH_CLI_HARNESS.install), false, 'install must not look like a path or filename');
});

test('Codex entrypoint includes --dangerously-bypass-approvals-and-sandbox — required for unattended execution inside the sbx microVM', () => {
  // Live UAT found Codex's own first-run "Do you trust the contents of this
  // directory?" trust prompt blocks a faravan task forever (no terminal
  // to answer it). Confirmed via `codex exec --help` on a real install that
  // this flag is intended exactly for this case: "Intended solely for
  // running in environments that are externally sandboxed." Reproduced
  // directly: a task with this flag ran to completion and exited; without
  // it, the sandbox sits idle at the prompt.
  assert.match(CODEX_HARNESS.entrypoint, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(CODEX_HARNESS.entrypoint, /^codex exec/);
});

test('both Claude Code variants include --dangerously-skip-permissions — same external-sandbox rationale as Codex', () => {
  // Confirmed via `claude --help` on a real install: "Bypass all permission
  // checks." Required for the same reason as Codex's bypass flag — a
  // faravan task has no terminal to answer an in-process permission
  // prompt, and the microVM (not Claude's own guard) is Faravan's real
  // containment boundary.
  assert.match(CLAUDE_CODE_SUBSCRIPTION_HARNESS.entrypoint, /--dangerously-skip-permissions/);
  assert.match(CLAUDE_CODE_API_KEY_HARNESS.entrypoint, /--dangerously-skip-permissions/);
  assert.match(CLAUDE_CODE_SUBSCRIPTION_HARNESS.entrypoint, /^claude --print/);
  assert.match(CLAUDE_CODE_SUBSCRIPTION_HARNESS.entrypoint, /--verbose --output-format stream-json/);
});

test('gh-cli entrypoint needs no bypass flag — gh subcommands are non-interactive by construction for the harness\'s use case', () => {
  // Confirmed directly: `gh --version` and `gh auth status` both run and
  // exit cleanly with no prompt of any kind — gh is a subcommand CLI, not an
  // interactive agent session, so it has no first-run trust/approval prompt
  // to bypass in the first place.
  assert.equal(GH_CLI_HARNESS.entrypoint, 'gh');
});

test('Gemini is classified docker-stored-secret, not docker-native-oauth — sbx --oauth is openai-only, confirmed live', () => {
  // Same limitation class already found for Anthropic: `sbx secret set
  // --help` hard-codes --oauth to openai/global only. There is no
  // host-drivable Google subscription OAuth in this sbx release.
  assert.equal(GEMINI_HARNESS.auth_strategy, 'docker-stored-secret');
  assert.equal(GEMINI_HARNESS.credential_discovery.secret_name, 'google');
  assert.equal(GEMINI_HARNESS.oauth_refresh.supports_refresh, false);
  assert.equal(GEMINI_HARNESS.oauth_refresh.refresh_owner, 'none');
  assert.equal(hasProvenIndefiniteRefresh(GEMINI_HARNESS), false);
});

test('Gemini entrypoint includes both --approval-mode yolo AND --skip-trust — confirmed these are two SEPARATE gates', () => {
  // Live UAT found --approval-mode yolo alone does not clear gemini-cli's
  // first-run directory-trust prompt; --skip-trust is required separately.
  assert.match(GEMINI_HARNESS.entrypoint, /--approval-mode yolo/);
  assert.match(GEMINI_HARNESS.entrypoint, /--skip-trust/);
  assert.match(GEMINI_HARNESS.entrypoint, /^gemini /);
  // -o json for structured, parseable headless output; -p as the final
  // token so the appended task prompt becomes its value once start() joins
  // entrypoint + prompt through `sh -c`.
  assert.match(GEMINI_HARNESS.entrypoint, /-o json/);
  assert.match(GEMINI_HARNESS.entrypoint, /-p$/);
});

test('Gemini harness never claims an --effort flag — gemini-cli has none, confirmed via --help', () => {
  assert.equal(/--effort|--reasoning-effort/.test(GEMINI_HARNESS.entrypoint), false);
});

test('Gemini install is the built-in sbx agent template name, matching `sbx run --help`\'s listed agents', () => {
  assert.equal(GEMINI_HARNESS.install, 'gemini');
});

import { HARNESS_ADAPTERS, getHarnessAdapter, DEFAULT_IDENTITY_PROBE_HARNESSES, parseIdentityEvidence } from '../lib/harnesses/index.mjs';
import { OPENCODE_HARNESS } from '../lib/harnesses.mjs';
import { parseHarnessExecutionResult, parseProviderAccount, statusProbeCommand, capacityKindForHarness, resolveHarness } from '../lib/executor.mjs';

test('registry owns all adapters and preserves legacy identity defaults', () => {
  assert.deepEqual(DEFAULT_IDENTITY_PROBE_HARNESSES, ['claude-code-subscription', 'codex', 'gemini', 'gh-cli']);
  assert.equal(HARNESS_ADAPTERS.length, 7);
  for (const adapter of HARNESS_ADAPTERS) {
    assert.equal(getHarnessAdapter(adapter.spec.harness_id), adapter);
    assert.equal(resolveHarness(adapter.spec.harness_id).image, adapter.spec.install);
    assert.equal(capacityKindForHarness(adapter.spec), adapter.capacityKind());
    assert.equal(statusProbeCommand(adapter.spec.harness_id), adapter.statusProbeCommand());
  }
  assert.equal(getHarnessAdapter('__proto__'), null);
  assert.throws(() => resolveHarness('__proto__'), /unknown --harness/);
});

test('legacy recorded/documented stdout shapes have identical adapter and compatibility results', () => {
  // Existing pull fixture shapes, with independent expected values.
  const cases = [
    ['codex', '{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.completed","usage":{"input_tokens":18795,"cached_input_tokens":10496,"output_tokens":6,"reasoning_output_tokens":0}}', { model: null, usage: { input_tokens: 18795, output_tokens: 6 } }],
    ['claude-code-subscription', '{"type":"result","usage":{"input_tokens":15166,"output_tokens":63},"modelUsage":{"claude-fable-5":{}}}', { model: 'claude-fable-5', usage: { input_tokens: 15166, output_tokens: 63 } }],
    ['claude-code-api-key', '{"type":"assistant"}\n{"type":"result","model":"claude-fable-5","usage":{"input_tokens":8,"output_tokens":3}}', { model: 'claude-fable-5', usage: { input_tokens: 8, output_tokens: 3 } }],
    ['gemini', '{"model":"gemini-2.5-pro","stats":{"inputTokens":12,"outputTokens":7}}', { model: 'gemini-2.5-pro', usage: { input_tokens: 12, output_tokens: 7 } }],
    ['gh-cli', 'github.com account example', { model: null, usage: null }],
  ];
  for (const [id, stdout, expected] of cases) {
    assert.deepEqual(getHarnessAdapter(id).parseExecutionResult(stdout), expected);
    assert.deepEqual(parseHarnessExecutionResult(id, stdout), expected);
    for (const malformed of ['', 'not json', '{}']) {
      assert.deepEqual(parseHarnessExecutionResult(id, malformed), { model: null, usage: null });
    }
  }
  const statuses = [
    ['claude-code-subscription', '{"loggedIn":true,"authMethod":"claude.ai","email":"test@example.test","subscriptionType":"max"}', { email: 'test@example.test', tier: 'max' }],
    ['claude-code-api-key', '{"loggedIn":true}', {}],
    ['codex', 'Logged in using an API key', {}],
    ['gemini', 'SBX_CRED_GOOGLE_MODE=apikey', {}],
    ['gh-cli', 'Logged in to github.com', {}],
  ];
  for (const [id, stdout, expected] of statuses) {
    assert.deepEqual(getHarnessAdapter(id).parseProviderAccount(stdout), expected);
    assert.deepEqual(parseProviderAccount(id, stdout), expected);
    assert.equal(parseProviderAccount(id, ''), null);
  }
  assert.deepEqual(parseHarnessExecutionResult('unknown', '{}'), { model: null, usage: null });
  assert.equal(parseProviderAccount('unknown', 'logged in'), null);
  assert.equal(statusProbeCommand('unknown'), null);
  assert.equal(capacityKindForHarness({ auth_strategy: 'host-auth-adapter-required' }), 'gateway');
  assert.throws(() => capacityKindForHarness({ auth_strategy: 'unknown' }), /unknown harness auth strategy/);
});

// Synthetic fixtures derived from official v1.18.35 source, NOT live recordings:
// https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/cli/cmd/run.ts
// https://github.com/anomalyco/opencode/blob/v1.18.35/packages/schema/src/v1/session.ts
let openCodeFixtureId = 0;
const openCodeStep = (input, output, overrides = {}) => ({
  type: 'step_finish', timestamp: 1760000000000, sessionID: 'ses_fixture',
  part: { id: `prt_fixture_${++openCodeFixtureId}`, sessionID: 'ses_fixture', messageID: 'msg_fixture',
    type: 'step-finish', reason: 'stop', cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } },
  ...overrides,
});
const openCodeJsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');

test('OpenCode pinned-source-derived step fixtures aggregate usage without inventing model', () => {
  const adapter = getHarnessAdapter('opencode');
  const stdout = openCodeJsonl(
    { type: 'step_start', sessionID: 'ses_fixture', part: { id: 'start_fixture', type: 'step-start', sessionID: 'ses_fixture', messageID: 'msg_fixture' } },
    { type: 'text', sessionID: 'ses_fixture', part: { type: 'text', text: 'done' } },
    openCodeStep(10, 4), openCodeStep(5, 2),
  );
  const expected = { model: null, usage: { input_tokens: 15, output_tokens: 6 } };
  assert.deepEqual(adapter.parseExecutionResult(stdout), expected);
  assert.deepEqual(parseHarnessExecutionResult('opencode', stdout), expected);
  assert.deepEqual(adapter.parseExecutionResult(openCodeJsonl(openCodeStep(0, 0))), { model: null, usage: { input_tokens: 0, output_tokens: 0 } });
  assert.deepEqual(adapter.parseExecutionResult(openCodeJsonl(openCodeStep(1, 2, { model: 'requested-not-observed' }))), { model: null, usage: { input_tokens: 1, output_tokens: 2 } });
});

test('OpenCode keeps malformed, missing, overflowing and cross-session usage unknown', () => {
  for (const stdout of ['', '{}', 'not json', '{"type":"error","error":{"name":"APIError"}}',
    openCodeJsonl(openCodeStep(null, 2)), openCodeJsonl(openCodeStep(-1, 2)),
    openCodeJsonl(openCodeStep('1', 2)), openCodeJsonl(openCodeStep(1.5, 2)),
    openCodeJsonl(openCodeStep(Number.MAX_SAFE_INTEGER, 2), openCodeStep(1, 2)),
    openCodeJsonl(openCodeStep(1, 2), openCodeStep(1, 2, { sessionID: 'other' })),
    openCodeJsonl(openCodeStep(1, 2)) + '\n{"type":',
  ]) assert.deepEqual(parseHarnessExecutionResult('opencode', stdout), { model: null, usage: null });
});

test('OpenCode auth metadata honestly discloses guest exposure and unverified execution', () => {
  assert.equal(OPENCODE_HARNESS.auth_strategy, 'guest-env-api-key');
  assert.equal(OPENCODE_HARNESS.credential_in_guest, true);
  assert.equal(OPENCODE_HARNESS.recommended_egress, 'provider-only');
  assert.match(OPENCODE_HARNESS.notes, /live-unverified/);
  assert.match(OPENCODE_HARNESS.notes, /not implemented/);
  assert.equal(hasProvenIndefiniteRefresh(OPENCODE_HARNESS), false);
  assert.deepEqual(OPENCODE_HARNESS.egress_provider_hosts, ['openrouter.ai']);
  assert.equal(statusProbeCommand('opencode'), 'opencode auth list');
  assert.equal(parseProviderAccount('opencode', '1 credential OpenRouter api'), null);
  for (const adapter of HARNESS_ADAPTERS.filter((a) => !['opencode','pi','codex','claude-code-subscription'].includes(a.spec.harness_id))) {
    assert.equal(adapter.spec.credential_in_guest, false);
  }
});

test('OpenCode includes cached input and reasoning output exactly once per step', () => {
  const step = openCodeStep(10, 4);
  step.part.tokens = { input: 10, output: 4, reasoning: 3, cache: { read: 7, write: 2 } };
  assert.deepEqual(parseHarnessExecutionResult('opencode', openCodeJsonl(step, step)),
    { model: null, usage: { input_tokens: 19, output_tokens: 7 } });
  const conflict = structuredClone(step);
  conflict.part.tokens.input = 11;
  assert.deepEqual(parseHarnessExecutionResult('opencode', openCodeJsonl(step, conflict)), { model: null, usage: null });
  for (const mutate of [
    (s) => { delete s.part.tokens.cache; },
    (s) => { delete s.part.tokens.reasoning; },
    (s) => { s.part.tokens.cache.read = -1; },
    (s) => { s.part.tokens.reasoning = '3'; },
    (s) => { s.part.tokens.cache.read = Number.MAX_SAFE_INTEGER; },
    (s) => { delete s.part.id; },
    (s) => { s.part.sessionID = 'different'; },
    (s) => { s.part.type = 'text'; },
  ]) {
    const invalid = structuredClone(step); mutate(invalid);
    assert.deepEqual(parseHarnessExecutionResult('opencode', openCodeJsonl(invalid)), { model: null, usage: null });
  }
});

test('OpenCode incomplete lifecycle and error streams do not claim full usage', () => {
  const finished = openCodeStep(10, 4);
  const started = {
    type: 'step_start', sessionID: 'ses_fixture',
    part: { id: 'start_pending', type: 'step-start', sessionID: 'ses_fixture', messageID: 'msg_pending' },
  };
  for (const stdout of [
    openCodeJsonl(finished, started),
    openCodeJsonl(finished, { type: 'error', sessionID: 'ses_fixture', error: { name: 'APIError' } }),
    openCodeJsonl(started, finished),
  ]) assert.deepEqual(parseHarnessExecutionResult('opencode', stdout), { model: null, usage: null });
  const matching = openCodeStep(2, 1);
  matching.part.messageID = 'msg_pending';
  assert.deepEqual(parseHarnessExecutionResult('opencode', openCodeJsonl(started, started, matching, matching)),
    { model: null, usage: { input_tokens: 2, output_tokens: 1 } });
});

test('every adapter module beside the registry is registered explicitly', async () => {
  const { readdirSync } = await import('node:fs');
  const { HARNESS_ADAPTERS } = await import('../lib/harnesses/index.mjs');
  const files = readdirSync(new URL('../lib/harnesses/', import.meta.url)).filter((name) => name.endsWith('.adapter.mjs'));
  assert.equal(HARNESS_ADAPTERS.length, files.length, 'add an import line in lib/harnesses/index.mjs for each *.adapter.mjs');
});

const CODEX_401 = '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Could not parse your authentication token. Please try signing in again., url: https://chatgpt.com/backend-api/codex/responses, cf-ray: abc)"}\n{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}\n';

test('agentAuthFailure recognises a failed Codex and Claude sign-in loss', () => {
  assert.equal(agentAuthFailure({ stdout: CODEX_401, stderr: '', exitCode: 1 }), true);
  assert.equal(agentAuthFailure({ stdout: '', stderr: 'Invalid API key · Please run /login', exitCode: 1 }), true);
  assert.equal(agentAuthFailure({ stdout: 'OAuth token has expired. Please run /login', stderr: '', exitCode: 1 }), true);
  assert.equal(agentAuthFailure({ stdout: '{"type":"result","is_error":true,"error":"authentication_error"}', exitCode: 1 }), true);
  assert.equal(agentAuthFailure({ stderr: 'Not logged in', exitCode: null }), true);
});

test('agentAuthFailure ignores successful runs, unrelated failures and early-run mentions', () => {
  assert.equal(agentAuthFailure({ stdout: CODEX_401, stderr: '', exitCode: 0 }), false);
  assert.equal(agentAuthFailure({ stdout: '+  // retry on 401 Unauthorized when the auth token is stale\n', exitCode: 0 }), false);
  assert.equal(agentAuthFailure({ stdout: CODEX_401 }), false, 'unknown exit status is not a failed run');
  assert.equal(agentAuthFailure({ stdout: 'npm ERR! 3 tests failed\n', stderr: 'Error: connect ECONNREFUSED', exitCode: 1 }), false);
  assert.equal(agentAuthFailure({ stdout: 'HTTP 401 from the example page\n', exitCode: 1 }), false);
  assert.equal(agentAuthFailure({ stdout: 'token budget exceeded', exitCode: 1 }), false);
  assert.equal(agentAuthFailure({ stdout: CODEX_401 + 'x'.repeat(20000), exitCode: 1 }), false, 'only the end of the output counts');
  assert.equal(agentAuthFailure(), false);
});

test('subscription identity requires affirmative claude.ai mode across every parser', () => {
  const adapter = getHarnessAdapter('claude-code-subscription');
  const cases = [
    ...['api_key', 'api_key_helper', 'third_party', 'none', 'oauth_token'].map(authMethod => [{loggedIn:true, authMethod}, false]),
    [{loggedIn:true}, null], [{loggedIn:true, authMethod:'new-mode'}, null],
    ...[null, [], {}, ['claude.ai'], 1, 'CLAUDE.AI', 'claude.ai '].map(authMethod => [{loggedIn:true, authMethod}, null]),
    ...['claude.ai','api_key',undefined].map(authMethod => [{loggedIn:false, authMethod}, false]),
    ...[1,'true',null,undefined].map(loggedIn => [{loggedIn, authMethod:'claude.ai'}, null]),
    [null,null], [[],null], [{},null],
  ];
  for (const [status, expected] of cases) {
    const body = JSON.stringify(status);
    assert.deepEqual(parseIdentityEvidence('claude-code-subscription', 'FARAVAN_INSTALLED=1\n'+body),
      {installed:true,signedIn:expected,account:null}, body);
    assert.equal(adapter.parseProviderAccount(body), null, body);
    assert.equal(parseProviderAccount('claude-code-subscription',body), null, body);
  }
  for (const body of ['', 'not json', '{"loggedIn":true', '{"loggedIn":true}\n{"authMethod":"claude.ai"}']) {
    assert.deepEqual(parseIdentityEvidence('claude-code-subscription','FARAVAN_INSTALLED=1\n'+body),
      {installed:true,signedIn:null,account:null});
    assert.equal(adapter.parseProviderAccount(body),null);
  }
  const body=JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'synthetic@example.test',subscriptionType:'max'});
  const account={email:'synthetic@example.test',tier:'max'};
  assert.deepEqual(parseIdentityEvidence('claude-code-subscription','FARAVAN_INSTALLED=1\n'+body),
    {installed:true,signedIn:true,account});
  assert.deepEqual(adapter.parseProviderAccount(body),account);
  assert.deepEqual(parseProviderAccount('claude-code-subscription',body),account);
  assert.deepEqual(adapter.spec.login_status_probe.success,{loggedIn:true,authMethod:'claude.ai'});
  assert.match(adapter.spec.login_status_probe.mode_field_hint,/authMethod/);
});
