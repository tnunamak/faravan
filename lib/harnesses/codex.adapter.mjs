import { promptCommand } from './job-framing.mjs';
import { validateHarnessSpec } from '../harness-spec.mjs';
import { nullableUsage, parseJson, capacityKindForStrategy } from './shared.mjs';

export const CODEX_HARNESS = validateHarnessSpec({
  harness_id: 'codex',
  install: 'codex', // built-in sbx agent template name, not a custom image
  // `--dangerously-bypass-approvals-and-sandbox` (confirmed via `codex exec
  // --help` on a real install): "Skip all confirmation prompts and execute
  // commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for
  // running in environments that are externally sandboxed."
  //
  // Without it, Codex's own first-run "Do you trust the contents of this
  // directory?" prompt blocks a faravan task forever — a headless job has
  // no terminal to answer it, and the sandbox launch just hangs (confirmed
  // live: this exact prompt stalled the owner's first successful `sbx run`
  // after the argument-order fix). This is not a workaround for that hang;
  // it is the flag's INTENDED use per Codex's own documentation. Faravan
  // v0's Docker Sandboxes microVM IS the "externally sandboxed" environment
  // the flag requires — per Docker's own isolation model (confirmed earlier
  // in this project: 5 isolation layers, credential proxy, deny-by-default
  // network, per-sandbox filesystem), Codex's in-VM
  // approval/trust/no-sandboxing concerns are already handled ONE LEVEL
  // OUTSIDE the process this flag affects. Codex's own `--sandbox` flag
  // governs command execution INSIDE its own process (read-only,
  // workspace-write, danger-full-access) — a second, redundant containment
  // layer for a process that is already running inside a full microVM with
  // its own kernel, filesystem, and network boundary. Bypassing Codex's
  // in-process sandbox does not weaken Faravan's actual security
  // boundary, which is the microVM itself (graduation gates A-G), not
  // Codex's own opt-in command-execution guard.
  //
  // This is scoped narrowly: it is safe BECAUSE the entrypoint always runs
  // inside a fresh, disposable sbx sandbox (never on the bare host — see
  // lib/docker-backend.mjs, which never mounts a real repo or
  // home directory). Using this flag OUTSIDE that context — e.g. on a bare
  // host, or a container without its own kernel/network isolation — would
  // be exactly as dangerous as Codex's own docs warn.
  // `codex exec --json` emits newline-delimited lifecycle events. Its final
  // turn.completed event currently carries token counts, but no model or
  // duration; Faravan measures the execution window itself and records
  // unavailable fields as null rather than guessing.
  entrypoint: 'codex exec --json --dangerously-bypass-approvals-and-sandbox',
  pinned_cli_version: 'unpinned — see profiles/faravan-docker.json for the sbx floor; Codex CLI version pinning is a separate follow-up',
  provider_service_id: 'openai',
  provider_domains: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
  egress_provider_hosts: ["**.openai.com","**.chatgpt.com","chatgpt.com"],
  // What the Codex kit itself allows for its sandbox beyond the provider (sbx 0.48, read live 2026-10-19). Its npm registry
  // allowance is not listed: registries are only ever what the signed job names.
  egress_kit_hosts: ["github.com","api.github.com","codeload.github.com","release-assets.githubusercontent.com","archive.ubuntu.com","security.ubuntu.com","ports.ubuntu.com","download.docker.com"],
  auth_header: { header: 'Authorization', format: 'Bearer %s' },
  credential_in_guest: true,
  auth_strategy: 'provider-file-generation',
  credential_discovery: {
    login_command: 'codex -c cli_auth_credentials_store="file" login',
    flow_shape: 'host-url-flow',
    url_prompt_pattern: 'https://auth.openai.com/',
  },
  oauth_refresh: {
    supports_refresh: true,
    refresh_owner: 'harness-cli',
    evidence: 'OpenAI documents copying the native auth.json cache. Codex renews a copy itself and the provider rotates the refresh token, so each owner job gets a private copy without the refresh token and Faravan renews the sign-in on the host first (one holder). The immutable publication is not a refresh destination.',
  },
  // Legacy profiles without a Faravan generation can still be inspected. This
  // listing is presence evidence only; generation publication never reads it.
  signin_probe: { path: 'sandbox-store', command: ['sbx', 'secret', 'ls', '-g', '--service', 'openai'] },
  login_status_probe: {
    command: 'codex login status 2>&1 | grep -q "^Logged in using ChatGPT" && printf "FARAVAN_CODEX_LOGIN=chatgpt\\n"',
    reports_auth_mode: true,
    mode_field_hint: 'Native Codex reports Logged in using ChatGPT for the selected job-private authentication cache. Legacy profiles use the proxy mode marker.',
    success: { FARAVAN_CODEX_LOGIN: 'chatgpt' },
  },
  cancellation: { cancel_signal: 'SIGKILL to the sign-in process group', on_cancel: 'source and receipt retained; no generation published' },
  result_behavior: { result_transport: 'stdout (codex exec) or streamed agent turn events' },
});

export const CODEX_LENDING_HARNESS = validateHarnessSpec({
  ...CODEX_HARNESS,
  credential_in_guest: false,
  auth_strategy: 'docker-native-oauth',
  credential_discovery: {
    login_command: 'sbx secret set -g openai --oauth --force',
    flow_shape: 'host-url-flow',
    url_prompt_pattern: 'Open this URL to sign in',
  },
  oauth_refresh: {
    supports_refresh: true,
    refresh_owner: 'docker-builtin',
    evidence: 'Docker keeps OAuth credentials in its host-side proxy and refreshes them there.',
  },
  login_status_probe: {
    command: 'env',
    reports_auth_mode: true,
    mode_field_hint: 'SBX_CRED_OPENAI_MODE reports the Docker proxy credential mode.',
    success: { SBX_CRED_OPENAI_MODE: 'oauth' },
  },
  signin_probe: { path: 'sandbox-store', command: ['sbx', 'secret', 'ls', '-g', '--service', 'openai'] },
});

export const spec = CODEX_HARNESS;
export const lendingSpec = CODEX_LENDING_HARNESS;
export const registrationOrder = 30;
export const defaultIdentityProbe = true;
export function capacityKind(harness = spec) { return capacityKindForStrategy(harness); }

export function parseExecutionResult(stdout) {
  const events = String(stdout || '').trim().split(/\r?\n/).map(parseJson).filter(Boolean);
  const completed = events.findLast((event) => event.type === 'turn.completed');
  return { model: null, usage: nullableUsage(completed?.usage?.input_tokens, completed?.usage?.output_tokens) };
}
export function parseProviderAccount(stdout) { return /logged in/i.test(String(stdout || '')) ? {} : null; }
export function statusProbeCommand() { return 'codex login status'; }

export function parseSignIn(stdout) {
  const text = String(stdout ?? '').trim();
  if (/^No secrets found for scope "\(global\)" and service "openai"\.?$/.test(text)) return false;
  // sbx 0.48 lists `(global)   openai    (oauth configured)` (SCOPE SERVICE SECRET); older builds listed `openai  oauth  (global)`.
  const rows = text.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(row => row.includes('openai'));
  if (rows.length !== 1) return null;
  const row = rows[0].join(' ');
  if (/^openai (?:oauth|apikey) \(global\)$/.test(row)) return true;
  return /^\(global\) (?:service )?openai \((?:oauth configured|stored)\)$/.test(row) ? true : null;
}

export function jobCommand(options) { return promptCommand(spec.entrypoint, options, 'codex'); }
