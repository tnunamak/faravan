/**
 * The Claude sign-in a lent job runs on. A Claude agent has one sign-in: Faravan's own (the published generation in the usage
 * store). A lent job gets that sign-in's current ACCESS token, pushed into its own sandbox; the refresh token never leaves the
 * store, so only Faravan rotates it.
 *
 * `lease` is called before each lent start. If the access token would expire before the job's wall time (plus the sandbox's
 * deadline grace) ends, it is refreshed first. A token that still cannot outlive the job is refused: a job never starts on a
 * credential that dies mid-run, and nothing falls back to another sign-in.
 */
import {SANDBOX_DEADLINE_GRACE_MS} from '../sandbox-deadline.mjs';
import {parseCredentialListing} from '../sandbox-credentials.mjs';

/** The agents whose lending sign-in is Faravan's own (the store key each one reads). */
export const FARAVAN_SIGNIN_AGENT = 'claude-code-subscription';
export const FARAVAN_SIGNIN_PROVIDERS = Object.freeze({[FARAVAN_SIGNIN_AGENT]: 'claude', codex: 'codex'});
const PROVIDER_NAMES = {claude: 'Claude', codex: 'Codex'};

const failure = (code, message) => Object.assign(new Error(message), {code});

export function createLentClaudeCredential({store, refresher, now = Date.now, onOutcome = () => {}, provider = 'claude'} = {}) {
  const name = PROVIDER_NAMES[provider];
  const read = async () => {
    try { return await store.credential(provider); }
    catch (error) {
      throw error?.reason === 'not_signed_in'
        ? failure('agent_signed_out', name + ' is not signed in to Faravan.')
        : failure('claude_account_unavailable', 'The ' + name + ' sign-in could not be read.');
    }
  };
  // `report: false` is for an owner's own job: it renews the same sign-in, but its outcome is not a lending fault.
  const lease = async ({wallSeconds, report = true} = {}) => {
    try {
      if (!Number.isFinite(wallSeconds) || wallSeconds <= 0) throw failure('claude_account_unavailable', 'The job has no run time.');
      const needsUntil = () => now() + wallSeconds * 1000 + SANDBOX_DEADLINE_GRACE_MS;
      let cred = await read();
      if (cred.kind !== 'oauth' || typeof cred.bearer !== 'string' || !cred.bearer) throw failure('claude_account_unavailable', 'The ' + name + ' sign-in has no access token.');
      if (!(cred.expiresAt >= needsUntil())) {
        const outcome = await refresher.refresh(provider, {force: true}).catch(() => ({ok: false}));
        if (!outcome?.ok) throw failure('claude_account_unavailable', 'The ' + name + ' sign-in could not be refreshed.');
        cred = await read();
      }
      if (!(cred.expiresAt >= needsUntil())) throw failure('claude_account_unavailable', 'The ' + name + ' sign-in would expire before the job ends.');
      return {value: cred.bearer, generation: cred.generation, digest: cred.digest, expiresAt: cred.expiresAt,
        lifetimeSeconds: Math.max(0, Math.floor((cred.expiresAt - now()) / 1000))};
    } catch (error) { if (report) onOutcome(error?.code ?? 'claude_account_unavailable'); throw error; }
  };
  // The push into the sandbox reports through the same channel, so a failed or refused push shows as one blocker.
  return {lease, report: code => onOutcome(code ?? null)};
}

/**
 * A lent Codex job runs on the same sign-in. Its ACCESS token goes to the sandbox through the built-in `openai` service, scoped
 * to that sandbox (a scoped value wins over the computer's global login). No refresh token, no auth file, no custom kit.
 */
export const createLentCodexCredential = options => createLentClaudeCredential({...options, provider: 'codex'});

const scopedFailure = () => Object.assign(new Error('The Codex sign-in could not be given to the sandbox.'), {code: 'claude_account_unavailable'});
/** Stores the value for this sandbox only and proves the scoped row exists; without it the global login would answer. */
export async function assignLentOpenAI(run, sandboxId, value) {
  let result;
  try { result = await run(['secret', 'set', 'openai', '--sandbox', sandboxId, '--force'], {input: value}); } catch { throw scopedFailure(); }
  if (result.code !== 0) throw scopedFailure();
  const listing = parseCredentialListing(await run(['secret', 'ls', '--json', '--sandbox', sandboxId]));
  if (listing.secrets.filter(row => row.name === 'openai' && row.scope === sandboxId && row.type === 'service').length !== 1) throw scopedFailure();
}
