// Preservation and redaction checks for the S9 two-computer journey (step 6 of
// docs/design/S9-TWO-COMPUTER-JOURNEY.md).
//
// Pure module: no file or process access of its own. The later driver collects
// plain-object inputs (before/after snapshots of approved nonsecret app
// preferences, channel identity, written paths with the run-owned roots, process
// and forward close receipts, and the text of evidence artifacts) and hands them
// to checkPreservation. It never reads credential stores, machines or app data.
//
// Result shape:
//   { status: 'pass' | 'blocked' | 'failed', label: 'fresh-install' | 'reused-install' | null,
//     issues: [{ code, item }] }
// `status` is 'pass' when every rule holds, 'blocked' when a preservation rule
// fires, and 'failed' when a required input is missing or malformed. `label`
// names the install kind every result is tagged with. `issues` is empty on a
// pass. `item` is a stable structural identifier — an input index or field path
// such as `writes[0].path` or `evidence[0]` — never an untrusted name, path or
// ID copied from the input, and never a secret value itself.

export const REDACTION_MARKER = '[REDACTED]';

// Stable blocked/failed codes, exercised across the preservation regression
// suites (including the bounded/opaque-evidence cases in revise2).
export const BLOCKED_CODES = Object.freeze({
  WRITE_OUTSIDE_RUN_ROOTS: 'write_outside_run_roots',
  TRAY_MODEL_LIST_CHANGED: 'tray_model_list_changed',
  TRAY_MODEL_SELECTION_CHANGED: 'tray_model_selection_changed',
  CHANNEL_IDENTITY_CHANGED: 'channel_identity_changed',
  EVIDENCE_SESSION_TOKEN_URL: 'evidence_contains_session_token_url',
  EVIDENCE_BEARER_TOKEN: 'evidence_contains_bearer_token',
  EVIDENCE_INVITATION: 'evidence_contains_invitation',
  EVIDENCE_AUTH_HEADER: 'evidence_contains_auth_header',
  EVIDENCE_UNINSPECTABLE: 'evidence_uninspectable',
  CLEANUP_UNOWNED_PROCESS: 'cleanup_unowned_process',
  INSTALL_DESTINATION_NOT_RUN_OWNED: 'install_destination_not_run_owned',
  MISSING_CLEANUP_RECEIPT: 'missing_cleanup_receipt',
  REUSED_INSTALL_WITHOUT_PRIOR_RECEIPT: 'reused_install_without_prior_receipt',
  MISSING_INPUT: 'missing_input',
});

export const INSTALL_LABELS = Object.freeze(['fresh-install', 'reused-install']);

// --- path helpers (lexical only; no filesystem access) ----------------------

// Resolve a path lexically: split on '/', drop '' and '.', resolve '..'
// against the segments seen so far. Returns the segment list, or null when
// '..' would escape above the filesystem root.
function normalizePathParts(value) {
  const parts = [];
  for (const part of String(value).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts;
}

// An absolute path is a string starting with '/' whose '..' segments never
// escape above the root. Relative paths are malformed at this boundary.
function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && normalizePathParts(value) !== null;
}

// True when `candidate` is the root itself or lies under it, after both are
// normalized lexically the same way. Both arguments must be absolute paths: a
// relative candidate is never under an absolute root, and a '..' segment that
// escapes the filesystem root makes the path outside it.
export function isUnderRoot(root, candidate) {
  if (!isAbsolutePath(root) || !isAbsolutePath(candidate)) return false;
  const rootParts = normalizePathParts(root);
  const parts = normalizePathParts(candidate);
  if (parts.length < rootParts.length) return false;
  return rootParts.every((part, index) => parts[index] === part);
}

// --- secret scanning and redaction (evidence text) --------------------------

// A session-token URL: a URL carrying a ?token=<redacted> &token= or #token= query/fragment.
const TOKEN_URL_RE = /([?&#]token=)([^\s&\"'<>]+)/gi;
// A complete auth header, including folded continuation lines. An empty first
// line must not sever its value from an indented following line.
const AUTH_HEADER_RE = /^([ \t]*authorization[ \t]*:[ \t]*)([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/gim;
// A serialized auth header in JSON: {"Authorization":"Basic ..."}.
// The opening quote must not itself be backslash-escaped; that form has its
// own pattern below.
const JSON_AUTH_HEADER_RE = /(?<!\\)"authorization"\s*:\s*"((?:\\.|[^"\\\r\n])+)"/gi;
// The same header as it appears inside a JSON string value, with
// backslash-escaped quotes: {\"Authorization\":\"Basic ...\"}.
const JSON_AUTH_HEADER_ESCAPED_RE = /\\"authorization\\"[ \t]*:[ \t]*\\"([^"\\\r\n]+)\\"/gi;
// A bare bearer <redacted> outside an Authorization header line.
const BEARER_RE = /\bbearer[ \t]+([^\s\"'<>]+)/gi;
// An invitation payload: an invitation/invite token, code, payload, url or link
// carried as a key/value pair (JSON, log line or query-style text).
const INVITATION_RE = /\b(?:invitation|invite)(?:[-_ ]?(?:token|code|payload|url|link))?[\"']?[ \t]*[:=][ \t]*[\"']?([^\s\"'<>,}]+)/gi;
// Faravan's short invitation link, <origin>/i/<code>#<seed>: the code and the seed after the fragment mark are both
// secret. The long link (/join#invite=<blob>) carries an invite= pair, which INVITATION_RE finds; the link handler's
// faravan://join?link=<link> (or faravan://) carries either link URL-encoded, so its whole link value is secret.
const SHORT_INVITE_RE = /(\/i\/)([A-Za-z0-9_-]+#[A-Za-z0-9_-]+)/g;
const JOIN_HANDLER_RE = /((?:faravan|faravan):\/\/join\?link=)([^\s\"'<>]+)/gi;

// A captured secret value is redacted output only when it is exactly the
// marker. A marker with extra secret material glued to it is still a secret.
const isRedactedValue = value => value === REDACTION_MARKER;

// An Authorization header value may carry its scheme in front of the marker
// (`Basic [REDACTED]`): the scheme is syntax, the marker is the whole secret.
// Anything after the marker is still unredacted secret material.
function isRedactedAuthHeaderValue(value) {
  const trimmed = value.trim();
  if (trimmed === REDACTION_MARKER) return true;
  const rest = trimmed.replace(/^[A-Za-z][A-Za-z0-9.+-]*[ \t]+/, '');
  return rest !== trimmed && rest === REDACTION_MARKER;
}

// Raw (unencoded) finders. Each entry names the regex, the group holding the
// secret value, the finding kind, the code, and how to tell a redacted value.
const RAW_FINDERS = [
  {re: TOKEN_URL_RE, group: 2, kind: 'session-token URL', code: BLOCKED_CODES.EVIDENCE_SESSION_TOKEN_URL, redacted: isRedactedValue},
  {re: AUTH_HEADER_RE, group: 2, kind: 'auth header', code: BLOCKED_CODES.EVIDENCE_AUTH_HEADER, redacted: isRedactedAuthHeaderValue},
  {re: JSON_AUTH_HEADER_RE, group: 1, kind: 'auth header', code: BLOCKED_CODES.EVIDENCE_AUTH_HEADER, redacted: isRedactedAuthHeaderValue},
  {re: JSON_AUTH_HEADER_ESCAPED_RE, group: 1, kind: 'auth header', code: BLOCKED_CODES.EVIDENCE_AUTH_HEADER, redacted: isRedactedAuthHeaderValue},
  {re: BEARER_RE, group: 1, kind: 'bearer <redacted>', code: BLOCKED_CODES.EVIDENCE_BEARER_TOKEN, redacted: isRedactedValue},
  {re: INVITATION_RE, group: 1, kind: 'invitation payload', code: BLOCKED_CODES.EVIDENCE_INVITATION, redacted: isRedactedValue},
  {re: SHORT_INVITE_RE, group: 2, kind: 'invitation link', code: BLOCKED_CODES.EVIDENCE_INVITATION, redacted: isRedactedValue},
  {re: JOIN_HANDLER_RE, group: 2, kind: 'invitation link', code: BLOCKED_CODES.EVIDENCE_INVITATION, redacted: isRedactedValue},
];

// Raw findings name only the rule and kind, never a secret value. The encoded
// pass works on the raw-redacted text so it cannot partially replace a raw
// match and leave its value behind.
function findRawSecrets(source) {
  const findings = [];
  for (const finder of RAW_FINDERS) {
    for (const match of source.matchAll(finder.re)) {
      if (finder.re === BEARER_RE) {
        // A bearer <redacted> already caught as part of an Authorization header line is
        // reported once, as an auth header; only a bare bearer <redacted> is its own finding.
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const line = source.slice(lineStart, match.index);
        if (/authorization[ \t]*:[ \t]*$/i.test(line)) continue;
      }
      const value = match[finder.group];
      if (value === undefined || finder.redacted(value)) continue;
      findings.push({code: finder.code, kind: finder.kind});
    }
  }
  return findings;
}

// --- encoded / serialized secret forms --------------------------------------

// Decode complete logical log/header lines, not whitespace-separated tokens:
// an encoded header separator and a literal space still share one context.
// Replacement uses the original line span, never a decoded substring offset.
const ENCODED_LINE_RE = /[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/g;
const ENCODED_MARKER_RE = /%[0-9A-Fa-f]{2}|\\(?:u[0-9A-Fa-f]{4}|["\\/bfnrt])/;
const BASE64_TOKEN_RE = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{8,}={0,2}(?![A-Za-z0-9+/_=-])/g;
const INVITATION_KEY_RE = /^(?:invitation|invite)(?:[-_ ]?(?:token|code|payload|url|link))?$/i;
const MAX_EVIDENCE_LENGTH = 1024 * 1024;
const MAX_INSPECTION_DEPTH = 12;
const MAX_INSPECTION_NODES = 10000;

function uninspectable() {
  return {
    findings: [{ code: BLOCKED_CODES.EVIDENCE_UNINSPECTABLE, kind: 'uninspectable evidence' }],
    text: REDACTION_MARKER,
  };
}

function decodeJsonEscapes(value) {
  return value.replace(/\\(u[0-9A-Fa-f]{4}|["\\/bfnrt])/g, (whole, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return whole;
    }
  });
}

function decodePercent(value) {
  // A trailing '%' or malformed neighboring escape cannot disable valid
  // escapes elsewhere. Even an invalid UTF-8 run must not hide its ASCII
  // delimiters; undecodable non-ASCII bytes stay literal for the next scan.
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => {
    try { return decodeURIComponent(run); }
    catch {
      return run.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

// Canonical base64 bytes, without any claim about their text interpretation:
// one alphabet, legal padding/length and canonical pad bits. A null result
// means the token is not a canonical encoding at all (an ordinary word, a
// fragment, or a malformed token). A non-null result whose bytes are not
// valid UTF-8 is an opaque candidate, not clean text: callers must inspect
// its ASCII secret forms (via a latin1 view, which preserves every ASCII
// byte) instead of certifying it.
function canonicalBase64Bytes(value, encoding) {
  if (typeof value !== 'string' || !value || value.length > MAX_EVIDENCE_LENGTH) return null;
  if (!/^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/.test(value)) return null;
  if (encoding === 'base64' && /[-_]/.test(value)) return null;
  if (encoding === 'base64url' && /[+/]/.test(value)) return null;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1 || (value.includes('=') && value.length % 4 !== 0)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== unpadded.replace(/-/g, '+').replace(/_/g, '/')) return null;
  return bytes;
}

function decodeBase64(value, encoding) {
  const bytes = canonicalBase64Bytes(value, encoding);
  if (bytes === null) return null;
  // The UTF-8 round trip is what makes the decoded text inspectable as text.
  const decoded = bytes.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
}


// JSON.parse otherwise silently discards earlier duplicate property values.
// This token walk runs only after successful parsing, so syntax is already
// validated; reject ambiguous keys (including escaped-equivalent names) and
// excessive nesting/work before inspecting the resulting object.
function unsafeJsonStructure(source) {
  const stack = [];
  let tokens = 0;
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g)) {
    if (++tokens > MAX_INSPECTION_NODES) return true;
    const token = match[0];
    if (token === '{' || token === '[') {
      stack.push({ keys: token === '{' ? new Set() : null, keyNext: true });
      if (stack.length > MAX_INSPECTION_DEPTH) return true;
    } else if (token === '}' || token === ']') stack.pop();
    else {
      const frame = stack.at(-1);
      if (!frame?.keys) continue;
      if (token === ',') frame.keyNext = true;
      else if (token.startsWith('"') && frame.keyNext) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.keyNext = false;
      }
    }
  }
  return false;
}

function inspectJson(value, state, depth) {
  if (depth > MAX_INSPECTION_DEPTH || ++state.nodes > MAX_INSPECTION_NODES) return uninspectable();
  if (typeof value === 'string') return inspectEvidence(value, state, depth + 1);
  if (!value || typeof value !== 'object') return { findings: [], text: value };
  const findings = [];
  if (Array.isArray(value)) {
    const text = [];
    for (const item of value) {
      if (state.nodes >= MAX_INSPECTION_NODES) return uninspectable();
      const result = inspectJson(item, state, depth + 1);
      findings.push(...result.findings);
      text.push(result.text);
    }
    // A child that could not be inspected within budget must not survive
    // inside wrappers that rescan over budget: collapse the whole value
    // so its redacted form is itself within the scan budget.
    if (findings.some(finding => finding.code === BLOCKED_CODES.EVIDENCE_UNINSPECTABLE)) {
      return { findings, text: REDACTION_MARKER };
    }
    return { findings, text };
  }
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    if (state.nodes >= MAX_INSPECTION_NODES) return uninspectable();
    const keyResult = inspectEvidence(key, state, depth + 1);
    findings.push(...keyResult.findings);
    let result;
    if (/^authorization$/i.test(key) || INVITATION_KEY_RE.test(key)) {
      const auth = /^authorization$/i.test(key);
      const clean = typeof child === 'string' && (auth ? isRedactedAuthHeaderValue(child) : isRedactedValue(child));
      result = clean ? { findings: [], text: child } : {
        findings: [{ code: auth ? BLOCKED_CODES.EVIDENCE_AUTH_HEADER : BLOCKED_CODES.EVIDENCE_INVITATION, kind: auth ? 'auth header' : 'invitation payload' }],
        text: REDACTION_MARKER,
      };
    } else if (key === 'body' && Object.prototype.hasOwnProperty.call(value, 'encoding')) {
      // A labelled encoded body promises inspectable text. Unsupported or
      // malformed opaque encodings cannot be certified clean.
      if (child === REDACTION_MARKER) result = { findings: [], text: child };
      else if (value.encoding === 'base64' || value.encoding === 'base64url') {
        const decoded = decodeBase64(child, value.encoding);
        result = decoded === null ? uninspectable() : inspectEvidence(decoded, state, depth + 1);
        result.text = result.findings.length ? REDACTION_MARKER : child;
      } else if (value.encoding === 'utf8' || value.encoding === 'utf-8') {
        result = typeof child === 'string' ? inspectEvidence(child, state, depth + 1) : uninspectable();
      } else result = uninspectable();
    } else result = inspectJson(child, state, depth + 1);
    findings.push(...result.findings);
    entries.push([keyResult.findings.length ? REDACTION_MARKER : key, result.text]);
  }
  if (findings.some(finding => finding.code === BLOCKED_CODES.EVIDENCE_UNINSPECTABLE)) {
    return { findings, text: REDACTION_MARKER };
  }
  return { findings, text: Object.fromEntries(entries) };
}

// Both public operations share this inspector, including all bounds. On a
// bound/opaque-body failure scanning blocks and redaction removes the original
// value; no decoder exception or exhausted budget is interpreted as clean.
// A supported prefixed JSON record: a short log prefix (a word label such as
// INFO, or a bracket label such as [INFO]) followed by one complete JSON
// value. The record is inspected structurally, so an escaped key keeps its
// association with its value across lines; the prefix itself is preserved.
// Returns null when the text is not a supported prefixed record, leaving
// the raw fallback to handle ordinary log lines. A JSON-shaped suffix
// (openers followed by a string) that does not parse is a truncated
// record, not context-free text, and fails closed instead of dropping
// the key/value context.
const LOG_PREFIX_RE = /^\s*(?:\[[^\]\r\n]{0,32}\]\s*|[A-Za-z][A-Za-z0-9._\-:]*(?:\s+[A-Za-z][A-Za-z0-9._\-:]*)*\s+)$/;
function inspectPrefixedJson(source, state, depth) {
  const open = source.search(/[{[]/);
  if (open <= 0) return null;
  const prefix = source.slice(0, open);
  const suffix = source.slice(open);
  if (prefix.length > 80 || prefix.includes('"') || !LOG_PREFIX_RE.test(prefix)) return null;
  let value;
  try { value = JSON.parse(suffix); } catch {
    if (/^[\s{[]*"/.test(suffix)) return uninspectable();
    return null;
  }
  if (unsafeJsonStructure(suffix)) return uninspectable();
  // The prefix is evidence too (a header line before a JSON body), so it gets
  // the same inspection as any other text, never a pass-through.
  const head = inspectEvidence(prefix, state, depth + 1);
  const result = inspectJson(value, state, depth + 1);
  const findings = [...head.findings, ...result.findings];
  if (!findings.length) return { findings: [], text: source };
  const body = !result.findings.length ? suffix
    : typeof result.text === 'string' ? result.text : JSON.stringify(result.text);
  return { findings, text: head.text + body };
}

// Inspect one bare base64 candidate. Returns null when the token is not a
// canonical encoding. A decodable candidate is inspected recursively, so
// nested encodings (percent-encoded text inside base64, base64 inside
// base64) are still found. A candidate whose bytes are not valid UTF-8
// cannot be inspected as text; it is scanned through a latin1 view for
// known ASCII secret forms only.
function inspectDecodedBase64(token, state, depth) {
  const bytes = canonicalBase64Bytes(token);
  if (bytes === null) return null;
  const decoded = decodeBase64(token);
  if (decoded !== null) return inspectEvidence(decoded, state, depth + 1);
  return { findings: findRawSecrets(bytes.toString('latin1')), text: null };
}

function inspectEvidence(source, state, depth = 0) {
  if (depth > MAX_INSPECTION_DEPTH || ++state.nodes > MAX_INSPECTION_NODES ||
      source.length > MAX_EVIDENCE_LENGTH || (state.chars += source.length) > 8 * MAX_EVIDENCE_LENGTH) return uninspectable();
  if (source === REDACTION_MARKER) return { findings: [], text: source };
  // Parse legal JSON whitespace and escaped property names before inspecting
  // their values. String keys are evidence too (including whole auth headers).
  if (/^\s*[\[{\"]/.test(source)) {
    let value;
    let parsed = false;
    try { value = JSON.parse(source); parsed = true; } catch { /* raw/serialized log text below */ }
    if (parsed) {
      if (unsafeJsonStructure(source)) return uninspectable();
      const result = inspectJson(value, state, depth + 1);
      return { findings: result.findings, text: result.findings.length ? JSON.stringify(result.text) : source };
    }
    if (/^\s*\{/.test(source)) {
      // Retain the earlier supported backslash-serialized JSON form, but do
      // not certify an otherwise malformed object as context-free clean text.
      try { JSON.parse(decodeJsonEscapes(source)); } catch { return uninspectable(); }
    }
    // The same fail-closed rule for truncated JSON-shaped arrays and
    // string envelopes: an opener followed by an object or a string is a
    // record, not a log prefix. A bracket label such as [INFO] (an opener
    // followed by a word) is not JSON-shaped and keeps the raw fallback.
    if (/^\s*\[\s*[{"]/.test(source)) {
      try { JSON.parse(decodeJsonEscapes(source)); } catch { return uninspectable(); }
    }
  }
  const prefixed = inspectPrefixedJson(source, state, depth);
  if (prefixed !== null) return prefixed;
  const findings = findRawSecrets(source);
  let redacted = redactRawSecrets(source);
  redacted = redacted.replace(ENCODED_LINE_RE, line => {
    if (!ENCODED_MARKER_RE.test(line)) return line;
    const decoded = decodePercent(decodeJsonEscapes(line));
    if (decoded === line) return line;
    const result = inspectEvidence(decoded, state, depth + 1);
    findings.push(...result.findings);
    return result.findings.length ? REDACTION_MARKER : line;
  });
  // A base64 value split across one line break is one representation, not
  // two clean words: rejoin a bounded pair and inspect the whole value.
  // Only a pair whose joined decoding actually contains a secret form is
  // replaced; innocent wrapped text is left untouched.
  redacted = redacted.replace(/(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{8,}={0,2})\r?\n([A-Za-z0-9+/_-]{8,}={0,2})(?![A-Za-z0-9+/_=-])/g, (match, first, second) => {
    const result = inspectDecodedBase64(first + second, state, depth + 1);
    if (result === null) return match;
    findings.push(...result.findings);
    return result.findings.length ? REDACTION_MARKER : match;
  });
  redacted = redacted.replace(BASE64_TOKEN_RE, token => {
    const result = inspectDecodedBase64(token, state, depth + 1);
    if (result === null) return token; // not a canonical encoding: an ordinary word
    findings.push(...result.findings);
    return result.findings.length ? REDACTION_MARKER : token;
  });
  // A base64 value as a URL path segment is also an encoded representation,
  // not a URL to trust: the bare-token pass skips tokens preceded by '/'.
  // Only a segment whose decoding itself contains a secret form is
  // replaced; ordinary path segments are left untouched.
  redacted = redacted.replace(/(\bhttps?:\/\/[^\s"'<>]*\/)([A-Za-z0-9+/_-]{8,}={0,2})(?![A-Za-z0-9+/_=-])/g, (match, urlPrefix, token) => {
    const result = inspectDecodedBase64(token, state, depth + 1);
    if (result === null) return match;
    findings.push(...result.findings);
    return result.findings.length ? urlPrefix + REDACTION_MARKER : match;
  });
  return { findings, text: redacted };
}

// Finding objects never contain source text, keys, values or decoded payloads.
export function findSecretsInEvidence(text) {
  if (typeof text !== 'string') return [];
  return inspectEvidence(text, { nodes: 0, chars: 0 }).findings;
}

export function redactEvidence(text) {
  if (typeof text !== 'string') return text;
  return inspectEvidence(text, { nodes: 0, chars: 0 }).text;
}

// Evidence with every detected secret replaced by the fixed marker. The check
// passes on the returned text: the marker itself is not treated as a secret.
// Each replacement covers exactly the captured secret value's span, so a
// value that also appears in its own key or scheme is not mistaken for it.
function redactRawSecrets(text) {
  let redacted = text.replace(TOKEN_URL_RE, `$1${REDACTION_MARKER}`);
  redacted = redacted.replace(AUTH_HEADER_RE, `$1${REDACTION_MARKER}`);
  redacted = redacted.replace(JSON_AUTH_HEADER_RE, (match, value) =>
    `${match.slice(0, match.length - value.length - 1)}${REDACTION_MARKER}"`);
  redacted = redacted.replace(JSON_AUTH_HEADER_ESCAPED_RE, (match, value) =>
    `${match.slice(0, match.length - value.length - 2)}${REDACTION_MARKER}\\"`);
  redacted = redacted.replace(BEARER_RE, (match, value, offset, whole) => {
    const lineStart = whole.lastIndexOf('\n', offset) + 1;
    if (/authorization[ \t]*:[ \t]*$/i.test(whole.slice(lineStart, offset))) return match;
    return `${match.slice(0, match.length - value.length)}${REDACTION_MARKER}`;
  });
  redacted = redacted.replace(INVITATION_RE, (match, value) =>
    `${match.slice(0, match.length - value.length)}${REDACTION_MARKER}`);
  redacted = redacted.replace(SHORT_INVITE_RE, `$1${REDACTION_MARKER}`);
  redacted = redacted.replace(JOIN_HANDLER_RE, `$1${REDACTION_MARKER}`);
  return redacted;
}

// --- deep equality over plain JSON-shaped values ----------------------------

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function missingInput(issues, item) {
  issues.push({code: BLOCKED_CODES.MISSING_INPUT, item});
}

// --- the preservation check --------------------------------------------------
//
// Input (all plain objects collected by the driver; nothing is read here):
// {
//   install: { label: 'fresh-install' | 'reused-install',
//              destination: '<install root>', runOwned: true,
//              priorRunReceipt: '<receipt id>' | null },   // required for reused-install
//   runRoots: { appState: '<root>', install: '<root>', evidence: '<root>' },
//   writes: [{ path: '<written path>' }],
//   preferences: { before: { trayModels: [...], traySelections: {...} },
//                  after: { trayModels: [...], traySelections: {...} } },
//   channel: { before: '<channel identity>', after: '<channel identity>' },
//   expectedCloses: [{ kind: 'process' | 'forward', id: '<pid or forward id>' }],
//   closeReceipts: [{ kind: 'process' | 'forward', id: '<pid or forward id>',
//                     owned: true, closed: true }],
//   evidence: [{ name: '<artifact name>', text: '<artifact text>' }],
// }
//
// The complete input schema is validated before anything is compared: a
// missing, empty, malformed or partial required snapshot or receipt fails
// with missing_input instead of passing by equal emptiness. Only then are
// snapshots compared and receipt identities matched — by value and by type,
// so a numeric process id never matches a string id.
//
// `expectedCloses` lists the run-owned processes and forwards the run must
// close; every entry needs a matching close receipt. A receipt for a process
// the run does not own blocks, and a missing receipt blocks. The install
// destination must be run-owned. Every result is labelled fresh-install or
// reused-install; a reused-install label without an explicit prior run receipt
// is refused.
export function checkPreservation(input) {
  const issues = [];
  const result = (status, label) => ({status, label, issues});

  if (!isPlainObject(input)) {
    missingInput(issues, 'input');
    return result('failed', null);
  }

  // Install label: every result carries one; reused-install needs a receipt.
  const install = input.install;
  let label = null;
  if (!isPlainObject(install) || typeof install.label !== 'string' || !INSTALL_LABELS.includes(install.label)) {
    missingInput(issues, 'install.label');
  } else {
    label = install.label;
    if (label === 'reused-install' &&
        (typeof install.priorRunReceipt !== 'string' || !install.priorRunReceipt.trim())) {
      issues.push({code: BLOCKED_CODES.REUSED_INSTALL_WITHOUT_PRIOR_RECEIPT, item: 'install.priorRunReceipt'});
    }
  }

  // Install destination must be owned by this run, and must be an absolute path.
  if (!isPlainObject(install) || typeof install.destination !== 'string' || !install.destination) {
    missingInput(issues, 'install.destination');
  } else if (!isAbsolutePath(install.destination)) {
    missingInput(issues, 'install.destination');
  } else if (install.runOwned !== true) {
    issues.push({code: BLOCKED_CODES.INSTALL_DESTINATION_NOT_RUN_OWNED, item: 'install.destination'});
  }

  // Run-owned roots: every write must fall under app state, install or evidence.
  // Roots must be absolute paths; a relative or escaping root is failed input.
  const runRoots = input.runRoots;
  const roots = [];
  if (!isPlainObject(runRoots)) {
    missingInput(issues, 'runRoots');
  } else {
    for (const key of ['appState', 'install', 'evidence']) {
      if (typeof runRoots[key] !== 'string' || !runRoots[key]) missingInput(issues, `runRoots.${key}`);
      else if (!isAbsolutePath(runRoots[key])) missingInput(issues, `runRoots.${key}`);
      else roots.push(runRoots[key]);
    }
  }
  if (!Array.isArray(input.writes)) {
    missingInput(issues, 'writes');
  } else {
    input.writes.forEach((write, index) => {
      const writtenPath = isPlainObject(write) ? write.path : write;
      if (typeof writtenPath !== 'string' || !writtenPath) {
        missingInput(issues, `writes[${index}].path`);
        return;
      }
      if (!isAbsolutePath(writtenPath)) {
        missingInput(issues, `writes[${index}].path`);
        return;
      }
      if (roots.length && !roots.some(root => isUnderRoot(root, writtenPath))) {
        issues.push({code: BLOCKED_CODES.WRITE_OUTSIDE_RUN_ROOTS, item: `writes[${index}].path`});
      }
    });
  }

  // Structural validity is checked before comparison. Complete coverage also
  // requires the seven observed identities below; their actual names come only
  // from the trusted observer, never a guessed/hard-coded production list.
  function validateSnapshot(snapshot, item) {
    if (!isPlainObject(snapshot)) {
      missingInput(issues, item);
      return false;
    }
    let valid = true;
    const models = snapshot.trayModels;
    const modelsValid = Array.isArray(models) && models.length > 0 &&
      models.every(model => typeof model === 'string' && model.trim() !== '') &&
      new Set(models).size === models.length;
    if (!modelsValid) {
      missingInput(issues, `${item}.trayModels`);
      valid = false;
    }
    const selections = snapshot.traySelections;
    if (!isPlainObject(selections) ||
        Object.values(selections).some(value => typeof value !== 'string')) {
      missingInput(issues, `${item}.traySelections`);
      valid = false;
    } else if (modelsValid &&
        (models.some(model => !Object.prototype.hasOwnProperty.call(selections, model)) ||
         Object.keys(selections).some(key => !models.includes(key)))) {
      missingInput(issues, `${item}.traySelections`);
      valid = false;
    }
    return valid;
  }

  // Tray model list and selections must not change; channel identity neither.
  const preferences = input.preferences;
  if (!isPlainObject(preferences) || !isPlainObject(preferences.before) || !isPlainObject(preferences.after)) {
    missingInput(issues, 'preferences.before/after');
  } else {
    const {before, after} = preferences;
    const beforeValid = validateSnapshot(before, 'preferences.before');
    const afterValid = validateSnapshot(after, 'preferences.after');
    if (beforeValid && afterValid) {
      const modelsChanged = !deepEqual(before.trayModels, after.trayModels);
      if (modelsChanged) {
        issues.push({code: BLOCKED_CODES.TRAY_MODEL_LIST_CHANGED, item: 'preferences.trayModels'});
      }
      if (!deepEqual(before.traySelections, after.traySelections)) {
        issues.push({code: BLOCKED_CODES.TRAY_MODEL_SELECTION_CHANGED, item: 'preferences.traySelections'});
      }
      // Preserve the existing blocked mutation result (including adding or
      // removing a model). Equal internally consistent subsets/supersets are
      // instead missing observation, not evidence that all seven survived.
      // Either route refuses every run lacking exactly seven on both sides.
      if (!modelsChanged) {
        for (const [side, snapshot] of Object.entries({before, after})) {
          if (snapshot.trayModels.length !== 7) missingInput(issues, `preferences.${side}.trayModels`);
        }
      }
    }
  }
  const channel = input.channel;
  if (!isPlainObject(channel) ||
      typeof channel.before !== 'string' || !channel.before.trim() ||
      typeof channel.after !== 'string' || !channel.after.trim()) {
    missingInput(issues, 'channel.before/after');
  } else if (!deepEqual(channel.before, channel.after)) {
    issues.push({code: BLOCKED_CODES.CHANNEL_IDENTITY_CHANGED, item: 'channel'});
  }

  // Close receipts: only run-owned processes/forwards may be cleaned up, and
  // every expected close needs its receipt. Close kinds are 'process' (a
  // numeric pid) and 'forward' (a nonempty string id); identities match by
  // value and by type, so numeric 4242 never matches the string '4242'.
  // Every receipt must carry explicit boolean owned/closed fields, whether or
  // not an expected entry refers to it.
  function isCloseId(kind, id) {
    if (kind === 'process') return Number.isInteger(id) && id >= 0;
    if (kind === 'forward') return typeof id === 'string' && id.trim() !== '';
    return false;
  }
  function closeKey(kind, id) {
    return JSON.stringify([kind, typeof id, id]);
  }
  const expectedCloses = Array.isArray(input.expectedCloses) ? input.expectedCloses : null;
  const closeReceipts = Array.isArray(input.closeReceipts) ? input.closeReceipts : null;
  if (expectedCloses === null) missingInput(issues, 'expectedCloses');
  if (closeReceipts === null) missingInput(issues, 'closeReceipts');
  if (expectedCloses !== null && closeReceipts !== null) {
    const receiptByKey = new Map();
    closeReceipts.forEach((receipt, index) => {
      if (!isPlainObject(receipt) || (receipt.kind !== 'process' && receipt.kind !== 'forward') ||
          !isCloseId(receipt.kind, receipt.id)) {
        missingInput(issues, `closeReceipts[${index}]`);
        return;
      }
      if (typeof receipt.owned !== 'boolean') {
        missingInput(issues, `closeReceipts[${index}].owned`);
        return;
      }
      if (typeof receipt.closed !== 'boolean') {
        missingInput(issues, `closeReceipts[${index}].closed`);
        return;
      }
      if (receipt.owned !== true) {
        issues.push({code: BLOCKED_CODES.CLEANUP_UNOWNED_PROCESS,
          item: `closeReceipts[${index}]`});
      }
      receiptByKey.set(closeKey(receipt.kind, receipt.id), receipt);
    });
    expectedCloses.forEach((expected, index) => {
      if (!isPlainObject(expected) || (expected.kind !== 'process' && expected.kind !== 'forward') ||
          !isCloseId(expected.kind, expected.id)) {
        missingInput(issues, `expectedCloses[${index}]`);
        return;
      }
      const receipt = receiptByKey.get(closeKey(expected.kind, expected.id));
      if (!receipt || receipt.closed !== true) {
        issues.push({code: BLOCKED_CODES.MISSING_CLEANUP_RECEIPT, item: `expectedCloses[${index}]`});
      }
    });
  }

  // Evidence text must carry no raw secrets; the redacted form must pass.
  if (!Array.isArray(input.evidence)) {
    missingInput(issues, 'evidence');
  } else {
    input.evidence.forEach((artifact, index) => {
      if (!isPlainObject(artifact) || typeof artifact.name !== 'string' || typeof artifact.text !== 'string') {
        missingInput(issues, `evidence[${index}]`);
        return;
      }
      for (const finding of findSecretsInEvidence(artifact.text)) {
        issues.push({code: finding.code, item: `evidence[${index}]`});
      }
    });
  }

  if (issues.some(issue => issue.code === BLOCKED_CODES.MISSING_INPUT)) return result('failed', label);
  if (issues.length) return result('blocked', label);
  return result('pass', label);
}
