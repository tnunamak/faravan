import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile, mkdtemp, mkdir, readFile, readlink, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {channelDataHome, channelIdentity, STABLE_CHANNEL} from '../lib/channel-identity.mjs';
import {createCommandPath} from '../lib/v1/command-path.mjs';
import {runOp} from '../lib/v1/ops/execute.mjs';

const exec=promisify(execFile);
const preview={id:'faravan',name:'Faravan',dataFolder:'Faravan',bundleId:'com.faravan.app',helperBundleId:'com.faravan.app.notify',launchAgentLabel:'com.faravan.agent',linuxPrefix:'faravan'};

async function fixture(t,platform='linux') {
  const root=await mkdtemp(path.join(tmpdir(),'faravan-command-upgrade-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'), bin=path.join(home,'.local','bin');
  const app=platform==='darwin'?path.join(root,'Applications','Faravan Preview.app','Contents'):path.join(root,'preview','usr');
  const install=platform==='darwin'?path.join(app,'Resources','faravan'):path.join(app,'lib','faravan');
  const launcher=platform==='darwin'?path.join(app,'MacOS','faravan'):path.join(app,'bin','faravan');
  const stableLauncher=path.join(root,'stable','faravan');
  await Promise.all([mkdir(home),mkdir(path.dirname(launcher),{recursive:true}),mkdir(path.dirname(stableLauncher),{recursive:true}),mkdir(path.join(install,'lib'),{recursive:true})]);
  await writeFile(path.join(install,'channel.json'),JSON.stringify(preview));
  await writeFile(launcher,'#!/bin/sh\nprintf "preview-v1\\n"\n',{mode:0o755});
  await writeFile(stableLauncher,'#!/bin/sh\nprintf "stable\\n"\n',{mode:0o755});
  // The Darwin case uses real Linux files and bash with the Mac bundle/data layout.
  const env={HOME:home,PATH:bin,SHELL:'/bin/bash'};
  const channel=()=>channelIdentity(path.join(install,'lib','channel-identity.mjs'));
  const data=channelDataHome({channel:channel(),home,platform,env});
  const stableData=path.join(home,'.faravan');
  await Promise.all([mkdir(data,{recursive:true}),mkdir(stableData)]);
  await writeFile(path.join(data,'settings.json'),'preview data');
  await writeFile(path.join(stableData,'settings.json'),'stable data');
  const ops=()=>createCommandPath({home,dataHome:data,launcher,channel:channel(),platform,env});
  const stable=createCommandPath({home,dataHome:stableData,launcher:stableLauncher,channel:STABLE_CHANNEL,platform,env});
  return {root,home,bin,install,launcher,stableLauncher,data,stableData,env,channel,ops,stable};
}

for(const platform of ['linux','darwin'])test(`upgrading the command preserves data and ownership (${platform} layout)`,async t=>{
  const f=await fixture(t,platform);
  const installed=await f.ops().install();
  assert.equal(installed.error,undefined);
  assert.equal(installed.path,path.join(f.bin,preview.linuxPrefix));
  assert.equal(await readlink(installed.path),f.launcher);
  const marker=await readFile(path.join(f.data,'command-path-installed'),'utf8');
  assert.equal(JSON.parse(marker).launcher,f.launcher);

  await rename(f.launcher,f.launcher+'.v1');
  await writeFile(f.launcher,'#!/bin/sh\nprintf "preview-v2\\n"\n',{mode:0o755});
  await writeFile(path.join(f.install,'channel.json'),JSON.stringify(preview));
  const upgraded=await f.ops().verifyOnLaunch();
  assert.equal(upgraded.installed,true);
  assert.deepEqual(f.channel(),preview);
  assert.equal(channelDataHome({channel:f.channel(),home:f.home,platform,env:f.env}),f.data);
  assert.equal(await readFile(path.join(f.data,'settings.json'),'utf8'),'preview data');
  assert.equal(await readFile(path.join(f.data,'command-path-installed'),'utf8'),marker);
  assert.equal((await exec(installed.path,[],{env:f.env})).stdout.trim(),'preview-v2');

  // A missing preview link may be repaired only by its own marker after upgrading.
  await rename(installed.path,installed.path+'.retained');
  assert.equal((await f.ops().verifyOnLaunch()).installed,true);
  assert.equal(await readlink(installed.path),f.launcher);
  await f.ops().uninstall();
  await assert.rejects(readlink(installed.path),{code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.data,'command-path-installed')),{code:'ENOENT'});
});


test('preview setup sharing an explicit data home preserves stable ownership and missing-link repair',async t=>{
  const f=await fixture(t);
  const env={...f.env,FARAVAN_DATA_HOME:f.stableData};
  const stable=createCommandPath({env,launcher:f.stableLauncher,channel:STABLE_CHANNEL});
  const previewOps=createCommandPath({env,launcher:f.launcher,channel:preview});
  assert.equal((await stable.install()).installed,true);
  const marker=path.join(f.stableData,'command-path-installed');
  const before=await readFile(marker);
  const bashrc=await readFile(path.join(f.home,'.bashrc'));
  const profile=await readFile(path.join(f.home,'.profile'));

  const result=await previewOps.install();
  assert.deepEqual(await readFile(marker),before,'preview setup must preserve stable ownership bytes');
  assert.equal(result.installed,false);
  assert.equal(result.error?.code,'command_path_data_home_conflict');
  assert.equal(result.error.path,marker);
  assert.match(result.error.message,/data home.*faravan.*different data home/i);
  assert.equal(await readlink(previewOps.link),f.stableLauncher);
  assert.deepEqual(await readFile(path.join(f.home,'.bashrc')),bashrc);
  assert.deepEqual(await readFile(path.join(f.home,'.profile')),profile);

  await rename(stable.link,stable.link+'.retained');
  assert.equal((await stable.verifyOnLaunch()).installed,true);
  assert.equal(await readlink(stable.link),f.stableLauncher);
  assert.deepEqual(await readFile(marker),before);
});

test('a managed command link cannot replace another command ownership record',async t=>{
  const f=await fixture(t);
  const stable=createCommandPath({env:f.env,dataHome:f.data,launcher:f.stableLauncher,channel:STABLE_CHANNEL});
  assert.equal((await stable.install()).installed,true);
  const ops=f.ops();
  const marker=path.join(f.data,'command-path-installed');
  const before=await readFile(marker);
  const bashrc=await readFile(path.join(f.home,'.bashrc'));
  const profile=await readFile(path.join(f.home,'.profile'));
  assert.equal((await ops.install()).error?.code,'command_path_data_home_conflict');
  assert.deepEqual(await readFile(marker),before);
  assert.deepEqual(await readFile(path.join(f.home,'.bashrc')),bashrc);
  assert.deepEqual(await readFile(path.join(f.home,'.profile')),profile);
  assert.equal(await readlink(ops.link),f.stableLauncher);
});

test('a missing command link cannot replace another launcher ownership record',async t=>{
  const f=await fixture(t);
  const owner=createCommandPath({env:f.env,dataHome:f.data,launcher:f.stableLauncher,channel:preview});
  assert.equal((await owner.install()).installed,true);
  await rename(owner.link,owner.link+'.retained');
  const marker=path.join(f.data,'command-path-installed');
  const before=await readFile(marker);
  assert.equal((await f.ops().install()).error?.code,'command_path_data_home_conflict');
  assert.deepEqual(await readFile(marker),before);
  await assert.rejects(readlink(owner.link),{code:'ENOENT'});
  assert.equal((await owner.verifyOnLaunch()).installed,true);
  assert.equal(await readlink(owner.link),f.stableLauncher);
});

test('a preview refuses ownership of a foreign dangling command',async t=>{
  const f=await fixture(t);
  await mkdir(f.bin,{recursive:true});
  const link=path.join(f.bin,preview.linuxPrefix), foreign=path.join(f.root,'foreign','faravan');
  await symlink(foreign,link);
  assert.equal((await f.ops().install()).error?.code,'command_path_conflict');
  assert.equal(await readlink(link),foreign);
});

test('uninstall from another install cannot remove the preview owner profile or marker',async t=>{
  const f=await fixture(t);
  const installed=await f.ops().install();
  const profile=await readFile(path.join(f.home,'.profile'),'utf8');
  const marker=await readFile(path.join(f.data,'command-path-installed'),'utf8');
  const other=createCommandPath({home:f.home,dataHome:f.data,launcher:f.stableLauncher,channel:preview,env:f.env});
  await other.uninstall();
  assert.equal(await readlink(installed.path),f.launcher);
  assert.equal(await readFile(path.join(f.home,'.profile'),'utf8'),profile);
  assert.equal(await readFile(path.join(f.data,'command-path-installed'),'utf8'),marker);
});


test('installed command setup discovers preview metadata beside its packaged module',async t=>{
  const f=await fixture(t,'darwin'), module=path.join(f.install,'lib','v1','command-path.mjs');
  await mkdir(path.dirname(module));
  await copyFile(new URL('../lib/v1/command-path.mjs',import.meta.url),module);
  await copyFile(new URL('../lib/channel-identity.mjs',import.meta.url),path.join(f.install,'lib','channel-identity.mjs'));
  await copyFile(new URL('../lib/v1/lock.mjs',import.meta.url),path.join(f.install,'lib','v1','lock.mjs'));
  await copyFile(new URL('../lib/v1/windows-process.mjs',import.meta.url),path.join(f.install,'lib','v1','windows-process.mjs'));
  const installed=await import(pathToFileURL(module));
  const ops=installed.createCommandPath({env:f.env,launcher:f.launcher,platform:'darwin'});
  assert.equal((await ops.install()).path,path.join(f.bin,preview.linuxPrefix));
  assert.equal(JSON.parse(await readFile(path.join(f.data,'command-path-installed'),'utf8')).command,preview.linuxPrefix);
  assert.equal(await readlink(path.join(f.bin,'faravan')),f.launcher);
});

test('command metadata rejects uppercase names and paths',async t=>{
  const f=await fixture(t);
  for(const linuxPrefix of ['FARAVAN','../faravan','nested/command']) {
    assert.throws(()=>createCommandPath({home:f.home,launcher:f.launcher,channel:{...preview,linuxPrefix},env:f.env}),/Invalid (?:command channel identity|channel command name)/);
  }
  await assert.rejects(readlink(path.join(f.bin,'faravan')),{code:'ENOENT'});
});

test('command operations use the account home for links and the data home for markers',async t=>{
  const f=await fixture(t);
  const result=await runOp('command_path.install',{}, {home:f.stableData,commandLauncher:f.stableLauncher,env:f.env,strict:true});
  assert.equal(result.installed,true);
  assert.equal(result.path,path.join(f.bin,'faravan'));
  assert.equal(await readlink(result.path),f.stableLauncher);
  assert.equal(JSON.parse(await readFile(path.join(f.stableData,'command-path-installed'),'utf8')).launcher,f.stableLauncher);
  await assert.rejects(readlink(path.join(f.stableData,'.local','bin','faravan')),{code:'ENOENT'});
});

test('Windows preview upgrade keeps modeled data and alias ownership while command setup stays unsupported',async t=>{
  const f=await fixture(t);
  const windowsHome='C:\\Users\\owner';
  const windowsData=channelDataHome({channel:f.channel(),home:windowsHome,platform:'win32',env:{}});
  assert.equal(windowsData,'C:\\Users\\owner\\AppData\\Local\\Faravan');
  const modeledData=path.join(f.root,...windowsData.slice(3).split('\\'));
  const alias=path.join(f.root,'WindowsApps','faravan.exe');
  await Promise.all([mkdir(modeledData,{recursive:true}),mkdir(path.dirname(alias))]);
  await writeFile(path.join(modeledData,'settings.json'),'Windows preview data');
  await writeFile(alias,'stable package alias');
  const ops=()=>createCommandPath({home:f.home,dataHome:modeledData,launcher:f.launcher,channel:f.channel(),platform:'win32',env:f.env});
  assert.equal((await ops().install()).error.code,'command_path_unsupported_platform');
  await writeFile(path.join(f.install,'channel.json'),JSON.stringify(preview));
  await writeFile(f.launcher,'preview v2');
  assert.equal((await ops().verifyOnLaunch()).error.code,'command_path_unsupported_platform');
  assert.deepEqual(f.channel(),preview);
  assert.equal(await readFile(path.join(modeledData,'settings.json'),'utf8'),'Windows preview data');
  assert.equal(await readFile(alias,'utf8'),'stable package alias');
  await assert.rejects(readFile(path.join(modeledData,'command-path-installed')),{code:'ENOENT'});
  await assert.rejects(readlink(path.join(f.bin,'faravan')),{code:'ENOENT'});
});
