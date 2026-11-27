import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSandboxDeadlineManager,sandboxDeadlineUnit,deadlineProcessStartSync} from '../lib/sandbox-deadline.mjs';
import {serviceProof,serviceState} from './helpers/deadline-service-model.mjs';

const row=()=>({_cleanupId:'11111111-1111-4111-8111-111111111111',sandbox_id:'wf-0123456789abcdef',sbx_home:'/sandbox home',
  deadline_at:70_000,deadline_clock:{version:1,boot_id:'boot',boot_at:64_000}});
const ok={code:0,stdout:'',stderr:''};

// A Linux systemd guard with a counted service manager. `replace` publishes a different guard process (the parent of this
// test), `stop` removes the published guard entirely.
function harness() {
  const calls=[];let armed=false,requested=null,replaced=false;
  const binary='/opt/sbx';
  const run=async(command,args)=>{
    calls.push({command,args});
    if(command==='systemd-run'){const payload=JSON.parse(args.at(-1));requested={...row(),deadline_at:payload.deadline_at,deadline_clock:payload.deadline_clock};armed=true;return ok;}
    if(command==='systemctl'){
      if(args.includes('stop')){armed=false;return ok;}
      if(args.includes('is-active'))return {...ok,code:armed?0:1};
      return ok;
    }
    if(command==='busctl'){
      if(!armed)return {...ok,code:1};
      if(args.includes('GetUnit'))return {...ok,stdout:JSON.stringify({type:'o',data:['/org/freedesktop/systemd1/unit/deadline_2eservice']})};
      return serviceProof(args,requested,binary);
    }
    throw Error('Unexpected deadline control command');
  };
  const manager=createSandboxDeadlineManager({binary,platform:'linux',run,readyTimeoutMs:1,now:()=>10_000,
    clock:()=>({wall:10_000,boot_id:'boot',boot_ms:4000}),
    stateReader:()=>{
      if(!armed)return null;
      const state=serviceState(requested,binary);
      return replaced?{...state,pid:process.ppid,start:deadlineProcessStartSync(process.ppid)}:state;
    }});
  return {manager,calls,replace:()=>{replaced=true;},stop:()=>{armed=false;}};
}

test('identity and sync checks spawn nothing; one full proof costs exactly three service-manager commands', async () => {
  const {manager,calls}=harness();
  const armedRow={...row(),deadline_enforcer:await manager.register(row())};
  const before=calls.length;
  assert.equal(typeof manager.identitySync(armedRow),'string');
  assert.equal(manager.activeSync(armedRow),true);
  assert.equal(calls.length-before,0,'an identity or sync check starts no service-manager process');
  assert.equal(await manager.active(armedRow),true);
  assert.deepEqual(calls.slice(before).map(call=>call.command),['systemctl','busctl','busctl'],'is-active, GetUnit, ExecStart');
});

test('a replaced guard has a different identity, so a proof taken for the old guard is not reused for the new one', async () => {
  const {manager,replace}=harness();
  const armedRow={...row(),deadline_enforcer:await manager.register(row())};
  const first=manager.identitySync(armedRow);
  replace();
  const second=manager.identitySync(armedRow);
  assert.equal(typeof first,'string');
  assert.equal(typeof second,'string');
  assert.notEqual(second,first);
});

test('a stopped guard has no identity and fails the synchronous check', async () => {
  const {manager,stop}=harness();
  const armedRow={...row(),deadline_enforcer:await manager.register(row())};
  stop();
  assert.equal(manager.identitySync(armedRow),null);
  assert.equal(manager.activeSync(armedRow),false);
});
