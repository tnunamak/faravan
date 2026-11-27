import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {STABLE_CHANNEL} from '../lib/channel-identity.mjs';
import {createCommandPath} from '../lib/v1/command-path.mjs';

const preview={id:'faravan',name:'Faravan',dataFolder:'Faravan',bundleId:'com.faravan.app',helperBundleId:'com.faravan.app.notify',launchAgentLabel:'com.faravan.agent',linuxPrefix:'faravan'};

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'faravan-command-owner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'home'), dataHome=join(root,'data'), bin=join(home,'.local','bin');
  const launcher=join(root,'stable','faravan'), previewLauncher=join(root,'preview','faravan');
  await Promise.all([mkdir(bin,{recursive:true}),mkdir(dataHome),mkdir(dirname(launcher)),mkdir(dirname(previewLauncher))]);
  await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(previewLauncher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const shell=join(root,'bash');
  await writeFile(shell,'#!/bin/bash --noprofile\n[ ! -f "$HOME/.profile" ] || . "$HOME/.profile"\nprintf "%s\\n%s\\n%s\\n" FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END\n',{mode:0o755});
  const env={HOME:home,PATH:bin,SHELL:shell};
  const ops=(target=launcher,channel=STABLE_CHANNEL,options={})=>createCommandPath({env,dataHome,launcher:target,channel,...options});
  const aliasDir=join(root,'stable-alias');
  await symlink(dirname(launcher),aliasDir);
  return {root,home,bin,dataHome,launcher,previewLauncher,env,ops,alias:join(aliasDir,'faravan'),marker:join(dataHome,'command-path-installed')};
}

test('same-owner directory symlink alias can repeat explicit setup',async t=>{
  const f=await fixture(t);
  assert.equal((await f.ops().install()).installed,true);
  const result=await f.ops(f.alias).install();
  assert.equal(result.error,undefined);
  assert.equal(result.installed,true);
});

test('same-owner directory symlink alias repairs a missing command link',async t=>{
  const f=await fixture(t);
  const owner=f.ops();
  assert.equal((await owner.install()).installed,true);
  await rename(owner.link,owner.link+'.retained');
  const alias=f.ops(f.alias);
  assert.equal((await alias.verifyOnLaunch()).installed,true);
  assert.equal(await readlink(alias.link),f.alias);
});

test('same-owner directory symlink alias removes its marker and profiles on uninstall',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.home,'.profile'),'# user profile\n');
  assert.equal((await f.ops().install()).installed,true);
  await f.ops(f.alias).uninstall();
  await assert.rejects(lstat(f.marker),{code:'ENOENT'});
  await assert.rejects(lstat(f.ops().link),{code:'ENOENT'});
  assert.equal(await readFile(join(f.home,'.profile'),'utf8'),'# user profile\n');
});

test('missing launcher ownership falls back to the same normalized path',async t=>{
  const f=await fixture(t);
  assert.equal((await f.ops().install()).installed,true);
  await rename(f.launcher,f.launcher+'.retained');
  const same=f.ops(join(dirname(f.launcher),'..','stable','faravan'));
  await same.uninstall();
  await assert.rejects(lstat(f.marker),{code:'ENOENT'});
});

test('different launcher targets remain foreign when present or missing',async t=>{
  const f=await fixture(t);
  const owner=f.ops();
  assert.equal((await owner.install()).installed,true);
  await rename(owner.link,owner.link+'.retained');
  const before=await readFile(f.marker);
  const other=f.ops(f.previewLauncher);
  assert.equal((await other.install()).error?.code,'command_path_data_home_conflict');
  await rename(f.launcher,f.launcher+'.retained');
  await rename(f.previewLauncher,f.previewLauncher+'.retained');
  assert.equal((await other.install()).error?.code,'command_path_data_home_conflict');
  await other.uninstall();
  assert.deepEqual(await readFile(f.marker),before);
});

test('case-only launcher aliases use filesystem identity on case-insensitive volumes',async t=>{
  const f=await fixture(t), alias=join(dirname(f.launcher),'FARAVAN');
  if(await realpath(alias).catch(()=>null)!==await realpath(f.launcher)) {
    t.skip('requires a case-insensitive filesystem');
    return;
  }
  assert.equal((await f.ops().install()).installed,true);
  const same=f.ops(alias);
  assert.equal((await same.install()).installed,true);
  await rename(same.link,same.link+'.retained');
  assert.equal((await same.verifyOnLaunch()).installed,true);
  await same.uninstall();
  await assert.rejects(lstat(f.marker),{code:'ENOENT'});
});

test('case-distinct launcher files stay foreign on case-sensitive volumes',async t=>{
  const f=await fixture(t), other=join(dirname(f.launcher),'FARAVAN');
  if(await realpath(other).catch(()=>null)===await realpath(f.launcher)) {
    t.skip('requires a case-sensitive filesystem');
    return;
  }
  await writeFile(other,'#!/bin/sh\nexit 0\n',{mode:0o755});
  assert.equal((await f.ops().install()).installed,true);
  assert.equal((await f.ops(other).install()).error?.code,'command_path_data_home_conflict');
});

const executable=async path=>{
  try {return (await stat(path)).isFile()&&(await access(path,constants.X_OK),true);}catch{return false;}
};

test('concurrent first installs cannot both acquire an unowned shared record',async t=>{
  const f=await fixture(t), firstReached=Promise.withResolvers(), firstGate=Promise.withResolvers();
  const secondReached=Promise.withResolvers(), secondGate=Promise.withResolvers();
  let secondPaused=false;
  const first=f.ops(f.launcher,STABLE_CHANNEL,{exists:async path=>{
    if(path===f.launcher){firstReached.resolve();await firstGate.promise;}
    return executable(path);
  }});
  const second=f.ops(f.previewLauncher,preview,{exists:async path=>{
    if(path===f.previewLauncher){secondPaused=true;secondReached.resolve();await secondGate.promise;}
    return executable(path);
  }});
  const installing=first.install();
  let competing;
  try {
    await firstReached.promise;
    competing=second.install();
    // Before serialization both callers reach their launcher check after reading
    // no owner. With serialization the second caller refuses without reaching it.
    await Promise.race([secondReached.promise,competing]);
    firstGate.resolve();
    assert.equal((await installing).installed,true);
    const before=await readFile(f.marker);
    secondGate.resolve();
    const loser=await competing;
    assert.equal(loser.installed,false);
    assert.equal(loser.error?.code,'lock_busy');
    assert.equal(secondPaused,false);
    assert.deepEqual(await readFile(f.marker),before);
    assert.equal(await readlink(second.link),f.launcher);
    assert.doesNotMatch(await readFile(join(f.home,'.profile'),'utf8'),/faravan-preview-ownership/);
    assert.equal((await second.install()).error?.code,'command_path_data_home_conflict');
    await rename(first.link,first.link+'.retained');
    assert.equal((await first.verifyOnLaunch()).installed,true);
  } finally {
    firstGate.resolve();secondGate.resolve();
    await Promise.allSettled([installing,competing]);
  }
});

test('an install transaction excludes uninstall and launch repair until its record is committed',async t=>{
  const f=await fixture(t), reached=Promise.withResolvers(), gate=Promise.withResolvers();
  const owner=f.ops(f.launcher,STABLE_CHANNEL,{beforeMutation:async(kind,path)=>{
    if(kind==='write-profile'&&path===join(f.home,'.bashrc')){reached.resolve();await gate.promise;}
  }});
  const installing=owner.install();
  try {
    await reached.promise;
    const operations=f.ops();
    const [,repair]=await Promise.all([assert.rejects(operations.uninstall(),{code:'lock_busy'}),operations.verifyOnLaunch()]);
    assert.equal(repair.error?.code,'lock_busy');
    assert.equal(await readlink(owner.link),f.launcher);
  } finally {
    gate.resolve();
    await installing;
  }
  assert.equal((await f.ops().status()).installed,true);
  assert.equal((await f.ops().install()).installed,true);
});

test('an unknown lock owner is busy and cannot authorize any command mutation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.ops().install()).installed,true);
  const before=await readFile(f.marker), profile=await readFile(join(f.home,'.profile'));
  const lockDirectory=f.marker+'.lock.owners-v1';
  await mkdir(lockDirectory,{recursive:true});
  const unknown=join(lockDirectory,'unknown-owner');
  await writeFile(unknown,'unrecognized owner bytes');
  const [install,repair]=await Promise.all([f.ops().install(),f.ops().verifyOnLaunch(),assert.rejects(f.ops().uninstall(),{code:'lock_busy'})]);
  assert.deepEqual([install.error?.code,repair.error?.code],['lock_busy','lock_busy']);
  assert.deepEqual(await readFile(f.marker),before);
  assert.deepEqual(await readFile(join(f.home,'.profile')),profile);
  assert.equal(await readlink(f.ops().link),f.launcher);
  assert.equal(await readFile(unknown,'utf8'),'unrecognized owner bytes');
});

test('failed setup releases the shared lock for another first owner',async t=>{
  const f=await fixture(t);
  const missing=f.ops(join(f.root,'missing'));
  assert.equal((await missing.install()).error?.code,'launcher_missing');
  assert.equal((await f.ops(f.previewLauncher,preview).install()).installed,true);
});

test('a different process cannot acquire the shared record while its first installer is paused',async t=>{
  const f=await fixture(t), ready=Promise.withResolvers(), result=Promise.withResolvers();
  const script=`
    import {access,stat} from 'node:fs/promises';
    import {constants} from 'node:fs';
    const {createCommandPath}=await import(process.argv[1]);
    const options=JSON.parse(process.argv[2]);
    const gate=new Promise(resolve=>process.once('message',resolve));
    const ops=createCommandPath({...options,exists:async path=>{
      if(path===options.launcher){process.send({ready:true});await gate;}
      try {return (await stat(path)).isFile()&&(await access(path,constants.X_OK),true);}catch{return false;}
    }});
    const result=await ops.install();
    process.send({result},()=>process.disconnect());
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,new URL('../lib/v1/command-path.mjs',import.meta.url).href,JSON.stringify({env:f.env,dataHome:f.dataHome,launcher:f.launcher,channel:STABLE_CHANNEL})],{env:f.env,stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('message',message=>{if(message.ready)ready.resolve();if(message.result)result.resolve(message.result);});
  const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  try {
    await Promise.race([ready.promise,ended.then(value=>{throw new Error('Installer exited before pause: '+JSON.stringify(value)+stderr);})]);
    const other=f.ops(f.previewLauncher,preview);
    assert.equal((await other.install()).error?.code,'lock_busy');
    await assert.rejects(lstat(other.link),{code:'ENOENT'});
    child.send('release');
    assert.equal((await result.promise).installed,true);
    assert.equal((await ended).code,0,stderr);
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await ended;
  }
});
