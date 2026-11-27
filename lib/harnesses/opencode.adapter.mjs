import { promptCommand } from './job-framing.mjs';
/**
 * Contract researched against OpenCode v1.18.35 (53d1eabb61e21162157817bf677da0a4ad3332e3).
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/cli/cmd/run.ts
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/schema/src/v1/session.ts
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/session/session.ts
 * This is NOT proof of the version installed by the Docker template.
 */
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson } from './shared.mjs';

export const OPENCODE_HARNESS = validateHarnessSpec({
  harness_id: 'opencode',
  install: 'opencode',
  entrypoint: 'opencode run --format json',
  pinned_cli_version: 'contract: v1.18.35 (53d1eabb61e21162157817bf677da0a4ad3332e3); installed Docker template version unverified',
  provider_service_id: 'openrouter',
  provider_domains: ['openrouter.ai'],
  egress_provider_hosts: ['openrouter.ai'],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  auth_strategy: 'guest-env-api-key',
  credential_in_guest: true,
  credential_discovery: { env_var: 'OPENROUTER_API_KEY' },
  oauth_refresh: {
    supports_refresh: false, refresh_owner: 'none',
    evidence: 'This profile describes a lender-supplied static API key in the guest environment for one job, not a host credential proxy or OAuth refresh mechanism.',
  },
  login_status_probe: {
    command: 'opencode auth list',
    reports_auth_mode: false,
    mode_field_hint: 'Lists configured auth sources; does not validate a key, selected provider, account identity, or billing. Presence is not successful authentication.',
    success: { authenticated: true },
  },
  cancellation: { cancel_signal: 'sbx stop <sandbox>', on_cancel: 'sandbox process terminated; sandbox state preserved until sbx rm' },
  result_behavior: { result_transport: 'JSONL stdout from opencode run --format json; step_finish.part.tokens is per-step usage; receipt input includes cache reads/writes and output includes reasoning; actual model is not emitted' },
  recommended_egress: 'provider-only',
  notes: 'live-unverified: nobody has run this adapter in a real sandbox. The job can read the API key. Recommend provider-only egress, a limited key and one-job lifetime. This profile defaults to OpenRouter; provider/model and an OpenAI-compatible baseURL are OpenCode configuration, with matching provider_hosts required for another endpoint. Faravan job-local key delivery and authorization are not implemented here; current sign-in modules cannot drive this strategy. Do not pass a key in a prompt, command, receipt or log. No credential proxy is claimed.',
});
export const spec = OPENCODE_HARNESS;
export const registrationOrder = 60;
// Credential listing is not an authenticated account probe; keep legacy defaults.
export const defaultIdentityProbe = false;
export function capacityKind() { return 'api_key'; }
export function statusProbeCommand() { return 'opencode auth list'; }
export function parseProviderAccount() { return null; }

export function parseExecutionResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const events = lines.map(parseJson);
  const steps = events.filter((event) => event?.type === 'step_finish');
  // A truncated/malformed stream, mixed sessions or missing counts cannot
  // support an honest aggregate. Never fill unknown counts with zero.
  if (!steps.length || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) return { model: null, usage: null };
  if (events.some((event) => event.type === 'error')) return { model: null, usage: null };
  const sessions = new Set(events.map((event) => event.sessionID).filter((id) => typeof id === 'string'));
  if (sessions.size > 1) return { model: null, usage: null };
  let input = 0, output = 0;
  const seen = new Map();
  const seenStarts = new Set();
  const pending = new Map();
  for (const event of events) {
    if (!['step_start', 'step_finish'].includes(event.type)) continue;
    const part = event.part;
    const tokens = part?.tokens;
    if (typeof event.sessionID !== 'string' || !event.sessionID ||
        part?.sessionID !== event.sessionID ||
        typeof part?.messageID !== 'string' || !part.messageID ||
        typeof part?.id !== 'string' || !part.id) return { model: null, usage: null };
    const message = JSON.stringify([event.sessionID, part.messageID]);
    const key = JSON.stringify([event.sessionID, part.id]);
    if (event.type === 'step_start') {
      if (part.type !== 'step-start') return { model: null, usage: null };
      if (!seenStarts.has(key)) {
        seenStarts.add(key);
        pending.set(message, (pending.get(message) || 0) + 1);
      }
      continue;
    }
    if (part.type !== 'step-finish') return { model: null, usage: null };
    const counts = [tokens?.input, tokens?.output, tokens?.reasoning, tokens?.cache?.read, tokens?.cache?.write];
    if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return { model: null, usage: null };
    // OpenCode normalizes cache and reasoning into separate buckets. Restore
    // inclusive receipt counts; never treat an absent bucket as a known zero.
    const usage = nullableUsage(counts[0] + counts[3] + counts[4], counts[1] + counts[2]);
    if (!usage) return { model: null, usage: null };
    const signature = JSON.stringify(counts);
    if (seen.has(key)) {
      if (seen.get(key) !== signature) return { model: null, usage: null };
      continue; // Replayed identical event is the same step, not more usage.
    }
    seen.set(key, signature);
    pending.set(message, Math.max(0, (pending.get(message) || 0) - 1));
    input += usage.input_tokens;
    output += usage.output_tokens;
  }
  if ([...pending.values()].some((count) => count > 0)) return { model: null, usage: null };
  // The CLI does not emit assistant message.info.modelID/providerID. Never
  // turn a requested model or an arbitrary JSON field into observed metadata.
  return { model: null, usage: nullableUsage(input, output) };
}

export function jobCommand(options) { return promptCommand(spec.entrypoint, options, 'prompt'); }
