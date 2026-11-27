import { ProtocolError } from '../protocol/index.mjs';

// Members queue their downloads to this width (lib/v1/device.mjs), so a default host never refuses them with 429.
export const DOWNLOADS_PER_DEVICE=2;

const need=value=>{if(!value)throw new ProtocolError('rate_limited');};

/** Host transport budgets. No circle data, quotas, nonces or idempotency live here. */
export function createHostAdmission({limits={},clock=()=>Math.floor(Date.now()/1000)}={}) {
  const pools=new Map(),rates=new Map();
  const positive=(name,fallback)=>{
    const value=limits[name]??fallback;
    if(!Number.isSafeInteger(value)||value<=0)throw new ProtocolError('invalid_request');
    return value;
  };
  const capacities={
    requests:[positive('maxRequests',256),positive('maxRequestsPerSource',64),Infinity],
    downloads:[positive('maxDownloads',16),positive('maxDownloadsPerSource',limits.maxDownloads??16),positive('maxDownloadsPerDevice',DOWNLOADS_PER_DEVICE),positive('maxDownloadsPerCircle',4)],
    polls:[positive('maxPolls',128),positive('maxPollsPerSource',limits.maxPolls??128),positive('maxPollsPerDevice',4),positive('maxPollsPerCircle',16)],
    enrollmentBodies:[positive('maxEnrollmentBodiesHost',16),positive('maxEnrollmentBodiesPerSource',limits.maxEnrollmentBodiesHost??16),Infinity,positive('maxEnrollmentBodies',2)],
    rosterRecoveries:[positive('maxRosterRecoveries',2),positive('maxRosterRecoveriesPerSource',limits.maxRosterRecoveries??2),Infinity],
  };
  capacities.watches=capacities.polls;
  if(capacities.enrollmentBodies[3]>=capacities.enrollmentBodies[0])throw new ProtocolError('invalid_request');
  // Long-lived member work cannot consume all request capacity. These leases
  // are acquired only after cryptographic membership preflight, never from a
  // caller-declared circle/key. Both dimensions matter when a circle has many
  // malicious members. Short reads keep the remaining host/source slots.
  const requestTotal=capacities.requests[0],requestSource=capacities.requests[1];
  const bounded=(name,maximum)=>Math.min(positive(name,maximum),maximum);
  const circleMaximum=Math.max(1,Math.min(16,Math.floor(requestTotal/2),Math.floor(requestSource/2)));
  capacities.memberWork=[requestTotal,requestSource,positive('maxMemberWorkPerDevice',5),bounded('maxMemberWorkPerCircle',circleMaximum)];
  capacities.memberBodies=[bounded('maxMemberBodies',Math.max(1,Math.floor(requestTotal*3/4))),
    bounded('maxMemberBodiesPerSource',Math.max(1,Math.floor(requestSource*3/4))),
    positive('maxMemberBodiesPerDevice',4),positive('maxMemberBodiesPerCircle',16)];
  const serviceTotal=Math.max(Math.min(2,requestTotal),Math.floor(requestTotal/8));
  const serviceSource=Math.max(Math.min(2,requestSource),Math.floor(requestSource/8));
  const serviceCircle=Math.max(1,Math.min(2,Math.floor(serviceTotal/2),Math.floor(serviceSource/2)));
  capacities.serviceBodies=[bounded('maxServiceBodies',serviceTotal),bounded('maxServiceBodiesPerSource',serviceSource),
    positive('maxServiceBodiesPerDevice',1),bounded('maxServiceBodiesPerCircle',serviceCircle)];
  const window=positive('bootstrapWindowSeconds',60),inviteWindow=positive('inviteLookupWindowSeconds',60);
  const bootstrap=positive('bootstrapPerDevice',limits.bootstrapPerSource??30);
  const invites=positive('inviteLookupsPerCode',limits.inviteLookupsPerSource??30);
  const failures=positive('unauthenticatedFailures',300),unknown=positive('unknownInviteLookups',failures);
  const work=positive('bootstrapWorkPerWindow',300),workSource=positive('bootstrapWorkPerSource',work);
  const nonnegative=(name,fallback)=>{const value=limits[name]??fallback;
    if(!Number.isSafeInteger(value)||value<0)throw new ProtocolError('invalid_request');return BigInt(value);};
  const freeBytes=nonnegative('minFreeDiskBytes',64*1048576),freeFiles=nonnegative('minFreeInodes',128);
  let reservedBytes=0n,reservedFiles=0n;
  function charge(kind,key,maximum,seconds) {
    let entries=rates.get(kind);if(!entries){entries=new Map();rates.set(kind,entries);}
    const t=clock();for(const [id,rate] of entries)if(rate.until<=t)entries.delete(id);
    let rate=entries.get(key);
    if(!rate){need(entries.size<4096);rate={until:t+seconds,count:0};entries.set(key,rate);}
    need(rate.count<maximum);rate.count++;
  }
  return {
    acquire(kind,source,device,circle) {
      let pool=pools.get(kind);
      if(!pool){pool={count:0,sources:new Map(),devices:new Map(),circles:new Map()};pools.set(kind,pool);}
      if(kind==='enrollmentBodies')need(typeof circle==='string');
      const [total,perSource,perDevice,perCircle=Infinity]=capacities[kind];
      need(pool.count<total&&(pool.sources.get(source)??0)<perSource&&(pool.devices.get(device)??0)<perDevice&&
        (pool.circles.get(circle)??0)<perCircle);
      pool.count++;pool.sources.set(source,(pool.sources.get(source)??0)+1);
      pool.devices.set(device,(pool.devices.get(device)??0)+1);
      pool.circles.set(circle,(pool.circles.get(circle)??0)+1);
      let released=false;
      return ()=>{
        if(released)return;released=true;pool.count--;
        for(const [map,key] of [[pool.sources,source],[pool.devices,device],[pool.circles,circle]]){
          const count=map.get(key)-1;if(count)map.set(key,count);else map.delete(key);
        }
      };
    },
    pending:kind=>pools.get(kind)?.count??0,
    reserveStorage(capacity,bytes) {
      // statfs reports the actual filesystem allocation unit and unprivileged
      // headroom. Reservations cover in-flight allocations across all circles.
      // Filesystems without inode accounting report files=0; bytes still gate.
      const block=BigInt(capacity.bsize),available=BigInt(capacity.bavail)*block;
      need(block>0n&&available>=0n);
      const content=BigInt(bytes),blocks=(content+block-1n)/block;
      const charge=(blocks>0n?blocks:1n)*block+2n*block;
      const inodeAware=BigInt(capacity.files)>0n;
      need(available-reservedBytes-charge>=freeBytes);
      if(inodeAware)need(BigInt(capacity.ffree)-reservedFiles-1n>=freeFiles);
      reservedBytes+=charge;reservedFiles++;
      let released=false;
      return ()=>{if(released)return;released=true;reservedBytes-=charge;reservedFiles--;};
    },
    enrollment:device=>charge('enrollments',device,bootstrap,window),
    bootstrapWork:source=>{
      // Admission of attempts, before body parsing or invite cryptography.
      // This may deny new joins during abuse; member service is independent.
      charge('bootstrapWork','host',work,window);
      charge('bootstrapWorkSources',source,workSource,window);
    },
    invite:code=>charge('invites',code,invites,inviteWindow),
    unknownInvite:source=>{
      // Unknown work has its own host and source budget. Valid codes never spend it.
      charge('unknownInvites','host',unknown,inviteWindow);
      charge('unknownInviteSources',source,unknown,inviteWindow);
    },
    failure:source=>{
      charge('failures','host',failures,window);
      charge('failureSources',source,failures,window);
    },
  };
}
