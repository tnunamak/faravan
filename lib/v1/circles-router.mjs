// R1: many circles on one coordinator origin. Each circle keeps its own SQLite store, its own
// blob directory and its own quotas (<circlesDir>/<circle id>/coordinator.sqlite, blobs/), so
// circles cannot read or fill each other's data. Host transport budgets are shared;
// public invite codes are indexed at load and publication, never by scanning on a request.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openV1Store } from './store.mjs';
import { createV1Handler } from './server.mjs';
import { createHostAdmission } from './admission.mjs';
import { ProtocolError, INVITE_CODE_PATTERN } from '../protocol/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_PROVISIONED = JSON.stringify({
  type: 'urn:faravan:problem:circle_not_provisioned', title: 'Circle not provisioned', status: 404,
  code: 'circle_not_provisioned', retryable: false, outcome: 'not_applied',
});
const notProvisioned = (request, response) => {
  response.writeHead(404, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(NOT_PROVISIONED) });
  response.end(request.method === 'HEAD' ? undefined : NOT_PROVISIONED);
};

export function createCirclesRouter({ circlesDir, origin, clock, versions = null, legacy = null, limits = {} }) {
  const admission=createHostAdmission({limits,...(clock?{clock}:{})});
  const now=clock??(()=>Math.floor(Date.now()/1000));
  const retrySeconds=limits.circleOpenRetrySeconds??1;
  if(!Number.isSafeInteger(retrySeconds)||retrySeconds<1||retrySeconds>30)throw new ProtocolError('invalid_request');
  const quarantined=new Map(); // local store identity -> bounded error metadata; no raw store errors
  const inviteIndex=new Map();
  const inviteRegistry={
    check(code,circle){const owner=inviteIndex.get(code);if(owner&&owner!==circle)throw new ProtocolError('conflict');},
    publish(code,circle){inviteRegistry.check(code,circle);inviteIndex.set(code,circle);},
    forget(code,circle){if(inviteIndex.get(code)===circle)inviteIndex.delete(code);},
  };
  let closed=false;
  const circles = new Map(); // circle id -> { store, handler }
  let legacyLoaded = false;
  const open = (id, dbPath, blobDir) => {
    const store = openV1Store({ path: dbPath, origin, busyTimeoutMs:0, ...(id===null?{}:{circle:id}), ...(clock ? { clock } : {}), ...(versions ? { faravanVersion: versions.faravanVersion, minMember: versions.minMember } : {}) });
    let handler,actual;
    try {
      actual = store.configuration().circle;
      if(!UUID.test(actual))throw new ProtocolError('invalid_request');
      if(circles.has(actual)){
        const existing=circles.get(actual);
        if(existing.dbPath!==dbPath)throw new ProtocolError('conflict');
        store.close();return existing;
      }
      const codes=store.publishedInviteCodes();
      for(const code of codes)inviteRegistry.check(code,actual);
      store.setInviteCodeRegistry(inviteRegistry);
      handler = createV1Handler({ store, blobDir, limits, admission, ...(clock ? { clock } : {}) });
      for(const code of codes)inviteRegistry.publish(code,actual);
      circles.set(actual, { store, handler, dbPath });
      return circles.get(actual);
    } catch (error) {
      if(UUID.test(actual))error.knownCircle=actual;
      try{handler?.close();}finally{store.close();} throw error;
    }
  };
  const tryOpen=(id,dbPath,blobDir)=>{
    const previous=quarantined.get(id);
    if(previous&&previous.retryAt>now())return null;
    try{
      const entry=open(id,dbPath,blobDir);quarantined.delete(id);return entry;
    }catch(error){
      const attempts=Math.min((previous?.attempts??0)+1,32);
      quarantined.set(id,{circle:id,...(error.knownCircle?{knownCircle:error.knownCircle}:{}),code:error instanceof ProtocolError?error.code:'internal_error',attempts,
        retryAt:now()+Math.min(30,retrySeconds*2**Math.min(attempts-1,5))});
      return null;
    }
  };
  const loadLegacy = () => {
    if(!legacy||!existsSync(legacy.dbPath)){quarantined.delete(null);return;}
    if((quarantined.get(null)?.retryAt??0)>now())return;
    if (!legacyLoaded) {
      legacyLoaded = !!tryOpen(null, legacy.dbPath, legacy.blobDir);
    }
  };
  const load = id => {
    if(!UUID.test(id))return null;
    if (circles.has(id)) return circles.get(id);
    const dir = join(circlesDir, id), db = join(dir, 'coordinator.sqlite');
    if(!existsSync(db)){quarantined.delete(id);return null;}
    return tryOpen(id, db, join(dir, 'blobs'));
  };
  const retryOneQuarantined = () => {
    const next=quarantined.entries().next();
    if(next.done)return;
    const [id,entry]=next.value;
    // Rotate one candidate per admitted miss. Neither a guess nor a valid invite
    // can force a scan of every store, even when several circles are unavailable.
    quarantined.delete(id);quarantined.set(id,entry);
    if(entry.retryAt>now())return;
    if(id===null)loadLegacy();else load(id);
  };
  const scan = () => {
    loadLegacy();
    let names = [];
    try { names = readdirSync(circlesDir); } catch { /* no circles yet */ }
    for (const name of names.sort()) if (UUID.test(name)) load(name);
  };
  scan();
  const any = () => circles.values().next().value ?? null;
  const handler = async (request, response) => {
    let release,retryAfter=1;
    try {
      if(closed)throw new ProtocolError('unavailable');
      const source=request.socket?.remoteAddress??'unknown';
      // Admission precedes filesystem discovery, index lookup and circle dispatch.
      release=admission.acquire('requests',source);
      const raw=request.url;
      if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//')||raw.length>4096||/[\\#\s]/.test(raw))throw new ProtocolError('invalid_request');
      const path = new URL(raw, 'http://coordinator.internal').pathname;
      const code = /^\/v1\/invites\/([^/]+)$/.exec(raw)?.[1];
      const inviteLookup=code&&INVITE_CODE_PATTERN.test(code)&&request.method==='GET';
      if(!inviteLookup)loadLegacy();
      const match = /^\/v1\/circles\/([^/]+)\//.exec(path);
      if (match) {
        const entry = load(match[1]);
        // An unreadable legacy configuration may own any otherwise unknown valid id.
        const legacyFailure=quarantined.get(null);
        const unavailable=quarantined.get(match[1])??(UUID.test(match[1])&&
          (!legacyFailure?.knownCircle||legacyFailure.knownCircle===match[1])?legacyFailure:null);
        if(!entry&&unavailable){
          retryAfter=Math.max(1,Math.ceil(unavailable.retryAt-now()));
          throw new ProtocolError('unavailable');
        }
        return await (entry ? entry.handler(request, response, {requestLease:release}) : notProvisioned(request, response));
      }
      if (inviteLookup) {
        let owner=inviteIndex.get(code);
        if(!owner){
          admission.unknownInvite(source);
          if(!legacyLoaded&&legacy&&!quarantined.has(null)&&existsSync(legacy.dbPath))loadLegacy();
          else retryOneQuarantined();
          owner=inviteIndex.get(code);
        }
        if(owner){
          admission.invite(code);
          return await circles.get(owner).handler(request,response,{requestLease:release,inviteAdmitted:true});
        }
        // Unreadable stores may own this code. Keep the miss retryable without
        // spending authentication-failure capacity shared with healthy circles.
        if(quarantined.size){
          retryAfter=Math.max(1,quarantined.values().next().value.retryAt-now());
          throw new ProtocolError('unavailable');
        }
        admission.failure(source);
        throw new ProtocolError('not_found');
      }
      const entry = any();
      return await (entry ? entry.handler(request, response, {requestLease:release}) : notProvisioned(request, response));
    } catch(error) {
      const code=error instanceof ProtocolError?error.code:'internal_error';
      const status={rate_limited:429,unavailable:503,conflict:409,invalid_request:400,not_found:404}[code]??500;
      if(response.headersSent){response.destroy();return;}
      const bytes=JSON.stringify({type:'urn:faravan:problem:'+code,title:code.replaceAll('_',' '),status,code,
        retryable:status===429||status===503,outcome:status===500?'unknown':'not_applied'});
      response.writeHead(status,{'Content-Type':'application/problem+json','Content-Length':Buffer.byteLength(bytes),
        'Cache-Control':'no-store',...(!request.complete?{'Connection':'close'}:{}),...(status===429||status===503?{'Retry-After':String(retryAfter)}:{})});
      response.end(request.method==='HEAD'?undefined:bytes);
    } finally {release?.();}
  };
  handler.close = () => { closed=true;for (const entry of circles.values()) entry.handler.close?.(); };
  handler.dispose = () => { closed=true;for (const entry of circles.values()) { try { entry.handler.close?.(); } finally { entry.store.close(); } } circles.clear(); };
  handler.circles = () => [...circles.keys()];
  handler.quarantined = () => [...quarantined.values()].slice(0,64).map(entry=>({...entry}));
  for (const [property,pool] of [['pendingRequests','requests'],['pendingPolls','polls'],['pendingWatches','watches'],['pendingDownloads','downloads'],
    ['pendingEnrollmentBodies','enrollmentBodies'],['pendingRosterRecoveries','rosterRecoveries'],
    ['pendingMemberWork','memberWork'],['pendingMemberBodies','memberBodies'],['pendingServiceBodies','serviceBodies']])
    Object.defineProperty(handler, property, {get:() => admission.pending(pool)});
  return handler;
}
