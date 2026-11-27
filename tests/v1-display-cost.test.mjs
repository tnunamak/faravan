import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {currentProbeDigest} from '../lib/v1/credential-probe.mjs';
import {createCircleTransport} from '../lib/v1/circle-transport.mjs';
import {appFixture,api,waitFor} from './helpers/v1-app-fixture.mjs';
import {HARNESS_ADAPTERS} from '../lib/harnesses/index.mjs';

test('probe digest follows atomic replacements, in-place edits, deletion and recovery',async t=>{
  const dir=await mkdtemp(join(homedir(),'.tmp/probe-generation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'probe.mjs'),digest=text=>createHash('sha256').update(text).digest('hex').slice(0,16);
  await writeFile(file,'first');assert.equal(currentProbeDigest(file),digest('first'));assert.equal(currentProbeDigest(file),digest('first'));
  await writeFile(file+'.new','other');await rename(file+'.new',file);assert.equal(currentProbeDigest(file),digest('other'));
  await writeFile(file,'third');assert.equal(currentProbeDigest(file),digest('third'));
  await rm(file);assert.equal(currentProbeDigest(file),null);
  await writeFile(file,'again');assert.equal(currentProbeDigest(file),digest('again'));
});

test('circle transport reuses a connection while every response and authorization header is fresh',async t=>{
  let connections=0;const proofs=[];
  const server=createServer((req,res)=>{proofs.push(req.headers['faravan-proof']);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({n:proofs.length}));});
  server.on('connection',()=>connections++);server.listen(0,'127.0.0.1');await once(server,'listening');
  const transport=createCircleTransport();t.after(async()=>{transport.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(let i=0;i<8;i++)assert.equal((await (await transport.fetch('http://127.0.0.1:'+server.address().port,{headers:{'Faravan-Proof':String(i)}})).json()).n,i+1);
  assert.equal(connections,1);assert.deepEqual(proofs,Array.from({length:8},(_,i)=>String(i)));
  await assert.rejects(transport.fetch('http://127.0.0.1:'+server.address().port,{signal:AbortSignal.abort()}));
});

test('display device snapshots stay within one request; authoritative readers see cross-process changes', {timeout:60000},async t=>{
  const f=await appFixture(t),{app,home}=await f.start('display-snapshot');
  const snapshot=app.device.displaySnapshot(),before=await snapshot.listCircles();
  await f.provisionFromHome('display-snapshot');
  await api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'New circle'}});
  assert.deepEqual(await snapshot.listCircles(),before);
  assert.ok((await app.device.listCircles()).length>before.length);
  assert.ok((await app.device.displaySnapshot().listCircles()).length>before.length);
  assert.equal(snapshot.client,undefined);assert.equal(snapshot.withOperationLock,undefined);
});

test('an unknown background identity check retries on its own back-off, not on every tick',{timeout:120000},async t=>{
  let time=Date.now(),probes=0;
  const native=HARNESS_ADAPTERS.find(a=>a.spec.harness_id==='codex'),f=await appFixture(t);
  const {lender}=await f.connect({adapters:[{...native,installed:true,signedIn:false}],clock:{now:()=>time},lendingIdentityCacheMs:30000,
    lendingSignInProbe:async()=>({signedIn:null,secretPresent:true}),
    lendingIdentityProbe:async({harnessNames})=>{probes++;return {providers:[{harness_id:harnessNames[0],installed:true,signedIn:null}]};}});
  await api(lender.app,'/api/agents');
  await waitFor(async()=>probes===1&&!(await api(lender.app,'/api/agents'))[0].checking,'the first unknown probe');
  // Ticks inside the 30 s back-off run no second probe.
  time+=10000;await api(lender.app,'/api/agents');time+=10000;await api(lender.app,'/api/agents');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(probes,1,'ticks inside the back-off run no probe');
  // The back-off ends: the next tick retries with no configuration change.
  time+=10000;await api(lender.app,'/api/agents');
  await waitFor(()=>probes===2,'the background retry after the back-off',20000);
});

test('day keys reuse formatters without changing zones or DST boundaries',async()=>{
  const {lenderDayKey}=await import('../lib/v1/lender.mjs');
  for(const timeZone of ['America/Chicago','UTC','Pacific/Auckland','Asia/Kathmandu'])
    for(const at of [Date.parse('2026-03-08T07:59Z'),Date.parse('2026-03-08T08:01Z'),Date.parse('2026-11-01T06:59Z'),Date.parse('2026-11-01T07:01Z')]) {
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
      const get=key=>parts.find(p=>p.type===key).value,expected=get('year')+'-'+get('month')+'-'+get('day');
      assert.equal(lenderDayKey(at,timeZone),expected);assert.equal(lenderDayKey(at,timeZone),expected);
    }
  assert.throws(()=>lenderDayKey(Date.now(),'invalid zone'),RangeError);
});

test('display presence shares only an in-flight read and the next observation is fresh',{timeout:60000},async t=>{
  const f=await appFixture(t),{owner,circle}=await f.connect(),app=owner.app;
  const original=app.device.client.bind(app.device);let clients=0,presences=0,release;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  app.device.client=async(...args)=>{const client=await original(...args);clients++;
    return new Proxy(client,{get(target,key){if(key==='fetchPresence')return async(...values)=>{presences++;await gate;return target.fetchPresence(...values);};return target[key];}});};
  const path='/api/circles/'+circle.id+'/compose',reads=[api(app,path),api(app,path)];
  await waitFor(()=>clients>=2&&presences>=1);assert.equal(presences,1);release();await Promise.all(reads);
  await api(app,path);assert.equal(presences,2);
});

test('circle HTTPS pool verifies certificates and reuses a TLS connection',{timeout:60000},async t=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile);
  const {createServer}=await import('node:https'),{readFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(homedir(),'.tmp/circle-tls-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert]);
  let connections=0;const server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>res.end('fresh'));
  server.on('secureConnection',()=>connections++);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const transport=createCircleTransport();t.after(()=>transport.close());
  const url='https://127.0.0.1:'+server.address().port;
  await assert.rejects(transport.fetch(url),'untrusted self-signed certificate must be refused');
  const module=new URL('../lib/v1/circle-transport.mjs',import.meta.url).href;
  const script=`import {createCircleTransport} from ${JSON.stringify(module)};const t=createCircleTransport();try{for(let i=0;i<8;i++){if(await(await t.fetch(${JSON.stringify(url)})).text()!=='fresh')throw Error('bad body');}}finally{t.close();}`;
  await exec(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert}});
  assert.equal(connections,1);
});
