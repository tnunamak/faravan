import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createUpdater} from '../lib/v1/self-update.mjs';
import {createUpdateService} from '../lib/v1/update-service.mjs';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {buildSignedManifest} from '../packaging/sign-update.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();await new Promise(resolve=>setImmediate(resolve));};

async function feed(t) {
  const root=await mkdtemp(join(tmpdir(),'manual-update-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const installDir=join(root,'install'),stateFile=join(root,'home/v1/update.json');
  await mkdir(installDir);await writeFile(join(installDir,'VERSION'),'0.1.0');
  const keys=generateKeyPairSync('ed25519'),now=Date.parse('2026-11-07T00:00:00Z');
  const signed=buildSignedManifest({version:'0.2.0',releasedAt:new Date(now),tarball:Buffer.from('archive'),tarballUrl:'https://example.test/app.tar.gz',
    privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const entered=gate(),download=gate(),requests=[];
  let parked=false;
  const updater=createUpdater({installDir,stateFile,arch:'x64',now:()=>now,
    publicKey:keys.publicKey.export({type:'spki',format:'pem'}),manifestUrl:'https://example.test/update.json',
    fetch:async url=>{
      requests.push(url);
      if(!url.endsWith('.sig')&&parked){entered.resolve();await download.promise;}
      return new Response(url.endsWith('.sig')?signed.signature:signed.bytes);
    }});
  return {root,stateFile,updater,requests,entered,download,park:()=>{parked=true;},
    state:()=>readFile(stateFile,'utf8').then(JSON.parse,()=>({}))};
}

test('an HTTP manual check stays owned through Quit and cannot write after its parked fetch resumes',async t=>{
  const s=await feed(t),f=await appFixture(t),{app}=await f.start('manual',{updater:s.updater});
  s.park();
  const checking=api(app,'/api/updates/check',{method:'POST',body:{}}).catch(error=>error);
  let stopping,closed=false;
  try {
    await s.entered.promise;
    await api(app,'/api/shutdown',{method:'POST',body:{},status:202});
    stopping=app.close().then(result=>{closed=true;return result;});await flush();
    await Promise.race([stopping,new Promise(resolve=>setTimeout(resolve,300))]);
    const closedBeforeFetch=closed;
    s.download.resolve();await checking;await stopping;
    const state=await s.state();
    t.diagnostic(JSON.stringify({closedBeforeFetch,downloads:s.requests.length,stateWritten:Object.keys(state).length>0}));
    assert.equal(closedBeforeFetch,false,'the updater drain owns the entire manual check');
    assert.equal(s.requests.length,1,'an aborted check cannot fetch the signature later');
    assert.deepEqual(state,{});
  }finally{s.download.resolve();await checking;await (stopping??app.close());}
});

test('manual checks are refused during Quit proof and work again after refusal',async t=>{
  let checks=0;const entered=gate(),proof=gate();
  const updater={check:async()=>{checks++;return {current:'0.1.0',manifest:null};},status:async()=>({}),startDelayMs:60_000};
  const f=await appFixture(t),{app,backend,home}=await f.start('manual-hold',{updater,shutdownProofMs:2000});
  backend.reconcilePending=async record=>{entered.resolve();await proof.promise;return {removed:false,attemptId:record.attemptId};};
  const counters=join(home,'v1/app-counters.json');
  await writeFile(counters,JSON.stringify({pending:{attemptId:'test-stop',...backend.sandboxOwnership(),attempt:{attempt_id:'test-stop',job_digest:'sha256:'+'a'.repeat(64),generation:1}}}));
  const quitting=api(app,'/api/shutdown',{method:'POST',body:{},status:409});
  try {
    await entered.promise;
    await api(app,'/api/updates/check',{method:'POST',body:{},status:409});assert.equal(checks,0);
    proof.resolve();await quitting;await writeFile(counters,'{}');
    await api(app,'/api/updates/check',{method:'POST',body:{}});assert.equal(checks,1);
  }finally{proof.resolve();await quitting;await writeFile(counters,'{}');}
});

test('manual check state replacement is fenced after private preparation',async t=>{
  const s=await feed(t),entered=gate(),resume=gate(),owner=new AppLifetime();
  const handle=owner.register('updater','producer',{blockedByHold:true});
  const open=fs.promises.open;
  t.mock.method(fs.promises,'open',async(...args)=>{
    const file=await open(...args);
    if(String(args[0]).startsWith(s.stateFile+'.')&&String(args[0]).endsWith('.tmp')) {
      const sync=file.sync.bind(file);file.sync=async()=>{await sync();entered.resolve();await resume.promise;};
    }
    return file;
  });
  const work=handle.run(({signal})=>s.updater.check({signal,admit:()=>handle.commit(()=>{}),commit:replace=>handle.commit(replace)})).catch(error=>error);
  try {
    await entered.promise;
    const stopping=owner.stop('quit');resume.resolve();await work;await stopping;
    assert.equal(await access(s.stateFile).then(()=>true,()=>false),false,'sealed ownership cannot replace update.json');
  }finally{resume.resolve();await work;await owner.stop('quit');}
});

test('a closed update service refuses new manual checks',async()=>{
  let calls=0;
  const service=createUpdateService({updater:{check:async()=>{calls++;return {current:'0.1.0',manifest:null};}}});
  service.close();await assert.rejects(service.check(),{code:'app_closing'});assert.equal(calls,0);
});
