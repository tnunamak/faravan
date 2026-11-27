/**
 * The harness registry. To add a harness, add one source-controlled
 * <id>.adapter.mjs module beside this file and one import line below.
 * Each module owns its spec, output parsing, status probe and capacity kind.
 * The list is explicit (no directory scan) so the set of code that can run
 * is visible here and static analysis and bundlers can see it.
 */
import { validateHarnessSpec } from '../harness-spec.mjs';
import { capacityKindForStrategy, unknownResult } from './shared.mjs';
import * as claudeCodeApiKey from './claude-code-api-key.adapter.mjs';
import * as claudeCodeSubscription from './claude-code-subscription.adapter.mjs';
import * as codex from './codex.adapter.mjs';
import * as gemini from './gemini.adapter.mjs';
import * as ghCli from './gh-cli.adapter.mjs';
import * as opencode from './opencode.adapter.mjs';
import * as pi from './pi.adapter.mjs';

const modules = [claudeCodeApiKey, claudeCodeSubscription, codex, gemini, ghCli, opencode, pi];
const ids = new Set();
for (const adapter of modules) {
  validateHarnessSpec(adapter.spec);
  if (adapter.lendingSpec) validateHarnessSpec(adapter.lendingSpec);
  if (ids.has(adapter.spec.harness_id)) throw new Error(`duplicate harness: ${adapter.spec.harness_id}`);
  ids.add(adapter.spec.harness_id);
  for (const method of ['parseExecutionResult', 'parseProviderAccount', 'statusProbeCommand', 'capacityKind', 'jobCommand']) {
    if (typeof adapter[method] !== 'function') throw new Error(`harness ${adapter.spec.harness_id} missing ${method}`);
  }
}
export const HARNESS_ADAPTERS = Object.freeze(modules.sort((a, b) =>
  (a.registrationOrder ?? 1000) - (b.registrationOrder ?? 1000) || a.spec.harness_id.localeCompare(b.spec.harness_id)));
const byId = new Map(HARNESS_ADAPTERS.map((adapter) => [adapter.spec.harness_id, adapter]));
export const DEFAULT_IDENTITY_PROBE_HARNESSES = Object.freeze(
  HARNESS_ADAPTERS.filter((adapter) => adapter.defaultIdentityProbe).map((adapter) => adapter.spec.harness_id));
const unknownAdapter = Object.freeze({
  parseExecutionResult: unknownResult, parseProviderAccount: () => null,
  statusProbeCommand: () => null, capacityKind: capacityKindForStrategy,
});
export function getHarnessAdapter(id) { return byId.get(id) || null; }
// Historical parser/probe helpers accepted unknown ids; resolve remains strict.
export function adapterFor(id) { return getHarnessAdapter(id) || unknownAdapter; }
export function resolveHarness(name) {
  const adapter = getHarnessAdapter(name);
  if (!adapter) throw new Error(`unknown --harness "${name}" — must be one of: ${[...byId.keys()].join(', ')}`);
  return { ...adapter.spec, image: adapter.spec.install };
}

/** Status-only commands. Never use the execution entrypoint or a login command. */
export function identityProbeCommand(id) {
  const adapter=getHarnessAdapter(id);
  if(!adapter)return null;
  const binary=({'claude-code-api-key':'claude','claude-code-subscription':'claude',
    codex:'codex',gemini:'gemini','gh-cli':'gh',opencode:'opencode'})[id];
  if(!binary)return null;
  const status=id==='codex'?'if [ -n "$FARAVAN_CREDENTIAL_GENERATION" ]; then codex login status; else printf "SBX_CRED_OPENAI_MODE=%s\\n" "$SBX_CRED_OPENAI_MODE"; fi':
    id==='gemini'?'printf "SBX_CRED_GOOGLE_MODE=%s\\n" "$SBX_CRED_GOOGLE_MODE"':
    id==='claude-code-api-key'?'printf "SBX_CRED_ANTHROPIC_MODE=%s\\n" "$SBX_CRED_ANTHROPIC_MODE"':
    adapter.statusProbeCommand();
  if(!status)return null;
  return 'if command -v '+binary+' >/dev/null 2>&1; then printf "FARAVAN_INSTALLED=1\\n"; ('+
    status+') 2>&1; else printf "FARAVAN_INSTALLED=0\\n"; fi; true';
}

/** Missing/unrecognized status is unknown, not a failed login or an account.
 * `subscription` asks whether the credential is a subscription sign-in: a metered API key is not. */
export function parseIdentityEvidence(id,stdout,{subscription=false}={}) {
  const text=String(stdout??''),markers=[...text.matchAll(/^FARAVAN_INSTALLED=([01])$/gm)];
  if(markers.length!==1)return {installed:null,signedIn:null,account:null};
  if(markers[0][1]==='0')return {installed:false,signedIn:null,account:null};
  const body=text.replace(/^FARAVAN_INSTALLED=1\r?\n/m,'');
  let signedIn=null,account=null;
  if(id==='claude-code-api-key'||id==='gemini'||id==='codex') {
    const key=id==='gemini'?'GOOGLE':id==='codex'?'OPENAI':'ANTHROPIC';
    const mode=new RegExp('^SBX_CRED_'+key+'_MODE=(apikey|oauth|none)$','m').exec(body)?.[1];
    if(mode)signedIn=subscription&&id==='codex'?mode==='oauth':mode==='apikey'||(['gemini','codex'].includes(id)&&mode==='oauth');
    if(id==='codex' && !mode) {
      if(/logged in using chatgpt/i.test(body))signedIn=true;
      else if(/not logged in/i.test(body))signedIn=false;
    }

  } else if(id==='claude-code-subscription') {
    signedIn=claudeCodeSubscription.subscriptionSignedIn(body);
  } else if(id==='gh-cli') {
    if(/logged in to/i.test(body))signedIn=true;
    else if(/not logged into any/i.test(body))signedIn=false;
  }
  // OpenCode lists credential configuration; that is not authentication proof.
  if(signedIn===true)account=getHarnessAdapter(id).parseProviderAccount(body);
  return {installed:true,signedIn,account};
}
