// The tray is inside the desktop session; daemon environment variables do not
// prove that anyone is present. Unknown/stale observations never mean away.
export function createOwnerPresence({now=Date.now,awayAfterSeconds=300,maxAgeMs=60000}={}) {
 let observedAt=null,idleSeconds=null,lastActive=null;
 return {
  report(input){
   if(!input||Object.keys(input).some(k=>k!=='idleSeconds')||!(input.idleSeconds===null||Number.isFinite(input.idleSeconds)&&input.idleSeconds>=0&&input.idleSeconds<=31536000))throw new Error('invalid_presence');
   observedAt=now();idleSeconds=input.idleSeconds;
   if(idleSeconds!==null&&idleSeconds<awayAfterSeconds)lastActive=observedAt;
  },
  active(){return observedAt===null||now()-observedAt>maxAgeMs||now()<observedAt||idleSeconds===null?null:idleSeconds<awayAfterSeconds;},
  lastActiveAt(){return lastActive;},
  snapshot(){return {active:this.active(),observed_at:observedAt,last_active_at:lastActive};}
 };
}
