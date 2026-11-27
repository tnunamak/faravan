import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {proveDurableCessation} from '../lib/v1/durable-cessation.mjs';

// Pooled counters: one journal per account; root.pending mirrors only the first account that has one.
const attempt=(id,job)=>({attempt_id:id,job_digest:job,generation:1});
const proven=(id,job)=>({owner_scope:'f'.repeat(64),sbx_home:'/synthetic/home',attemptId:id,attempt:attempt(id,job),cessationVerified:{sbx_home:'/synthetic/home',attemptId:id,jobDigest:job,generation:1}});
const open=(id,job)=>({attemptId:id,attempt:attempt(id,job)});
const pooled=(a,b)=>({jobs:2,milliseconds:0,pending:a,accounts:{'claude:0':{pending:a},'codex:0':{pending:b}}});
const store=value=>({get:async()=>structuredClone(value)});
function inventory(removed){const asked=[];return {asked,reconcilePending:async p=>{asked.push(p.attemptId);return {removed:removed.includes(p.attemptId),attemptId:p.attemptId};}};}

test('after a restart every pooled account\'s sandbox must be proven gone, not only the one root.pending mirrors',async()=>{
 const backend=inventory(['A']);
 const result=await proveDurableCessation({store:store(pooled(proven('A','ja'),open('B','jb'))),backend});
 assert.equal(result.proven,false);assert.equal(result.attemptId,'B');
 assert.deepEqual(backend.asked,['B'],'the already-proven attempt is not re-asked');
});
test('two unproven pooled sandboxes are each reconciled; all gone is proof',async()=>{
 const backend=inventory(['A','B']);
 const result=await proveDurableCessation({store:store(pooled(open('A','ja'),open('B','jb'))),backend});
 assert.equal(result.proven,true);assert.deepEqual(backend.asked.sort(),['A','B']);
});
test('one sandbox still present among several fails with that attempt',async()=>{
 const result=await proveDurableCessation({store:store(pooled(open('A','ja'),open('B','jb'))),backend:inventory(['A'])});
 assert.deepEqual({proven:result.proven,attemptId:result.attemptId},{proven:false,attemptId:'B'});
});
test('a running pool that reports proven still fails while any persisted account journal is unproven',async()=>{
 const lender={cessation:()=>({proven:true,attemptId:null})};
 const result=await proveDurableCessation({store:store(pooled(proven('A','ja'),open('B','jb'))),backend:inventory([]),lender});
 assert.deepEqual({proven:result.proven,attemptId:result.attemptId,reason:result.reason},{proven:false,attemptId:'B',reason:'lender_recovering'});
});
test('single-account counters keep their old behaviour',async()=>{
 assert.equal((await proveDurableCessation({store:store({pending:null}),backend:inventory([])})).proven,true);
 assert.equal((await proveDurableCessation({store:store({pending:proven('A','ja')}),backend:inventory([])})).proven,true);
 assert.deepEqual(await proveDurableCessation({store:store({pending:open('A','ja')}),backend:inventory(['A'])}),{proven:true,attemptId:'A'});
});
