const closing = () => Object.assign(new Error('The application is closing'), {code:'app_closing',status:503});
const held = () => Object.assign(new Error('Quit is proving cessation'), {code:'app_quitting',status:409});
const phaseEnd=Object.freeze({producer:2/3,consumer:11/12,lock:1});

/** Own admission, outstanding operations and one bounded shutdown. */
export class AppLifetime {
  constructor({now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,budgetMs=60000}={}) {
    this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;this.budgetMs=budgetMs;
    this.entries=[];this.sealed=false;this.generation=0;this.stopping=null;this.holds=new Set();
  }
  // seal receives the phase's absolute deadline, measured by this owner's clock.
  register(name,phase,{seal,drain,release,provisional=false,blockedByHold=false}={}) {
    if(this.sealed)throw closing();
    if(!['producer','consumer','lock'].includes(phase))throw new TypeError('Invalid lifetime phase');
    const entry={name,phase,seal,drain,release,work:new Set(),abort:new AbortController()},generation=this.generation;
    let cancelled=false;
    if(provisional)this.holds.add(entry);
    this.entries.push(entry);
    const check=()=>{
      if(cancelled||this.sealed||generation!==this.generation)throw closing();
      if(blockedByHold&&this.holds.size)throw held();
    };
    const forget=()=>{if(cancelled&&!entry.work.size)this.entries=this.entries.filter(row=>row!==entry);};
    return {
      cancel:()=>{cancelled=true;this.holds.delete(entry);entry.abort.abort();forget();},
      run:fn=>{
        try{check();}catch(error){const rejected=Promise.reject(error);rejected.catch(()=>{});return rejected;}
        // Publish ownership before invoking code, including synchronous reentrant stop.
        let resolve,reject;
        const work=new Promise((yes,no)=>{resolve=yes;reject=no;});entry.work.add(work);
        const finished=()=>{entry.work.delete(work);forget();};
        work.then(finished,finished);
        try{Promise.resolve(fn({signal:entry.abort.signal})).then(resolve,reject);}catch(error){reject(error);}
        return work;
      },
      commit:fn=>{
        check();
        if(fn.constructor?.name==='AsyncFunction')throw new TypeError('commit must be synchronous');
        const result=fn();
        if(result?.then)throw new TypeError('commit must not return a promise');
        return result;
      },
    };
  }
  stop(reason,{startedAt=this.now()}={}) {
    if(this.stopping)return this.stopping;
    this.sealed=true;this.generation++;
    const unfinished=new Set();
    let resolve;
    this.stopping=new Promise(done=>{resolve=done;});
    // Install the shared promise before invoking a component's reentrant seal.
    for(const entry of [...this.entries].reverse()) {
      entry.abort.abort();
      try{entry.seal?.({deadline:startedAt+this.budgetMs*phaseEnd[entry.phase]});}catch{unfinished.add(entry.name);}
    }
    this.finish(reason,startedAt,unfinished).then(resolve);
    return this.stopping;
  }
  async finish(reason,started,unfinished) {
    const wait=async(entry,fn,cutoff)=>{
      const remaining=Math.max(0,started+this.budgetMs*cutoff-this.now());
      let timer;
      const expired=Symbol();
      try {
        const work=Promise.resolve().then(fn);
        const result=await Promise.race([work,new Promise(done=>{timer=this.setTimer(()=>done(expired),remaining);})]);
        if(result===expired){unfinished.add(entry.name);return;}
      }catch{unfinished.add(entry.name);}
      finally{this.clearTimer(timer);}
    };
    const entries=[...this.entries].reverse();
    for(const phase of ['producer','consumer','lock'])for(const entry of entries.filter(row=>row.phase===phase)) {
      await wait(entry,async()=>{await entry.drain?.();await Promise.allSettled([...entry.work]);},phaseEnd[phase]);
    }
    for(const phase of ['producer','consumer','lock'])for(const entry of entries.filter(row=>row.phase===phase)) {
      // An incomplete writer retains ownership until process exit. Never release its lock.
      if(phase==='lock'&&unfinished.size)continue;
      await wait(entry,()=>entry.release?.({reason,commit:fn=>{if(this.holds.size)throw held();return fn();}}),1);
    }
    return {state:unfinished.size?'interrupted':'closed',reason,unfinished:[...unfinished]};
  }
}
