/** One lending pool, two authorities (owner-offline topology). A device that serves its own recorded
 *  member origin lends from two stores with one pool, one account slot model and one budget:
 *    - ordinary work belongs to the incumbent authority (the circle host);
 *    - work that names this device as its designated member belongs to the device's own member store.
 *  This client is the lender's one `client`. It never decides who may dispatch (each store's own fence
 *  does that); it keeps each job's selected authority attached through claim, renew, start, result,
 *  cancellation, stop and restart recovery, so no operation on an attempt reaches another store, and no
 *  store's outage makes an operation switch stores.
 *
 *  Discovery reads both stores independently: an incumbent outage never stalls designated discovery,
 *  and a member outage never stalls ordinary discovery. The route for a job is its authority, written
 *  durably before its claim is sent, so a restart resolves the same store for the uncertain claim,
 *  renewals, the result, a stop and the release. An attempt with no saved route is an incumbent claim
 *  (claim-next is incumbent-only), the one authority that never needs a saved route. */
const SOURCES=['member','incumbent'];
const MAX_ROUTES=500;
const artifactDigests=job=>[job?.prompt?.digest,job?.source?.artifact?.digest].filter(Boolean);

export function createAuthorityClient({ownKeyId,incumbent,member,routes,outageMs=2000,backoffMs=2000,now=Date.now}={}) {
  if(typeof incumbent!=='function'||typeof member!=='function'||!routes)throw new TypeError('authority client needs both stores and a route table');
  // One client per store for the life of this lending session, like the single client it replaces;
  // a failed resolution (an unreachable store) is retried on the next use.
  const clients={};
  const source=name=>{
    clients[name]??=Promise.resolve().then(()=>name==='member'?member():incumbent()).catch(error=>{delete clients[name];throw error;});
    return clients[name];
  };
  const known=new Map(); // digest -> {a, art}
  const life=new AbortController();
  let table=null;
  const saved=async()=>table??=(await routes.read())??{};
  async function authorityOf(digest) {
    return known.get(digest)?.a??(await saved())[digest]?.a??'incumbent';
  }
  async function persist(digest,entry) {
    const rows=await saved();
    delete rows[digest]; // newest last
    rows[digest]=entry;
    for(const key of Object.keys(rows).slice(0,Math.max(0,Object.keys(rows).length-MAX_ROUTES)))delete rows[key];
    await routes.write(rows);
  }
  function remember(name,view) {
    const digest=view?.job_digest;
    if(typeof digest!=='string')return;
    known.set(digest,{a:name,art:artifactDigests(view.job?.payload)});
  }
  async function artifactSource(digest) {
    for(const [,entry] of known)if(entry.art.includes(digest))return entry.a;
    for(const entry of Object.values(await saved()))if(entry.art?.includes(digest))return entry.a;
    return 'incumbent';
  }
  // A store only offers work it may dispatch; this checks the same fact on the reader's side.
  const ownedBy=(name,item)=>{
    const designated=item?.job?.payload?.designated_member;
    return name==='member'?designated===ownKeyId:designated===undefined;
  };

  // Discovery: one persistent long poll per store, so neither store's wait blocks the other. The poll results
  // are shared by every reader (the pool gives each of its lenders this one client): a snapshot version moves
  // whenever either store's open set changes, and a reader that has not seen the current version gets the
  // union of both snapshots at once. An unreachable store contributes nothing and is retried after a
  // backoff, so it neither stalls the reachable store nor spins.
  const feeds=Object.fromEntries(SOURCES.map(name=>[name,{promise:null,controller:null,revision:undefined,failedAt:-Infinity,error:null,items:[]}]));
  let version=0,answered=false;
  const shape=items=>JSON.stringify(items.map(item=>[item.job_digest,item.state]));
  const pollOnce=(name,controller,{waitSeconds,limit,since})=>(async()=>{
    const store=await source(name),items=[];let revision;
    for await(const item of store.listOffers({signal:controller.signal,waitSeconds,limit,...(since===undefined?{}:{since}),
      onRevision:value=>{revision=value;}}))items.push(item);
    return {items,revision};
  })().then(value=>({name,value,controller}),error=>({name,error,controller}));
  function start(name,{waitSeconds,limit}) {
    const feed=feeds[name],controller=new AbortController();
    feed.controller=controller;
    feed.promise=pollOnce(name,controller,{waitSeconds,limit,since:feed.revision});
    // Folded in as soon as it settles, so a snapshot is never waiting on a reader to pick it up.
    feed.promise.then(apply);
    return feed.promise;
  }
  /** Folds one finished poll into its feed (once, however many readers raced it). True when it answered. */
  function apply({name,value,error,controller}) {
    const feed=feeds[name],fresh=feed.controller===controller&&feed.promise!==null;
    if(fresh)feed.promise=null;
    if(error) {
      if(!fresh||controller.signal.aborted)return false;
      feed.failedAt=now();feed.error=error;
      if(feed.items.length){feed.items=[];version++;}
      return false;
    }
    if(fresh) {
      const items=value.items.filter(item=>ownedBy(name,item));
      if(shape(items)!==shape(feed.items))version++;
      feed.error=null;feed.failedAt=-Infinity;feed.revision=value.revision??feed.revision;feed.items=items;
      for(const item of items)remember(name,item);
      answered=true;
    }
    return true;
  }
  const union=()=>SOURCES.flatMap(name=>feeds[name].items);
  async function* listOffers({limit=100,waitSeconds=30,since,signal,onRevision}={}) {
    if(signal?.aborted)throw signal.reason;
    if(waitSeconds===0) {
      const outcomes=await Promise.all(SOURCES.map(name=>pollOnce(name,new AbortController(),{waitSeconds,limit})));
      for(const outcome of outcomes) {
        feeds[outcome.name].promise=null;
        if(outcome.error){feeds[outcome.name].error=outcome.error;feeds[outcome.name].items=[];}
        else{feeds[outcome.name].error=null;feeds[outcome.name].items=outcome.value.items.filter(item=>ownedBy(outcome.name,item));
          for(const item of feeds[outcome.name].items)remember(outcome.name,item);}
      }
      if(SOURCES.every(name=>feeds[name].error))throw feeds.incumbent.error;
      onRevision?.(++version);
      yield* union();return;
    }
    // The caller's abort stops this read's polls; the next read starts fresh ones.
    const stopPolls=()=>{for(const feed of Object.values(feeds))feed.controller?.abort(signal.reason);};
    signal?.addEventListener('abort',stopPolls,{once:true});
    let timer;
    try {
      for(;;) {
        if(signal?.aborted)throw signal.reason;
        for(const name of SOURCES) {
          const feed=feeds[name];
          if(!feed.promise&&now()-feed.failedAt>=backoffMs)start(name,{waitSeconds,limit});
        }
        if(answered&&since!==version) {onRevision?.(version);yield* union();return;}
        const running=SOURCES.filter(name=>feeds[name].promise);
        if(!running.length)throw feeds.incumbent.error??feeds.member.error;
        const racers=running.map(name=>feeds[name].promise);
        const idle=SOURCES.filter(name=>!feeds[name].promise);
        if(idle.length)racers.push(new Promise(resolve=>{
          timer=setTimeout(()=>resolve({retry:true}),Math.max(1,Math.min(...idle.map(name=>backoffMs-(now()-feeds[name].failedAt)))));
        }));
        const done=await Promise.race(racers);
        clearTimeout(timer);
        if(done.retry)continue;
        if(signal?.aborted)throw signal.reason;
        if(apply(done)) {
          onRevision?.(version);
          yield* union();return;
        }
        if(SOURCES.every(name=>feeds[name].error))throw feeds.incumbent.error;
      }
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',stopPolls);}
  }
  async function* listJobs({limit=50,signal}={}) {
    const outcomes=await Promise.all(SOURCES.map(async name=>{
      try {
        const store=await source(name),items=[];
        for await(const item of store.listJobs({limit,signal}))items.push(item);
        return {name,items};
      } catch(error) {return {name,error};}
    }));
    if(outcomes.every(row=>row.error))throw outcomes.find(row=>row.name==='incumbent').error;
    for(const {name,items=[]} of outcomes)
      for(const item of items) {
        if(item.state==='queued'&&!ownedBy(name,item))continue;
        remember(name,item);yield item;
      }
  }
  async function capabilities(options={}) {
    const results=new Map();
    const asks=SOURCES.map(name=>source(name).then(store=>store.capabilities(options)).then(
      value=>({name,value}),error=>({name,error})));
    // The first answer opens a short grace for the other store; an unreachable store costs only that grace.
    let grace;
    await new Promise(resolve=>{
      let pending=asks.length;
      for(const ask of asks)ask.then(result=>{
        results.set(result.name,result);
        if(result.value&&!grace)grace=setTimeout(resolve,outageMs);
        if(--pending===0)resolve();
      });
    });
    clearTimeout(grace);
    const answered=SOURCES.filter(name=>results.get(name)?.value);
    if(!answered.length)throw results.get('incumbent')?.error??results.get('member')?.error;
    const profiles=answered.map(name=>results.get(name).value);
    const shared=profiles[0].capabilities.filter(capability=>profiles.every(profile=>profile.capabilities.includes(capability)));
    return {...(results.get('incumbent')?.value??profiles[0]),capabilities:shared};
  }
  async function claimJob(digest,advertisement,options={}) {
    const a=await authorityOf(digest);
    await persist(digest,{a,art:known.get(digest)?.art??(await saved())[digest]?.art??[]});
    return (await source(a)).claimJob(digest,advertisement,options);
  }
  // Claim-next is the incumbent's: a member store never turns an ordinary item into an attempt.
  async function claimNext(advertisement,options={}) {
    const claim=await (await source('incumbent')).claimNext(advertisement,options);
    if(claim)remember('incumbent',claim);
    return claim;
  }
  const byDigest=name=>async(digest,...rest)=>(await source(await authorityOf(digest)))[name](digest,...rest);
  const byAttempt=name=>async(attempt,...rest)=>(await source(await authorityOf(attempt.job_digest)))[name](attempt,...rest);
  const api={listOffers,listJobs,capabilities,claimJob,claimNext,
    async resultContext(options={}) {
      if(options.job!==undefined)return (await source(await authorityOf(options.job))).resultContext(options);
      let first;
      for(const name of SOURCES)try{return await (await source(name)).resultContext(options);}catch(error){first??=error;}
      throw first;
    },
    async fetchArtifact(ref,options={}) {
      const a=options.job!==undefined?await authorityOf(options.job):await artifactSource(ref.digest);
      return (await source(a)).fetchArtifact(ref,options);
    },
    async uploadResultArtifacts(input,options={}) {return (await source(await authorityOf(input.job))).uploadResultArtifacts(input,options);},
    async verifyAccountLease(input) {return (await source(await authorityOf(input.jobId))).verifyAccountLease(input);},
    async signContinuation(...args) {return (await source('member').catch(()=>source('incumbent'))).signContinuation(...args);},
    async heartbeat(body,options={}) {
      const outcomes=await Promise.allSettled(SOURCES.map(async name=>(await source(name)).heartbeat(body,options)));
      if(outcomes.every(row=>row.status==='rejected'))throw outcomes.find(row=>row.status==='rejected').reason;
    },
    close(){life.abort();},
  };
  for(const name of ['getJob','fetchResult','fetchReceipt','fetchTranscript','waitForJob','waitForJobChange','declineJob','fetchProgress','fetchLiveTranscript'])api[name]=byDigest(name);
  for(const name of ['startAttempt','observeExecutionStart','renew','postLiveTranscript','postProgress','release','fail','completeAttempt','stopped','requestStop','getStopRequest','accountLease'])api[name]=byAttempt(name);
  return api;
}
