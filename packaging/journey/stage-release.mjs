#!/usr/bin/env node
// Stages the journey's release for the installer. The manifest is signed by a key made for this run, and the
// installer copy trusts only that key. The real update key is never read here, and the private key is never written.
//
//   node packaging/journey/stage-release.mjs --tarball MEDIA/faravan_linux_amd64.tar.gz --version 0.1.0 \
//        --media MEDIA --installer bin/faravan-install.sh --out DIR
import {generateKeyPairSync} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {buildSignedManifest} from '../sign-update.mjs';

const TARBALL_NAME = 'faravan_linux_amd64.tar.gz';

export async function stageSignedRelease({tarball, version, media, installerSource, out}) {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({type: 'pkcs8', format: 'pem'});
  const publicPem = publicKey.export({type: 'spki', format: 'pem'}).trimEnd();
  const archive = await readFile(tarball);
  const url = 'https://journey.invalid/' + TARBALL_NAME;
  // The tarball is listed as a linux asset as well as the top-level tarball, so the journey exercises the same check a real release passes.
  const {bytes, signature} = buildSignedManifest({tarball: archive, version, tarballUrl: url, privateKeyPem,
    assets: [{archive, platform: 'linux', arch: 'x64', kind: 'tarball', channel: 'faravan', url}]});
  await mkdir(media, {recursive: true});
  await writeFile(join(media, 'update.json'), bytes);
  await writeFile(join(media, 'update.json.sig'), signature);
  const source = await readFile(installerSource, 'utf8');
  const script = source.replace(/UPDATE_PUBLIC_KEY_PEM='[^']*'/, () => `UPDATE_PUBLIC_KEY_PEM='${publicPem}'`);
  if (script === source) throw new Error('the installer does not embed UPDATE_PUBLIC_KEY_PEM');
  await mkdir(out, {recursive: true});
  const installer = join(out, 'faravan-install.sh');
  await writeFile(installer, script, {mode: 0o755});
  return {installer, manifest: join(media, 'update.json')};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {tarball: {type: 'string'}, version: {type: 'string'}, media: {type: 'string'},
    installer: {type: 'string'}, out: {type: 'string'}}});
  if (!values.tarball || !values.version || !values.media || !values.installer || !values.out) {
    console.error('usage: stage-release.mjs --tarball F --version V --media DIR --installer SCRIPT --out DIR');
    process.exit(2);
  }
  const staged = await stageSignedRelease({tarball: values.tarball, version: values.version, media: values.media,
    installerSource: values.installer, out: values.out});
  console.log(staged.installer);
}
