import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {hostingError,publishedOrigin} from '../coordinator-hosting.mjs';

const closing=()=>hostingError('operation_conflict','Member exposure was stopped; wait for exact cleanup before publishing again.');

/** The member's own Gozar route lifecycle (owner-offline topology). The route targets exactly this app's
 *  protocol-only member listener, under an owner scope of its own (see `memberHosting`), through the shared
 *  hosting wrapper: the wrapper validates route proof, owns the cleanup journal, and enforces consent.
 *
 *  App code sees an origin only while a usable, fresh proof names that exact target, handle and generation;
 *  it is withdrawn the moment the route is lost or the proof lapses. `retire` is the listener's shutdown hook:
 *  it fences first, so a start still in flight can publish nothing, and then removes the exact owned route,
 *  including one a late start returned, or keeps its owner/operation/handle on disk for the next open. */
export function createMemberExposure({hosting,listener,onChange=()=>{},recheckMs=250,startSettleMs=10000}={}) {
  let fenced=false,generation=0,starting=null,recovering=null,retiring=null;
  let held=null,heldTarget=null,heldOrigin=null,lastOrigin=null,watching=null;

  const published=()=>heldOrigin&&publishedOrigin(held,heldTarget)===heldOrigin?heldOrigin:null;
  const announce=()=>{try{onChange(published());}catch{/* a consumer failure never changes route ownership */}};
  function withdraw() {
    watching?.abort();watching=null;
    const had=held!==null;
    held=null;heldTarget=null;heldOrigin=null;
    if(had)announce();
  }
  const bindingFor=target=>createHash('sha256').update('member-protocol-listener:v1\n'+target).digest('hex');

  /** The listener's exact target and the spec an exposure route must serve. A saved selection keeps its own
   *  spec (it carries the pinned origin) but must still name this listener's target. */
  async function prepare(selection={}) {
    if(fenced)throw closing();
    const {target}=await listener().start();
    if(fenced)throw closing();
    const saved=hosting.read();
    if(saved&&(saved.spec.target!==target||selection.providerId&&saved.spec.providerId!==selection.providerId))
      throw hostingError('operation_conflict','The saved member exposure has a different target or offer.');
    const spec=saved?.spec??{target,reach:'internet',address:'stable',usage:selection.usage??'durable',protocols:[],
      ...(selection.providerId&&{providerId:selection.providerId})};
    return {spec,target,approvalBinding:bindingFor(target)};
  }
  async function offers(selection={}) {
    const {spec,approvalBinding}=await prepare(selection);
    const rows=await hosting.offers(spec);
    if(fenced)throw closing();
    return {status:'approval_required',spec,approvalBinding,offers:rows.map(({approval,...offer})=>offer)};
  }
  /** Record the member's consent to exactly the offer they reviewed. Nothing is installed here. */
  async function approve({providerId,consentFactsDigest,...selection}={}) {
    const {spec,approvalBinding}=await prepare({...selection,providerId});
    // Remove a lost or retained route first, so the consent below is the one a new start consumes.
    await recover();
    const offer=(await hosting.offers(spec)).find(row=>(providerId===undefined||row.providerId===providerId)&&
      row.consent.consentFactsDigest===consentFactsDigest);
    if(!offer)throw hostingError('candidate_stale','The exposure offer changed. Review it again.');
    if(fenced)throw closing();
    await hosting.select(spec,offer);
    await hosting.authorize(offer.consent.consentFactsDigest,{binding:approvalBinding});
    return {status:'approved',approvalBinding};
  }

  /** Remove a route a previous process left behind (an unconfirmed close or a crash). It runs before any
   *  start, so a new route can never share state with an old unconfirmed one. */
  function recover() {
    if(recovering)return recovering;
    const saved=hosting.read();
    if(!saved?.handle||held)return Promise.resolve(null);
    const work=hosting.shutdown({origin:saved.spec.origin}).finally(()=>{if(recovering===work)recovering=null;});
    recovering=work;
    return work;
  }

  function supervise(route,target,origin,gen) {
    const watch=new AbortController();
    watching=watch;
    const retained=structuredClone(hosting.read());
    const active=()=>!watch.signal.aborted&&gen===generation&&!fenced;
    const update=view=>{
      if(!active())return false;
      if(isDeepStrictEqual(view?.handle,route.handle)&&view?.operationId===route.operationId&&publishedOrigin(view,target)===origin) {
        held=view; // only new verified evidence refreshes the proof deadline
        return true;
      }
      withdraw();
      return false;
    };
    void (async()=>{
      while(active()) {
        if(publishedOrigin(held,target)!==origin){update(null);return;}
        try {
          for await(const view of hosting.watch(route,watch.signal))if(!update(view))return;
        } catch { /* a failed transport is not authoritative route loss */ }
        if(!active())return;
        // Recheck the captured owner and handle, never a replacement selected on disk.
        let view;
        const observation=new AbortController();
        const abort=()=>observation.abort();
        watch.signal.addEventListener('abort',abort,{once:true});
        try {
          const remaining=Date.parse(held.verification.validUntil.value)-Date.now();
          view=await Promise.race([hosting.status(retained),delay(Math.max(0,Math.min(5000,remaining)),null,{signal:observation.signal})]);
        } catch {if(active())update(null);return;}
        finally {watch.signal.removeEventListener('abort',abort);observation.abort();}
        if(!active()||!update(view))return;
        try {await delay(recheckMs,undefined,{signal:watch.signal});}
        catch {return;}
      }
    })();
  }

  /** Install and verify the route for this listener. An unapproved selection never reaches the provider.
   *  `fence`/`retire` win over every stage: a result that returns after them is never published. */
  function start() {
    if(fenced)return Promise.reject(closing());
    if(starting)return starting;
    const gen=generation;
    const current=()=>{if(gen!==generation||fenced)throw closing();};
    const work=(async()=>{
      await recovering?.catch(()=>{});
      current();
      const saved=hosting.read();
      if(saved?.handle&&!held) {
        await recover(); // exact removal first; unconfirmed debt stops the start with the retained handle
        current();
      }
      const {spec,target,approvalBinding}=await prepare();
      current();
      const selected=hosting.read();
      if(!selected)throw hostingError('consent_required','Review and approve an exposure offer.');
      if(JSON.stringify(selected.spec)!==JSON.stringify(spec))throw hostingError('operation_conflict','The saved member exposure has a different target or offer.');
      const route=await hosting.start(undefined,{binding:approvalBinding,explicit:true,assertCurrent:current,beforeMutation:current});
      current();
      const origin=publishedOrigin(route,target);
      if(!origin)throw hostingError('verification_failed','Gozar has not verified the member address.',{route});
      held=route;heldTarget=target;heldOrigin=origin;lastOrigin=origin;
      supervise(route,target,origin,gen);
      announce();
      return {status:'published',origin,route:{handle:route.handle,operationId:route.operationId}};
    })();
    const entry=work.finally(()=>{if(starting===entry)starting=null;});
    starting=entry;
    return entry;
  }

  /** Stop publishing now, then remove exactly the owned route. A failure keeps owner, operation and handle on disk. */
  function retire() {
    fenced=true;generation++;
    withdraw();
    if(retiring)return retiring;
    const work=(async()=>{
      // Let an in-flight start settle (bounded): whatever it installed is owned and removed below. A start that
      // outlives the bound still holds the hosting lock, so the removal waits for it and then sees its handle.
      await Promise.race([Promise.allSettled([starting,recovering]),delay(startSettleMs)]);
      return hosting.shutdown({origin:lastOrigin??undefined});
    })();
    retiring=work.catch(error=>{retiring=null;throw error;});
    return retiring;
  }
  function fence() {fenced=true;generation++;withdraw();}

  /** The only route facts a proposal may carry: the exact verified origin, its handle generation and when its
   *  proof lapses. Null unless a fresh usable proof names this exact target right now; nothing is kept across a restart. */
  function evidence() {
    const origin=published();
    if(!origin)return null;
    return {origin,generation:held.handle.generation,validUntilSeconds:Math.floor(Date.parse(held.verification.validUntil.value)/1000)};
  }

  /** What the member's page may know about the route: never the handle, target or provider ids. `approved` means a
   *  consent is recorded and the next start will use it; `lost` means a verified address stopped working. */
  function status() {
    const origin=published();
    return {state:fenced?'retiring':starting?'starting':origin?'published':'idle',origin,
      approved:Boolean(hosting.read()?.pendingApproval),lost:!origin&&lastOrigin!==null&&!starting};
  }

  return {offers,approve,start,recover,retire,fence,origin:published,evidence,status,
    get state(){return fenced?'retiring':starting?'starting':published()?'published':'idle';}};
}
