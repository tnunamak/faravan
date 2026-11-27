import { promptCommand } from './job-framing.mjs';
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson, capacityKindForStrategy } from './shared.mjs';

const CLAUDE_SUBSCRIPTION_STATUS_PROBE = {
  command: 'claude auth status --json',
  reports_auth_mode: true,
  mode_field_hint: 'Require JSON loggedIn:true AND authMethod:claude.ai; other or unknown modes are not subscription evidence. This does not prove usage credits are disabled.',
  success: { loggedIn: true, authMethod: 'claude.ai' },
};
export const CLAUDE_CODE_SUBSCRIPTION_HARNESS = validateHarnessSpec({
  harness_id: 'claude-code-subscription',
  install: 'claude', // built-in sbx agent template name
  // Probed from the installed Claude CLI's --help: --verbose plus
  // --output-format stream-json emits newline-delimited assistant/tool/result
  // events.  This is the agent's own session transcript, not wrapper stderr.
  entrypoint: 'claude --print --verbose --output-format stream-json --dangerously-skip-permissions',
  pinned_cli_version: 'unpinned — see profiles/faravan-docker.json for the sbx floor; Claude Code version pinning is a separate follow-up',
  provider_service_id: 'anthropic',
  provider_domains: ['api.anthropic.com', 'claude.ai'],
  egress_provider_hosts: ["**.anthropic.com","**.claude.ai"],
  // What the Claude kit itself allows beyond the provider hosts (sbx 0.48, read live 2026-10-19).
  egress_kit_hosts: ["platform.claude.com","claude.com","code.claude.com","bridge.claudeusercontent.com"],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  credential_in_guest: true,
  auth_strategy: 'provider-file-generation',
  credential_discovery: {
    login_command: 'claude auth login --claudeai',
    flow_shape: 'host-url-flow',
    url_prompt_pattern: 'visit:',
  },
  oauth_refresh: {
    supports_refresh: true,
    refresh_owner: 'harness-cli',
    evidence: 'Native Claude credentials are copied into a job-private consumer store. Guest refresh changes only that copy; a later source change requires another generation. Indefinite refresh and cross-copy token rotation are not qualified.',
  },
  login_status_probe: CLAUDE_SUBSCRIPTION_STATUS_PROBE,
  cancellation: { cancel_signal: 'SIGKILL to the sign-in process group', on_cancel: 'source and receipt retained; no generation published' },
  result_behavior: { result_transport: 'native Claude stream-json event stream' },
});

export const CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS = validateHarnessSpec({
  ...CLAUDE_CODE_SUBSCRIPTION_HARNESS,
  credential_in_guest: false,
  auth_strategy: 'docker-native-oauth',
  oauth_refresh: {
    supports_refresh: true,
    refresh_owner: 'docker-builtin',
    evidence: 'Docker keeps OAuth credentials in its host-side proxy and refreshes them there.',
  },
  signin_probe: { path: 'sandbox-store', command: ['sbx', 'secret', 'ls', '-g', '--service', 'anthropic'] },
});

export const spec = CLAUDE_CODE_SUBSCRIPTION_HARNESS;
export const lendingSpec = CLAUDE_CODE_SUBSCRIPTION_LENDING_HARNESS;
export const registrationOrder = 10;
export const defaultIdentityProbe = true;
export function capacityKind(harness = spec) { return capacityKindForStrategy(harness); }

export function parseExecutionResult(stdout) {
  const output = String(stdout || '').trim();
  if (!output) return { model: null, usage: null };

    // Claude stream-json ends in a result event. Keep accepting the older
    // one-object --output-format json shape so already persisted runs remain
    // readable after the harness moves to agent-native streaming.
    const events = output.split(/\r?\n/).map(parseJson).filter(Boolean);
    const result = events.findLast((event) => event.type === 'result') || parseJson(output) || {};
    const models = result?.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
    // Claude has emitted both a direct model field and modelUsage across CLI
    // versions. A multi-model turn is real execution metadata, not an error:
    // preserve every reported model instead of discarding the receipt because
    // it is not a single-item array.
    const directModel = [result?.model, result?.model_name, result?.metadata?.model, result?.usage?.model]
      .find((value) => typeof value === 'string' && value.trim());
    return {
      model: directModel || (models.length ? models.join(', ') : null),
      usage: nullableUsage(result?.usage?.input_tokens ?? result?.usage?.inputTokens, result?.usage?.output_tokens ?? result?.usage?.outputTokens),
    };
}
// Shared by direct account parsing and registry identity qualification.
// Authentication mode evidence is not a guarantee about paid usage settings.
export function subscriptionSignedIn(stdout) {
  const status = parseJson(String(stdout ?? ''));
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  if (status.loggedIn === false) return false;
  if (status.loggedIn !== true) return null;
  if (status.authMethod === 'claude.ai') return true;
  if (['none', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'].includes(status.authMethod)) return false;
  return null;
}
export function parseProviderAccount(stdout) {
    const status = parseJson(String(stdout || ''));
    if (subscriptionSignedIn(stdout) !== true) return null;
    const account = {};
    if (typeof status.email === 'string' && status.email) account.email = status.email;
    if (typeof status.subscriptionType === 'string' && status.subscriptionType) account.tier = status.subscriptionType;
    return account;
}
export function statusProbeCommand() { return 'claude auth status --json'; }

export function parseSignIn(stdout) {
  const text = String(stdout ?? '').trim();
  if (/^No secrets found for scope "\(global\)" and service "anthropic"\.?$/.test(text)) return false;
  const rows = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(row => row.includes('anthropic'));
  if (rows.length !== 1) return null;
  const row = rows[0].join(' ');
  if (/^anthropic (?:oauth|apikey) \(global\)$/.test(row)) return true;
  return /^\(global\) (?:service )?anthropic \((?:oauth configured|stored)\)$/.test(row) ? true : null;
}

/**
 * `maxBudgetUsd` is Claude Code's own cap (`--max-budget-usd`), checked at turn boundaries. Pass the lent
 * budget minus headroom (faravan-guard-host `claudeMaxBudgetUsd`); the guard reports the stop as `budget`.
 */
export function jobCommand({ maxBudgetUsd, ...options }) {
  if (maxBudgetUsd === undefined || maxBudgetUsd === null) return promptCommand(spec.entrypoint, options, 'claude');
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw Object.assign(new Error('maxBudgetUsd must be a positive number'), { code: 'policy_unenforceable' });
  return promptCommand(spec.entrypoint, { ...options, args: [...(options.args || []), '--max-budget-usd', String(maxBudgetUsd)] }, 'claude');
}
