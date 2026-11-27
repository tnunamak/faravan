// Run with node capture.mjs <release source checkout> <throwaway root> <destination>.
// Imports only the selected release's app, APIs, test backend and state writers.
import {mkdir,readFile,writeFile,cp,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [source,root,destination]=process.argv.slice(2).map(value=>resolve(value));
const load=file=>import(pathToFileURL(join(source,file)));
const {syntheticBackend}=await load('tests/helpers/v1-app-fixture.mjs');
await mkdir(root,{recursive:true});
for(const key of ['HOME','FARAVAN_HOME','FARAVAN_HOME','FARAVAN_DATA_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','FARAVAN_COORDINATOR_HOME','FARAVAN_COORDINATOR_HOME'])process.env[key]=root;
for(const key of ['FARAVAN_NO_BROWSER','FARAVAN_NO_BROWSER','FARAVAN_NO_AUTOSTART','FARAVAN_NO_AUTOSTART','FARAVAN_NO_UPDATE'])process.env[key]='1';
process.env.DISPLAY='';process.env.WAYLAND_DISPLAY='';
const bin=join(root,'bin');await mkdir(bin,{recursive:true});
for(const name of ['sbx','docker'])await writeFile(join(bin,name),'#!/bin/sh\necho "forbidden sandbox command" >&2\nexit 97\n',{mode:0o755});
process.env.PATH=bin+':'+process.env.PATH;
const {startApp}=await load('lib/v1/app.mjs');
const {saveJsonFile}=await load('lib/local-state.mjs');
const {openSessionStore}=await load('lib/v1/browser-sessions.mjs');
const {createLenderCounterStorage}=await load('lib/v1/lender.mjs');
const {createSandboxCleanupJournal}=await load('lib/sandbox-cleanup-journal.mjs');
let owner=null;
try {const {ensureSbxOwner}=await load('lib/sbx-daemon-owner.mjs');owner=ensureSbxOwner(join(bin,'sbx'),process.env);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const home=join(root,'data');const backend=syntheticBackend(root);
const app=await startApp({home,port:0,freshLending:'off',adapters:[],backendFactory:async()=>backend,
  signInProbe:async()=>({signedIn:null}),lendingSignInProbe:async()=>({signedIn:null}),
  identityProbe:async()=>({providers:[]}),lendingIdentityProbe:async()=>({providers:[]}),
  autostart:{status:async()=>({supported:false,enabled:false})}});
const limits={dailyJobs:7,dailyMinutes:91,maxWallSeconds:1200,quotaReserve:35,idleOnly:false,timeZone:'UTC',
  schedule:{days:[1,3,5],from:'09:15',to:'16:45',weekends_all_day:false},
  lendingPolicy:{strategy:'automatic',strategyParams:{perJobPct:9},protectionPosition:'share_more',warningPct:17,
    machineSlots:3,accountSlots:1,providerConsent:{claude:true,codex:true},accountPlans:{claude:'max20',codex:'pro'}}};
try {
 const response=await fetch(app.origin+'/api/lending/limits',{method:'POST',headers:{'content-type':'application/json','x-faravan-session-token':app.token},body:JSON.stringify(limits)});
 if(!response.ok)throw Error(await response.text());
}finally{await app.close();}
const settings=JSON.parse(await readFile(join(home,'v1/app-settings.json'),'utf8'));
settings.name='Fixture computer';
// Remove the explicit-choice marker through this release's atomic writer: this
// models an older unmarked UTC file, not a state reachable by this release's API.
const unmarked=structuredClone(settings);delete unmarked.timeZoneChosen;
saveJsonFile(join(home,'v1/app-settings.json'),unmarked,{base:home});
const invalid=structuredClone(settings);invalid.limits.lendingPolicy.warningPct=150;
saveJsonFile(join(home,'invalid-policy.json'),invalid,{base:home});
const sessions=await openSessionStore(join(home,'v1/sessions.json'),{now:()=>4102444800000});
await sessions.create({kind:'phone',label:'Fixture device',scopes:['inbox:read','requests:answer']});await sessions.close();
// Only persisted non-secret session hashes are copied; the returned cookie is discarded.
const jobId='upgrade-fixture-job',sandbox='wf-'+createHash('sha256').update(jobId).digest('hex').slice(0,16);
const scratch=join(root,'scratch');await mkdir(scratch,{recursive:true});
const handle={job_id:jobId,sandbox_id:sandbox,scratch_dir:join(scratch,'wf-job-'+sandbox+'-fixture')};
await mkdir(handle.scratch_dir);
const journal=createSandboxCleanupJournal({directory:join(home,'cleanup'),scratchRoot:()=>scratch,home:()=>root,destroy:async()=>{}});
journal.register(handle);
// The public durable counter writer is used because no real provider/daemon may
// run. Its root mirror is intentionally absent to exercise the account-only reader.
const pending={attemptId:'fixture-attempt',attempt:{attempt_id:'fixture-attempt'},jobId,reservedMs:120000,executionStartRequested:false,scratchDir:handle.scratch_dir,sandboxId:sandbox,...(owner?{owner_scope:owner.id,sbx_home:root}:{})};
const storage=createLenderCounterStorage(join(home,'v1/app-counters.json'));const release=await storage.acquire();
try{await storage.set({day:'2099-12-31',jobs:0,milliseconds:0,pending:null,accounts:{'codex:0':{jobs:0,milliseconds:0,pending}}});}finally{await release();}
await mkdir(destination,{recursive:true});
for(const file of ['v1/app-settings.json','v1/app-counters.json','v1/sessions.json','invalid-policy.json']){
 await mkdir(join(destination,file,'..'),{recursive:true});await cp(join(home,file),join(destination,file));
}
if(owner)saveJsonFile(join(destination,'sandbox-owner.json'),{id:owner.id,executable:'@ROOT@/bin/sbx'},{base:destination});
await cp(join(home,'cleanup'),join(destination,'cleanup'),{recursive:true});
// Relocate only throwaway absolute paths. Shape, version and writer values stay intact.
for(const name of await readdir(join(destination,'cleanup'))){
 if(!name.endsWith('.json')){await rm(join(destination,'cleanup',name),{recursive:true,force:true});continue;}
 const file=join(destination,'cleanup',name);await writeFile(file,(await readFile(file,'utf8')).replaceAll(root,'@ROOT@'));
}
console.log('captured '+source+' -> '+destination);

const countersFile=join(destination,'v1/app-counters.json');await writeFile(countersFile,(await readFile(countersFile,'utf8')).replaceAll(root,'@ROOT@'));
