import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Give the real stager and validator a disposable checkout with an independently
// pinned guest archive. A no-op npm cannot build the checked-in guest payload,
// and these tests exercise staging, not the Linux-only guest dependency build.
export function stagingFixture(work) {
  const checkout = join(work, 'checkout');
  for (const path of [
    'packaging/stage-app.sh', 'packaging/check-staged-runtime.mjs',
    'bin', 'lib', 'kits', 'public', 'docs/protocol',
    'docs/security/credential-proxy-evidence.json', 'profiles/faravan-docker.json',
    'package.json', 'package-lock.json', 'LICENSE.md',
  ]) {
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(root, path), destination, {recursive: true, verbatimSymlinks: true});
  }
  const vendor = join(root, 'vendor');
  if (existsSync(vendor)) {
    cpSync(vendor, join(checkout, 'vendor'), {recursive: true, verbatimSymlinks: true});
  }

  const guest = join(work, 'guest');
  const module = join(guest, 'node_modules', 'fixture-pi');
  mkdirSync(module, {recursive: true});
  writeFileSync(join(module, 'package.json'), '{"name":"fixture-pi","version":"0.0.0"}\n');
  const payload = join(work, 'pi-payload.tgz');
  execFileSync('tar', ['-czf', payload, '-C', guest, 'node_modules'], {stdio: 'pipe'});
  const digest = createHash('sha256').update(readFileSync(payload)).digest('hex');
  writeFileSync(join(checkout, 'kits/wf-pi/files/home/.faravan/pi-payload.sha256'), digest + '\n');
  return {stage: join(checkout, 'packaging/stage-app.sh'), payload};
}
