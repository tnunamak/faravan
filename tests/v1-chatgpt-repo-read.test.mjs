import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectRepo} from '../lib/v1/repo-source.mjs';
import {withIsolatedGitRead} from '../lib/git-source-status.mjs';
const exec=promisify(execFile);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
test('repository inspection never runs fsmonitor or clean filters from included config',async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-repo-inspect-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>exec('git',['-C',root,...args]);
  await git('init','--quiet');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(join(root,'file.txt'),'before');await writeFile(join(root,'.gitattributes'),'file.txt filter=hostile\n');
  await git('add','.');await git('-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
  const filterMarker=join(root,'filter-ran'),monitorMarker=join(root,'monitor-ran'),include=join(root,'included-config');
  await writeFile(include,'[filter "hostile"]\n\tclean = "touch '+filterMarker+'; cat"\n\trequired = true\n');
  await git('config','include.path',include);
  await git('config','core.fsmonitor','touch '+quote(monitorMarker)+'; echo');
  await writeFile(join(root,'file.txt'),'after');
  const result=await inspectRepo(root);assert.ok(result.changed_count>0);
  await assert.rejects(access(filterMarker),'included clean filters must not run');
  await assert.rejects(access(monitorMarker),'fsmonitor must not run');
});

test('isolated ChatGPT read preserves callback/abort errors and closes capabilities', async t=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-chatgpt-read-errors-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>exec('git',['-C',root,...args]);
  await git('init','--quiet');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
  await writeFile(join(root,'binary.bin'),Buffer.from([0,255,128,10]));
  await git('add','.');await git('-c','commit.gpgsign=false','commit','--quiet','-m','fixture');
  let retained;
  const original=new Error('original synthetic callback failure');
  await assert.rejects(withIsolatedGitRead(root,async read=>{
    retained=read;
    const metadata=await read.packaging();
    const {stdout:expected}=await exec('git',['-C',root,'archive','--format=tar',metadata.commit],{encoding:'buffer'});
    assert.deepEqual(await read.archive(),expected,'bounded archive capability returns exact binary tar bytes');
    throw original;
  }),error=>error===original);
  await assert.rejects(retained.archive(),/closed/);
  const controller=new AbortController(),reason=new Error('original synthetic abort');
  await assert.rejects(withIsolatedGitRead(root,async read=>{
    controller.abort(reason);
    await read.archive();
  },{signal:controller.signal}),error=>error===reason);
  await assert.rejects(withIsolatedGitRead(root,()=>assert.fail('pre-aborted callback ran'),
    {signal:AbortSignal.abort(reason)}),error=>error===reason);
});
