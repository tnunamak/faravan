import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {removeSandboxPolicies} from '../lib/sandbox-policy-cleanup.mjs';

const name='wf-0000000000000000';
const rule={id:'owned',scope:'sandbox:'+name,applies_to:'sandbox:'+name,status:'active',resource_type:'network',editable:true};
test('policy cleanup requires a complete parseable listing and exact scope',async()=>{
 for(const listing of [null,'oops',{},[],{rules:null}]) {
  const calls=[];const ok=await removeSandboxPolicies(async args=>{calls.push(args);return {code:0,stdout:JSON.stringify(listing)};},name);
  assert.equal(ok,false);assert.equal(calls.some(a=>a[1]==='rm'),false);
 }
 const calls=[];await removeSandboxPolicies(async args=>{calls.push(args);return {code:0,stdout:JSON.stringify({rules:[{...rule,applies_to:'all',scope:'all'}]})};},name);
 assert.equal(calls.some(a=>a[1]==='rm'),false);
});
test('policy cleanup proves removal, refuses noneditable rules and preserves failed receipts',async()=>{
 for(const row of [rule,{...rule,editable:false}]) {
  const calls=[];const ok=await removeSandboxPolicies(async args=>{calls.push(args);return {code:0,stdout:JSON.stringify({rules:[row]})};},name);
  assert.equal(ok,false);
  assert.equal(calls.filter(a=>a[1]==='rm').length,row.editable?1:0);
 }
});

test('ambiguous or duplicate scoped rules cause no mutation',async()=>{
 for(const rules of [[rule,rule],[rule,{...rule,id:undefined}],[{...rule,scope:'all'}],[null]]){
  const calls=[];assert.equal(await removeSandboxPolicies(async args=>{calls.push(args);return {code:0,stdout:JSON.stringify({rules})};},name),false);
  assert.equal(calls.some(a=>a[1]==='rm'),false);
 }
});

test('noneditable policies are blocked only after editable siblings are removed and listed again',async()=>{
 for(const rules of [[{...rule,id:'locked',editable:false},rule],[rule,{...rule,id:'locked',editable:false}]]){
  let remaining=[...rules];const calls=[],details={};
  const removed=await removeSandboxPolicies(async args=>{
   calls.push(args);
   if(args[1]==='rm')remaining=remaining.filter(row=>row.id!==args[args.indexOf('--id')+1]);
   return {code:0,stdout:JSON.stringify({rules:remaining})};
  },name,details);
  assert.equal(removed,false);assert.equal(details.blocked,true);
  assert.deepEqual(calls.filter(args=>args[1]==='rm').map(args=>args[args.indexOf('--id')+1]),['owned']);
  assert.equal(calls.at(-1)[1],'ls');assert.deepEqual(remaining.map(row=>row.id),['locked']);
 }
});
test('blocked classification rejects failed removal and incomplete initial or final listings',async()=>{
 const locked={...rule,id:'locked',editable:false};
 const invalid=[{code:1,stdout:'{"rules":[]}'},{code:0,stdout:'oops'},
  ...[[{...locked,id:undefined}],[locked,locked],[locked,rule]].map(rules=>({code:0,stdout:JSON.stringify({rules})}))];
 for(const final of invalid){
  let listed=0;const details={blocked:true};
  assert.equal(await removeSandboxPolicies(async args=>args[1]==='ls'&&listed++>0?final:
   {code:0,stdout:JSON.stringify({rules:[locked]})},name,details),false);
  assert.equal(details.blocked,false);
 }
 for(const rules of [[{...locked,id:undefined}],[locked,locked],[locked,rule]]){
  const details={};let removals=0;
  assert.equal(await removeSandboxPolicies(async args=>{
   if(args[1]==='rm'){removals++;return {code:1};}
   return {code:0,stdout:JSON.stringify({rules})};
  },name,details),false);
  assert.notEqual(details.blocked,true);assert.equal(removals,rules.includes(rule)?1:0);
 }
});

const provisioned={...rule,editable:false,layer:'local',origin:'scoped',
 provenance:{created_via:'provisioned',source:'sandboxes'}};
const policyListing=()=>({code:0,stderr:'',stdout:JSON.stringify({rules:[provisioned]})});
const incompletePolicyResults=[
 ['stderr',{stderr:'partial policy listing'}],['truncated',{truncated:true}],
 ['timedOut',{timedOut:true}],['killed',{killed:true}],['errorCode',{errorCode:'EPIPE'}],
 ['exit status',{code:1}],['invalid JSON',{stdout:'oops'}],
];
for(const [label,override] of incompletePolicyResults)for(const failedRead of [1,2])
test(`provisioned policy stays pending with ${label} on read ${failedRead}`,async()=>{
 let reads=0;const calls=[],details={};
 const result=await removeSandboxPolicies(async args=>{
  calls.push(args);assert.equal(args[1],'ls');
  return {...policyListing(),...(++reads===failedRead?override:{})};
 },name,details,{leaveProvisioned:true});
 assert.equal(result,false);assert.equal(details.failure,'listing_failed');
 assert.equal(details.blocked,false);assert.equal(details.left,undefined);
 assert.equal(calls.length,failedRead);
});
test('complete provisioned policy listings pass only the explicit exception',async()=>{
 for(const leaveProvisioned of [false,true]){
  let reads=0;const details={};
  const result=await removeSandboxPolicies(async args=>{
   assert.equal(args[1],'ls');reads++;return policyListing();
  },name,details,{leaveProvisioned});
  assert.equal(result,leaveProvisioned);assert.equal(reads,2);
  assert.equal(details.left,leaveProvisioned?1:undefined);
 }
});
