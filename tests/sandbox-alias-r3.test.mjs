import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import {createCheckSandboxes} from '../lib/v1/check-sandboxes.mjs';

const job={job_id:'wf-pull-0000000000000000-81234567',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
  execution_scope:'owner',
  resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
  inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']};
const empty=withCleanCredentialScope(async args=>({code:0,stdout:args[0]==='ls'?'[]':'{"rules":[]}'}));

test('R3 both reapers remove owned scratch through a symlinked temporary root',async t=>{
  const root=await mkdtemp(join(tmpdir(),'r3-scratch-alias-')),real=join(root,'real'),alias=join(root,'alias');
  await mkdir(real);await symlink(real,alias,'dir');
  const previous=process.env.FARAVAN_SCRATCH_ROOT;process.env.FARAVAN_SCRATCH_ROOT=alias;
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_SCRATCH_ROOT;else process.env.FARAVAN_SCRATCH_ROOT=previous;});
  const cleanupDirectory=join(root,'journal'),backend=new DockerSbxBackend({cleanupDirectory,runCommand:empty,removeScratch:async()=>{throw Error('busy');}});
  backend._configureEgress=async()=>{};
  const file=join(root,'checks.json'),checks=createCheckSandboxes({backend,file,now:()=>0,timeoutMs:1});
  const handle=await checks.backend.prepare(job);await writeFile(join(handle.scratch_dir,'source'),'borrower source');
  assert.ok(handle.scratch_dir.startsWith(real+'/'),'normal prepare already records a canonical path');
  await checks.backend.destroy(handle);
  const restarted=new DockerSbxBackend({cleanupDirectory,runCommand:empty});
  // The check journal only forgets the expired lease; the cleanup record owns the scratch.
  await createCheckSandboxes({backend:restarted,file,now:()=>2}).reap();
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),[]);
  await restarted.reapCleanup();
  assert.equal(existsSync(handle.scratch_dir),false,'diagnostics and backend must agree on the same physical root');
  assert.equal(restarted.cleanupStatus().state,'clear');
});
