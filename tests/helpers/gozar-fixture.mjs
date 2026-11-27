import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,request} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {createTestingGozar,fakeRegistry} from '@tnunamak/gozar/testing';

export const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
export const stop = server => new Promise(resolve => {server.closeAllConnections();server.close(resolve);});
export function send(target,{path,method='GET',headers={},body}) {
  return new Promise((resolve,reject)=>{
    let last=performance.now();
    const req=request('http://'+target+path,{method,headers},res=>{
      const chunks=[];
      res.on('data',chunk=>{
        const at=performance.now();
        chunks.push({chunk,delayMs:Math.round(at-last)});
        last=at;
      });
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,
        bytes:Buffer.concat(chunks.map(row=>row.chunk)),
        chunks:chunks.map(({chunk,delayMs})=>({data:chunk.toString('base64'),delayMs}))}));
    });
    req.on('error',reject);req.end(body);
  });
}
async function listenProxy(target) {
  const server=createServer((req,res)=>{
    const upstream=request('http://'+target+req.url,{method:req.method,headers:req.headers},reply=>{
      res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
    });
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  await listen(server);
  return server;
}

/** Extension from the installed testing export. Actual HTTP bytes cross its loopback transport. */
export async function gozarFixture(directory,{kind='attached',reach='internet',secretBackend,setupActions=[],extend}={}) {
  const id='random-'+randomUUID();
  const registry=await fakeRegistry({id,dir:join(directory,'registry'),kinds:kind==='durable'?['attached','durable']:[kind],reach,setupActions,
    protocols:['streamable-http','oauth-dcr',...(kind==='attached'?['sse']:[])]});
  const folder=join(registry.root,'providers',id);
  const definitionFile=join(folder,'definition.json');
  const definition=JSON.parse(await readFile(definitionFile));
  definition.adapter.capabilities.address.stability='stable';
  await writeFile(definitionFile,JSON.stringify(definition));
  await extend?.(folder);
  const opened=new Map(),proofTargets=[];
  let proofFailure=false,closeFailure=false;
  const harness=await createTestingGozar({manifest:registry.manifest,root:registry.root,secretBackend,
    effects:[
      {kind:'process-runtime',operation:'open',async handle({origin,target}) {
        const handle=randomUUID(),server=await listenProxy(target);
        opened.set(handle,{origin,target,server});return {handle};
      }},
      {kind:'process-runtime',operation:'read',async handle({handle}) {return {present:opened.get(handle)?.server.listening===true};}},
      {kind:'process-runtime',operation:'close',async handle({handle}) {
        if(closeFailure)return {closed:false};
        const entry=opened.get(handle);
        if(entry?.server.listening)await stop(entry.server);
        return {closed:true};
      }},
      {kind:'recipe',operation:'probe',async handle() {return {stdout:'',stderr:'',exitCode:0};}},
      {kind:'network',operation:'fetch',async handle({url,headers}) {
        const endpoint=new URL(url);
        if(proofFailure && (endpoint.hostname!=='127.0.0.1' && endpoint.hostname.endsWith('.invalid')))
          return {status:502,headers:{},chunks:[]};
        let target;
        if(endpoint.hostname==='127.0.0.1')target=endpoint.host;
        else if(kind==='durable') {
          assert.ok(endpoint.hostname.endsWith('.'+id+'.invalid'));
          const rules=JSON.parse(await readFile(join(folder,'store.json')));
          target=rules.entries[endpoint.hostname.split('.')[0]]?.rule?.forward;
        } else {
          const record=[...opened.values()].find(row=>row.origin===endpoint.origin&&row.server.listening);
          assert.ok(record,'Proof may reach only a Gozar-owned forwarder');
          proofTargets.push(record.target);
          target='127.0.0.1:'+record.server.address().port;
        }
        if(!target)return {status:502,headers:{},chunks:[]};
        const reply=await send(target,{path:endpoint.pathname+endpoint.search,headers:{host:endpoint.host,...headers}});
        return {status:reply.status,headers:reply.headers,chunks:reply.chunks};
      }},
    ]});
  return {id,kind,gozar:harness.gozar,opened,proofTargets,folder,
    failProof:value=>{proofFailure=value;},failClose:value=>{closeFailure=value;},
    async close(){
      closeFailure=false;
      try {await harness.close();}
      finally {
        await Promise.all([...opened.values()].filter(({server})=>server.listening).map(({server})=>stop(server)));
        await registry.cleanup();
      }
    }};
}

export async function stagedExposure(t, options) {
  const base=join(userInfo().homedir,'.tmp');
  await mkdir(base,{recursive:true});
  const directory=await mkdtemp(join(base,'fh-'));
  const fixture=await gozarFixture(directory,options);
  t.after(async()=>{try{await fixture.close();}finally{await rm(directory,{recursive:true,force:true});}});
  return fixture;
}

export async function approveChatgpt(app,home,fixture,{body={},approve=true}={}) {
  const {chatgptHosting}=await import('../../lib/coordinator-hosting.mjs');
  const call=(input,status=200)=>fetch(app.origin+'/api/chatgpt/start',{method:'POST',headers:{
    'x-faravan-session-token':app.token,'content-type':'application/json',
  },body:JSON.stringify(input)}).then(async response=>{
    const payload=await response.json();
    assert.equal(response.status,status,JSON.stringify(payload));return payload;
  });
  const pending=await call(body);
  assert.equal(pending.status,'approval_required');
  if(!approve)return pending;
  const exposure=chatgptHosting(join(home,'v1'),fixture.gozar);
  const usage=fixture.kind;
  const spec={...pending.spec,usage};
  const [choice]=await exposure.offers(spec);
  assert.ok(choice?.approval, 'the installed package offered the selected usage');
  await exposure.select(spec,choice);
  await exposure.authorize(choice.consent.consentFactsDigest,{binding:pending.approvalBinding});
  return call({...body,approveExposure:true});
}

// A detached fixture controller uses Unix sockets below the app profile.
export async function shortGozarAppHome(t, apps, name) {
  const directory=await mkdtemp(join(userInfo().homedir,'.tmp','fa-'));
  apps.homes.set(name,directory);
  t.after(()=>rm(directory,{recursive:true,force:true}));
}
