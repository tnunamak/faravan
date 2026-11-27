#!/usr/bin/env node
// Writes update.json and update.json.sig for release artifacts. The release owner
// runs this with the existing private update key off CI, then publishes the pair.
// This tool only writes files into --out; it uploads nothing.
//
//   node packaging/sign-update.mjs --tarball faravan_0.2.0_linux_amd64.tar.gz --version 0.2.0 \
//        --key update-private.pem --out dist [--tarball-url https://.../faravan_0.2.0_linux_amd64.tar.gz] [--asset-map assets.json]
// The optional asset map is a JSON array of {file,platform,arch,kind,channel,bundleId,url};
// file paths are resolved relative to the map, and each named archive is hashed into the signature.
//
// Direct dual-platform preview options: --mac-zip F --mac-url HTTPS_URL
// --mac-channel INSTALL_LABEL --mac-bundle-id ID --linux-channel INSTALL_LABEL
// [--linux-arch x64|arm64]. Use the existing key; see packaging/apt/README.md.
// A .deb is signed as the top-level deb object beside the tarball, not as an asset: --deb F [--deb-arch x64|arm64],
// with --linux-channel. The object carries the file's own size, sha256 and file name. One .deb per manifest.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {validateManifestAssets} from '../lib/v1/update-assets.mjs';
import {parseUpdateVersion} from '../lib/v1/macos-update-version.mjs';

export function buildSignedManifest({tarball, version, tarballUrl, privateKeyPem, releasedAt = new Date(), notes, releaseNotesUrl, assets, deb, sourceSha}) {
  if(!parseUpdateVersion(version))throw new Error('Invalid update version');
  const manifest = {schema: 1, version, tarball: tarballUrl, sha256: createHash('sha256').update(tarball).digest('hex'),
    size: tarball.length, released: releasedAt.toISOString()};
  if(sourceSha!==undefined) {
    if(typeof sourceSha!=='string'||! /^[0-9a-f]{40}$/.test(sourceSha))throw new Error('sourceSha must be a full 40-character source commit');
    manifest.sourceSha=sourceSha;
  }
  if(assets!==undefined) {
    if(!Array.isArray(assets))throw new Error('Update assets must be an array');
    manifest.assets_schema=1;
    manifest.assets=assets.map(({archive,...metadata})=>{
      if(!Buffer.isBuffer(archive))throw new Error('Each update asset needs archive bytes');
      return {...metadata,size:archive.length,sha256:createHash('sha256').update(archive).digest('hex')};
    });
  }
  if (deb !== undefined) {
    if (!deb || !Buffer.isBuffer(deb.archive)) throw new Error('The .deb needs its bytes');
    manifest.deb = {arch: deb.arch, channel: deb.channel, size: deb.archive.length,
      sha256: createHash('sha256').update(deb.archive).digest('hex'), file: deb.file};
  }
  validateManifestAssets(manifest);
  if (notes !== undefined) {
    const text = Array.isArray(notes) ? notes.join('\n') : notes;
    if (typeof text !== 'string' || text.length > 16_000) throw new Error('Release notes must be text of at most 16000 characters');
    manifest.notes = text;
  }
  if (releaseNotesUrl !== undefined) {
    const url = new URL(releaseNotesUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Release notes URL must use HTTPS without credentials');
    manifest.release_notes_url = url.href;
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  return {bytes, signature: sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64') + '\n'};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {tarball: {type: 'string'}, version: {type: 'string'}, key: {type: 'string'}, out: {type: 'string'}, 'tarball-url': {type: 'string'}, 'notes-file': {type: 'string'}, 'release-notes-url': {type: 'string'}, 'asset-map': {type: 'string'},
    'mac-zip': {type:'string'}, 'mac-url': {type:'string'}, 'mac-channel': {type:'string'}, 'mac-bundle-id': {type:'string'},
    'linux-channel': {type:'string'}, 'linux-arch': {type:'string'}, deb: {type:'string'}, 'deb-arch': {type:'string'}, 'source-sha': {type:'string'}}});
  if (!values.tarball || !values.version || !values.key || !values.out) { console.error('usage: sign-update.mjs --tarball F --version VERSION --key PRIVATE.pem --out DIR [--tarball-url URL] [--notes-file F] [--release-notes-url URL] [--asset-map F | --mac-zip F --mac-url URL --mac-channel LABEL --mac-bundle-id ID] [--linux-channel LABEL --linux-arch ARCH] [--deb F --deb-arch ARCH] [--source-sha COMMIT]'); process.exit(2); }
  let assets, deb;
  const macOptions=['mac-zip','mac-url','mac-channel','mac-bundle-id'];
  if(macOptions.some(k=>values[k]!==undefined)) {
    if(macOptions.some(k=>!values[k])||values['asset-map'])throw new Error('Use all four --mac-* options, without --asset-map');
    assets=[{archive:await readFile(values['mac-zip']),platform:'darwin',arch:'arm64',kind:'macos-app-zip',
      channel:values['mac-channel'],bundleId:values['mac-bundle-id'],url:values['mac-url']}];
  }
  if(values['asset-map']) {
    const file=resolve(values['asset-map']), map=JSON.parse(await readFile(file,'utf8'));
    if(!Array.isArray(map)||map.length<1||map.length>16)throw new Error('Invalid asset map');
    assets=await Promise.all(map.map(async row=>{
      const keys=['file','platform','arch','kind','channel','bundleId','url'];
      if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==keys.length||keys.some(k=>typeof row[k]!=='string'||!row[k]))throw new Error('Invalid asset map entry');
      const {file:archiveFile,...metadata}=row;
      return {...metadata,archive:await readFile(resolve(dirname(file),archiveFile))};
    }));
  }
  const tarball=await readFile(values.tarball),tarballUrl=values['tarball-url']??basename(values.tarball);
  if(values['linux-channel']) {
    assets=[...(assets??[]),{archive:tarball,platform:'linux',arch:values['linux-arch']??'x64',kind:'tarball',
      channel:values['linux-channel'],url:tarballUrl}];
  } else if(values.version.includes('-preview.'))throw new Error('Preview signing requires --linux-channel');
  if (values.deb) {
    if(!values['linux-channel'])throw new Error('Signing a .deb needs --linux-channel');
    deb={archive:await readFile(values.deb),arch:values['deb-arch']??'x64',channel:values['linux-channel'],file:basename(values.deb)};
  }
  const {bytes, signature} = buildSignedManifest({tarball, version: values.version,
    tarballUrl, privateKeyPem: await readFile(values.key, 'utf8'),
    assets, deb, sourceSha:values['source-sha'], notes: values['notes-file'] ? await readFile(values['notes-file'], 'utf8') : undefined, releaseNotesUrl: values['release-notes-url']});
  await mkdir(values.out, {recursive: true});
  await writeFile(join(values.out, 'update.json'), bytes);
  await writeFile(join(values.out, 'update.json.sig'), signature);
  console.log('wrote update.json and update.json.sig in ' + values.out);
}
