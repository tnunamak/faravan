#!/usr/bin/env node
// Byte-level checks for Faravan.app that need no Apple tool, so they behave the same on the build Mac and in
// offline tests. The shell scripts beside this file run the native tools (swiftc, go, iconutil, lipo,
// codesign); this file decides what is allowed.
//
//   node bundle-tool.mjs compare ARM64_APP X86_64_APP   print the Mach-O paths to merge; refuse any other difference
//   node bundle-tool.mjs verify APP --arch arm64|x86_64|universal [--allow-dev-runtime]
//   node bundle-tool.mjs sign-plan APP                  print "entitlements|plain<TAB>path", inside out
//   node bundle-tool.mjs archs FILE                     print the architectures of one Mach-O file
import { readFile, readdir, lstat, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// The bundle contract shared with the launcher (packaging/macos/launcher) and the tray.
export const CONTRACT = {
  id: 'com.faravan.app', executable: 'faravan-launch', cli: 'faravan', tray: 'faravan-tray', icon: 'Faravan',
  helper: 'Contents/Helpers/FaravanNotify.app', helperId: 'com.faravan.app.notify', helperExecutable: 'faravan-notify',
  runtime: 'Contents/Resources/faravan/runtime',
};
export function bundleIdentity(channel = {}) {
  return {
    name: channel.name || 'Faravan',
    id: channel.bundleId || 'com.faravan.app',
    helperId: channel.helperBundleId || 'com.faravan.app.notify',
  };
}
const helperBinary = `${CONTRACT.helper}/Contents/MacOS/${CONTRACT.helperExecutable}`;
// Every Mach-O file the bundle may hold, in signing order (inside out). A new native file (a dylib, a .node
// addon) must be added here, or verification fails: it would otherwise ship unmerged or unsigned.
export const MACHO_INVENTORY = [
  {path: `${CONTRACT.runtime}/bin/node`, sign: `${CONTRACT.runtime}/bin/node`, entitlements: true}, // V8 needs the JIT entitlements
  {path: helperBinary, sign: CONTRACT.helper},
  {path: `Contents/MacOS/${CONTRACT.tray}`, sign: `Contents/MacOS/${CONTRACT.tray}`},
  {path: 'Contents/MacOS/faravan-process-identity', sign: 'Contents/MacOS/faravan-process-identity'},
  {path: 'Contents/MacOS/faravan-update-exchange', sign: 'Contents/MacOS/faravan-update-exchange'},
  {path: `Contents/MacOS/${CONTRACT.executable}`, sign: '.'}, // the main executable is signed with the bundle
];
const MACOS_ENTRIES = [CONTRACT.executable, CONTRACT.cli, CONTRACT.tray, 'faravan', 'faravan-process-identity', 'faravan-update-exchange'];
const DEV_RUNTIME = 'development runtime'; // what bundle-node.sh writes for FARAVAN_NODE_BIN

export class BundleError extends Error {
  constructor(problems) { super(problems.join('\n')); this.problems = problems; }
}

const CPU = {0x0100000c: 'arm64', 0x01000007: 'x86_64', 0x0200000c: 'arm64_32', 7: 'i386', 12: 'arm'};
const cpuName = cpu => CPU[cpu >>> 0] ?? 'cpu-0x' + (cpu >>> 0).toString(16);
function thin(buffer) {
  if (buffer.length < 8) return null;
  const le = buffer.readUInt32LE(0), be = buffer.readUInt32BE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) return cpuName(buffer.readUInt32LE(4));
  if (be === 0xfeedfacf || be === 0xfeedface) return cpuName(buffer.readUInt32BE(4));
  return null;
}

// {fat, archs} for a Mach-O file, null for anything else. A malformed fat file throws: it is never "not binary".
export function machOArchs(buffer) {
  const single = thin(buffer);
  if (single) return {fat: false, archs: [single]};
  if (buffer.length < 8) return null;
  const magic = buffer.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null;
  const count = buffer.readUInt32BE(4), wide = magic === 0xcafebabf, size = wide ? 32 : 20;
  if (count === 0 || count > 30) return null; // a Java class file has the same magic and a version number here
  if (8 + count * size > buffer.length) throw new Error('fat header truncated');
  const archs = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * size, arch = cpuName(buffer.readUInt32BE(at));
    const offset = wide ? Number(buffer.readBigUInt64BE(at + 8)) : buffer.readUInt32BE(at + 8);
    const length = wide ? Number(buffer.readBigUInt64BE(at + 16)) : buffer.readUInt32BE(at + 12);
    if (offset + length > buffer.length) throw new Error(`slice ${i} (${arch}) lies outside the file`);
    const inner = thin(buffer.subarray(offset, offset + length));
    if (inner !== arch) throw new Error(`slice ${i} says ${arch} but holds ${inner ?? 'no Mach-O'}`);
    archs.push(arch);
  }
  return {fat: true, archs: archs.sort()};
}

// The flat <dict> of strings and booleans our Info.plist templates use. Anything else is refused.
export function parsePlist(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').match(/<plist[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/);
  if (!body) throw new Error('not a property list with a top-level dict');
  const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const out = {}, token = /\s*<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\/>)/y;
  let rest = body[1], match;
  while (rest.trim()) {
    token.lastIndex = 0;
    if (!(match = token.exec(rest))) throw new Error('unsupported plist content near: ' + rest.trim().slice(0, 60));
    out[unescape(match[1])] = match[3] ? match[3] === 'true' : unescape(match[2]);
    rest = rest.slice(token.lastIndex);
  }
  return out;
}

// Every entry under DIR by relative POSIX path, without following symlinks.
async function walk(dir) {
  const entries = new Map();
  async function visit(rel) {
    for (const entry of await readdir(rel ? join(dir, rel) : dir)) {
      const path = rel ? rel + '/' + entry : entry, abs = join(dir, path), info = await lstat(abs);
      const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special file';
      entries.set(path, {abs, type, mode: info.mode & 0o777, target: type === 'symlink' ? await readlink(abs) : undefined});
      if (type === 'directory') await visit(path);
    }
  }
  await visit('');
  return entries;
}
function symlinkProblem(path, target) {
  if (target.startsWith('/')) return `${path}: symlink to ${target} is absolute`;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === '..' || resolved.startsWith('../')) return `${path}: symlink to ${target} leaves the bundle`;
  return null;
}
const octal = mode => mode.toString(8);
const machOOf = async (abs, path, problems) => { try { return machOArchs(await readFile(abs)); } catch (error) { problems.push(`${path}: malformed Mach-O (${error.message})`); return undefined; } };

// Two native legs may differ only in Mach-O contents, and each must be a thin binary of its own architecture.
export async function compareLegs(armApp, x64App) {
  const legs = {arm64: await walk(armApp), x86_64: await walk(x64App)}, problems = [], machO = [];
  for (const [arch, entries] of Object.entries(legs)) {
    for (const path of entries.keys()) {
      if (path.includes('\n')) problems.push(`${JSON.stringify(path)}: a path with a newline`);
      if (path.split('/').includes('_CodeSignature')) problems.push(`${path}: legs must be unsigned: sign after merging, never before`);
    }
    const license = entries.get(`${CONTRACT.runtime}/LICENSE`);
    if (license && (await readFile(license.abs, 'utf8')).includes(DEV_RUNTIME))
      problems.push(`${CONTRACT.runtime}/LICENSE: development Node runtime in the ${arch} leg; it is never released`);
  }
  const paths = [...new Set([...legs.arm64.keys(), ...legs.x86_64.keys()])].sort();
  for (const path of paths) {
    const a = legs.arm64.get(path), b = legs.x86_64.get(path);
    if (!a || !b) { problems.push(`${path}: only in ${a ? 'arm64' : 'x86_64'}`); continue; }
    if (a.type !== b.type) { problems.push(`${path}: ${a.type} in arm64, ${b.type} in x86_64`); continue; }
    if (a.type === 'special file') { problems.push(`${path}: a special file`); continue; }
    if (a.type === 'symlink') {
      if (a.target !== b.target) problems.push(`${path}: symlink targets differ (${a.target} vs ${b.target})`);
      else { const problem = symlinkProblem(path, a.target); if (problem) problems.push(problem); }
      continue;
    }
    if (a.mode !== b.mode) problems.push(`${path}: modes differ (${octal(a.mode)} vs ${octal(b.mode)})`);
    if (a.type !== 'file') continue;
    const [ma, mb] = [await machOOf(a.abs, path, problems), await machOOf(b.abs, path, problems)];
    if (ma === undefined || mb === undefined) continue;
    if (!ma && !mb) {
      if (!(await readFile(a.abs)).equals(await readFile(b.abs))) problems.push(`${path}: contents differ`);
    } else if (!ma || !mb) problems.push(`${path}: Mach-O in ${ma ? 'arm64' : 'x86_64'} only`);
    else if (ma.fat || mb.fat) problems.push(`${path}: ${ma.fat ? 'arm64' : 'x86_64'} leg is already fat; merge native thin legs`);
    else if (ma.archs[0] !== 'arm64') problems.push(`${path}: arm64 leg has ${ma.archs[0]}`);
    else if (mb.archs[0] !== 'x86_64') problems.push(`${path}: x86_64 leg has ${mb.archs[0]}`);
    else machO.push(path);
  }
  if (problems.length) throw new BundleError(problems);
  return {machO};
}

function icnsProblem(buffer) {
  if (buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'icns' || buffer.readUInt32BE(4) !== buffer.length) return 'not an icns file';
  const types = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.length - at >= 8 ? buffer.readUInt32BE(at + 4) : 0;
    if (length < 8 || at + length > buffer.length) return 'not an icns file (bad entry)';
    types.push(buffer.toString('latin1', at, at + 4));
    at += length;
  }
  return types.includes('ic10') ? null : 'no 1024-pixel (ic10) image';
}

const NEEDS = {arm64: ['arm64'], x86_64: ['x86_64'], universal: ['arm64', 'x86_64']};
// Checks a built bundle against the contract. Returns {inventory, notes}; throws BundleError listing every problem.
export async function verifyApp(app, {arch, allowDevRuntime = false}) {
  const needs = NEEDS[arch];
  if (!needs) throw new BundleError([`unknown architecture ${arch}; use arm64, x86_64 or universal`]);
  const problems = [], notes = [], inventory = [];
  let channel = {};
  try { channel = JSON.parse(await readFile(join(app, 'Contents/Resources/faravan/channel.json'), 'utf8')); } catch {}
  const identity = bundleIdentity(channel);
  const read = async (path, encoding) => readFile(join(app, path), encoding).catch(() => { problems.push(`${path}: missing`); return null; });
  const mode = async path => (await lstat(join(app, path)).catch(() => null))?.mode ?? 0;

  const plists = {};
  for (const [path, expected] of [['Contents/Info.plist', {CFBundleIdentifier: identity.id, CFBundleExecutable: CONTRACT.executable, CFBundleName: identity.name, CFBundleDisplayName: identity.name}],
    [`${CONTRACT.helper}/Contents/Info.plist`, {CFBundleIdentifier: identity.helperId, CFBundleExecutable: CONTRACT.helperExecutable, CFBundleName: `${identity.name}Notify`, CFBundleDisplayName: identity.name}]]) {
    const xml = await read(path, 'utf8');
    if (xml === null) continue;
    const left = xml.match(/@@[A-Z_]+@@/);
    if (left) { problems.push(`${path}: unfilled placeholder ${left[0]}`); continue; }
    let plist;
    try { plist = parsePlist(xml); } catch (error) { problems.push(`${path}: ${error.message}`); continue; }
    plists[path] = plist;
    for (const [key, value] of Object.entries({...expected, CFBundleIconFile: CONTRACT.icon, CFBundlePackageType: 'APPL', LSUIElement: true}))
      if (plist[key] !== value) problems.push(`${path}: ${key} ${plist[key]}, expected ${value}`);
    if (!/^\d+(\.\d+){1,2}$/.test(plist.LSMinimumSystemVersion ?? '')) problems.push(`${path}: LSMinimumSystemVersion missing`);
    if (plist.CFBundleVersion !== plist.CFBundleShortVersionString) problems.push(`${path}: CFBundleVersion and CFBundleShortVersionString differ`);
    const icon = await read(path.replace(/Info\.plist$/, `Resources/${CONTRACT.icon}.icns`));
    const iconProblem = icon && icnsProblem(icon);
    if (iconProblem) problems.push(`${path.replace(/Info\.plist$/, `Resources/${CONTRACT.icon}.icns`)}: ${iconProblem}`);
  }
  const outer = plists['Contents/Info.plist'], inner = plists[`${CONTRACT.helper}/Contents/Info.plist`];
  const version = (await read('Contents/Resources/faravan/VERSION', 'utf8'))?.trim();
  if (outer && version != null && outer.CFBundleShortVersionString !== version)
    problems.push(`Contents/Info.plist: CFBundleShortVersionString ${outer.CFBundleShortVersionString} but Resources/faravan/VERSION says ${version}`);
  if (outer && inner) for (const key of ['CFBundleShortVersionString', 'LSMinimumSystemVersion'])
    if (outer[key] !== inner[key]) problems.push(`${CONTRACT.helper}/Contents/Info.plist: ${key} ${inner[key]} differs from the app's ${outer[key]}`);

  const macos = await readdir(join(app, 'Contents/MacOS')).catch(() => []);
  for (const entry of macos) if (!MACOS_ENTRIES.includes(entry))
    problems.push(`Contents/MacOS/${entry}: unexpected; Contents/MacOS holds only ${MACOS_ENTRIES.join(', ')}`);
  const cliNames = [CONTRACT.cli, 'faravan'];
  for (const path of [...MACHO_INVENTORY.map(item => item.path), ...cliNames.map(name => `Contents/MacOS/${name}`)]) {
    const m = await mode(path);
    if (!m) problems.push(`${path}: missing`); else if (!(m & 0o111)) problems.push(`${path}: not executable`);
  }
  for (const name of cliNames) {
    const cli = await readFile(join(app, `Contents/MacOS/${name}`), 'utf8').catch(() => null);
    if (cli !== null && (!cli.includes('runtime/bin/node') || /env\s+node/.test(cli)))
      problems.push(`Contents/MacOS/${name}: does not start the bundled runtime`);
  }

  const devRuntime = ((await readFile(join(app, `${CONTRACT.runtime}/LICENSE`), 'utf8').catch(() => '')).includes(DEV_RUNTIME));
  if (devRuntime && !allowDevRuntime) problems.push(`${CONTRACT.runtime}/LICENSE: development Node runtime (FARAVAN_NODE_BIN); it is never released`);
  if (devRuntime && allowDevRuntime) notes.push('DEVELOPMENT runtime: Node was not checked and this bundle is not releasable');

  const listed = new Set(MACHO_INVENTORY.map(item => item.path));
  for (const [path, entry] of await walk(app)) {
    if (entry.type === 'symlink') { const problem = symlinkProblem(path, entry.target); if (problem) problems.push(problem); continue; }
    if (entry.type === 'special file') { problems.push(`${path}: a special file`); continue; }
    if (entry.type !== 'file') continue;
    const skipNode = devRuntime && allowDevRuntime && path === `${CONTRACT.runtime}/bin/node`;
    if (skipNode) continue;
    const found = await machOOf(entry.abs, path, problems);
    if (found === undefined) continue;
    if (!found) { if (listed.has(path)) problems.push(`${path}: not a Mach-O executable`); continue; }
    if (!listed.has(path)) { problems.push(`${path}: Mach-O outside the signing inventory; add it to MACHO_INVENTORY in packaging/macos/bundle-tool.mjs`); continue; }
    if (found.archs.join(' + ') !== needs.join(' + ')) problems.push(`${path}: has ${found.archs.join(' + ')}, needs ${needs.join(' + ')}`);
    inventory.push({path, archs: found.archs});
  }
  if (problems.length) throw new BundleError(problems);
  return {inventory, notes};
}

// What sign-notarize.sh signs, inside out: nested code first, the bundle last.
export function signPlan(app) {
  return [
    ...MACHO_INVENTORY.filter(item => item.sign !== '.').map(item => ({path: join(app, item.sign), entitlements: !!item.entitlements})),
    {path: join(app, `Contents/MacOS/${CONTRACT.cli}`), entitlements: false}, // a script: codesign stores its signature in xattrs
    {path: join(app, 'Contents/MacOS/faravan'), entitlements: false}, // the approved CLI alias is also a script
    {path: app, entitlements: false},
  ];
}

async function main([command, ...args]) {
  const fail = (code, lines) => { for (const line of lines) process.stderr.write(line + '\n'); process.exitCode = code; };
  try {
    if (command === 'compare' && args.length === 2) {
      for (const path of (await compareLegs(args[0], args[1])).machO) process.stdout.write(path + '\n');
    } else if (command === 'verify' && args[1] === '--arch' && args.length >= 3) {
      if (!NEEDS[args[2]]) return fail(2, [`verify: unknown architecture ${args[2]}; use arm64, x86_64 or universal`]);
      const {inventory, notes} = await verifyApp(args[0], {arch: args[2], allowDevRuntime: args.includes('--allow-dev-runtime')});
      for (const item of inventory) process.stdout.write(`  ${item.archs.join(' + ').padEnd(16)} ${item.path}\n`);
      for (const note of notes) process.stdout.write(note + '\n');
    } else if (command === 'sign-plan' && args.length === 1) {
      for (const item of signPlan(args[0])) process.stdout.write(`${item.entitlements ? 'entitlements' : 'plain'}\t${item.path}\n`);
    } else if (command === 'archs' && args.length === 1) {
      const found = machOArchs(await readFile(args[0]));
      if (!found) return fail(1, [`${args[0]}: not a Mach-O file`]);
      process.stdout.write(found.archs.join(' ') + '\n');
    } else return fail(2, ['usage: bundle-tool.mjs compare ARM64_APP X86_64_APP | verify APP --arch ARCH [--allow-dev-runtime] | sign-plan APP | archs FILE']);
  } catch (error) {
    if (error instanceof BundleError) return fail(1, error.problems.map(problem => '  ' + problem));
    throw error;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2));
