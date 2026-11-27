import '../helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const install=read('docs/install.md');
test('all teammate guides point to the same desktop installation steps',()=>{
  for(const path of ['docs/team-onboarding.md','docs/mac-quickstart.md','docs/linux-quickstart.md'])
    assert.match(read(path),/\(install\.md#(?:mac|linux)\)/,path);
});
test('Mac installation names Finder approval and Local Network controls without manual hashing',()=>{
  const mac=install.split('## Mac')[1].split('## Linux')[0];
  for(const phrase of ['Faravan.app','Applications','Privacy & Security','Open Anyway','**Open**','**Allow**'])
    assert.ok(mac.includes(phrase),phrase);
  assert.match(mac,/managed Mac may block this preview/);
  assert.doesNotMatch(install,/shasum|sha256sum|curl|Open Terminal/);
});
test('Linux installation offers the Debian app package and names missing-download recovery',()=>{
  assert.match(install,/\.deb.*missing/);
  const linux=install.split('## Linux')[1].split('## After opening')[0];
  for(const phrase of ['Discover','**Install**','password prompt','applications menu'])assert.ok(linux.includes(phrase),phrase);
  assert.match(install,/First downloads use GitHub's HTTPS connection/);
});
