import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import * as p from '../protocol/index.mjs';
import {openV1Store} from './store.mjs';
import {createV1Handler} from './server.mjs';

/** The owner-offline serving endpoint (design 1119, authorized topology): when the current signed
 *  roster records this device's own serving origin, the app serves that circle from a durable
 *  member store mounted on its own HTTP server. The store is provisioned from the verified cached
 *  roster - the root-signed authority this device already accepted - recovers from disk across
 *  restarts, and is refreshed to the newest roster this device accepted (an owner-signed roster
 *  body authorizes its own installation; the member's request only carries it). Serving is reach
 * data: it never grants membership or signing authority, and dispatch still waits for a job that
 * names this member as its designated member. */
export function createMemberServing({home,device,now=()=>Math.floor(Date.now()/1000)}={}) {
  const serving=new Map();
  let closed=false;
  const directory=join(home,'v1','member-stores');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const proofFor=(circleId,origin,roster)=>({proof:p.buildRequestProof({circle:circleId,roster_epoch:roster.payload.epoch,
    method:'PUT',target:origin+'/v1/circles/'+circleId+'/roster',body:Buffer.from(p.canonicalize(roster)),
    content_type:'application/json',artifact_media_type:'',idempotency_key:'',created:now(),
    nonce:randomBytes(24).toString('base64url')},device.deviceKey.privateKey??device.deviceKey,
    {lanMode:roster.payload.lan_mode===true})});
  /** The handler for the device's current serving origin and installed roster. */
  async function ensure(circleId) {
    if(closed)return null;
    const circle=await device.selectCircle(circleId);
    const snapshot=await device.rosterCache(circleId).get();
    const roster=snapshot?.current??null;
    const entry=roster?p.findMember(roster.payload,device.keyId):null;
    let existing=serving.get(circleId);
    if(closed||!entry?.origin||(existing&&existing.origin!==entry.origin))return null;
    if(!existing) {
      const store=openV1Store({path:join(directory,circleId+'.sqlite'),origin:entry.origin,circle:circleId,
        rootFingerprint:circle.pinnedRootFingerprint,initialRoster:roster,clock:now});
      const handler=createV1Handler({store,blobDir:join(directory,'blobs-'+circleId),clock:now});
      existing={store,handler,epoch:store.configuration().epoch,origin:entry.origin};
      serving.set(circleId,existing);
    }
    // Serve the current signed roster: a newer accepted roster is installed through the store's own
    // route, carried by this member's request and authorized by the roster's owner signature.
    if(roster.payload.epoch>existing.epoch) {
      try {
        existing.store.installRoster(roster,proofFor(circleId,existing.origin,roster));
        existing.epoch=roster.payload.epoch;
      } catch { return null; }
    }
    return existing.epoch===roster.payload.epoch?existing.handler:null;
  }
  /** Stop whatever the handlers still hold (request bodies, parked polls) and refuse new lookups. It does
   *  not touch the stores: the caller drains admitted requests first. Safe to call more than once. */
  function quiesce() {
    closed=true;
    for(const entry of serving.values()) {
      if(entry.quiesced)continue;
      entry.quiesced=true;entry.handler.close?.();
    }
  }
  return {ensure,quiesce,
    async close(){quiesce();for(const {store} of serving.values())store.close();serving.clear();}};
}
