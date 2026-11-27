import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readFile, lstat, realpath, rename, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandPath,launcherForCli,loginPath} from '../lib/v1/command-path.mjs';
import {opById} from '../lib/v1/ops/registry.mjs';
import {runOp} from '../lib/v1/ops/execute.mjs';
import {startApp} from '../lib/v1/app.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'faravan-command-path-'));
  const home=join(root,'home'), install=join(home,'.local'), bin=join(install,'bin'), app=join(install,'lib','faravan');
  const pathDir=join(root,'path');
  await mkdir(home);
  await Promise.all([mkdir(bin,{recursive:true}),mkdir(app,{recursive:true}),mkdir(pathDir)]);
  const launcher=join(app,'faravan');
  await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,home,install,bin,app,pathDir,launcher};
}

test('install adds user bin to login PATH, links the install launcher, resolves in a fresh login shell, then uninstall removes it', async t => {
  const f=await fixture(t), ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  const originalBashrc='# user bashrc\n', originalProfile='# user profile\n';
  await writeFile(join(f.home,'.bashrc'),originalBashrc);
  await writeFile(join(f.home,'.profile'),originalProfile);
  assert.equal((await ops.status()).installed,false);
  const installed=await ops.install();
  assert.equal(installed.installed,true);
  assert.equal(installed.path,join(f.home,'.local','bin','faravan'));
  assert.equal((await lstat(installed.path)).isSymbolicLink(),true);
  await ops.install();
  const bashrc=await readFile(join(f.home,'.bashrc'),'utf8'), profile=await readFile(join(f.home,'.profile'),'utf8');
  assert.equal((bashrc.match(/# Faravan command path/g)||[]).length,1,'the interactive profile block is idempotent');
  assert.equal((profile.match(/# Faravan command path/g)||[]).length,1,'the login profile block is idempotent');
  await assert.rejects(readFile(join(f.home,'.bash_profile')),{code:'ENOENT'});
  const bash=await import('node:child_process');
  const {stdout}=await new Promise((resolve,reject)=>bash.execFile('/bin/bash',['--login','-c','command -v faravan'],{env:{...process.env,HOME:f.home,PATH:f.pathDir,SHELL:'/bin/bash'}},(error,stdout,stderr)=>error?reject(new Error(stderr||error.message)):resolve({stdout,stderr})));
  assert.equal(stdout.trim(),installed.path);
  const uninstalled=await ops.uninstall();
  assert.equal(uninstalled.installed,false);
  assert.equal(uninstalled.path,installed.path);
  assert.equal((await ops.status()).installed,false);
  assert.equal(await readFile(join(f.home,'.bashrc'),'utf8'),originalBashrc);
  assert.equal(await readFile(join(f.home,'.profile'),'utf8'),originalProfile);
});

test('install selects bashrc plus first existing login profile and zshrc plus zprofile under ZDOTDIR', async t=>{
  const bash=await fixture(t);
  await writeFile(join(bash.home,'.bash_login'),'# bash login\n');
  await writeFile(join(bash.home,'.profile'),'# profile must remain unused\n');
  const bashOps=createCommandPath({home:bash.home,launcher:bash.launcher,env:{PATH:bash.pathDir,SHELL:'/bin/bash'}});
  await bashOps.install();
  assert.match(await readFile(join(bash.home,'.bashrc'),'utf8'),/# Faravan command path/);
  assert.match(await readFile(join(bash.home,'.bash_login'),'utf8'),/# Faravan command path/);
  assert.doesNotMatch(await readFile(join(bash.home,'.profile'),'utf8'),/# Faravan command path/);
  await bashOps.uninstall();

  const zsh=await fixture(t), zdotdir=join(zsh.home,'zsh-config'), fakeShellDir=join(zsh.root,'fake-shell');
  await Promise.all([mkdir(zdotdir),mkdir(fakeShellDir)]);
  const fakeZsh=join(fakeShellDir,'zsh');
  await writeFile(fakeZsh,'#!/bin/sh\n. "$ZDOTDIR/.zprofile"\nprintf \'%s\\n%s\\n%s\\n\' FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END\n',{mode:0o755});
  const originals={'.zshrc':'# zshrc\n','.zprofile':'# zprofile\n'};
  for(const [name,content] of Object.entries(originals))await writeFile(join(zdotdir,name),content);
  const zshOps=createCommandPath({home:zsh.home,launcher:zsh.launcher,env:{PATH:zsh.pathDir,SHELL:fakeZsh,ZDOTDIR:zdotdir}});
  await zshOps.install();
  for(const name of Object.keys(originals))assert.match(await readFile(join(zdotdir,name),'utf8'),/# Faravan command path/);
  await zshOps.uninstall();
  for(const [name,content] of Object.entries(originals))assert.equal(await readFile(join(zdotdir,name),'utf8'),content);
});

test('status and install are exposed as typed command_path operations', async t=>{
  const f=await fixture(t), context={home:f.home,commandLauncher:f.launcher,env:{HOME:f.home,PATH:f.pathDir,SHELL:'/bin/bash'}};
  const status=opById('command_path.status'), install=opById('command_path.install');
  assert.ok(status&&install);
  assert.deepEqual(await runOp(status.id,{}, {...context,strict:true}),{installed:false,path:join(f.home,'.local','bin','faravan'),launcher:f.launcher,profile:join(f.home,'.bashrc'),profiles:[join(f.home,'.bashrc'),join(f.home,'.profile')],managed:true});
  assert.deepEqual(await runOp(install.id,{}, {...context,strict:true}),{installed:true,path:join(f.home,'.local','bin','faravan'),launcher:f.launcher,profile:join(f.home,'.bashrc'),profiles:[join(f.home,'.bashrc'),join(f.home,'.profile')],managed:true});
  const failure=await fixture(t), missing=await install.handler({home:failure.home,commandLauncher:join(failure.app,'missing'),env:{HOME:failure.home,PATH:failure.pathDir,SHELL:'/bin/bash'}});

  assert.equal(missing.installed,false);
  assert.equal(missing.error.code,'launcher_missing');
  assert.equal(missing.path,join(failure.home,'.local','bin','faravan'));
  assert.equal(missing.profile,join(failure.home,'.bashrc'));
});

test('launcher discovery selects package, portable and macOS app shims',()=>{
  assert.equal(launcherForCli('/usr/lib/faravan/bin/faravan'),'/usr/bin/faravan');
  assert.equal(launcherForCli('/usr/lib/faravan/bin/faravan'),'/usr/bin/faravan');
  assert.equal(launcherForCli('/home/ana/.local/lib/faravan/bin/faravan'),'/home/ana/.local/bin/faravan');
  assert.equal(launcherForCli('/home/ana/.local/lib/faravan/bin/faravan'),'/home/ana/.local/bin/faravan');
  assert.equal(launcherForCli('/Applications/Faravan.app/Contents/Resources/faravan/bin/faravan'),'/Applications/Faravan.app/Contents/MacOS/faravan');
  assert.equal(launcherForCli('/Applications/Faravan.app/Contents/Resources/faravan/bin/faravan'),'/Applications/Faravan.app/Contents/MacOS/faravan');
  assert.equal(launcherForCli('/Applications/Faravan.app/Contents/Resources/faravan/lib/v1/macos-launch.mjs'),'/Applications/Faravan.app/Contents/MacOS/faravan');
  assert.equal(launcherForCli('/tmp/faravan-preview-20261029/usr/lib/faravan/bin/faravan'),'/tmp/faravan-preview-20261029/usr/bin/faravan');
});

test('first app launch installs the product command',async t=>{
  const f=await fixture(t), channel={id:'faravan',name:'Faravan',dataFolder:'Faravan',bundleId:'com.faravan.app',helperBundleId:'com.faravan.app.notify',launchAgentLabel:'com.faravan.agent',linuxPrefix:'faravan'};
  const cli=join(f.root,'faravan-preview-qa','usr/lib/faravan/bin/faravan'), launcher=join(f.root,'faravan-preview-qa','usr/bin/faravan'), dataHome=join(f.root,'preview-data');
  await Promise.all([mkdir(join(cli,'..'),{recursive:true}),mkdir(join(launcher,'..'),{recursive:true}),mkdir(dataHome)]);
  await writeFile(cli,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await writeFile(launcher,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const target=launcherForCli(cli);
  assert.equal(target,launcher);
  const ops=createCommandPath({home:f.home,dataHome,launcher:target,channel,platform:'linux',env:{HOME:f.home,PATH:f.pathDir,SHELL:'/bin/bash'}});
  const result=await ops.verifyOnLaunch();
  assert.equal(result.installed,true);
  assert.equal(result.path,join(f.home,'.local/bin',channel.linuxPrefix));
  assert.equal(await realpath(result.path),await realpath(launcher));
  assert.match(await readFile(join(f.home,'.profile'),'utf8'),/# Faravan command path/);
  assert.equal(await realpath(join(f.home,'.local/bin/faravan')),await realpath(launcher));
});

test('a macOS command link runs the app-bundled Node runtime without PATH Node', {skip:process.platform==='win32'}, async t=>{
  const f=await fixture(t), app=join(f.root,'Faravan.app'), contents=join(app,'Contents'), resources=join(contents,'Resources','faravan');
  const cli=join(resources,'bin','faravan'), launcher=join(contents,'MacOS','faravan'), runtime=join(resources,'runtime','bin','node');
  const zdotdir=join(f.home,'zsh-config'), shell=join(f.pathDir,'zsh'), runtimeLog=join(f.root,'runtime-args.log');
  await Promise.all([mkdir(join(resources,'bin'),{recursive:true}),mkdir(join(resources,'runtime','bin'),{recursive:true}),mkdir(join(contents,'MacOS'),{recursive:true}),mkdir(zdotdir)]);
  await writeFile(cli,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.FARAVAN_RUNTIME_LOG,'system Node ran\\n');\n`,{mode:0o755});
  await writeFile(runtime,'#!/bin/sh\nprintf "bundled Node\\n" > "$FARAVAN_RUNTIME_LOG"\nprintf "%s\\n" "$@" >> "$FARAVAN_RUNTIME_LOG"\n',{mode:0o755});
  await writeFile(launcher,await readFile(new URL('../packaging/macos/launcher/cli.sh',import.meta.url),'utf8'),{mode:0o755});
  await symlink('/usr/bin/readlink',join(f.pathDir,'readlink'));
  await symlink('/usr/bin/dirname',join(f.pathDir,'dirname'));
  await writeFile(shell,'#!/bin/sh\n[ ! -f "$ZDOTDIR/.zprofile" ] || . "$ZDOTDIR/.zprofile"\nprintf \'%s\\n%s\\n%s\\n\' FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END\n',{mode:0o755});

  const target=launcherForCli(cli);
  assert.equal(target,launcher);
  const ops=createCommandPath({home:f.home,launcher:target,platform:'darwin',env:{HOME:f.home,PATH:f.pathDir,SHELL:shell,ZDOTDIR:zdotdir}});
  const installed=await ops.install();
  assert.equal(installed.installed,true);
  assert.equal(await realpath(installed.path),await realpath(launcher));

  const result=spawnSync(installed.path,['--version'],{encoding:'utf8',env:{HOME:f.home,PATH:f.pathDir,FARAVAN_RUNTIME_LOG:runtimeLog}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(await readFile(runtimeLog,'utf8'),`bundled Node\n${contents}/MacOS/../Resources/faravan/bin/faravan\n--version\n`);
});

test('app launch repairs a broken user link silently', async t => {
  const f=await fixture(t), ops=createCommandPath({home:f.home,dataHome:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.bin,SHELL:'/bin/bash'}});
  const installed=await ops.install();
  await rm(installed.path);
  await assert.rejects(startApp({home:f.home,commandLauncher:f.launcher,env:{HOME:f.home,PATH:f.bin,SHELL:'/bin/bash'},port:-1}),{code:'invalid_request'});
  await assert.rejects(lstat(installed.path),{code:'ENOENT'},'a rejected startup does not repair the link');
  const app=await startApp({home:f.home,commandLauncher:f.launcher,env:{HOME:f.home,PATH:f.bin,SHELL:'/bin/bash'},port:0,freshLending:'off'});
  try {
    assert.equal((await lstat(installed.path)).isSymbolicLink(),true);
    assert.equal((await ops.status()).installed,true);
  } finally {await app.close();}
});

test('first app launch installs the CLI link without a separate terminal setup step', async t => {
  const f=await fixture(t);
  const ops=createCommandPath({home:f.home,dataHome:f.home,launcher:f.launcher,platform:'linux',env:{HOME:f.home,PATH:f.bin,SHELL:'/bin/bash'}});
  const app=await startApp({home:f.home,commandLauncher:f.launcher,env:{HOME:f.home,PATH:f.bin,SHELL:'/bin/bash'},port:0,freshLending:'off'});
  try {
    assert.equal((await lstat(ops.link)).isSymbolicLink(),true);
    assert.equal((await ops.status()).installed,true);
    assert.match(await readFile(join(f.home,'.profile'),'utf8'),/# Faravan command path/);
  } finally {await app.close();}
});

test('a foreign command on PATH is reported as a conflict and a directory is not a command', async t=>{
  const f=await fixture(t), foreign=join(f.pathDir,'faravan');
  await writeFile(foreign,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  const status=await ops.status();
  assert.equal(status.installed,false);
  assert.equal(status.error.code,'command_path_conflict');
  assert.equal(status.error.path,foreign);
  await writeFile(join(f.pathDir,'faravan'),'not executable');

  const dirFixture=await fixture(t), directory=join(dirFixture.pathDir,'faravan');
  await mkdir(directory);
  const directoryOps=createCommandPath({home:dirFixture.home,launcher:dirFixture.launcher,platform:'linux',env:{PATH:dirFixture.pathDir,SHELL:'/bin/bash'}});
  assert.equal((await directoryOps.status()).installed,false);
});

test('unsupported shells and Windows fail before changing files',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile');
  const fish=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/usr/bin/fish'}});
  assert.equal((await fish.install()).error.code,'command_path_unsupported_shell');
  await assert.rejects(readFile(profile),{code:'ENOENT'});
  const windows=createCommandPath({home:f.home,launcher:f.launcher,platform:'win32',env:{PATH:f.pathDir,SHELL:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'}});
  assert.equal((await windows.status()).error.code,'command_path_unsupported_platform');
  assert.equal((await windows.install()).error.code,'command_path_unsupported_platform');
  await assert.rejects(readFile(profile),{code:'ENOENT'});
});

test('install repairs a marker-only profile block and preserves its mode',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile');
  await writeFile(profile,'# before\n# Faravan command path\n',{mode:0o640});
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  const result=await ops.install();
  assert.equal(result.installed,true);
  const content=await readFile(profile,'utf8');
  assert.match(content,/# Faravan command path\ncase ":\$PATH:" in/);
  assert.equal((content.match(/# Faravan command path/g)||[]).length,1);
  assert.equal((await stat(profile)).mode&0o777,0o640);
});

test('profile writes follow symlinks and preserve target mode; dangling profile symlinks are reported',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc'), destination=join(f.root,'shared-bashrc');
  await writeFile(destination,'# shared profile\n',{mode:0o640});
  await symlink(destination,profile);
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  assert.equal((await ops.install()).installed,true);
  assert.equal((await lstat(profile)).isSymbolicLink(),true);
  assert.match(await readFile(destination,'utf8'),/# Faravan command path/);
  assert.equal((await stat(destination)).mode&0o777,0o640);
  await ops.uninstall();

  const dangling=join(f.home,'.bashrc');
  await unlink(dangling);
  await symlink(join(f.root,'missing-profile'),dangling);
  const failed=await ops.install();
  assert.equal(failed.error.code,'command_path_write_failed');
  assert.equal((await lstat(dangling)).isSymbolicLink(),true);
  await assert.rejects(realpath(dangling),{code:'ENOENT'});
});

test('login-shell probe gets EOF when a startup profile reads stdin',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bash_profile');
  await writeFile(profile,'read ignored_value\n');
  const started=Date.now();
  const result=await loginPath({home:f.home,env:{PATH:`${f.pathDir}:/usr/bin:/bin`,SHELL:'/bin/bash'}});
  assert.ok(Date.now()-started<3000,'the login shell probe must not wait for profile input');
  assert.equal(typeof result,'string');
});

for(const scenario of [
  {description:'a descendant holds its pipes',parentTrap:"trap '' TERM",redirect:''},
  {description:'the shell exits before a pipe-free descendant',parentTrap:"trap 'exit 0' TERM",redirect:'>/dev/null 2>&1'},
])test('login PATH timeout kills its process group when '+scenario.description,async t=>{
  const f=await fixture(t), shell=join(f.root,'bash');
  const shellPidFile=join(f.root,'shell.pid'), descendantPidFile=join(f.root,'descendant.pid');
  const script=[
    '#!/bin/sh',
    'printf \"%s\\\\n\" \"$$\" > \"$TEST_SHELL_PID_FILE\"',
    scenario.parentTrap,
    '(',
    "  trap '' TERM",
    '  exec /bin/sleep 60 '+scenario.redirect,
    ') &',
    'descendant=$!',
    'printf \"%s\\\\n\" \"$descendant\" > \"$TEST_DESCENDANT_PID_FILE\"',
    'wait \"$descendant\"',
  ].join('\n')+'\n';
  await writeFile(shell,script,{mode:0o755});
  const env={HOME:f.home,PATH:'/usr/bin:/bin',SHELL:shell,
    TEST_SHELL_PID_FILE:shellPidFile,TEST_DESCENDANT_PID_FILE:descendantPidFile};
  const pidFrom=async path=>Number(await readFile(path,'utf8').catch(()=> ''));
  let processesStopped=false;
  const stopOwnedProcesses=async()=>{
    if(processesStopped)return;
    processesStopped=true;
    for(const pid of [await pidFrom(descendantPidFile),await pidFrom(shellPidFile)]) {
      if(pid>0)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    }
  };
  t.after(stopOwnedProcesses);
  try {
    const started=Date.now();
    const outcome=await Promise.race([
      loginPath({home:f.home,env,platform:'linux'}).then(path=>({path}),error=>({error})),
      new Promise(resolve=>setTimeout(()=>resolve({timedOut:true}),16000)),
    ]);
    const elapsed=Date.now()-started;
    assert.notEqual(outcome.timedOut,true,'the PATH probe must settle at its 15 second deadline');
    assert.equal(outcome.error?.code,'command_path_shell_failed');
    assert.ok(elapsed<15500,'the PATH probe exceeded its 15 second wall-clock bound: '+elapsed+'ms');
    const shellPid=await pidFrom(shellPidFile), descendantPid=await pidFrom(descendantPidFile);
    assert.ok(shellPid>0&&descendantPid>0,'the fixture started a shell and its descendant');
    await new Promise(resolve=>setTimeout(resolve,50));
    for(const pid of [shellPid,descendantPid]) {
      const processInfo=spawnSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'});
      assert.equal(processInfo.error,undefined);
      const state=processInfo.stdout.trim();
      assert.ok(!state||state.startsWith('Z'),'process '+pid+' remained alive after timeout (state '+state+')');
    }
  } finally {
    await stopOwnedProcesses();
  }
});

test('status does not classify an unverified command link as managed when launcher is unmapped',async t=>{
  const f=await fixture(t), link=join(f.home,'.local','bin','faravan');
  await symlink(f.launcher,link);
  const ops=createCommandPath({home:f.home,env:{PATH:f.bin,SHELL:'/bin/bash'}});
  const result=await ops.status();
  assert.equal(result.installed,false);
  assert.equal(result.managed,false);
  assert.equal(result.error.code,'command_path_conflict');
});

test('a profile write failure leaves the original bytes intact',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc'), original='# keep these bytes\n';
  await writeFile(profile,original);
  await chmod(f.home,0o500);
  const ops=createCommandPath({home:f.home,dataHome:f.root,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  const result=await ops.install();
  await chmod(f.home,0o700);
  assert.equal(result.error.code,'command_path_write_failed');
  assert.equal(result.error.directory,f.home);
  assert.equal(await readFile(profile,'utf8'),original);
});

test('login PATH parsing ignores profile output and allows slow startup files',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile');
  await writeFile(profile,'echo profile startup text\nsleep 4\n');
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:`${f.pathDir}:/usr/bin:/bin`,SHELL:'/bin/bash'}});
  const result=await ops.install();
  assert.equal(result.installed,true);
});

test('uninstall removes the managed block from every candidate profile',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bash_profile'), bashrc=join(f.home,'.bashrc');
  await writeFile(profile,'# profile\n');
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  await ops.install();
  const after=await ops.uninstall();
  assert.equal(after.installed,false);
  assert.doesNotMatch(await readFile(profile,'utf8'),/# Faravan command path/);
  assert.doesNotMatch(await readFile(bashrc,'utf8'),/# Faravan command path/);
  assert.equal((await ops.status()).installed,false);
  const foreign=join(f.pathDir,'faravan');
  await writeFile(foreign,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const stillResolves=await ops.uninstall();
  assert.equal(stillResolves.installed,false);
  assert.equal(stillResolves.path,foreign);
});

test('uninstall removes its dangling launcher symlink and keeps a foreign dangling symlink',async t=>{
  const f=await fixture(t), ops=createCommandPath({home:f.home,launcher:f.launcher,env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  await ops.install();
  await rename(f.launcher,join(f.app,'launcher-moved'));
  const result=await ops.uninstall();
  assert.equal(result.installed,false);
  await assert.rejects(lstat(ops.link),{code:'ENOENT'});
  await rename(join(f.app,'launcher-moved'),f.launcher);
  const foreign=join(f.root,'foreign-missing');
  await symlink(foreign,ops.link);
  await ops.uninstall();
  assert.equal((await lstat(ops.link)).isSymbolicLink(),true);
});

test('marker matching and removal tolerate trailing whitespace',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile');
  await writeFile(profile,'# keep\n# Faravan command path   \ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n');
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{PATH:f.pathDir,SHELL:'/bin/bash'}});
  await ops.install();
  const content=await readFile(profile,'utf8');
  assert.equal((content.match(/# Faravan command path/g)||[]).length,1);
  assert.match(content,/# Faravan command path\s*\ncase ":\$PATH:" in/);
  await ops.uninstall();
  assert.doesNotMatch(await readFile(profile,'utf8'),/Faravan command path/);
});

test('launch verification repairs only missing or dangling links and never throws on a foreign link',async t=>{
  const f=await fixture(t), ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'linux',env:{PATH:`${f.bin}:${join(f.home,'.local','bin')}`,SHELL:'/bin/bash'}});
  await ops.install();
  await rm(ops.link);
  await writeFile(ops.link,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const foreignHome=join(f.home,'foreign');
  await mkdir(foreignHome);
  const foreign=join(foreignHome,'faravan');
  await writeFile(foreign,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await rm(ops.link);
  await symlink(foreign,ops.link);
  const result=await ops.verifyOnLaunch();
  assert.equal(result.error.code,'command_path_conflict');
  assert.equal(await realpath(ops.link),foreign);
});
