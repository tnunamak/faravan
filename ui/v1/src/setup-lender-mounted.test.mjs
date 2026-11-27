import './mounted.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Setup} from './setup.jsx';
import {mount,resetPage,teardown,click,installClock,advance} from './mounted.test-helper.mjs';

const circle={id:'friends',name:'Friends',origin:'https://circle.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
const baseAgent={id:'codex',installed:true,signedIn:true,useForLending:true,signInSupported:true};
const reading={agents:[{id:'codex',hasReading:true,checks:[{id:'signed_in',state:'pass'}]}]};
function props(platform,state,api={get:async()=>reading,post:async()=>({phase:'installed'})}) {
 const agent={...baseAgent,signedIn:state!=='agent'};
 const checks=[{name:'sbx_install',ok:state!=='install',remedy:state!=='install'?'':platform==='mac'?'brew install docker/tap/sbx':'sudo apt install docker-sbx'},
  {name:'sbx_daemon',ok:state!=='install'},{name:'docker_login',ok:!['install','docker'].includes(state)},
  {name:'test_workspace',ok:state==='ready',unknown:state==='check'}];
 return {api,agents:[agent],circles:[circle],circle:circle.id,lending:{enabled:false,circle:circle.id},mutate:async()=>({}),refresh:async()=>{},phone:false,
  data:{agents:[agent],readiness:{ready:state==='ready',checks},lendingReadiness:reading,home:{desktop:{platform},lending:{enabled:false}},devices:{}}};
}
for(const platform of ['mac','linux'])for(const state of ['install','docker','agent','check','ready'])
 test(`${platform} lender list has one current step in ${state}`,async t=>{
  t.after(teardown);resetPage();
  const view=await mount(h(Setup,props(platform,state)));
  const current=view.$$('.setup-steps [aria-current="step"]');
  assert.equal(current.length,state==='ready'?0:1);
  const titles=view.$$('.setup-steps h3').map(node=>node.textContent);
  assert.deepEqual(titles,state==='install'?['Install the sandbox','Sign in to Docker','Sign in to your agent','Check']:['Sign in to Docker','Sign in to your agent','Check']);
  if(platform==='mac')assert.equal(view.$('.setup-current .cmd'),null,'required Mac steps have no command to copy');
  if(state==='install')assert.ok(platform==='mac'?view.button('Install the sandbox'):view.$('.setup-current .cmd'));
  if(state==='check')assert.doesNotMatch(view.$('.setup-current').textContent,/Ready|Try a protected job/);
  assert.equal(/Your computer is ready/.test(view.text()),state==='ready');
 });
test('Mac install button reports failure and allows a retry',async t=>{
 t.after(teardown);resetPage();let attempts=0;
 const api={get:async path=>path==='setup/install-sandbox'?{phase:'idle'}:reading,
  post:async path=>{assert.equal(path,'setup/install-sandbox');if(++attempts===1)throw Error('Download failed. Retry.');return {phase:'installed'};}};
 const view=await mount(h(Setup,props('mac','install',api)));
 await click(view.button('Install the sandbox'));
 assert.match(view.text(),/installation did not finish/);
 await click(view.button('Retry installation'));
 assert.equal(attempts,2);
});
test('a fresh Mac can sign in to a lending agent without a host CLI install',async t=>{
 t.after(teardown);resetPage();
 const p=props('mac','agent');
 p.agents=[{...baseAgent,installed:false,signedIn:false,useForLending:false,lendingSignInTarget:'codex-lending',lendingSignInSupported:true}];
 p.data.agents=p.agents;
 const view=await mount(h(Setup,p));
 assert.match(view.$('.setup-current').textContent,/Choose the agent you want to lend/);
 assert.ok(view.button('Sign in to Codex'));
 assert.equal(view.$('.setup-current .cmd'),null);
 assert.doesNotMatch(view.$('.setup-current').textContent,/npm|brew|terminal|How to install/);
});
test('an existing agent is selected explicitly through the same lending API',async t=>{
 t.after(teardown);resetPage();const calls=[];
 const p=props('mac','ready');
 p.agents=[{...baseAgent,useForLending:false}];p.data.agents=p.agents;
 p.mutate=async(...args)=>{calls.push(args);return [];};
 const view=await mount(h(Setup,p));
 await click(view.button('Lend with Codex'));
 assert.deepEqual(calls,[['agents/codex',{useForLending:true}]]);
});
test('the protected check starts automatically after sign-ins and cannot be called ready while pending',async t=>{
 t.after(teardown);resetPage();const calls=[];
 const p=props('mac','check',{get:async path=>{calls.push(path);return reading;}});
 p.data.readiness.ready=true; // A stale ready flag must not override the pending test row.
 const view=await mount(h(Setup,p));
 assert.ok(calls.includes('readiness?refresh=true'));
 assert.doesNotMatch(view.text(),/Your computer is ready|The protected test passed/);
 assert.equal(view.$('.setup-current h2').textContent,'Check');
});
test('reopening Mac Setup shows the active download progress',async t=>{
 t.after(teardown);resetPage();
 const p=props('mac','install',{get:async path=>path==='setup/install-sandbox'?{phase:'downloading',received:12,total:24}:reading});
 const view=await mount(h(Setup,p));
 const progress=view.$('progress[aria-label="Sandbox installation"]');
 assert.ok(progress);assert.equal(progress.getAttribute('value'),'12');assert.equal(progress.getAttribute('max'),'24');
 assert.match(view.$('.setup-current').textContent,/Downloading the sandbox from Docker/);
});

test('Intel Mac explains Apple silicon is required without an install button',async t=>{
 t.after(teardown);resetPage();const p=props('mac','install');p.data.home.desktop.arch='x64';
 const view=await mount(h(Setup,p));
 assert.match(view.text(),/Lending from this Mac needs Apple silicon/);
 assert.equal(view.button('Install the sandbox'),null);
 assert.equal(view.$('.cmd'),null);
});
test('Check waits until the open agent sign-in finishes despite refreshed credentials',async t=>{
 t.after(teardown);resetPage();installClock();const original=window.open;window.open=()=>({});t.after(()=>{window.open=original;});
 const calls=[];
 let flow={flowId:'signing',target:'codex',status:'awaiting_browser',url:'https://login.test/'};
 const p=props('mac','agent',{get:async path=>{calls.push(path);return path.startsWith('signin/')?flow:reading;},post:async()=>flow});
 const view=await mount(h(Setup,p));await click(view.button('Sign in to Codex'));
 const ready=props('mac','check',p.api);
 await view.rerender(h(Setup,ready));
 assert.equal(calls.includes('readiness?refresh=true'),false);
 assert.match(view.$('.setup-current').textContent,/Waiting|sign-in|Sign in/);
 flow={...flow,status:'complete'};await advance(6000);
 await view.rerender(h(Setup,ready));
 assert.equal(calls.includes('readiness?refresh=true'),true,'the completed sign-in releases Check');
});

for(const platform of ['mac','linux'])for(const problem of ['circle','kvm_access','network_policy','sbx_daemon','sbx_version'])
 test(platform+' keeps '+problem+' in its own step without starting the protected test',async t=>{
 t.after(teardown);resetPage();const calls=[];
 const p=props(platform,'ready',{get:async path=>{calls.push(path);return reading;}});
 p.data.readiness.ready=false;
 const titles={circle:'Circle membership',kvm_access:'Permission to run sandboxes',network_policy:'Network rules',sbx_daemon:'Start the sandbox',sbx_version:'Sandbox version'};
 if(problem==='circle')p.circles=[];
 else {
  p.data.readiness.checks=p.data.readiness.checks.filter(c=>c.name!==problem);
  p.data.readiness.checks.push({name:problem,ok:false,label:titles[problem],
   remedy:problem==='sbx_version'?'Update Docker Sandboxes to 0.51.0 or newer. sudo apt upgrade docker-sbx':problem==='kvm_access'?'sudo usermod -aG kvm $USER':problem==='sbx_daemon'?'sbx daemon start':'Reset sandbox network rules'});
 }
 if(['circle','kvm_access','network_policy'].includes(problem)) {
  const workspace=p.data.readiness.checks.find(c=>c.name==='test_workspace');
  Object.assign(workspace,{ok:false,unknown:true});
 }
 const view=await mount(h(Setup,p));
 assert.equal(calls.includes('readiness?refresh=true'),false);
 assert.equal(view.$$('.setup-steps [aria-current="step"]').length,1);
 const current=view.$('.setup-current');
 if(problem==='sbx_version'&&platform==='mac')assert.equal(current.querySelector('h2').textContent,'Install the sandbox');
 else {
  assert.doesNotMatch(current.querySelector('h2').textContent,/Sign in to Docker|^Check$/);
  if(problem==='sbx_daemon')assert.equal(current.querySelector('h2').textContent,'Start the sandbox');
  if(problem==='sbx_version')assert.match(current.textContent,/sudo apt upgrade docker-sbx/);
 }
 if(platform==='mac')assert.equal(current.querySelector('.cmd'),null);
});
test('Mac download can be cancelled from the mounted Setup step',async t=>{
 t.after(teardown);resetPage();const posts=[];
 const p=props('mac','install',{get:async path=>path==='setup/install-sandbox'?{phase:'downloading',received:1,total:10}:reading,
  post:async(path,body)=>{posts.push([path,body]);return {phase:'idle',message:'Installation cancelled.'};}});
 const view=await mount(h(Setup,p));
 assert.ok(view.button('Cancel'));
 await click(view.button('Cancel'));
 assert.deepEqual(posts.filter(([path])=>path.startsWith('setup/')),[['setup/cancel-sandbox',{}]]);
 assert.match(view.text(),/Installation cancelled/);
 assert.equal(view.$('progress[aria-label="Sandbox installation"]'),null);
 assert.equal(view.button('Install the sandbox').disabled,false);
});
test('busy install refusal tells the person to finish sign-in or wait for the job',async t=>{
 t.after(teardown);resetPage();
 const p=props('mac','install',{get:async()=>({phase:'idle'}),post:async()=>{throw Object.assign(Error('busy'),{code:'sandbox_not_ready',status:409});}});
 const view=await mount(h(Setup,p));await click(view.button('Install the sandbox'));
 assert.match(view.text(),/Finish the sign-in or wait for the job, then try again/);
});
test('required Mac disk help contains no prune commands',async t=>{
 t.after(teardown);resetPage();
 const p=props('mac','ready');p.data.readiness.ready=false;
 p.data.readiness.checks.push({name:'host_disk',ok:false,label:'Not enough disk space',remedy:'Free disk space.'});
 p.data.home.lending_blockers={canLend:false,items:[{key:'readiness_requirement',cause:'host_disk',status:'blocked',label:'Disk space',detail:'Free disk space.',action:'Open Settings',disk:{reclaim:{docker:{command:'docker system df -v',items:[{kind:'image',name:'unused',size:'3GB',command:'docker image prune'}]}}}}]};
 p.data.home.lending_blockers.items.unshift(
  {key:'docker_installed',status:'ok',label:'Docker Sandboxes',detail:'Installed and running.'},
  {key:'docker_signin',status:'ok',label:'Docker sign-in',detail:'Signed in.'},
  {key:'agent',agent:'codex',status:'ok',label:'Codex',detail:'Ready.'});
 const view=await mount(h(Setup,p));
 assert.match(view.$('.setup-current').textContent,/Free space on this Mac/);
 assert.doesNotMatch(view.$('.setup-current').textContent,/docker .*prune|sbx .*prune/);
 assert.equal(view.$('.setup-current .cmd'),null);
});
