import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSbxChild} from '../lib/docker-backend.mjs';
import {hostDefaultSbxRuntime,cleanupSbxRuntime,restoreSbxRuntime,describeSbxRuntime,runtimeDescriptor} from '../lib/sbx-runtime.mjs';
const unavailable=error=>error?.code==='claude_account_unavailable';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'host-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
for(const phase of ['live','cleanup','restart','restart-cleanup'])for(const drift of ['child','current'])
test(`${phase} host runtime refuses ${drift} HOME drift at the process boundary`,async t=>{
 const root=await fixture(t),homeA=join(root,'a'),homeB=join(root,'b'),saved=process.env.HOME;
 process.env.HOME=homeA;t.after(()=>{if(saved===undefined)delete process.env.HOME;else process.env.HOME=saved;});
 const env={...process.env,HOME:homeA};
 let runtime=hostDefaultSbxRuntime({binary:process.execPath,env});
 if(phase.includes('cleanup'))runtime=cleanupSbxRuntime(runtime);
 if(phase.startsWith('restart'))runtime=restoreSbxRuntime(describeSbxRuntime(runtime),{env,cleanup:phase.includes('cleanup')});
 const calls=[],primitives={execFile(binary){calls.push(binary);return {};}};
 spawnSbxChild(runtime,['ls','--json'],{env},primitives);assert.deepEqual(calls,[process.execPath]);calls.length=0;
 const childEnv={...env};if(drift==='child')childEnv.HOME=homeB;else process.env.HOME=homeB;
 let failure;try{spawnSbxChild(runtime,['ls','--json'],{env:childEnv},primitives);}catch(error){failure=error;}
 assert.equal(calls.length,0,'a changed store never reaches the process stub');assert.ok(unavailable(failure),'HOME drift keeps the typed runtime refusal');
});
for(const kind of ['absolute','PATH'])test(`a missing ${kind} executable cannot gain launch authority by appearing later`,async t=>{
 const root=await fixture(t),file=join(root,'sbx'),binary=kind==='PATH'?'sbx':file,env={...process.env,PATH:root};
 let runtime,failure;try{runtime=hostDefaultSbxRuntime({binary,env});}catch(error){failure=error;}
 await writeFile(file,'synthetic executable',{mode:0o700});const calls=[];
 if(runtime)spawnSbxChild(runtime,['version'],{env},{execFile(path){calls.push(path);return {};}});
 assert.equal(calls.length,0,'later executable appearance cannot revive an unqualified binding');
 assert.ok(unavailable(failure));assert.equal(runtime,undefined);
 const weak=runtimeDescriptor({kind:'host-default',binary:{path:binary},home:env.HOME});
 assert.throws(()=>restoreSbxRuntime(weak,{env}),unavailable,'restart also refuses a descriptor without executable identity');
});
