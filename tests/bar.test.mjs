import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runBar, testCheck, ownerOfflineCheck, main, createRows, repositoryName, trunkHead, candidateCheck} from '../scripts/bar.mjs';

test('private head lookup targets the configured branch', async()=>{
  const sha='a'.repeat(40), ref='refs/heads/fixture/private-branch';
  const run=async(command,args)=>{
    assert.equal(command,'git');
    assert.deepEqual(args,['ls-remote','origin',ref]);
    return {stdout:sha+'\t'+ref+'\n'};
  };
  assert.equal(await trunkHead({run,branch:'fixture/private-branch'}),sha);
});

test('R1 compares the signed private head, not public export, and checks file sizes', async()=>{
  const privateHead='a'.repeat(40);
  const manifest={sourceSha:'b'.repeat(40),privateHead,tarball:'https://example.invalid/signed.tar.gz',size:4,
    assets:[{platform:'darwin',url:'https://example.invalid/app.zip',size:8}],deb:{file:'signed.deb',size:6}};
  const checked=[];
  const deps={read:async()=>manifest,head:async()=>privateHead,headFile:async(url,options)=>{
    assert.equal(options.method,'HEAD');checked.push(url.pathname);
    const size={'/signed.tar.gz':4,'/app.zip':8,'/signed.deb':6}[url.pathname];
    return new Response(null,{headers:{'content-length':String(size)}});
  }};
  assert.equal((await candidateCheck(deps)).pass,true);
  assert.deepEqual(checked,['/signed.tar.gz','/app.zip','/signed.deb']);
  assert.equal((await candidateCheck({...deps,read:async()=>({...manifest,privateHead:'c'.repeat(40)})})).pass,false);
  assert.deepEqual(await candidateCheck({...deps,read:async()=>({...manifest,privateHead:undefined})}),
    {pass:false,reason:'candidate lacks signed privateHead'});
  await assert.rejects(candidateCheck({...deps,headFile:async()=>new Response(null,{headers:{'content-length':'0'}})}),/size differs/);
});


test('hosted checks follow the origin repository through the public move',async()=>{
  for(const remote of ['git@github.com:tnunamak/faravan.git','https://github.com/tnunamak/faravan.git','ssh://git@github.com/tnunamak/faravan.git']) {
    const run=async(command,args)=>{
      assert.equal(command,'git');assert.deepEqual(args,['remote','get-url','origin']);
      return {stdout:remote+'\n'};
    };
    assert.equal(await repositoryName(run),'tnunamak/faravan');
  }
  await assert.rejects(repositoryName(async()=>({stdout:'/local/repo'})),/GitHub origin/);
});

test('R7 requires tests and the real member-home path and names both outcomes',async()=>{
  let timeout,realCalls=0;
  const run=async(command,args,options)=>{timeout=options.timeout;return {stdout:'# pass 16\n# fail 0\n# skipped 0\n# cancelled 0\n'};};
  const real=async()=>{realCalls++;return {pass:false,reason:'real: 0 finished jobs sent to a member\'s address since release'};};
  const result=await ownerOfflineCheck({run,real})();
  assert.equal(timeout,900_000);assert.equal(realCalls,1);assert.equal(result.pass,false);
  assert.match(result.reason,/tests: 16 passed.*; real: 0 finished/);
  assert.equal((await ownerOfflineCheck({run,real:async()=>({pass:true,reason:'real: 1 finished'})})()).pass,true);
  const failed=await ownerOfflineCheck({run:async()=>{throw Object.assign(Error('tests failed'),{stdout:'# fail 2\n'});},real:async()=>({pass:true,reason:'real: 1 finished'})})();
  assert.equal(failed.pass,false);assert.match(failed.reason,/tests:.*2 failed.*; real: 1 finished/);
});

const fakeRows = pass => Array.from({length:9}, (_, i) => ({id:`R${i+1}`, userCan:'do something', check:async()=>({pass,reason:'live'})}));
test('a missing test fails as not built even when a saved result says pass', async t => {
  const root=await mkdtemp(join(tmpdir(),'bar-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'test-artifacts/bar'),{recursive:true});
  await writeFile(join(root,'test-artifacts/bar/multi-account.json'),JSON.stringify({passed:100,pass:true}));
  const rows=await runBar([{id:'R4',userCan:'lend',check:testCheck(['missing.test.mjs'],{cwd:root})}]);
  assert.deepEqual(rows[0],{id:'R4',userCan:'lend',pass:false,reason:'not built: missing.test.mjs'});
  const source=await readFile(new URL('../scripts/bar.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/readFile|test-artifacts|receipt/);
});
test('throwing checks fail and do not hide other rows', async()=>{
  const rows=fakeRows(true); rows[0].check=async()=>{throw Error('offline');};
  const results=await runBar(rows);
  assert.equal(results.length,9); assert.equal(results[0].pass,false); assert.equal(results[0].reason,'offline');
});
test('exit is zero only when every selected row passes; JSON has the same rows',async()=>{
  let text=''; const stdout={write:value=>{text+=value;}};
  assert.equal(await main([],{rows:fakeRows(false),stdout}),1);
  assert.equal(await main(['--json'],{rows:fakeRows(true),stdout:{write:value=>{text=value;}}}),0);
  assert.equal(JSON.parse(text).length,9);
});
test('--row runs only the requested check and rejects unknown rows',async()=>{
  const calls=[]; const rows=fakeRows(true).map(row=>({...row,check:async()=>{calls.push(row.id);return {pass:true,reason:'now'};}}));
  assert.equal(await main(['--row','R4'],{rows,stdout:{write(){}}}),0);
  assert.deepEqual(calls,['R4']);
  await assert.rejects(main(['--row','R99'],{rows}),/Unknown row/);
});
test('production rows are exactly R1 through R9',()=>{
  assert.deepEqual(createRows().map(row=>row.id),fakeRows(true).map(row=>row.id));
});
test('existing check files still need a fresh successful command with no skips',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bar-command-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'check.test.mjs'),'');
  let calls=0;
  const run=async()=>{calls++;return {stdout:'# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n'};};
  const check=testCheck(['check.test.mjs'],{cwd:root,run});
  assert.equal((await check()).pass,true);assert.equal((await check()).pass,true);assert.equal(calls,2);
  assert.equal((await testCheck(['check.test.mjs'],{cwd:root,run:async()=>({stdout:'# pass 2\n# skipped 1\n'})})()).pass,false);
  const [result]=await runBar([{id:'R4',check:testCheck(['check.test.mjs'],{cwd:root,run:async()=>{throw Error('command failed');}})}]);
  assert.equal(result.pass,false);
});
