import {randomBytes} from 'node:crypto';
import * as p from '../protocol/index.mjs';

// Reuse the v1 request signature domain. The current circle signer authorizes one exact, monotonic
// action; the normal member HTTP proof still authenticates and meters the request.
function authorization({circle,origin,epoch,route,field,id,now,rootKey,lanMode}) {
  const bytes=Buffer.from(p.canonicalize({[field]:id}));
  return {[field]:id,authorization:p.buildRequestProof({circle,roster_epoch:epoch,
    method:'POST',target:origin+'/v1/circles/'+circle+route,body:bytes,
    content_type:'application/json',created:now,nonce:randomBytes(16).toString('base64url'),
    idempotency_key:id},rootKey,{lanMode})};
}
function verifyAuthorization(body,{circle,origin,roster,now,lanMode=false,route,field}) {
  const bytes=Buffer.from(p.canonicalize({[field]:body[field]}));
  let publicKey;
  try{const request=p.strictParse(p.decodeBase64url(body.authorization));publicKey=p.circleDocumentSigner(roster,request.signature.key_id);}catch{return {ok:false,code:'forbidden'};}
  return p.verifyRequestProofSync(body.authorization,{publicKey,now:()=>now,lanMode,
    // Replaying this authorization can only repeat the same irreversible decision.
    consumeNonce:()=>true,expected:{circle,key_id:p.fingerprint(publicKey),roster_epoch:roster.epoch,
      method:'POST',target:origin+'/v1/circles/'+circle+route,body_digest:p.digestBytes(bytes),
      content_length:bytes.length,content_type:'application/json',artifact_media_type:'',idempotency_key:body[field]}});
}
const INVITE={route:'/invites/revoke',field:'invite_id'},ENROLLMENT={route:'/enrollments/reject',field:'enrollment_id'};
export function invitationRevocation({inviteId,lanMode=false,...rest}) {
  return authorization({...rest,...INVITE,id:inviteId,lanMode});
}
export function verifyInvitationRevocation(body,options) {
  return verifyAuthorization(body,{...options,...INVITE});
}
// An owner's decline of one join request, recorded by the coordinator so the joining computer sees it too.
export function enrollmentRejection({enrollmentId,lanMode=false,...rest}) {
  return authorization({...rest,...ENROLLMENT,id:enrollmentId,lanMode});
}
export function verifyEnrollmentRejection(body,options) {
  return verifyAuthorization(body,{...options,...ENROLLMENT});
}
