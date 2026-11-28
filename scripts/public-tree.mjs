#!/usr/bin/env node
// Export committed source only. Generated files and local edits cannot enter the snapshot.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, lstatSync} from 'node:fs';
import {resolve, dirname, relative, posix} from 'node:path';
import {fileURLToPath} from 'node:url';

// Deliberately reviewed data: adding a new root does not make it public automatically.
export const ALLOWLIST = [
  '.gitignore', '.gitleaks.toml', '.github/workflows/ci.yml',
  '.github/workflows/release-macos.yml', '.github/workflows/bar-install.yml', '.github/workflows/bar-join-borrow.yml',
  'LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'licenses/', 'README.md', 'package.json', 'package-lock.json',
  'playwright.config.mjs', 'playwright.verify.config.mjs',
  'bin/', 'lib/', 'public/', 'ui/', 'tray/', 'packaging/', 'profiles/', 'kits/',
  'vendor/', 'scripts/', 'tests/', 'spec/',
  'docs/SECURITY.md', 'docs/STATUS.md',
  'docs/agents.md', 'docs/circle-invitations.md', 'docs/circle-people.md',
  'docs/connect-chatgpt.md', 'docs/getting-started-with-a-friend.md',
  'docs/linux-quickstart.md', 'docs/mac-quickstart.md', 'docs/mcp-quickstart.md',
  'docs/install.md', 'docs/releasing.md',
  'docs/team-onboarding.md', 'docs/testing.md', 'docs/testing-browser.md', 'docs/testing/',
  'docs/protocol/', 'docs/security/', 'docs/support/',
  'docs/design/AGENT-INTERFACES.md', 'docs/internal/status.json', 'docs/internal/test-evidence.md',
];
export const EXCLUDED = [
  'docs/history/', 'docs/reviews/', 'docs/research/', 'evidence/', 'research/',
  'test-artifacts/', 'BOUNDS-MAP.md', 'INPUT-MAP.md',
  'scripts/rename/', 'packaging/journey/REVIEW',
  'tests/full-rename.test.mjs',
];
export function isPublic(path) {
  return !EXCLUDED.some(prefix => path.startsWith(prefix)) &&
    ALLOWLIST.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix);
}

export function exportPublicTree(root, destination) {
  root = resolve(root);
  const output = resolve(destination);
  if (output === root || !relative(root, output).startsWith('..')) throw new Error('output must be outside the source checkout');
  mkdirSync(output, {recursive: true});
  if (readdirSync(output).length) throw new Error('output directory must be empty');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {maxBuffer: 256 * 1024 * 1024});
  const rows = git('ls-tree', '-rz', 'HEAD').toString().split('\0').filter(Boolean).map(row => {
    const [header, path] = row.split('\t');
    return {mode: header.split(' ')[0], path};
  });
  const files = rows.filter(row => isPublic(row.path));
  for (const {mode, path} of files) {
    if (mode === '160000') throw new Error(`submodule requires explicit vendoring: ${path}`);
    if (mode === '120000') {
      const target = git('show', `HEAD:${path}`).toString();
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (target.startsWith('/') || !isPublic(resolved)) throw new Error(`symlink leaves public tree: ${path}`);
    }
  }
  const archive = git('archive', '--format=tar', 'HEAD', '--', ...files.map(row => row.path));
  execFileSync('tar', ['-xf', '-', '-C', output], {input: archive});
  // Conservative literal dependency audit. Scan executable inputs, not prose comments or outputs.
  // Computed paths still need the fresh-clone test/package gate; this is not a JS evaluator.
  const missing = rows.filter(row => !isPublic(row.path)).map(row => row.path);
  const failures = [];
  for (const {path} of files) {
    if (!/^(?:tests|scripts|packaging|bin|lib|ui)\//.test(path) || !/\.(?:mjs|cjs|js|jsx|sh|ps1)$/.test(path)) continue;
    if (lstatSync(resolve(output, path)).isSymbolicLink()) continue;
    const lines = readFileSync(resolve(output, path), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(?:\/\/|#|\*)/.test(line)) return;
      if (!/(?:readFile|readSource|new URL|\bimport\b|\brequire\b|\bsource\b|\blocal\b|\bcp\b|\bcat\b|\btest -[efdr]\b)/.test(line)) return;
      for (const omitted of missing) {
        if (line.includes(omitted)) failures.push(`${path}:${i + 1} reads excluded ${omitted}`);
      }
    });
  }
  if (failures.length) throw new Error(failures.join('\n'));
  const commit = git('rev-parse', 'HEAD').toString().trim();
  console.log(`Exported ${files.length} committed files from ${commit}`);
  return {commit, rows, files};
}
function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.length !== 3) throw new Error('usage: node scripts/public-tree.mjs <empty output directory>');
  exportPublicTree(root, process.argv[2]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
