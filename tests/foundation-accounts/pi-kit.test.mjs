import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PI_HARNESS} from '../../lib/harnesses/pi.adapter.mjs';

const read=name=>readFileSync(new URL('../../kits/'+name,import.meta.url),'utf8');
const spec=read('wf-pi/spec.yaml'),launcher=read('wf-pi/faravan-pi.sh');

test('the pi kit pins its base by digest and the exact pi release, and the adapter names this kit',()=>{
  assert.equal(PI_HARNESS.install,'wf-pi');
  assert.match(spec,/^name: wf-pi$/m);
  const base=/image: "(docker\/sandbox-templates@sha256:[0-9a-f]{64})"/.exec(spec)?.[1];
  assert.ok(base,'base image is named by digest');
  assert.equal(base,/image: "(docker\/sandbox-templates@sha256:[0-9a-f]{64})"/.exec(read('wf-gh-cli/spec.yaml'))[1],'same reviewed base as the GitHub kit');
  const pack=JSON.parse(readFileSync(new URL('../../packaging/pi-payload/package.json',import.meta.url),'utf8'));
  const version=pack.dependencies['@earendil-works/pi-coding-agent'];
  assert.match(version,/^\d+\.\d+\.\d+$/,'an exact version, no range');
  assert.match(PI_HARNESS.pinned_cli_version,new RegExp('pi-coding-agent@'+version.replaceAll('.','\\.')));
  const lock=JSON.parse(readFileSync(new URL('../../packaging/pi-payload/package-lock.json',import.meta.url),'utf8')).packages;
  assert.equal(lock['node_modules/@earendil-works/pi-coding-agent'].version,version);
  for(const [name,entry] of Object.entries(lock))if(name)assert.match(entry.integrity??'',/^sha512-/,name+' is pinned by integrity');
});

test('pi reaches the guest from the kit itself: no install-time registry or network access',()=>{
  assert.doesNotMatch(spec,/npm |npx |pip |curl |wget |apt-get /);
  assert.match(spec,/sh \/home\/agent\/\.faravan\/install-pi\.sh/);
  const dir=new URL('../../kits/wf-pi/files/home/.faravan/',import.meta.url),install=readFileSync(new URL('install-pi.sh',dir),'utf8');
  assert.doesNotMatch(install,/npm|curl|wget|https?:/);
  assert.match(install,/sha256sum -c pi-payload\.sha256/);
  const pin=readFileSync(new URL('pi-payload.sha256',dir),'utf8');
  assert.match(pin,/^[0-9a-f]{64}  pi-payload\.tgz\n$/);
  // A built payload (scripts/build-pi-payload.sh) must match its pin; a checkout that has not built one skips this.
  const built=new URL('pi-payload.tgz',dir);
  if(existsSync(built))assert.equal(createHash('sha256').update(readFileSync(built)).digest('hex'),pin.slice(0,64));
});

test('the pi kit declares no network and no credential source',()=>{
  assert.doesNotMatch(spec,/^\s*(network|credentials|serviceAuth|allowedDomains|serviceDomains|proxyManaged)\s*:/m);
  assert.doesNotMatch(spec,/https?:\/\//);
});

test('the installed launcher is exactly kits/wf-pi/faravan-pi.sh, and it never needs the network',()=>{
  const encoded=/echo ([A-Za-z0-9+/=]+) \| base64 -d > \/usr\/local\/bin\/faravan-pi/.exec(spec)?.[1];
  assert.ok(encoded);
  assert.equal(Buffer.from(encoded,'base64').toString('utf8'),launcher);
  assert.match(launcher,/PI_OFFLINE=1/);
  assert.match(launcher,/PI_CODING_AGENT_DIR=\$dir/);
  assert.doesNotMatch(launcher,/curl|wget|https?:/);
  assert.match(spec,/run: \["faravan-pi"\]/);
});
