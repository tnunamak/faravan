import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadDraft,saveDraft,restoreDraft,draftBody,COMPOSE_DRAFT_PREFIX} from './compose-draft.mjs';
const memory=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),clear:()=>values.clear()};};
test('restore preserves long explicit opaque model and effort IDs without silent downgrade',()=>{
  const storage=memory();
  try {
    const draft={...loadDraft(storage,'circle'),prompt:'Synthetic task',sourceKind:'none',agent:'synthetic',
      model:'model-'+ 'x'.repeat(100),effort:'effort-'+ 'y'.repeat(40),sending:true,uncertainSince:100};
    assert.equal(saveDraft(storage,'circle',draft),true);
    const restored=restoreDraft(storage,'circle');
    assert.equal(restored.state,'saved');
    assert.equal(restored.draft.model,draft.model);
    assert.equal(restored.draft.effort,draft.effort);
    assert.equal(restored.draft.id,draft.id);
    assert.deepEqual(draftBody(restored.draft,'circle'),draftBody(draft,'circle'));
  } finally {storage.clear();}
});
test('ambiguous send and send-anyway preserve explicit selection and no-project body',()=>{
  const storage=memory();
  try {
    const original={...loadDraft(storage,'circle'),sourceKind:'none',prompt:'Synthetic task',
      agent:'synthetic',model:'specific',effort:'precise',sending:true,uncertainSince:10};
    saveDraft(storage,'circle',original);
    const recovered=loadDraft(storage,'circle'),before=draftBody(original,'circle');
    assert.deepEqual(draftBody(recovered,'circle'),before);
    const again=draftBody({...recovered,sendAnyway:true},'circle');
    assert.deepEqual(again,{...before,send_anyway:true});
    assert.equal(again.noSource,true);assert.deepEqual(again.result,{kind:'message'});
    assert.equal('repo' in again,false);assert.equal(again.draft_id,original.id);
    assert.equal(again.model,'specific');assert.deepEqual(again.budget_v1,{effort:'precise'});
  } finally {storage.clear();}
});
test('late local restore does not replace an unknown explicit choice with a default',()=>{
  const storage=memory();
  try {
    const d={...loadDraft(storage,'circle'),model:'not-currently-offered',effort:'unsupported-explicit',agent:'synthetic',sourceKind:'none',prompt:'x'};
    saveDraft(storage,'circle',d);const raw=storage.getItem(COMPOSE_DRAFT_PREFIX+'circle');
    const restored=loadDraft(storage,'circle');
    assert.equal(restored.model,d.model);assert.equal(restored.effort,d.effort);
    assert.equal(storage.getItem(COMPOSE_DRAFT_PREFIX+'circle'),raw);
    // Availability validation belongs to negotiated selection; restore must not
    // manufacture a new choice or claim these opaque IDs are currently supported.
  } finally {storage.clear();}
});
