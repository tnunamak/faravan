import { promptCommand } from './job-framing.mjs';
/**
 * Pi (pi-coding-agent) as a guest harness for broker-backed account jobs.
 * The guest holds one per-job broker key and the broker URL. The provider
 * credential stays on the host; the host registry builds the run spec.
 * The guest is the local kit kits/wf-pi (base image by digest, exact pi
 * release). scripts/build-pi-guest-image.sh builds the same inputs locally to
 * check the commands; sbx builds its own sandbox from the kit at create time.
 */
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage } from './shared.mjs';

export const PI_HARNESS = validateHarnessSpec({
  harness_id: 'pi',
  install: 'wf-pi', // the local kit's own manifest name (kits/wf-pi/spec.yaml)
  entrypoint: 'faravan-pi --print --mode json',
  pinned_cli_version: '@earendil-works/pi-coding-agent@1.5.2 (kits/wf-pi/spec.yaml; local image build checked, not published)',
  provider_service_id: 'broker',
  // The spec needs a non-empty list. `.invalid` never resolves, so this opens no provider route: the guest reaches the host broker only.
  provider_domains: ['account-broker.invalid'],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  auth_strategy: 'guest-env-api-key',
  credential_in_guest: true,
  credential_discovery: { env_var: 'PI_API_KEY' },
  oauth_refresh: {
    supports_refresh: false, refresh_owner: 'none',
    evidence: 'The guest key is a one-job broker key. The host broker owns any provider refresh; the guest never sees a provider credential.',
  },
  login_status_probe: {
    command: 'pi --version', reports_auth_mode: false,
    mode_field_hint: 'Reports the installed version only; says nothing about a broker key or account.',
    success: { authenticated: true },
  },
  cancellation: { cancel_signal: 'sbx stop <sandbox>', on_cancel: 'sandbox process terminated; sandbox state preserved until sbx rm' },
  result_behavior: { result_transport: 'stdout of the pi run; no usage or model is parsed from it, the broker records the served model', model_reported: false },
  notes: 'live-unverified: not run in a Docker Sandbox; the same inputs were checked in a local container. The guest reaches only the host broker; provider hosts stay denied.',
});
export const spec = PI_HARNESS;
export const registrationOrder = 70;
export const defaultIdentityProbe = false;
export function capacityKind() { return 'api_key'; }
export function statusProbeCommand() { return null; }
export function parseProviderAccount() { return null; }
// Unknown, never guessed: the broker observes the served model and usage.
export function parseExecutionResult() { return { model: null, usage: nullableUsage(null, null) }; }
export function jobCommand(options) { return promptCommand(spec.entrypoint, options, 'prompt'); }
