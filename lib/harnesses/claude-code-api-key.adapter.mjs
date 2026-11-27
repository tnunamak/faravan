import { promptCommand } from './job-framing.mjs';
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson, capacityKindForStrategy } from './shared.mjs';

export { parseExecutionResult, statusProbeCommand } from './claude-code-subscription.adapter.mjs';

// This harness checks its API-key mode separately. Its account metadata must
// remain independent of the subscription adapter's stricter login check.
export function parseProviderAccount(stdout) {
  const status = parseJson(String(stdout || ''));
  if (!status?.loggedIn) return null;
  const account = {};
  if (typeof status.email === 'string' && status.email) account.email = status.email;
  if (typeof status.subscriptionType === 'string' && status.subscriptionType) account.tier = status.subscriptionType;
  return account;
}
const CLAUDE_API_KEY_STATUS_PROBE = {
  command: 'env (inside the sandbox, via sbx exec)',
  reports_auth_mode: true,
  mode_field_hint: 'SBX_CRED_ANTHROPIC_MODE env var: "apikey" once `sbx secret set -g anthropic` has been configured with a static key, vs "none". Confirmed against a real install as the correct, working signal for this specific strategy (unlike the subscription variant, where this same env var does NOT reflect the in-session /login state).',
  success: { SBX_CRED_ANTHROPIC_MODE: 'apikey' },
};

export const CLAUDE_CODE_API_KEY_HARNESS = validateHarnessSpec({
  harness_id: 'claude-code-api-key',
  install: 'claude', // built-in sbx agent template name
  entrypoint: 'claude --print --verbose --output-format stream-json --dangerously-skip-permissions', // same external-sandbox rationale as CLAUDE_CODE_SUBSCRIPTION_HARNESS above
  pinned_cli_version: 'unpinned — see profiles/faravan-docker.json for the sbx floor; Claude Code version pinning is a separate follow-up',
  provider_service_id: 'anthropic',
  provider_domains: ['api.anthropic.com', 'claude.ai'],
  egress_provider_hosts: ["**.anthropic.com","**.claude.ai"],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  credential_in_guest: false,
  auth_strategy: 'docker-stored-secret',
  credential_discovery: {
    // Confirmed against a real install: `sbx secret set --help` lists
    // 'anthropic' as a supported service; `echo "$ANTHROPIC_API_KEY" |
    // sbx secret set -g anthropic` is the documented non-interactive form
    // (the same pattern Docker's own examples use for openai/github/etc).
    // Host-side, waspflow-drivable via startAuthFlow-equivalent tooling —
    // smooth like Codex's OAuth — but the resulting secret is a STATIC API
    // key, not a refreshing OAuth token, and it is USAGE-BILLED.
    secret_name: 'anthropic',
  },
  oauth_refresh: {
    supports_refresh: false,
    refresh_owner: 'none',
    evidence: 'A static Anthropic API key does not refresh; docker-stored-secret is the correct strategy for a static, host-side-settable credential.',
  },
  login_status_probe: CLAUDE_API_KEY_STATUS_PROBE,
  cancellation: { cancel_signal: 'sbx stop <sandbox>', on_cancel: 'sandbox process terminated; sandbox state preserved until sbx rm' },
  result_behavior: { result_transport: 'native Claude stream-json event stream' },
});

export const spec = CLAUDE_CODE_API_KEY_HARNESS;
export const registrationOrder = 20;
export const defaultIdentityProbe = false;
export function capacityKind(harness = spec) { return capacityKindForStrategy(harness); }

export function jobCommand(options) { return promptCommand(spec.entrypoint, options, 'claude'); }
