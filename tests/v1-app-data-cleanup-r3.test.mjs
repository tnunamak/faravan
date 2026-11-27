import './helpers/no-browser.mjs';
import {fakeSandboxDeadlines} from './helpers/sandbox-receipt-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import {appFixture,syntheticBackend,waitFor,api} from './helpers/v1-app-fixture.mjs';

test('R3 normal app retries scratch debt while Off without a recovery request',{timeout:60000},async t=>{
  const f=await appFixture(t),home=await f.home('data-debt');let blocked=true;
  const real=new DockerSbxBackend({sandboxDeadlines:fakeSandboxDeadlines(),cleanupDirectory:join(home,'v1','sandbox-cleanup'),runCommand:withCleanCredentialScope(async args=>({code:0,stdout:args[0]==='ls'?'[]':'{"rules":[]}'})),
    removeScratch:async dir=>{if(blocked)throw Error('busy');await rm(dir,{recursive:true,force:true});}});
  real._configureEgress=async()=>{};
  const handle=await real.prepare({job_id:'r3-data-debt',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
    execution_scope:'owner',
    resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
    inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']});
  await writeFile(join(handle.scratch_dir,'source'),'borrower source');
  assert.equal((await real.destroy(handle)).removed,true);assert.equal(existsSync(handle.scratch_dir),true);
  const backend=syntheticBackend(f.root);backend.reapCleanup=options=>real.reapCleanup(options);backend.cleanupStatus=()=>real.cleanupStatus();
  const {app}=await f.start('data-debt',{backend,cleanupRecheckMs:10});
  assert.equal((await api(app,'/api/lending')).intent,'off');
  blocked=false;
  await waitFor(()=>!existsSync(handle.scratch_dir),'normal app debt cleanup',1500);
  assert.equal(real.cleanupStatus().state,'clear');
});
