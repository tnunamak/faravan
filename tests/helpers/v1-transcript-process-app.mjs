// Isolated app process for the transcript regression. All identity and provider data are synthetic.
import {startApp} from '../../lib/v1/app.mjs';
import {syntheticBackend,adapters,api} from './v1-app-fixture.mjs';
import {syntheticProvider,syntheticTransport,accountBackend,enrollSyntheticAccount} from './synthetic-run-account.mjs';
import {transcriptProcessUserActive} from './v1-transcript-process-presence.mjs';
import {TRANSCRIPT_CLAUDE} from '../../ui/v1/src/fixtures/private-transcript-stream.mjs';
const [home,root,name]=process.argv.slice(2);
const sandboxOptions={hold:true};
const backend=accountBackend(syntheticBackend(root,sandboxOptions));
backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});
const original=backend.start.bind(backend);
backend.start=async(handle,options={})=>{
 const agent=handle._entrypoint?.includes('codex')&&!handle._entrypoint.includes('login status');
 if(agent)options.onLog?.({stream:'stdout',chunk:Buffer.from(TRANSCRIPT_CLAUDE)});
 await original(handle,options);
 if(agent)handle._lastExecStdout=TRANSCRIPT_CLAUDE+handle._lastExecStdout;
};
const app=await startApp({checkJobIsolation:async()=>({state:"pass"}),home,origin:null,port:0,freshLending:'off',token:'synthetic-session-'+name,backendFactory:async()=>backend,adapters:adapters(),accountProviderConfigurations:[syntheticProvider],accountTransportFetch:syntheticTransport,pollMs:250,autoApprove:false,joinWaitMs:0,approvalPollMs:250,quotaReader:async()=>({remaining:100,observedAt:Date.now()}),idleReader:transcriptProcessUserActive,signInProbe:async()=>({signedIn:null,source:'unavailable'}),identityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:true}))})});
await enrollSyntheticAccount(app,api,home);
await api(app,'/api/agents/codex/run',{method:'POST',body:{model:'gpt-6-luna',effort:null}});
process.send({origin:app.origin,token:app.token,pid:process.pid});
let stopping=false;
process.on('message',async message=>{
 if(message==='release'){sandboxOptions.hold=false;backend.release();return;}
 if(message!=='stop'||stopping)return;
 stopping=true;backend.release();await app.close();process.exit(0);
});
