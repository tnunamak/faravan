import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAccountStore,publicAccount} from '../../lib/v1/accounts.mjs';
import {createAccountVault} from '../../lib/v1/account-vault.mjs';
import {durableJson} from '../../lib/durable-write.mjs';
import {createAccountBroker} from '../../lib/v1/account-broker.mjs';

function fixture(t, options = {}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'faravan-vault-test-'));
  const cleanup=[];
  t.after(async()=>{
    try {for(const close of cleanup.reverse())await close();}
    finally {fs.rmSync(directory,{recursive:true,force:true});}
  });
  const store=createAccountStore({directory,...options});
  return {directory,store,cleanup,metadata:()=>JSON.parse(fs.readFileSync(path.join(directory,'accounts.json'),'utf8'))};
}
const record=(id,secret)=>({schemaVersion:1,id,providerId:'synthetic',label:id,
  authState:'signed_in',generation:0,expiresAtMs:null,enabled:true,modelOrder:[],modelPreferences:{model:{enabled:true,effortIds:null}},
  subjectId:'subject-'+id,secret,refreshIntent:null});
const seed=(store,...records)=>store.transaction(s=>{for(const r of records)s.records[r.id]=r;});

test('two same-provider accounts survive restart; metadata/public output exclude values',async t=>{
  const f=fixture(t);
  await seed(f.store,record('one',{sentinel:'FAKE-ONE'}),record('two',{sentinel:'FAKE-TWO'}));
  assert.equal(JSON.stringify(f.metadata()).includes('FAKE-'),false);
  const restarted=createAccountStore({directory:f.directory});
  assert.deepEqual(restarted.get('one').secret,{sentinel:'FAKE-ONE'});
  assert.deepEqual(restarted.get('two').secret,{sentinel:'FAKE-TWO'});
  assert.equal(JSON.stringify(publicAccount(restarted.get('one'))).includes('secret'),false);
  assert.equal(JSON.stringify(publicAccount(restarted.get('one'))).includes('FAKE-'),false);
  const vaultDir=path.join(f.directory,'account-vault');
  assert.equal(fs.statSync(vaultDir).mode&0o077,0);
  for(const file of fs.readdirSync(vaultDir))assert.equal(fs.statSync(path.join(vaultDir,file)).mode&0o077,0);
});

test('foreign account, provider, generation and traversal references fail closed',async t=>{
  const f=fixture(t);await seed(f.store,record('one','FAKE-ONE'),record('two','FAKE-TWO'));
  const vault=createAccountVault({directory:path.join(f.directory,'account-vault')});
  const ref=f.metadata().records.one.secretRef;
  for(const account of [record('two',null),{...record('one',null),providerId:'other'},
    {...record('one',null),generation:1}])
    assert.throws(()=>vault.get(ref,account),/invalid_account_secret_reference/);
  assert.throws(()=>vault.get({...ref,id:'../accounts'},record('one',null)),/invalid_account_secret_reference/);
  await assert.rejects(f.store.transaction(s=>{s.records.two.secretRef=ref;}),/invalid_account_secret_reference/);
  assert.equal(f.store.get('two').secret,'FAKE-TWO');
});

test('generation CAS and refresh intent survive restart; publication failure leaves old generation',async t=>{
  let failPublish=false;
  const f=fixture(t,{publishMetadata:(file,state)=>{
    if(failPublish)throw new Error('synthetic_publish_failure');
    return durableJson(file,state);
  }});await seed(f.store,record('one','FAKE-OLD'));
  assert.equal(await f.store.compareAndSwap('one',0,{refreshIntent:{id:'intent',generation:0}}),true);
  assert.equal(await f.store.compareAndSwap('one',9,{secret:'FAKE-WRONG'}),false);
  const old=f.metadata().records.one.secretRef;
  // Inject a failure after immutable object creation, before metadata publication.
  failPublish=true;
  try {
    await assert.rejects(f.store.compareAndSwap('one',0,{secret:'FAKE-NEW',generation:1,refreshIntent:null}),
      /synthetic_publish_failure/);
  } finally {failPublish=false;}
  let restarted=createAccountStore({directory:f.directory});
  assert.equal(restarted.get('one').secret,'FAKE-OLD');
  assert.equal(restarted.get('one').generation,0);
  assert.equal(restarted.get('one').refreshIntent.id,'intent');
  assert.equal(await restarted.compareAndSwap('one',0,{secret:'FAKE-NEW',generation:1,refreshIntent:null}),true);
  restarted=createAccountStore({directory:f.directory});
  assert.equal(restarted.get('one').secret,'FAKE-NEW');
  assert.equal(restarted.get('one').refreshIntent,null);
  // A reader holding the previous metadata still has a valid immutable object.
  const vault=createAccountVault({directory:path.join(f.directory,'account-vault')});
  assert.equal(vault.get(old,record('one',null)),'FAKE-OLD');
});

test('removal deletes tracked generations only after metadata removal',async t=>{
  const f=fixture(t);await seed(f.store,record('one','FAKE-OLD'),record('two','FAKE-TWO'));
  await f.store.compareAndSwap('one',0,{secret:'FAKE-NEW',generation:1});
  const refs=f.metadata().records.one.secretRefs;
  await f.store.transaction(s=>{s.records.one.removalIntent={atMs:1};s.records.one.enabled=false;});
  for(const ref of refs)assert.ok(fs.existsSync(path.join(f.directory,'account-vault',ref.id+'.json')));
  await f.store.transaction(s=>{delete s.records.one;});
  for(const ref of refs)assert.equal(fs.existsSync(path.join(f.directory,'account-vault',ref.id+'.json')),false);
  assert.equal(f.store.get('one'),null);assert.equal(f.store.get('two').secret,'FAKE-TWO');
});

test('unchanged broker ports hydrate only host auth; public account and guest lease exclude host secret',async t=>{
  const f=fixture(t);await seed(f.store,record('one',{sentinel:'FAKE-HOST'}));
  const adapter={descriptor:{refreshKind:'none',models:[{id:'model',enabled:true,efforts:[],defaultEffort:null}]}};
  const broker=createAccountBroker({store:f.store,providers:{getProvider:()=>({ok:true,value:adapter})},
    clock:()=>1000,authority:{verify:async()=>({ok:true,value:{expiresAtMs:100000,fence:1}})},
    proxy:{revokeStreams:async()=>({aborted:[],unconfirmed:[]})}});
  f.cleanup.push(()=>broker.close());
  let hostSeen;
  assert.equal((await broker.withAuth('one',auth=>{hostSeen=auth;return 'host-only';})).ok,true);
  assert.deepEqual(hostSeen.secret,{sentinel:'FAKE-HOST'});
  const lease=await broker.issueJobKey({selection:{accountId:'one',providerId:'synthetic',modelId:'model',effortId:null},
    jobId:'job',attemptId:'attempt',leaseProof:{schemaVersion:1,signedEnvelope:'SYNTHETIC'}});
  assert.equal(lease.ok,true);
  assert.equal(JSON.stringify(lease).includes('FAKE-HOST'),false);
  assert.equal(JSON.stringify(await broker.list()).includes('FAKE-HOST'),false);
});
