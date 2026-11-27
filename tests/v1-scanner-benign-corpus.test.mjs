import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHandoff,scanCredentialText} from '../lib/v1/continuation.mjs';
import {benignCorpus} from './helpers/benign-scanner-corpus.mjs';
test('the corpus has 20 samples',()=>assert.equal(benignCorpus.length,20));
for(const {id,text} of benignCorpus)test('benign coding-agent sample '+id+' is not withheld',()=>{
  assert.equal(scanCredentialText(text).ok,true);
  const handoff=buildHandoff({prompt:'Continue the work',transcript:JSON.stringify({type:'result',result:text})});
  assert.equal(handoff.scan.status,'passed');
  assert.notEqual(handoff.agent_claims,'');
});
