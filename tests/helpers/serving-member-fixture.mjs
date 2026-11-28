import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createPrivateKey,randomBytes} from 'node:crypto';
import * as protocol from '../../lib/protocol/index.mjs';

// Publish the synthetic lender's real member endpoint in the owner-signed roster.
export async function installServingMember({f,owner,lender,circle}){
 const origin='http://127.0.0.1:'+(await lender.app.memberListener.start()).port;
 const current=(await owner.app.device.rosterCache(circle.id).get()).current;
 const members=current.payload.members.map(member=>member.key_id===lender.app.device.keyId?{...member,origin}:member);
 const key=createPrivateKey(await readFile(join(await f.home('owner'),'v1','roots',circle.id+'.pem'),'utf8'));
 const roster=protocol.signEnvelope('roster',{...current.payload,epoch:current.payload.epoch+1,members},key);
 const proof=protocol.buildRequestProof({circle:circle.id,roster_epoch:roster.payload.epoch,method:'PUT',
  target:circle.origin+'/v1/circles/'+circle.id+'/roster',body:Buffer.from(protocol.canonicalize(roster)),content_type:'application/json',
  artifact_media_type:'',idempotency_key:'',created:Math.floor(Date.now()/1000),nonce:randomBytes(24).toString('base64url')},
  owner.app.device.deviceKey.privateKey??owner.app.device.deviceKey);
 const response=await fetch(circle.origin+'/v1/circles/'+circle.id+'/roster',{method:'PUT',headers:{'content-type':'application/json','faravan-proof':proof},body:protocol.canonicalize(roster)});
 assert.equal(response.status,200,'the owner-signed serving origin installs');
 await owner.app.device.rosterCache(circle.id).set({current:roster,history:[],highestAcceptedEpoch:roster.payload.epoch,highestAcceptedDigest:protocol.digest(roster.payload)});
 await lender.app.device.refreshRoster(circle.id);
 return origin;
}
