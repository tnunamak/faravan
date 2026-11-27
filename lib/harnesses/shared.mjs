export function nullableUsage(inputTokens, outputTokens) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

export function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function capacityKindForStrategy(harness) {
  switch (harness.auth_strategy) {
    case 'docker-native-oauth':
    case 'provider-file-generation': return 'subscription';
    case 'guest-env-api-key':
    case 'docker-stored-secret':
    case 'host-file-proxy': return 'api_key';
    case 'host-env-proxy': return 'local';
    case 'host-auth-adapter-required': return 'gateway';
    case 'unsupported': return 'local';
    default: throw new Error(`unknown harness auth strategy: ${harness.auth_strategy}`);
  }
}


// A failed agent run whose output clearly says the sandbox's sign-in is gone. Conservative on purpose:
// a successful run never counts, and only the tail is read because an auth failure ends the run
// (earlier text is usually the agent's own work, e.g. test output that mentions a 401).
const AUTH_TAIL_BYTES = 8192;
const AUTH_WORDING = /\b(?:token|auth(?:entication|orization)?|sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|credentials?|api[ _-]?key)\b/;
const AUTH_FAILURES = [
  /authentication_error/,
  /invalid api key/,
  /please run \/login/,
  /not logged in/,
  /sign(?:ing)? in again/,
  /token (?:has |is )?expired/,
];
export function agentAuthFailure({ stdout, stderr, exitCode } = {}) {
  // null means the process produced no exit code (killed): also not a usable result. undefined means unknown.
  if (exitCode !== null && !(Number.isInteger(exitCode) && exitCode !== 0)) return false;
  const tail = (value) => typeof value === 'string' ? value.slice(-AUTH_TAIL_BYTES).toLowerCase() : '';
  const text = tail(stdout) + '\n' + tail(stderr);
  if (AUTH_FAILURES.some((pattern) => pattern.test(text))) return true;
  return /\b401\b|\bunauthorized\b/.test(text) && AUTH_WORDING.test(text);
}

export const unknownResult = () => ({ model: null, usage: null });
