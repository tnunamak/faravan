import {legacyProxyHarness} from './legacy-proxy-harness.mjs';
// Same synthetic app process as data-app-worker.mjs, but with two agent accounts (codex and claude) lending, so the
// daemon alternates its per-account lending events the way a real two-agent computer does.
const adapters=()=>[...codexOnly(),{...codexOnly()[0],spec:legacyProxyHarness('claude-code-subscription')}];
import { startApp } from '../../lib/v1/app.mjs';
import { syntheticBackend, adapters as codexOnly } from './v1-app-fixture.mjs';
import { createSyntheticPace50Source } from './pace50-synthetic-source.mjs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [home, name, portText, coordinatorOrigin] = process.argv.slice(2);
for(const [key,value] of Object.entries({HOME:home,FARAVAN_HOME:home,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude')}))assert.equal(process.env[key],value,`Synthetic ${key} is required`);
const backend = syntheticBackend(home, {hold: true});
backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});
const originalStart = backend.start.bind(backend);
let emitMessage=null;
backend.start = async (handle, options = {}) => {
  if (/login status/.test(handle._entrypoint??'')) return originalStart(handle, options);
  if(options.onLog&&!handle._sourcePreparation){
    emitMessage=text=>options.onLog({stream:'stdout',chunk:Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n')});
    const at=Date.now();await fetch(coordinatorOrigin+'/test-events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'agent_emit',device:name,at})}).catch(()=>{});
  }
  options.onLog?.({stream: 'stdout', chunk: Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DATA synthetic agent message'}}) + '\n')});
  return originalStart(handle, options);
};
const app = await startApp({home,origin:null,port:Number(portText),token:'synthetic-session-' + name,backendFactory:async()=>backend,adapters:adapters(),lendingPace50:{source:createSyntheticPace50Source({start:Date.now()}),
    account_week_id:'synthetic-week-1'},pollMs:1000,autoApprove:false,joinWaitMs:0,approvalPollMs:1000,quotaReader:async()=>({remaining:100,observedAt:Date.now()}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null,source:'unavailable'}),identityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:true}))})});
process.stdout.write(JSON.stringify({origin:app.origin})+'\n');
const input=createInterface({input:process.stdin});
input.on('line',async line=>{let request;try{request=JSON.parse(line);let value;
  if(request.command==='roster')value=(await app.device.rosterCache(request.circle).get()).current;
  else if(request.command==='refreshRoster')value=await app.device.refreshRoster(request.circle);
  else if(request.command==='release'){backend.release();value=true;}
  else if(request.command==='emit'){if(!emitMessage)throw new Error('Agent has not started');emitMessage(request.text);value=true;}
  process.stdout.write(JSON.stringify({id:request.id,value})+'\n');
}catch(error){process.stdout.write(JSON.stringify({id:request?.id,error:error.message})+'\n');}});
async function stop(){await app.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
