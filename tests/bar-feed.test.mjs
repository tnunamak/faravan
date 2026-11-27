import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readManifest,manifestCommit} from '../scripts/bar-feed.mjs';

test('feed verifies exact HTTP bytes and requires a commit for comparison',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const manifest={schema:1,version:'1.2.3',tarball:'https://example.invalid/build.tar.gz',sha256:'a'.repeat(64),size:1,sourceSha:'b'.repeat(40)};
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');
  const signature=sign(null,bytes,privateKey).toString('base64');
  const read=body=>async url=>new Response(url.endsWith('.sig')?signature:body);
  const options={publicKey:publicKey.export({format:'pem',type:'spki'})};
  assert.deepEqual(await readManifest('https://example.invalid/update.json',{...options,fetch:read(bytes)}),manifest);
  await assert.rejects(readManifest('https://example.invalid/update.json',{...options,fetch:read(bytes.toString().trim())}),/not signed/);
  assert.equal(manifestCommit(manifest),'b'.repeat(40));
  assert.throws(()=>manifestCommit({}),/sourceSha/);
});
test('HTTP failure cannot pass as a manifest',async()=>{
  await assert.rejects(readManifest('https://example.invalid/update.json',{fetch:async()=>new Response('',{status:404})}),/HTTP 404/);
});
