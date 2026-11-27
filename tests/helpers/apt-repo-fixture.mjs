import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const run = promisify(execFile);
const script = fileURLToPath(new URL('../../packaging/apt/build-repo.sh', import.meta.url));
export const tools = ['apt-ftparchive', 'apt-get', 'apt-cache', 'dpkg-deb', 'gpg', 'gpgconf', 'xz'];
const have = async name => run('sh', ['-c', 'command -v ' + name]).then(() => true, () => false);
export const skip = (await Promise.all(tools.map(have))).every(Boolean) ? false : 'needs apt-utils, dpkg and gnupg';

// A throwaway key and repository. The private key lives only in this test's temp directory.
// A short path keeps gpg-agent's socket path under the OS limit.
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'spk-apt-'));
  const gnupg = join(root, 'g');
  await mkdir(gnupg, {mode: 0o700});
  t.after(async () => {
    await run('gpgconf', ['--homedir', gnupg, '--kill', 'all']).catch(() => {});
    await rm(root, {recursive: true, force: true});
  });
  await run('gpg', ['--homedir', gnupg, '--batch', '--passphrase', '', '--quick-generate-key',
    'Faravan Test Key <test@example.invalid>', 'rsa3072', 'sign', 'never']);
  const fpr = (await run('gpg', ['--homedir', gnupg, '--with-colons', '--list-keys'])).stdout.match(/^fpr:::::::::(\w+):/m)[1];
  const built = new Map(); // one build per package, so the same package is the same bytes every time it is passed
  const deb = async (version, architecture = 'amd64', note = 'test package') => {
    const id = [version, architecture, note].join('\0');
    if (built.has(id)) return built.get(id);
    const dir = join(root, 'pkg-' + architecture + '-' + version + '-' + note.replaceAll(' ', '_'));
    await mkdir(join(dir, 'DEBIAN'), {recursive: true});
    await mkdir(join(dir, 'usr/lib/faravan'), {recursive: true});
    await writeFile(join(dir, 'usr/lib/faravan/VERSION'), version + '\n');
    await writeFile(join(dir, 'DEBIAN/control'), `Package: faravan\nVersion: ${version}\nArchitecture: ${architecture}\nMaintainer: Test <test@example.invalid>\nDescription: ${note}\n`);
    // One directory per note: the same file name with different bytes is what a rebuilt release looks like.
    await mkdir(join(root, 'debs', note.replaceAll(' ', '_')), {recursive: true});
    const file = join(root, 'debs', note.replaceAll(' ', '_'), `faravan_${version}_${architecture}.deb`);
    await run('dpkg-deb', ['--build', '--root-owner-group', dir, file]);
    built.set(id, file);
    return file;
  };
  const out = join(root, 'repo');
  // Build (or rebuild) one suite of the repository from the given versions; other suites are left as they are.
  const buildSuite = async (suite, ...versions) => {
    const files = await Promise.all(versions.map(version => deb(version)));
    await run(script, ['--out', out, '--key', fpr, '--gnupghome', gnupg, '--suite', suite, ...files]);
    return out;
  };
  const build = (...versions) => buildSuite('stable', ...versions);
  // An unprivileged apt: its own state, cache and source list, trusting only the given keyring.
  const apt = async (repo, keyring, args, bin = 'apt-get', suite = 'stable') => {
    const state = join(root, 'apt');
    await mkdir(join(state, 'lists/partial'), {recursive: true});
    await mkdir(join(state, 'cache/archives/partial'), {recursive: true});
    await writeFile(join(state, 'sources.list'), `deb [signed-by=${keyring}] file:${repo} ${suite} main\n`);
    const options = ['-o', 'Dir::State=' + state, '-o', 'Dir::State::lists=' + join(state, 'lists'), '-o', 'Dir::Cache=' + join(state, 'cache'),
      '-o', 'Dir::Etc::sourcelist=' + join(state, 'sources.list'), '-o', 'Dir::Etc::sourceparts=/dev/null',
      '-o', 'Dir::Etc::trusted=/dev/null', '-o', 'Dir::Etc::trustedparts=/dev/null', '-o', 'APT::Sandbox::User=', '-o', 'Debug::NoLocking=1'];
    return run(bin, [...options, ...args], {cwd: root});
  };
  return {root, gnupg, fpr, out, script, deb, build, buildSuite, apt};
}

