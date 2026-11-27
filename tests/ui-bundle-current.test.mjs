import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

// Every build (Linux, macOS, Windows) ships the committed public/v1 files; none of them runs vite. A UI change merged
// without `npm run build:ui` therefore never reaches users. Build the UI into a scratch folder and compare.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = join(root, 'ui/node_modules/vite/bin/vite.js');

async function filesUnder(directory, prefix = '') {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function assetPath(url, basePath) {
  const resolved = new URL(url, `https://faravan-assets.invalid${basePath}`);
  if (resolved.origin !== 'https://faravan-assets.invalid') return null;
  return resolved.pathname.replace(/^\/+/, '');
}

function referencedPaths(indexHtml, manifest) {
  const urls = [];
  for (const match of indexHtml.matchAll(/<(?:link|script|img|source|meta)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const isAppAssetMeta = /<meta\b/i.test(tag) && ['app-module', 'app-style'].includes(name?.[1] ?? name?.[2]);
    for (const attr of tag.matchAll(/\b(href|src|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      if (attr[1].toLowerCase() !== 'content' || isAppAssetMeta) urls.push(attr[2] ?? attr[3]);
    }
  }
  const collectManifestAssets = value => {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => {
      if ((key === 'src' || key === 'href') && typeof child === 'string') return [child];
      return collectManifestAssets(child);
    });
  };
  return [...new Set([
    ...urls.map(url => assetPath(url, '/index.html')),
    ...collectManifestAssets(manifest).map(url => assetPath(url, '/manifest.webmanifest')),
  ].filter(Boolean))];
}

function assertReferencedPathsExist(paths, committedFiles, availableFiles) {
  for (const path of paths) {
    assert.ok(committedFiles.has(path), `referenced UI asset public/v1/${path} is not committed`);
    assert.ok(availableFiles.has(path), `referenced UI asset public/v1/${path} does not exist in the working tree`);
  }
}

// A missing toolchain fails: a skip would let a stale bundle pass the local gate unseen.
test('the committed web UI bundle is built from the current ui/ source', {timeout: 180000}, async t => {
  assert.ok(existsSync(vite),
    'cannot check the committed UI bundle: the UI toolchain is not installed. Run `npm --prefix ui ci`, then re-run this test.');
  const [firstOut, secondOut] = await Promise.all([
    mkdtemp(join(tmpdir(), 'faravan-ui-bundle-first-')),
    mkdtemp(join(tmpdir(), 'faravan-ui-bundle-second-')),
  ]);
  t.after(() => Promise.all([firstOut, secondOut].map(out => rm(out, {recursive: true, force: true}))));
  const build = out => promisify(execFile)(process.execPath,
    [vite, 'build', '--config', 'v1/vite.config.mjs', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'],
    {cwd: join(root, 'ui'), env: {...process.env, TZ: 'America/Chicago'}, maxBuffer: 1 << 24});
  await build(firstOut);
  await build(secondOut);

  const trackedPaths = execFileSync('git', ['ls-files', '-z', '--', 'public/v1'], {cwd: root, encoding: 'buffer'})
    .toString('utf8').split('\0').filter(Boolean).map(path => path.slice('public/v1/'.length));
  const [firstFiles, secondFiles] = await Promise.all([filesUnder(firstOut), filesUnder(secondOut)]);
  const availableFiles = new Set(await filesUnder(join(root, 'public/v1')));
  const firstSet = new Set(firstFiles);
  const secondSet = new Set(secondFiles);
  const tracked = new Set(trackedPaths);
  assert.deepEqual(firstFiles.filter(path => !secondSet.has(path)), [], 'the second UI build emits every first-build file');
  assert.deepEqual(secondFiles.filter(path => !firstSet.has(path)), [], 'the second UI build emits no extra files');
  assert.deepEqual(firstFiles.filter(path => !tracked.has(path)), [],
    `public/v1 is missing tracked build files: ${firstFiles.filter(path => !tracked.has(path)).join(', ')}; run 'npm run build:ui' and commit them`);
  assert.deepEqual(trackedPaths.filter(path => !firstSet.has(path)), [],
    `public/v1 contains tracked files not emitted by the UI build: ${trackedPaths.filter(path => !firstSet.has(path)).join(', ')}`);

  // Two clean Vite builds must be byte-stable before exact byte comparison with the committed index blobs.
  const firstHtml = await readFile(join(firstOut, 'index.html'), 'utf8');
  const firstManifest = JSON.parse(await readFile(join(firstOut, 'manifest.webmanifest'), 'utf8'));
  const refs = referencedPaths(firstHtml, firstManifest);
  assert.ok(refs.length > 0, 'the built index and manifest reference UI assets');
  assertReferencedPathsExist(refs, tracked, availableFiles);
  const iconPath = refs.find(path => /\.(?:png|ico|svg)$/i.test(path));
  assert.ok(iconPath, 'the built index or manifest references an icon');
  const withoutIcon = new Set([...availableFiles].filter(path => path !== iconPath));
  assert.throws(() => assertReferencedPathsExist(refs, tracked, withoutIcon),
    new RegExp(`public/v1/${iconPath} does not exist in the working tree`),
    `the reference guard rejects a removed icon (${iconPath})`);

  for (const file of firstFiles) {
    const [first, second] = await Promise.all([readFile(join(firstOut, file)), readFile(join(secondOut, file))]);
    assert.ok(first.equals(second), `UI build output is not byte-stable across two runs: ${file}`);
    const committed = execFileSync('git', ['show', `:public/v1/${file}`], {cwd: root, encoding: 'buffer', maxBuffer: 1 << 24});
    assert.ok(first.equals(committed), `public/v1/${file} is stale: run 'npm run build:ui' and commit it`);
  }
});
