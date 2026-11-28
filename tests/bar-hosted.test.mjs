import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {candidateAsset,verifyDownload} from '../scripts/bar-hosted-install.mjs';

const sha='a'.repeat(40),bytes=Buffer.from('candidate package');
const deb={file:'faravan.deb',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const mac={...deb,url:'https://example.test/faravan.zip',platform:'darwin',arch:'universal',kind:'macos-app-zip'};
const manifest={sourceSha:sha,tarball:'https://example.test/faravan.tar.gz',deb,assets:[mac]};
test('hosted install requires this commit and a package for the actual runner architecture',()=>{
  assert.equal(candidateAsset(manifest,sha,'linux','x64').url,'https://example.test/faravan.deb');
  assert.equal(candidateAsset(manifest,sha,'darwin','arm64'),mac);
  assert.equal(candidateAsset(manifest,sha,'darwin','x64'),mac);
  assert.throws(()=>candidateAsset(manifest,'b'.repeat(40),'linux','x64'),/workflow commit/);
  assert.throws(()=>candidateAsset({...manifest,deb:null},sha,'linux','x64'),/no package/);
  assert.throws(()=>candidateAsset(manifest,sha,'linux','arm64'),/no package/);
  assert.throws(()=>candidateAsset({...manifest,assets:[{...mac,arch:'arm64'}]},sha,'darwin','x64'),/no package/);
});
test('hosted install refuses corrupted or incomplete package downloads before installation',()=>{
  verifyDownload(bytes,deb);
  assert.throws(()=>verifyDownload(Buffer.alloc(bytes.length),deb),/package hash/);
  assert.throws(()=>verifyDownload(bytes.subarray(1),deb),/package size/);
});

test('the integration branch triggers both hosted entry points on the Linux and macOS matrix',()=>{
  const read=name=>readFileSync(new URL('../.github/workflows/'+name,import.meta.url),'utf8');
  const install=read('bar-install.yml');
  const borrow=read('bar-join-borrow.yml');
  for (const [name,workflow] of [['install',install],['join and borrow',borrow]]) {
    const triggers=workflow.match(/^on:\n((?:[ ]+[^\n]*\n)+)/m)?.[1]??'';
    assert.match(triggers,/^  push:\n    branches: \[ff\/t1-integ-1127, 'bar-hosted-\*'\]$/m,name);
  }
  assert.match(install,/^  workflow_call:$/m);
  assert.match(install,/^          - platform: Linux\n            runner: ubuntu-latest$/m);
  assert.match(install,/^          - platform: macOS\n            runner: macos-latest$/m);
  assert.match(install,/^    runs-on: \$\{\{ matrix\.runner \}\}$/m);
  assert.match(borrow,/^    uses: \.\/\.github\/workflows\/bar-install\.yml\n    with:\n      join-borrow: true$/m);
});
