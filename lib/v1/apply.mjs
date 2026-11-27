// `faravan apply <job>`: put a verified diff candidate on a NEW branch of the
// repository in the current directory. The branch is built with git plumbing on
// a temporary index, so the current branch, HEAD, the real index and every
// working-tree file (including uncommitted changes) are never touched and no
// hook runs. The patch is untrusted bytes from another computer.
import { addedImagePreviews } from '../result-images.mjs';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { UsageError } from './cli.mjs';
import { openDevice } from './device.mjs';
import { applyOwner, applyOwnerGone, recoverApplyHeadLock } from './apply-head-lock.mjs';
import { parseUnifiedDiff, patchHazards, unsafePatchPath, unsafeSymlinkTarget, PatchError } from '../git-candidate.mjs';
import { acquirePreviewLock, previewGuard, recordTransaction, recoverPreviewLock } from './preview-lock.mjs';

export class ApplyError extends Error {
  constructor(code, message) { super(message); this.name = 'ApplyError'; this.code = code; }
}
const refuse = (code, message) => { throw new ApplyError(code, message); };
const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^(?:sha256:)?([0-9a-f]{64})$/;
const USAGE = 'Usage: faravan apply JOB-ID [--branch NAME] [--dry-run] [--circle CIRCLE]';
const previewSecret = randomBytes(32);

function resultHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function previewToken(binding) {
  const payload = Buffer.from(JSON.stringify(binding)).toString('base64url');
  const signature = createHmac('sha256', previewSecret).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function readPreviewToken(token) {
  if (typeof token !== 'string') refuse('preview_required', 'Review this branch preview again before adding it.');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) refuse('preview_changed', 'This branch preview is invalid. Review it again before adding the branch.');
  const expected = createHmac('sha256', previewSecret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) refuse('preview_changed', 'This branch preview is invalid. Review it again before adding the branch.');
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { refuse('preview_changed', 'This branch preview is invalid. Review it again before adding the branch.'); }
}
function bindingForPreview(preview, circle) {
  return { version: 1, repo: preview.repo, head: preview.head, current_branch: preview.current_branch, current_ref: preview.current_ref,
    branch: preview.branch, job_digest: preview.job_digest, circle: circle ?? null, base: preview.base,
    patch_hash: preview.patch_hash };
}

async function circleForJob(device, circle, digest) {
  if (circle) return device.selectCircle(circle);
  for (const candidate of await device.listCircles()) {
    if (await device.intentStore(candidate.id).get('job:' + digest)) return candidate;
  }
  return device.selectCircle();
}

// Only an intent saved before publication can identify a lost acknowledgement.
// A same-name branch, or even the same tree in another commit, is not that proof.
async function publishedApply(intent) {
  if (intent?.kind !== 'apply' || intent.version !== 1) return null;
  const result = intent.result;
  if (!result || !DIGEST.test(result.job_digest ?? '') || !HEX.test(result.base ?? '') ||
      !HEX.test(result.commit ?? '') || !HEX.test(intent.tree ?? '') ||
      typeof result.repo !== 'string' || !isAbsolute(result.repo) ||
      typeof result.branch !== 'string' || intent.ref !== 'refs/heads/' + result.branch ||
      typeof result.at !== 'string' || !Number.isFinite(Date.parse(result.at))) return null;
  try {
    const cwd = await realpath(result.repo);
    if (cwd !== result.repo || (await git(['check-ref-format', intent.ref], { cwd })).code !== 0) return null;
    const top = await git(['rev-parse', '--show-toplevel'], { cwd });
    if (top.code !== 0 || await realpath(text(top)) !== cwd) return null;
    if ((await git(['symbolic-ref', '--quiet', intent.ref], { cwd })).code === 0) return null;
    const ref = await git(['show-ref', '--verify', '--hash', intent.ref], { cwd });
    if (ref.code !== 0 || text(ref) !== result.commit) return null;
    const commit = await git(['--no-replace-objects', 'cat-file', 'commit', result.commit], { cwd });
    const headers = text(commit).split('\n\n', 1)[0].split('\n');
    if (commit.code !== 0 || headers[0] !== 'tree ' + intent.tree ||
        headers.filter(line => line.startsWith('parent ')).join('\n') !== 'parent ' + result.base) return null;
    return { ...result, status: 'applied' };
  } catch { return null; } // Unavailable repositories retain their recovery evidence.
}

async function matchingPublished(intents, circle, digest, cwd, name) {
  for (const intent of await intents.list()) {
    if (intent?.circle !== circle || intent.result?.job_digest !== digest ||
        intent.result?.repo !== cwd || intent.result?.branch !== name) continue;
    const applied = await publishedApply(intent);
    if (applied) return applied;
  }
  return null;
}

async function retireUnpublished(intents, circle, result, ownCommit = null, removeAbandoned = false) {
  for (const intent of await intents.list()) {
    if (intent?.kind !== 'apply' || intent.circle !== circle || intent.result?.job_digest !== result.job_digest ||
        intent.result?.repo !== result.repo || intent.result?.branch !== result.branch || intent.result?.commit === result.commit) continue;
    // An in-flight candidate may still publish if the branch is removed. Keep
    // its proof unless this caller has stopped it or its guarded owner is gone.
    if (intent.result.commit !== ownCommit && !(removeAbandoned && intent.guarded && applyOwnerGone(intent.owner))) continue;
    const key = 'apply:' + resultHash(JSON.stringify([result.repo, intent.ref, intent.result.commit]));
    await intents.delete(key);
  }
}

async function recoverOwnedLock(path) {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isSymbolicLink()) return recoverPreviewLock(path);
  await recoverApplyHeadLock(path.slice(0, -'.lock'.length));
  if (await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))
    throw Object.assign(new Error(`Git lock ${path} is occupied or its owner is unknown.`), {code:'preview_lock_blocked'});
}

async function recoverApplyLocks(cwd, result) {
  const common = await git(['rev-parse', '--git-common-dir'], { cwd });
  if (common.code !== 0) return;
  const guard = await previewGuard(resolve(cwd, text(common)));
  try {
    const head = await git(['rev-parse', '--git-path', 'HEAD'], { cwd });
    if (head.code === 0) await recoverOwnedLock(resolve(cwd, text(head)) + '.lock').catch(() => {});
    const ref = result?.current_ref;
    if (typeof ref !== 'string' || !ref.startsWith('refs/') ||
        (await git(['check-ref-format', ref], { cwd })).code !== 0) return;
    const path = await git(['rev-parse', '--git-path', ref], { cwd });
    if (path.code === 0) await recoverOwnedLock(resolve(cwd, text(path)) + '.lock').catch(() => {});
  } finally { guard(); }
}

/** Recover abandoned Apply locks and published intents without opening the user's index. */
export async function reconcileApplies(device) {
  // Dynamic import avoids the result-actions -> apply utility dependency cycle.
  await (await import('./result-actions.mjs')).reconcileWorktrees(device);
  const applied = [];
  for (const circle of await device.listCircles()) {
    for (const intent of await device.intentStore(circle.id).list()) {
      if (intent?.kind !== 'apply' || intent.circle !== circle.id) continue;
      if (typeof intent.result?.repo === 'string' && isAbsolute(intent.result.repo)) {
        const cwd = intent.result.repo;
        await recoverApplyLocks(cwd, intent.result).catch(() => {});
      }
      const result = await publishedApply(intent);
      if (result) applied.push({ ...result, circle: circle.id });
    }
  }
  return applied.sort((a, b) => a.at.localeCompare(b.at));
}

export function gitEnv(extra) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const name of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES)$/.test(name)) delete env[name];
    // GIT_CONFIG is read only by `git config`, so the hook lookup below would
    // inspect a different file than the commands it protects. Inherited
    // GIT_CONFIG_COUNT/KEY/VALUE would clash with the overrides set below.
    if (/^GIT_CONFIG(_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+)?$/.test(name)) delete env[name];
  }
  return { ...env, ...extra };
}
function runGit(args, { cwd, input, env, beforeInput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached:!!beforeInput && ['linux','darwin'].includes(process.platform) });
    const out = [], err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (error) => reject(error.code === 'ENOENT' ? new ApplyError('git_missing', 'git is not installed or not on PATH.') : error));
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').trim() }));
    // The ref transaction cannot start until the detached writer group is recorded.
    if (beforeInput) Promise.resolve().then(() => beforeInput(child.pid)).then(() => child.stdin.end(input), error => { child.kill(); reject(error); });
    else child.stdin.end(input);
  });
}
export async function git(args, options = {}) {
  // hooksPath covers hook files only. Config-defined hooks have multi-valued
  // event lists; a final empty value clears all inherited events:
  // https://git-scm.com/docs/git-config#Documentation/git-config.txt-hookltfriendly-namegtevent
  const config = await runGit(['config', '--null', '--name-only', '--get-regexp', '^hook\\..*\\.(command|event)$'], { cwd: options.cwd, env: options.env });
  if (config.code !== 0 && config.code !== 1) refuse('git_config_failed', 'git could not inspect configured hooks: ' + config.stderr);
  const events = [...new Set(config.stdout.toString('utf8').split('\0').filter(Boolean).map(key => key.replace(/\.(command|event)$/, '.event')))];
  // Pass the resets through GIT_CONFIG_KEY_n/VALUE_n, not -c: -c splits at the
  // first '=', which a hook name may contain.
  const env = { ...options.env, GIT_CONFIG_COUNT: String(events.length) };
  events.forEach((key, i) => { env['GIT_CONFIG_KEY_' + i] = key; env['GIT_CONFIG_VALUE_' + i] = ''; });
  return runGit(args, { ...options, env });
}
export const text = (result) => result.stdout.toString('utf8').trim();
export const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

/** Paths git itself would touch, from `git apply --numstat -z`. */
function numstatPaths(stdout) {
  const tokens = stdout.toString('utf8').split('\0');
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!match) continue;
    if (match[3] !== '') paths.push(match[3]);
    else { paths.push(tokens[i + 1], tokens[i + 2]); i += 2; }
  }
  return paths.filter((path) => path !== undefined);
}

export async function findBase({ cwd, job, receipt }) {
  if (job.source.kind === 'git') {
    const base = job.source.commit;
    if (!HEX.test(base)) refuse('base_missing', 'The job names no usable base commit.');
    const have = await git(['cat-file', '-e', base + '^{commit}'], { cwd });
    const contained = have.code === 0 && (await git(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd })).code === 0;
    if (!contained) refuse('base_missing', `This repository's HEAD does not contain commit ${base.slice(0, 12)}, the version the agent worked from. Fetch it, or run this in a clone that has it.`);
    return { base, how: 'commit' };
  }
  const tree = receipt.base_tree;
  if (!HEX.test(tree ?? '')) refuse('base_unknown', 'This result does not say which snapshot it was made from, so it cannot be applied safely. Download it with faravan job result and review it by hand.');
  const log = await git(['log', '-n', '5000', '--format=%H %T', 'HEAD'], { cwd });
  const hit = log.code === 0 ? text(log).split('\n').map((line) => line.split(' ')).find(([, t]) => t === tree) : null;
  if (!hit) refuse('base_missing', 'No commit in this repository matches the snapshot you sent. Run this in the repository you sent, at or after the commit you sent.');
  return { base: hit[0], how: 'snapshot' };
}

function commitMessage({ prompt, digest, receipt, stat, base }) {
  const subject = clean(String(prompt ?? '').split('\n').find((line) => line.trim()), 72) || 'Faravan job ' + digest.slice(7, 19);
  const agent = [clean(receipt.harness, 80), receipt.harness_version && receipt.harness_version !== 'unknown' ? clean(receipt.harness_version, 40) : null].filter(Boolean).join(' ');
  return [subject, '',
    `Agent: ${agent} · Model: ${clean(receipt.model, 80) || 'not reported'} · Duration: ${duration(receipt.duration_ms)}`,
    `Changes: ${stat.files} file${stat.files === 1 ? '' : 's'}, +${stat.insertions} -${stat.deletions}`,
    `Faravan-Job: ${digest}`, `Base: ${base}`, '',
    'Written by an agent on another computer. Review and test before merging.', ''].join('\n');
}

/**
 * The verified diff candidate of `digest`, read through the signed-result path: the result signature, the retained
 * attempt and both artifact hashes are checked by fetchResult, then the patch is parsed and checked for unsafe paths by
 * this reader and by git itself (`cwd` must be the repository it is meant for).
 */
export async function verifiedPatch({ digest, circle, cwd, device, deviceOptions, signal }) {
  const d = await (device ?? openDevice(deviceOptions ?? {}));
  const selected = await circleForJob(d, circle, digest);
  const client = d.jobReadClient ? await d.jobReadClient(selected.id, digest) : await d.client(selected.id);

  // Retain a separate, earlier job observation before the result read. This is
  // coordinator consistency evidence, not an independently authenticated lease.
  const attempt = structuredClone((await client.getJob(digest, { signal })).current_attempt);
  // fetchResult verifies the signature, the retained attempt, and both artifact hashes.
  const { bytes, candidate, receipt, job } = await client.fetchResult(digest, { signal, attempt, includeMetadata: true });
  if (candidate.media_type !== 'text/x-diff') {
    refuse('not_a_diff', 'This result is a full copy of the files, not a patch (the lender could not produce a diff). Download it with: faravan job result ' + digest + ' --out DIRECTORY');
  }

  let parsed;
  try { parsed = parseUnifiedDiff(bytes); } catch (error) {
    if (error instanceof PatchError) refuse('patch_invalid', 'The patch is malformed: ' + error.message);
    throw error;
  }
  if (!parsed.files.length) refuse('no_changes', 'The agent made no changes.');
  const hazards = patchHazards(parsed);
  if (hazards.length) refuse('unsafe_patch', 'Refusing an unsafe patch: ' + hazards.slice(0, 3).join('; ') + '.');

  // Second opinion from git itself on which paths it would write.
  const listed = await git(['apply', '--numstat', '-z', '-'], { cwd, input: bytes });
  if (listed.code !== 0) refuse('patch_invalid', 'git cannot read the patch: ' + (listed.stderr.split('\n')[0] || 'unknown error'));
  const known = new Set(parsed.files.flatMap((file) => [file.path, file.oldPath]));
  for (const path of numstatPaths(listed.stdout)) {
    const why = unsafePatchPath(path);
    if (why || !known.has(path)) refuse('unsafe_patch', `Refusing an unsafe patch: ${clean(path, 200) || '(empty)'}: ${why ?? 'path not recognized'}.`);
  }
  return { bytes, parsed, receipt, job, client, circle: selected.id };
}

export async function applyResult({ digest, circle, branch, dryRun = false, repo = process.cwd(), device, deviceOptions, signal, expectedPreview = null } = {}) {
  const match = DIGEST.exec(digest ?? '');
  if (!match) throw new UsageError('Provide a job ID. ' + USAGE);
  digest = 'sha256:' + match[1];
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: repo });
  if (top.code !== 0) refuse('not_a_repository', 'Run this inside the Git repository you want the changes in.');
  const cwd = await realpath(text(top));
  const name = branch ?? 'faravan/' + digest.slice(7, 19);
  if (name.startsWith('-') || (await git(['check-ref-format', 'refs/heads/' + name])).code !== 0) throw new UsageError('That is not a valid branch name.');
  const d = await (device ?? openDevice(deviceOptions ?? {}));
  const selected = await circleForJob(d, circle, digest), intents = d.intentStore(selected.id);
  const previous = await matchingPublished(intents, selected.id, digest, cwd, name);
  if (previous) {
    await recoverApplyLocks(cwd, previous).catch(() => {});
    return previous;
  }
  const { bytes, parsed, receipt, job, client } = await verifiedPatch({ digest, circle: selected.id, cwd, device: d, signal });
  const { base, how } = await findBase({ cwd, job, receipt });
  if ((await git(['show-ref', '--verify', '--quiet', 'refs/heads/' + name], { cwd })).code === 0) {
    const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
    if (applied) return applied;
    refuse('branch_exists', `Branch ${name} already exists. Choose another with --branch.`);
  }

  const stat = { files: parsed.files.length, insertions: parsed.insertions, deletions: parsed.deletions };
  // Where it would land: the repository, the commit HEAD is at and the branch it is on (null when detached). The web app
  // shows these and refuses to write if they changed between the preview and "Add the branch".
  const head = text(await git(['rev-parse', 'HEAD'], { cwd })), current = await git(['symbolic-ref', '-q', 'HEAD'], { cwd });
  const current_ref = current.code === 0 ? text(current) : null;
  const current_branch = current_ref?.startsWith('refs/heads/') ? current_ref.slice('refs/heads/'.length) : null;
  const summary = {
    job_digest: digest, branch: name, base, base_match: how, repo: cwd, head,
    current_branch, current_ref, patch_hash: resultHash(bytes), ...stat,
    files_changed: parsed.files.map((f) => ({ path: f.path, status: f.status, insertions: f.insertions, deletions: f.deletions })),
  };
  const binding = {
    version: 1, repo: cwd, head, current_branch: summary.current_branch, current_ref: summary.current_ref, branch: name,
    job_digest: digest, circle: circle ?? null, base, patch_hash: summary.patch_hash,
  };
  if (expectedPreview && JSON.stringify(binding) !== JSON.stringify(expectedPreview)) {
    refuse('preview_changed', 'The repository, branch, or verified result changed since the preview. Review it again before adding the branch.');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'faravan-apply-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    const step = async (args, input) => {
      const result = await git(args, { cwd, env, input });
      if (result.code !== 0) refuse('patch_conflict', 'The patch does not apply to the base commit: ' + (result.stderr.split('\n')[0] || args[0]));
      return result;
    };
    await step(['read-tree', base]);
    await step(['apply', '--cached', '--check', '--whitespace=nowarn', '-'], bytes);
    await step(['apply', '--cached', '--whitespace=nowarn', '-'], bytes);
    // Read actual link bytes: binary patches and mode-only changes have no text target to inspect.
    const changed = new Set(parsed.files.map(file => file.path));
    const entries = (await step(['ls-files', '--stage', '-z'])).stdout.toString('utf8').split('\0');
    for (const entry of entries) {
      const link = /^120000 ([0-9a-f]+) 0\t([\s\S]*)$/.exec(entry);
      if (!link || !changed.has(link[2])) continue;
      const target = (await step(['cat-file', 'blob', link[1]])).stdout.toString('utf8');
      if (unsafeSymlinkTarget(target)) refuse('unsafe_patch', 'Refusing an unsafe patch: ' + clean(link[2], 200) + ': symbolic link points outside the repository.');
    }
    if (dryRun) return { ...summary, status: 'dry_run' };
    const tree = text(await step(['write-tree']));

    let prompt = null;
    try { prompt = Buffer.from(await client.fetchArtifact(job.prompt, { signal })).toString('utf8'); } catch { /* subject falls back to the job id */ }
    const message = commitMessage({ prompt, digest, receipt, stat, base });
    const identity = await git(['var', 'GIT_COMMITTER_IDENT'], { cwd });
    const fallback = identity.code === 0 ? {} : { GIT_AUTHOR_NAME: 'Faravan', GIT_AUTHOR_EMAIL: 'faravan@localhost', GIT_COMMITTER_NAME: 'Faravan', GIT_COMMITTER_EMAIL: 'faravan@localhost' };
    const made = await git(['commit-tree', tree, '-p', base, '-F', '-'], { cwd, input: message, env: fallback });
    if (made.code !== 0) refuse('commit_failed', 'git could not create the commit: ' + (made.stderr.split('\n')[0] || 'unknown error'));
    const commit = text(made);
    const result = { ...summary, status: 'applied', commit, at: new Date().toISOString() };
    const ref = 'refs/heads/' + name;
    // The device store fsyncs the intent and its directory before Git can publish.
    // Each candidate gets its own record so a losing concurrent Apply cannot erase a winner's proof.
    await intents.set('apply:' + resultHash(JSON.stringify([cwd, ref, commit])), {
      kind: 'apply', version: 1, circle: selected.id, ref, tree, result, owner: applyOwner(), guarded: !!expectedPreview,
    });
    if (!expectedPreview) {
      // The standalone CLI has no earlier preview to bind. Keep its atomic
      // create-only behavior without taking the app flow's HEAD lock.
      const created = await git(['update-ref', '-m', 'faravan apply', 'refs/heads/' + name, commit, ''], { cwd });
      if (created.code !== 0) {
        const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
        if (applied) { await retireUnpublished(intents, selected.id, applied, commit).catch(() => {}); return applied; }
        if (created.stderr.includes('already exists') || created.stderr.includes('reference already exists'))
          refuse('branch_exists', `Branch ${name} could not be created: ${created.stderr.split('\n')[0] || 'already exists'}.`);
        refuse('apply_publish_failed', 'Git could not publish the branch: ' + (created.stderr.split('\n')[0] || 'unknown error'));
      }
    } else {
      // Hold HEAD and its shared branch ref through the final check and result
      // transaction. Another worktree cannot move the symbolic HEAD's referent
      // between the last read and the create-only result-ref commit.
      await recoverApplyLocks(cwd, summary).catch(() => {});
      const headFile = resolve(cwd, text(await git(['rev-parse', '--git-path', 'HEAD'], { cwd })));
      const headLock = headFile + '.lock';
      const commonDir = resolve(cwd, text(await git(['rev-parse', '--git-common-dir'], { cwd })));
      const headStaging = resolve(dirname(headFile), 'faravan-preview-staging');
      const refStaging = resolve(commonDir, 'faravan-preview-staging');
      let guard, lock;
      try { guard = await previewGuard(commonDir, {timeoutMs:30000}); lock = await acquirePreviewLock(headLock, headStaging); }
      catch (error) {
        if (guard) { try { guard(); } catch (releaseError) { console.warn('Faravan: Git preview guard cleanup failed (' + clean(releaseError.code, 40) + ').'); } }
        const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
        // Without the HEAD lock, another dead owner's Git writer may still be active.
        if (applied) { await retireUnpublished(intents, selected.id, applied, commit).catch(() => {}); return applied; }
        refuse('apply_locked', error.message);
      }
      let currentRefLock;
      let currentRefLockPath;
      try {
        const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
        if (applied) { await retireUnpublished(intents, selected.id, applied, commit, true).catch(() => {}); return applied; }
        const refStorage = await git(['config', '--local', '--get', 'extensions.refStorage'], { cwd });
        if (refStorage.code !== 0 && refStorage.code !== 1)
          refuse('preview_changed', 'The repository ref storage could not be checked. Review it again before adding the branch.');
        if (refStorage.code === 0 && text(refStorage) !== 'files')
          refuse('preview_changed', 'This repository uses a ref storage backend this operation cannot lock safely. Review it again before adding the branch.');

        if (summary.current_ref) {
          const currentRef = summary.current_ref;
          const currentRefFile = resolve(cwd, text(await git(['rev-parse', '--git-path', currentRef], { cwd })));
          currentRefLockPath = currentRefFile + '.lock';
          await mkdir(dirname(currentRefFile), { recursive: true });
          try { currentRefLock = await acquirePreviewLock(currentRefLockPath, refStaging); }
          catch (error) {
            const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
            if (applied) { await retireUnpublished(intents, selected.id, applied, commit).catch(() => {}); return applied; }
            if (error.code === 'preview_lock_blocked') refuse(error.code, error.message);
            refuse('preview_changed', 'The current branch is changing. Review it again before adding the branch.');
          }
        }

        const currentHeadFile = (await readFile(headFile, 'utf8')).trim();
        const expectedHeadFile = summary.current_ref ? `ref: ${summary.current_ref}` : head;
        const lockedHead = text(await git(['rev-parse', 'HEAD'], { cwd }));
        if (currentHeadFile !== expectedHeadFile || lockedHead !== head)
          refuse('preview_changed', 'The repository changed while the branch was being added. Review it again before retrying.');
        if (summary.current_ref) {
          const currentRef = summary.current_ref;
          const lockedRef = text(await git(['rev-parse', '--verify', currentRef], { cwd }));
          if (lockedRef !== head)
            refuse('preview_changed', 'The current branch changed while the branch was being added. Review it again before retrying.');
        }
        const commands = ['start', `create refs/heads/${name} ${commit}`, 'prepare', 'commit', ''];
        const created = await git(['update-ref', '-m', 'faravan apply', '--stdin'], { cwd, input: commands.join('\n'), beforeInput: async pid => {
          await recordTransaction(headLock, pid, headStaging);
          if (currentRefLockPath) await recordTransaction(currentRefLockPath, pid, refStaging);
        } });
        if (created.code !== 0) {
          const applied = await matchingPublished(intents, selected.id, digest, cwd, name);
          if (applied) { await retireUnpublished(intents, selected.id, applied, commit, true).catch(() => {}); return applied; }
          if (created.stderr.includes('already exists') || created.stderr.includes('reference already exists'))
            refuse('branch_exists', `Branch ${name} could not be created: ${created.stderr.split('\n')[0] || 'already exists'}.`);
          refuse('apply_publish_failed', 'Git could not publish the branch: ' + (created.stderr.split('\n')[0] || 'unknown error'));
        }
        await retireUnpublished(intents, selected.id, result, null, true).catch(() => {});
      } finally {
        if (currentRefLock) {
          await currentRefLock().catch(error => {
            if (error.code !== 'ENOENT') console.warn('Faravan: Git branch lock cleanup failed at ' + clean(currentRefLockPath, 200) + ' (' + clean(error.code, 40) + '). Check the repository before removing the lock.');
          });
        }
        await lock().catch(error => {
          console.warn('Faravan: Git HEAD lock cleanup failed (' + clean(error.code, 40) + '). Check the repository before removing the lock.');
        });
        try { guard(); } catch (error) { console.warn('Faravan: Git preview guard cleanup failed (' + clean(error.code, 40) + ').'); }
      }
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Explicitly recover only locks whose recorded Faravan owner is proven gone. */
export async function recoverPreviewLocks({repo} = {}) {
  if (typeof repo !== 'string' || !isAbsolute(repo) || repo.includes('\0')) refuse('repo_missing', 'Enter the full path of the repository.');
  const top = await git(['rev-parse', '--show-toplevel'], {cwd:repo});
  if (top.code !== 0) refuse('not_a_repository', 'Run this inside the Git repository.');
  const cwd = await realpath(text(top));
  const commonDir = resolve(cwd, text(await git(['rev-parse', '--git-common-dir'], {cwd})));
  let guard;
  try {
    guard = await previewGuard(commonDir);
    const head = resolve(cwd, text(await git(['rev-parse', '--git-path', 'HEAD'], {cwd})));
    const ref = await git(['symbolic-ref', '-q', 'HEAD'], {cwd});
    if (ref.code === 0) {
      const refPath = resolve(cwd, text(await git(['rev-parse', '--git-path', text(ref)], {cwd})));
      await recoverOwnedLock(refPath + '.lock');
    }
    await recoverOwnedLock(head + '.lock');
    return {status:'recovered'};
  } catch (error) {
    if (error.code === 'preview_lock_blocked') refuse(error.code, error.message);
    throw error;
  } finally { if (guard) guard(); }
}

/** Each refusal of applyResult, as the job page state it becomes (EXPERIENCE M10; one to one). */
export const APPLY_STATES = {
  not_a_repository: 'job.apply-repo-missing', repo_missing: 'job.apply-repo-missing',
  base_missing: 'job.apply-base-missing', base_unknown: 'job.apply-base-missing',
  branch_exists: 'job.apply-branch-exists', patch_conflict: 'job.apply-conflict',
  apply_locked: 'job.apply-locked',
  unsafe_patch: 'job.apply-unsafe', patch_invalid: 'job.apply-unsafe', no_changes: 'job.no-changes',
  preview_lock_blocked: 'job.apply-lock-blocked',
};
export const applyStateOf = code => APPLY_STATES[code] ?? 'job.apply-failed';

/**
 * The web app's Add as a branch. `dryRun` returns a signed `preview_token` bound to the canonical repo, HEAD,
 * current branch, target branch, and verified result. A new publication requires that token and checks those expectations
 * again under Git's HEAD and current-branch ref locks before an atomic create-only ref transaction. The folder must be an absolute directory;
 * an exactly reconciled prior Apply returns its original success without publishing again. applyResult never changes
 * the current branch, real index, or working tree.
 */
export async function applyForApp({ digest, circle, repo, branch, dryRun = true, expect = null, device, signal } = {}) {
  if (typeof repo !== 'string' || !repo || repo.includes('\0') || !isAbsolute(repo)) refuse('repo_missing', 'Enter the full path of the folder, starting with / (or C:\\ on Windows).');
  const info = await stat(repo).catch(() => null);
  if (!info?.isDirectory()) refuse('repo_missing', `${clean(repo, 200)} is not a folder on this computer.`);
  const preview = await applyResult({ digest, circle, branch, dryRun: true, repo, device, signal });
  if (preview.status === 'applied') return preview;
  const binding = bindingForPreview(preview, circle);
  if (dryRun) return { ...preview, preview_token: previewToken(binding), status: 'dry_run' };
  const submitted = readPreviewToken(expect?.preview_token);
  if (JSON.stringify(submitted) !== JSON.stringify(binding))
    return { ...preview, preview_token: previewToken(binding), status: 'changed' };
  try { return await applyResult({ digest, circle, branch, dryRun: false, repo, device, signal, expectedPreview: submitted }); }
  catch (error) {
    if (!(error instanceof ApplyError) || error.code !== 'preview_changed') throw error;
    const current = await applyResult({ digest, circle, branch, dryRun: true, repo, device, signal });
    const currentBinding = bindingForPreview(current, circle);
    return { ...current, preview_token: previewToken(currentBinding), status: 'changed' };
  }
}

function parseArgs(argv) {
  const flags = {}, position = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--json') continue;
    if (value === '--dry-run') { if (flags.dryRun) throw new UsageError('Duplicate --dry-run. ' + USAGE); flags.dryRun = true; continue; }
    if (value === '--branch' || value === '--circle') {
      const key = value.slice(2);
      if (Object.hasOwn(flags, key) || i + 1 === argv.length || argv[i + 1].startsWith('--')) throw new UsageError('Missing or duplicate ' + value + '. ' + USAGE);
      flags[key] = argv[++i]; continue;
    }
    if (value.startsWith('--')) throw new UsageError('Unknown option ' + value + '. ' + USAGE);
    position.push(value);
  }
  if (position.length !== 1) throw new UsageError(USAGE);
  return { ...flags, digest: position[0] };
}

const PREVIEW_BYTES = 256 * 1024, PREVIEW_FILES = 500;

/**
 * What the app's Changes tab shows for a verified result: file list, bounded
 * unified-diff text, and the command that applies it. Never applies anything.
 */
export function changesView({ bytes, mediaType, digest, circle }) {
  if (mediaType !== 'text/x-diff') return { format: 'tree', command: null };
  const command = 'faravan apply ' + digest + (circle ? ' --circle ' + circle : '');
  let parsed;
  try { parsed = parseUnifiedDiff(bytes); } catch (error) {
    if (error instanceof PatchError) return { format: 'diff', invalid: true, message: error.message, command: null };
    throw error;
  }
  const previews = addedImagePreviews(bytes, parsed.files.slice(0, PREVIEW_FILES), {digest,circle});
  const whole = Buffer.from(bytes);
  let end = Math.min(whole.length, PREVIEW_BYTES);
  if (end < whole.length) end = Math.max(whole.lastIndexOf(10, end - 1) + 1, 0);
  return {
    format: 'diff', command,
    diffstat: { files: parsed.files.length, insertions: parsed.insertions, deletions: parsed.deletions },
    files: parsed.files.slice(0, PREVIEW_FILES).map((f, i) => ({ path: f.path, status: f.status, insertions: f.insertions, deletions: f.deletions, binary: f.binary, ...(previews[i] ? {preview:previews[i]} : {}) })),
    more_files: Math.max(0, parsed.files.length - PREVIEW_FILES),
    diff: whole.subarray(0, end).toString('utf8'), truncated: end < whole.length, bytes: whole.length,
    blocked: patchHazards(parsed).slice(0, 5),
  };
}

function describe(result) {
  const counts = `${result.files} file${result.files === 1 ? '' : 's'}, +${result.insertions} -${result.deletions}`;
  const list = result.files_changed.slice(0, 20).map((f) => `  ${f.status.padEnd(8)} ${clean(f.path, 200)}`).join('\n') +
    (result.files_changed.length > 20 ? `\n  … and ${result.files_changed.length - 20} more` : '');
  if (result.status === 'dry_run') {
    return `Dry run: the patch applies cleanly (${counts}). Nothing was changed.\nIt would create branch ${result.branch} from ${result.base.slice(0, 12)}.\n${list}`;
  }
  return `Applied to new branch ${result.branch} (${counts}). Your current branch and working tree were not changed.\n${list}\n` +
    `Review: git diff ${result.base.slice(0, 12)}..${result.branch}\nUse it: git merge ${result.branch}   (or git switch ${result.branch})`;
}

/** CLI entry. Prints its own result; refusals exit 1, bad usage 2 (via the shared handler). */
export async function runApply(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  const json = argv.includes('--json');
  const input = parseArgs(argv);
  try {
    const result = await applyResult({ ...input, repo: options.repo, device: options.device, deviceOptions: options, signal: options.signal });
    stdout.write(json ? JSON.stringify(result) + '\n' : describe(result) + '\n');
    return 0;
  } catch (error) {
    if (!(error instanceof ApplyError)) throw error;
    if (json) stdout.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
    else stderr.write('faravan: ' + error.message + '\n');
    return 1;
  }
}
