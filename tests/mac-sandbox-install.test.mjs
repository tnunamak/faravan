import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, access, utimes, readdir, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createMacSandboxInstaller,macSandboxArch} from '../lib/mac-sandbox-install.mjs';

const bytes=Buffer.from('official complete bundle archive');
const release={version:'0.54.1',url:'https://docker.test/archive',sha256:createHash('sha256').update(bytes).digest('hex'),teamId:'9BNSXJN65R'};
async function fixture(t,options={}) {
  const home=await mkdtemp(join(tmpdir(),'mac-install-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const calls=[];
  let external=false,wrongTeam=false,partial=false,badHash=false,failStart=false;
  const run=async(command,args)=>{
    calls.push([command,args]);
    if(command==='sbx') {if(!external)throw Error('missing');return 'Client Version: v0.54.1';}
    if(command==='/usr/bin/tar') {
      const directory=args[args.indexOf('-C')+1];
      await mkdir(join(directory,'Sbx.app/Contents/MacOS'),{recursive:true});
      await mkdir(join(directory,'Sbx.app/Contents/Helpers'),{recursive:true});
      await writeFile(join(directory,'Sbx.app/Contents/Helpers/guest-kernel'),'helper');
      await writeFile(join(directory,'Sbx.app/Contents/MacOS/sbx'),'binary');return '';
    }
    if(command==='/usr/bin/codesign') {if(wrongTeam)throw Error('wrong signing team');return '';}
    await access(command);if(failStart)throw Error('could not start');return 'Client Version: v0.54.1';
  };
  const download=async(_url,file,progress)=>{
    progress(12,bytes.length);
    await writeFile(file,badHash?Buffer.from('wrong archive'):bytes);
    if(partial)throw Error('connection closed');
  };
  const installer=createMacSandboxInstaller({home,platform:'darwin',arch:'arm64',release,run,download,...options});
  return {home,calls,installer,run,download,set:values=>{external=values.external??external;wrongTeam=values.wrongTeam??wrongTeam;partial=values.partial??partial;badHash=values.badHash??badHash;failStart=values.failStart??failStart;}};
}
test('hash mismatch never unpacks or runs the archive',async t=>{
  const f=await fixture(t);f.set({badHash:true});
  await assert.rejects(f.installer.install(),/download could not be verified/);
  assert.equal(f.calls.some(([command])=>command==='/usr/bin/tar'),false);
  assert.equal(f.installer.status().phase,'failed');
});
test('wrong signature team never selects an executable',async t=>{
  const f=await fixture(t);f.set({wrongTeam:true});
  await assert.rejects(f.installer.install(),/signature/);
  assert.equal(f.installer.status().executable,undefined);
  const args=f.calls.find(([command])=>command==='/usr/bin/codesign')[1];
  assert.deepEqual(args,['--verify','--deep','--strict',
    '-R=anchor apple generic and certificate leaf[subject.OU] = "9BNSXJN65R"',args.at(-1)]);
  assert.ok(args.at(-1).endsWith('/unpacked/Sbx.app'));
});
test('partial download fails, retry succeeds and preserves the whole bundle',async t=>{
  const f=await fixture(t);f.set({partial:true});
  await assert.rejects(f.installer.install(),/download/);
  f.set({partial:false});
  const result=await f.installer.install();
  assert.equal(result.phase,'installed');assert.ok(result.executable.startsWith(f.home));
  await access(result.executable);
  await access(join(result.executable,'../../Helpers/guest-kernel'));
  const count=f.calls.filter(([command])=>command==='/usr/bin/tar').length;
  assert.equal((await f.installer.install()).executable,result.executable);
  assert.equal(f.calls.filter(([command])=>command==='/usr/bin/tar').length,count);
});
test('a supported installed runtime needs no download',async t=>{
  const f=await fixture(t,{resolveExecutable:()=>'/opt/homebrew/bin/sbx'});f.set({external:true});
  assert.equal((await f.installer.install()).executable,'/opt/homebrew/bin/sbx');
  assert.equal(f.calls.some(([command])=>command==='/usr/bin/tar'),false);
});
test('unsupported Linux install does not download a Mac bundle',async t=>{
  const f=await fixture(t,{platform:'linux'});
  await assert.rejects(f.installer.install(),/Mac/);
});
test('Homebrew is detected even when the graphical app PATH omits it',async t=>{
  const f=await fixture(t,{run:async command=>{if(command==='/opt/homebrew/bin/sbx')return 'Client Version: v0.54.1';throw Error('missing');},resolveExecutable:command=>command});
  assert.equal((await f.installer.install()).executable,'/opt/homebrew/bin/sbx');
});
test('a supported client is reused even when its daemon has not started',async t=>{
  const f=await fixture(t,{run:async()=>{throw Object.assign(Error('no daemon'),{stdout:'Client Version: v0.54.1',stderr:'Server is not running'});},resolveExecutable:()=>'/opt/homebrew/bin/sbx'});
  assert.equal((await f.installer.install()).executable,'/opt/homebrew/bin/sbx');
});
test('a published bundle that cannot start is removed and can be retried',async t=>{
  const f=await fixture(t);f.set({failStart:true});
  await assert.rejects(f.installer.install(),/Retry the installation/);
  await assert.rejects(access(join(f.home,'sandbox-runtime/0.54.1')));
  f.set({failStart:false});
  const first=f.installer.install(),second=f.installer.install();
  assert.equal(first,second,'concurrent clicks join the download');
  assert.equal((await first).phase,'installed');
});

test('a broken pinned folder and stale staging are recovered without touching outside data',async t=>{
  const f=await fixture(t),root=join(f.home,'sandbox-runtime');
  await mkdir(join(root,release.version),{recursive:true});
  await writeFile(join(root,release.version,'partial'),'unfinished');
  await mkdir(join(root,'.install-old'));await utimes(join(root,'.install-old'),new Date(0),new Date(0));
  await mkdir(join(root,'.install-recent'));
  const outside=join(f.home,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'mine');
  await symlink(outside,join(root,'.install-link'));await utimes(join(root,'.install-link'),new Date(0),new Date(0));
  assert.equal((await f.installer.install()).phase,'installed');
  assert.deepEqual((await readdir(root)).sort(),['.install-link','.install-recent',release.version].sort());
  await access(join(outside,'keep'));
});
test('old version folders are removed only after the new bundle starts',async t=>{
  const f=await fixture(t),root=join(f.home,'sandbox-runtime');
  await mkdir(join(root,'0.53.0'),{recursive:true});await mkdir(join(root,'notes'));
  f.set({failStart:true});await assert.rejects(f.installer.install());
  await access(join(root,'0.53.0'));
  f.set({failStart:false});await f.installer.install();
  await assert.rejects(access(join(root,'0.53.0')));await access(join(root,'notes'));
});
test('unexpected unpack errors use a plain installer message',async t=>{
  const f=await fixture(t,{run:async command=>{if(command==='/usr/bin/tar')throw Error('EACCES /private/path');throw Error('missing');}});
  await assert.rejects(f.installer.install(),/The sandbox installation did not finish. Retry installation./);
  assert.doesNotMatch(f.installer.status().message,/EACCES|private/);
});
for(const mode of ['slow','idle','early','large'])test('download '+mode+' keeps the idle limit and size checks',async t=>{
  const f=await fixture(t,{download:undefined});
  t.mock.timers.enable({apis:['setTimeout']});
  let fetched,downloadSignal;
  const started=new Promise(resolve=>{fetched=resolve;});
  t.mock.method(globalThis,'fetch',async(_url,{signal})=>{
    downloadSignal=signal;fetched();
    if(mode==='idle')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return {ok:true,headers:new Headers({'content-length':String(mode==='early'?bytes.length+1:bytes.length)}),body:(async function*(){
      if(mode==='large'){yield {length:513*1024*1024};return;}
      for(const byte of bytes){t.mock.timers.tick(50000);signal.throwIfAborted();yield Buffer.from([byte]);}
    })()};
  });
  const pending=f.installer.install();
  const result=mode==='slow'?pending:assert.rejects(pending,/download did not finish/);
  await started;
  if(mode==='idle'){
    t.mock.timers.tick(60000);
    const aborted=downloadSignal.aborted;
    if(!aborted)await f.installer.cancel();await result;
    assert.equal(aborted,true,'60 seconds without bytes aborts the download');return;
  }
  await result;
  assert.equal(f.installer.status().phase,mode==='slow'?'installed':'failed');
});

test('another completed publication keeps its exclusive claim',async t=>{
 const f=await fixture(t);let releaseDownload,started;
 const gate=new Promise(resolve=>{releaseDownload=resolve;}),entered=new Promise(resolve=>{started=resolve;});
 const first=createMacSandboxInstaller({home:f.home,platform:'darwin',arch:'arm64',release,run:f.run,
  download:async(...args)=>{started();await gate;return f.download(...args);}});
 const pending=first.install();t.after(()=>{releaseDownload();return pending.catch(()=>{});});await entered;
 const second=await f.installer.install();releaseDownload();
 await assert.rejects(pending,/installation did not finish/);
 await access(second.executable);
});

test('a response body that stops sending bytes hits the idle limit',async t=>{
 const f=await fixture(t,{download:undefined});t.mock.timers.enable({apis:['setTimeout']});
 let stalled;const entered=new Promise(resolve=>{stalled=resolve;});
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>({ok:true,headers:new Headers(),body:(async function*(){
  yield bytes.subarray(0,1);
  await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});stalled();});
 })()}));
 const rejected=assert.rejects(f.installer.install(),/download did not finish/);
 await entered;t.mock.timers.tick(60000);await rejected;
 assert.equal(f.installer.status().phase,'failed');
});

for(const existing of [false,true])test('managed bundle with daemon off is recognised, existing='+existing,async t=>{
 const f=await fixture(t);
 if(existing)await f.installer.install();
 const installer=createMacSandboxInstaller({home:f.home,platform:'darwin',arch:'arm64',release,download:f.download,
  run:async(command,args)=>{
   if(command.endsWith('/0.54.1/Sbx.app/Contents/MacOS/sbx')) {
    await access(command);
    throw Object.assign(Error('no daemon'),{stdout:'Client Version: v0.54.1',stderr:'Server is not running'});
   }
   return f.run(command,args);
  }});
 if(existing)assert.equal(await installer.findInstalled(),join(f.home,'sandbox-runtime/0.54.1/Sbx.app/Contents/MacOS/sbx'));
 assert.equal((await installer.install()).phase,'installed');
 await access(join(f.home,'sandbox-runtime/0.54.1/Sbx.app/Contents/MacOS/sbx'));
});
test('a trickle still stops at the 60 minute total download limit',async t=>{
 const f=await fixture(t,{download:undefined});t.mock.timers.enable({apis:['setTimeout']});
 let downloadSignal;
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>{
  downloadSignal=signal;
  return {ok:true,headers:new Headers(),body:(async function*(){
   for(let i=0;i<80;i++){t.mock.timers.tick(50000);signal.throwIfAborted();yield Buffer.from('x');}
  })()};
 });
 await assert.rejects(f.installer.install(),/download did not finish/);
 assert.equal(downloadSignal.aborted,true,'the total timer stops a still active trickle');
 assert.deepEqual(await readdir(join(f.home,'sandbox-runtime')),[]);
});
test('Cancel aborts a download and removes its staging folder',async t=>{
 let entered;const started=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{download:async(_url,file,_progress,signal)=>{
  await writeFile(file,'partial');
  await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});entered();});
 }});
 const rejected=assert.rejects(f.installer.install());
 await started;await f.installer.cancel();await rejected;
 assert.equal(f.installer.status().phase,'idle');
 assert.match(f.installer.status().message,/cancelled/i);
 assert.deepEqual(await readdir(join(f.home,'sandbox-runtime')),[]);
});
for(const [output,fallback,expected] of [['1','x64','arm64'],['0','arm64','x64'],[null,'x64','x64']])
 test('Mac hardware detection uses sysctl with architecture fallback '+output,async()=>{
  const arch=await macSandboxArch({arch:fallback,run:async(command,args)=>{
   assert.equal(command,'/usr/sbin/sysctl');assert.deepEqual(args,['-n','hw.optional.arm64']);
   if(output===null)throw Error('unavailable');return output;
  }});
  assert.equal(arch,expected);
 });
