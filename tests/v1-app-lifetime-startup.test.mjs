import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {AppLifetime} from '../lib/v1/app-lifetime.mjs';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

// Fault each registration in real startApp, including those before its old startup try.
test('each partial startup unwinds through stop and preserves its original error',async t=>{
  for(const target of ['circle transport','profile admission','app lock','HTTP admission','lending loop','browser sessions','phone listener','price refresh','disk sweep','data cleanup','telemetry','settings','app work','lending probe','updater'])await t.test(target,async t=>{
    const f=await appFixture(t),original=new Error('synthetic acquisition failure'),entries=[],released=[],sealed=[];
    const register=AppLifetime.prototype.register;
    t.mock.method(AppLifetime.prototype,'register',function(name,phase,hooks={}) {
      entries.push({name,phase});
      const handle=register.call(this,name,phase,{...hooks,
        seal:context=>{sealed.push(name);return hooks.seal?.(context);},
        release:context=>{released.push(name);return hooks.release?.(context);}});
      if(name===target)throw original;
      return handle;
    });
    await assert.rejects(f.start('partial'),error=>error===original);
    const expected=['producer','consumer','lock'].flatMap(phase=>entries.filter(row=>row.phase===phase).reverse().map(row=>row.name));
    assert.deepEqual(released,expected,'reverse acquisition within producer/consumer/lock order');
    assert.deepEqual(sealed,entries.map(row=>row.name).reverse(),'each acquired registration sealed once');
    t.mock.restoreAll();
    const restarted=await f.start('partial');
    assert.ok(await api(restarted.app,'/api/status'),'a failed start left no live lock or listener');
  });
});

test('real asynchronous acquisition failures unwind resources and permit a clean retry',async t=>{
  for(const stage of ['sessions','settings','backend','listener','update restore'])await t.test(stage,async t=>{
    const f=await appFixture(t),home=await f.home('failed'),directory=join(home,'v1');
    const original=new Error('synthetic '+stage),entries=[],released=[];
    let damaged,blocker;
    const extra={};
    if(stage==='sessions'||stage==='settings'){
      await mkdir(directory,{recursive:true});damaged=join(directory,stage==='sessions'?'sessions.json':'app-settings.json');
      if(stage==='sessions')await mkdir(damaged);else await writeFile(damaged,'{invalid json');
    }
    if(stage==='backend')extra.backendFactory=async()=>{throw original;};
    if(stage==='update restore')extra.updater={status:async()=>{throw original;}};
    if(stage==='listener'){
      blocker=createServer();blocker.listen(0,'127.0.0.1');await once(blocker,'listening');extra.port=blocker.address().port;
      t.after(()=>new Promise(done=>blocker.close(done)));
    }
    const register=AppLifetime.prototype.register;
    t.mock.method(AppLifetime.prototype,'register',function(name,phase,hooks={}){
      entries.push({name,phase});return register.call(this,name,phase,{...hooks,release:context=>{released.push(name);return hooks.release?.(context);}});
    });
    await assert.rejects(f.start('failed',extra),error=>stage==='backend'||stage==='update restore'?error===original:stage==='listener'?error.code==='EADDRINUSE':stage==='sessions'?error.code==='EISDIR':error instanceof SyntaxError);
    assert.deepEqual(released,['producer','consumer','lock'].flatMap(phase=>entries.filter(row=>row.phase===phase).reverse().map(row=>row.name)));
    t.mock.restoreAll();if(damaged)await rm(damaged,{recursive:true});
    const restarted=await f.start('failed');assert.ok(await api(restarted.app,'/api/status'));
  });
});
