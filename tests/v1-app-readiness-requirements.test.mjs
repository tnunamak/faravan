import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api,syntheticBackend,waitFor,adapters} from './helpers/v1-app-fixture.mjs';
import {SBX_VERSION} from './helpers/credential-probe-fixture.mjs';

test('fresh readiness failures block lending', {timeout:90000}, async t => {
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  // A pass counts only for a known sbx version, so this computer reports one.
  const baseProbe=backend.probeCapabilities.bind(backend);
  backend.probeCapabilities=async()=>{const report=await baseProbe();report.preflight.version=SBX_VERSION;return report;};
  const baseProtectionSummary=backend.protectionSummary.bind(backend);
  const observedAt='2026-10-27T20:15:00.000Z';
  let failures=false;
  backend.protectionSummary=async(requirements,context)=>{
    const report=await baseProtectionSummary(requirements,context);
    report.observed_at=observedAt;
    report.preflight.checks.push({name:'network_policy',ok:true,detail:'Network policy is enforced.',fix:'sbx policy init deny-all (or run: faravan doctor --fix-policy)'});
    if(failures){
      report.preflight.checks=report.preflight.checks.map(check=>check.name==='network_policy'?{...check,ok:false,detail:'Network policy is not enforced.'}:check);
      report.limits.satisfied=false;
      report.limits.unenforced=['cpu'];
      report.satisfied=false;
    }
    return report;
  };
  const {owner,lender,circle}=await f.connect({backend,adapters:adapters(),faravanVersion:'0.12.0'});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});

  failures=true;
  const readiness=await api(lender.app,'/api/readiness?refresh=true');
  assert.equal(readiness.ready,false);
  assert.equal(readiness.protection.observed_at,observedAt);
  const home=await api(lender.app,'/api/home');
  assert.equal(home.intent.on,true,'the owner’s on choice remains intent');
  assert.equal(home.intent.state,'blocked');
  assert.equal(home.intent.reason,'policy_unenforceable');
  const rows=home.lending_blockers.items.filter(item=>item.key==='readiness_requirement');
  assert.deepEqual(rows.map(item=>item.cause),['network_policy','v1_limits']);
  assert.equal(rows[0].action,'Retry network setup');
  assert.doesNotMatch(JSON.stringify(readiness),/sbx policy|--fix-policy/);
  assert.ok(rows.every(item=>item.status==='blocked'&&item.observedAt===observedAt));
  assert.equal(home.lending_blockers.canLend,false);
  await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,git:'https://github.com/example/synthetic.git',
    commit:'1'.repeat(40),prompt:'Synthetic task.',harness:'codex'}});
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(backend.calls.filter(([kind])=>kind==='run').length,0,'a blocked readiness projection prevents launch');

  failures=false;
  const recovered=await api(lender.app,'/api/readiness?refresh=true');
  assert.equal(recovered.ready,true);
  // The lender re-proves its account after a readiness change, so Home shows "checking" until it has.
  await waitFor(async()=>(await api(lender.app,'/api/home')).intent.state==='ready','ready after the failures clear');
  const readyHome=await api(lender.app,'/api/home');
  assert.equal(readyHome.intent.on,true);
  assert.equal(readyHome.intent.state,'ready','clearing the failures restores readiness without changing intent');
});

test('runtime readiness holds admission and reaches lending readiness and status', {timeout:90000}, async t => {
  const f=await appFixture(t),backend=syntheticBackend(f.root);
  const base=backend.protectionSummary.bind(backend);
  let broken=false;
  backend.protectionSummary=async(...args)=>{
    const report=await base(...args);
    report.preflight.checks.push({name:'guard_runtime',ok:!broken,reason:broken?'guard_runtime_unavailable':null,
      detail:broken?"Faravan's job guard could not start in the sandbox. Update Faravan; if it still fails, reinstall Faravan.":'The sandbox job guard runtime is ready.',
      fix:broken?'Update Faravan; if it still fails, reinstall Faravan.':''});
    if(broken){report.sandbox_ready=false;report.satisfied=false;}
    return report;
  };
  const {lender,circle}=await f.connect({backend,adapters:adapters(),faravanVersion:'0.12.0'});
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  broken=true;
  const refreshed=await api(lender.app,'/api/readiness?refresh=true');
  assert.equal(refreshed.ready,false,'explicit refresh returns the new machine result before it answers');
  assert.equal(refreshed.checks.find(c=>c.name==='guard_runtime')?.reason,'guard_runtime_unavailable');
  // Machine readiness and the lending pool's account/counter startup are separate.
  // A loaded parallel suite can finish the fresh machine check before the pool has a child.
  await waitFor(()=>lender.app.lendingAdmission()!=='lender_starting','lender startup after the runtime refresh',30000);
  assert.equal(lender.app.lendingAdmission(),'guard_runtime_unavailable','the machine gate holds claims');
  const readiness=await api(lender.app,'/api/lending/readiness');
  const row=readiness.agents.find(a=>a.id==='codex').checks.find(c=>c.code==='guard_runtime_unavailable');
  assert.equal(row.state,'fail');
  assert.match(row.line,/Update Faravan.*reinstall Faravan/);
  const status=await api(lender.app,'/api/status');
  assert.equal(status.lendingProjection.admissionReason,'guard_runtime_unavailable');
  // The owner sees this hold by name, with its fix, not as a generic failure.
  const lending=await waitFor(async()=>{const view=await api(lender.app,'/api/lending');return view.reason==='guard_runtime_unavailable'&&view;},'named runtime hold',30000);
  assert.equal(lending.label,"Faravan's job guard could not start in the sandbox. Update Faravan; if it still fails, reinstall Faravan.");
  broken=false;
  await api(lender.app,'/api/readiness?refresh=true');
  const recovered=await api(lender.app,'/api/lending/readiness');
  assert.equal(recovered.agents.flatMap(a=>a.checks).some(c=>c.code==='guard_runtime_unavailable'),false);
});
