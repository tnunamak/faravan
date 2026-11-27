// Real process boundaries: coordinator, owner app and lender app run in separate Node processes.
// Synthetic provider only; all homes and network traffic belong to this disposable fixture.
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appFixture,syntheticBackend,adapters,api} from '../helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from '../helpers/pace50-synthetic-source.mjs';
import {startApp} from '../../lib/v1/app.mjs';
import {json} from '../helpers/v1-journey.mjs';
const role=process.argv[2];
if(role==='coordinator'){
 const clean=[];const f=await appFixture({after:fn=>clean.push(fn)});
 await f.provisionFromHome('owner');
 // This fixture advertises the current host capabilities. Preserve signed
 // post-membership profiles in presence just as that host contract requires.
 const profiles=new Map(),heartbeats=new Map(),previous=f.override;
 f.override=async ctx=>{
  const key=ctx.req.headers['faravan-proof']?JSON.parse(Buffer.from(ctx.req.headers['faravan-proof'],'base64url')).payload.key_id:null;
  if(ctx.route==='/heartbeat'){
   const id=ctx.circleId+':'+key;
   if(ctx.body.profile)profiles.set(id,{body:ctx.body,proof:ctx.req.headers['faravan-proof']});
   heartbeats.set(id,ctx.body);
  }
  if(ctx.route==='/presence'){
   const now=new Date().toISOString(),members=f.circles.get(ctx.circleId)?.roster.payload.members??[];
   json(ctx.res,{now,online_seconds:90,persons:[],devices:members.map(m=>{
    const id=ctx.circleId+':'+m.key_id,hb=heartbeats.get(id),profile=profiles.get(id);
    return {device:m.key_id,online:Boolean(hb),source:hb?'heartbeat':'none',last_heartbeat_at:hb?now:null,
      intent:hb?.intent??null,execution:hb?.execution??null,agents:hb?.agents??[],blockers:hb?.blockers??[],
      capabilities:hb?.capabilities??[],member_capabilities:hb?.capabilities??[],...(profile?{member_profile:profile}:{})};
   })});return true;
  }
  return previous(ctx);
 };
 process.on('disconnect',async()=>{for(const fn of clean.reverse())await fn();process.exit(0);});
 process.send({origin:f.origin,root:f.root,ownerHome:await f.home('owner'),lenderHome:await f.home('lender'),pid:process.pid});
 process.on('message',async m=>{if(m==='stop'){for(const fn of clean.reverse())await fn();process.exit(0);}});
}else if(role==='app'){
 const [home,root,name]=process.argv.slice(3),holdOptions={hold:true},backend=syntheticBackend(root,holdOptions);
 backend.probeCapabilities=async()=>({available:true,preflight:{ok:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]}});
 const app=await startApp({home,origin:null,port:0,token:'synthetic-r6-'+name,backendFactory:async()=>backend,adapters:adapters(),lendingPace50:{source:createSyntheticPace50Source({start:Date.now()}),account_week_id:'synthetic-week-1'},pollMs:1000,autoApprove:false,joinWaitMs:0,approvalPollMs:1000,quotaReader:async()=>({remaining:100,observedAt:Date.now()}),idleReader:async()=>false,signInProbe:async()=>({signedIn:null,source:'unavailable'}),identityProbe:async({harnessNames})=>({providers:harnessNames.map(harness_id=>({harness_id,installed:true,signedIn:true}))})});
 process.on('disconnect',async()=>{await app.close();process.exit(0);});
 process.send({origin:app.origin,token:app.token,pid:process.pid});
 process.on('message',async m=>{if(m==='release'){holdOptions.hold=false;backend.release();}if(m==='stop'){await app.close();process.exit(0);}});
}else{
 const children=[];
 const isolation=await mkdtemp(join(tmpdir(),'faravan-r6-processes-'));
 async function launch(args){
  const root=join(isolation,String(children.length));
  const env={...process.env,HOME:join(root,'home'),FARAVAN_HOME:args[0]==='app'?args[1]:join(root,'faravan'),CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''};
  await Promise.all(['HOME','FARAVAN_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR'].map(key=>mkdir(env[key],{recursive:true})));
  const child=fork(new URL(import.meta.url),args,{stdio:['ignore','ignore','inherit','ipc'],env});children.push(child);return {child,info:await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(([code])=>{throw Error('fixture exited '+code);})])};
 }
 const coordinator=await launch(['coordinator']),c=coordinator.info;
 const owner=await launch(['app',c.ownerHome,c.root,'owner']),lender=await launch(['app',c.lenderHome,c.root,'lender']);
 await api(owner.info,'/api/devices',{method:'POST',body:{name:'sandpiper',ownerName:'Alex Example'}});
 await api(lender.info,'/api/devices',{method:'POST',body:{name:'kestrel',ownerName:'Maya Okafor'}});
 const control=createServer((req,res)=>{if(req.url==='/release')lender.child.send('release');res.writeHead(204).end();});control.listen(0,'127.0.0.1');await once(control,'listening');
 console.log(JSON.stringify({owner:owner.info.origin,lender:lender.info.origin,ownerApi:owner.info,lenderApi:lender.info,queue:c.origin,control:'http://127.0.0.1:'+control.address().port,pids:[c.pid,owner.info.pid,lender.info.pid]}));
 let stopped=false;async function stop(){if(stopped)return;stopped=true;control.closeAllConnections();control.close();for(const child of children.reverse()){if(child.exitCode===null){child.send('stop');await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},5000))]);}}await rm(isolation,{recursive:true,force:true});process.exit(0);}
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
