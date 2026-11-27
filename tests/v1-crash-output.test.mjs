import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-lender-child.mjs',import.meta.url));
for(const boundary of ['sandbox-removed','before-upload']) {
  test('G02 sealed output survives SIGKILL at '+boundary,async t=>{
    const f=await realLenderFixture(t);
    writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now()}));
    await crashProcess(t,worker,[f.root,boundary,'run'],boundary);
    await crashProcess(t,worker,[f.root,'recovered','recover'],'recovered');
    assert.equal((await f.owner.getJob(f.jobDigest)).state,'result-accepted');
    assert.deepEqual(await f.owner.fetchResult(f.jobDigest,{attempt:(await f.owner.getJob(f.jobDigest)).current_attempt}),readFileSync(join(f.root,'expected-output')));
    assert.equal(readFileSync(join(f.root,'executions'),'utf8'),'run\n');
  });
}

for(const boundary of ['sandbox-removed','completion-committed','legacy-spool']) {
  test('G02 signed transcript keeps the live redaction contract after '+boundary,async t=>{
    const f=await realLenderFixture(t);
    writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now()}));
    const killAt=boundary==='legacy-spool'?'sandbox-removed':boundary;
    await crashProcess(t,worker,[f.root,killAt,'run'],killAt);
    const journal=join(f.root,'app-home','v1','app-counters.json');
    const saved=JSON.parse(readFileSync(journal,'utf8'));
    assert.equal(saved.outputPending.result.execution.workspace_path,'/workspace/repo');
    if(boundary==='legacy-spool') {
      saved.outputPending.result.execution.workspace_path='/synthetic/private/old-root/repo';
      writeFileSync(journal,JSON.stringify(saved));
    }
    await crashProcess(t,worker,[f.root,'recovered','app-recover'],'recovered');
    const view=await f.owner.getJob(f.jobDigest);
    const transcript=Buffer.from(await f.owner.fetchTranscript(f.jobDigest,{attempt:view.current_attempt})).toString();
    const context=transcript.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.type==='faravan.job_context');
    assert.ok(context,'verified transcript contains framing context');
    assert.equal(context.workspace_path,boundary==='legacy-spool'?'/workspace':'/workspace/repo');
    assert.doesNotMatch(transcript,/faravan-lender-offline-|\/home\/|\/tmp\/|\/synthetic\/private/);
    assert.equal(transcript.includes(f.root),false);
    assert.equal(readFileSync(join(f.root,'executions'),'utf8'),'run\n');
  });
}
