// Synthetic macOS bundle pieces for offline packaging tests. The bytes are real Mach-O, fat and icns
// headers, so the checks in packaging/macos/bundle-tool.mjs parse them for real; they are not runnable
// programs. Nothing here proves native compilation, lipo, codesign or LaunchServices behaviour.
import { mkdir, writeFile, readFile, readdir, chmod, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const CPU = {arm64: 0x0100000c, x86_64: 0x01000007};

// A 64-bit little-endian Mach-O header followed by a tag, so two slices of one file differ in content.
export function machO(arch, tag = '') {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(CPU[arch], 4);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  return Buffer.concat([header, Buffer.from(arch + ':' + tag)]);
}

// The fat layout lipo writes: big-endian header, one entry per slice, slices aligned to 2^14.
export function fatMachO(slices) {
  const align = 14, step = 1 << align;
  const archOf = slice => slice.readUInt32LE(4);
  let offset = step;
  const entries = slices.map(slice => { const entry = {cpu: archOf(slice), offset, size: slice.length}; offset += Math.ceil(slice.length / step) * step; return entry; });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(0xcafebabe, 0);
  out.writeUInt32BE(slices.length, 4);
  entries.forEach((entry, i) => {
    const at = 8 + i * 20;
    out.writeUInt32BE(entry.cpu, at); out.writeUInt32BE(0, at + 4);
    out.writeUInt32BE(entry.offset, at + 8); out.writeUInt32BE(entry.size, at + 12); out.writeUInt32BE(align, at + 16);
    slices[i].copy(out, entry.offset);
  });
  return out;
}

// An icns container holding PNG entries, keyed the way iconutil names an .iconset.
const ICNS_TYPES = {'icon_16x16.png': 'icp4', 'icon_16x16@2x.png': 'ic11', 'icon_32x32.png': 'icp5', 'icon_32x32@2x.png': 'ic12',
  'icon_128x128.png': 'ic07', 'icon_128x128@2x.png': 'ic13', 'icon_256x256.png': 'ic08', 'icon_256x256@2x.png': 'ic14',
  'icon_512x512.png': 'ic09', 'icon_512x512@2x.png': 'ic10'};
export function icns(entries) {
  const parts = entries.map(([type, data]) => { const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32BE(data.length + 8, 4); return Buffer.concat([head, data]); });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}
export async function icnsFromIconset(dir) {
  const names = (await readdir(dir)).filter(name => ICNS_TYPES[name]).sort();
  return icns(await Promise.all(names.map(async name => [ICNS_TYPES[name], await readFile(join(dir, name))])));
}

// Writes executable stand-ins for Apple tools into DIR. lipo and iconutil produce real fat/icns bytes.
export async function fakeAppleTools(dir) {
  await mkdir(dir, {recursive: true});
  const helper = new URL(import.meta.url).href;
  // These bytes are synthetic: never send them through real Apple tools on a macOS test host.
  // Native compilation/verification runs against build-app.sh output in its own CI step.
  await writeFile(join(dir, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; *) exit 2;; esac\n', {mode: 0o755});
  await writeFile(join(dir, 'lipo'), `#!${process.execPath}
import { readFile, writeFile } from 'node:fs/promises';
import { fatMachO } from ${JSON.stringify(helper)};
const args = process.argv.slice(2), out = args[args.indexOf('-output') + 1];
if (args[0] !== '-create' || !out) { console.error('fake lipo: only -create IN... -output OUT'); process.exit(64); }
const inputs = args.slice(1, args.indexOf('-output'));
await writeFile(out, fatMachO(await Promise.all(inputs.map(path => readFile(path)))));
if (process.env.FAKE_TOOL_LOG) await writeFile(process.env.FAKE_TOOL_LOG, 'lipo ' + args.join(' ') + '\\n', {flag: 'a'});
`, {mode: 0o755});
  await writeFile(join(dir, 'iconutil'), `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
import { icnsFromIconset } from ${JSON.stringify(helper)};
const args = process.argv.slice(2);
if (args[0] !== '-c' || args[1] !== 'icns' || args[2] !== '-o') { console.error('fake iconutil: only -c icns -o OUT DIR'); process.exit(64); }
await writeFile(args[3], await icnsFromIconset(args[4]));
`, {mode: 0o755});
  await writeFile(join(dir, 'clang'), `#!${process.execPath}
import { writeFile, chmod } from 'node:fs/promises';
import { basename } from 'node:path';
import { machO } from ${JSON.stringify(helper)};
const args = process.argv.slice(2);
const target = args[args.indexOf('-target') + 1];
const out = args[args.indexOf('-o') + 1];
const arch = target?.split('-')[0];
if (args.length !== 6 || args[0] !== '-O2' || args[1] !== '-target' || args[3] !== '-o'
    || !['arm64', 'x86_64'].includes(arch) || !/^apple-macos[0-9.]+$/.test(target.slice(arch.length + 1))
    || basename(out ?? '') !== 'faravan-update-exchange' || basename(args[5]) !== 'update-exchange.c') {
  console.error('fake clang: expected the named update-exchange target'); process.exit(64);
}
await writeFile(out, machO(arch, 'update-exchange.c')); await chmod(out, 0o755);
if (process.env.MAC_BUILD_LOG) await writeFile(process.env.MAC_BUILD_LOG,
  ['clang', process.cwd(), target, out, args[5]].join('|') + '\\n', {flag: 'a'});
`, {mode: 0o755});
  return dir;
}

export const MIN_MACOS = '14.0';
async function plist(template, version) {
  return (await readFile(join(root, template), 'utf8')).replaceAll('@@VERSION@@', version).replaceAll('@@MIN_MACOS@@', MIN_MACOS).replaceAll('@@BUNDLE_ID@@', 'com.faravan.app').replaceAll('@@HELPER_BUNDLE_ID@@', 'com.faravan.app.notify').replaceAll('@@APP_NAME@@', 'Faravan');
}
async function put(path, data, mode = 0o644) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, data);
  await chmod(path, mode);
}

// A complete Faravan.app as one native leg (arm64 or x86_64) or a merged universal bundle would look.
export async function makeApp(dir, {arch = 'arm64', version = '0.0.1', runtimeLicense = 'Node.js is licensed for use as follows: (fixture)\n'} = {}) {
  const app = join(dir, 'Faravan.app'), contents = join(app, 'Contents'), res = join(contents, 'Resources/faravan');
  const binary = name => arch === 'universal' ? fatMachO([machO('arm64', name), machO('x86_64', name)]) : machO(arch, name);
  await put(join(contents, 'Info.plist'), await plist('packaging/macos/Info.plist', version));
  await put(join(contents, 'MacOS/faravan-launch'), binary('launch'), 0o755);
  await put(join(contents, 'MacOS/faravan-tray'), binary('tray'), 0o755);
  await put(join(contents, 'MacOS/faravan-process-identity'), binary('identity'), 0o755);
  await put(join(contents, 'MacOS/faravan-update-exchange'), binary('exchange'), 0o755);
  const cliLauncher = await readFile(join(root, 'packaging/macos/launcher/cli.sh'), 'utf8');
  await put(join(contents, 'MacOS/faravan'), cliLauncher, 0o755);
  await put(join(contents, 'MacOS/faravan'), cliLauncher, 0o755);
  const helper = join(contents, 'Helpers/FaravanNotify.app/Contents');
  await put(join(helper, 'Info.plist'), await plist('packaging/macos/notify/Info.plist', version));
  await put(join(helper, 'MacOS/faravan-notify'), binary('notify'), 0o755);
  const icon = icns([['ic07', Buffer.from('png-128')], ['ic10', Buffer.from('png-1024')]]);
  await put(join(helper, 'Resources/Faravan.icns'), icon);
  await put(join(contents, 'Resources/Faravan.icns'), icon);
  await put(join(res, 'runtime/bin/node'), binary('node'), 0o755);
  await put(join(res, 'runtime/LICENSE'), runtimeLicense);
  await put(join(res, 'channel.json'), '{"id":"faravan","name":"Faravan","bundleId":"com.faravan.app","helperBundleId":"com.faravan.app.notify"}\n');
  await put(join(res, 'bin/faravan'), '#!/usr/bin/env node\n', 0o755);
  await put(join(res, 'lib/v1/app.mjs'), 'export {};\n');
  // npm writes relative bin links like this one; they must survive the merge as links.
  await put(join(res, 'node_modules/tool/cli.js'), '#!/usr/bin/env node\n', 0o755);
  await mkdir(join(res, 'node_modules/.bin'), {recursive: true});
  await symlink('../tool/cli.js', join(res, 'node_modules/.bin/tool'));
  await put(join(res, 'VERSION'), version + '\n');
  return app;
}
