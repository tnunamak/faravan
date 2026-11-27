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
for(const boundary of ['sandbox-removed','before-upload','completion-saved','completion-committed']){
  test('G02/G03 SIGKILL at '+boundary+' delivers once after lease expiry',{timeout:60000},async t=>{
    const f=await realLenderFixture(t);
    const configure=()=>writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now()}));
    configure();
    await crashProcess(t,worker,[f.root,boundary,'run'],boundary);
    f.clock.advance(121000);configure();
    await crashProcess(t,worker,[f.root,'recovered','recover'],'recovered');
    const job=await f.owner.getJob(f.jobDigest);
    assert.equal(job.state,'result-accepted');
    assert.deepEqual(await f.owner.fetchResult(f.jobDigest,{attempt:job.current_attempt}),readFileSync(join(f.root,'expected-output')));
    assert.equal(readFileSync(join(f.root,'executions'),'utf8'),'run\n');
    const saved=JSON.parse(readFileSync(join(f.root,'recovered.json'),'utf8'));
    assert.equal(saved.resultPending,null);
  });
}
