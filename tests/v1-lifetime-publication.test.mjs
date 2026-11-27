import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {durableWriteAsync} from '../lib/durable-write.mjs';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import fs from 'node:fs';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('a refused attempt cannot publish a settings replacement parked after its private write',async()=>{
  const owner=new AppLifetime(),scope=owner.register('Quit attempt','producer',{provisional:true});
  const entered=gate(),resume=gate(),log=[];
  const handle={writeFile:async()=>{},chmod:async()=>{},sync:async()=>{},close:async()=>{entered.resolve();await resume.promise;}};
  const io={mkdir:async()=>{},open:async()=>handle,renameSync:()=>{log.push('published');},unlink:async()=>{log.push('discarded');}};
  const work=scope.run(()=>durableWriteAsync('/synthetic/settings','{}',{io,publish:replace=>scope.commit(replace)}));
  const rejected=assert.rejects(work,{code:'app_closing'});
  await entered.promise;scope.cancel();resume.resolve();await rejected;
  assert.deepEqual(log,['discarded']);
  const ordinary=owner.register('ordinary','producer');assert.equal(await ordinary.run(()=>42),42);
});

test('settings replacement checks its owner at the actual filesystem publication boundary',async t=>{
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  let settingsWrites=Promise.resolve();'),end=source.indexOf('  const counterStore=',start);
  assert.ok(start>0&&end>start);
  const directory=await mkdtemp(join(tmpdir(),'settings-publication-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const action of ['refuse','stop']) {
    const file=join(directory,action+'.json');await writeFile(file,'{"intent":"on"}');
    const owner=new AppLifetime(),scope=owner.register('Quit attempt','producer',{provisional:true});
    const entered=gate(),resume=gate();
    const pause=async()=>{entered.resolve();await resume.promise;};
    const io={...fs.promises,rename:async(...args)=>{await pause();return fs.promises.rename(...args);}};
    const context={lifetime:owner,settingsFile:file,settings:{intent:'off'},atomic:(path,value,options)=>durableWriteAsync(path,JSON.stringify(value),{
      ...options,io,...(options.publish?{publish:async replace=>{await pause();return options.publish(replace);}}:{})})};
    const save=runInNewContext(source.slice(start,end)+'\nsave;',context);
    const result=save(undefined,scope).then(()=>null,error=>error);
    await entered.promise;
    const stopped=action==='stop'?owner.stop('quit'):null;
    if(action==='refuse')scope.cancel();
    resume.resolve();const error=await result;if(stopped)await stopped;
    assert.equal(await readFile(file,'utf8'),'{"intent":"on"}',action+' cannot replace canonical settings after its fence closes');
    assert.equal(error?.code,'app_closing');
    assert.deepEqual((await readdir(directory)).filter(name=>name.endsWith('.tmp')),[]);
  }
});
