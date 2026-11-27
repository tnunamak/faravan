import './mounted.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandPath} from '../../../lib/v1/command-path.mjs';
import {CommandLineTool} from './command-line-tool.jsx';
import {click, mount, resetPage, teardown} from './mounted.test-helper.mjs';

async function makeResult(t,{code='ok'}={}) {
  const root=await mkdtemp(join(tmpdir(),'faravan-command-card-'));
  const home=join(root,'home'), bin=join(root,'path'), app=join(root,'app');
  await Promise.all([mkdir(home),mkdir(bin),mkdir(app)]);
  const launcher=join(app,'faravan');
  await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const env={PATH:bin,SHELL:'/bin/bash'};
  let target=launcher;
  if(code==='launcher_missing')target=join(app,'missing');
  if(code==='command_path_conflict')await writeFile(join(bin,'faravan'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  if(code==='command_path_write_failed')await writeFile(join(home,'.local'),'not a directory');
  if(code==='command_path_shell_failed')env.SHELL=join(root,'missing','bash');
  if(code==='command_path_unsupported_shell')env.SHELL='/usr/bin/fish';
  if(code==='lock_busy') {
    const owners=join(home,'.local/share/Faravan','command-path-installed.lock.owners-v1');
    await mkdir(owners,{recursive:true});
    await writeFile(join(owners,'unknown-owner'),'unrecognized owner bytes');
  }
  if(code==='command_path_data_home_conflict') {
    const ownerLauncher=join(app,'owner');
    await writeFile(ownerLauncher,'#!/bin/sh\nexit 0\n',{mode:0o755});
    const owner=createCommandPath({home,launcher:ownerLauncher,env});
    assert.equal((await owner.install()).installed,true);
  }
  const ops=createCommandPath({home,launcher:target,platform:code==='command_path_unsupported_platform'?'win32':'linux',env});
  const result=await ops.install();
  t.after(()=>rm(root,{recursive:true,force:true}));
  return result;
}

test('command-line tool maps actual command path failures to clear copy', async t => {
  t.after(teardown);
  const cases=[
    ['launcher_missing',/launcher couldn.t be found/],
    ['command_path_conflict',/Something else is already at/],
    ['command_path_write_failed',/Couldn.t write to/],
    ['command_path_shell_failed',/Could not check the PATH/],
    ['command_path_unsupported_shell',/Automatic setup does not support this shell yet/],
    ['command_path_unsupported_platform',/isn.t supported on Windows yet/],
  ];
  for(const [code,expected] of cases) {
    const result=await makeResult(t,{code});
    assert.equal(result.error.code,code);
    if(code==='command_path_write_failed')assert.ok(result.error.directory);
    else assert.equal(result.error.directory,undefined);
    const view=await mount(h(CommandLineTool,{api:{},initialResult:result}));
    assert.match(view.text(),expected);
    assert.ok(view.$('details'));
    if(code==='command_path_unsupported_shell'||code==='command_path_unsupported_platform')assert.equal(view.button('Install command-line tool'),null);
    else assert.ok(view.button('Install command-line tool'));
    await view.unmount();
    resetPage();
  }
});

test('installed copy requires a managed command path', async t=>{
  t.after(teardown); resetPage();
  const foreign=await mount(h(CommandLineTool,{api:{},initialResult:{installed:true,path:'/usr/bin/faravan',launcher:'/usr/bin/faravan',profile:'/home/ana/.bashrc',managed:false}}));
  assert.match(foreign.text(),/Another faravan is already installed at \/usr\/bin\/faravan/);
  assert.doesNotMatch(foreign.text(),/Installed\./);
  await foreign.unmount();
  resetPage();
  const managed=await mount(h(CommandLineTool,{api:{},initialResult:{installed:true,path:'/home/ana/.local/bin/faravan',launcher:'/Applications/Faravan.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true}}));
  assert.match(managed.text(),/Installed\./);
  assert.equal(managed.button('Install command-line tool'),null);
});

test('data-home ownership conflicts explain recovery without suggesting record removal or manual setup',async t=>{
  t.after(teardown); resetPage();
  const result=await makeResult(t,{code:'command_path_data_home_conflict'});
  assert.equal(result.error.code,'command_path_data_home_conflict');
  const view=await mount(h(CommandLineTool,{api:{},initialResult:result}));
  assert.match(view.$('[role="alert"]').textContent,/data home is already used/);
  assert.match(view.$('[role="alert"]').textContent,/different data home \(FARAVAN_DATA_HOME\)/);
  assert.doesNotMatch(view.text(),/Remove it|choose another command location/);
  const commands=[...view.$$('details code')].map(code=>code.textContent);
  assert.equal(commands.some(command=>command.startsWith('mkdir -p ')||command.startsWith('grep -Fqx ')),false);
});

test('busy command setup explains retry and hides manual mutation instructions',async t=>{
  t.after(teardown); resetPage();
  const result=await makeResult(t,{code:'lock_busy'});
  assert.equal(result.error.code,'lock_busy');
  const view=await mount(h(CommandLineTool,{api:{},initialResult:result}));
  assert.match(view.$('[role="alert"]').textContent,/setup is busy.*lock owner.*try again/i);
  assert.equal(view.$('details pre'),null);
  assert.doesNotMatch(view.$('details').textContent,/mkdir -p|Edit your shell profiles|export PATH=/);
});

test('manual fallback gives profile editing instructions without a rewrite command', async t=>{
  t.after(teardown); resetPage();
  const result=await makeResult(t,{code:'command_path_conflict'});
  const view=await mount(h(CommandLineTool,{api:{},initialResult:result}));
  await click(view.$('details summary'));
  const details=view.$('details').textContent;
  assert.match(details,/Edit your shell profiles yourself/);
  assert.match(details,/# Faravan command path/);
  assert.match(details,/case ":\$PATH:" in/);
  assert.match(details,/\.bashrc/);
  assert.match(details,/\.profile/);
  assert.doesNotMatch(details,/awk -v marker=|tmp=.*faravan\.tmp|mv "\$tmp"/);
});

test('conflict copy does not promise a command location choice that is not offered',async t=>{
  t.after(teardown); resetPage();
  const result=await makeResult(t,{code:'command_path_conflict'});
  const view=await mount(h(CommandLineTool,{api:{},initialResult:result}));
  assert.doesNotMatch(view.text(),/choose another command location/i);
  assert.match(view.text(),/use Faravan.s built-in terminal/i);
});

test('command-line tool button calls install and displays managed success', async t => {
  t.after(teardown); resetPage(); const calls=[];
  const api={post:async(path,body)=>{calls.push([path,body]); return {installed:true,path:'/home/ana/.local/bin/faravan',launcher:'/Applications/Faravan.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true};}};
  const view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/home/ana/.local/bin/faravan',launcher:'/Applications/Faravan.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true}}));
  await click(view.button('Install command-line tool'));
  assert.deepEqual(calls,[['ops/command_path.install',{}]]);
  assert.match(view.text(),/Installed\./);
});

test('preview command copy and fallback keep the channel command and profile marker',async t=>{
  t.after(teardown); resetPage();
  const command='faravan-preview-upgrade';
  const result={installed:true,path:`/home/ana/.local/bin/${command}`,launcher:'/Applications/Faravan Preview.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true};
  const managed=await mount(h(CommandLineTool,{api:{},initialResult:result}));
  assert.match(managed.text(),/faravan-preview-upgrade help/);
  await managed.unmount(); resetPage();
  const missing=await mount(h(CommandLineTool,{api:{},initialResult:{...result,installed:false,error:{code:'command_path_unresolved'}}}));
  assert.match(missing.text(),/can't find faravan-preview-upgrade/);
  const commands=[...missing.$$('details code')].map(code=>code.textContent);
  assert.match(missing.$('details pre code').textContent,/^# Faravan command path \(faravan-preview-upgrade\)\ncase ":/);
  assert.ok(commands.some(text=>text.startsWith('mkdir -p ')&&text.includes(`/home/ana/.local/bin/${command}`)));
});

const settleUI=()=>new Promise(resolve=>setTimeout(resolve,30));
test('F2 failed and unresolved status reads expose a working Check again',async t=>{
 t.after(teardown);resetPage();let calls=0;
 const api={post:()=>++calls===1?new Promise(()=>{}):Promise.resolve({installed:false,path:'/command'})};
 const view=await mount(h(CommandLineTool,{api,statusTimeoutMs:5}));
 await settleUI();assert.match(view.text(),/Could not check command-line tool status. Check again/);
 await click(view.button('Check again'));await settleUI();
 assert.equal(calls,2);assert.ok(view.button('Install command-line tool'));
});
test('F2 unknown install cannot duplicate while original request is pending',async t=>{
 t.after(teardown);resetPage();let installs=0,resolveInstall,completed=false;
 const api={post:async path=>path.endsWith('.install')?(installs++,new Promise(resolve=>{resolveInstall=resolve;})):{installed:completed,managed:completed,path:'/command'}};
 const view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/command'},installTimeoutMs:5}));
 await click(view.button('Install command-line tool'));await settleUI();
 assert.match(view.text(),/Installation status is unknown/);
 await click(view.button('Check again'));await settleUI();
 const again=view.button('Install command-line tool');assert.equal(again.getAttribute('aria-disabled'),'true');
 await click(again);await settleUI();assert.equal(installs,1);
 completed=true;resolveInstall({installed:true,managed:true,path:'/command'});await settleUI();
 assert.match(view.text(),/Installed\./,'post-completion status reconciles the late success');
 assert.equal(installs,1,'reconciliation never starts another install');
 await view.rerender(h(CommandLineTool,{api,initialResult:{installed:true,managed:true,path:'/command'}}));
 assert.match(view.text(),/Installed\./);
});
test('F9 unsupported shell Details is not mislabeled as unsupported platform',async t=>{
 t.after(teardown);resetPage();
 const view=await mount(h(CommandLineTool,{api:{},initialResult:{installed:false,error:{code:'command_path_unsupported_shell'}}}));
 assert.equal((view.text().match(/Automatic setup does not support this shell yet/g)||[]).length,1);
 assert.doesNotMatch(view.$('details').textContent,/Automatic setup does not support this shell yet/);
 assert.doesNotMatch(view.$('details').textContent,/This platform does not support/);
});
test('F10 successful install hands owned focus to stable heading but never steals moved focus',async t=>{
 t.after(teardown);
 for(const move of [false,true]) {
  resetPage();let resolve;
  const view=await mount(h(CommandLineTool,{api:{post:()=>new Promise(done=>{resolve=done;})},initialResult:{installed:false,path:'/command'}}));
  const button=view.button('Install command-line tool');button.focus();await click(button);
  const heading=view.$('h2'),other=document.createElement('button');document.body.append(other);if(move)other.focus();
  resolve({installed:true,managed:true,path:'/command'});await settleUI();
  assert.equal(document.activeElement,move?other:heading);other.remove();
  await view.unmount();
 }
});

test.skip('F5 optionalness and safe removal need a verified product/removal contract',()=>{});

test('R1 pending and rejected installs retain ownership across remount',async t=>{
 t.after(teardown);
 for(const rejectRequest of [false,true]){
  resetPage();let finish,installs=0;
  const api={post:path=>path.endsWith('.install')?(installs++,new Promise((resolve,reject)=>{finish=rejectRequest?reject:resolve;})):Promise.resolve({installed:false,path:'/command'})};
  let view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/command'},installTimeoutMs:5}));
  await click(view.button('Install command-line tool'));await settleUI();
  if(rejectRequest){finish(Error('response lost'));await settleUI();}
  await view.unmount();view=await mount(h(CommandLineTool,{api,statusTimeoutMs:5,installTimeoutMs:5}));
  await settleUI();assert.match(view.text(),/Installation status is unknown/);
  const button=view.button('Install command-line tool');assert.equal(button.getAttribute('aria-disabled'),'true');
  await click(button);assert.equal(installs,1);
  if(!rejectRequest){finish({installed:true,managed:true,path:'/command'});await settleUI();}
  await view.unmount();
 }
});
test('R2 late install cannot replace newer status or a replacement API context',async t=>{
 t.after(teardown);
 for(const changeApi of [false,true]){
  resetPage();let finish;
  const api={post:path=>path.endsWith('.install')?new Promise(resolve=>{finish=resolve;}):Promise.resolve({installed:true,managed:true,path:'/newer'})};
  const view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/old'},installTimeoutMs:5}));
  await click(view.button('Install command-line tool'));await settleUI();
  if(changeApi)await view.rerender(h(CommandLineTool,{api:{post:async()=>({installed:false,path:'/replacement'})}}));
  else await click(view.button('Check again'));
  await settleUI();
  finish(changeApi?{installed:true,managed:true,path:'/old'}:{installed:false,path:'/old'});await settleUI();
  if(changeApi){assert.doesNotMatch(view.text(),/Installed\./);assert.match(view.text(),/replacement/);}
  else {assert.match(view.text(),/Installed\./);assert.match(view.text(),/newer/);}
  assert.doesNotMatch(view.text(),/old help/);await view.unmount();
 }
});

test('F2 older status cannot replace a newer initial observation',async t=>{
 t.after(teardown);resetPage();let resolveStatus;
 const api={post:()=>new Promise(resolve=>{resolveStatus=resolve;})};
 const view=await mount(h(CommandLineTool,{api}));
 await view.rerender(h(CommandLineTool,{api,initialResult:{installed:true,managed:true,path:'/newer'}}));
 resolveStatus({installed:false,path:'/old'});await settleUI();
 assert.match(view.text(),/Installed\./);assert.match(view.text(),/newer/);
});

test('late install reconciliation retains ownership until authoritative fresh status settles',async t=>{
 t.after(teardown);resetPage();let finish,reconcile;let installs=0,statuses=0;
 const api={post:path=>path.endsWith('.install')?(installs++,new Promise(resolve=>{finish=resolve;})):++statuses===1?Promise.resolve({installed:false,path:'/command'}):new Promise(resolve=>{reconcile=resolve;})};
 const view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/command'},installTimeoutMs:5}));
 await click(view.button('Install command-line tool'));await settleUI();
 await click(view.button('Check again'));await settleUI();
 finish({installed:true,managed:true,path:'/stale-install'});await settleUI();
 assert.equal(statuses,2,'terminal install must request a fresh snapshot');
 const retry=view.button('Install command-line tool');
 assert.equal(retry.getAttribute('aria-disabled'),'true');
 await click(retry);assert.equal(installs,1);
 reconcile({installed:true,managed:true,path:'/authoritative'});await settleUI();
 assert.match(view.text(),/Installed\./);assert.match(view.text(),/authoritative help/);
 assert.doesNotMatch(view.text(),/stale-install help/);assert.equal(installs,1);
});
test('unavailable error path has no copy action',async t=>{
 t.after(teardown);resetPage();
 const view=await mount(h(CommandLineTool,{api:{},initialResult:{installed:false,error:{code:'launcher_missing'}}}));
 assert.match(view.text(),/Command location: Unavailable/);assert.ok(view.button('Copy full path')===null,'no copy action without a path');
});
test('negative snapshot explains unresolved ownership without enabling another install',async t=>{
 t.after(teardown);resetPage();let installs=0;
 const api={post:path=>path.endsWith('.install')?(installs++,Promise.reject(new Error('lost response'))):Promise.resolve({installed:false,path:'/command'})};
 const view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/command'}}));
 await click(view.button('Install command-line tool'));await settleUI();await click(view.button('Check again'));await settleUI();
 assert.match(view.text(),/negative check cannot confirm the earlier setup stopped/);
 assert.equal(view.button('Install command-line tool').getAttribute('aria-disabled'),'true');assert.equal(installs,1);
});

test('a superseding status reconciles confirmed completion but never releases pending ownership early',async t=>{
 t.after(teardown);resetPage();let finish,firstRead,newRead;let installs=0,statuses=0;
 const api={post:path=>path.endsWith('.install')?(installs++,new Promise(resolve=>{finish=resolve;})):++statuses===1?Promise.resolve({installed:false,path:'/command'}):new Promise(resolve=>{if(statuses===2)firstRead=resolve;else newRead=resolve;})};
 let view=await mount(h(CommandLineTool,{api,initialResult:{installed:false,path:'/command'},installTimeoutMs:5}));
 await click(view.button('Install command-line tool'));await settleUI();await click(view.button('Check again'));await settleUI();
 finish({installed:true,managed:true,path:'/stale'});await settleUI();
 await view.unmount();view=await mount(h(CommandLineTool,{api}));await settleUI();
 assert.equal(statuses,3);newRead({installed:false,path:'/current'});await settleUI();
 assert.equal(view.button('Install command-line tool').getAttribute('aria-disabled'),'true');
 firstRead({installed:true,managed:true,path:'/obsolete'});await settleUI();
 assert.doesNotMatch(view.text(),/Installation status is unknown|Installed\./);
 assert.equal(view.button('Install command-line tool').getAttribute('aria-disabled'),null);assert.equal(installs,1);
});
