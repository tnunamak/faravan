import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveHostCli} from '../lib/host-cli.mjs';

const MARKER='__FARAVAN_PATH_8f3a__';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'host-cli-'));
  const a=join(root,'a'),b=join(root,'b');
  await mkdir(a);await mkdir(b);
  await writeFile(join(a,'claude'),'#!/bin/sh\n',{mode:0o755});
  await writeFile(join(b,'not-exec'),'x',{mode:0o644});
  return {a,b};
}
const fakeShell=(...replies)=>{
  const calls=[];
  const run=async(shell,args,options)=>{calls.push({shell,args,options});const r=replies.shift();if(r instanceof Error)throw r;return r;};
  run.calls=calls;return run;
};

test('a command missing from the app PATH is found on the login shell PATH',async()=>{
  const {a}=await fixture();
  const runShell=fakeShell('junk from rc files\n'+MARKER+a+':/usr/bin'+MARKER+'\nmore junk');
  const found=await resolveHostCli('claude',{env:{PATH:'/usr/bin:/bin'},shell:'/fake/zsh',runShell,timeoutMs:50});
  assert.deepEqual(found,{path:join(a,'claude'),searchPath:a+':/usr/bin'});
  assert.equal(runShell.calls[0].shell,'/fake/zsh');
  assert.equal(runShell.calls[0].args[0],'-ilc');
  assert.equal(runShell.calls[0].options.timeoutMs,50);
});

test('a command on the app PATH never starts a shell',async()=>{
  const {a}=await fixture();
  const runShell=fakeShell();
  const found=await resolveHostCli('claude',{env:{PATH:'/nope:'+a},runShell});
  assert.deepEqual(found,{path:join(a,'claude'),searchPath:'/nope:'+a});
  assert.equal(runShell.calls.length,0);
});

test('a missing command reports provider_cli_missing with the provider',async()=>{
  const {a,b}=await fixture();
  const runShell=fakeShell(MARKER+b+MARKER);
  await assert.rejects(resolveHostCli('claude',{env:{PATH:a.replace('/a','/zz')},shell:'/fake/sh',runShell}),
    error=>error.code==='provider_cli_missing' && error.provider==='claude');
  const notExecutable=fakeShell(MARKER+b+MARKER);
  await assert.rejects(resolveHostCli('not-exec',{env:{PATH:'/nope'},shell:'/fake/other',runShell:notExecutable}),{code:'provider_cli_missing'});
});

test('a failing or silent login shell falls back to -lc once, then reports the command missing',async()=>{
  const {a}=await fixture();
  const recovered=fakeShell(new Error('timed out'),MARKER+a+MARKER);
  const found=await resolveHostCli('claude',{env:{PATH:'/nope'},shell:'/fake/bash',runShell:recovered});
  assert.equal(found.path,join(a,'claude'));
  assert.deepEqual(recovered.calls.map(c=>c.args[0]),['-ilc','-lc']);
  const failing=fakeShell(new Error('timed out'),new Error('exit 1'));
  await assert.rejects(resolveHostCli('claude',{env:{PATH:'/nope'},shell:'/fake/fish',runShell:failing}),{code:'provider_cli_missing'});
  assert.equal(failing.calls.length,2);
});

test('the login shell is read once per process',async()=>{
  const {a}=await fixture();
  await writeFile(join(a,'codex'),'#!/bin/sh\n',{mode:0o755});
  const runShell=fakeShell(MARKER+a+MARKER);
  const env={PATH:'/nope'};
  const first=await resolveHostCli('claude',{env,shell:'/fake/zsh',runShell});
  const second=await resolveHostCli('codex',{env,shell:'/fake/zsh',runShell});
  assert.equal(first.path,join(a,'claude'));assert.equal(second.path,join(a,'codex'));
  assert.equal(runShell.calls.length,1);
});

test('the default shell runner reads a real login shell with stdin closed',{skip:process.platform==='win32'},async()=>{
  const {a}=await fixture();
  const shell=join(a,'fake-shell');
  await writeFile(shell,'#!/bin/sh\necho noisy rc output\nprintf "%s" "'+MARKER+a+MARKER+'"\n',{mode:0o755});
  const found=await resolveHostCli('claude',{env:{PATH:'/nope'},shell});
  assert.equal(found.path,join(a,'claude'));
});
