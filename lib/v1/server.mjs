import { createReadStream, realpathSync, readdirSync, mkdirSync, renameSync, unlinkSync, existsSync, openSync, fsyncSync, closeSync, statfsSync } from 'node:fs';
import { open, stat, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import * as p from '../protocol/index.mjs';
import { createHostAdmission } from './admission.mjs';
import { acquireProcessLockSync } from './lock.mjs';
import { isVersion, versionAtLeast } from './versions.mjs';
import { isOperationKey } from './outcome.mjs';

const fail=code=>{throw new p.ProtocolError(code);};
const need=(value,code='invalid_request')=>{if(!value)fail(code);};
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX='[0-9a-f]{64}';
const PUBLIC_ICONS=new Map([['/favicon.svg',['favicon.svg','image/svg+xml']],['/favicon.ico',['favicon.ico','image/vnd.microsoft.icon']],
  ['/apple-touch-icon.png',['apple-touch-icon.png','image/png']],['/icon-192.png',['icon-192.png','image/png']],
  ['/icon-512.png',['icon-512.png','image/png']],['/icon-maskable-512.png',['icon-maskable-512.png','image/png']],
  ['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']]]);
const STATUS=Object.fromEntries([
  [400,'invalid_request wrong_circle digest_mismatch size_mismatch cursor_invalid unsupported_version'],
  [401,'unauthenticated invalid_signature replay'],[403,'forbidden'],[404,'not_found circle_not_provisioned'],
  [409,'conflict idempotency_conflict stale_attempt lease_expired lease_fenced not_designated job_terminal retry_exhausted roster_stale enrollment_conflict invite_used artifact_missing circle_members_need_update client_update_required'],
  [410,'job_expired roster_expired enrollment_expired enrollment_rejected'],[413,'payload_too_large'],[422,'requirements_unsupported'],
  [429,'quota_exceeded rate_limited'],[503,'unavailable'],[500,'internal_error']
].flatMap(([status,codes])=>codes.split(' ').map(code=>[code,status])));
const exact=(body,required,optional=[])=>{
  need(body&&typeof body==='object'&&!Array.isArray(body));
  need(required.every(k=>Object.hasOwn(body,k))&&Object.keys(body).every(k=>required.includes(k)||optional.includes(k)));
};
export function consumeRequest(request,maximum,onChunk,timeoutMs) {
  return new Promise((resolve,reject)=>{
    let length=0,done=false,inFlight=Promise.resolve();
    const cleanup=()=>{clearTimeout(timer);for(const [name,fn] of [['data',data],['end',end],['error',error],['aborted',aborted]])request.removeListener(name,fn);};
    const finish=err=>{if(done)return;done=true;cleanup();request.pause();inFlight.then(()=>{if(err)reject(err);else resolve(length);},reject);};
    const error=()=>finish(new p.ProtocolError('invalid_request'));
    const aborted=()=>finish(new p.ProtocolError('invalid_request'));
    const end=()=>finish();
    const data=chunk=>{
      request.pause();length+=chunk.length;
      if(length>maximum){finish(new p.ProtocolError('payload_too_large'));return;}
      inFlight=Promise.resolve().then(()=>onChunk(chunk));
      inFlight.then(()=>{if(!done)request.resume();},finish);
    };
    const timer=setTimeout(()=>finish(new p.ProtocolError('invalid_request')),timeoutMs);
    request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',aborted);
  });
}

/** Thin single-circle transport. Origin comes only from the provisioned store. */
const clientCapabilities=value=>String(value).split(',').map(c=>c.trim()).filter(c=>/^[a-z0-9_]{1,40}$/.test(c)).slice(0,16);

export function createV1Handler({store,blobDir,clock=()=>Math.floor(Date.now()/1000),limits={},uploadIO={},downloadIO={},pollTiming={},maintenanceTiming={},minMember=null,admission=createHostAdmission({limits,clock})}={}) {
  const blobIO={open,renameSync,unlink,unlinkSync,statfsSync,...uploadIO};
  const openDownload=downloadIO.createReadStream??createReadStream;
  const downloadStat=downloadIO.stat??stat;
  // Separate monotonic poll timing from the protocol's epoch-seconds clock.
  const pollTimer={now:()=>performance.now(),setTimeout,clearTimeout,...pollTiming};
  const maintenanceTimer={setInterval,clearInterval,...maintenanceTiming};
  need(store&&typeof blobDir==='string'&&typeof clock==='function');
  const config=store.configuration();
  // Older stores can supply an explicit handler fallback; current hosts expose their runtime policy.
  const minimumMember=store.versionPolicy?.()?.minMember??minMember;
  need(minimumMember===null||isVersion(minimumMember));
  const requireClientVersion=(request,preflight)=>{
    // Compatibility only: this header is self-reported, not signed, and is not a security boundary.
    // Enrollment and roster recovery authenticate their bootstrap body later and remain compatible.
    if(minimumMember===null||preflight?.enrollmentBootstrap||preflight?.rosterRecovery)return;
    const reported=request.headers['faravan-version'];
    const version=isVersion(reported)?reported:null;
    if(version!==null&&versionAtLeast(version,minimumMember)===true)return;
    const error=new p.ProtocolError('client_update_required');
    error.minMember=minimumMember;error.clientVersion=version;throw error;
  };
  need(p.validateOrigin(config.origin, { lanMode: config.lanMode === true }).ok);
  const maxBodyBytes=Math.min(limits.maxBodyBytes??262144,262144);
  const maxArtifactBytes=Math.min(limits.maxArtifactBytes??config.limits.maxArtifactBytes,config.limits.maxArtifactBytes);
  const maxPollSeconds=Math.min(limits.maxPollSeconds??30,30),uploadTimeoutMs=limits.uploadTimeoutMs??300000;
  const jsonTimeoutMs=limits.jsonTimeoutMs??15000;
  const maxEnrollmentBodyBytes=Math.min(limits.maxEnrollmentBodyBytes??16384,maxBodyBytes);
  const enrollmentTimeoutMs=limits.enrollmentTimeoutMs??2000;
  const maxRosterRecoveryBytes=Math.min(limits.maxRosterRecoveryBytes??65536,maxBodyBytes);
  const rosterRecoveryTimeoutMs=limits.rosterRecoveryTimeoutMs??2000;
  const downloadTimeoutMs=limits.downloadTimeoutMs??300000;
  const downloads=new Set(),artifactReads=new Map();
  for(const n of [downloadTimeoutMs,maxEnrollmentBodyBytes,enrollmentTimeoutMs,jsonTimeoutMs,rosterRecoveryTimeoutMs,maxRosterRecoveryBytes])
    need(Number.isSafeInteger(n)&&n>0);
  for(const n of [maxBodyBytes,maxArtifactBytes,maxPollSeconds,uploadTimeoutMs])need(Number.isSafeInteger(n)&&n>=0);
  mkdirSync(blobDir,{recursive:true,mode:0o700});
  blobDir=realpathSync(blobDir);
  // Exclusive process ownership prevents restart recovery from stealing live uploads.
  const lockPath=blobDir+'.http-owner';
  let releaseLock;
  try{releaseLock=acquireProcessLockSync(lockPath);}
  catch(error){if(error.code==='lock_busy')fail('conflict');throw error;}
  let activeRequests=0,activeRosterRecoveries=0,activeEnrollmentBodies=0;
  // One HTTP owner per database/blob directory; recover only transport-owned uploads.
  try {
    // Legacy temporaries have no persisted cleanup identity. Remove them before
    // recovery can release any associated reservation; failure prevents serving.
    for(const name of readdirSync(blobDir))if(/^\.upload-[0-9a-f-]{36}$/.test(name))blobIO.unlinkSync(join(blobDir,name));
    store.recoverTransportUploads((ref,{abandonedAtStartup}={})=>{
      if(!abandonedAtStartup)return !existsSync(join(blobDir,ref.digest.slice(7)));
      // The store calls this only for an unretained digest with no live upload
      // owner. Persist removal before releasing its quota reservation.
      try {blobIO.unlinkSync(join(blobDir,ref.digest.slice(7)));}
      catch(error){if(error.code!=='ENOENT')throw error;}
      const fd=openSync(blobDir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      return true;
    },name=>{
      try {blobIO.unlinkSync(join(blobDir,name));return true;}
      catch(error){if(error.code==='ENOENT')return true;throw error;}
    });
    // P17a: files of deleted or expired jobs. A deletion that committed but whose file could not be removed (a crash) is finished here.
    const removeBlob=name=>{try{blobIO.unlinkSync(join(blobDir,name));}catch(error){if(error.code!=='ENOENT')throw error;}};
    store.setBlobRemover?.(removeBlob);
    store.collect();
    for(const name of readdirSync(blobDir))if(/^[0-9a-f]{64}$/.test(name)&&store.orphanBlob?.(name)===true)removeBlob(name);
  } catch(error) {releaseLock();throw error;}
  const events=new EventEmitter();events.setMaxListeners(0);
  const polls=new Set(),bodies=new Set();let closed=false;
  const collection=maintenanceTimer.setInterval(()=>{
    if(closed)return;
    try{store.collect();}catch{ /* Retry a busy or failed collection on the next tick. */ }
  },60000);
  collection.unref?.();
  const reply=(response,status,value,method,headers={})=>{
    if(response.destroyed||response.writableEnded)return;
    const bytes=value===undefined?Buffer.alloc(0):Buffer.from(p.canonicalize(value));
    need(status>=400||bytes.length<=maxBodyBytes,'payload_too_large');
    response.writeHead(status,{'Cache-Control':'no-store','Content-Type':'application/json','Content-Length':bytes.length,...headers});
    response.end(method==='HEAD'?undefined:bytes);
  };
  const waitClaim=async(request,response,device,body,ctx,releaseRequest)=>{
    const source=request.socket?.remoteAddress??'unknown';
    const duration=(body.wait_seconds===undefined?0:body.wait_seconds)*1000;
    const releasePoll=duration>0?admission.acquire('polls',source,device,config.circle):()=>{};
    let poll;try{poll=store.openClaimPoll(device,body,ctx);}catch(error){releasePoll();throw error;}
    if(poll.initial!==null||poll.replayed){poll.close();releasePoll();return poll.initial;}
    if(duration===0){try{return poll.poll(true);}finally{poll.close();}}
    // The independent poll lease now owns the wait; leave ordinary API slots free.
    releaseRequest();
    return new Promise((resolve,reject)=>{
      const deadline=pollTimer.now()+duration;let done=false,timer;
      const finish=(value,error)=>{
        if(done)return;done=true;pollTimer.clearTimeout(timer);poll.close();polls.delete(cancel);
        releasePoll();
        events.removeListener('jobs',wake);response.removeListener('close',cancel);request.removeListener('aborted',cancel);
        if(error)reject(error);else resolve(value);
      };
      const cancel=()=>finish(null,new p.ProtocolError('unavailable'));
      const wake=()=>{
        if(done)return;
        if(response.destroyed||request.aborted||closed){cancel();return;}
        try{const final=pollTimer.now()>=deadline,result=poll.poll(final);if(result!==null||final)finish(result);else{pollTimer.clearTimeout(timer);timer=pollTimer.setTimeout(wake,Math.max(1,Math.ceil(deadline-pollTimer.now())));}}
        catch(error){finish(null,error);}
      };
      polls.add(cancel);events.on('jobs',wake);response.once('close',cancel);request.once('aborted',cancel);
      timer=pollTimer.setTimeout(wake,Math.max(0,deadline-pollTimer.now()));
      wake();
    });
  };
  // GET /offers: the lender's list of open jobs. With wait>0 it holds until the list is non-empty (no `since`) or its revision
  // differs from `since`, waking on the same events as claim-next plus claims (an offer taken). One authenticated request, one nonce.
  const waitOffers=async(request,response,device,params,ctx,releaseRequest)=>{
    const duration=params.wait*1000,source=request.socket?.remoteAddress??'unknown';
    // Offer polls share the host-wide poll budget with claim polls (one admission across all circles).
    const releasePoll=duration>0?admission.acquire('polls',source,device,config.circle):()=>{};
    let poll;try{poll=store.openOffersPoll(device,params,ctx);}catch(error){releasePoll();throw error;}
    const ready=page=>params.since===null?page.items.length>0:page.revision!==params.since;
    if(duration===0){try{return poll.poll();}finally{poll.close();}}
    let first;try{first=poll.poll();}catch(error){poll.close();releasePoll();throw error;}
    if(ready(first)){poll.close();releasePoll();return first;}
    releaseRequest();
    return new Promise((resolve,reject)=>{
      const deadline=pollTimer.now()+duration;let done=false,timer,latest=first;
      const finish=(value,error)=>{
        if(done)return;done=true;pollTimer.clearTimeout(timer);poll.close();polls.delete(cancel);
        releasePoll();
        events.removeListener('jobs',wake);events.removeListener('offers',wake);response.removeListener('close',cancel);request.removeListener('aborted',cancel);
        if(error)reject(error);else resolve(value);
      };
      const cancel=()=>finish(null,new p.ProtocolError('unavailable'));
      const wake=()=>{
        if(done)return;
        if(response.destroyed||request.aborted||closed){cancel();return;}
        try{
          latest=poll.poll();const final=pollTimer.now()>=deadline;
          if(final||ready(latest))finish(latest);
          else{pollTimer.clearTimeout(timer);timer=pollTimer.setTimeout(wake,Math.max(1,Math.ceil(deadline-pollTimer.now())));}
        }catch(error){finish(null,error);}
      };
      polls.add(cancel);events.on('jobs',wake);events.on('offers',wake);response.once('close',cancel);request.once('aborted',cancel);
      timer=pollTimer.setTimeout(wake,Math.max(1,Math.ceil(deadline-pollTimer.now())));
    });
  };
  const waitJobChange=async(request,response,device,id,params,ctx,releaseRequest)=>{
    const duration=params.wait*1000,source=request.socket?.remoteAddress??'unknown';
    const releasePoll=admission.acquire('watches',source,device,config.circle);
    let poll;try{poll=store.openJobWatch(device,id,ctx);}catch(error){releasePoll();throw error;}
    const changed=page=>params.after===null||page.revision!==params.after;
    let latest;try{latest=poll.poll();}catch(error){poll.close();releasePoll();throw error;}
    if(changed(latest)){poll.close();releasePoll();return latest;}
    releaseRequest();
    return new Promise((resolve,reject)=>{
      const deadline=pollTimer.now()+duration;let done=false,timer;
      const finish=(value,error)=>{
        if(done)return;done=true;pollTimer.clearTimeout(timer);poll.close();polls.delete(cancel);releasePoll();
        events.removeListener('jobs',wake);response.removeListener('close',cancel);request.removeListener('aborted',cancel);
        if(error)reject(error);else resolve(value);
      };
      const cancel=()=>finish(null,new p.ProtocolError('unavailable'));
      const wake=changedDigest=>{
        if(done||changedDigest!==undefined&&changedDigest!==id)return;
        if(response.destroyed||request.aborted||closed){cancel();return;}
        try{
          latest=poll.poll();const final=pollTimer.now()>=deadline;
          if(final||changed(latest))finish(latest);
          else{pollTimer.clearTimeout(timer);timer=pollTimer.setTimeout(()=>wake(),Math.max(1,Math.ceil(deadline-pollTimer.now())));}
        }catch(error){finish(null,error);}
      };
      polls.add(cancel);events.on('jobs',wake);response.once('close',cancel);request.once('aborted',cancel);
      timer=pollTimer.setTimeout(()=>wake(),Math.max(1,Math.ceil(deadline-pollTimer.now())));
      wake();
    });
  };
  const handler=async(request,response,{requestLease,inviteAdmitted=false}={})=>{
    const source=request.socket?.remoteAddress??'unknown';
    let admitted=false,recoveryAdmitted=false,enrollmentAdmitted=false,downloadAdmitted=false,bootstrapFailure=false;
    let releaseRequest=requestLease,releaseDownload,releaseEnrollment,releaseRecovery;
    const releaseAdmission=()=>{
      if(!admitted)return;
      admitted=false;activeRequests--;releaseRequest();
    };
    let reservation,temp,file,installed=false,destination,device,releaseMember,releaseStorage,operationKey=null;
    // A parked poll has its own host/member/circle budget; release body-work leases too.
    const parkPoll=()=>{releaseAdmission();releaseMember?.();releaseMember=null;};
    const admitMember=kind=>{
      const fair=admission.acquire('memberWork',source,device,config.circle);
      try{const release=admission.acquire(kind,source,device,config.circle);releaseMember=()=>{release();fair();};}
      catch(error){fair();throw error;}
    };
    try {
      need(!closed,'unavailable');
      releaseRequest??=admission.acquire('requests',source);
      activeRequests++;admitted=true;
      const method=request.method,raw=request.url;
      need(typeof raw==='string'&&raw.startsWith('/')&&!raw.startsWith('//')&&raw.length<=4096&&!/[\\#\s]/.test(raw));
      const url=new URL(raw,config.origin);need(url.pathname+url.search===raw);
      if(method==='GET'&&PUBLIC_ICONS.has(url.pathname)) {
        const [name,type]=PUBLIC_ICONS.get(url.pathname),asset=await readFile(new URL('../../public/v1/'+name,import.meta.url));
        response.writeHead(200,{'Content-Type':type,'Content-Length':asset.length,'Cache-Control':'public, max-age=86400',
          'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});response.end(asset);return;
      }
      const shortPage=method==='GET'&&/^\/i\/[a-z2-7]{10}$/.test(raw);
      if(method==='GET'&&(raw==='/join'||shortPage)){
        const page=await readFile(new URL('../../public/join/index.html',import.meta.url));
        response.writeHead(200,{
          'Content-Type':'text/html; charset=utf-8',
          'Content-Length':page.length,
          // Only the short-link page reads from its own origin (the published invite); /join reads nothing.
          'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src "+(shortPage?"'self'":"'none'")+"; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'Referrer-Policy':'no-referrer',
          'Cache-Control':'no-store',
          'X-Content-Type-Options':'nosniff',
        });
        response.end(page);
        return;
      }
      if(method==='GET'&&raw.startsWith('/v1/invites/')){
        bootstrapFailure=true;
        const code=raw.slice('/v1/invites/'.length);
        need(p.INVITE_CODE_PATTERN.test(code),'not_found');
        let invite;try{invite=store.resolveInvite(code);}catch(error){if(!requestLease)admission.unknownInvite(source);throw error;}
        bootstrapFailure=false;
        if(!inviteAdmitted)admission.invite(code);
        reply(response,200,invite,method);
        return;
      }
      const prefix='/v1/circles/'+config.circle;
      need(url.pathname.startsWith(prefix+'/'),'circle_not_provisioned');
      const route=url.pathname.slice(prefix.length),query=url.search;
      const names=[...url.searchParams.keys()];need(new Set(names).size===names.length);
      bootstrapFailure=method==='POST'&&route==='/enrollments';
      if(bootstrapFailure)admission.bootstrapWork(source);
      const proof=request.headers['faravan-proof'];need(typeof proof==='string'&&proof.length<=16384,'unauthenticated');
      let payload;try{payload=p.strictParse(p.decodeBase64url(proof)).payload;}catch{fail('unauthenticated');}
      need(payload&&payload.method===method&&payload.target===config.origin+raw,'invalid_signature');
      need(payload.circle===config.circle,'wrong_circle');device=payload.key_id;
      const contentType=request.headers['content-type']??'',mediaType=request.headers['faravan-media-type']??'',idem=request.headers['idempotency-key']??'';
      need(payload.content_type===contentType&&payload.artifact_media_type===mediaType&&payload.idempotency_key===idem,'invalid_signature');
      if(method==='POST'&&route==='/jobs')operationKey=idem;
      const lengthHeader=request.headers['content-length'];let declared=null;
      if(lengthHeader!==undefined){need(typeof lengthHeader==='string'&&/^(0|[1-9][0-9]*)$/.test(lengthHeader));declared=Number(lengthHeader);need(Number.isSafeInteger(declared));need(declared<=(method==='PUT'&&url.pathname.includes('/artifacts/')?maxArtifactBytes:maxBodyBytes),'payload_too_large');need(declared===payload.content_length,'size_mismatch');}
      const read=method==='GET'||method==='HEAD';
      if(read)need((declared===null||declared===0)&&!request.headers['transfer-encoding']&&payload.content_length===0&&contentType===''&&mediaType===''&&idem==='');
      if(method==='POST')need(isOperationKey(idem));
      // Unsigned like Faravan-Version: it names the job a lender's result upload delivers. The store authorizes it per device.
      const jobHeader=request.headers['faravan-job'];
      need(jobHeader===undefined||typeof jobHeader==='string'&&new RegExp('^'+HEX+'$').test(jobHeader));
      const ctx={proof,route:route+query,maxResponseBytes:maxBodyBytes,personAction:request.headers['faravan-priority']==='person',
        ...(jobHeader===undefined?{}:{job:'sha256:'+jobHeader}),
        admitEnrollment:()=>{
          bootstrapFailure=false;
          admission.enrollment(device);
        }};
      const artifactMatch=new RegExp('^/artifacts/('+HEX+')$').exec(route);
      if(method==='PUT'&&artifactMatch) {
        need(!query&&contentType==='application/octet-stream'&&declared!==null&&!request.headers['transfer-encoding']);
        need(declared<=maxArtifactBytes,'payload_too_large');
        const ref={digest:'sha256:'+artifactMatch[1],bytes:declared,media_type:mediaType};
        need(payload.body_digest===ref.digest,'digest_mismatch');
        const checked=store.preflightRequest(device,ctx);
        if(minimumMember!==null)requireClientVersion(request,checked);
        admitMember('memberBodies');
        destination=join(blobDir,artifactMatch[1]);
        if(!existsSync(destination))releaseStorage=admission.reserveStorage(blobIO.statfsSync(blobDir,{bigint:true}),ref.bytes);
        reservation=store.reserveArtifact(device,ref,{...ctx,transport:true});
        // An uncertain installation already owns its permanent bytes. Verify
        // and finalize them without borrowing that charge for a second stream.
        const adoptedUncertainRetry=reservation.adopted_uncertain_retry===true;
        try {if(adoptedUncertainRetry||!store.requiresArtifactProof(device,ref.digest))file=await blobIO.open(destination,'r');}
        catch(error){if(error.code!=='ENOENT')throw error;}
        if(file) {
          const info=await file.stat();need(info.isFile()&&info.size===ref.bytes,'internal_error');
          const hash=createHash('sha256');let bytes=0;
          for await(const chunk of file.createReadStream({autoClose:false})) {
            bytes+=chunk.length;need(bytes<=ref.bytes,'internal_error');hash.update(chunk);
          }
          need(bytes===ref.bytes&&'sha256:'+hash.digest('hex')===ref.digest,'internal_error');
          await file.close();file=null;
          const result=store.finishArtifactUpload(device,reservation.reservation_id,ref,()=>{
            const fd=openSync(blobDir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
          },reservation.owner_token,{verifiedInput:adoptedUncertainRetry,job:ctx.job});
          reservation=null;
          reply(response,200,result,method,!request.complete?{'Connection':'close'}:{});return;
        }
        releaseStorage??=admission.reserveStorage(blobIO.statfsSync(blobDir,{bigint:true}),ref.bytes);
        const tempName='.upload-'+randomUUID();
        store.trackArtifactUpload(device,reservation.reservation_id,reservation.owner_token,tempName);
        temp=join(blobDir,tempName);
        file=await blobIO.open(temp,'wx',0o600);const hash=createHash('sha256');
        bodies.add(request);
        const bytes=await consumeRequest(request,declared,async chunk=>{hash.update(chunk);let offset=0;while(offset<chunk.length){const written=await file.write(chunk,offset,chunk.length-offset);need(written.bytesWritten>0,'internal_error');offset+=written.bytesWritten;}},uploadTimeoutMs);
        need(bytes===declared,'size_mismatch');const actual={...ref,digest:'sha256:'+hash.digest('hex')};
        need(actual.digest===ref.digest,'digest_mismatch');await file.sync();await file.close();file=null;
        const existed=existsSync(destination);
        const result=store.finishArtifactUpload(device,reservation.reservation_id,actual,()=>{
          blobIO.renameSync(temp,destination);temp=null;installed=!existed;
          const fd=openSync(blobDir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
        },reservation.owner_token,{verifiedInput:true,job:ctx.job});
        reservation=null;installed=false;reply(response,200,result,method);return;
      }
      let body=null;
      if(!read) {
        need(['POST','PUT'].includes(method)&&contentType==='application/json'&&mediaType==='');
        need(Number.isSafeInteger(payload.content_length)&&payload.content_length>=0,'invalid_request');
        need(payload.content_length<=maxBodyBytes,'payload_too_large');
        need(declared===null||declared<=maxBodyBytes,'payload_too_large');
        const preflight=store.preflightRequest(device,ctx);
        requireClientVersion(request,preflight);
        if(preflight?.enrollmentBootstrap){
          releaseAdmission();
          releaseEnrollment=admission.acquire('enrollmentBodies',source,undefined,config.circle);
          need(payload.content_length<=maxEnrollmentBodyBytes,'payload_too_large');
          activeEnrollmentBodies++;enrollmentAdmitted=true;
        }
        if(preflight?.rosterRecovery){
          admission.bootstrapWork(source);
          releaseAdmission();
          releaseRecovery=admission.acquire('rosterRecoveries',source);
          need(payload.content_length<=maxRosterRecoveryBytes,'payload_too_large');
          activeRosterRecoveries++;recoveryAdmitted=true;
        }
        if(!preflight?.enrollmentBootstrap&&!preflight?.rosterRecovery)
          admitMember(route==='/heartbeat'?'serviceBodies':'memberBodies');
        bodies.add(request);
        const chunks=[];const length=await consumeRequest(request,payload.content_length,chunk=>chunks.push(chunk),recoveryAdmitted?rosterRecoveryTimeoutMs:enrollmentAdmitted?enrollmentTimeoutMs:jsonTimeoutMs);
        need(declared===null||declared===length,'size_mismatch');const bytes=Buffer.concat(chunks,length);
        need(payload.content_length===length,'size_mismatch');need(payload.body_digest===p.digestBytes(bytes),'digest_mismatch');
        try{body=p.strictParse(bytes);need(p.canonicalize(body)===bytes.toString('utf8'));}catch{fail('invalid_request');}
        ctx.bodyBytes=bytes;
      }
      const replay=method==='POST'?store.openPostRequest(device,body,ctx):null;
      if(!replay?.replayed)need(!/%/.test(route));
      if(!replay?.replayed&&route!=='/jobs'&&route!=='/offers'&&route!=='/enrollments'&&!(method==='GET'&&(route.endsWith('/progress')||route.endsWith('/watch'))))need(!query);
      let result,status=200,match;
      if(replay?.replayed) {
        result=replay.result;status=route==='/jobs'?201:route==='/enrollments'||route==='/leave-requests'||route==='/member-origins'?202:route==='/jobs/claim-next'&&result===null?204:200;
      } else if(method==='GET'&&route==='/capabilities') {
        result=store.getCapabilities(device,ctx);result.max_artifact_bytes=maxArtifactBytes;result.max_json_bytes=maxBodyBytes;result.max_claim_wait_seconds=maxPollSeconds;
      } else if(method==='GET'&&route==='/quotas')result=store.getQuotas(device,ctx);
      else if(method==='GET'&&route==='/presence')result=store.getPresence(device,ctx);
      else if(method==='POST'&&route==='/heartbeat'){need(!query);result=store.heartbeat(device,body,ctx);}
      else if(method==='GET'&&route==='/roster')result=store.getRoster(device,ctx);
      else if(method==='GET'&&(match=/^\/rosters\/([1-9][0-9]*)$/.exec(route))){need(Number.isSafeInteger(Number(match[1])));result=store.getHistoricalRoster(device,Number(match[1]),ctx);}
      else if(method==='PUT'&&route==='/roster'){
        try {result=store.installRoster(body,ctx);}
        finally {
          // COMMIT can apply even when its acknowledgement throws. A rejected
          // proposal leaves the durable roster unchanged; never revoke from it.
          let members;
          try {members=new Set(store.currentMemberKeys());}catch { /* Cancel this circle's reads if membership cannot be established. */ }
          for(const read of artifactReads.values())if(!members||!members.has(read.device))read.cancel();
        }
        events.emit('jobs');
      }
      else if(method==='POST'&&route==='/invites/revoke')result=store.revokeInvite(body,ctx);
      else if(method==='POST'&&route==='/enrollments/reject')result=store.rejectEnrollment(body,ctx);
      else if(method==='POST'&&route==='/invites')result=store.registerInvite(body,ctx);
      else if(method==='POST'&&route==='/enrollments'){
        need(!query);exact(body,['invite','device_public_key','enrollment_proof']);result=store.createEnrollment(body,ctx);status=202;
      } else if(method==='GET'&&route==='/enrollments'){
        need(names.every(k=>['state','limit','cursor'].includes(k)),'cursor_invalid');
        result=store.listEnrollments(device,{state:url.searchParams.get('state')??'pending',limit:Number(url.searchParams.get('limit')??50),cursor:url.searchParams.get('cursor')},ctx);
      } else if(method==='GET'&&(match=new RegExp('^/enrollments/('+UUID+')$').exec(route)))result=store.getEnrollment(device,match[1],ctx);
      else if(method==='POST'&&route==='/leave-requests'){need(!query);exact(body,['leave']);result=store.createLeaveRequest(body,ctx);status=202;}
      else if(method==='GET'&&route==='/leave-requests')result=store.listLeaveRequests(device,ctx);
      else if(method==='POST'&&route==='/member-origins'){need(!query);exact(body,['proposal']);result=store.createMemberOrigin(body,ctx);status=202;}
      else if(method==='GET'&&route==='/member-origins')result=store.listMemberOrigins(device,ctx);
      else if(method==='POST'&&route==='/jobs'){need(!query);result=store.publishJob(body,ctx);status=201;events.emit('jobs');}
      else if(method==='GET'&&route==='/jobs'){
        need(names.every(k=>['limit','cursor'].includes(k)),'cursor_invalid');
        result=store.listJobs(device,{limit:Number(url.searchParams.get('limit')??50),cursor:url.searchParams.get('cursor'),
          accepts:clientCapabilities(request.headers['faravan-client-capabilities']??'')},ctx);
      } else if(method==='GET'&&route==='/offers'){
        need(names.every(k=>['limit','cursor','wait','since'].includes(k)),'cursor_invalid');
        const num=(name,fallback,max)=>{const v=url.searchParams.get(name);if(v===null)return fallback;need(/^(0|[1-9][0-9]{0,8})$/.test(v)&&Number(v)<=max,'cursor_invalid');return Number(v);};
        ctx.bodyBytes=Buffer.alloc(0);
        const params={limit:num('limit',50,100),cursor:url.searchParams.get('cursor'),
          accepts:clientCapabilities(request.headers['faravan-client-capabilities']??'results_v1'),
          wait:num('wait',0,maxPollSeconds),since:num('since',null,Number.MAX_SAFE_INTEGER)};
        if(params.wait>0){store.preflightRequest(device,ctx);admitMember('memberBodies');}
        result=await waitOffers(request,response,device,params,ctx,parkPoll);
      } else if(method==='GET'&&(match=new RegExp('^/jobs/('+HEX+')/watch$').exec(route))){
        need(names.every(k=>['after','wait'].includes(k)),'cursor_invalid');
        const after=url.searchParams.get('after');
        need(after===null||/^sha256:[0-9a-f]{64}$/.test(after),'cursor_invalid');
        const wait=url.searchParams.get('wait');
        need(wait!==null&&/^(0|[1-9][0-9]{0,8})$/.test(wait)&&Number(wait)>=1&&Number(wait)<=maxPollSeconds,'cursor_invalid');
        ctx.bodyBytes=Buffer.alloc(0);
        store.preflightRequest(device,ctx);admitMember('memberBodies');
        result=await waitJobChange(request,response,device,'sha256:'+match[1],{after,wait:Number(wait)},ctx,parkPoll);
      } else if(method==='POST'&&route==='/jobs/claim-next'){
        exact(body,['advertisement'],['lease_seconds','wait_seconds','exclude']);
        const wait=body.wait_seconds===undefined?0:body.wait_seconds;
        need(Number.isInteger(wait)&&wait>=0&&wait<=maxPollSeconds);
        result=await waitClaim(request,response,device,body,ctx,parkPoll);if(result===null)status=204;else {events.emit('offers');events.emit('jobs',result.job_digest);}
      } else if((match=new RegExp('^/jobs/('+HEX+')(?:/(claim|decline|cancel|result|progress|transcript|retention|delete|watch))?$').exec(route))){
        const id='sha256:'+match[1],action=match[2];
        if(method==='GET'&&!action)result=store.getJob(device,id,ctx,clientCapabilities(request.headers['faravan-client-capabilities']??'').includes('decline_count_v1'));
        else if(method==='GET'&&action==='result')result=store.getResult(device,id,ctx);
        else if(method==='GET'&&action==='transcript')result=store.getLiveTranscript(device,id,ctx);
        else if(method==='POST'&&action==='transcript'){exact(body,['attempt','seq','text','truncated']);result=store.postLiveTranscript(device,id,body,ctx);}
        else if(method==='GET'&&action==='retention')result=store.getRetention(device,id,ctx);
        else if(method==='POST'&&action==='delete'){exact(body,[]);result=store.deleteJob(device,id,ctx);events.emit('jobs',id);}
        else if(method==='GET'&&action==='progress'){
          need(names.every(k=>k==='after')&&(query===''||/^\?after=(0|[1-9][0-9]{0,8})$/.test(query)),'cursor_invalid');
          result=store.getProgress(device,id,{after:Number(url.searchParams.get('after')??0)},ctx);
        } else if(method==='POST'&&action==='progress'){exact(body,['attempt'],['step','kind','stage','elapsed_s']);result=store.postProgress(device,id,body,ctx);}
        else if(method==='POST'&&action==='claim'){
          exact(body,['advertisement'],['lease_seconds','wait_seconds']);need(body.wait_seconds===undefined||body.wait_seconds===0);
          result=store.claimJob(device,id,body.advertisement,ctx,body.lease_seconds===undefined?120:body.lease_seconds);events.emit('offers');events.emit('jobs',id);
        } else if(method==='POST'&&action==='decline'){exact(body,[]);result=store.declineJob(device,id,ctx);events.emit('offers');events.emit('jobs',id);}
        else if(method==='POST'&&action==='cancel'){need(body?.payload?.job_digest===id);result=store.cancel(body,ctx);events.emit('jobs',id);}
        else fail('not_found');
      } else if((match=new RegExp('^/attempts/('+UUID+')(?:/(start|observed-start|renew|release|fail|complete|stopped|stop-request|account-lease))?$').exec(route))){
        const id=match[1],action=match[2];
        if(method==='GET'&&!action)result=store.getAttempt(device,id,ctx);
        else if(method==='POST'&&action==='account-lease'){
          exact(body,['generation','selection','challenge']);
          need(typeof body.challenge==='string'&&/^[A-Za-z0-9_-]{32,64}$/.test(body.challenge));
          result=store.accountLease(device,id,body,ctx);
        }
        else if(method==='GET'&&action==='stop-request')result=store.getStopRequest(device,id,ctx);
        else if(method==='POST'&&action==='complete'){need(body?.payload?.attempt_id===id);result=store.complete(body,ctx);events.emit('jobs',result.job_digest);}
        else if(method==='POST'&&action==='start'){exact(body,['generation']);result=store.start(device,id,body.generation,ctx);events.emit('jobs',result.job_digest);}
        else if(method==='POST'&&action==='observed-start'){exact(body,['generation'],['observed_at']);result=store.observeExecutionStart(device,id,body.generation,ctx,body.observed_at);events.emit('jobs',result.job_digest);}
        else if(method==='POST'&&action==='stop-request'){exact(body,['generation']);result=store.requestStop(device,id,body.generation,ctx);events.emit('jobs',result.job_digest);}
        else if(method==='POST'&&action==='renew'){exact(body,['generation'],['lease_seconds']);result=store.renew(device,id,body.generation,ctx,body.lease_seconds===undefined?120:body.lease_seconds);}
        else if(method==='POST'&&['release','fail'].includes(action)){exact(body,['generation','reason']);result=store[action](device,id,body.generation,body.reason,ctx);events.emit('jobs',result.job_digest);}
        else if(method==='POST'&&action==='stopped'){exact(body,['generation','stopped_at']);result=store.stopped(device,id,body.generation,body.stopped_at,ctx);events.emit('jobs',result.job_digest);}
        else fail('not_found');
      } else if(read&&artifactMatch) {
        store.preflightRequest(device,ctx);
        admitMember('memberBodies');
        const ref=store.getArtifact(device,'sha256:'+artifactMatch[1],ctx,method),path=join(blobDir,artifactMatch[1]);
        let stream,finished,settle,timer,done=false;
        const finishDownload=()=>{
          if(done)return;done=true;clearTimeout(timer);
          if(stream&&!stream.closed){stream.once('close',settle);stream.destroy();}
          else settle();
        };
        const failDownload=()=>{response.destroy();finishDownload();};
        artifactReads.set(response,{device,cancel:failDownload});
        if(method==='GET'){
          releaseDownload=admission.acquire('downloads',source,device,config.circle);downloadAdmitted=true;
          downloads.add(response);
        }
        finished=new Promise(resolve=>{settle=resolve;});
        // Cancellation and the deadline cover GET/HEAD stat as well as streams.
        response.once('finish',finishDownload);response.once('close',finishDownload);response.on('error',failDownload);
        timer=setTimeout(failDownload,downloadTimeoutMs);
        if(response.destroyed)finishDownload();
        try {
          const lookup=downloadStat(path).catch(()=>fail('not_found'));
          const info=await Promise.race([lookup,finished.then(()=>fail('unavailable'))]);
          need(!done&&!response.destroyed,'unavailable');
          // Stat yields to roster publication. Recheck current membership without
          // consuming this request's nonce a second time before sending headers.
          store.recheckArtifactRead(device,ref.digest);
          need(info.isFile()&&info.size===ref.bytes,'internal_error');
          response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':ref.bytes,
            'Faravan-Media-Type':ref.media_type,'Content-Disposition':'attachment','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
          if(method==='HEAD'){response.end();return;}
          stream=openDownload(path);
          // Keep the error consumer until the descriptor has actually closed.
          stream.on('error',failDownload);
          stream.once('close',()=>{
            stream.removeListener('error',failDownload);
            if(!done&&!stream.readableEnded)failDownload();
          });
          stream.pipe(response);await finished;
        } finally {
          finishDownload();await finished;
          response.removeListener('finish',finishDownload);response.removeListener('close',finishDownload);response.removeListener('error',failDownload);
        }
        return;
      } else fail('not_found');
      if(route.startsWith('/enrollments/')||method==='POST'&&route==='/enrollments')
        result={enrollment_id:result.enrollment_id,state:result.state,device_key_id:result.device,roster:result.roster};
      if(result?.attempt&&result?.job?.job_digest)result={job_digest:result.job.job_digest,job:result.job.job,attempt:result.attempt};
      reply(response,status,status===204?undefined:result,method);
    } catch(error) {
      if(bootstrapFailure){
        try{admission.failure(source);}catch(limited){error=limited;}
      }
      const code=error instanceof p.ProtocolError&&STATUS[error.code]?error.code:'internal_error',status=STATUS[code];
      if(file)await file.close().catch(()=>{});
      if(temp)try {await blobIO.unlink(temp);temp=null;}catch(cleanupError){if(cleanupError.code==='ENOENT')temp=null;}
      if(reservation){try{store.abortArtifactUpload(device,reservation.reservation_id,
        code==='internal_error'?undefined:()=>{
          if(installed&&destination)unlinkSync(destination);
          return !destination||!existsSync(destination);
        },reservation.owner_token,!temp);}catch{}}
      if(response.headersSent){response.destroy();return;}
      reply(response,status,{type:'urn:faravan:problem:'+code,title:code.replaceAll('_',' '),status,code,
        retryable:status===429||status===503,outcome:code==='internal_error'?'unknown':'not_applied',
        ...(operationKey?{operationKey}:{}),
        ...(code==='client_update_required'?{min_member:error.minMember,client_version:error.clientVersion,
          detail:'Update Faravan to '+error.minMember+' or newer before making changes.'}:{})},request.method,
        {'Content-Type':'application/problem+json',...(!request.complete?{'Connection':'close'}:{}),...(status===429||status===503?{'Retry-After':'1'}:{})});
    } finally {
      bodies.delete(request);
      artifactReads.delete(response);
      if(downloadAdmitted){
        downloads.delete(response);releaseDownload();
      }
      releaseAdmission();releaseMember?.();releaseStorage?.();releaseEnrollment?.();releaseRecovery?.();
      if(recoveryAdmitted)activeRosterRecoveries--;
      if(enrollmentAdmitted)activeEnrollmentBodies--;
      if(closed&&activeRequests===0&&activeRosterRecoveries===0&&activeEnrollmentBodies===0){releaseLock();}
    }
  };
  handler.close=()=>{closed=true;maintenanceTimer.clearInterval(collection);for(const request of bodies)request.destroy();for(const read of artifactReads.values())read.cancel();for(const cancel of [...polls])cancel();if(activeRequests===0&&activeRosterRecoveries===0&&activeEnrollmentBodies===0){releaseLock();}};
  Object.defineProperty(handler,'pendingRequests',{get:()=>activeRequests});
  Object.defineProperty(handler,'pendingEnrollmentBodies',{get:()=>activeEnrollmentBodies});
  Object.defineProperty(handler,'pendingDownloads',{get:()=>downloads.size});
  Object.defineProperty(handler,'pendingRosterRecoveries',{get:()=>activeRosterRecoveries});
  Object.defineProperty(handler,'pendingPolls',{get:()=>polls.size});
  return handler;
}
