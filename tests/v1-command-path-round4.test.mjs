import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, writeFile, readFile, readlink, symlink, lstat, unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandPath} from '../lib/v1/command-path.mjs';

const ownership=f=>JSON.stringify({version:1,command:'faravan',launcher:f.launcher})+'\n';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'round4-'));
  const home=join(root,'home'), bin=join(home,'.local','bin'), other=join(root,'other'), shell=join(root,'bash'), launcher=join(root,'launcher');
  await mkdir(bin,{recursive:true}); await mkdir(other);
  await writeFile(launcher,'#!/bin/sh\n',{mode:0o755});
  await writeFile(shell,'#!/bin/bash --noprofile\n[ ! -f "$HOME/.profile" ] || . "$HOME/.profile"\nprintf "%s\\n%s\\n%s\\n" FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END\n',{mode:0o755});
  return {root,home,bin,other,launcher,ops:createCommandPath({home,launcher,env:{HOME:home,PATH:other,SHELL:shell}})};
}

for(const marked of [false,true]) for(const operation of ['install','verifyOnLaunch']) {
  test(`foreign dangling link survives ${operation}, marker=${marked}`,async t=>{
    const f=await fixture(t), target=join(f.root,'foreign-missing');
    await symlink(target,f.ops.link);
    if(marked){await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});await writeFile(join(f.home,'.local/share/Faravan','command-path-installed'),ownership(f));}
    await f.ops[operation]();
    assert.equal(await readlink(f.ops.link),target);
    await assert.rejects(lstat(join(f.home,'.profile')),{code:'ENOENT'});
  });
}

for(const operation of ['install','uninstall']) for(const line of ['export PATH="$HOME/tools:$PATH"','case ":$PATH:" in custom) echo custom ;; esac']) {
  test(`${operation} preserves a user PATH line after marker: ${line}`,async t=>{
    const f=await fixture(t), profile=join(f.home,'.profile');
    await writeFile(profile,`# Faravan command path\n${line}\n`);
    await f.ops[operation]();
    assert.match(await readFile(profile,'utf8'),new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  });
}

test('install reports conflict if profile selects a foreign command after link creation',async t=>{
  const f=await fixture(t), foreign=join(f.other,'faravan');
  await writeFile(foreign,'#!/bin/sh\n',{mode:0o755});
  await writeFile(join(f.home,'.profile'),'if [ -e "$HOME/.local/bin/faravan" ]; then export PATH="$TEST_OTHER:$HOME/.local/bin:$PATH"; else export PATH=/nonexistent; fi\n');
  const shell=join(f.root,'bash');
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:shell,TEST_OTHER:f.other}});
  const result=await ops.install();
  assert.equal(result.installed,false); assert.equal(result.error.code,'command_path_conflict'); assert.equal(result.error.path,foreign);
});

test('read-only profiles are not replaced through their writable directory',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc');
  await writeFile(profile,'# private settings\n',{mode:0o400});
  const result=await f.ops.install();
  assert.equal(result.installed,false); assert.equal(result.error.code,'command_path_write_failed');
  assert.equal(await readFile(profile,'utf8'),'# private settings\n');
});

for(const kind of ['file','link','dangling','directory']) {
  test(`install preserves foreign ${kind} at the candidate location`,async t=>{
    const f=await fixture(t), link=f.ops.link, foreign=join(f.root,'foreign');
    if(kind==='file')await writeFile(link,'foreign');
    if(kind==='directory')await mkdir(link);
    if(kind==='link'){await writeFile(foreign,'foreign');await symlink(foreign,link);}
    if(kind==='dangling')await symlink(foreign,link);
    const result=await f.ops.install();
    assert.equal(result.error.code,'command_path_conflict');
    if(kind==='file')assert.equal(await readFile(link,'utf8'),'foreign');
    if(kind==='directory')assert.equal((await lstat(link)).isDirectory(),true);
    if(kind==='link'||kind==='dangling')assert.equal(await readlink(link),foreign);
  });
}

test('uninstall does not report installed when a foreign command remains on PATH',async t=>{
  const f=await fixture(t), foreign=join(f.other,'faravan');
  await writeFile(foreign,'#!/bin/sh\n',{mode:0o755});
  const result=await f.ops.uninstall();
  assert.equal(result.installed,false);
  assert.equal(result.path,foreign);
});

test('an unrelated install marker is preserved during install',async t=>{
  const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed');
  await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});
  await writeFile(marker,'user data\n');
  await f.ops.install();
  assert.equal(await readFile(marker,'utf8'),'user data\n');
});

test('uninstall preserves unrelated install marker',async t=>{
  const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed');
  await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});
  await writeFile(marker,'user data\n');
  await f.ops.uninstall();
  assert.equal(await readFile(marker,'utf8'),'user data\n');
});

for(const shell of ['/bin/sh','/usr/bin/fish']) for(const platform of ['linux','darwin']) {
  test(`unsupported ${shell} on ${platform} writes no profile`,async t=>{
    const f=await fixture(t);
    const ops=createCommandPath({home:f.home,launcher:f.launcher,platform,env:{SHELL:shell,PATH:f.other}});
    assert.equal((await ops.install()).error.code,'command_path_unsupported_shell');
    await assert.rejects(lstat(ops.link),{code:'ENOENT'});
    await assert.rejects(lstat(join(f.home,'.profile')),{code:'ENOENT'});
  });
}

for(const platform of ['linux','darwin']) {
  test(`fresh login PATH resolves our launcher on ${platform}`,async t=>{
    const f=await fixture(t), shell=join(f.root,'bash');
    const ops=createCommandPath({home:f.home,launcher:f.launcher,platform,env:{HOME:f.home,PATH:f.other,SHELL:shell}});
    const result=await ops.install();
    assert.equal(result.installed,true);
    assert.equal(result.path,ops.link);
    assert.equal((await ops.status()).installed,true);
  });
}

test('profile symlink and target mode survive install and uninstall',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc'), target=join(f.root,'shared');
  await writeFile(target,'# settings\n',{mode:0o640}); await symlink(target,profile);
  assert.equal((await f.ops.install()).installed,true);
  assert.equal((await lstat(profile)).isSymbolicLink(),true);
  assert.equal((await lstat(target)).mode&0o777,0o640);
  await f.ops.uninstall();
  assert.equal(await readFile(target,'utf8'),'# settings\n');
  assert.equal((await lstat(profile)).isSymbolicLink(),true);
  assert.equal((await lstat(target)).mode&0o777,0o640);
});

test('uninstall preserves a link swapped after ownership was checked',async t=>{
  const f=await fixture(t), foreign=join(f.root,'foreign'), link=f.ops.link;
  await symlink(f.launcher,link);
  let swapped=false;
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')},beforeMutation:async(kind,path)=>{
    if(kind==='remove-link'&&path===link){await unlink(link);await symlink(foreign,link);swapped=true;}
  }});
  await ops.uninstall();
  assert.equal(swapped,true);
  assert.equal(await readlink(link),foreign);
});

test('install refuses a profile changed after it was read',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc');
  await writeFile(profile,'# original\n');
  let changed=false;
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')},beforeMutation:async(kind,path)=>{
    if(kind==='write-profile'&&path===profile){await writeFile(profile,'# user edit\n');changed=true;}
  }});
  const result=await ops.install();
  assert.equal(changed,true);
  assert.equal(result.installed,false);
  assert.equal(result.error.code,'command_path_write_failed');
  assert.equal(await readFile(profile,'utf8'),'# user edit\n');
});

test('uninstall preserves a marker replaced after it was checked',async t=>{
  const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed');
  await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});
  await writeFile(marker,ownership(f));
  let changed=false;
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')},beforeMutation:async(kind,path)=>{
    if(kind==='remove-marker'&&path===marker){await writeFile(marker,'user data\n');changed=true;}
  }});
  await ops.uninstall();
  assert.equal(changed,true);
  assert.equal(await readFile(marker,'utf8'),'user data\n');
});

test('install preserves a foreign marker symlink inserted during profile setup',async t=>{
  const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed'), target=join(f.root,'marker-target');
  await writeFile(target,'user data\n');
  let inserted=false;
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')},beforeMutation:async(kind)=>{
    if(kind==='profile-read'&&!inserted){await symlink(target,marker);inserted=true;}
  }});
  const result=await ops.install();
  assert.equal(inserted,true);
  assert.equal(result.error?.code,'command_path_conflict');
  assert.equal(await readlink(marker),target);
  assert.equal(await readFile(target,'utf8'),'user data\n');
});

for(const initial of ['missing','on-path','off-path','not-writable']) {
  test(`candidate directory ${initial}`,async t=>{
    const f=await fixture(t), home=join(f.root,'candidate-home'), bin=join(home,'.local','bin');
    await mkdir(home);
    if(initial!=='missing')await mkdir(bin,{recursive:true});
    if(initial==='not-writable')await chmod(bin,0o500);
    const ops=createCommandPath({home,launcher:f.launcher,env:{HOME:home,PATH:initial==='on-path'?bin:f.other,SHELL:join(f.root,'bash')}});
    const result=await ops.install();
    if(initial==='not-writable')assert.equal(result.error.code,'command_path_write_failed');
    else {assert.equal(result.installed,true);assert.equal(await readlink(ops.link),f.launcher);}
  });
}

test('first launch installs the command link when no owner marker exists',async t=>{
  const f=await fixture(t);
  assert.equal((await f.ops.verifyOnLaunch()).installed,true);
  assert.equal(await readlink(f.ops.link),f.launcher);
  assert.match(await readFile(join(f.home,'.profile'),'utf8'),/# Faravan command path/);
});

test('first macOS zsh launch installs faravan for the next terminal',async t=>{
  const f=await fixture(t),zdotdir=join(f.root,'zsh-config');
  await mkdir(zdotdir);
  await writeFile(join(zdotdir,'.zshrc'),'# user zshrc\n');
  await writeFile(join(zdotdir,'.zprofile'),'# user zprofile\n');
  const zsh=join(f.root,'zsh');
  await writeFile(zsh,'#!/bin/sh\n[ ! -f "$ZDOTDIR/.zprofile" ] || . "$ZDOTDIR/.zprofile"\nprintf \'%s\\n%s\\n%s\\n\' FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END\n',{mode:0o755});
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'darwin',env:{...f.env,SHELL:zsh,ZDOTDIR:zdotdir}});
  const result=await ops.verifyOnLaunch();
  assert.equal(result.installed,true);
  assert.equal(await readlink(ops.link),f.launcher);
  assert.match(await readFile(join(zdotdir,'.zshrc'),'utf8'),/# Faravan command path/);
  assert.match(await readFile(join(zdotdir,'.zprofile'),'utf8'),/# Faravan command path/);
});

test('first zsh launch follows ZDOTDIR set by .zshenv',async t=>{
  const f=await fixture(t),zdotdir=join(f.home,'.config','zsh');
  await mkdir(zdotdir,{recursive:true});
  await writeFile(join(f.home,'.zshenv'),'export ZDOTDIR="$HOME/.config/zsh"\n');
  const found=spawnSync('/bin/sh',['-c','command -v zsh'],{encoding:'utf8'});
  let shell=found.status===0?found.stdout.trim():null;
  if(!shell) {
    shell=join(f.root,'zsh');
    await writeFile(shell,'#!/bin/sh\n[ ! -f "$HOME/.zshenv" ] || . "$HOME/.zshenv"\nprofile_dir=${ZDOTDIR:-$HOME}\n[ ! -f "$profile_dir/.zprofile" ] || . "$profile_dir/.zprofile"\nprintf \'%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n\' FARAVAN-PATH-BEGIN "$PATH" FARAVAN-PATH-END FARAVAN-ZDOTDIR-BEGIN "$profile_dir" FARAVAN-ZDOTDIR-END\n',{mode:0o755});
  }
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'darwin',env:{HOME:f.home,PATH:f.other,SHELL:shell}});
  const result=await ops.verifyOnLaunch();
  assert.equal(result.installed,true,JSON.stringify(result));
  assert.deepEqual(result.profiles,[join(zdotdir,'.zshrc'),join(zdotdir,'.zprofile')]);
  assert.match(await readFile(join(zdotdir,'.zshrc'),'utf8'),/# Faravan command path/);
  assert.match(await readFile(join(zdotdir,'.zprofile'),'utf8'),/# Faravan command path/);
  await assert.rejects(readFile(join(f.home,'.zshrc')),{code:'ENOENT'});
  await ops.uninstall();
  assert.doesNotMatch(await readFile(join(zdotdir,'.zshrc'),'utf8'),/# Faravan command path/);
  assert.doesNotMatch(await readFile(join(zdotdir,'.zprofile'),'utf8'),/# Faravan command path/);
});

test('launch repairs a marked missing link',async t=>{
  const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed');
  await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});
  await writeFile(marker,ownership(f));
  assert.equal((await f.ops.verifyOnLaunch()).installed,true);
  assert.equal(await readlink(f.ops.link),f.launcher);
});

test('an existing managed block is idempotent and uninstall restores other content',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile'), original='# user content\n';
  await writeFile(profile,original);
  assert.equal((await f.ops.install()).installed,true);
  const installed=await readFile(profile,'utf8');
  await f.ops.install();
  assert.equal(await readFile(profile,'utf8'),installed);
  await f.ops.uninstall();
  assert.equal(await readFile(profile,'utf8'),original);
});

test('a dangling profile symlink is preserved',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc'), target=join(f.root,'missing-profile');
  await symlink(target,profile);
  assert.equal((await f.ops.install()).error.code,'command_path_write_failed');
  assert.equal(await readlink(profile),target);
});

test('uninstall preserves a foreign link that reaches our launcher through an alias',async t=>{
  const f=await fixture(t), alias=join(f.root,'user-alias');
  await symlink(f.launcher,alias);
  await symlink(alias,f.ops.link);
  await f.ops.uninstall();
  assert.equal(await readlink(f.ops.link),alias);
});

test('install refuses a profile created after the initial read',async t=>{
  const f=await fixture(t), profile=join(f.home,'.bashrc');
  let changed=false;
  const ops=createCommandPath({home:f.home,launcher:f.launcher,env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')},beforeMutation:async(kind,path)=>{
    if(kind==='profile-read'&&path===profile){await writeFile(profile,'# new user profile\n');changed=true;}
  }});
  const result=await ops.install();
  assert.equal(changed,true);
  assert.equal(result.error.code,'command_path_write_failed');
  assert.equal(await readFile(profile,'utf8'),'# new user profile\n');
});

test('uninstall on an unsupported platform leaves profiles and links alone',async t=>{
  const f=await fixture(t), profile=join(f.home,'.profile');
  await writeFile(profile,'# Faravan command path\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n');
  const original=await readFile(profile,'utf8');
  await symlink(f.launcher,f.ops.link);
  const ops=createCommandPath({home:f.home,launcher:f.launcher,platform:'win32',env:{HOME:f.home,PATH:f.other,SHELL:join(f.root,'bash')}});
  await assert.rejects(ops.uninstall(),{code:'command_path_unsupported_platform'});
  assert.equal(await readFile(profile,'utf8'),original);
  assert.equal(await readlink(ops.link),f.launcher);
});

test('a dangling owned link remains intact until its launcher is restored',async t=>{
  const f=await fixture(t);
  await unlink(f.launcher);
  await symlink(f.launcher,f.ops.link);
  const failed=await f.ops.install();
  assert.equal(failed.error.code,'launcher_missing');
  assert.equal(await readlink(f.ops.link),f.launcher);
  await writeFile(f.launcher,'#!/bin/sh\n',{mode:0o755});
  assert.equal((await f.ops.install()).installed,true);
  assert.equal(await readlink(f.ops.link),f.launcher);
});

for(const operation of ['install','uninstall']) {
  test(`${operation} preserves a marker symlink and its target`,async t=>{
    const f=await fixture(t), marker=join(f.home,'.local/share/Faravan','command-path-installed'), target=join(f.root,'marker-target');
    await mkdir(join(f.home,'.local/share/Faravan'),{recursive:true});
    await writeFile(target,ownership(f));
    await symlink(target,marker);
    await f.ops[operation]();
    assert.equal(await readlink(marker),target);
    assert.equal(await readFile(target,'utf8'),ownership(f));
  });
}
