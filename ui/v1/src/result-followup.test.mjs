import test from 'node:test';
import assert from 'node:assert/strict';
import {saveFollowupRequest} from './result-followup.mjs';
test('review notes and answers persist as the delta after the existing handoff-based draft is prepared',()=>{
 let saved;
 const prepared={ok:true,draft:{id:'draft-id-123',prompt:'',followup:{parentJob:'parent',parentResult:'result'},base:{commit:'c'}}};
 const result=saveFollowupRequest({prepare:()=>prepared,save:(_storage,_circle,value)=>{saved=value;},storage:{},circle:'c',continuation:{},request:'Please handle null.'});
 assert.equal(result.ok,true);assert.equal(saved.prompt,'Please handle null.');assert.deepEqual(saved.followup,prepared.draft.followup);
});
test('a preparation refusal never overwrites a draft or navigates',()=>{
 let writes=0;
 assert.deepEqual(saveFollowupRequest({prepare:()=>({ok:false,error:'Sending'}),save:()=>writes++,request:'answer'}),{ok:false,error:'Sending'});assert.equal(writes,0);
});

test('notes and question answers use the same real continuation draft, including no-project parents',async()=>{
 const {prepareFollowupDraft}=await import('./job-thread.mjs');
 const {saveDraft,loadDraft,draftBody}=await import('./compose-draft.mjs');
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const parent='sha256:'+'a'.repeat(64),result='sha256:'+'b'.repeat(64);
 const saved=saveFollowupRequest({prepare:prepareFollowupDraft,save:saveDraft,storage,circle:'c',continuation:{parentJob:parent,parentResult:result,base:{},sourceKind:'none'},request:'Use UTC.'});
 assert.equal(saved.ok,true);const draft=loadDraft(storage,'c');assert.equal(draft.prompt,'Use UTC.');assert.equal(draft.sourceKind,'none');
 assert.deepEqual(draftBody(draft,'c').followup,{parentJob:parent,parentResult:result});
});
