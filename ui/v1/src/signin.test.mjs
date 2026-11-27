import test from 'node:test';
import assert from 'node:assert/strict';
import {isTerminal,dockerSignInNeeded,signInLabel,safeSignInUrl,signInView,ACTION_LABELS,checkView} from './signin.mjs';
import {errorMessage as appError} from './helpers.mjs';
test('docker sign-in is offered only for a failed docker_login check',()=>{
  assert.equal(dockerSignInNeeded({checks:[{name:'docker_login',ok:false}]}),true);
  assert.equal(dockerSignInNeeded({checks:[{name:'docker_login',ok:true}]}),false);
  assert.equal(dockerSignInNeeded({checks:[{name:'sandbox',ok:false}]}),false);
  assert.equal(dockerSignInNeeded(null),false);
});
test('labels follow the approved copy',()=>{
  assert.equal(signInLabel('docker'),'Sign in to Docker');
  assert.equal(signInLabel('claude-code-subscription','Claude Code'),'Sign in to Claude Code');
  assert.equal(ACTION_LABELS.check,'Check now');
  assert.equal(ACTION_LABELS.cancel,'Cancel sign-in');
});
test('only https URLs are linkable',()=>{
  assert.equal(safeSignInUrl('https://example.test/device'),'https://example.test/device');
  assert.equal(safeSignInUrl('javascript:alert(1)'),null);
  assert.equal(safeSignInUrl('http://example.test'),null);
  assert.equal(safeSignInUrl(undefined),null);
});
test('waiting view shows the code and the three actions; success and failure end the flow',()=>{
  const waiting=signInView({status:'awaiting_browser',url:'https://login.example.test/x',code:'AB-12'});
  assert.equal(waiting.heading,'Finish sign-in in your browser. Faravan notices when you’re done.');
  assert.equal(waiting.status,'Waiting for you to finish in the browser…');
  assert.equal(waiting.code,'AB-12');
  assert.deepEqual(waiting.actions,['open','cancel'],'no manual check while the automatic one runs');
  assert.equal(signInView({status:'awaiting_browser',url:'javascript:1'}).url,null);
  assert.equal(signInView({status:'complete'}).status,'Signed in');
  for(const status of ['failed','cancelled','timed_out']){assert.deepEqual(signInView({status,message:'Try later.'}).actions,['retry']);assert.equal(isTerminal({status}),true);}
  assert.equal(isTerminal({status:'awaiting_browser'}),false);
  assert.deepEqual(signInView(null).actions,['start']);
  assert.deepEqual(signInView(null,'Boom').actions,['retry']);
});
test('starting is an explicit preparation state with a cancel action and no implied browser URL',()=>{
  assert.deepEqual(signInView({status:'starting'}),{heading:'Preparing sign-in…',body:null,
    status:'Faravan is preparing the sign-in page.',actions:['cancel']});
  assert.equal(isTerminal({status:'starting'}),false);
});
test('sign-in errors have plain messages',()=>{
  assert.match(appError({code:'signin_failed'}),/sign-in/i);
  assert.match(appError({code:'signin_unsupported'}),/Open the agent on your computer.*check sign-in here/);
});

test('a sign-in that waits for a pasted code asks for it and drops Check sign-in', () => {
  const view=signInView({status:'awaiting_browser',url:'https://claude.com/cai/oauth/authorize',codeEntry:true});
  assert.equal(view.codeEntry,true);
  assert.match(view.heading,/paste the code/);
  assert.deepEqual(view.actions,['open','cancel']);
  assert.equal(signInView({status:'awaiting_browser',url:'https://login.example.test/x'}).codeEntry,undefined);
});

test('the one sign-in panel: a quiet live status, and "Check now" only when the automatic check cannot reach the app, saying what it found', () => {
  const flow={status:'awaiting_browser',url:'https://login.example.test/x',code:'AB-12'};
  assert.deepEqual(signInView(flow,'',{pollFailed:false}).actions,['open','cancel']);
  const failed=signInView(flow,'',{pollFailed:true});
  assert.deepEqual([failed.status,failed.actions],['Can’t check right now.',['open','check','cancel']]);
  assert.equal(signInView(flow,'',{pollFailed:true,checkNote:'Not signed in yet.'}).status,'Can’t check right now. Not signed in yet.');
  assert.equal(signInView(flow,'',{checkNote:'Not signed in yet.'}).status,'Not signed in yet.');
});

// Every button gives visible feedback at once: "Checking…" while it runs, then what it found.
test('a Check button changes visible state: idle, checking, then what it found', () => {
  const at=Date.parse('2026-10-19T14:41:07Z');
  assert.deepEqual(checkView({}),{label:'Check again',busy:false,note:''});
  assert.deepEqual(checkView({phase:'checking'}),{label:'Checking…',busy:true,note:'Checking this computer…'});
  assert.equal(checkView({phase:'done',at,changed:false,zone:'UTC'}).note,'Checked 2:41 PM. Nothing changed.');
  assert.equal(checkView({phase:'done',at,changed:true,zone:'UTC'}).note,'Checked 2:41 PM.');
  assert.equal(checkView({phase:'done',at,error:'The app can’t be reached.',zone:'UTC'}).note,'Couldn’t check: The app can’t be reached.');
  for (const phase of ['checking','done']) assert.notDeepEqual(checkView({phase,at}),checkView({}),phase+' differs from idle');
});

test('Codex OAuth waiting copy shows elapsed progress while the callback is pending', () => {
  const view=signInView({status:'awaiting_browser',target:'codex',startedAt:1000},'',{elapsedMs:12000});
  assert.match(view.status,/12 seconds/);
});

import { beginSignIn, readProgress, writeProgress, progressView } from './signin.mjs';
const memory = () => {const m=new Map();return {getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};};
test('the click opens Faravan progress before the slow POST and never opens a blank tab', async () => {
  const storage=memory(),events=[],flow={flowId:'provider-flow',status:'awaiting_browser',url:'https://provider.test/signin'};
  const pending=beginSignIn({id:'local-flow',target:'codex',agentName:'Codex',storage,open:(...args)=>{events.push(args);return {};},api:{post:async()=>{events.push('post');return flow;}},onFlow:f=>events.push(f.status)});
  assert.deepEqual(events[0],['/#/signin/local-flow','_blank','noopener,noreferrer']);
  assert.equal(events[1],'post');
  assert.match(progressView(readProgress(storage,'local-flow')).heading,/Starting a secure sign-in for Codex/);
  await pending;
  assert.equal(progressView(readProgress(storage,'local-flow')).url,flow.url);
});
test('a popup exception cannot prevent the sign-in POST', async () => {
  const storage=memory(), flow={flowId:'provider-flow',status:'starting'};let posts=0;
  const result=await beginSignIn({id:'local-flow',target:'codex',storage,open:()=>{throw new Error('blocked popup');},
    api:{post:async()=>{posts++;return flow;}},onFlow:()=>{}});
  assert.equal(posts,1);
  assert.equal(result.status,'starting');
});
test('an opener proxy that rejects assignment cannot prevent the sign-in POST', async () => {
  const storage=memory(), flow={flowId:'provider-flow',status:'starting'};let posts=0;
  const proxy=Object.defineProperty({},'opener',{set(){throw new Error('opener is protected');}});
  const result=await beginSignIn({id:'local-flow',target:'codex',storage,open:()=>proxy,
    api:{post:async()=>{posts++;return flow;}},onFlow:()=>{}});
  assert.equal(posts,1);
  assert.equal(result.status,'starting');
});
test('cancel during startup cancels the eventual backend flow without redirecting', async () => {
  const storage=memory();let finish;const calls=[];
  const pending=beginSignIn({id:'cancelled',target:'docker',storage,open:()=>null,api:{post:(path)=>{calls.push(path);return calls.length===1?new Promise(r=>{finish=r;}):Promise.resolve({status:'cancelled'});}},onFlow:()=>{}});
  writeProgress(storage,'cancelled',{...readProgress(storage,'cancelled'),cancelled:true});
  finish({flowId:'f',status:'awaiting_browser',url:'https://provider.test'});await pending;
  assert.deepEqual(calls,['signin/docker','signin/f/cancel']);
  assert.equal(progressView(readProgress(storage,'cancelled')).terminal,true);
  assert.equal(progressView(readProgress(storage,'cancelled')).url,undefined);
});
test('progress shows elapsed time, error recovery, and already-signed-in completion', async () => {
  assert.match(progressView({target:'docker',startedAt:1000},12000).status,/11 seconds elapsed/);
  assert.equal(progressView({target:'docker',flow:{status:'complete'}}).complete,true);
  const storage=memory();await assert.rejects(beginSignIn({id:'fail',target:'docker',storage,open:()=>null,api:{post:async()=>{throw Error('Could not start.');}},onFlow:()=>{}}));
  assert.equal(progressView(readProgress(storage,'fail')).status,'Faravan could not confirm what happened. Check the current state before taking another action.');
  assert.equal(progressView(readProgress(storage,'fail')).terminal,true);
  assert.equal(progressView(null).terminal,true);
});


test('provider errors cannot put raw technical messages into sign-in copy', () => {
 assert.equal(signInView({status:'failed',message:'lease sha256:deadbeef'}).body, appError({code:'signin_failed'}));
 assert.equal(signInView(null,'internal raw error').body, appError({code:'signin_failed'}));
 assert.equal(progressView({target:'codex',flow:{status:'failed',message:'raw technical code'}}).status, appError({code:'signin_failed'}));
 assert.equal(progressView({target:'codex',error:'lease sha256:deadbeef'}).status, 'Faravan could not confirm what happened. Check the current state before taking another action.');
 assert.equal(progressView({target:'codex',errorCode:'network'}).status,'Can’t reach your computer. Check that it’s awake and on the same network.');
});
test('sign-in timeout uses fixed next-step copy', () => {
  assert.equal(signInView({status:'timed_out',message:'provider error with secret'}).body,'Sign-in timed out. Choose Start sign-in again.');
  assert.equal(progressView({target:'codex',flow:{status:'timed_out',message:'provider error with secret'}}).status,
    'Sign-in timed out. Return to Lending to try again.');
});

test('a sign-in that did not finish names a concrete next step and leads to Setup', () => {
  for (const progress of [{target:'docker',flow:{status:'failed'}},{target:'docker',flow:{status:'timed_out'}},{target:'docker',errorCode:'signin_failed'}]) {
    const view = progressView(progress);
    assert.equal(view.terminal, true);
    assert.equal(view.next, 'setup');
    assert.match(view.status, progress.flow?.status === 'timed_out' ? /Sign-in timed out\. Return to Setup to try again\./ : /Choose the sign-in again/);
    assert.doesNotMatch(view.status, /protected workspace setup/i);
  }
  assert.equal(progressView({target:'docker',flow:{status:'complete'}}).next, undefined);
  assert.equal(progressView({target:'docker',cancelled:true}).next, undefined);
  assert.equal(progressView({target:'codex',flow:{status:'failed'}}).next, undefined, 'agent sign-ins do not start on Setup');
  assert.equal(progressView({target:'docker',errorCode:'credential_writer_unresolved'}).next, undefined, 'a support case is not a retry');
});

test('terminal stage diagnostics use fixed reason copy and keep the next action clear', () => {
  const hostile = 'private error https://attacker.test/?token=secret';
  const policy = progressView({target:'codex',flow:{status:'failed',stage:'sandbox_prepare',reasonCode:'policy_unenforceable',message:hostile}});
  assert.equal(policy.status, 'Faravan could not apply the required sign-in security policy. Save support archive in Settings → Data and send it to support.');
  assert.equal(policy.terminal, true);
  assert.equal(policy.next, undefined);
  assert.ok(!JSON.stringify(policy).includes(hostile));

  const timeout = progressView({target:'codex',flow:{status:'timed_out',stage:'sandbox_prepare',reasonCode:'sandbox_ready_timeout'}});
  assert.equal(timeout.status, 'The secure sign-in sandbox did not become ready. Return to Lending to try again.');
  assert.equal(timeout.terminal, true);

  assert.equal(progressView({target:'codex',flow:{status:'failed',message:hostile}}).status,
    appError({code:'signin_failed'}), 'legacy terminal views without a stage keep their existing copy');
});

test('Q4 P2-2 reason guidance survives cleared stage and distinguishes lease contention', () => {
  for(const [reasonCode,pattern] of [
    ['credential_mutation_busy',/another.*wait/i],
    ['completion_failed',/confirm.*(try again|sign-in again)/i],
    ['provider_cli_missing',/could not find.*command.*install it.*terminal.*(try again|sign-in again)/i],
    ['guest_not_authenticated',/credential.*(try again|sign-in again)/i],
  ]) {
    const flow={status:'failed',reasonCode};
    assert.match(signInView(flow).body,pattern);
    assert.match(progressView({target:'codex',flow}).status,pattern);
  }
});

test('the sign-in tab names Setup for Docker and Lending for agents; the inline panel names its own retry button', () => {
  const timeout = 'Sign-in timed out. Return to Setup to try again.';
  assert.equal(signInView({target:'docker',status:'timed_out'}).body, 'Sign-in timed out. Choose Start sign-in again.');
  assert.equal(progressView({target:'docker',flow:{status:'timed_out'}}).status, timeout);
  const cases = [
    ['backend_health','startup_failed'], ['backend_health','wall_timeout'],
    ['identity_drain','startup_failed'], ['identity_drain','wall_timeout'],
    ['adapter_resolution','startup_failed'], ['adapter_resolution','wall_timeout'],
    ['docker_guard','startup_failed'], ['docker_guard','wall_timeout'],
    ['capabilities','startup_failed'], ['capabilities','sandbox_not_ready'], ['capabilities','wall_timeout'],
    ['sandbox_prepare','startup_failed'], ['sandbox_prepare','sandbox_start_failed'],
    ['sandbox_prepare','sandbox_ready_timeout'], ['sandbox_prepare','sandbox_credential_store_failed'],
    ['sandbox_prepare','host_disk_low'], ['sandbox_prepare','wall_timeout'], ['sandbox_prepare','signin_timeout'],
    ['provider_url','startup_failed'], ['provider_url','wall_timeout'],
  ];
  for (const [stage, reasonCode] of cases) {
    for (const status of ['failed','timed_out']) {
      const flow = {status, stage, reasonCode};
      const inline = signInView({...flow,target:'codex'}).body;
      assert.doesNotMatch(inline, /Lending|Setup/);
      assert.equal(signInView({...flow,target:'docker'}).body, inline, 'the inline panel reads the same for every target');
      const agent = progressView({target:'codex',flow}).status;
      assert.match(agent, /Lending/);
      const expected = agent.replace(/Lending/g, 'Setup');
      const progress = progressView({target:'docker',flow});
      assert.equal(progress.status, expected);
      assert.equal(progress.next, 'setup');
    }
  }
  for (const reasonCode of ['policy_unenforceable','storage_unenforceable']) {
    const flow = {status:'failed',stage:'sandbox_prepare',reasonCode};
    const agent = signInView({...flow,target:'codex'}).body;
    assert.match(agent, /Save support archive in Settings → Data and send it to support\./);
    assert.equal(signInView({...flow,target:'docker'}).body, agent);
    assert.equal(progressView({target:'docker',flow}).status, agent);
  }
  assert.equal(signInView({status:'timed_out'}).body,
    'Sign-in timed out. Choose Start sign-in again.', 'unknown targets get the same panel copy');
});

test('sign-in low-disk copy names the free space lending needs', async () => {
  const {HOST_DISK_HEADROOM_BYTES} = await import('../../../lib/host-disk.mjs');
  const gib = HOST_DISK_HEADROOM_BYTES / 1024 ** 3;
  const body = signInView({status:'failed', stage:'sandbox_prepare', reasonCode:'host_disk_low', target:'codex'}).body;
  assert.match(body, new RegExp('at least ' + gib + ' GiB free'));
});

// These regressions use pure state and fake API replies; they never authenticate.
import {signInResponses} from './signin.mjs';
import {readFileSync} from 'node:fs';
test('cancellation intent and failed cancellation are not terminal receipts', async () => {
  for(const intent of [{cancelRequested:true},{cancelled:true},{cancelRequested:true,cancelError:true}]) {
    const view=progressView({target:'docker',...intent});
    assert.equal(view.terminal,false);
    assert.notEqual(view.heading,'Sign-in cancelled');
    assert.equal(view.url,undefined);
  }
  const storage=memory();let resolveStart;const calls=[];
  const pending=beginSignIn({id:'cancel-fails',target:'docker',storage,open:()=>null,onFlow:()=>{},api:{post:path=>{
    calls.push(path);return calls.length===1?new Promise(resolve=>{resolveStart=resolve;}):Promise.reject(new Error('offline'));
  }}});
  writeProgress(storage,'cancel-fails',{...readProgress(storage,'cancel-fails'),cancelRequested:true});
  resolveStart({flowId:'flow',status:'starting'});await pending;
  const saved=readProgress(storage,'cancel-fails');
  assert.deepEqual(calls,['signin/docker','signin/flow/cancel']);
  assert.equal(saved.cancelError,true);
  assert.equal(saved.flow.status,'starting');
  assert.equal(progressView(saved).terminal,false);
  assert.match(progressView(saved).status,/Retry Cancel sign-in/);
  assert.equal(progressView({...saved,flow:{status:'cancelled'}}).heading,'Sign-in cancelled');
});
test('recoverable errors stay beside active code entry and cannot mask completion',()=>{
  const flow={flowId:'f',status:'awaiting_browser',codeEntry:true,url:'https://provider.test',code:'CODE'};
  const view=signInView(flow,'network');
  assert.equal(view.codeEntry,true);assert.equal(view.code,'CODE');
  assert.deepEqual(view.actions,['open','cancel']);assert.ok(view.actionError);
  assert.equal(signInView(flow).actionError,undefined);
  assert.equal(signInView({status:'complete'},'network').status,'Signed in');
});
test('progress routes remount per ID, and a poll never clears an action error (only a new action does)',()=>{
  const main=readFileSync(new URL('./main.jsx',import.meta.url),'utf8');
  const source=readFileSync(new URL('./signin.jsx',import.meta.url),'utf8');
  assert.match(main,/<SignInProgress key=\{route\.id\} id=\{route\.id\}/);
  assert.doesNotMatch(source,/const apply=[^\n]*setError\(''\)/);
  assert.match(source,/working\.current=true;const ticket=responses\.current\.ticket\(\);setBusy\(true\);setError\(''\)/);
  assert.match(source,/alive\.current=false;responses\.current\.reset\(\)/);
});
test('progress read failure shows recovery rather than indefinite preparation',()=>{
  const failed=progressView({target:'docker',startedAt:1000,readFailed:true},12000);
  assert.match(failed.heading,/Can’t check/);assert.match(failed.status,/Retry/);
  assert.doesNotMatch(failed.status,/Usually|elapsed/);assert.equal(failed.url,undefined);
  assert.match(progressView({target:'docker',readFailed:false}).heading,/Starting/);
  const source=readFileSync(new URL('./signin.jsx',import.meta.url),'utf8');
  assert.match(source,/readFailed:true/);assert.match(source,/readFailed:false/);
  assert.ok(source.includes('progress.readFailed&&<Button pending={busy} onClick={()=>setRetry(n=>n+1)}>Check now</Button>'));
});
test('intentional inline cancellation is neutral, even with a retained failure stage',()=>{
  const view=signInView({status:'cancelled',stage:'sandbox_prepare'},'network');
  assert.equal(view.heading,'Sign-in cancelled');assert.equal(view.body,null);
  assert.deepEqual(view.actions,['retry']);
  assert.match(readFileSync(new URL('./signin.jsx',import.meta.url),'utf8'),/flow\?\.status==='cancelled'\?'Start again'/);
});
test('late reads cannot replace cancellation or a newer flow generation',async()=>{
  const gate=signInResponses();
  assert.equal(gate.accept(gate.ticket('expected'),{flowId:'other',status:'cancelled'}),false);
  assert.equal(gate.accept(gate.ticket(),{flowId:'A',status:'awaiting_browser'}),true);
  const late=gate.ticket(),cancel=gate.ticket();
  assert.equal(gate.accept(cancel,{flowId:'A',status:'cancelled'}),true);
  assert.equal(gate.terminal(),true);
  assert.equal(gate.accept(late,{flowId:'A',status:'awaiting_browser'}),false);
  assert.equal(gate.accept(gate.ticket(),{flowId:'A',status:'awaiting_browser'}),false);
  const old=gate.ticket();gate.reset();assert.equal(gate.terminal(),false);
  assert.equal(gate.accept(gate.ticket(),{flowId:'B',status:'starting'}),true);
  assert.equal(gate.accept(old,{flowId:'A',status:'complete'}),false);
  assert.equal(gate.accept(gate.ticket(),{flowId:'A',status:'complete'}),false);
  const first=gate.ticket(),second=gate.ticket();
  assert.equal(gate.accept(second,{flowId:'B',status:'complete'}),true);
  assert.equal(gate.accept(first,{flowId:'B',status:'starting'}),false);
});
test('every Docker recovery branch returns to Setup without promising to close the app tab',()=>{
  for(const state of [{cancelRequested:true},{flow:{status:'cancelled'}},{unavailable:true},{readFailed:true},{errorCode:'network'},{flow:{status:'complete'}}]) {
    const view=progressView({target:'docker',...state});
    assert.deepEqual(view.recovery,{href:'#/setup',label:'Go to Setup',name:'Setup'});
    assert.doesNotMatch(view.status,/Lending|This tab will close/);
  }
  assert.equal(progressView({target:'codex',unavailable:true}).recovery.href,'#/lend');
});

test('an early explicit cancel survives absent storage and terminal receipts stop progress reads',()=>{
  const source=readFileSync(new URL('./signin.jsx',import.meta.url),'utf8');
  assert.ok(source.includes('pendingCancel.current=!current.flow?.flowId'));
  assert.ok(source.includes('target:current.target||current.flow?.target,agentName:current.agentName||current.flow?.target'));
  assert.ok(source.includes('else if(pendingCancel.current)cancel(flow)'));
  assert.ok(source.includes('if(pending||working.current||responses.current.terminal())return'));
});

test('a sign-in that could not start no longer blames sandbox support', () => {
  const body = signInView({status:'failed', stage:'capabilities', reasonCode:'startup_failed', target:'codex'}).body;
  assert.match(body, /Sign-in could not start\./);
  assert.doesNotMatch(body, /sandbox support/);
});
