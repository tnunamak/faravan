import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function executable(path, label) {
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`staged Linux runtime: missing executable ${label}; rebuild/reinstall the complete Faravan package (no system Node fallback)`);
  }
}

async function jsonFile(path, label) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`staged Linux runtime: missing or invalid ${label}; rebuild/reinstall the complete Faravan package`);
  }
}

// Shared by staging and final qualification. Copy the exact bytes hashed here,
// not a second read of a caller-controlled path.
export async function verifiedPiPayload(payloadPath, pinPath) {
  let bytes, pin;
  try {
    if (!(await stat(payloadPath)).isFile()) throw new Error('not a file');
    bytes = await readFile(payloadPath);
  } catch { throw new Error('pi payload: missing or unreadable file ' + payloadPath); }
  try { pin = (await readFile(pinPath, 'utf8')).trim().split(/\s+/)[0]; }
  catch { throw new Error('pi payload: missing or unreadable checked-in pi-payload.sha256'); }
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error('pi payload: invalid pi-payload.sha256');
  if (createHash('sha256').update(bytes).digest('hex') !== pin)
    throw new Error('pi payload: pi-payload.tgz does not match pi-payload.sha256');
  return bytes;
}

// Layout and package declarations, not a claim that the build host is the target.
// The installed launcher separately refuses to start without system Python.
export async function checkLinuxLayout(root, metadataPath, format = 'nfpm') {
  if (!metadataPath || !['nfpm', 'deb-control'].includes(format)) {
    throw new Error('staged Linux runtime: package dependency metadata is required (nfpm or deb-control)');
  }
  let metadata;
  try { metadata = await readFile(metadataPath, 'utf8'); }
  catch { throw new Error('staged Linux runtime: missing package dependency metadata; declare python3 before packaging'); }
  const dependencies = format === 'nfpm'
    ? (metadata.match(/^depends:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? '')
    : (metadata.match(/^Depends:\s*([^\n]*(?:\n[ \t]+[^\n]*)*)/m)?.[1] ?? '');
  const pythonDeclared = format === 'nfpm'
    ? /^\s*-\s*python3\s*(?:#.*)?$/m.test(dependencies)
    : dependencies.split(',').some(part => /^\s*python3(?:\s*\([^)]*\))?\s*$/.test(part));
  if (!pythonDeclared) {
    throw new Error('staged Linux runtime: package must require python3; on Ubuntu install python3 with apt before starting Faravan');
  }
  await executable(join(root, 'runtime/bin/node'), 'bundled Node');
  await executable(join(root, 'bin/faravan'), 'product entrypoint');
  await executable(resolve(root, '../../bin/faravan'), 'faravan launcher');
  await executable(resolve(root, '../../bin/faravan'), 'faravan launcher');
  const pkg = await jsonFile(join(root, 'package.json'), 'runtime package.json');
  const lock = await jsonFile(join(root, 'package-lock.json'), 'runtime package-lock.json');
  if (typeof pkg.name !== 'string' || !pkg.name || !Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 1) {
    throw new Error('staged Linux runtime: invalid runtime package metadata; rebuild the complete package');
  }
  if (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) {
    throw new Error('staged Linux runtime: invalid runtime dependencies');
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.split('/').some(p => p === '.' || p === '..')) {
      throw new Error('staged Linux runtime: invalid dependency name');
    }
    const installed = await jsonFile(join(root, 'node_modules', name, 'package.json'), `installed dependency ${name}`);
    if (installed.name !== name || typeof installed.version !== 'string' || !installed.version) {
      throw new Error(`staged Linux runtime: invalid installed dependency ${name}; rebuild with offline production dependencies`);
    }
  }
}

// Exercise exactly the original product entrypoints and pins. Never enumerate
// or import unrelated modules; the injected loader is for disposable fixtures.
export async function verifyStagedRuntime(root, { loadModule = url => import(url) } = {}) {
  for (const name of ['lib/v1/app.mjs', 'lib/executor.mjs', 'lib/docker-backend.mjs']) {
    await loadModule(pathToFileURL(join(root, name)).href);
  }
  const { loadImagePins, createImageArgs } = await loadModule(pathToFileURL(join(root, 'lib/sbx-image-pins.mjs')).href);
  const pins = loadImagePins();
  for (const agent of ['claude', 'codex']) {
    try { createImageArgs(agent, pins); } catch (error) { throw new Error(`staged sbx image pins: ${agent} is not pinned (${error.message})`); }
  }
  await stat(join(root, 'kits/wf-gh-cli/spec.yaml'));
  await stat(join(root, 'kits/wf-claude-account/spec.yaml'));
  await stat(join(root, 'kits/wf-pi/spec.yaml'));
  await stat(join(root, 'kits/wf-pi/faravan-pi.sh'));
  // The pi payload ships inside the kit and must match its pin: the sandbox has no registry access to fetch it.
  const piFiles = join(root, 'kits/wf-pi/files/home/.faravan');
  await stat(join(piFiles, 'install-pi.sh'));
  await verifiedPiPayload(join(piFiles, 'pi-payload.tgz'), join(piFiles, 'pi-payload.sha256'));
  JSON.parse(await readFile(join(root, 'profiles/faravan-docker.json'), 'utf8'));
  for (const name of ['index.html', 'app.mjs', 'app.css']) await stat(join(root, 'public/v1', name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--pi-payload') {
      if (![5, 6].includes(process.argv.length)) throw new Error('usage: --pi-payload PAYLOAD PIN [DEST]');
      const bytes = await verifiedPiPayload(process.argv[3], process.argv[4]);
      if (process.argv[5]) await writeFile(process.argv[5], bytes, {mode:0o644});
      console.log('pinned Linux guest pi payload: ok');
    } else {
      if (!process.argv[2]) throw new Error('staged runtime root is required');
      const root = resolve(process.argv[2]);
      const mode = process.argv[3];
      if (mode && mode !== '--linux-package') throw new Error('unknown staged-runtime verification mode');
      if (mode) await checkLinuxLayout(root, process.argv[4], process.argv[5] ?? 'nfpm');
      await verifyStagedRuntime(root);
      console.log(mode ? 'staged Linux package layout and entrypoints: ok; target Python availability is checked at launch' : 'staged runtime entrypoints: ok');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
