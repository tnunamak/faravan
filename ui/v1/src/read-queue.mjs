import {displayVisible} from './display-visibility.mjs';
// One queue per shell resource. Reads never overlap. Background loads start at least five seconds
// apart (longer after a slow read); a person's own action (`force`) never waits for that spacing.
// `run(signal)` reports 'ok', 'failed' (retried here with doubling delays) or 'cancelled'; `load` resolves with it.
export function createReadQueue(run,{minInterval=5000,maxInterval=30000,whileHidden=false}={}) {
  let running=null,followUp=null,followUpForce=false,waiting=null,retryTimer=null,controller=null;
  let nextAt=0,attempt=0,stopped=false;
  function start() {
    clearTimeout(retryTimer);retryTimer=null;
    controller=new AbortController();const started=Date.now();
    running=(async()=>{
      let outcome;
      try {outcome=await run(controller.signal);} catch {outcome='failed';}
      const elapsed=Date.now()-started;
      let retryAt=0;
      if(outcome==='ok')attempt=0;
      else if(outcome==='failed'&&!stopped) {
        const retryDelay=Math.min(maxInterval,Math.max(2*elapsed,minInterval*2**attempt));
        retryAt=Date.now()+retryDelay;
        retryTimer=setTimeout(()=>{retryTimer=null;load();},retryDelay);
        attempt++;
      }
      nextAt=Math.max(retryAt,started+Math.min(maxInterval,Math.max(minInterval,2*elapsed)));
      return outcome;
    })().finally(()=>{running=null;});
    return running;
  }
  function load({force=false}={}) {
    if(stopped||!force&&!whileHidden&&!displayVisible())return Promise.resolve('cancelled');
    if(running) {
      followUpForce ||= force;
      return followUp ||= running.then(()=>{const again={force:followUpForce};followUp=null;followUpForce=false;return load(again);});
    }
    if(waiting&&!force)return waiting.promise;
    if(waiting) {
      const {resolve,timer}=waiting;waiting=null;clearTimeout(timer);
      const result=start();resolve(result);return result;
    }
    const wait=force?0:Math.max(0,nextAt-Date.now());
    if(!wait)return start();
    let resolve;const promise=new Promise(done=>{resolve=done;});
    waiting={promise,resolve,timer:setTimeout(()=>{waiting=null;resolve(load());},wait)};
    return promise;
  }
  const visible=()=>{if(displayVisible())queueMicrotask(()=>{if(!stopped&&!running)load({force:true});});};
  globalThis.document?.addEventListener('visibilitychange',visible);
  function stop() {
    globalThis.document?.removeEventListener('visibilitychange',visible);
    stopped=true;clearTimeout(retryTimer);retryTimer=null;
    if(waiting){clearTimeout(waiting.timer);waiting.resolve();waiting=null;}
    controller?.abort();
  }
  return {load,stop};
}
