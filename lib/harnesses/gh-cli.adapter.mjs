import { promptCommand } from './job-framing.mjs';
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson, capacityKindForStrategy } from './shared.mjs';

export const GH_CLI_HARNESS = validateHarnessSpec({
  harness_id: 'gh-cli',
  install: 'wf-gh-cli', // the kit's own manifest `name` — the sbx run AGENT positional for a kind:sandbox kit
  entrypoint: 'gh',
  pinned_cli_version: 'unpinned — follow-up: pin to a specific gh CLI release once this kit is exercised against real sbx',
  provider_service_id: 'github',
  provider_domains: ['api.github.com', 'github.com', 'objects.githubusercontent.com'],
  egress_provider_hosts: ["**.github.com","**.githubusercontent.com"],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  credential_in_guest: false,
  auth_strategy: 'host-env-proxy',
  credential_discovery: { env_var: 'GH_TOKEN' },
  oauth_refresh: {
    supports_refresh: false,
    refresh_owner: 'none',
    evidence: 'GH_TOKEN is a static Personal Access Token; gh does not self-refresh it. No refresh mechanism is needed or claimed.',
  },
  login_status_probe: {
    command: 'gh auth status',
    reports_auth_mode: true,
    mode_field_hint: '"Logged in to github.com account <user> (GH_TOKEN)" vs an unauthenticated/error message — gh reports the active token source explicitly.',
    success: { logged_in: true },
  },
  cancellation: { cancel_signal: 'sbx stop <sandbox>', on_cancel: 'sandbox process terminated; sandbox state preserved until sbx rm' },
  result_behavior: { result_transport: 'stdout' },
});

export const spec = GH_CLI_HARNESS;
export const registrationOrder = 50;
export const defaultIdentityProbe = true;
export function capacityKind(harness = spec) { return capacityKindForStrategy(harness); }

export function parseExecutionResult() { return { model: null, usage: null }; }
export function parseProviderAccount(stdout) { return /logged in to/i.test(String(stdout || '')) ? {} : null; }
export function statusProbeCommand() { return 'gh auth status'; }

export function jobCommand(options) { return promptCommand(spec.entrypoint, options, 'none'); }
