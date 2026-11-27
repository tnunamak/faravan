// Faravan credential-proxy probe (BUILD-PLAN S5.2, decision T14).
//
// This file runs INSIDE a job sandbox, as the job's own user, the way a hostile job would. It looks
// for credentials the lender owns that the job could read or use, and prints ONE line of JSON:
//   FARAVAN_PROBE_JSON:{"probe_version":1,"verdict":"pass|fail|inconclusive","checks":[{id,found,evidence_redacted,severity}],...}
//
// Rules the code keeps (tests/credential-probe.test.mjs checks them):
// - It never calls a provider API. Its only network targets are the sandbox's own MCP gateway and
//   proxy, the link-local metadata address, and a local unix socket.
// - It never prints a secret value. Evidence is names, paths, lengths and the first 4 hex characters
//   of a SHA-256. A value the sandbox proxy issued as a placeholder (a "sentinel") is not a secret.
// - It has no dependencies: Node built-ins only, so one file can be copied into any sandbox.
//
// `found: true` always means "a problem": something real is readable or usable. `found: null` means
// the check could not run. The caller must treat null as "inconclusive", never as a pass.
import { createHash, X509Certificate } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync, readFileSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { request } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

export const PROBE_VERSION = 5;
const GATEWAY_BUILTIN_TOOLS = ['code-mode', 'mcp-add', 'mcp-config-set', 'mcp-exec', 'mcp-find'];
export const MARKER = 'FARAVAN_PROBE_JSON:';
export const SEVERITIES = Object.freeze(['none', 'info', 'low', 'medium', 'high', 'critical']);
// Checks without which a pass is not credible. `known-secret-match` is listed in the report but
// only means something when the runner supplied hashes of the lender's real credentials.
export const REQUIRED_CHECKS = Object.freeze([
  'env-secrets', 'credential-files', 'git-credential-helpers', 'sentinel-status', 'host-mounts',
  'ssh-agent', 'mcp-gateway', 'link-local-metadata', 'process-environ', 'filesystem-token-scan',
]);

// ---- classification (pure) --------------------------------------------------------------------

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const hash4 = (value) => sha256(value).slice(0, 4);

/** Placeholders issued by the sbx credential proxy: sk-ant-oat01-proxy-managed, proxy-managed, gho_...proxy...managed. */
export function isSentinel(value) {
  return /proxymanaged/.test(String(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

const TOKEN_FORMATS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\boai-[a-z]{3}\d\d-[A-Za-z0-9_-]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_NAME = /(token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|credential|bearer|authorization|auth|cookie|private[_-]?key|session[_-]?key)/i;
// name = "value" | name: value | NAME=value
const ASSIGNMENT = /(["']?)([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|credential|bearer|authorization|auth|cookie|private[_-]?key)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;#}\]"']+))/gi;
const NETRC_PASSWORD = /\bmachine\s+\S+[\s\S]{0,200}?\bpassword\s+(\S+)/g;

/** 'empty' | 'sentinel' | 'real' | 'ignore' for a value found next to a secret-looking name. */
export function classifyValue(raw) {
  const value = String(raw ?? '').replace(/^(?:bearer|token|basic)\s+/i, '').trim();
  if (value === '') return 'empty';
  if (isSentinel(value)) return 'sentinel';
  if (/^(?:true|false|null|none|undefined|file|keyring|auto|[0-9.]+)$/i.test(value)) return 'ignore';
  if (value.length < 8) return 'ignore';
  if (/^https?:\/\/[^@\s]*$/i.test(value) || /^\/[\w./@:+-]*$/.test(value) || /^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i.test(value)) return 'ignore';
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return 'ignore'; // an unexpanded variable reference
  // Source code, not a secret: calls, member access, templates.
  if (/[()[\]<>$]/.test(value) || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) return 'ignore';
  if (/^[A-Za-z0-9.-]+:\d{1,5}$/.test(value)) return 'ignore'; // host:port
  // A name like "auth" or "token" next to a plain word (a mode, a policy) is configuration. A secret has digits or is long and random.
  if (!(value.length >= 12 && /\d/.test(value) && shannon(value) >= 3)) return 'ignore';
  return 'real';
}

export function shannon(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/** A base64 value that decodes to a public certificate is not a secret; one that decodes to a private key is. */
export function decodedPem(value) {
  if (!/^[A-Za-z0-9+/=\s]{80,}$/.test(value)) return null;
  try {
    const text = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('latin1');
    if (/PRIVATE KEY/.test(text)) return 'private';
    if (/BEGIN CERTIFICATE/.test(text)) return 'certificate';
  } catch { /* not base64 */ }
  return null;
}

/**
 * Every secret-looking string in a block of text: [{kind:'sentinel'|'real'|'empty', name, length, hash, full}].
 * `full` is the SHA-256 of the whole value; it lets the caller compare against hashes of the lender's
 * real credentials and is never printed.
 */
export function scanText(text, { config = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (kind, name, value) => {
    const key = kind + '\0' + name + '\0' + value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name, length: value.length, hash: hash4(value), full: sha256(value) });
  };
  for (const pattern of TOKEN_FORMATS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) add(isSentinel(match[0]) ? 'sentinel' : 'real', 'format', match[0]);
  }
  if (!config) return out; // source code and documents: only the unmistakable token formats count
  NETRC_PASSWORD.lastIndex = 0;
  for (const match of text.matchAll(NETRC_PASSWORD)) {
    const kind = classifyValue(match[1]);
    if (kind !== 'ignore') add(kind, 'netrc-password', match[1]);
  }
  ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    const kind = classifyValue(value);
    if (kind !== 'ignore') add(kind, match[2], value.replace(/^(?:bearer|token|basic)\s+/i, ''));
  }
  return out;
}

/** Token-shaped substrings, for comparing against hashes of the lender's real credentials. */
export function tokenCandidates(text) {
  return new Set(String(text).match(/[A-Za-z0-9_\-.+/=~]{16,}/g) ?? []);
}

/** Classify one environment variable. Returns null when it is ordinary configuration. */
export function classifyEnv(name, value) {
  if (/^(?:FARAVAN_PROBE_|PATH$|PWD$|OLDPWD$)/.test(name)) return null;
  const pem = decodedPem(value);
  if (pem === 'private') return { kind: 'real', reason: 'private-key' };
  if (pem === 'certificate') return null;
  const found = scanText(name + '=' + JSON.stringify(value));
  const real = found.find((item) => item.kind === 'real');
  if (real) return { kind: 'real', reason: 'token-shaped' };
  if (SECRET_NAME.test(name)) {
    const kind = classifyValue(value);
    if (kind === 'real' || kind === 'sentinel' || kind === 'empty') return { kind, reason: 'secret-name' };
  }
  if (value.length >= 32 && /^[A-Za-z0-9_\-+/=.]+$/.test(value) && !/^[0-9a-f-]{32,40}$/i.test(value) &&
      !/^\//.test(value) && shannon(value) >= 4.2) return { kind: 'real', reason: 'high-entropy' };
  return null;
}

const label = (item) => `${item.name}(${item.length},${item.hash})`;
const verdictRank = { none: 0, info: 1, low: 2, medium: 3, high: 4, critical: 5 };

export function makeCheck(id, found, evidence, severity) {
  const text = String(evidence ?? '').slice(0, 1500);
  return { id, found, evidence_redacted: text, severity: found === true ? severity : 'none' };
}

/**
 * Is a sign-in bound to this sandbox? `SBX_CRED_<SERVICE>_MODE` says oauth or apikey (Codex does). Claude's OAuth sandbox reports
 * mode `none` even when signed in, so its own credentials file counts too: sentinel tokens with an expiry still in the future are
 * what the sbx engine writes when it holds a live credential. Placeholders with expiry 0 and empty tokens are "not signed in".
 */
export function providerBound(provider) {
  return !!provider && (['oauth', 'apikey'].includes(provider.mode) || provider.credential_file_bound === true);
}

/**
 * Verdict from the checks. Pure; the host module repeats this rule and refuses a report that disagrees.
 * fail: a real secret is readable or a usable lender authority is reachable (critical or high).
 * inconclusive: nothing failed but the proxy could not be observed working.
 */
export function decideVerdict({ checks, provider, selfTest, ownerGenerationBound = false }) {
  const failed = checks.some((check) => check.found === true && verdictRank[check.severity] >= verdictRank.high);
  if (failed) return { verdict: 'fail', reasons: [] };
  const reasons = [];
  for (const id of REQUIRED_CHECKS) {
    const check = checks.find((entry) => entry.id === id);
    if (!check) reasons.push(`missing_check:${id}`);
    else if (check.found === null) reasons.push(`check_unavailable:${id}`);
  }
  if (!selfTest?.canary_detected || !selfTest?.sentinel_ignored) reasons.push('self_test_failed');
  if (ownerGenerationBound && checks.find(check => check.id === 'owner-generation')?.found !== false) reasons.push('check_unavailable:owner-generation');
  if (!ownerGenerationBound && !providerBound(provider)) reasons.push('provider_not_signed_in');
  else if (!ownerGenerationBound && !(provider.sentinels > 0)) reasons.push('no_sentinel_observed');
  return reasons.length ? { verdict: 'inconclusive', reasons } : { verdict: 'pass', reasons: [] };
}

// ---- filesystem helpers -----------------------------------------------------------------------

const remainingMs = deadline => Math.max(0,Number((deadline-process.hrtime.bigint())/1000000n));
const deadlineOf = options => options.deadlineNs!==undefined ? BigInt(options.deadlineNs)
  : process.hrtime.bigint()+BigInt(Math.max(0,Math.floor(options.budgetMs??20000)))*1000000n;

function readText(file, maxBytes = 262144) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const n = readSync(fd, buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, n);
    if (slice.subarray(0, 1024).includes(0)) return null; // binary
    return slice.toString('utf8');
  } catch(error) { if(error.code==='ENOENT')return null;throw error; } finally { if(fd!==undefined)closeSync(fd); }
}

const SKIP_DIRS = new Set(['site-packages', 'dist-packages', '.rustup', '.cargo', '.nvm', 'node_modules', '.git', '.cache', '.npm', 'proc', 'sys', 'dev', '__pycache__', 'alternatives', 'fonts', 'apt', 'dpkg', 'python3', 'locale', 'terminfo', 'mime']);

const within = (file, root) => {
  const relative=path.relative(root,path.resolve(file));
  return relative==='' || relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
};
// Preserve the lexical tail beneath missing or inaccessible protected directories.
// Workspace canonicalization itself never tolerates access errors; a privileged
// invocation repeats this validation with its own visibility.
function canonicalProtectedPath(file) {
  try {return realpathSync(file);}catch(error) {
    if(!['ENOENT','EACCES'].includes(error.code)||path.dirname(file)===file)throw error;
    return path.join(canonicalProtectedPath(path.dirname(file)),path.basename(file));
  }
}
function* walk(root, { maxDepth = 4, budget, excludedPaths = [] }) {
  let resolvedRoot=root;
  try {resolvedRoot=realpathSync(root);}catch(error) {if(error.code!=='ENOENT')budget.failed=true;}
  if(excludedPaths.some(excluded=>within(root,excluded)||within(resolvedRoot,excluded)))return;
  const stack = [[root, 0]];
  while (stack.length) {
    if(budget.deadline&&remainingMs(budget.deadline)<=0){budget.failed=true;return;}
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch(error) {if(error.code!=='ENOENT')budget.failed=true;continue;}
    for (const entry of entries) {
      if(budget.deadline&&remainingMs(budget.deadline)<=0){budget.failed=true;return;}
      const full = path.join(dir, entry.name);
      if (excludedPaths.some(excluded=>within(full,excluded)) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) stack.push([full, depth + 1]); continue; }
      if (!entry.isFile()) continue;
      let size = 0;
      try { size = lstatSync(full).size; } catch(error) {if(error.code!=='ENOENT')budget.failed=true;continue;}
      if (size === 0 || size > 262144) continue;
      if (budget.files===0) {budget.exhausted=true;return;}
      budget.files--;
      yield full;
    }
  }
}

// ---- the checks -------------------------------------------------------------------------------

function sumFindings(findings, limit = 12) {
  const real = findings.filter((item) => item.kind === 'real');
  const sentinel = findings.filter((item) => item.kind === 'sentinel');
  const empty = findings.filter((item) => item.kind === 'empty');
  return { real, sentinel, empty, text: `${real.length} real-looking, ${sentinel.length} sentinel, ${empty.length} empty` +
    (real.length ? '; real: ' + real.slice(0, limit).map((item) => `${item.where}:${label(item)}`).join(', ') : '') };
}

function envCheck(env, ctx) {
  const names = Object.keys(env).sort();
  const findings = [];
  for (const name of names) {
    const found = classifyEnv(name, env[name]);
    if (found) findings.push({ kind: found.kind, name, length: env[name].length, hash: hash4(env[name]), full: sha256(env[name]), where: 'env', reason: found.reason });
    for (const token of tokenCandidates(env[name])) ctx.candidates.add(token);
    ctx.candidates.add(env[name]);
  }
  ctx.envFindings = findings;
  const summary = sumFindings(findings);
  return makeCheck('env-secrets', summary.real.length > 0, `${names.length} variables: ${names.join(',')}. ${summary.text}` +
    (summary.sentinel.length ? '; sentinel: ' + summary.sentinel.map((item) => item.name).join(',') : ''), 'critical');
}

// Placeholders the sbx proxy swaps for a real credential on requests to the service's own hosts. The job cannot read the real
// value, but it can spend it wherever its network reaches that service. Provider sentinels are the point of the design and are skipped.
const SENTINEL_SERVICES = { GH_TOKEN: 'github', GITHUB_TOKEN: 'github', GITLAB_TOKEN: 'gitlab', NPM_TOKEN: 'npm', OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic',
  GOOGLE_API_KEY: 'google', GEMINI_API_KEY: 'google' };
function foreignCredentialCheck(ctx, provider) {
  const names = ctx.envFindings.filter((item) => item.kind === 'sentinel' && SENTINEL_SERVICES[item.name] && SENTINEL_SERVICES[item.name] !== provider.service)
    .map((item) => `${item.name}(${SENTINEL_SERVICES[item.name]})`);
  return makeCheck('foreign-credential-reach', names.length > 0, names.length
    ? `sentinels for other services: ${names.join(',')}. The real credential stays on the host, and the proxy swaps it in only for requests to those services' hosts; a job reaches them only if its network policy allows those hosts`
    : 'no sentinel for a service other than the agent\'s provider', 'medium');
}

const CREDENTIAL_FILES = ['.claude/.credentials.json', '.claude.json', '.codex/auth.json', '.codex/config.toml', '.config/gh/hosts.yml',
  '.docker/config.json', '.netrc', '.git-credentials', '.config/git/credentials', '.aws/credentials', '.ssh/id_rsa', '.ssh/id_ed25519',
  '.config/opencode/auth.json', '.local/share/opencode/auth.json', '.gemini/oauth_creds.json', '.npmrc', '.pypirc'];

const CODE_OR_DOC = /\.(?:py|pyc|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|rb|go|rs|c|h|cc|cpp|java|md|markdown|txt|html|htm|css|rst|pl|pm|lua|php|1|3|so|service|rules|desktop|xml|svg|csv|log)$/i;

// ---- one known signed artifact -----------------------------------------------------------------------
// The Claude CLI writes ~/.claude/policy-limits.json.signature.json inside the guest: compact JSON {"jws":<JWS>,"receivedAt":<ms>}.
// The JWS is a signed policy document with a public certificate chain in its header (alg, typ, kid, x5c) and a nine-key payload
// (v, typ, aud, sub, ws, plan, iat, exp, sha). Its 2969-character base64url string matches the JWT token format, so the scanner flags
// it. It is allowed here only when the path AND the whole structure match exactly; anything else in that file, or any other file,
// is judged by the normal rules. This is a structural exemption, not a name or format exemption: a file of that name holding
// anything but this shape stays a finding.

const SIGNATURE_FILE = /^(?:\/root|\/home\/[^/]+)\/\.claude\/policy-limits\.json\.signature\.json$/;
const SIGNATURE_ENVELOPE = /^\{"jws":"([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{86})","receivedAt":(\d{13})\}$/;
const HEADER_KEYS = { alg: 'string', typ: 'string', kid: 'string', x5c: 'array' };
const PAYLOAD_KEYS = { v: 'number', typ: 'string', aud: 'string', sub: 'string', ws: 'string', plan: 'string', iat: 'number', exp: 'number', sha: 'string' };
const SIGNATURE_ALGORITHMS = /^(?:ES|RS|PS)(?:256|384|512)$/;

const containsToken = (text) => TOKEN_FORMATS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text); }) || /PRIVATE KEY/.test(text);
const typeOf = (value) => Array.isArray(value) ? 'array' : typeof value;

/** One JWS segment: base64url -> JSON object whose keys are exactly `keys`, each once, with these types and no token inside. */
function decodeSegment(segment, keys) {
  let text, value;
  try { text = Buffer.from(segment, 'base64url').toString('utf8'); value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const names = Object.keys(value);
  if (names.length !== Object.keys(keys).length || !names.every((name) => keys[name] === typeOf(value[name]))) return null;
  // JSON.parse keeps the last of two equal keys. A duplicate would hide the earlier value, so each key must be written once,
  // and the raw text is checked for tokens before anything is decoded further.
  if (names.some((name) => (text.match(new RegExp('"' + name + '"\\s*:', 'g')) ?? []).length !== 1)) return null;
  if (text.includes('\\') || containsToken(text) || Object.values(value).some((entry) => typeof entry === 'string' && entry.length > 256)) return null;
  return value;
}

/**
 * Is `text` the exact signed-policy file at `file`? {ok:true, masked} gives the text with the single JWS value replaced by a
 * fixed placeholder, so the rest of the file is still scanned; {ok:false, reason} gives a fixed code and never any content.
 */
export function classifySignatureFile(file, text, home) {
  const no = (reason) => ({ ok: false, reason });
  if (!(SIGNATURE_FILE.test(file) || (typeof home === 'string' && home && file === path.join(home, '.claude/policy-limits.json.signature.json')))) return no('path');
  const envelope = SIGNATURE_ENVELOPE.exec(text);
  if (!envelope) return no('envelope');
  const header = decodeSegment(envelope[1], HEADER_KEYS);
  if (!header) return no('header');
  if (!SIGNATURE_ALGORITHMS.test(header.alg) || header.x5c.length < 1 || header.x5c.length > 5) return no('header_values');
  for (const entry of header.x5c) {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(entry)) return no('certificate');
    try { new X509Certificate(Buffer.from(entry, 'base64')); } catch { return no('certificate'); }
  }
  if (!decodeSegment(envelope[2], PAYLOAD_KEYS)) return no('payload');
  if (envelope.slice(1, 4).some(containsToken)) return no('segment');
  return { ok: true, masked: text.replace(/^\{"jws":"[^"]*"/, '{"jws":"<signed-policy-jws>"'), length: envelope[1].length + envelope[2].length + envelope[3].length + 2 };
}

function scanFile(file, ctx, findings, { forceConfig = false } = {}) {
  let text;
  if(remainingMs(ctx.deadline)<=0){ctx.failedReads.add(file);return false;}
  try {text=readText(file);}catch {ctx.failedReads.add(file);return false;}
  if(text===null)return false;
  // Only the host-declared provider fields in this exact generation are expected.
  // Other keys, files and services still go through every secret scan.
  if (file === ctx.ownerGenerationFile && ctx.ownerGenerationExpected) text = parseOwnerGeneration(text, ctx.ownerGenerationService)?.masked ?? text;
  // The one allowed signed file is scanned with its single JWS masked; the known-secret comparison below still sees the original text.
  const signature = classifySignatureFile(file, text, ctx.home);
  if (signature.ok) (ctx.signatures ??= []).push(file);
  else if (signature.reason !== 'path') {
    // The known file in an unknown shape: nothing vouches for it, so it is a finding even when no token pattern matches.
    (ctx.signatureRejected ??= []).push(signature.reason);
    findings.push({ kind: 'real', name: 'signed-policy-unrecognized', length: text.length, hash: hash4(text), full: sha256(text), where: file });
  }
  for (const item of scanText(signature.ok ? signature.masked : text, { config: forceConfig || !CODE_OR_DOC.test(file) })) findings.push({ ...item, where: file });
  for (const token of tokenCandidates(text)) ctx.candidates.add(token);
  // Masking the outer JWT never exempts known secret bytes in its individual segments.
  if (signature.ok) for (const segment of JSON.parse(text).jws.split('.')) ctx.candidates.add(segment);
  return true;
}

function credentialFilesCheck(home, ctx) {
  const present = [], findings = [];
  for (const rel of CREDENTIAL_FILES) {
    const file = path.join(home, rel);
    try { if (statSync(file).isFile()) { present.push(rel); scanFile(file, ctx, findings, { forceConfig: true }); } } catch(error) {if(error.code!=='ENOENT')ctx.failedReads.add(file);}
  }
  ctx.fileFindings = findings;
  // The sign-in state the sandbox itself records: expiresAt 0 or missing means no credential was bound.
  try {
    const oauth = JSON.parse(readText(path.join(home, '.claude/.credentials.json')) ?? 'null')?.claudeAiOauth;
    if (oauth) {
      ctx.credentialExpiry = !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= 0 ? 'none' : oauth.expiresAt < Date.now() ? 'past' : 'future';
      ctx.credentialFileSentinels = ['accessToken', 'refreshToken'].every((key) => typeof oauth[key] === 'string' && isSentinel(oauth[key]));
    }
  } catch(error) {if(error.code&&error.code!=='ENOENT')ctx.failedReads.add(path.join(home,'.claude/.credentials.json'));}
  const summary = sumFindings(findings);
  return makeCheck('credential-files', summary.real.length ? true : ctx.failedReads.size ? null : false,
    `present: ${present.length ? present.join(',') : 'none'}. ${summary.text}` +
    (summary.sentinel.length ? '; sentinel in: ' + [...new Set(summary.sentinel.map((item) => path.basename(item.where)))].join(',') : '') +
    (summary.empty.length ? '; empty in: ' + [...new Set(summary.empty.map((item) => path.basename(item.where)))].join(',') : ''), 'critical');
}

function gitHelpersCheck(home, env) {
  const notes = [];
  for (const file of [path.join(home, '.gitconfig'), path.join(home, '.config/git/config'), '/etc/gitconfig']) {
    const text = readText(file);
    if (text === null) continue;
    for (const match of text.matchAll(/^\s*helper\s*=\s*(\S+)/gm)) notes.push(`credential.helper=${match[1].split('/').pop()}`);
  }
  for (const name of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CREDENTIAL_HELPER']) if (env[name]) notes.push(`${name} set`);
  return makeCheck('git-credential-helpers', notes.length > 0, notes.length ? notes.join(', ') : 'no credential helper configured', 'low');
}

// `readOnlyMount` is the lender's own runtime directory. It is expected only while this guest sees it read-only.
export function mountsCheck(mountsText, env, readOnlyMount = null) {
  const workspace = env.WORKSPACE_DIR ?? null;
  const unexpected = [];
  let hostMounts = 0;
  for (const line of String(mountsText).split('\n')) {
    const [source, target, type, options = ''] = line.split(' ');
    if (!target || !/^(?:virtiofs|9p|fuse[\w.]*|nfs\d?|cifs|vboxsf|overlayfs)$/.test(type) || type === 'overlayfs') continue;
    hostMounts++;
    if (target === workspace) continue;
    if (target === '/etc/resolv.conf' && /^bind-/.test(source)) continue;
    if (readOnlyMount && target === readOnlyMount && options.split(',').includes('ro')) continue;
    unexpected.push(`${type}:${target}`);
  }
  const expected = readOnlyMount ? 'the job workspace, resolv.conf and the read-only runtime' : 'the job workspace and resolv.conf';
  return makeCheck('host-mounts', unexpected.length > 0, `${hostMounts} host-backed mounts; ${unexpected.length ? 'unexpected: ' + unexpected.join(', ') : 'only ' + expected}`, 'high');
}

function procEnvirons(root) {
  const lines = [];
  let processes = 0;
  const collect = (buffer, pid) => { processes++; for (const entry of buffer.toString('utf8').split('\0')) if (entry.includes('=')) lines.push([pid, entry]); };
  let pids = [];
  try { pids = readdirSync(root).filter((name) => /^\d+$/.test(name)); } catch { /* no /proc */ }
  for (const pid of pids) { try { collect(readFileSync(path.join(root, pid, 'environ')), pid); } catch { /* not ours */ } }
  // Command lines can carry a token as an argument.
  const commandLines = [];
  for (const pid of pids) { try { commandLines.push([pid, readFileSync(path.join(root, pid, 'cmdline')).toString('utf8').split('\0').join(' ')]); } catch { /* gone */ } }
  return { lines, processes, pids, commandLines };
}

function processEnvironCheck(ctx, role) {
  const { lines, processes, commandLines } = procEnvirons(ctx.proc ?? '/proc');
  const findings = [];
  for (const [pid, text] of commandLines) {
    for (const item of scanText(text, { config: false })) if (item.kind === 'real') findings.push({ ...item, where: `pid${pid}:cmdline` });
    for (const token of tokenCandidates(text)) ctx.candidates.add(token);
  }
  for (const [pid, entry] of lines) {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq), value = entry.slice(eq + 1);
    const found = classifyEnv(name, value);
    if (found?.kind === 'real') findings.push({ kind: 'real', name, length: value.length, hash: hash4(value), full: sha256(value), where: `pid${pid}` });
    for (const token of tokenCandidates(value)) ctx.candidates.add(token);
  }
  const real = findings.filter((item) => item.kind === 'real');
  return makeCheck('process-environ', real.length > 0, `${processes} process environments and command lines readable as ${role}; ${real.length} real-looking` +
    (real.length ? ': ' + real.slice(0, 12).map((item) => `${item.where}:${label(item)}`).join(', ') : ''), 'critical');
}

/** What the scan did with the known signed-policy file: counts and fixed reason codes only. */
function signatureNote(ctx) {
  const rejected = [...new Set(ctx.signatureRejected ?? [])];
  return (ctx.signatures?.length ? `; signed policy artifact recognized: ${ctx.signatures.length}` : '') +
    (rejected.length ? `; signed policy artifact rejected: ${rejected.join(',')}` : '');
}

function filesystemScanCheck(roots, ctx) {
  const exhausted = [];let failed=false;
  const findings = [];
  let scanned = 0;
  for (const [root, maxDepth] of roots) {
    const budget={files:6000,exhausted:false,failed:false,deadline:ctx.deadline};
    for (const file of walk(root, { maxDepth, budget, excludedPaths:ctx.excludedPaths })) { if (scanFile(file, ctx, findings)) scanned++; }
    if(budget.exhausted)exhausted.push(root);
    failed ||= budget.failed;
  }
  ctx.scanFindings = findings;
  const summary = sumFindings(findings);
  const sentinelFiles = [...new Set(summary.sentinel.map((item) => item.where))].length;
  return makeCheck('filesystem-token-scan', summary.real.length ? true : exhausted.length||failed||ctx.failedReads.size ? null : false,
    `${scanned} files under ${roots.map(([root]) => root).join(' ')}; ${summary.text}; sentinel in ${sentinelFiles} files` +
    (failed||ctx.failedReads.size ? '; scan incomplete: filesystem observation failed' : '') +
    (exhausted.length ? `; scan incomplete: file budget reached in ${exhausted.length} roots` : '') + signatureNote(ctx), 'critical');
}

function knownSecretCheck(ctx) {
  const known = ctx.knownHashes;
  if (!known.size) return makeCheck('known-secret-match', null, 'no host credential hashes supplied; this check compared nothing', 'critical');
  let compared = 0;
  const hits = [];
  for (const candidate of ctx.candidates) { compared++; const full = sha256(candidate); if (known.has(full)) hits.push(`(${candidate.length},${full.slice(0, 4)})`); }
  return makeCheck('known-secret-match', hits.length > 0, `${known.size} host credential hashes compared against ${compared} guest strings; matches: ${hits.length}${hits.length ? ' ' + hits.slice(0, 8).join(',') : ''}`, 'critical');
}

function providerState(ctx, env, service) {
  const modeName = service ? `SBX_CRED_${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODE` : null;
  const mode = modeName ? (env[modeName] ?? 'unknown') : 'unknown';
  const all = [...(ctx.envFindings ?? []), ...(ctx.fileFindings ?? [])];
  const sentinels = all.filter((item) => item.kind === 'sentinel').length;
  const empties = all.filter((item) => item.kind === 'empty').length;
  return { service: service ?? null, mode_variable: modeName, mode, sentinels, empty_values: empties,
    ...(ctx.ownerGenerationFile ? {owner_generation_bound: ctx.ownerGenerationBound === true} : {}),
    ...(ctx.credentialExpiry ? { credential_expiry: ctx.credentialExpiry, credential_file_bound: ctx.credentialFileSentinels === true && ctx.credentialExpiry === 'future' } : {}) };
}

function sentinelStatusCheck(ctx, provider) {
  const real = [...ctx.envFindings, ...ctx.fileFindings, ...ctx.scanFindings].filter((item) => item.kind === 'real');
  return makeCheck('sentinel-status', real.length > 0,
    `${provider.mode_variable}=${provider.mode}; ${provider.sentinels} sentinel values and ${provider.empty_values} empty values in provider-adjacent places; ${real.length} real-looking values anywhere` +
    signatureNote(ctx), 'critical');
}

/** Unix sockets a job could connect to. Listed as evidence; only the SSH agent socket is asked a question. */
function listUnixSockets(dirs) {
  const found = [];
  for (const root of dirs) {
    const stack = [[root, 0]];
    while (stack.length && found.length < 40) {
      const [dir, depth] = stack.pop();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSocket()) found.push(full);
        else if (entry.isDirectory() && depth < 2 && !entry.isSymbolicLink()) stack.push([full, depth + 1]);
      }
    }
  }
  return [...new Set(found)].sort();
}

function sshAgentCheck(sockets, env = {}) {
  return Promise.all(sockets.map((socket) => new Promise((resolve) => {
    const client = connect(socket);
    const done = (result) => { client.destroy(); resolve({ socket, ...result }); };
    const timer = setTimeout(() => done({ state: 'no-reply' }), 2500);
    client.on('connect', () => client.write(Buffer.from([0, 0, 0, 1, 11])));
    client.on('data', (data) => {
      clearTimeout(timer);
      done(data.length >= 9 && data[4] === 12 ? { state: 'answered', keys: data.readUInt32BE(5) } : { state: 'answered', keys: 0 });
    });
    client.on('error', (error) => { clearTimeout(timer); done({ state: error.code === 'ENOENT' ? 'absent' : 'error:' + (error.code ?? 'unknown') }); });
  }))).then((results) => {
    const keys = results.reduce((sum, item) => sum + (item.keys ?? 0), 0);
    const others = listUnixSockets(['/run', '/var/run', '/tmp', env.XDG_RUNTIME_DIR].filter(Boolean)).filter((socket) => !results.some((item) => item.socket === socket));
    return makeCheck('ssh-agent', keys > 0, (results.map((item) => `${item.socket}: ${item.state}${item.keys !== undefined ? ' keys=' + item.keys : ''}`).join('; ') || 'no agent socket configured') +
      `; other unix sockets in the sandbox: ${others.length ? others.join(',') : 'none'}`, 'high');
  });
}

function httpJson(url, { method = 'GET', headers = {}, body, timeout = 4000, proxy = null } = {}) {
  return new Promise((resolve) => {
    // Through the sandbox's HTTP proxy the way an agent's own clients reach sandbox-internal names.
    const target = new URL(url);
    const options = proxy ? { host: proxy.hostname, port: Number(proxy.port) || 80, path: url, method, headers: { ...headers, host: target.host }, agent: false, timeout }
      : { method, headers, agent: false, timeout };
    const onResponse = (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; if (data.length > 262144) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', () => resolve({ error: 'response' }));
    };
    const req = proxy ? request(options, onResponse) : request(url, options, onResponse);
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (error) => resolve({ error: error.code ?? 'error' }));
    if (body) req.write(body);
    req.end();
  });
}

function parseRpc(body) {
  const data = String(body).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
  try { return JSON.parse(data || body); } catch { return null; }
}

async function mcpGatewayCheck(env) {
  const url = env.MCP_GATEWAY_URL;
  if (!url) return makeCheck('mcp-gateway', false, 'no MCP gateway configured', 'high');
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer proxy-managed' };
  let proxy = null;
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'faravan-probe', version: '1' } } });
  let init = await httpJson(url, { method: 'POST', headers, body: initBody });
  if (init.error && env.HTTP_PROXY) {
    try { proxy = new URL(env.HTTP_PROXY ?? env.http_proxy); } catch { proxy = null; }
    if (proxy) init = await httpJson(url, { method: 'POST', headers, body: initBody, proxy });
  }
  if (init.error) return makeCheck('mcp-gateway', false, `gateway configured but not reachable (${init.error})`, 'high');
  const session = init.headers?.['mcp-session-id'];
  const sessionHeaders = session ? { ...headers, 'mcp-session-id': session } : headers;
  await httpJson(url, { method: 'POST', headers: sessionHeaders, proxy, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const list = await httpJson(url, { method: 'POST', headers: sessionHeaders, proxy, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const parsed = parseRpc(list.body ?? '');
  const tools = parsed?.result?.tools;
  if (!Array.isArray(tools)) return makeCheck('mcp-gateway', null, `gateway answered initialize (HTTP ${init.status}) but tools/list gave no list (HTTP ${list.status ?? list.error})`, 'high');
  // The gateway's own management tools (find/add/configure/execute servers) reach nothing while the lender has
  // registered no MCP server in this sbx identity. Any other tool is a lender-configured service the job could use.
  const names = tools.map((tool) => String(tool.name).slice(0, 40));
  const lenderTools = names.filter((name) => !GATEWAY_BUILTIN_TOOLS.includes(name));
  const text = `gateway reachable with the sentinel bearer; ${names.length} tools (${lenderTools.length} beyond the gateway's own management tools)` +
    (names.length ? ': ' + names.slice(0, 10).join(',') : '');
  const check = makeCheck('mcp-gateway', names.length > 0, text, lenderTools.length ? 'high' : 'medium');
  return check;
}

function directHttp(host, port, requestText) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2500 });
    let data = '';
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => { data += chunk; if (data.includes('\r\n')) done({ status: /^HTTP\/\d\.\d (\d{3})/.exec(data)?.[1] ?? 'non-http' }); });
    socket.on('timeout', () => done({ error: 'timeout' }));
    socket.on('error', (error) => done({ error: error.code ?? 'error' }));
    socket.on('close', () => done({ error: 'closed' }));
  });
}

async function metadataCheck(env) {
  const parts = [];
  let found = false;
  const direct = await directHttp('169.254.169.254', 80, 'GET /latest/meta-data/ HTTP/1.0\r\nHost: 169.254.169.254\r\n\r\n');
  parts.push(`direct 169.254.169.254: ${direct.status ? 'HTTP ' + direct.status : direct.error}`);
  if (direct.status) found = true;
  const proxy = env.HTTP_PROXY ?? env.http_proxy;
  if (proxy) {
    try {
      const target = new URL(proxy);
      for (const host of ['169.254.169.254', 'metadata.google.internal']) {
        const viaProxy = await directHttp(target.hostname, Number(target.port) || 80,
          `GET http://${host}/latest/meta-data/ HTTP/1.0\r\nHost: ${host}\r\nMetadata-Flavor: Google\r\n\r\n`);
        parts.push(`via proxy ${host}: ${viaProxy.status ? 'HTTP ' + viaProxy.status : viaProxy.error}`);
        if (viaProxy.status && /^2/.test(viaProxy.status)) found = true;
      }
    } catch { parts.push('proxy address unreadable'); }
  }
  return makeCheck('link-local-metadata', found, parts.join('; '), 'high');
}

// A clean root report settles an incomplete user scan, so the root run must come from the system sudo.
// Any program earlier on PATH could print a clean report; PATH is never searched.
export const SUDO_CANDIDATES = ['/usr/bin/sudo', '/bin/sudo'];
function systemSudo(candidates) {
  return candidates.find((candidate) => { try { return path.isAbsolute(candidate) && statSync(candidate).isFile(); } catch { return false; } }) ?? null;
}

function privilegeCheck(timeoutMs, sudoPath) {
  const sudo = sudoPath ? spawnSync(sudoPath, ['-n', 'true'], { timeout: Math.max(1,Math.min(5000,timeoutMs)), killSignal:'SIGKILL', stdio:'ignore' }) : null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const available = sudo?.status === 0;
  return { check: makeCheck('guest-privilege', available || uid === 0, `uid=${uid}; passwordless sudo ${available ? 'available' : 'not available'}. The job can read everything inside its own sandbox; that is why only sentinels may be there.`, 'info'), sudo: available };
}

// ---- self test --------------------------------------------------------------------------------

/** The classifier must flag a made-up real token and ignore a sentinel, here, in this runtime. */
export function selfTest() {
  const canary = 'sk-ant-oat01-' + 'Zq7Tn4Xw1Lp8Vb3Rk9Ys2Hd6Mc5Fj0Ga'.repeat(2);
  const fakeJwt = ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJjYW5hcnkifQ', 'c2lnbmF0dXJlLWNhbmFyeQ'].join('.');
  const detected = scanText(`{"accessToken":"${canary}"}`).some((item) => item.kind === 'real') &&
    scanText(`OPENAI_API_KEY=${fakeJwt}`).some((item) => item.kind === 'real') &&
    classifyEnv('CANARY_API_KEY', 'a'.repeat(4) + 'Kd82hs72Jd92kd82Qp') !== null;
  const ignored = scanText('{"accessToken":"sk-ant-oat01-proxy-managed"}').every((item) => item.kind === 'sentinel') &&
    scanText('experimental_bearer_token = "oai-oat01-proxy-managed"').every((item) => item.kind === 'sentinel') &&
    classifyEnv('GH_TOKEN', 'gho_proxymanaged0000000000000000000000') ?.kind === 'sentinel';
  return { canary_detected: detected, sentinel_ignored: ignored };
}

// ---- main -------------------------------------------------------------------------------------

function parseOwnerGeneration(text, service) {
  const value = JSON.parse(text);
  let expiry, fields;
  if (service === 'anthropic') {
    fields = value.claudeAiOauth;
    expiry = fields?.expiresAt;
    if (!['accessToken','refreshToken'].every(key => typeof fields?.[key] === 'string' && fields[key])) return null;
    fields.accessToken = fields.refreshToken = '';
  } else {
    fields = value.tokens;
    if (!['access_token','refresh_token','id_token'].every(key => typeof fields?.[key] === 'string' && fields[key]) || value.OPENAI_API_KEY) return null;
    try { expiry = JSON.parse(Buffer.from(fields.access_token.split('.')[1], 'base64url').toString()).exp * 1000; }
    catch { expiry = null; }
    fields.access_token = fields.refresh_token = fields.id_token = '';
  }
  // Expired auth is still the owner's expected file, but cannot establish a live binding.
  return {masked:JSON.stringify(value), bound:Number.isFinite(expiry) && expiry > Date.now()};
}

function ownerGenerationState(generation, service, env, role) {
  if (!generation || generation.service !== service || !['anthropic','openai'].includes(service) ||
      typeof generation.directory !== 'string' || !path.isAbsolute(generation.directory)) return {};
  const directory = path.resolve(generation.directory);
  const file = path.join(directory, service === 'anthropic' ? '.credentials.json' : 'auth.json');
  const state = {ownerGenerationFile:file, ownerGenerationService:service, ownerGenerationBound:false};
  try {
    // sudo can reset the provider's environment; the host's explicit directory survives in argv.
    if ((role !== 'root' && env[service === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] !== directory) ||
        !lstatSync(directory).isDirectory() || !lstatSync(file).isFile()) return state;
    return {...state, ownerGenerationExpected:true, ownerGenerationBound:parseOwnerGeneration(readText(file),service)?.bound === true};
  } catch { return state; }
}

export async function runProbe(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const role = options.role ?? 'user';
  const deadline=deadlineOf(options);
  const hostRoots=[[home,5],['/etc',2],['/run',2],['/opt',3],['/srv',3],['/tmp',3],['/mnt',3],['/media',3],['/home',4],['/usr/local/etc',3],['/usr/local/share',3],['/var/run',2]];
  // A declared workspace is source, not a host observation root.
  // The privileged run also scans every root the user run scanned, so its complete scan covers the user's.
  const roots=[...new Map([...(options.roots??[...hostRoots,...(!options.workspace?[[env.WORKSPACE_DIR??'/workspace',3]]:[])]),...(options.userRoots??[])]
    .map(([root,depth])=>[path.resolve(root)+'\0'+depth,[path.resolve(root),depth]])).values()];
  const excludedPaths=[];let invalidExclusion=false;
  if(options.workspace) {
    excludedPaths.push(path.resolve(options.workspace));
    try {excludedPaths.push(realpathSync(options.workspace));}catch(error) {if(error.code!=='ENOENT')invalidExclusion=true;}
    const protectedPaths=[...hostRoots.map(([root])=>root),...roots.map(([root])=>root),'/root',
      ...[home,'/root'].flatMap(base=>CREDENTIAL_FILES.flatMap(file=>[path.join(base,file),path.dirname(path.join(base,file))]))];
    for(const protectedPath of protectedPaths) {
      let resolved=protectedPath;
      try {resolved=canonicalProtectedPath(protectedPath);}catch {invalidExclusion=true;}
      if(excludedPaths.some(excluded=>within(protectedPath,excluded)||within(resolved,excluded)))invalidExclusion=true;
    }
  }
  const ctx = { home, deadline, excludedPaths, failedReads:new Set(), candidates: new Set(), knownHashes: new Set(options.knownHashes ?? []), proc: options.proc, envFindings: [], fileFindings: [], scanFindings: [],
    ...ownerGenerationState(options.ownerGeneration, options.provider, env, role) };
  const checks = [];
  const finish=provider=>{
    if(remainingMs(deadline)<=0){const scan=checks.find(check=>check.id==='filesystem-token-scan');if(scan&&scan.found!==true){scan.found=null;scan.evidence_redacted+='; probe deadline reached';}}
    const test=selfTest(),{verdict,reasons}=decideVerdict({checks,provider,selfTest:test,ownerGenerationBound:ctx.ownerGenerationBound === true});
    return {probe_version:PROBE_VERSION,role,verdict,inconclusive_reasons:reasons,provider,self_test:test,known_hashes_checked:ctx.knownHashes.size,node:process.version,checks};
  };
  if(invalidExclusion) {
    checks.push(...REQUIRED_CHECKS.map(id=>makeCheck(id,null,'workspace exclusion overlaps a protected path or could not be checked','critical')));
    return finish(providerState(ctx,env,options.provider));
  }
  const guarded = async (id, severity, fn) => {
    if(remainingMs(deadline)<=0){checks.push(makeCheck(id,null,'probe deadline reached',severity));return;}
    try { checks.push(await fn()); } catch (error) { checks.push(makeCheck(id, null, `check failed to run: ${String(error?.code ?? error?.name ?? 'error')}`, severity)); }
  };
  await guarded('env-secrets', 'critical', () => envCheck(env, ctx));
  await guarded('credential-files', 'critical', () => credentialFilesCheck(home, ctx));
  if (ctx.ownerGenerationFile) await guarded('owner-generation', 'critical', () => {
    const findings=[];
    const read=scanFile(ctx.ownerGenerationFile,ctx,findings,{forceConfig:true});
    ctx.fileFindings.push(...findings);
    const summary=sumFindings(findings);
    return makeCheck('owner-generation',summary.real.length?true:read?false:null,
      `owner provider file ${ctx.ownerGenerationBound?'bound':'not bound'}; ${summary.text}`,'critical');
  });
  await guarded('git-credential-helpers', 'low', () => gitHelpersCheck(home, env));
  const mounts = 'mountsText' in options ? options.mountsText : (() => { try { return readFileSync('/proc/mounts', 'utf8'); } catch { return null; } })();
  await guarded('host-mounts', 'high', () => {
    if (mounts === null) return makeCheck('host-mounts', null, '/proc/mounts unreadable', 'high');
    return mountsCheck(mounts, env, options.readOnlyMount ?? null);
  });
  await guarded('process-environ', 'critical', () => processEnvironCheck(ctx, role));
  await guarded('filesystem-token-scan', 'critical', () => filesystemScanCheck(roots, ctx));
  const provider = providerState(ctx, env, options.provider);
  await guarded('sentinel-status', 'critical', () => sentinelStatusCheck(ctx, provider));
  await guarded('foreign-credential-reach', 'medium', () => foreignCredentialCheck(ctx, provider));
  if (options.networkChecks) {
    checks.push(...options.networkChecks); // a caller that supplies its own network observations (tests)
  } else if (options.network !== false) {
    await guarded('ssh-agent', 'high', () => sshAgentCheck([...new Set([env.SSH_AUTH_SOCK, '/run/ssh-agent.sock'].filter(Boolean))], env));
    await guarded('mcp-gateway', 'high', () => mcpGatewayCheck(env));
    await guarded('link-local-metadata', 'high', () => metadataCheck(env));
  } else {
    // Skipped is not clear: a verdict cannot be a pass while the network checks did not run.
    for (const id of ['ssh-agent', 'mcp-gateway', 'link-local-metadata']) checks.push(makeCheck(id, null, 'network checks skipped by the caller', 'high'));
  }
  await guarded('known-secret-match', 'critical', () => knownSecretCheck(ctx));
  let sudoAvailable = false;
  const sudoPath = systemSudo(options.sudoCandidates ?? SUDO_CANDIDATES);
  if (role === 'user' && options.escalate !== false && remainingMs(deadline)>0) {
    const privilege = privilegeCheck(remainingMs(deadline), sudoPath);
    sudoAvailable = privilege.sudo;
    checks.push(privilege.check);
  }
  // A hostile job would become root if it could. Run the same probe as root and merge what it finds.
  const rootRuns = [];
  if (sudoAvailable) {
    const args = ['-n', process.execPath, fileURLToPath(import.meta.url), '--role', 'root', '--home', '/root', '--no-network', '--provider', options.provider ?? '', '--deadline-ns',String(deadline),
      '--user-roots', Buffer.from(JSON.stringify(roots)).toString('base64')];
    if (options.workspace) args.push('--exclude-workspace',options.workspace);
    if (options.ownerGeneration) args.push('--owner-generation',Buffer.from(JSON.stringify(options.ownerGeneration)).toString('base64url'));
    if (options.knownHashes?.length) args.push('--known-hashes', Buffer.from(JSON.stringify(options.knownHashes)).toString('base64'));
    const child = remainingMs(deadline)>0 ? spawnSync(sudoPath,args,{timeout:remainingMs(deadline),killSignal:'SIGKILL',encoding:'utf8',maxBuffer:4*1024*1024}) : null;
    const line = (child?.stdout ?? '').split('\n').find((entry) => entry.startsWith(MARKER));
    try { rootRuns.push(JSON.parse(line.slice(MARKER.length))); } catch { rootRuns.push(null); }
    const merged = ['env-secrets', 'credential-files', 'git-credential-helpers', 'process-environ', 'filesystem-token-scan', 'known-secret-match', ...(ctx.ownerGenerationFile ? ['owner-generation'] : [])];
    const root = rootRuns[0];
    for (const id of merged) {
      const mine = checks.find((entry) => entry.id === id);
      const theirs = root?.checks?.find((entry) => entry.id === id);
      if (!theirs && mine) { mine.found = mine.found === true ? true : null; mine.evidence_redacted += '; as root: probe did not run'; }
      else if (theirs && mine) {
        // Root can read what the user cannot. Its complete clean scan of the user's roots and more settles a user scan
        // that stopped at unreadable paths. Other checks see a different environment as root, so they still need both.
        const rootCovers = id === 'filesystem-token-scan' && theirs.found === false;
        mine.found = mine.found === true || theirs.found === true ? true : rootCovers ? false : mine.found === null || theirs.found === null ? null : false;
        mine.severity = verdictRank[theirs.severity] > verdictRank[mine.severity] ? theirs.severity : mine.severity;
        mine.evidence_redacted = `user: ${mine.evidence_redacted} | root: ${theirs.evidence_redacted}`.slice(0, 1500);
      }
    }
  }
  return finish(provider);
}

// This independent process can stop a probe blocked in synchronous I/O. The
// privileged invocation arms its own watchdog with the SAME guest monotonic
// deadline, so terminating sudo cannot leave that privileged probe running.
// Parent identity is checked before signalling to avoid PID reuse.
export async function runProbeWithDeadline(options = {}) {
  const deadline=deadlineOf(options);
  // The user's fallback allows only reaping time after the work deadline.
  // The privileged worker is killed at the work deadline itself.
  const killAt=deadline+(options.role==='root'?0n:250000000n);
  const watchdog=spawn(process.execPath,['-e',`
    const parent=Number(process.argv[1]),deadline=BigInt(process.argv[2]);
    const timer=setTimeout(()=>{if(process.ppid===parent){try{process.kill(parent,'SIGKILL');}catch{}}process.exit(0);},Math.max(0,Number((deadline-process.hrtime.bigint())/1000000n)));
    process.stdin.resume();process.stdin.once('end',()=>{clearTimeout(timer);process.exit(0);});
  `,String(process.pid),String(killAt)],{stdio:['pipe','ignore','ignore']});
  const stopped=new Promise((resolve,reject)=>{watchdog.once('close',resolve);watchdog.once('error',reject);});
  watchdog.stdin.on('error',()=>{});
  try {return await runProbe({...options,deadlineNs:String(deadline)});}
  finally {watchdog.stdin.end();await stopped;}
}

function argValue(args, name) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let knownHashes = [];
  try { knownHashes = JSON.parse(Buffer.from(argValue(args, '--known-hashes') ?? '', 'base64').toString() || '[]'); } catch { knownHashes = []; }
  // The user run's clean-scan merge relies on these roots, so a malformed list ends this run without a report.
  let userRoots;
  try { userRoots = JSON.parse(Buffer.from(argValue(args, '--user-roots') ?? '', 'base64').toString() || '[]'); } catch { process.exit(2); }
  if (!Array.isArray(userRoots) || !userRoots.every(root => Array.isArray(root) && root.length === 2 && typeof root[0] === 'string' && path.isAbsolute(root[0]) && Number.isSafeInteger(root[1]) && root[1] >= 0)) process.exit(2);
  let ownerGeneration;
  try { ownerGeneration=JSON.parse(Buffer.from(argValue(args,'--owner-generation')??'','base64url').toString()||'null'); } catch { process.exit(2); }
  const report = await runProbeWithDeadline({ role: argValue(args, '--role') ?? 'user', home: argValue(args, '--home'), provider: argValue(args, '--provider') || undefined,
    network: !args.includes('--no-network'), knownHashes, ownerGeneration, workspace:argValue(args,'--exclude-workspace'), readOnlyMount:argValue(args,'--allow-ro-mount'), userRoots, budgetMs:Number(argValue(args,'--budget-ms')??20000), deadlineNs:argValue(args,'--deadline-ns') });
  process.stdout.write(MARKER + JSON.stringify(report) + '\n');
}
