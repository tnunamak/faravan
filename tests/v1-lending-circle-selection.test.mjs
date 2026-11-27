import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';

test('explicitly select either joined circle while off; switching cannot move an enabled lender',async t=>{
 const f=await appFixture(t),{owner,lender,circle:first}=await f.connect();
 const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'My devices'}});
 const {invite}=await api(owner.app,'/api/circles/'+second.id+'/invite',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+second.id+'/approve',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/'+second.id+'/check',{method:'POST',body:{}});
 const selected=await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:second.id}});
 assert.equal(selected.circle,second.id);assert.equal(selected.enabled,false);
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 const on=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:second.id}});
 assert.equal(on.enabled,true);assert.equal(on.circle,second.id,'a networked circle named My devices is eligible');
 const blocked=await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:first.id},status:409});assert.equal(blocked.code,'lending_busy');
 await api(lender.app,'/api/lending/off',{method:'POST',body:{}});
 const changed=await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:first.id}});
 assert.equal(changed.enabled,false);assert.equal(changed.circle,first.id);
 const resumed=await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:first.id}});assert.equal(resumed.circle,first.id);
});

test('accepted work awaiting startup cannot move to another circle or leave its circle',async t=>{
 const f=await appFixture(t),{owner,lender,circle:first}=await f.connect();
 const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Second circle'}});
 const {invite}=await api(owner.app,'/api/circles/'+second.id+'/invite',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+second.id+'/approve',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/'+second.id+'/check',{method:'POST',body:{}});
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:first.id}});
 const file=join(lender.home,'v1','app-counters.json');
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 t.after(()=>rm(file,{force:true}));
 const accepted={circle:first.id,acceptedClaim:{jobDigest:'sha256:'+'a'.repeat(64),attempt:{attempt_id:'accepted-before-start'}}};
 await writeFile(file,JSON.stringify(accepted));
 for(const route of ['/api/lending/circle','/api/lending/on']){
  const refused=await api(lender.app,route,{method:'POST',body:{circle:second.id},status:409});
  assert.equal(refused.code,'lending_recovery_required');
 }
 const leave=await api(lender.app,'/api/circles/'+first.id+'/leave',{method:'POST',body:{},status:409});
 assert.equal(leave.code,'lending_recovery_required');
 await rm(file,{force:true});
 const changed=await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:second.id}});
 assert.equal(changed.circle,second.id);assert.equal(changed.enabled,false);
});

for(const where of ['root','account'])test('an open sandbox watch ('+where+') keeps its circle: no switch, leave or change',async t=>{
 const f=await appFixture(t),{owner,lender,circle:first}=await f.connect();
 const second=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Second circle'}});
 const {invite}=await api(owner.app,'/api/circles/'+second.id+'/invite',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/join',{method:'POST',body:{link:invite}});
 await api(owner.app,'/api/circles/'+second.id+'/approve',{method:'POST',body:{}});
 await api(lender.app,'/api/circles/'+second.id+'/check',{method:'POST',body:{}});
 await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:first.id}});
 const file=join(lender.home,'v1','app-counters.json');
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 t.after(()=>rm(file,{force:true}));
 const watch=[{attemptId:'watched-attempt',attempt:{attempt_id:'watched-attempt'}}];
 await writeFile(file,JSON.stringify({circle:first.id,...(where==='root'?{watchedStops:watch}:{accounts:{'codex:0':{watchedStops:watch}}})}));
 for(const route of ['/api/lending/circle','/api/lending/on']){
  const refused=await api(lender.app,route,{method:'POST',body:{circle:second.id},status:409});
  assert.equal(refused.code,'lending_recovery_required',route);
 }
 const leave=await api(lender.app,'/api/circles/'+first.id+'/leave',{method:'POST',body:{},status:409});
 assert.equal(leave.code,'lending_recovery_required');
 await rm(file,{force:true});
 const changed=await api(lender.app,'/api/lending/circle',{method:'POST',body:{circle:second.id}});
 assert.equal(changed.circle,second.id);
});

test('creating a circle keeps an unselected lending target across restart',async t=>{
 const f=await appFixture(t),first=await f.start('creator');
 await f.provisionFromHome('creator');
 await api(first.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 const before=await api(first.app,'/api/lending/on',{method:'POST',body:{}});
 assert.equal(before.circle,null);
 const created=await api(first.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Created circle'}});
 const after=await api(first.app,'/api/lending');
 assert.equal(after.circle,before.circle,'creation must not adopt the new lending target');
 await first.app.close();
 const restarted=await f.start('creator');
 const restored=await api(restarted.app,'/api/lending');
 assert.equal(restored.circle,null);assert.equal(restored.enabled,false);
 assert.equal(f.networkTrace.some(entry=>entry.device==='creator'&&entry.route.endsWith('/offers')),false);
 await api(restarted.app,'/api/lending/off',{method:'POST',body:{}});
 const selected=await api(restarted.app,'/api/lending/circle',{method:'POST',body:{circle:created.id}});
 assert.equal(selected.circle,created.id);assert.equal(selected.enabled,false);
});

test('saving rules does not turn an unset circle mode into a saved Ask choice',async t=>{
 const f=await appFixture(t),{lender,circle}=await f.connect();
 const file=join(lender.home,'v1','app-settings.json');
 await lender.app.close();
 const saved=JSON.parse(await readFile(file,'utf8'));
 delete saved.modes[circle.id];
 if(saved.appRuleIds)delete saved.appRuleIds[circle.id];
 if(saved.pendingJoinedDefaults)delete saved.pendingJoinedDefaults[circle.id];
 saved.standingRules=saved.standingRules.filter(rule=>rule.circle!==circle.id);
 await writeFile(file,JSON.stringify(saved));

 const reopened=await f.start('lender');
 const mode=async()=> (await api(reopened.app,'/api/home')).circles.find(row=>row.id===circle.id).lendingMode;
 assert.equal(await mode(),'auto');
 await api(reopened.app,'/api/lending/rules',{method:'POST',body:{rules:saved.standingRules}});
 assert.equal(await mode(),'auto');
 await api(reopened.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(reopened.app,'/api/lending/rules',{method:'POST',body:{rules:saved.standingRules}});
 assert.equal(await mode(),'ask');
});
