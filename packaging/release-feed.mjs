/** Offline staging only. This is NOT the signed runtime update feed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const component = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const bytes = value => Buffer.isBuffer(value) || value instanceof Uint8Array;
function publicURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /%|\\/.test(url.pathname)) throw new Error('invalid public URL');
  return url;
}
export function releaseConfig(onboarding) {
  const installs = [...onboarding.matchAll(/curl -fsSL (https:\/\/[^\s]+) \| sh/g)].map(m => m[1]);
  const feeds = [...onboarding.matchAll(/\[public signed release list\]\((https:\/\/[^)]+)\)/g)].map(m => m[1]);
  if (installs.length !== 1 || feeds.length !== 1) throw new Error('ambiguous documented release URLs');
  const bootstrap = publicURL(installs[0]), feed = publicURL(feeds[0]);
  const base = new URL('./', bootstrap);
  if (feed.origin !== base.origin || !feed.pathname.startsWith(base.pathname)) throw new Error('release URL mismatch');
  return Object.freeze({ bootstrapURL: bootstrap.href, signedFeedURL: feed.href, baseURL: base.href });
}

/** Caller supplies build provenance and bytes; this function reads no host stores. */
export async function stageRelease(input, io = fs) {
  const { output, sourceSha, expectedSourceSha, installer, onboarding, artifacts } = input;
  if (!commit(sourceSha) || sourceSha !== expectedSourceSha) throw new Error('stale or mismatched source SHA');
  if (!bytes(installer) || !installer.length) throw new Error('absent installer');
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('absent graphical artifact');
  const config = releaseConfig(onboarding);
  // Snapshot caller-owned buffers before awaiting filesystem effects.
  const files = [{ url: config.bootstrapURL, data: Buffer.from(installer) }];
  const names = new Set(), platforms = new Set();
  const packages = artifacts.map(artifact => {
    const universalMacZip = artifact.platform === 'darwin' && artifact.kind === 'zip' && artifact.arch === 'universal';
    if (!component(artifact.name) || !['linux', 'darwin'].includes(artifact.platform) ||
        (!universalMacZip && !['x64', 'arm64'].includes(artifact.arch)) ||
        !['deb', 'zip', 'AppImage', 'dmg'].includes(artifact.kind)) throw new Error('invalid artifact metadata');
    if (artifact.sourceSha !== sourceSha) throw new Error('stale artifact source SHA');
    if (!bytes(artifact.data) || !artifact.data.length) throw new Error('absent artifact bytes');
    const data = Buffer.from(artifact.data), sha256 = hash(data);
    if (sha256 !== artifact.sha256) throw new Error('artifact hash mismatch');
    const platformKey = [artifact.platform, artifact.arch, artifact.kind].join('/');
    if (names.has(artifact.name) || platforms.has(platformKey)) throw new Error('duplicate artifact');
    names.add(artifact.name); platforms.add(platformKey);
    const url = new URL('releases/' + sourceSha + '/' + artifact.name, config.baseURL).href;
    if (artifact.url !== undefined && artifact.url !== url) throw new Error('artifact URL mismatch');
    files.push({ url, data });
    return { name: artifact.name, platform: artifact.platform, arch: artifact.arch,
      kind: artifact.kind, sourceSha, sha256, size: data.length, url };
  });
  packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const manifestURL = new URL('releases/' + sourceSha + '/manifest.json', config.baseURL).href;
  if (names.has('manifest.json')) throw new Error('reserved artifact name');
  const manifest = { schemaVersion: 1, stagingOnly: true, sourceSha,
    bootstrap: { url: config.bootstrapURL, sha256: hash(files[0].data), size: files[0].data.length },
    signedFeedURL: config.signedFeedURL, manifestURL, packages };
  files.push({ url: manifestURL, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
  // output must be a new directory. A concurrent attempt cannot overwrite it.
  await io.mkdir(output);
  try {
    for (const file of files) {
      const target = path.join(output, publicURL(file.url).pathname.slice(1));
      await io.mkdir(path.dirname(target), { recursive: true });
      await io.writeFile(target, file.data, { flag: 'wx', mode: 0o444 });
    }
  } catch (error) {
    await io.rm(output, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

// CLI recipe contains explicit local build provenance and artifact paths.
// It does not fetch, sign, publish, inspect credentials, or infer a source SHA.
async function main() {
  const [recipePath, output] = process.argv.slice(2);
  if (!recipePath || !output) throw new Error('usage: node packaging/release-feed.mjs RECIPE.json NEW_DISPOSABLE_OUTPUT');
  const recipe = JSON.parse(await fs.readFile(recipePath, 'utf8'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const onboarding = await fs.readFile(path.join(root, 'docs/releasing.md'), 'utf8');
  const installer = await fs.readFile(path.join(root, 'bin/faravan-install.sh'));
  const artifacts = await Promise.all(recipe.artifacts.map(async artifact => ({
    ...artifact, data: await fs.readFile(path.resolve(path.dirname(recipePath), artifact.file)),
  })));
  await stageRelease({ ...recipe, output, onboarding, installer, artifacts });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
