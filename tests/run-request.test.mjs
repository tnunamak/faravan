import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRunRequest,validateAccountAdvertisement,resolveSelection,selectionSatisfies,offersRunRequest} from '../lib/v1/run-request.mjs';

const model=(id,over={})=>({id,label:id,enabled:true,rank:0,pareto:null,efforts:[{id:'low',label:'Low'},{id:'high',label:'High'}],defaultEffort:'low',...over});
const accounts=[
  {accountId:'a1',providerId:'claude',models:[model('opus'),model('haiku',{efforts:[],defaultEffort:null})]},
  {accountId:'a2',providerId:'codex',models:[model('gpt',{pareto:true})]},
];
const req=(models='any',effortId=null)=>({schemaVersion:1,models,effortId});

test('a request is exactly the signed shape and nothing else',()=>{
  assert.equal(validateRunRequest(req()).ok,true);
  assert.equal(validateRunRequest(req([{providerId:'claude',modelId:'opus'}],'high')).ok,true);
  for(const bad of [null,{},{...req(),extra:1},{...req(),schemaVersion:2},req([]),req('all'),req('any',''),req('any',3),
    req([{providerId:'claude'}]),req([{providerId:'claude',modelId:'opus',x:1}]),
    req([{providerId:'claude',modelId:'opus'},{providerId:'claude',modelId:'opus'}]),req(Array.from({length:65},(_,i)=>({providerId:'p',modelId:'m'+i})))])
    assert.equal(validateRunRequest(bad).ok,false,JSON.stringify(bad));
});

test('an advertisement carries only ids and descriptor model data',()=>{
  assert.equal(validateAccountAdvertisement(accounts),true);
  assert.equal(validateAccountAdvertisement([{...accounts[0],subjectId:'person@example.invalid'}]),false);
  assert.equal(validateAccountAdvertisement([accounts[0],accounts[0]]),false);
  assert.equal(validateAccountAdvertisement([{...accounts[0],models:[model('m',{defaultEffort:'nope'})]}]),false);
});

test('selection follows saved account order, then saved model order, and resolves a null effort to the default',()=>{
  assert.deepEqual(resolveSelection({runRequest:req(),accounts}).value,{providerId:'claude',accountId:'a1',modelId:'opus',effortId:'low'});
  assert.deepEqual(resolveSelection({runRequest:req([{providerId:'codex',modelId:'gpt'}]),accounts}).value,{providerId:'codex',accountId:'a2',modelId:'gpt',effortId:'low'});
  const reversed=[accounts[1],accounts[0]];
  assert.equal(resolveSelection({runRequest:req(),accounts:reversed}).value.accountId,'a2');
});

test('an explicit effort is never downgraded; a model without efforts accepts only null',()=>{
  assert.equal(resolveSelection({runRequest:req('any','high'),accounts}).value.effortId,'high');
  assert.deepEqual(resolveSelection({runRequest:req([{providerId:'claude',modelId:'haiku'}],'high'),accounts}),{ok:false,code:'effort_unavailable'});
  assert.deepEqual(resolveSelection({runRequest:req([{providerId:'claude',modelId:'haiku'}],null),accounts}).value,
    {providerId:'claude',accountId:'a1',modelId:'haiku',effortId:null});
  assert.deepEqual(resolveSelection({runRequest:req('any','max'),accounts}),{ok:false,code:'effort_unavailable'});
});

test('selection failures name their cause and are not quota holds',()=>{
  assert.deepEqual(resolveSelection({runRequest:req([{providerId:'claude',modelId:'sonnet'}]),accounts}),{ok:false,code:'model_unavailable'});
  const disabled=[{...accounts[0],models:[model('opus',{enabled:false})]}];
  assert.deepEqual(resolveSelection({runRequest:req(),accounts:disabled}),{ok:false,code:'model_unavailable'});
  assert.deepEqual(resolveSelection({runRequest:req(),accounts,busy:()=>true}),{ok:false,code:'account_busy'});
  assert.equal(resolveSelection({runRequest:req(),accounts,busy:id=>id==='a1'}).value.accountId,'a2');
  assert.deepEqual(resolveSelection({runRequest:req(),accounts:[]}),{ok:false,code:'model_unavailable'});
  assert.deepEqual(resolveSelection({runRequest:{schemaVersion:1},accounts}),{ok:false,code:'adapter_unsupported'});
});

test('the Pareto filter excludes a model only when the owner enabled it',()=>{
  assert.equal(resolveSelection({runRequest:req(),accounts}).value.modelId,'opus');
  assert.deepEqual(resolveSelection({runRequest:req(),accounts,paretoOnly:true}).value,{providerId:'codex',accountId:'a2',modelId:'gpt',effortId:'low'});
});

test('the borrower accepts only a selection the signed request allowed',()=>{
  const chosen={providerId:'claude',accountId:'a1',modelId:'opus',effortId:'high'};
  assert.equal(selectionSatisfies(req(),chosen),true);
  assert.equal(selectionSatisfies(req([{providerId:'claude',modelId:'opus'}],'high'),chosen),true);
  assert.equal(selectionSatisfies(req([{providerId:'claude',modelId:'opus'}],'high'),{...chosen,effortId:'low'}),false,'no silent downgrade');
  assert.equal(selectionSatisfies(req([{providerId:'codex',modelId:'gpt'}]),chosen),false);
  assert.equal(selectionSatisfies(req(),{...chosen,subjectId:'x'}),false);
  assert.equal(selectionSatisfies(req(),null),false);
});

test('waiting eligibility uses fresh anonymous offers for the exact signed provider, model and effort',()=>{
  const offer={providerId:'claude',modelId:'opus',effortIds:['high']};
  const device={source:'heartbeat',capabilities:['run_request_v1'],account_offers:[offer]};
  const model=[{providerId:'claude',modelId:'opus'}];
  assert.equal(offersRunRequest(device,req(model,'high')),true);
  assert.equal(offersRunRequest(device,req(model,'low')),false);
  assert.equal(offersRunRequest(device,req([{...model[0],providerId:'codex'}],'high')),false);
  assert.equal(offersRunRequest(device,req('any','high')),true);
  assert.equal(offersRunRequest(device,req(model)),true);
  assert.equal(offersRunRequest({...device,source:'poll'},req(model,'high')),false);
  assert.equal(offersRunRequest({...device,capabilities:[]},req(model,'high')),false);
  const withdrawn={...device,account_offers:[{...offer,providerId:'codex'},{...offer,effortIds:['low']}]};
  assert.equal(offersRunRequest(withdrawn,req(model,'high')),false);
  assert.equal(offersRunRequest({...withdrawn,account_offers:[...withdrawn.account_offers,offer]},req(model,'high')),true);
  assert.equal(offersRunRequest({...device,account_offers:[]},req(model,'high')),false);
  assert.equal(offersRunRequest({...device,account_offers:[null,{...offer,effortIds:'high'}]},req()),false);
});
