import { spawn as spawnProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGED_BINARY=fileURLToPath(new URL('../../clawmeter',import.meta.url));
const MAX_STDOUT=1024*1024, TIMEOUT_MS=10000, CACHE_MS=60000, FRESH_MS=300000;
const executable=path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}};

function reading(text) {
  const usage=JSON.parse(text)?.providers?.claude?.usage;
  const window=usage?.windows?.find(row=>row?.name==='7d All');
  const observedAt=Date.parse(usage?.fetched_at),resetsAt=Date.parse(window?.resets_at);
  if(!Number.isFinite(window?.utilization)||!Number.isFinite(observedAt)||!Number.isFinite(resetsAt))return null;
  return {provider:'claude',remaining:Math.max(0,Math.min(100,100-window.utilization)),observedAt,resetsAt};
}

/** The whole week's allowance as last read: `remaining` percent and when it was checked.
 * Null when the reading is unknown, older than five minutes, from the future or past its reset.
 * It is never a share of one job, which Faravan cannot measure.
 */
export function weekAllowance(quota,at=Date.now()) {
  if(quota?.provider!=='claude'||!Number.isFinite(at)||
     !Number.isFinite(quota.remaining)||quota.remaining<0||quota.remaining>100||
     !Number.isFinite(quota.observedAt)||!Number.isFinite(quota.resetsAt)||
     quota.observedAt>at||at-quota.observedAt>=FRESH_MS||quota.resetsAt<=at)return null;
  return {remaining:quota.remaining,checked_at:new Date(quota.observedAt).toISOString()};
}

// Only clawmeter accesses credentials. Its diagnostics never enter app logs or state.
export function createQuotaReader({spawn=spawnProcess,env=process.env,isExecutable=executable,
  now=Date.now,schedule=setTimeout,unschedule=clearTimeout}={}) {
  let cached=null,cachedAt=-Infinity,pending;
  function run() {
    return new Promise(resolve=>{
      let child,timer,done=false,size=0;
      const chunks=[];
      const finish=value=>{
        if(done)return;
        done=true;unschedule(timer);chunks.length=0;resolve(value);
      };
      const stop=()=>{finish(null);try{child?.kill('SIGKILL');}catch{}};
      try {
        const binary=env.FARAVAN_CLAWMETER|| (isExecutable(PACKAGED_BINARY)?PACKAGED_BINARY:'clawmeter');
        child=spawn(binary,['status','--json','--provider','claude'],
          {shell:false,stdio:['ignore','pipe','ignore'],timeout:TIMEOUT_MS,killSignal:'SIGKILL'});
        child.on('error',()=>finish(null));
        child.stdout.on('error',stop);
        child.stdout.on('data',chunk=>{
          if(done)return;
          try {
            const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
            size+=bytes.length;
            if(size>MAX_STDOUT){stop();return;}
            chunks.push(bytes);
          }catch{stop();}
        });
        child.on('close',(code,signal)=>{
          if(done)return;
          if(code!==0||signal){finish(null);return;}
          try{finish(reading(Buffer.concat(chunks).toString('utf8')));}catch{finish(null);}
        });
        // Also settle promptly when a child never emits close after termination.
        timer=schedule(stop,TIMEOUT_MS);
      }catch{stop();}
    });
  }
  return async function readQuota() {
    try {
      if(pending)return await pending;
      const age=now()-cachedAt;
      if(age>=0&&age<CACHE_MS)return cached&&{...cached};
      pending=run().then(value=>{cached=value;cachedAt=now();return value;});
      try{const value=await pending;return value&&{...value};}finally{pending=undefined;}
    }catch{return null;}
  };
}
