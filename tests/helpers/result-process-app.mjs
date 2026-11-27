// A disposable app process for the result journey; all credentials and files are synthetic.
import './no-browser.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {startApp} from '../../lib/v1/app.mjs';
import {syntheticBackend,adapters} from './v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';
import {isGitCandidateScript} from '../../lib/git-candidate.mjs';
const {home,root,name}=JSON.parse(process.argv[2]);
const isolatedHome=join(root,name+'-process-home');
for(const [key,value] of Object.entries({HOME:isolatedHome,FARAVAN_HOME:home,CODEX_HOME:join(isolatedHome,'.codex'),CLAUDE_CONFIG_DIR:join(isolatedHome,'.claude')}))assert.equal(process.env[key],value,key+' must be synthetic');
const backend=syntheticBackend(root),start=backend.start;
backend.start=async(handle,opts={})=>{
 if(handle._sourcePreparation||isGitCandidateScript(handle._entrypoint)||handle._entrypoint==='codex login status')return start(handle,opts);
 await writeFile(join(handle.scratch_dir,'notes.txt'),'new\n');
 await mkdir(join(handle.scratch_dir,'sub'),{recursive:true});await writeFile(join(handle.scratch_dir,'sub','plan.txt'),'plan\n');
 await rm(join(handle.scratch_dir,'delete.txt'),{force:true});
 handle._lastExecStdout=JSON.stringify({type:'result',result:'Updated the notes and added a plan.'})+'\n';
 opts.onLog?.({stream:'stdout',chunk:Buffer.from(handle._lastExecStdout)});
};
const app=await startApp({home,port:0,token:'synthetic-result-'+name,userHome:join(root,'projects'),backendFactory:async()=>backend,adapters:adapters(),pollMs:1000,approvalPollMs:1000,autoApprove:false,joinWaitMs:0,quotaReader:async()=>({remaining:100,observedAt:Date.now()}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null,source:'unavailable'}),lendingPace50:{source:createSyntheticPace50Source({start:Date.now()}),account_week_id:'synthetic-week-1'},identityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:true}))})});
process.send({origin:app.origin,token:app.token,pid:process.pid,environmentIsolated:true});
let stopped=false;async function stop(){if(stopped)return;stopped=true;try{await app.close();}finally{process.exit(0);}}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);
