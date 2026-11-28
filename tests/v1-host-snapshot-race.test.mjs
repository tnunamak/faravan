import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {effectiveState} from '../lib/v1/lending-state.mjs';
import {createLendingProjection,projectLendingState,transitionalLendingProjection} from '../lib/v1/state-projection.mjs';

const source=readFileSync(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
function section(start,end) {
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,`production boundary ${start}`);
  return source.slice(a,b);
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture({home=false,initial=true,refresh=false,resumeFailure=false}={}) {
  const entered=deferred(),release=deferred(),circle={id:'circle',name:'Friends',origin:'https://fixture.invalid',joinInfo:{ownerName:'Owner'}};
  const hostProfiles=new Map([['circle',{reachable:initial,lastReached:1000}]]);
  let circleReads=0,evidenceReads=0,revision=0;
  const evidence=[{spec:{harness_id:'codex'},installed:true,signedIn:true}];
  const state={status:'idle',current:null,counters:{},configVersion:1};
  const noop=()=>{},empty=()=>({});
  const c={Date,Intl,Map,Set,Promise,structuredClone,effectiveState,hostProfiles,hostReadSequence:new Map(),closed:false,
    settings:{activeCircle:'circle',intent:'on',enabled:true,limits:{},agents:{codex:true},desktop:{},modes:{}},
    options:{platform:'linux'},minHostVersion:null,faravanVersion:'0.74.0',hostRateLimited:false,
    now:()=>1000,readinessChanged:noop,nudgeHeartbeat:noop,hostUnreachable:()=>true,versionAtLeast:()=>true,
    device:{selectCircle:async()=>circle,listCircles:async()=>{
      // Suspend at the actual circleState -> device.listCircles await, without changing product source.
      if(new Error().stack.includes('circleState')&&++circleReads===(home?2:1)) {entered.resolve();await release.promise;}
      return [circle];
    }},
    todayCounters:()=>({}),executionEvidence:()=>({current:null}),projectMembership:()=>({phase:'approved'}),
    lendingHours:()=>({inside:true}),dailyLimitReached:()=>false,timedResume:null,safetyIntentEpoch:0,
    launchedAt:0,backgroundCheck:null,resumeFailed:null,approvals:new Map(),chatgptActions:()=>[],
    lender:{cessation:()=>({proven:true})},lenderAdmission:()=>hostProfiles.get('circle').reachable===false?'circle_unreachable':null,
    admissionIntent:reason=>({state:'blocked',reason,until:null}),deadlineRecovery:null,
    cleanupDisplaySummary:()=>({items:[]}),backend:{},
    lastHomeObservation:0,agentViews:async()=>[],circleFacts:{},readQuota:async()=>{},machineSetupReason:()=>null,admissionChanged:noop,
    recheckBlockers:noop,dockerCheckedAt:1000,autostart:{status:async()=>({supported:false})},setupProgress:{view:async()=>({})},
    lendingPolicySnapshot:async()=>({}),lendingView:()=>state,lenderObservationGeneration:0,
    lendingSnapshotSignature:()=>'',readinessStamp:()=>JSON.stringify([revision,hostProfiles.get('circle').reachable]),
    pendingRequests:new Map(),counterStore:{get:async()=>({})},lenderDayKey:()=>'',AGENT_NAMES:{},
    lenderEvidence:async()=>{if(home&&++evidenceReads===1)revision++;return {views:evidence};},
    lendingProjectionVersion:()=>null,desktopView:()=>({platform:'linux'}),trayReport:null,lenderStoppedJob:null,
    createLendingProjection,projectLendingState,transitionalLendingProjection,appIconState:empty,trayUpdateProjection:empty,updateService:null,
    lendingSummary:empty,todayUsage:empty,canonicalAgentId:x=>x,automaticNotices:()=>[],needsLendingChoice:()=>false,
    dismissedLendingPrompts:new Set(),ownerPresence:{snapshot:empty},diskLedger:null,dockerSignedOut:false,
    allowance:null,sandboxHealth:{notice:null},
  };
  vm.createContext(c);
  vm.runInContext(section('  async function observeHostRead(','  async function readHostProfile(')+
    section('  const memberTooOld=','  async function blockerInputs(')+
    section('  async function computeEffective(','  // P1b:')+
    section('  async function homeView()','  async function uploaded(')+
    '\nglobalThis.compute=computeEffective;globalThis.home=homeView;globalThis.observe=observeHostRead;globalThis.circle= circleState;',c);
  c.blockerInputs=async()=>({circle:await c.circle(),docker:{installed:true,running:true,signedIn:true},
    agents:[{id:'codex',enabled:true,installed:true,signedIn:true}]});
  return {entered,release,restart:()=>{c.settings.enabled=true;c.resumeFailed=null;return home?c.home():c.compute(state,evidence);},start:()=>home?c.home():c.compute(state,evidence),async refresh(){
    await c.observe('circle',async()=>{if(!refresh)throw new Error('unreachable');return {};});
    if(resumeFailure){c.settings.enabled=false;c.resumeFailed={code:'network_error',circleName:circle.name};}
  },async change(){try {await this.refresh();}catch(error){assert.equal(error.message,'unreachable');}}};
}
function consistent(answer,{host=false}={}) {
  const reason=answer.intent.reason;
  if(reason==='circle_unreachable') {
    if(host)assert.equal(answer.host.reachable,false,'unreachable reason must use the same host snapshot');
    assert.equal(answer.lending_blockers.first?.key,'circle','unreachable reason must have a first circle blocker');
  }
  if(host)assert.equal(answer.lendingProjection.admissionReason,reason,'public projection uses the same host observation');
  assert.equal(answer.reason,reason,'legacy reason agrees with intent');
}
for(const home of [false,true])for(const refresh of [false,true]) {
  test(`${home?'home retry':'effective answer'} stays coherent when host becomes ${refresh?'reachable':'unreachable'} during circle lookup`,{timeout:5000},async t=>{
    const f=fixture({home,initial:!refresh,refresh}),pending=f.start();
    t.after(()=>f.release.resolve());
    await f.entered.promise;
    await f.change();
    f.release.resolve();
    const answer=await pending;
    consistent(answer,{host:home});
    assert.equal(answer.intent.reason==='circle_unreachable',!refresh,'answer reflects the host refresh completed before projection');
    if(refresh)assert.equal(answer.lending_blockers.first,null,'recovery clears the circle blocker');
    if(home)assert.equal(answer.host.reachable,refresh);
  });
}

// A failed pool can finish while the status lookup awaits; a successful host read
// does not restart that pool or clear its recorded start failure.
for(const home of [false,true])test(`${home?'home retry':'effective answer'} names the failed pool after a host recovery during the status lookup`,{timeout:5000},async t=>{
  const f=fixture({home,initial:false,refresh:true,resumeFailure:true}),pending=f.start();
  t.after(()=>f.release.resolve());
  await f.entered.promise;await f.change();f.release.resolve();
  const answer=await pending;
  assert.equal(answer.intent.reason,'circle_unreachable');
  assert.equal(answer.lending_blockers.first?.key,'circle');
  assert.equal(answer.lending_blockers.first?.label,'Friends');
  assert.equal(answer.lending_blockers.first?.hostName,'Owner');
  assert.equal(answer.host.reachable,true,'host transport recovered, but lending still needs its restart');
  assert.ok(answer.lending_blockers.items.filter(item=>item.key!=='circle').every(item=>item.status==='ok'));
  if(home)assert.equal(answer.lendingProjection.admissionReason,'circle_unreachable');
  const restarted=await f.restart();
  assert.equal(restarted.lending_blockers.first,null,'successful restart clears the failure row');
  assert.equal(restarted.intent.reason,null);
});
