import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile,chmod,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerSbxBackend,sbxChildEnv} from '../../lib/docker-backend.mjs';
import {hostDefaultSbxRuntime} from '../../lib/sbx-runtime.mjs';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHostProviderRegistry} from '../../lib/v1/providers/host-registry.mjs';
import {TUNNEL_ORIGIN,TUNNEL_PORT,GUEST_RELAY_PYTHON_SOURCE,guestRelayArgv,attachGuestBrokerTunnel} from '../../lib/v1/guest-broker-tunnel.mjs';

// Production DockerSbxBackend.openAccountTunnel against an owned stand-in `sbx` executable.
// The stand-in is not Docker Sandboxes and proves nothing about a real sandbox. It follows the real
// stdio contract: `sbx exec -i <name> -- node -e <relay> <port>` starts the guest process with the
// host's pipe as its stdin and stdout, and the guest process ends when that stdin ends.
// _dispatchProtected (cleanup-journal admission and deadline binding) needs a fully prepared sandbox
// and is replaced by a pass-through here; it is exercised by the sandbox preparation tests, not these.
const FAKE=`#!/usr/bin/env node
const {spawn}=require('node:child_process');const fs=require('node:fs');
const log=line=>fs.appendFileSync(process.env.FAKE_SBX_LOG,line+'\\n');
const args=process.argv.slice(2);
if(args[0]==='daemon'){console.log('Status: running');process.exit(0);}
if(args[0]==='version'){console.log('sbx fake');process.exit(0);}
log(JSON.stringify({pid:process.pid,args}));
const mode=process.env.FAKE_SBX_MODE||'ok';
if(mode==='fail'){process.stderr.write('sandbox not running\\n');process.exit(1);}
if(mode==='silent'){process.stdin.resume();setInterval(()=>{},1000);return;}
const i=args.indexOf('--');
const child=process.env.FAKE_SBX_CONTAINER?spawn('docker',['exec','-i',process.env.FAKE_SBX_CONTAINER,...args.slice(i+1)],{stdio:'inherit'})
  :spawn(args[i+1],args.slice(i+2),{stdio:'inherit'});
log(JSON.stringify({relay:child.pid}));
child.on('exit',c=>process.exit(c??1));
process.on('SIGTERM',()=>child.kill());
`;
const IMAGE='faravan-wf-pi:local';
const haveImage=(()=>{try{execFileSync('docker',['image','inspect',IMAGE],{stdio:'ignore'});return true;}catch{return false;}})();
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(fn,what)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('timed out: '+what);};
async function harness(t,mode='ok',container=''){
  const dir=await mkdtemp(join(tmpdir(),'faravan-fake-sbx-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'sbx'),log=join(dir,'log');
  await writeFile(bin,FAKE);await chmod(bin,0o755);await writeFile(log,'');
  const saved={bin:process.env.FARAVAN_SBX_BIN,gate:process.env.FARAVAN_SBX_DAEMON_GATE,log:process.env.FAKE_SBX_LOG,mode:process.env.FAKE_SBX_MODE,container:process.env.FAKE_SBX_CONTAINER};
  Object.assign(process.env,{FARAVAN_SBX_BIN:bin,FARAVAN_SBX_DAEMON_GATE:'off',FAKE_SBX_LOG:log,FAKE_SBX_MODE:mode,...(container?{FAKE_SBX_CONTAINER:container}:{})});
  if(!container)delete process.env.FAKE_SBX_CONTAINER;
  t.after(()=>{for(const [k,v] of [['FARAVAN_SBX_BIN',saved.bin],['FARAVAN_SBX_DAEMON_GATE',saved.gate],['FAKE_SBX_LOG',saved.log],['FAKE_SBX_MODE',saved.mode],['FAKE_SBX_CONTAINER',saved.container]])
    v===undefined?delete process.env[k]:process.env[k]=v;});
  const backend=new DockerSbxBackend();
  backend._dispatchProtected=async(_handle,signal,launch)=>{signal?.throwIfAborted();return launch();};
  const handle={sandbox_id:'wf-owned-test',_sbxRuntime:hostDefaultSbxRuntime({binary:bin,currentEnv:sbxChildEnv,env:sbxChildEnv()})};
  const entries=async()=>(await readFile(log,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
  return {backend,handle,entries};
}
const get=(key,path='/api/account-proxy/pi/chat/completions')=>fetch('http://127.0.0.1:'+TUNNEL_PORT+path,{headers:{authorization:'Bearer '+key}});
const handlerFor=valid=>(req,res)=>{const key=String(req.headers.authorization??'').replace(/^Bearer /,'');
  res.writeHead(valid.has(key)?200:403);res.end(valid.has(key)?'ok':'refused');};

test('production openAccountTunnel runs the exact exec command, serves one job key, and cleans up on revoke, close and abort',{timeout:60000},async t=>{
  const {backend,handle,entries}=await harness(t);
  const valid=new Set(['JOB_KEY']),abort=new AbortController();
  const tunnel=await backend.openAccountTunnel(handle,{handler:handlerFor(valid),signal:abort.signal});
  const [exec]=await entries();
  assert.deepEqual(exec.args,['exec','-i','wf-owned-test','--',...guestRelayArgv()]);
  const relay=(await entries()).find(e=>e.relay).relay;
  assert.equal((await get('JOB_KEY')).status,200);
  assert.equal((await get('OTHER_KEY')).status,403);
  // Key revocation is the broker's decision; the same route then refuses it.
  valid.delete('JOB_KEY');assert.equal((await get('JOB_KEY')).status,403);
  valid.add('JOB_KEY');assert.equal((await get('JOB_KEY')).status,200);
  // Abort ends the exec process and the guest relay, and frees the guest port. Exactly one exec was ever started.
  abort.abort();
  await until(()=>!alive(exec.pid)&&!alive(relay),'sbx exec and guest relay exit');
  await assert.rejects(get('JOB_KEY'));
  assert.equal((await entries()).filter(e=>e.args).length,1);
  tunnel.close();
});

test('closing the tunnel ends the exec process and the guest relay',{timeout:60000},async t=>{
  const {backend,handle,entries}=await harness(t);
  const tunnel=await backend.openAccountTunnel(handle,{handler:handlerFor(new Set(['K']))});
  const [exec]=await entries();const relay=(await entries()).find(e=>e.relay).relay;
  assert.equal((await get('K')).status,200);
  tunnel.close();
  await until(()=>!alive(exec.pid)&&!alive(relay),'processes exit after close');
  await assert.rejects(get('K'));
});

test('a startup failure is a refused launch and leaves no process or listener',{timeout:60000},async t=>{
  const {backend,handle,entries}=await harness(t,'fail');
  await assert.rejects(backend.openAccountTunnel(handle,{handler:handlerFor(new Set())}),e=>e.code==='adapter_unsupported'&&/private route/.test(e.message));
  const [exec]=await entries();await until(()=>!alive(exec.pid),'failed exec is gone');
  await assert.rejects(get('K'));
});

test('a guest that never reports ready is killed at the deadline',{timeout:60000},async t=>{
  const {backend,handle,entries}=await harness(t,'silent');
  await assert.rejects(backend.openAccountTunnel(handle,{handler:handlerFor(new Set()),readyTimeoutMs:300}),e=>e.code==='adapter_unsupported');
  const [exec]=await entries();await until(()=>!alive(exec.pid),'silent exec is killed');
});

test('an already-aborted launch spawns nothing',async t=>{
  const {backend,handle,entries}=await harness(t);
  const abort=new AbortController();abort.abort();
  await assert.rejects(backend.openAccountTunnel(handle,{handler:handlerFor(new Set()),signal:abort.signal}));
  assert.equal((await entries()).length,0);
});

// Optional, local only: the real kit contents (scripts/build-pi-guest-image.sh builds faravan-wf-pi:local).
// A container with no network stands in for the sandbox and `docker exec -i` for `sbx exec -i`.
const piData={descriptor:{schemaVersion:1,id:'pi',label:'Self-hosted pi',signInKind:'local_harness',refreshKind:'none',
  usageKind:'none',maxConcurrentJobs:1,nativeUnits:[],
  models:[{id:'local-small',label:'Local small',enabled:true,rank:0,pareto:null,efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],
  destinations:[{origin:'http://127.0.0.1:43123',pathPrefixes:['/v1'],methods:['POST']}]},
  identity:'pi-host-subject',command:'faravan-pi',args:['--print','--mode','text','--no-session'],modelFlag:'--model',effortFlag:'--thinking',
  keyEnv:'PI_API_KEY',modelsEnv:'FARAVAN_PI_MODELS',harnessId:'pi'};
test('the built pi guest, started from the host run spec, reaches the host through the production tunnel with only its job key',{timeout:120000,skip:!haveImage&&'build faravan-wf-pi:local first'},async t=>{
  const name='faravan-pi-test-'+process.pid;
  execFileSync('docker',['run','-d','--rm','--network','none','--name',name,'--entrypoint','sleep',IMAGE,'600'],{stdio:'ignore'});
  t.after(()=>{try{execFileSync('docker',['rm','-f',name],{stdio:'ignore'});}catch{}});
  const {backend,handle}=await harness(t,'ok',name);
  const seen=[];
  const handler=(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const j=JSON.parse(body||'{}');seen.push({url:req.url,auth:req.headers.authorization,model:j.model,effort:j.reasoning_effort});
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=o=>'data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',model:j.model,...o})+'\n\n';
    res.write(chunk({choices:[{index:0,delta:{role:'assistant',content:'pong'},finish_reason:null}]}));
    res.write(chunk({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}));
    res.end('data: [DONE]\n\n');});};
  const tunnel=await backend.openAccountTunnel(handle,{handler});
  t.after(()=>tunnel.close());
  const adapter=createHostProviderRegistry({configurations:[piData],proxyOrigin:()=>TUNNEL_ORIGIN,nativeDrivers:{}}).getProvider('pi').value;
  const selection={accountId:'a',providerId:'pi',modelId:'local-small',effortId:'high'};
  const run=adapter.makeRun({selection,jobKey:'GUEST_JOB_KEY',job:{selection,promptText:'say pong'},receipt:{schemaVersion:1},enforcement:{amount:{unit:'tokens',value:1}}}).value;
  assert.deepEqual(Object.keys(run.env).sort(),['FARAVAN_PI_MODELS','PI_API_KEY']);
  const envArgs=Object.entries(run.env).flatMap(([k,v])=>['-e',k+'='+v]);
  // Async: the host handler runs in this process and must keep serving while the guest waits.
  const {stdout:out}=await promisify(execFile)('docker',['exec',...envArgs,name,run.command,...run.args],{encoding:'utf8',timeout:90000});
  assert.match(out,/pong/);
  assert.deepEqual(seen,[{url:'/api/account-proxy/pi/chat/completions',auth:'Bearer GUEST_JOB_KEY',model:'local-small',effort:'high'}]);
});

test('the python3 relay (for guests with no node) carries large bodies, streams and ends with its stdin',{timeout:30000},async t=>{
  const child=spawn('python3',['-c',GUEST_RELAY_PYTHON_SOURCE,String(TUNNEL_PORT)],{stdio:['pipe','pipe','ignore']});
  let release;const gate=new Promise(r=>{release=r;});
  const tunnel=attachGuestBrokerTunnel({child,handler:async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    if(req.url==='/echo'){res.end(Buffer.concat(chunks));return;}
    res.writeHead(200);res.write('first');await gate;res.end('second');}});
  t.after(()=>tunnel.close());await tunnel.ready;
  const big=Buffer.alloc(300000,9);
  const echoed=Buffer.from(await (await fetch('http://127.0.0.1:'+TUNNEL_PORT+'/echo',{method:'POST',body:big})).arrayBuffer());
  assert.ok(echoed.equals(big));
  const r=(await fetch('http://127.0.0.1:'+TUNNEL_PORT+'/stream')).body.getReader();
  assert.equal(Buffer.from((await r.read()).value).toString(),'first');
  release();let rest='';for(;;){const x=await r.read();if(x.done)break;rest+=Buffer.from(x.value).toString();}
  assert.equal(rest,'second');
  const exited=once(child,'close');child.stdin.end();await exited;
});
