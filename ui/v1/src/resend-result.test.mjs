import test from 'node:test';
import assert from 'node:assert/strict';
import {resendResultDraft} from './resend-result.mjs';
test('sending to someone else uses a fresh identity and the original source, never a native session or result-as-base',()=>{
 const old={id:'old-id',prompt:'old',sending:false,followup:{parentJob:'parent'},base:{commit:'c'},sourceKind:'git',gitUrl:'https://example.com/project.git',gitCommit:'c'};
 const out=resendResultDraft({current:old,prompt:'Original request',sourceFolder:'/code/project',job:{local:{agent:'codex'}}});
 assert.notEqual(out.id,old.id);assert.equal(out.prompt,'Original request');assert.equal(out.path,'/code/project');assert.equal(out.followup??null,null);assert.equal(out.base??null,null);assert.equal(out.sourceKind,'folder');assert.equal(out.sending,false);
});
test('an uncertain in-flight send must be resolved first',()=>{
 assert.throws(()=>resendResultDraft({current:{sending:true},prompt:'Again'}),/earlier send/);
});
