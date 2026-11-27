import test from 'node:test';
import assert from 'node:assert/strict';
import {setupDetailsVM} from './setup-details.mjs';
test('workspace and unknown protections retain independent names and outcomes',()=>{
 const rows=setupDetailsVM({checks:[
  {name:'test_workspace',ok:false},{name:'artifact_access',ok:true},{name:'guest_cleanup',ok:null},
 ]}).rows;
 assert.deepEqual(rows.map(r=>r.label),['Test workspace','Additional protection: artifact access','Additional protection: guest cleanup']);
 assert.deepEqual(rows.map(r=>r.state),['Needs attention','Passed','Not confirmed']);
});
import {SetupDetails} from './setup.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
test('an inconclusive check never reads Passed even if ok is true',()=>{
  const vm=setupDetailsVM({ready:true,checks:[{name:'network_policy',ok:true,label:'Inconclusive: no evidence'}]});
  assert.deepEqual(vm.rows,[{label:'The sandbox network rules are ready',state:'Not confirmed'}]);
  assert.doesNotMatch(vm.summary,/passed/i);
});
test('details use plain labels and distinguish all three evidence states',()=>{
  assert.deepEqual(setupDetailsVM({checks:[{name:'sbx_install',ok:true},{name:'raw_error_name',ok:false},{name:'v1_limits',ok:null}]}).rows.map(r=>r.state),['Passed','Needs attention','Not confirmed']);
  assert.equal(setupDetailsVM(null).rows.length,0);
  assert.equal(setupDetailsVM(null).summary,'Loading protection checks…');
});

import {setupRowsVM} from './setup-details.mjs';

test('Setup rows adapt to the existing BlockerList renderer without a separate status model',()=>{
 const vm=setupRowsVM([{id:'agent:codex',title:'Codex',detail:'Signed out.',state:'need'}]);
 assert.deepEqual(vm.items.map(i=>[i.key,i.agent,i.status]),[['agent','codex','blocked']]);
 assert.equal(vm.needsYou.length,1);
});

test('credential storage, file paths, and Windows permission checks have distinct plain labels',()=>{
 const rows=setupDetailsVM({checks:['sbx_credential_store','socket_path_length','windows_file_permissions'].map(name=>({name,ok:true}))}).rows;
 assert.equal(new Set(rows.map(r=>r.label)).size,3);assert.ok(rows.every(r=>r.label!=='Sandbox protection check'));
 assert.equal(rows[2].label,'Sandbox-file access permissions are restricted to this account');
 assert.equal(rows[2].detail,'This does not hide job contents from the computer’s owner or administrator.');
});
test('Windows permission detail is visible beside the readiness result',()=>{
 const text=renderedText(renderFixture(SetupDetails,{readiness:{checks:[{name:'windows_file_permissions',ok:true}]}}));
 assert.match(text,/Sandbox-file access permissions are restricted to this account Passed This does not hide job contents from the computer’s owner or administrator\./);
});
