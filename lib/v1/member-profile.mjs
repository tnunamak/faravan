import * as p from '../protocol/index.mjs';

/** A retained heartbeat proof binds the display claim to its member, circle and exact body. */
export function verifyMemberProfile(profile,{circle,origin,member}={}) {
  try {
    if(!profile||Object.keys(profile).length!==2||!Object.hasOwn(profile,'body')||typeof profile.proof!=='string')return null;
    const {body,proof}=profile;
    const signed=p.strictParse(p.decodeBase64url(proof));
    const result=p.verifyEnvelope('request',signed,member.public_key);
    if(!result.ok)return null;
    const request=result.payload;
    if(request.circle!==circle||request.key_id!==member.key_id||request.roster_epoch<member.joined_epoch||
      request.method!=='POST'||request.target!==origin+'/v1/circles/'+circle+'/heartbeat'||
      request.content_type!=='application/json'||request.body_digest!==p.digest(body)||
      request.content_length!==Buffer.byteLength(p.canonicalize(body)))return null;
    if(!body||Object.keys(body).length!==2||!Array.isArray(body.capabilities)||
      !body.profile||Object.keys(body.profile).length!==2)return null;
    if(body.capabilities.length>32||new Set(body.capabilities).size!==body.capabilities.length||
      !body.capabilities.every(c=>typeof c==='string'&&/^[a-z0-9_]{1,40}$/.test(c)))return null;
    if(!Number.isSafeInteger(body.profile.revision)||body.profile.revision<0)return null;
    p.checkDeviceName(body.profile.person_name);
    return {name:body.profile.person_name,revision:body.profile.revision};
  } catch {return null;}
}
