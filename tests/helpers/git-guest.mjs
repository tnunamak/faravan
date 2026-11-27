import './no-browser.mjs';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { DIFF_OUTPUT, isGitCandidateScript } from '../../lib/git-candidate.mjs';

const run = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/** Test fake for the sandbox guest: runs the lender's real git scripts with the real git binary in a temp dir. */
export async function guestExec(handle, command) {
  if (!isGitCandidateScript(command)) return false;
  const { stdout } = await run('sh', ['-c', command], { cwd: handle.scratch_dir, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
  handle._lastExecStdout = stdout;
  return true;
}
export async function collectGuest(handle, manifest) {
  if (manifest?.[0] !== DIFF_OUTPUT) return null;
  return [{ path: DIFF_OUTPUT, bytes_content: await readFile(join(handle.scratch_dir, DIFF_OUTPUT)) }];
}

/** A temp git repository with one commit; returns {dir, commit}. */
export async function makeRepo(files = { 'README.md': 'hello\n', 'src/a.txt': 'one\ntwo\nthree\n' }) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-git-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.test'); git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), content);
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'initial');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}
