/**
 * GitHub device login for task access. Unlike provider capacity sign-in, this
 * keeps a private provider source and publishes an immutable copy of its token.
 * Each GitHub job's sandbox gets that copy as a sandbox-scoped sbx secret; the
 * task receives a proxy-managed GH_TOKEN sentinel through the stable GitHub kit
 * and never receives the real token or the user's gh config.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sanitizedEnv, sbxChildEnv } from './docker-backend.mjs';
import { acquireCredentialMutation, spawnCredentialWriter } from './sandbox-credentials.mjs';
import { createGitHubSource, currentGitHubGeneration, publishGitHubGeneration } from './credential-generations.mjs';

export class GitHubAuthError extends Error {}

function githubEnv(baseEnv = process.env, faravanHome = sbxChildEnv().HOME, sourceId) {
  const env = sanitizedEnv(baseEnv);
  env.HOME = faravanHome;
  // gh honors GH_CONFIG_DIR. Keeping it below Faravan's sbx identity makes
  // the isolation explicit and prevents any read of ~/.config/gh.
  env.GH_CONFIG_DIR = path.join(faravanHome, '.gh-task-access-'+sourceId);
  return env;
}

async function spawnCapture(command, args, { env, input, writerHome, isolation, timeoutMs = 10000 } = {}) {
  const child = writerHome ? await spawnCredentialWriter(writerHome, command, args, {env,
    ...(isolation ? {credentialIsolation:isolation} : {})}) : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve, reject) => {
    let settled=false;
    const finish=(code,error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      child.stdout.destroy();child.stderr.destroy();
      if(error)reject(error);else resolve({code,stdout,stderr});
    };
    const stop=()=>{try{writerHome?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');}catch{};finish(-1);};
    const timer=setTimeout(stop,timeoutMs);
    const capture=stream=>chunk=>{
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+chunk.length>262144){stop();return;}
      if(stream==='stdout')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');
    };
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));
    child.once('error',error=>finish(-1,error));
    child.once('exit',code=>finish(code));
  });
  child.stdin.on('error',()=>{});
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  return { child, done, output: () => `${stdout}\n${stderr}` };
}

/** Starts the real default gh device flow and returns its capturable code/URL. */
export async function startGitHubAuthFlow({ ghBin = 'gh', env = process.env, faravanHome = sbxChildEnv().HOME, urlTimeoutMs = 75_000, leaseWaitMs = 90_000, onHandle } = {}) {
  const source={id:randomUUID(),ghBin,pathEnv:env.PATH || process.env.PATH || ''};
  const childEnv = githubEnv(env, faravanHome, source.id);
  const releaseCredentials = await acquireCredentialMutation(faravanHome,{isolatedSources:true,leaseWaitMs});
  // Avoid the OS credential keychain: gh's default keychain namespace is
  // user-wide, while this flow must never read or write the personal gh
  // account. Successful sources stay private for later digest comparisons.
  let login;
  try {
    await createGitHubSource(faravanHome,source);
    login = await spawnCapture(ghBin, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key', '--insecure-storage'], { env: childEnv, writerHome: faravanHome, timeoutMs:300000,isolation:{kind:'github-source',id:source.id} });
  }
  catch (error) { await releaseCredentials(); throw error; }
  let completing = false;
  const publication=new AbortController();
  const cleanConfig = async () => {
    if (handle.status!=='complete') await rm(childEnv.GH_CONFIG_DIR, { recursive: true, force: true }).catch(() => {});
    await releaseCredentials();
  };
  const handle = {
    harness_id: 'gh-cli',
    status: 'pending',
    url: undefined,
    code: undefined,
    cancel() {
      handle.status = 'cancelled';
      publication.abort();
      try { login.child.kill('SIGTERM'); } catch {}
      // The CLI may still be flushing its insecure on-disk config when it
      // receives SIGTERM, so defer removal until it has actually exited.
      if (!completing) void login.done.then(cleanConfig,cleanConfig).catch(()=>{});
    },
    waitForCompletion: undefined,
  };
  onHandle?.(handle);

  const device = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GitHubAuthError(`timed out after ${urlTimeoutMs}ms waiting for GitHub's device code`)), urlTimeoutMs);
    const inspect = () => {
      const output = login.output();
      const url = /(https:\/\/github\.com\/login\/device)/.exec(output)?.[1];
      const code = /one-time code:\s*([A-Z0-9-]+)/i.exec(output)?.[1];
      if (url && code) { clearTimeout(timer); resolve({ url, code }); }
    };
    login.child.stdout.on('data', inspect);
    login.child.stderr.on('data', inspect);
    inspect();
    login.done.then((result) => {
      inspect();
      if (!handle.url && result.code !== 0) { clearTimeout(timer); reject(new GitHubAuthError(`GitHub sign-in exited ${result.code}.`)); }
    }).catch(reject);
  }).catch(async (error) => {
    handle.cancel();
    await login.done.catch(() => {});
    await cleanConfig();
    throw error;
  });

  handle.url = device.url;
  handle.code = device.code;
  handle.status = 'awaiting-browser';
  let completion;
  handle.waitForCompletion = () => completion ??= finish();
  async function finish() {
    completing = true;
    try {
      const result = await login.done;
      if (handle.status === 'cancelled') return { status: 'failed', detail: 'cancelled before completion' };
      if (result.code !== 0) return { status: 'failed', detail: `GitHub sign-in exited ${result.code}.` };
      const tokenRead = await spawnCapture(ghBin, ['auth', 'token', '--hostname', 'github.com'], { env: childEnv });
      const token = await tokenRead.done;
      if (token.code !== 0 || !token.stdout.trim()) return { status: 'failed', detail: 'GitHub sign-in completed, but Faravan could not securely store task access.' };
      // Token flows only from gh stdout into a private generation file. Do not
      // put it in argv, environment, a log, or this returned object.
      await publishGitHubGeneration(faravanHome,source,token.stdout.trim(),{signal:publication.signal});
      handle.status = 'complete';
      return { status: 'complete', detail: 'GitHub task access is ready.' };
    } catch(error) {
      if(handle.status==='cancelled')return {status:'failed',detail:'cancelled before completion'};
      throw error;
    } finally {
      await cleanConfig();
    }
  }
  return handle;
}

// Caller holds credential-changes.lock. Provider reads happen even when this
// preparation does not request GitHub, so a refresh records late source changes.
export async function refreshGitHubGeneration(home) {
  const current=await currentGitHubGeneration(home);
  if(!current)return null;
  const env=githubEnv({PATH:current.source.pathEnv},home,current.source.id);
  try {
    const reader=await spawnCapture(current.source.ghBin,['auth','token','--hostname','github.com'],{env});
    const token=await reader.done;
    if(token.code!==0 || !token.stdout.trim())throw new GitHubAuthError('GitHub task access could not be read.');
    return await publishGitHubGeneration(home,current.source,token.stdout.trim());
  }catch{throw Object.assign(new GitHubAuthError('GitHub task access could not be read or published.'),{code:'credential_writer_unresolved'});}
}
