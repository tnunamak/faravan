import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdtempSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-lender-child.mjs',import.meta.url));
test('R4 cancelled sealed output stays local with its refusal outcome',async t=>{
  const f=await realLenderFixture(t);
  writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now()}));
  await crashProcess(t,worker,[f.root,'sandbox-removed','run'],'sandbox-removed');
  await f.owner.cancelJob(f.jobDigest);
  await crashProcess(t,worker,[f.root,'recovered','app-recover'],'recovered');
  assert.equal((await f.owner.getJob(f.jobDigest)).state,'cancelled');
  const directory=join(f.root,'app-home','v1','rejected-results'),names=readdirSync(directory);
  assert.equal(names.length,1);
  const rejected=JSON.parse(readFileSync(join(directory,names[0]),'utf8'));
  assert.equal(rejected.code,'cancelled');assert.equal(rejected.output.claim.job_digest,f.jobDigest);
  assert.ok(rejected.output.result.collected[0].bytes_content.length>0);
});
for(const intent of ['off','paused'])for(const boundary of ['sandbox-removed','completion-saved']) {
  test('R4 normal app restart after lease expiry: '+intent+' / '+boundary,{timeout:60000},async t=>{
    const f=await realLenderFixture(t);
    const configure=()=>writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now(),intent}));
    configure();await crashProcess(t,worker,[f.root,boundary,'run'],boundary);
    const requests=f.realRequests.length;
    f.clock.advance(121000);configure();
    await crashProcess(t,worker,[f.root,'recovered','app-recover'],'recovered');
    assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
    assert.deepEqual(await f.owner.fetchResult(f.jobDigest,{attempt:(await f.owner.getJob(f.jobDigest)).current_attempt}),readFileSync(join(f.root,'expected-output')));
    assert.equal(readFileSync(join(f.root,'executions'),'utf8'),'run\n');
    assert.equal(f.realRequests.slice(requests).some(row=>row.url.endsWith('/claim-next')||row.url.endsWith('/start')||row.url.endsWith('/renew')),false);
    const settings=JSON.parse(readFileSync(join(f.root,'app-home','v1','app-settings.json'),'utf8'));
    assert.equal(settings.intent,intent);assert.equal(settings.paused,intent==='paused');
  });
}
