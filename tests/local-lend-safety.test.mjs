import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {commandAllowed,daemonEnvironment,requireDisk,MIN_FREE_BYTES,waitForIdle,waitForAgents,policyDiff,loginStatus,recordRefusal} from '../packaging/journey/local-lend-safety.mjs';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';

test('live wrapper blocks authentication, daemon control and every secret mutation before invoking sbx',()=>{
  const root=fs.mkdtempSync(join(os.tmpdir(),'lend-fence-'));
  try {
    const fake=join(root,'sbx'),config=join(root,'config.json'),marker=join(root,'invoked');
    fs.writeFileSync(fake,'#!/bin/sh\ntouch "'+marker+'"\n',{mode:0o700});
    const refusalLog=join(root,'refusals');
    fs.writeFileSync(config,JSON.stringify({realSbx:fake,env:{},before:[],refusalLog}));
    for(const args of [['login','--help'],['login','--username','private-value'],['--no-input','login'],['logout'],...['start','stop','restart'].map(v=>['daemon',v]),...['secret','secrets'].flatMap(noun=>['set','set-custom','import','rm','delete','write'].map(v=>[noun,v])),['policy','init'],['policy','reset'],['policy','allow','network','*'],['policy','deny','network','--sandbox','foreign','*'],['--cloud','login'],['--no-input','logout']]) {
      const result=spawnSync(process.execPath,[resolve('packaging/journey/local-lend-safety.mjs'),'--wrapper',config,...args]);
      assert.equal(result.status,125,args.join(' '));assert.equal(fs.existsSync(marker),false);
    }
    assert.equal(commandAllowed(['secret','ls']),true);
    assert.doesNotMatch(fs.readFileSync(refusalLog,'utf8'),/private-value/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('refusal logging records verbs without argument values; bare login was blocked by the generic fence',()=>{
  const root=fs.mkdtempSync(join(os.tmpdir(),'lend-refusal-'));
  try {
    const log=join(root,'verbs');
    assert.equal(commandAllowed(['login']),false);
    recordRefusal(log,['login']);recordRefusal(log,['secret','set','private-token']);
    assert.equal(fs.readFileSync(log,'utf8'),'["login"]\n["secret","set"]\n');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('bare login status is bounded, headless, closes stdin and never relays interactive output',async()=>{
  const root=fs.mkdtempSync(join(os.tmpdir(),'lend-login-'));
  try {
    const fake=join(root,'sbx'),browserOpener=join(root,'browser'),browserMarker=join(root,'browser-called');
    fs.writeFileSync(browserOpener,'#!/bin/sh\n: > "'+browserMarker+'"\nexit 1\n',{mode:0o700});
    fs.writeFileSync(fake,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
if(process.argv[2]==='diagnose'){console.log(process.env.CASE==='signedout'?'Authentication: not authenticated':'Authentication: authenticated');process.exit(0);}
if(fs.readFileSync(0).length||process.env.DISPLAY||process.env.WAYLAND_DISPLAY)process.exit(2);
if(process.env.CASE==='timeout')setInterval(()=>{},1000);
else if(process.env.CASE==='browser'){spawnSync(process.env.BROWSER,[]);setInterval(()=>{},1000);}
else if(process.env.CASE==='url'){process.stdout.write('ht');setTimeout(()=>process.stderr.write('tps://fixture.invalid/private-code'),10);setInterval(()=>{},1000);}
else if(process.env.CASE==='code'){console.error('Enter the code: private-value');setInterval(()=>{},1000);}
else if(process.env.CASE==='open'){console.log('Open the sign-in page');setInterval(()=>{},1000);}
else console.log('You are signed in [username: fixture]');
`,{mode:0o700});
    const options={realSbx:fake,env:{...process.env,CASE:'status'},browserOpener,browserMarker,timeoutMs:2000};
    assert.match(await loginStatus(options),/You are signed in/);
    for(const [kind,error] of [['signedout','not_authenticated'],['url','interactive_output'],['code','interactive_output'],['open','interactive_output'],['timeout','timeout'],['browser','browser_called']]){
      await assert.rejects(loginStatus({...options,env:{...options.env,CASE:kind},timeoutMs:kind==='timeout'?50:2000}),new RegExp(error));
    }
    fs.rmSync(browserMarker);
    const config=join(root,'config.json'),stopFile=join(root,'stop');
    for(const [kind,error] of [['status',null],['code','interactive_output'],['url','interactive_output'],['timeout','timeout'],['browser','browser_called']]) {
      fs.rmSync(stopFile,{force:true});fs.rmSync(browserMarker,{force:true});
      fs.writeFileSync(config,JSON.stringify({...options,timeoutMs:kind==='timeout'?50:2000,env:{...options.env,CASE:kind},stopFile,refusalLog:join(root,'refusals')}));
      const result=spawnSync(process.execPath,[resolve('packaging/journey/local-lend-safety.mjs'),'--wrapper',config,'login'],{encoding:'utf8'});
      if(!error){assert.equal(result.status,0);assert.match(result.stdout,/You are signed in/);assert.equal(fs.existsSync(stopFile),false);}
      else {
        assert.equal(result.status,125);assert.equal(result.stdout,'');
        assert.doesNotMatch(result.stderr,/private-value|fixture.invalid/);
        assert.equal(fs.readFileSync(stopFile,'utf8'),'login_status_'+error);
      }
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('agents wait for both background probes and stop at ten minutes',async()=>{
  let reads=0,clock=0;
  const rows=checking=>['claude-code-subscription','codex'].map(id=>({id,signInState:checking?'Checking':'Signed in',installed:checking?null:true}));
  const ready=await waitForAgents(async()=>rows(++reads<3),{now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(reads,3);assert.equal(ready[0].installed,true);
  clock=0;
  await assert.rejects(waitForAgents(async()=>rows(true),{now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:10}),/Checking after 10 minutes/);
});
test('policy removal requires an exact new rule id and preserves older rules',()=>{
  const old={id:'old',scope:'sandbox:old',applies_to:'sandbox:old',resource_type:'network'};
  const added={...old,id:'new',scope:'sandbox:ours',applies_to:'sandbox:ours'};
  const args=id=>['policy','rm','network','--sandbox','ours','--id',id,'--force'];
  assert.equal(commandAllowed(args('old'),[old],[old,added]),false);
  assert.equal(commandAllowed(args('missing'),[old],[old,added]),false);
  assert.equal(commandAllowed(args('new'),[old],[old,added]),true);
  assert.equal(commandAllowed(['policy','allow','network','--sandbox','ours','example.com'],[],[],['ours']),true);
  assert.equal(commandAllowed(['policy','allow','network','--sandbox','foreign','example.com'],[],[],['ours']),false);
  assert.equal(commandAllowed(['policy','rm','network','--all'],[old],[old,added]),false);
  assert.throws(()=>policyDiff([old],[{...old,decision:'deny'},added]),/older policy/);
  assert.throws(()=>policyDiff([old],[added]),/older policy/);
});
test('disk guard checks available bytes on the owner filesystem at the 16 GiB boundary',()=>{
  assert.throws(()=>requireDisk('/owner',()=>({bavail:MIN_FREE_BYTES-1n,bsize:1n})),/16 GiB/);
  assert.equal(requireDisk('/owner',(home,opts)=>{assert.equal(home,'/owner');assert.equal(opts.bigint,true);return {bavail:MIN_FREE_BYTES,bsize:1n};}),Number(MIN_FREE_BYTES));
});
test('idle guard waits, treats unknown states as busy, and stops at its deadline',async()=>{
  const listing=rows=>({code:0,stdout:JSON.stringify(rows)});let clock=0,calls=0;
  const answer=await waitForIdle(()=>listing(++calls===1?[{name:'foreign',status:'running'}]:[{name:'foreign',status:'stopped'}]),{now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.deepEqual(answer,['foreign']);assert.equal(calls,2);
  clock=0;
  await assert.rejects(waitForIdle(()=>listing([{name:'foreign'}]),{now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:10}),/30 minutes/);
  await assert.rejects(waitForIdle(()=>({code:1})),/Cannot verify/);
});
test('daemon guard reads only the named running daemon and selects home/XDG/bus variables',()=>{
  const read=p=>p.endsWith('cmdline')?'/usr/bin/sbx\0daemon\0start\0':'HOME=/owner\0XDG_STATE_HOME=/state\0DBUS_SESSION_BUS_ADDRESS=disabled:\0TOKEN=never-copy\0';
  assert.deepEqual(daemonEnvironment('/owner',{read}),{HOME:'/owner',XDG_STATE_HOME:'/state',DBUS_SESSION_BUS_ADDRESS:'disabled:'});
  assert.throws(()=>daemonEnvironment('/other',{read}),/differs/);
  assert.throws(()=>daemonEnvironment('/owner',{read:()=>'/bin/other\0'}),/not running/);
});
test('live backend disables both capability auto-repair and health recovery',async()=>{
  const calls=[];
  const backend=new DockerSbxBackend({autoRepair:false,hostDisk:{},runCommand:async()=>{throw Error('unexpected sbx');}});
  assert.deepEqual(await backend.recoverHealth(),{recovered:false});
  const report=await backend.probeCapabilities({runCommand:async(_bin,args)=>{calls.push(args);return {code:1,stdout:'',stderr:'daemon not running'};},inspectDaemons:async()=>[],platformName:'linux'});
  assert.equal(report.available,false);
  assert.equal(calls.some(a=>['daemon','login','logout'].includes(a[0])||a[0]==='policy'&&['init','reset','rm'].includes(a[1])),false);
});
test('private scratch journal recovery does not inspect the shared home journal',async()=>{
  const root=fs.mkdtempSync(join(os.tmpdir(),'lend-journal-'));
  try {
    const journal=join(root,'private','scratch-journal');
    const backend=new DockerSbxBackend({scratchJournal:journal,runCommand:async()=>{throw Error('must not list or remove sandboxes');}});
    assert.equal(backend._scratchJournalPath(),journal);
    await backend.reconcileOrphanedScratch();
    assert.deepEqual(fs.readdirSync(root),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
