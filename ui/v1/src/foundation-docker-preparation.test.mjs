// The real mounted harness installs DOM globals before the component imports.
import {mount, teardown, installClock, resetPage, createFakeApi} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Setup} from './setup.jsx';
import {setupVM} from './view-models.mjs';

afterEach(teardown);
const prepared = {schemaVersion:1,state:'prepared',jobId:'job-one',attemptId:'attempt-one',sandboxId:'wf-0000000000000001',observedAtMs:1234};
const unknown = {schemaVersion:1,state:'unknown',jobId:null,attemptId:null,sandboxId:null,observedAtMs:null};
const pending = {schemaVersion:1,state:'pending',jobId:'job-two',attemptId:'attempt-two',sandboxId:null,observedAtMs:1235};
const unexpected = async () => { throw new Error('Observation must not invoke a setup action'); };
function propsFor(preparation, broken = false) {
  const docker = {key:'docker_running',label:'Docker Sandboxes',status:broken?'blocked':'ok',
    detail:broken?'Synthetic Docker service is stopped.':'Docker is running.',
    ...(broken?{action:'Check again',cause:'daemon_unavailable'}:{})};
  const lending = {enabled:false,mode:'ask'};
  const readiness = {checks:[{name:'sbx_install',ok:true},
    {name:'docker_login',ok:true,signinVerified:true},{name:'sbx_daemon',ok:!broken}],
    ...(preparation === undefined ? {} : {preparation})};
  return {data:{readiness,agents:[],devices:{name:'Synthetic computer'},lendingReadiness:{agents:[]},
    home:{desktop:{platform:'linux',lendable:true},lending,
      lending_blockers:{items:[docker,{key:'docker_signin',label:'Docker sign-in',status:'ok',detail:'Signed in.'}],
        first:broken?docker:null,canLend:false}}},
    lending,agents:[],circles:[],circle:null,phone:false,mutate:unexpected,refresh:unexpected};
}
function gates(props) {
  const vm = setupVM({readiness:props.data.readiness,agents:props.agents,
    status:{...props.data.home,lending:props.lending},devices:props.data.devices,
    lendingReadiness:props.data.lendingReadiness});
  return {ready:vm.ready,done:vm.done,required:vm.required,steps:vm.steps,summary:vm.summary};
}
// Setup's existing CommandLineTool performs this read-like POST on mount.
// Permit exactly that established call, not arbitrary ops or new side effects.
function onlyExistingStatusRead(api) {
  assert.deepEqual(api.posts,[{path:'ops/command_path.status',body:{}}]);
}
test('mounted Setup observes preparation without promoting login or lending readiness', async () => {
  installClock(); resetPage();
  const api = createFakeApi();
  const initial = propsFor(undefined);
  const baseline = gates(initial);
  const screen = await mount(h(Setup,{...initial,api}));
  const row = () => screen.$('[data-preparation-observation]');
  assert.ok(row(),'login-only legacy readiness still shows unknown preparation');
  assert.equal(row().getAttribute('data-state'),'unknown');
  assert.match(row().textContent,/Not observed/);
  assert.equal(screen.$('progress[aria-label="Sandbox preparation observation"]').value,0);
  assert.equal(screen.button('Turn on lending'),null);
  onlyExistingStatusRead(api);
  for (const fact of [prepared,pending,prepared,unknown,undefined]) {
    const props = propsFor(fact);
    await screen.rerender(h(Setup,{...props,api}));
    const state = fact?.state ?? 'unknown';
    assert.equal(row().getAttribute('data-state'),state);
    assert.equal(screen.$('progress[aria-label="Sandbox preparation observation"]').value,state==='prepared'?1:0);
    assert.equal(row().textContent.includes('Preparation observed'),state==='prepared');
    assert.deepEqual(gates(props),baseline);
    assert.equal(screen.button('Turn on lending'),null);
    for (const secret of ['job-one','attempt-one','wf-0000000000000001','1234','job-two','attempt-two','1235'])
      assert.equal(row().outerHTML.includes(secret),false);
    assert.equal(row().querySelector('button,a,code,input'),null);
    onlyExistingStatusRead(api);
  }
});
test('mounted Setup preserves the real first failure and remedy when preparation is observed', async () => {
  installClock(); resetPage();
  const api = createFakeApi();
  const initial = propsFor(unknown,true);
  const screen = await mount(h(Setup,{...initial,api}));
  const current = screen.$('.setup-current');
  assert.ok(current,'real failure remains actionable');
  const currentText = current.textContent;
  const actions = [...current.querySelectorAll('button,a')].map(el=>el.textContent);
  const next = propsFor(prepared,true);
  await screen.rerender(h(Setup,{...next,api}));
  assert.equal(screen.$('.setup-current').textContent,currentText);
  assert.deepEqual([...screen.$('.setup-current').querySelectorAll('button,a')].map(el=>el.textContent),actions);
  assert.deepEqual(gates(next),gates(initial));
  assert.equal(screen.$('[data-preparation-observation]').getAttribute('data-state'),'prepared');
  assert.equal(screen.button('Turn on lending'),null);
  onlyExistingStatusRead(api);
});
