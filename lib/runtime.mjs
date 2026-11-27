/**
 * Backend-neutral Faravan runtime contract (Runtime Decision, 2026-07-20).
 *
 * The faravan application must not know Docker- or Firecracker-specific
 * concepts. A `SandboxBackend` is any object implementing the methods below;
 * `DockerSbxBackend` (docker-backend.mjs) is the first
 * implementation. `ValidatedJobSpec` is the only thing that crosses the
 * interface boundary — it is intentionally host-blind (see FORBIDDEN_FIELDS).
 */

export const FORBIDDEN_FIELDS = Object.freeze([
  'host_path', 'host_paths', 'mount', 'mounts', 'raw_args', 'vmm_args',
  'shell_command', 'host_command', 'privileged', 'port', 'ports',
  'port_mapping', 'env', 'environment', 'credential', 'credentials',
  'secret', 'secrets', 'kernel_path', 'rootfs_path', 'policy_fragment',
  'proxy', 'proxy_endpoint',
]);

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}
const fail = (message) => { throw new ValidationError(message); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A ValidatedJobSpec describes WHAT to run and under what limits/egress
 * policy — never HOW a specific backend should be configured. Fields mirror
 * the note's "may contain" / "must not contain" lists.
 *
 * Required shape:
 * {
 *   job_id: string,                     // opaque, backend-independent identifier
 *   image: string,                      // approved workload identifier (not a path). For
 *                                       // DockerSbxBackend in v0 this is a built-in sbx
 *                                       // agent template name ('codex' | 'claude') so the
 *                                       // template's own native auth plumbing (host-side
 *                                       // OAuth/credential proxy) is used unmodified — see
 *                                       // docs/history/design/archive/FEDERATION_V0_UAT_REPORT.md's "Auth
 *                                       // architecture" section. It is never a custom
 *                                       // Docker image reference or a gateway endpoint.
 *   entrypoint: string,                 // fixed guest entrypoint identifier
 *   resources: { cpu, memory_mib, storage_mib, wall_seconds, output_bytes,
 *                network_bytes, max_processes },
 *   inputs: [{ artifact_id, dest }],    // content-addressed input identifiers
 *   output_manifest: [string],          // declared output paths to collect
 *   egress: 'internet' | 'provider-only',
 *   provider_hosts: [string],           // trusted harness data, not task-controlled rules
 *   required_limits: [string],          // names admission must enforce
 *   // Legacy opaque policy/token fields remain readable but cannot be admitted.
 * }
 */
export function validateJobSpec(spec) {
  isPlainObject(spec) || fail('job spec must be an object');
  assertNoForbiddenFields(spec);

  const allowed = ['job_id', 'image', 'entrypoint', 'resources', 'inputs', 'output_manifest', 'egress_policy_id', 'capability_token', 'egress', 'provider_hosts', 'required_limits', 'github_access_required', 'registries', 'source_hosts', 'verify', 'execution_scope', 'auth_strategy'];
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) fail(`job spec has unknown field: ${key}`);
  }

  nonEmptyString(spec.job_id, 'job_id');
  nonEmptyString(spec.image, 'image');
  nonEmptyString(spec.entrypoint, 'entrypoint');
  // These are chosen by the host executor, never copied from a remote request.
  if (spec.execution_scope !== undefined && !['owner', 'borrowed'].includes(spec.execution_scope)) fail('invalid execution_scope');
  if (spec.auth_strategy !== undefined) nonEmptyString(spec.auth_strategy, 'auth_strategy');
  // Legacy v0 jobs remain readable; admission must not guess their policy.
  if (spec.egress === undefined) {
    nonEmptyString(spec.egress_policy_id, 'egress_policy_id');
    nonEmptyString(spec.capability_token, 'capability_token');
  } else {
    if (!['internet', 'provider-only', 'provider+registries'].includes(spec.egress)) fail('egress must be internet, provider-only or provider+registries');
    if (!Array.isArray(spec.provider_hosts) || !spec.provider_hosts.length) fail('provider_hosts must be non-empty');
    for (const host of spec.provider_hosts) {
      if (typeof host !== 'string' || !/^(?:\*\*?\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) fail('invalid provider host');
    }
  }
  if (spec.required_limits !== undefined && (!Array.isArray(spec.required_limits) || spec.required_limits.some((key) => !['cpu', 'memory', 'wall', 'output', 'storage', 'guest_block_device_capacity', 'processes', 'network_bytes'].includes(key)))) fail('invalid required_limits');
  if (spec.github_access_required !== undefined && typeof spec.github_access_required !== 'boolean') fail('github_access_required must be boolean');
  if (spec.registries !== undefined && (!Array.isArray(spec.registries) || spec.registries.length > 2 ||
      new Set(spec.registries).size !== spec.registries.length ||
      spec.registries.some(name => !['npm', 'pypi'].includes(name)) || spec.egress !== 'provider+registries')) fail('invalid registries');
  if (spec.egress === 'provider+registries' && !spec.registries?.length) fail('registries required');
  if (spec.source_hosts !== undefined && (!Array.isArray(spec.source_hosts) || spec.source_hosts.length > 2 ||
      new Set(spec.source_hosts).size !== spec.source_hosts.length ||
      spec.source_hosts.some(host => !['github.com', 'codeload.github.com'].includes(host)))) fail('invalid source_hosts');

  isPlainObject(spec.resources) || fail('resources must be an object');
  for (const key of ['cpu', 'memory_mib', 'storage_mib', 'wall_seconds', 'output_bytes', 'network_bytes', 'max_processes']) {
    const value = spec.resources[key];
    Number.isSafeInteger(value) && value > 0 || fail(`resources.${key} must be a positive integer`);
  }

  if (spec.verify !== undefined) {
    isPlainObject(spec.verify) && Object.keys(spec.verify).length === 1 &&
      typeof spec.verify.cmd === 'string' && spec.verify.cmd.trim().length > 0 &&
      [...spec.verify.cmd].length <= 4096 && !/[\x00-\x1f\x7f]/.test(spec.verify.cmd) ||
      fail('verify must contain only a bounded command');
    spec.resources.wall_seconds > 180 || fail('verification requires more than the 180-second reserve');
  }

  Array.isArray(spec.inputs) || fail('inputs must be an array');
  for (const input of spec.inputs) {
    isPlainObject(input) || fail('each input must be an object');
    nonEmptyString(input.artifact_id, 'input.artifact_id');
    nonEmptyString(input.dest, 'input.dest');
    isRelativeSafePath(input.dest) || fail(`input.dest is not a safe relative path: ${input.dest}`);
  }

  Array.isArray(spec.output_manifest) || fail('output_manifest must be an array');
  for (const path of spec.output_manifest) {
    typeof path === 'string' && path.length > 0 || fail('output_manifest entries must be non-empty strings');
    isRelativeSafePath(path) || fail(`output_manifest entry is not a safe relative path: ${path}`);
  }

  return spec;
}

function assertNoForbiddenFields(value, path = 'spec', depth = 0) {
  if (depth > 8) fail('job spec exceeds nesting limit');
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoForbiddenFields(v, `${path}[${i}]`, depth + 1)); return; }
  if (!isPlainObject(value)) return;
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.includes(key)) fail(`${path}.${key} is forbidden in a ValidatedJobSpec (host/backend-specific control)`);
    assertNoForbiddenFields(val, `${path}.${key}`, depth + 1);
  }
}

function nonEmptyString(value, name) {
  typeof value === 'string' && value.length > 0 || fail(`${name} must be a non-empty string`);
}

function isRelativeSafePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.includes('\0')) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '..' && part !== '.');
}

/**
 * Base class documenting the contract every backend must implement. Not
 * abstract in the TypeScript sense — Node has no interfaces — but every
 * method throws by default so a backend that forgets one fails loudly
 * instead of silently no-op'ing a security-relevant step.
 */
export class SandboxBackend {
  /** @returns {Promise<CapabilityReport>} */
  async probeCapabilities() { throw notImplemented('probeCapabilities'); }
  /** @param {object} validatedJob @returns {Promise<SandboxHandle>} */
  async prepare(_validatedJob) { throw notImplemented('prepare'); }
  /** @param {SandboxHandle} handle */
  async start(_handle, _options = {}) { throw notImplemented('start'); }
  /** @param {SandboxHandle} handle @returns {AsyncIterable<{stream, line}>} */
  async *streamLogs(_handle) { throw notImplemented('streamLogs'); }
  /** @param {SandboxHandle} handle @param {string[]} manifest @returns {Promise<{path,sha256,bytes}[]>} */
  async collectDeclaredOutputs(_handle, _manifest) { throw notImplemented('collectDeclaredOutputs'); }
  /** @param {SandboxHandle} handle */
  async cancel(_handle) { throw notImplemented('cancel'); }
  /** @param {SandboxHandle} handle @returns {Promise<CleanupReceipt>} */
  async destroy(_handle) { throw notImplemented('destroy'); }
  /** @param {SandboxHandle} handle @returns {Promise<RuntimeState>} */
  async inspect(_handle) { throw notImplemented('inspect'); }
}

function notImplemented(method) {
  const error = new Error(`SandboxBackend subclass must implement ${method}()`);
  error.name = 'NotImplementedError';
  return error;
}

/**
 * @typedef {object} CapabilityReport
 * @property {boolean} available
 * @property {string} backend_id
 * @property {string} [version]
 * @property {string[]} [missing_prerequisites]
 * @property {string} [install_hint]
 *
 * @typedef {object} SandboxHandle
 * @property {string} backend_id
 * @property {string} job_id
 * @property {string} sandbox_id      backend-native identifier (e.g. sbx sandbox name)
 * @property {string} scratch_dir     disposable host-side anchor directory, unique per job
 *
 * @typedef {object} CleanupReceipt
 * @property {string} job_id
 * @property {string} sandbox_id
 * @property {boolean} removed         independently confirmed absent, not just "command exited 0"
 * @property {boolean} scratch_removed
 * @property {{create_incarnation:string,before_at:string,after_at:string}} [removal_observation] Scoped presence before and absence after removal of the same recorded sandbox.
 * @property {string} at               RFC3339 timestamp
 *
 * @typedef {object} RuntimeState
 * @property {string} job_id
 * @property {'pending'|'running'|'exited'|'destroyed'|'unknown'} status
 * @property {number} [exit_code]
 */
