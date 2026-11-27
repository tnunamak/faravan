import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPhoneAccess} from '../lib/v1/phone-access.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};

test('a config write released after close cannot reopen the phone listener',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'faravan-phone-close-'));
  const entered=gate(),release=gate();
  let closed=false,writeCalls=0,ownerWork,closeWork;
  const listens=[],changes=[];
  const phone=createPhoneAccess({
    directory,now:()=>1000,
    sessions:{instance:'synthetic',list:()=>[],room:()=>10},
    inbox:async()=>[],answer:async()=>{},
    interfaces:()=>({synthetic:[{address:'10.23.50.10',family:'IPv4',internal:false}]}),
    tailscale:{
      self:async()=>null,served:async()=>null,
      serve:async()=>{throw Error('unexpected Tailscale operation');},unserve:async()=>{},
    },
    onChange:value=>changes.push({afterClose:closed,value}),
    // Injection-only production seams included in this patch.
    writeConfig:async()=>{
      if(++writeCalls===1){entered.resolve();await release.promise;}
    },
    httpServer:()=>{
      const server=new EventEmitter();
      let port=0;
      server.listen=(requested,host)=>{
        port=requested||42424;
        listens.push({afterClose:closed,host,port});
        queueMicrotask(()=>server.emit('listening'));
        return server;
      };
      server.address=()=>({port,address:'10.23.50.10',family:'IPv4'});
      server.close=callback=>{queueMicrotask(()=>callback?.());return server;};
      server.closeAllConnections=()=>{};
      return server;
    },
  });
  t.after(async()=>{
    release.resolve();
    await ownerWork;await closeWork;
    await phone.close();
    await rm(directory,{recursive:true,force:true});
  });
  // No real start()/socket: default disabled state is enough to reach the owner write.
  ownerWork=phone.owner({method:'POST',parts:['settings'],browserSession:true,
    input:{enabled:true,address:'10.23.50.10'}}).then(
      value=>({value}),error=>({error}),
    );
  await entered.promise;
  closeWork=phone.close().then(()=>{closed=true;});
  // Base close completes through a finite promise chain here. A fixed close may
  // instead wait for the owner write; release it in either case, without deadlock.
  await flush();
  release.resolve();
  await Promise.all([ownerWork,closeWork]);
  await flush();
  assert.equal(closed,true);
  assert.deepEqual({
    listensAfterClose:listens.filter(item=>item.afterClose).length,
    changesAfterClose:changes.filter(item=>item.afterClose).length,
    origin:phone.origin,
  },{listensAfterClose:0,changesAfterClose:0,origin:null},
  'completed close is terminal even if an earlier settings write finishes later');
});
