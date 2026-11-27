import { promptCommand } from './job-framing.mjs';
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson, capacityKindForStrategy } from './shared.mjs';

export const GEMINI_HARNESS = validateHarnessSpec({
  harness_id: 'gemini',
  install: 'gemini', // built-in sbx agent template name (confirmed: `sbx run --help` lists gemini among built-in agents)
  // --skip-trust clears the first-run directory-trust gate (distinct from
  // --approval-mode yolo, which only clears tool-call approval — confirmed
  // directly that yolo alone left an untrusted-dir headless run blocked).
  // Same external-sandbox rationale as every other harness's bypass flag
  // here: the sbx microVM is Faravan's real containment boundary: see
  // CODEX_HARNESS's entrypoint comment above for the full argument.
  entrypoint: 'gemini -o json --approval-mode yolo --skip-trust -p',
  pinned_cli_version: 'unpinned — see profiles/faravan-docker.json for the sbx floor; gemini-cli version pinning is a separate follow-up',
  provider_service_id: 'google',
  provider_domains: ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'],
  egress_provider_hosts: ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  credential_in_guest: false,
  auth_strategy: 'docker-stored-secret',
  credential_discovery: {
    // Confirmed against a real install: `sbx secret set --help` lists
    // 'google' as a supported service; `echo "$GEMINI_API_KEY" | sbx secret
    // set -g google` is the documented non-interactive form (same pattern as
    // CLAUDE_CODE_API_KEY_HARNESS's anthropic secret).
    secret_name: 'google',
  },
  oauth_refresh: {
    supports_refresh: false,
    refresh_owner: 'none',
    evidence: 'A static Google API key does not refresh; docker-stored-secret is the correct strategy for a static, host-side-settable credential — mirrors CLAUDE_CODE_API_KEY_HARNESS.',
  },
  login_status_probe: {
    command: 'env (inside the sandbox, via sbx exec)',
    reports_auth_mode: true,
    mode_field_hint: 'SBX_CRED_GOOGLE_MODE env var: "apikey" once `sbx secret set -g google` has been configured with a static key, vs "none". Confirmed live against a real install.',
    success: { SBX_CRED_GOOGLE_MODE: 'apikey' },
  },
  cancellation: { cancel_signal: 'sbx stop <sandbox>', on_cancel: 'sandbox process terminated; sandbox state preserved until sbx rm' },
  result_behavior: { result_transport: 'stdout (gemini -o json), structured JSON per turn' },
});

export const spec = GEMINI_HARNESS;
export const registrationOrder = 40;
export const defaultIdentityProbe = true;
export function capacityKind(harness = spec) { return capacityKindForStrategy(harness); }

export function parseExecutionResult(stdout) {
  const result = parseJson(String(stdout || '').trim());
  const stats = result?.stats || result?.usage || {};
  return {
    model: typeof result?.model === 'string' ? result.model : (typeof stats.model === 'string' ? stats.model : null),
    usage: nullableUsage(stats.input_tokens ?? stats.inputTokens, stats.output_tokens ?? stats.outputTokens),
  };
}
export function parseProviderAccount(stdout) { return /SBX_CRED_GOOGLE_MODE=(?:oauth|apikey)/.test(String(stdout || '')) ? {} : null; }
export function statusProbeCommand() { return 'env'; }

export function jobCommand(options) {
  // Keep -p beside the prompt; model flags belong before this value-taking option.
  return promptCommand(spec.entrypoint.replace(/ -p$/, ''), {...options,args:[...(options.args??[]),'-p']}, 'prompt');
}
