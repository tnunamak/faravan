import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { openV1Store } from '../../lib/v1/store.mjs';
import { createV1Handler } from '../../lib/v1/server.mjs';
import { appFixture, api } from './v1-app-fixture.mjs';
import { freshLink } from './fresh-link.mjs';

const worker = new URL('./data-app-worker.mjs', import.meta.url);
export async function startDataHarness({worker:workerUrl=worker}={}) {
  const cleanup=[];const fixture=await appFixture({after:fn=>cleanup.push(fn)});
  let handler=null,store=null,stopped=false;const agentEmits=[];let emitWaiters=[];
  const coordinator=createServer(async(req,res)=>{if(req.url==='/test-events'&&req.method==='POST'){let text='';for await(const chunk of req)text+=chunk;const event=JSON.parse(text);agentEmits.push(event);for(const resolve of emitWaiters)resolve(event);emitWaiters=[];res.writeHead(204).end();return;}return handler?handler(req,res):(res.writeHead(503).end());});
  coordinator.listen(0,'127.0.0.1');await once(coordinator,'listening');
  const coordOrigin='http://127.0.0.1:'+coordinator.address().port,children=[],pending=new Map();let nextId=0;
  // Disposable host outage: the coordinator stops answering while both apps keep running. Safe to call twice.
  let hostStopped=null;
  const stopHost=()=>hostStopped??=new Promise(resolve=>{coordinator.closeAllConnections();coordinator.close(()=>resolve());});
  const stop=async()=>{
    if(stopped)return;stopped=true;
    for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');
    await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))])));
    for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');
    handler?.close();await stopHost();store?.close();
    for(const fn of cleanup.reverse())await fn();
  };
  async function app(name){
    const home=await fixture.home(name),child=spawn(process.execPath,[workerUrl.pathname,home,name,'0',coordOrigin],{
      env:{...process.env,HOME:home,FARAVAN_HOME:home,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''},stdio:['pipe','pipe','pipe']});
    children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);
    const rl=createInterface({input:child.stdout});
    let startupTimer;
    const line=await Promise.race([
      new Promise((resolve,reject)=>rl.once('line',resolve).once('error',reject)),
      once(child,'exit').then(([code])=>{throw new Error(`${name} app worker exited ${code}: ${stderr}`);}),
      new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(new Error(`Timed out starting ${name} app worker: ${stderr}`)),30000);}),
    ]).finally(()=>clearTimeout(startupTimer));
    rl.on('line',raw=>{try{const message=JSON.parse(raw),entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error)):entry.resolve(message.value);}}catch{}});
    child.command=command=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error('worker IPC timeout'));}},5000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,...command})+'\n');});
    const endpoints=JSON.parse(line);return {origin:endpoints.origin,token:'synthetic-session-'+name,process:child};
  }
  try{
    const owner=await app('owner'),lender=await app('lender');
    await api(owner,'/api/devices',{method:'POST',body:{name:'Data Owner',ownerName:'Owner Person'}});
    await api(lender,'/api/devices',{method:'POST',body:{name:'Data Lender',ownerName:'Lender Person'}});
    const circle=await api(owner,'/api/circles',{method:'POST',body:{origin:coordOrigin,name:'Synthetic data regression',publish:false}});
    const initialRoster=await owner.process.command({command:'roster',circle:circle.id});
    store=openV1Store({path:join(fixture.root,'data-coordinator.sqlite'),circle:circle.id,
      rootFingerprint:circle.pinnedRootFingerprint,origin:coordOrigin,initialRoster});
    handler=createV1Handler({store,blobDir:join(fixture.root,'data-blobs')});
    const {invite}=await api(owner,`/api/circles/${circle.id}/invite`,{method:'POST',body:{}});
    await api(lender,'/api/circles/join',{method:'POST',body:{link:invite}});
    await api(owner,`/api/circles/${circle.id}/approve`,{method:'POST',body:{}});
    await lender.process.command({command:'refreshRoster',circle:circle.id});
    return {owner:owner.origin,lender:lender.origin,ownerLink:()=>freshLink(owner.origin,owner.token),lenderLink:()=>freshLink(lender.origin,lender.token),
      pids:{owner:owner.process.pid,lender:lender.process.pid,coordinator:process.pid},agentEmits,
      waitForAgentEmit:()=>agentEmits.length?Promise.resolve(agentEmits.at(-1)):new Promise(resolve=>emitWaiters.push(resolve)),
      emitMessage:text=>lender.process.command({command:'emit',text}),releaseJob:()=>lender.process.command({command:'release'}),stopHost,circle,stop};
  }catch(error){await stop().catch(()=>{});throw error;}
}
