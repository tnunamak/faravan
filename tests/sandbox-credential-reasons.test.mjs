import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {restrictCredentialScope,acquireCredentialMutation,parseCredentialListing} from '../lib/sandbox-credentials.mjs';

const secret='private-credential-value-canary';
const empty=()=>({secrets:[],custom_secrets:[],shadowed_services:[],env_only_count:0});
function runner(listing,{forwarding='false',socket='""'}={}) {
 return async args=>({code:0,stdout:args[0]==='secret'?JSON.stringify(listing):args[1]==='get'?(args[2]==='ssh.agentForwardingEnabled'?forwarding:socket):'',stderr:''});
}
const job={image:'claude',github_access_required:false};
function refusal(condition,kind) {
 return error=>{
  assert.equal(error.code,'credential_scope_unenforceable');
  assert.equal(error.condition,condition);
  assert.equal(error.credentialKind,kind);
  assert.equal(JSON.stringify(error).includes(secret),false);
  assert.equal(error.message.includes(secret),false);
  return true;
 };
}
test('a valid empty credential scope remains accepted',async()=>{
 await restrictCredentialScope(runner(empty()),job,'sandbox-1');
});
test('an unrelated service is named by kind without its secret or name',async()=>{
 const listing=empty();listing.secrets.push({type:'service',name:secret,scope:'global',value:secret});
 await assert.rejects(restrictCredentialScope(runner(listing),job,'sandbox-1'),refusal('unrelated_service_credential','service'));
});
test('custom credentials have a distinct sanitized refusal',async()=>{
 const listing=empty();listing.custom_secrets.push({scope:'global',name:secret,value:secret});
 await assert.rejects(restrictCredentialScope(runner(listing),job,'sandbox-1'),refusal('custom_credential','custom'));
});
test('environment-only authority is distinct from an unsupported listing',()=>{
 const listing=empty();listing.env_only_count=1;
 assert.throws(()=>parseCredentialListing({code:0,stdout:JSON.stringify(listing)}),refusal('environment_credential','environment'));
 const extra={...empty(),[secret]:secret};
 assert.throws(()=>parseCredentialListing({code:0,stdout:JSON.stringify(extra)}),refusal('listing_shape_unsupported',null));
});
test('invalid listing text is never reflected into the error',()=>{
 assert.throws(()=>parseCredentialListing({code:0,stdout:secret}),refusal('listing_json_invalid',null));
});
test('SSH forwarding and socket authority identify the exact failed check',async()=>{
 await assert.rejects(restrictCredentialScope(runner(empty(),{forwarding:'true'}),job,'sandbox-1'),refusal('ssh_forwarding_enabled','ssh_agent'));
 await assert.rejects(restrictCredentialScope(runner(empty(),{socket:secret}),job,'sandbox-1'),refusal('ssh_socket_present','ssh_agent'));
});
test('another prepared sandbox has a distinct mutation refusal',async t=>{
 const home=await mkdtemp(join(tmpdir(),'scope-reason-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,'scratch-journal'));
 await writeFile(join(home,'scratch-journal','other-sandbox.json'),'{}');
 await assert.rejects(acquireCredentialMutation(home,{sandboxId:'sandbox-1'}),refusal('other_sandbox_lease','shared_store'));
 await assert.rejects(acquireCredentialMutation(home,{sandboxId:'sandbox-1',leaseWaitMs:150,leasePollMs:20}),refusal('other_sandbox_lease','shared_store'));
});
test('a bounded wait outlasts another sandbox lease',async t=>{
 const home=await mkdtemp(join(tmpdir(),'scope-reason-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,'scratch-journal'));
 const lease=join(home,'scratch-journal','other-sandbox.json');
 await writeFile(lease,'{}');
 const waiting=acquireCredentialMutation(home,{sandboxId:'sandbox-1',leaseWaitMs:5000,leasePollMs:20});
 await new Promise(resolve=>setTimeout(resolve,100));
 await rm(lease);
 const release=await waiting; await release();
});
test('a bounded wait outlasts a preparation that holds the credential lock',async t=>{
 const home=await mkdtemp(join(tmpdir(),'scope-reason-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const held=await acquireCredentialMutation(home,{concurrentSources:true});
 await assert.rejects(acquireCredentialMutation(home,{sandboxId:'sandbox-1'}),refusal('mutation_lock_unavailable',null));
 const waiting=acquireCredentialMutation(home,{sandboxId:'sandbox-1',leaseWaitMs:5000,leasePollMs:20});
 setTimeout(()=>held(),100);
 const release=await waiting; await release();
});
