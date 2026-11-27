import assert from 'node:assert/strict';

// An injected fake provider for the member's Gozar route: it models only what the shared hosting wrapper asks of
// Gozar. A route forwards to exactly the target it was installed for, a close removes exactly its own handle, and a
// route installed for another owner is never touched. No network, no credentials, no real route.

export const publicOrigin='https://member.example';
export const digest='sha256:member-offer';

export function provider() {
  const routes=new Map([['foreign-route',{handle:{id:'foreign-route',generation:1},owner:'someone-else',operationId:'theirs',target:'127.0.0.1:9'}],
    ['coordinator-route',{handle:{id:'coordinator-route',generation:1},owner:'faravan-coordinator',operationId:'coord',target:'127.0.0.1:8'}]]);
  const log={catalog:[],ensure:[],close:[],status:[]};
  const state={generations:0,gate:null,entered:null,refuse:false,failEnsure:false,watchers:new Set()};
  const view=route=>{
    const lost=route.lost===true;
    return {handle:route.handle,operationId:route.operationId,state:lost?'lost':'usable',published:publicOrigin,
      verification:{status:lost?'failed':'verified',subject:{origin:publicOrigin,target:route.target,handleGeneration:route.handle.generation},
        validUntil:{known:true,value:new Date(Date.now()+3600000).toISOString()}},binding:{target:{known:true,value:route.target}},
      cleanup:{state:'confirmed'}};
  };
  const api={
    async catalogRoutes(query){
      log.catalog.push(query);
      return {candidates:[{eligible:true,providerId:'fake',display:'fake',properties:{},configuration:{revision:1},
        setup:{state:'ready',actions:[]},consent:{consentFactsDigest:digest},consentFactsDigest:digest,candidateToken:'token',
        disclosure:{revision:'r1'}}]};
    },
    async ensureRoute(request){
      log.ensure.push(request);
      if(state.failEnsure)throw Object.assign(new Error('provider unavailable'),{code:'provider_unavailable'});
      state.entered?.();
      if(state.gate)await state.gate;
      const known=[...routes.values()].find(row=>row.owner===request.owner&&row.operationId===request.operationId);
      if(!known&&!request.approval)throw Object.assign(new Error('approval required'),{code:'consent_required'});
      const route=known??{handle:{id:'route-'+routes.size,generation:++state.generations},owner:request.owner,operationId:request.operationId,target:request.target};
      routes.set(route.handle.id,route);
      return view(route);
    },
    async routeStatus({handle}){log.status.push(handle);const route=routes.get(handle.id);return route?view(route):null;},
    async listRoutes({owner}){return {routes:[...routes.values()].filter(row=>row.owner===owner)};},
    async *watchRoutes({handle,signal}){
      const queue=[];let wake=()=>{};
      const entry={handle,push:value=>{queue.push(value);wake();}};
      state.watchers.add(entry);
      signal?.addEventListener('abort',()=>wake(),{once:true});
      try {
        while(!signal?.aborted) {
          if(queue.length){yield {route:queue.shift()};continue;}
          await new Promise(resolve=>{wake=resolve;});
        }
      } finally {state.watchers.delete(entry);}
    },
    async closeRoute(call){
      log.close.push(call);
      const route=routes.get(call.handle.id);
      if(state.refuse||!route)return {handle:call.handle,operationId:route?.operationId??null,cleanup:{state:'unconfirmed'}};
      routes.delete(call.handle.id);
      return {handle:call.handle,operationId:route.operationId,cleanup:{state:'confirmed'}};
    },
  };
  const lose=id=>{const route=routes.get(id);route.lost=true;for(const w of state.watchers)w.push(view(route));};
  return {api,routes,log,state,lose};
}
export const approved=async(app,fake)=>{
  const {offers,approvalBinding}=await app.memberExposure.offers();
  assert.equal(offers.length,1);
  assert.ok(approvalBinding);
  return app.memberExposure.approve({providerId:'fake',consentFactsDigest:digest});
};
