import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
test.use({timezoneId:'America/Chicago'});
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const at='2026-10-20T07:14:00Z';
const passedRun={id:'run-1',state:'passed',at,current:{runId:'run-1',at,configuration:{
 versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex'],
}}};
const passedRunAt=observed=>({...passedRun,at:observed,current:{...passedRun.current,at:observed}});
async function fixture(page) {
 await page.route('**/api/home',r=>r.fulfill({json:{lending:{enabled:true,circle:'shared',status:'idle'}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
}
test('readiness Check again forces refresh, stays pending, and shows the observed time',async({page})=>{
 await fixture(page);let release;const gate=new Promise(resolve=>{release=resolve;});let forced=0;
 await page.route('**/api/readiness?refresh=true',async r=>{forced++;await gate;await r.fulfill({json:{ready:true,protection:{observed_at:at}}});});
 await page.goto((await harness.link('lender'))+'#/lend');
 const check=page.getByRole('button',{name:'Check readiness again',exact:true});await check.click();
 await expect(check).toHaveAttribute('aria-busy','true');await expect(check).toHaveText('Check readiness again · Checking…');await expect.poll(()=>forced).toBe(1);
 release();await expect(page.locator('.notice')).toContainText('Last checked');
 const expected=await page.evaluate(at=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(Date.parse(at)),at);
 await expect(page.locator('.notice')).toContainText(expected);
});
test('sandbox and allowance readings use the computer zone when saved hours use UTC',async({page})=>{
 // The allowance is hidden after 24 hours. Keep this fixture fresh without
 // changing real timers, and use a computer zone distinct from the saved UTC hours.
 await page.clock.setFixedTime(new Date('2026-10-20T09:00:00Z'));
 const observed='2026-10-20T08:53:00Z', observedAt=Date.parse(observed);
 await page.route('**/api/home',r=>r.fulfill({json:{intent:{on:true,state:'ready'},lending:{enabled:true,circle:'shared',status:'idle',limits:{timeZone:'UTC'}},allowance:{provider:'claude',remaining:62,observedAt,resetsAt:observedAt+86400000}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 await page.goto((await harness.link('lender'))+'#/lend');
 const expected=await page.evaluate(value=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(Date.parse(value)),observed);
 const utc=await page.evaluate(value=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(Date.parse(value)),observed);
 expect(expected).not.toBe(utc);
 await expect(page.locator('.checks-summary')).toContainText('checked '+expected);
 await expect(page.locator('.meters')).toContainText('checked '+expected);
});
test('Run the test starts S2.3, follows the run, then refreshes readiness',async({page})=>{
 await fixture(page);const calls=[];let finished=false,launchId;let release;const gate=new Promise(resolve=>{release=resolve;});
 await page.route(/\/api\/setup\/test(?:\?.*)?$/,async r=>{
  const method=r.request().method();
  if(method==='POST'){
   launchId=r.request().postDataJSON().launch_id;calls.push('POST setup/test');
   return r.fulfill({status:202,json:{state:'running',id:'run-1',launch_id:launchId,launch_state:'started',started_at:at}});
  }
  calls.push('GET setup/test?launch_id='+new URL(r.request().url()).searchParams.get('launch_id'));
  await gate;finished=true;await r.fulfill({json:{state:'passed',id:'run-1',launch_id:launchId,launch_state:'started',finished_at:at}});
 });
 await page.route('**/api/readiness?refresh=true',r=>{calls.push('GET readiness?refresh=true');return r.fulfill({json:{ready:true,protection:{observed_at:at}}});});
 await page.route('**/api/home',r=>r.fulfill({json:{lending:{enabled:true,circle:'shared',status:'idle'}}}));
 await page.goto((await harness.link('lender'))+'#/lend');
 const run=page.getByRole('button',{name:'Run the test',exact:true});await run.click();
 await expect(page.getByRole('button',{name:'Running the test…',exact:true})).toHaveAttribute('aria-busy','true');
 expect(calls[0]).toBe('POST setup/test');release();
 await expect(page.locator('.notice')).toContainText('Sandbox safety test passed');
 expect(calls).toEqual(['POST setup/test','GET setup/test?launch_id='+launchId,'GET readiness?refresh=true']);
});


test('a safety run survives route changes and a terminal SSE update while its status poll is pending',async({page})=>{
 await fixture(page);
 let phase='not_run',posts=0,deletes=0,gets=0,forced=0,terminalHomeReads=0;
 let sendRunning,sendTerminal,releaseGet;
 const runningEvent=new Promise(resolve=>{sendRunning=resolve;});
 const terminalEvent=new Promise(resolve=>{sendTerminal=resolve;});
 const heldGet=new Promise(resolve=>{releaseGet=resolve;});
 let stream=0;
 const eventBody=(id,state)=>`id: ${id}\nevent: setup-test\ndata: ${JSON.stringify({id,type:'setup-test',data:{state}})}\n\n`;

 // The first short stream opens the watcher. Subsequent streams deliver real watchUpdates frames.
 await page.route('**/api/events?after=*',async route=>{
  const index=++stream;
  if(index===1)return route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:': connected\n\n'});
  if(index===2){await runningEvent;return route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:eventBody(1,'running')});}
  await terminalEvent;
  return route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:eventBody(2,'passed')});
 });
 await page.route('**/api/home',async route=>{
  if(phase==='passed')terminalHomeReads++;
  await route.fulfill({json:{lending:{enabled:true,circle:'shared',status:'idle'}}});
 });
 await page.route(/\/api\/setup\/test(?:\?.*)?$/,async route=>{
  const method=route.request().method();
  if(method==='POST'){posts++;phase='running';const launchId=route.request().postDataJSON().launch_id;sendRunning();return route.fulfill({status:202,json:{state:'running',id:'run-1',launch_id:launchId,launch_state:'started',started_at:at}});}
  if(method==='DELETE'){deletes++;return route.fulfill({json:{state:'cancelled',id:null,launch_id:new URL(route.request().url()).searchParams.get('launch_id'),launch_state:'cancelled'}});}
  gets++;await heldGet;
  return route.fulfill({json:{state:'passed',id:'run-1',launch_id:new URL(route.request().url()).searchParams.get('launch_id'),launch_state:'started',finished_at:at}});
 });
 await page.route('**/api/readiness?refresh=true',async route=>{
  forced++;
  return route.fulfill({json:{ready:true,protection:{observed_at:at},checks:[]}});
 });

 await page.goto((await harness.link('lender'))+'#/lend');
 await expect.poll(()=>stream,{timeout:5000}).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Run the test',exact:true}).click();
 await expect.poll(()=>gets,{timeout:5000}).toBe(1);
 await expect.poll(()=>stream,{timeout:5000}).toBeGreaterThan(1);
 await expect(page.getByRole('button',{name:'Running the test…',exact:true})).toHaveAttribute('aria-busy','true');
 await expect(page.getByRole('button',{name:'Run the test',exact:true})).toHaveCount(0);

 // Leave while the one GET status poll is blocked; the backend run must continue.
 await page.evaluate(()=>{location.hash='#/settings/profile';});
 await expect(page.locator('.you-page')).toBeVisible();
 phase='passed';sendTerminal();
 await expect.poll(()=>terminalHomeReads,{timeout:5000}).toBeGreaterThan(0);
 expect(gets).toBe(1);
 expect(forced).toBe(0);

 // The terminal home snapshot is already visible on return, even though setup/test GET is still held.
 await page.evaluate(()=>{location.hash='#/lend';});
 await expect(page.locator('.checks-summary')).toBeVisible();
 const displayedTime=await page.evaluate(value=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(Date.parse(value)),at);
 await expect(page.locator('.checks-summary')).toContainText(displayedTime);
 await expect(page.getByRole('button',{name:'Run the test',exact:true})).toHaveCount(0);
 expect(posts).toBe(1);
 expect(deletes).toBe(0);
 expect(forced).toBe(0);

 releaseGet();
 await expect.poll(()=>forced,{timeout:5000}).toBe(1);
 await expect.poll(()=>posts).toBe(1);
 await expect.poll(()=>deletes).toBe(0);
});

test('an agent sign-in test remedy starts the real safety run instead of opening Setup',async({page})=>{
 await fixture(page);let posts=0,forced=0;
 const agentProblem={key:'agent',agent:'codex',label:'Codex',status:'blocked',detail:'The sign-in test did not pass.',action:'Run the test again',headline:'The sign-in test needs attention'};
 await page.route('**/api/home',r=>r.fulfill({json:{lending:{enabled:true,circle:'shared',status:'idle'},lending_blockers:{items:[agentProblem],first:agentProblem,canLend:false}}}));
 await page.route('**/api/setup/test',r=>{expect(r.request().method()).toBe('POST');posts++;return r.fulfill({status:202,json:{state:'passed',id:'run-1',launch_id:r.request().postDataJSON().launch_id,launch_state:'started',finished_at:at}});});
 await page.route('**/api/readiness?refresh=true',r=>{forced++;return r.fulfill({json:{ready:true,protection:{observed_at:at}}});});
 await page.goto((await harness.link('lender'))+'#/lend');
 await page.getByRole('button',{name:'Run the test again',exact:true}).click();
 await expect.poll(()=>posts).toBe(1);await expect.poll(()=>forced).toBe(1);
 await expect(page.locator('.notice')).toContainText('Sandbox safety test passed');
 await expect.poll(()=>page.evaluate(()=>location.hash)).toBe('#/lend');
});

test('the Home agent remedy checks that agent, shows progress and keeps readiness checks separate',async({page})=>{
 await fixture(page);let checked=false,forced=0,release;const calls=[],gate=new Promise(resolve=>{release=resolve;});
 const agent=()=>({id:'codex',installed:true,signedIn:checked?true:null,useForLending:true});
 await page.route('**/api/home',r=>r.fulfill({json:{intent:{on:false,state:'off'},lending:{enabled:false,circle:'shared',status:'idle'}}}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[]}));
 await page.route('**/api/approvals',r=>r.fulfill({json:[]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[agent()]}));
 await page.route('**/api/readiness?refresh=true',r=>{forced++;return r.fulfill({json:{ready:true,checks:[]}});});
 await page.route('**/api/agents/refresh',async r=>{calls.push(r.request().postDataJSON());await gate;checked=true;await r.fulfill({json:[agent()]});});
 await page.goto((await harness.link('lender'))+'#/home');
 const control=page.locator('section[aria-labelledby=home-needs] .request-preview').filter({has:page.getByRole('heading',{name:'Codex',exact:true})}).getByRole('button');
 await expect(control).toHaveText('Check Codex');await control.click();await expect(control).toHaveAttribute('aria-busy','true');
 await expect.poll(()=>calls).toEqual([{agents:['codex']}]);release();
 await expect(page.locator('.home-lending-card').getByRole('button',{name:'Turn lending on',exact:true})).toBeVisible();
 expect(forced).toBe(0);
});

test('first-run Lending shows both MVP agents and Check again checks both',async({page})=>{
 const rows=[
  {id:'claude-code-subscription',installed:true,signedIn:true,useForLending:false,run:{model:'Sonnet'}},
  {id:'codex',installed:true,signedIn:false,useForLending:false,signInSupported:true},
  {id:'claude-code-api-key',installed:true,signedIn:true}, {id:'gemini',installed:false},
  {id:'gh-cli',installed:true,signedIn:null}, {id:'opencode',installed:false},
 ];
 await page.route('**/api/home',r=>r.fulfill({json:{lending:{enabled:true,circle:'shared',status:'idle'}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
 await page.route('**/api/agents',r=>r.fulfill({json:rows}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 const calls=[];
 await page.route('**/api/agents/refresh',r=>{calls.push(r.request().postDataJSON());return r.fulfill({json:rows});});
 await page.goto((await harness.link('lender'))+'#/lend');
 const cards=page.locator('#lend-agents .lagent');
 await expect(cards).toHaveCount(2);
 await expect(cards.nth(0)).toContainText('Claude Code');await expect(cards.nth(0)).toContainText('Signed in · ready');
 await expect(cards.nth(1)).toContainText('Codex');await expect(cards.nth(1)).toContainText('Signed out');
 await expect(cards.nth(1).getByRole('button',{name:'Sign in to Codex',exact:true})).toBeVisible();
 await expect(page.getByText(/Show \d+ more agents/)).toHaveCount(0);
 await page.getByRole('button',{name:'Check again',exact:true}).click();
 await expect.poll(()=>calls).toEqual([{agents:['claude-code-subscription','codex']}]);
 await expect(page.locator('.notice')).toContainText('Claude Code is ready. Codex needs you.');
});

test('restart recovery stays on the Lending hero, Home card and one attention row',async({page})=>{
 const home={intent:{on:true,state:'blocked',reason:'lending_not_started'},lending:{enabled:false,circle:'shared',status:'idle'}};
 await page.route('**/api/home',r=>r.fulfill({json:home}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 await page.route('**/api/approvals',r=>r.fulfill({json:[]}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[]}));
 await page.goto((await harness.link('lender'))+'#/home');
 await expect(page.locator('.home-lending-card').getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
 await expect(page.locator('section[aria-labelledby=home-needs]').getByRole('button',{name:'Resume now',exact:true})).toHaveCount(1);
 await page.evaluate(()=>{location.hash='#/lend';});
 await expect(page.locator('.hero').getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
});
