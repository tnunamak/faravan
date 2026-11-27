import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';
import {runUninstall} from '../lib/v1/uninstall.mjs';

test('R3 uninstall retains the cleanup journal until external scratch is reaped',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'r3-uninstall-debt-')),home=join(root,'data');let blocked=true;
  const backend=new DockerSbxBackend({cleanupDirectory:join(home,'v1','sandbox-cleanup'),runCommand:withCleanCredentialScope(async args=>({code:0,stdout:args[0]==='ls'?'[]':'{"rules":[]}'})),
    removeScratch:async dir=>{if(blocked)throw Error('busy');await rm(dir,{recursive:true,force:true});}});
  backend._configureEgress=async()=>{};
  const handle=await backend.prepare({job_id:'r3-uninstall-debt',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
    execution_scope:'owner',
    resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
    inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']});
  await writeFile(join(handle.scratch_dir,'source'),'borrower source');await backend.destroy(handle);
  let errors='';
  const options={home,userHome:root,device:{listCircles:async()=>[]},platform:'linux',env:{},installDir:join(root,'checkout'),cleanupBackend:backend,
    run:async(command,args)=>({code:command==='pgrep'?1:args.includes('is-active')?3:0}),sleep:async()=>{},stdout:{write(){}},stderr:{write:text=>{errors+=text;}}};
  assert.equal(await runUninstall(['--yes'],options),1);
  assert.match(errors,/cleanup debt/);assert.equal(existsSync(home),true);assert.equal(existsSync(handle.scratch_dir),true);
  assert.equal(backend.cleanupStatus().state,'pending');
  blocked=false;errors='';assert.equal(await runUninstall(['--yes'],options),0,errors);
  assert.equal(existsSync(handle.scratch_dir),false);assert.equal(existsSync(home),false);
});
