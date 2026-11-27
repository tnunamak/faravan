import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, rmSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {durableJson} from '../durable-write.mjs';
import {readJsonState, StateUnknownError} from './state-read.mjs';

// Which local session logs belong to the account this computer lends. A provider meter counts one account. A local log
// prices use of the account its folder was signed in to, which can be another account (Claude Code keeps one account per
// config folder). Only a folder whose signed-in account equals the pinned lent account may price that meter. Its use
// counts from `since`: the first time this app saw that folder on that account and plan tier. Older use in the folder may
// belong to an earlier sign-in or plan, so it never counts. The file keeps only 16-hex hashes of folder paths, accounts and
// plan tiers. A plan tier hash names one of a few known tiers, so it hides the tier only from a casual reader.
// A folder set up to pay by API key (an API key, key helper or cloud provider in its settings.json or settings.local.json)
// is on no lent account: its use did not move the plan's meter, and counting its cost would make the measured rate too low.
// Faravan cannot see a key set only in a shell environment or in a project's own settings. Its own process environment is
// not checked: it says nothing about how the logged runs were paid, and would drop every folder for a developer who
// exports a key in the shell that started Faravan.

const FILE = 'lending-log-attribution.json';
const HASH16 = /^[0-9a-f]{16}$/;
const hx = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex').slice(0, 16);
// Folder paths keep their case: on a case-sensitive file system `.claude-A` and `.claude-a` are different folders.
const hp = path => createHash('sha256').update(String(path)).digest('hex').slice(0, 16);
/** The 16-hex hash this store keeps for an account id. */
export const accountHash = hx;
const API_KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const CLOUD_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
// A funding or identity file is absent (undefined, as an account that was never signed in) or read. One that exists but cannot
// be read is an unknown funding fact: it throws UNREADABLE so the folder is on no lent account instead of a subscription one.
const UNREADABLE = Symbol('unreadable');
const readJson = path => {
  const result = readJsonState(path);
  if (result.state === 'unknown') throw UNREADABLE;
  return result.state === 'present' ? result.value : undefined;
};
const isDir = path => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
// A cloud-provider flag set to 0, false or nothing is off.
const flagOn = value => { const v = text(value)?.toLowerCase(); return v != null && v !== '0' && v !== 'false'; };
// True when a settings `env` block pays by API key or cloud provider.
const paysByKey = env => Boolean(env) && (API_KEY_ENV.some(key => text(env[key])) || CLOUD_ENV.some(key => flagOn(env[key])));

// A folder's account and plan tier. Null when the folder names no account, its account files disagree, or it pays by API key.
function claudeAccount(files, settingsFiles) {
  try { return claudeAccountKnown(files, settingsFiles); } catch (error) { if (error === UNREADABLE) return null; throw error; }
}
function claudeAccountKnown(files, settingsFiles) {
  const read = files.map(readJson).filter(Boolean), settings = settingsFiles.map(readJson);
  if (read.some(file => text(file.primaryApiKey) || (Array.isArray(file.customApiKeyResponses?.approved) &&
      file.customApiKeyResponses.approved.length > 0)) || settings.some(s => text(s?.apiKeyHelper) || paysByKey(s?.env))) return null;
  const accounts = read.map(file => file.oauthAccount).filter(Boolean);
  const ids = new Set(accounts.map(a => text(a.accountUuid)).filter(Boolean));
  if (ids.size !== 1) return null;
  const tiers = new Set(accounts.map(a => JSON.stringify(['organizationRateLimitTier', 'userRateLimitTier', 'seatTier',
    'billingType'].map(key => text(a[key])))));
  if (tiers.size !== 1) return null;
  return {account_sha256_16:hx([...ids][0]), fingerprint:hx([...tiers][0])};
}

function codexAccount(file) {
  let auth;
  try { auth = readJson(file); } catch (error) { if (error === UNREADABLE) return null; throw error; }
  if (text(auth?.OPENAI_API_KEY) || (auth?.auth_mode != null && auth.auth_mode !== 'chatgpt')) return null;
  const tokens = auth?.tokens;
  const id = text(tokens?.account_id);
  if (!id) return null;
  let plan = null;
  try {
    const payload = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8'));
    plan = text(payload?.['https://api.openai.com/auth']?.chatgpt_plan_type);
  } catch {}
  return {account_sha256_16:hx(id), fingerprint:hx(JSON.stringify([plan]))};
}

/** The local log folders of each provider and the account each is signed in to. Reads no log. The two default folders
 * are always listed, as the log reader has always read them; other folders are listed only when they are real folders. */
export function localLogRoots(homeDir, {env = process.env} = {}) {
  if (typeof homeDir !== 'string' || !isAbsolute(homeDir)) throw new TypeError('homeDir must be absolute');
  const claudeDefault = join(homeDir, '.claude'), codexDefault = join(homeDir, '.codex');
  const claudeDirs = new Set([claudeDefault]), codexDirs = new Set([codexDefault]);
  if (isAbsolute(env.CLAUDE_CONFIG_DIR ?? '')) claudeDirs.add(resolve(env.CLAUDE_CONFIG_DIR));
  if (isAbsolute(env.CODEX_HOME ?? '')) codexDirs.add(resolve(env.CODEX_HOME));
  let names = [];
  try { names = readdirSync(homeDir); } catch {}
  for (const name of names) if (name.startsWith('.claude-')) claudeDirs.add(join(homeDir, name));
  const roots = [];
  for (const dir of claudeDirs) {
    const isDefault = dir === claudeDefault;
    if (!isDefault && !isDir(dir)) continue;
    // Claude Code keeps the default folder's account in ~/.claude.json and any other folder's in <folder>/.claude.json.
    const files = [join(dir, '.claude.json'), ...(isDefault ? [join(homeDir, '.claude.json')] : [])];
    roots.push({provider:'claude', path:join(dir, 'projects'), default:isDefault, ...claudeAccount(files,
      [join(dir, 'settings.json'), join(dir, 'settings.local.json')])});
  }
  for (const dir of codexDirs) {
    const isDefault = dir === codexDefault;
    if (!isDefault && !isDir(dir)) continue;
    roots.push({provider:'codex', path:join(dir, 'sessions'), default:isDefault, ...codexAccount(join(dir, 'auth.json'))});
  }
  return roots.map(root => ({account_sha256_16:null, fingerprint:null, ...root}));
}

/**
 * The durable attribution of local log folders to the lent account. `update` keeps `since` while a folder stays on the
 * same account and tier, and restarts it on any change. `current` is the provider's attribution, or null when no folder
 * is on the pinned account or folders on it disagree about its tier.
 */
export function createLogAttributionStore({directory, now = Date.now}) {
  const path = join(directory, FILE);
  const fresh = () => ({version:1, roots:{}, providers:{}});
  // Absent starts empty. A file that exists but cannot be read, parsed or checked is unknown: update refuses to replace it.
  const read = () => {
    const result = readJsonState(path);
    if (result.state === 'absent') return {saved:fresh(), unknown:null};
    const saved = result.value;
    if (result.state === 'present' && saved?.version === 1 && saved.roots && typeof saved.roots === 'object' && !Array.isArray(saved.roots))
      return {saved, unknown:null};
    return {saved:fresh(), unknown:result.error ?? new Error('unexpected shape')};
  };
  const valid = row => HASH16.test(row?.account_sha256_16 ?? '') && HASH16.test(row?.fingerprint ?? '') && Number.isSafeInteger(row?.since);
  return {
    /** Record the folders now on disk against the pins. Returns the folders to read and each provider's attribution. */
    update(found, pins) {
      const {saved, unknown} = read();
      if (unknown) throw new StateUnknownError(path, unknown);
      const at = now(), next = {version:1, roots:{}, providers:{}};
      const out = [];
      for (const root of found) {
        // With no lent account known yet (before the first reading after a restart), keep the last one recorded.
        const pin = pins?.[root.provider]?.account_sha256_16 ?? saved.providers?.[root.provider]?.account_sha256_16;
        if (!HASH16.test(pin ?? '') || root.account_sha256_16 !== pin || !HASH16.test(root.fingerprint ?? '')) {
          out.push({...root, since:null});
          continue;
        }
        const key = hp(root.path), prior = saved.roots[key];
        const since = valid(prior) && prior.account_sha256_16 === root.account_sha256_16 && prior.fingerprint === root.fingerprint
          ? prior.since : at;
        next.roots[key] = {provider:root.provider, account_sha256_16:root.account_sha256_16, fingerprint:root.fingerprint, since};
        out.push({...root, since});
      }
      for (const provider of ['claude', 'codex']) {
        const matched = out.filter(root => root.provider === provider && root.since !== null);
        const tiers = new Set(matched.map(root => root.fingerprint));
        if (matched.length === 0 || tiers.size !== 1) continue;
        // One provider-wide start: a measurement made before any matched folder's latest change is not kept.
        next.providers[provider] = {account_sha256_16:matched[0].account_sha256_16, fingerprint:matched[0].fingerprint,
          since:Math.max(...matched.map(root => root.since))};
      }
      durableJson(path, next);
      // Read the default folders (they also feed weekly scoring) and any other folder on the lent account (measure only).
      const roots = out.map(root => ({...root, since:next.providers[root.provider] ? root.since : null, scoring:root.default === true}))
        .filter(root => root.scoring || root.since !== null);
      return {roots, providers:next.providers};
    },
    /** Forget every attribution, as when the owner turns off learning from local logs. */
    clear() { rmSync(path, {force:true}); },
    current(provider) {
      const row = read().saved.providers?.[provider];
      return valid(row) ? {account_sha256_16:row.account_sha256_16, since:row.since} : null;
    },
  };
}

const boundTo = (measured, current) => Number.isSafeInteger(measured?.upper_micro) && measured.upper_micro > 0 && current &&
  measured.binding?.account_sha256_16 === current.account_sha256_16 && measured.binding?.since === current.since;

/** A saved measurement, if it was made on the provider's current attribution (same account, same start) and has not
 * expired; else null. A measurement saved with no expiry is missing. */
export function measurementFor(measured, current, now = Date.now()) {
  return boundTo(measured, current) && Number.isFinite(measured.expires_at) && measured.expires_at > now ? measured : null;
}

/** True when the provider's current attribution has a measurement that is dated and has expired. An undated one is missing,
 * not expired. With `accountId` (the verified account), another account's measurement is not this account's. */
export function measurementExpired(measured, current, now = Date.now(), accountId = undefined) {
  return Boolean(boundTo(measured, current)) && (accountId === undefined || measured.binding.account_sha256_16 === accountId) &&
    Number.isFinite(measured.expires_at) && measured.expires_at <= now;
}
