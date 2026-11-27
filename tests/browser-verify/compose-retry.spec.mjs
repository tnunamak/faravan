import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id:'retry-circle', name:'Retry circle', origin:'https://circle.example', enrollment:{state:'approved'}, rosterMembershipVerified:true};
const digest = 'sha256:' + 'a'.repeat(64);
const draft = {id:'retry-draft-12345678', prompt:'Keep checking this one send.', path:'/fixture/project', agent:'', includeUncommitted:false, sending:true};

async function composer(browser, restored = false, retryRefusal = false, testCommand = '', storedVerifyCmd = '') {
  const context = await browser.newContext();
  await context.addInitScript(({circle, draft, restored, storedVerifyCmd}) => {
    localStorage.setItem('faravan-compose-circle', circle.id);
    if (restored) localStorage.setItem('faravan-compose-draft:' + circle.id, JSON.stringify({...draft,verifyCmd:storedVerifyCmd}));
  }, {circle, draft, restored, storedVerifyCmd});
  const page = await context.newPage(), calls = [];
  await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose', route => route.fulfill({json:{circle:circle.id, networked:true, host:{reachable:true}, lenders:[]}}));
  await page.route('**/api/repo/inspect', route => route.fulfill({json:{path:draft.path, name:'fixture-project', branch:'main', head:'b'.repeat(40), files:2, changed:[], changed_count:0, testCommand}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'POST') return route.fulfill({json:[]});
    calls.push(route.request().postDataJSON());
    if (calls.length < 3) {
      const code = calls.length === 2 && retryRefusal ? retryRefusal === true ? 'device_busy' : retryRefusal : 'network';
      return route.fulfill({status:code === 'network' ? 503 : code === 'invalid_request' ? 400 : 409,json:{code,
        outcome:code==='network'||code==='device_busy'?'unknown':'not_applied',
        ...(code === 'agent_unavailable' ? {message:'No computer in Retry circle lends Claude Code right now',action:{label:'Send anyway',input:{send_anyway:true}}} : {})}});
    }
    return route.fulfill({json:{jobDigest:digest}});
  });
  await page.route('**/api/jobs/*', route => route.fulfill({json:{job_digest:digest, circle, state:'queued', local:{title:draft.prompt, prompt:draft.prompt}}}));
  await page.goto((await harness.link('owner')) + '#/new');
  await page.getByRole('heading', {name:'New job', exact:true}).waitFor();
  if (!restored) {
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await page.getByLabel('What the agent should do').fill(draft.prompt);
    await page.getByRole('textbox',{name:'Project folder',exact:true}).fill(draft.path);
    await page.getByRole('textbox',{name:'Project folder',exact:true}).press('Enter');
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    if (testCommand) await expect(page.getByLabel('Test command')).toHaveValue(testCommand);
    await page.getByRole('textbox',{name:'Project folder',exact:true}).blur();
    const send = page.getByRole('button', {name:'Send', exact:true});
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await send.click();
    await confirmFirstSend(page);
  }
  return {context, page, calls};
}

test('the inspected package test is shown and sent as the job check', async ({browser}) => {
  test.info().annotations.push({type:'slice', description:'D-compose'}, {type:'check', description:'verify-command'});
  const {context, page, calls} = await composer(browser, false, false, 'npm test');
  try {
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    expect(calls[0].verify).toEqual({cmd:'npm test'});
    await expect(page.getByLabel('Test command')).toBeDisabled();
  } finally { await context.close(); }
});

for (const restored of [false, true]) {
  test(`uncertain ${restored ? 'restored' : 'new'} send keeps checking the same draft until resolved`, async ({browser}) => {
    test.info().annotations.push({type:'slice', description:'D-retry'}, {type:'check', description:restored ? 'restored' : 'new-send'});
    const {context, page, calls} = await composer(browser, restored);
    try {
      await expect.poll(() => calls.length, {timeout:13_000}).toBe(3);
      expect(calls.map(body => body.circle)).toEqual([circle.id, circle.id, circle.id]);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[2]).toEqual(calls[0]);
      if (restored) expect(calls[0].draft_id).toBe(draft.id);
      await expect.poll(() => new URL(page.url()).hash).toBe('#/job/' + encodeURIComponent(digest) + '/' + circle.id);
    } finally { await context.close(); }
  });
}

test('leaving an uncertain composer stops its retry loop', async ({browser}) => {
  test.info().annotations.push({type:'slice', description:'D-retry'}, {type:'check', description:'unmount'});
  const {context, page, calls} = await composer(browser);
  try {
    await expect.poll(() => calls.length).toBe(1);
    await page.locator('.side-nav a[href="#/home"]').click();
    await expect(page.locator('.compose')).toHaveCount(0);
    await page.waitForTimeout(3300);
    expect(calls).toHaveLength(1);
  } finally { await context.close(); }
});

test('a changed inspection result cannot replace the check on a restored uncertain send', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-retry'},{type:'check',description:'frozen-verify'});
  const {context,page,calls}=await composer(browser,true,false,'npm test','node original-check');
  try {
    await expect.poll(()=>calls.length,{timeout:13_000}).toBe(3);
    expect(calls.map(body=>body.verify)).toEqual(Array(3).fill({cmd:'node original-check'}));
  } finally {await context.close();}
});

test('a restored uncertain send stays with its original circle when that circle disappears from the picker', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-retry'},{type:'check',description:'circle-removed'});
  const {context,page,calls}=await composer(browser,true);
  try {
    await page.unroute('**/api/circles');
    await page.route('**/api/circles',route=>route.fulfill({json:[{id:'other-circle',name:'Other circle',origin:'https://other.example'}]}));
    await page.reload();
    await expect.poll(()=>calls.length,{timeout:13_000}).toBe(3);
    expect(calls.map(body=>body.circle)).toEqual([circle.id,circle.id,circle.id]);
    expect(await page.evaluate(()=>localStorage.getItem('faravan-compose-draft:other-circle'))).toBeNull();
  } finally {await context.close();}
});

test('a retry refusal cannot unlock a send whose first outcome is still unknown', async ({browser}) => {
 test.info().annotations.push({type:'slice',description:'D-retry'},{type:'check',description:'retry-refusal'});
 const {context,page,calls}=await composer(browser,false,true);
 try {
  await expect.poll(()=>calls.length).toBe(2);
  await expect(page.getByLabel('What the agent should do')).toBeDisabled();
  await expect.poll(()=>calls.length,{timeout:8000}).toBe(3);
  expect(calls[2]).toEqual(calls[0]);
  await expect.poll(()=>new URL(page.url()).hash).toBe('#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 } finally {await context.close();}
});

test('an agent refusal during retry offers Send to any available agent on the same draft', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-retry'},{type:'check',description:'retry-agent-refusal'});
  const {context,page,calls}=await composer(browser,false,'agent_unavailable');
  try {
    await expect.poll(()=>calls.length,{timeout:8000}).toBe(2);
    await expect(page.locator('#agent-unavailable')).toBeFocused();
    await expect(page.getByRole('button',{name:'Send to any available agent',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Send to any available agent',exact:true}).click();
    await confirmFirstSend(page);
    await expect.poll(()=>calls.length).toBe(3);
    expect(calls[2]).toEqual({...calls[0],send_anyway:true});
    await expect.poll(()=>new URL(page.url()).hash).toBe('#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  } finally {await context.close();}
});

test('agent refusal offers the same frozen draft to any available agent, then retries its uncertain result', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'agent-unavailable-override'});
  const context = await browser.newContext();
  await context.addInitScript(({circle,draft}) => {
    localStorage.setItem('faravan-compose-circle',circle.id);
    if(!localStorage.getItem('faravan-compose-draft:'+circle.id))localStorage.setItem('faravan-compose-draft:'+circle.id,JSON.stringify({...draft,agent:'claude-code',sending:false}));
  },{circle,draft});
  const page = await context.newPage(), calls=[];
  await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[{agents:[{adapter:'claude-code-api-key',readiness:'ready'}]}]}}));
  await page.route('**/api/repo/inspect',route=>route.fulfill({json:{path:draft.path,name:'fixture-project',branch:'main',head:'b'.repeat(40),files:2,changed:[],changed_count:0}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,route=>{
    if(route.request().method()!=='POST')return route.fulfill({json:[]});
    calls.push(route.request().postDataJSON());
    if(calls.length===1)return route.fulfill({status:409,json:{code:'agent_unavailable',outcome:'not_applied',message:'No computer in Retry circle lends Claude Code right now',action:{label:'Send anyway',input:{send_anyway:true}}}});
    if(calls.length<4)return route.fulfill({status:503,json:{code:'network',outcome:'unknown'}});
    return route.fulfill({json:{jobDigest:digest}});
  });
  await page.route('**/api/jobs/*',route=>route.fulfill({json:{job_digest:digest,circle,state:'queued',local:{title:draft.prompt,prompt:draft.prompt}}}));
  try {
    await page.goto((await harness.link('owner'))+'#/new');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue(draft.path);
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await expect(page.getByLabel('Agent',{exact:true})).toHaveValue('claude-code');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await confirmFirstSend(page);
    const notice=page.locator('#agent-unavailable');
    await expect(notice).toHaveText('Review the available agents before sending this job.');
    await expect(notice).toBeFocused();
    await expect(page.locator('.send-note #agent-unavailable')).toBeVisible();
    await expect(page.locator('.compose > .form-error')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Change the job'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Send to any available agent',exact:true})).toBeVisible();
    await expect(page.getByLabel('What the agent should do')).toBeDisabled();
    await page.reload();
    await expect(notice).toHaveText('Review the available agents before sending this job.');
    await expect(page.getByRole('button',{name:'Send to any available agent',exact:true})).toBeVisible();
    expect(calls).toHaveLength(1);
    await page.getByRole('button',{name:'Send to any available agent',exact:true}).click();
    await confirmFirstSend(page);
    await expect.poll(()=>calls.length,{timeout:13_000}).toBe(4);
    expect(calls[0].draft_id).toBe(draft.id);
    for(const body of calls.slice(1))expect(body).toEqual({...calls[0],send_anyway:true});
    await expect.poll(()=>new URL(page.url()).hash).toBe('#/job/'+encodeURIComponent(digest)+'/'+circle.id);
    expect(calls.filter(body=>body.send_anyway!==true)).toHaveLength(1);
  } finally { await context.close(); }
});

test('changing the agent after a refusal clears Send to any available agent and starts a new draft identity', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'change-after-refusal'});
  const context=await browser.newContext();
  await context.addInitScript(({circle,draft})=>{
    localStorage.setItem('faravan-compose-circle',circle.id);
    localStorage.setItem('faravan-compose-draft:'+circle.id,JSON.stringify({...draft,agent:'claude-code',sending:false}));
  },{circle,draft});
  const page=await context.newPage(),calls=[];
  await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[{agents:[{adapter:'claude-code-api-key',readiness:'ready'},{adapter:'codex',readiness:'ready'}]}]}}));
  await page.route('**/api/repo/inspect',route=>route.fulfill({json:{path:draft.path,name:'fixture-project',branch:'main',head:'b'.repeat(40),files:2,changed:[],changed_count:0}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,route=>{
    if(route.request().method()!=='POST')return route.fulfill({json:[]});
    calls.push(route.request().postDataJSON());
    return calls.length===1?route.fulfill({status:409,json:{code:'agent_unavailable',outcome:'not_applied',message:'No computer in Retry circle lends Claude Code right now',action:{label:'Send anyway',input:{send_anyway:true}}}}):route.fulfill({json:{jobDigest:digest}});
  });
  await page.route('**/api/jobs/*',route=>route.fulfill({json:{job_digest:digest,circle,state:'queued',local:{title:draft.prompt,prompt:draft.prompt}}}));
  try {
    await page.goto((await harness.link('owner'))+'#/new');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await confirmFirstSend(page);
    await expect(page.locator('#agent-unavailable')).toBeFocused();
    await page.getByLabel('Agent',{exact:true}).selectOption('codex');
    await expect(page.getByRole('button',{name:'Send to any available agent',exact:true})).toHaveCount(0);
    await expect(page.getByLabel('What the agent should do')).toBeEnabled();
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await confirmFirstSend(page);
    await expect.poll(()=>calls.length).toBe(2);
    expect(calls[1].draft_id).not.toBe(calls[0].draft_id);
    expect(calls[1].prompt).toBe(calls[0].prompt);
    expect(calls[1].harness).toBe('codex');
    await expect.poll(()=>new URL(page.url()).hash).toBe('#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  } finally {await context.close();}
});

test('Back to jobs leaves a composer opened directly', async ({page}) => {
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'direct-cancel'});
  await page.goto((await harness.link('owner'))+'#/new');
  await page.getByRole('heading',{name:'New job',exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to jobs',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).hash).toBe('#/jobs');
});

test('a real circle is selected by default and changing circles keeps the inspected draft', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'circle-switch-keeps-work'});
  const context=await browser.newContext();
  const page=await context.newPage();
  const circles=[
    {id:'my-devices',name:'My devices'},
    {id:'weekend',name:'Weekend projects',origin:'https://weekend.example',enrollment:{state:'approved'},rosterMembershipVerified:true},
    {id:'writing',name:'Writing circle',origin:'https://writing.example',enrollment:{state:'approved'},rosterMembershipVerified:true},
  ];
  await page.route('**/api/circles',route=>route.fulfill({json:circles}));
  await page.route('**/api/circles/*/compose',route=>{
    const id=new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({json:{circle:id,networked:true,host:{reachable:true},lenders:[]}});
  });
  await page.route('**/api/repo/inspect',route=>route.fulfill({json:{path:draft.path,name:'fixture-project',branch:'main',head:'b'.repeat(40),files:2,kind:'git',changed:['src/example.mjs'],changed_count:1,testCommand:'npm test'}}));
  try {
    await page.goto((await harness.link('owner'))+'#/new');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await expect(page.getByLabel('Circle')).toHaveValue('weekend');
    await expect(page.getByLabel('Circle').locator('option:checked')).toHaveText('Weekend projects');
    await page.getByLabel('What the agent should do').fill('Keep the task after changing circles.');
    await page.getByRole('textbox',{name:'Project folder',exact:true}).fill(draft.path);
    await page.getByRole('textbox',{name:'Project folder',exact:true}).press('Enter');
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await expect(page.getByLabel('Test command')).toHaveValue('npm test');
    // A local Git folder supports both options; Git-URL and no-project sources do not expose this checkbox.
    await page.locator('#cmp-workdir').fill('packages/app');
    const include=page.locator('#cmp-project .cmp-project-settings input[type="checkbox"]');
    await expect(include).toHaveCount(1);
    await expect(include).toBeVisible();
    await include.check();
    await expect(include).toBeChecked();
    await expect(page.locator('#cmp-saved')).toBeVisible();
    const beforeMove=await page.evaluate(()=>({
      a:JSON.parse(localStorage.getItem('faravan-compose-draft:weekend')),
      b:localStorage.getItem('faravan-compose-draft:writing'),
    }));
    expect(beforeMove.a.id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(beforeMove.b).toBeNull();
    expect(beforeMove.a).toMatchObject({sourceKind:'folder',workingDirectory:'packages/app',includeUncommitted:true});
    await page.getByLabel('Circle').selectOption('writing');
    const afterMove=await page.evaluate(()=>({
      a:localStorage.getItem('faravan-compose-draft:weekend'),
      b:JSON.parse(localStorage.getItem('faravan-compose-draft:writing')),
    }));
    expect(afterMove.a).toBeNull();
    expect(afterMove.b.id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(afterMove.b.id).not.toBe(beforeMove.a.id);
    // The destination is a new saved draft, with a new identity and edit time.
    expect(Number.isSafeInteger(afterMove.b.editedAt)).toBe(true);
    expect(afterMove.b.editedAt).toBeGreaterThanOrEqual(beforeMove.a.editedAt);
    expect(afterMove.b).toEqual({...beforeMove.a,id:afterMove.b.id,editedAt:afterMove.b.editedAt,
      sending:false,uncertainSince:null,sendAnyway:false});
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await expect(page.getByLabel('What the agent should do')).toHaveValue('Keep the task after changing circles.');
    await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue(draft.path);
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await expect(page.getByLabel('Test command')).toHaveValue('npm test');
    await expect(page.getByLabel('Circle').locator('option:checked')).toHaveText('Writing circle');
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
    await expect(page.locator('#cmp-workdir')).toHaveValue('packages/app');
    await expect(include).toBeChecked();
    // Reload restores B independently, rather than performing another move.
    await page.reload();
    await expect(page.getByLabel('Circle')).toHaveValue('writing');
    if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await expect(page.getByLabel('What the agent should do')).toHaveValue(beforeMove.a.prompt);
    await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue(beforeMove.a.path);
    await expect(page.getByLabel('Test command')).toHaveValue(beforeMove.a.verifyCmd);
    await expect(page.locator('#cmp-workdir')).toHaveValue('packages/app');
    await expect(include).toBeChecked();
    const restored=await page.evaluate(()=>({
      a:localStorage.getItem('faravan-compose-draft:weekend'),
      b:JSON.parse(localStorage.getItem('faravan-compose-draft:writing')),
    }));
    expect(restored.a).toBeNull();
    expect(restored.b.id).toBe(afterMove.b.id);
    expect(restored.b).toMatchObject({prompt:beforeMove.a.prompt,path:beforeMove.a.path,verifyCmd:beforeMove.a.verifyCmd,sourceKind:'folder',workingDirectory:'packages/app',includeUncommitted:true});
    expect(restored.b).toMatchObject({sending:false,uncertainSince:null,sendAnyway:false});
  } finally {await context.close();}
});


test('an occupied circle refuses the move and preserves both exact stored drafts', async ({browser}) => {
  const context=await browser.newContext(),page=await context.newPage(),posts=[];
  const circles=[{...circle,id:'occupied-a',name:'Circle A'},{...circle,id:'occupied-b',name:'Circle B'}];
  const values=circles.map((circle,i)=>({circle,path:'/fixture/project-'+i,prompt:'Keep request '+i,model:'model-'+i,effort:i?'high':'low',check:'node check-'+i,workdir:'packages/'+i}));
  await page.route('**/api/circles',route=>route.fulfill({json:circles}));
  await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{
    circle:new URL(route.request().url()).pathname.split('/')[3],networked:true,host:{reachable:true},
    lenders:[{agents:[{adapter:'codex',readiness:'ready'}]}],offers:values.map(v=>({harness:'codex',model:v.model,effort:v.effort}))}}));
  await page.route('**/api/repo/inspect',route=>{
    const path=route.request().postDataJSON().path;
    return route.fulfill({json:{path,name:path.split('/').at(-1),branch:'main',head:'b'.repeat(40),files:2,changed:[],changed_count:0}});
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/,route=>{
    if(route.request().method()!=='POST')return route.fulfill({json:[]});
    posts.push(route.request().postDataJSON());return route.fulfill({status:400,json:{code:'invalid_request',outcome:'not_applied'}});
  });
  const both=()=>page.evaluate(ids=>ids.map(id=>JSON.parse(localStorage.getItem('faravan-compose-draft:'+id))),circles.map(c=>c.id));
  const disclose=async selector=>{if(!await page.locator(selector).evaluate(e=>e.open))await page.locator(selector+' > summary').click();};
  // Change only navigation preference while unmounted; never write draft objects.
  const open=async id=>{
    await page.goto((await harness.link('owner'))+'#/home');await expect(page.locator('.compose')).toHaveCount(0);
    await page.evaluate(id=>localStorage.setItem('faravan-compose-circle',id),id);
    await page.goto((await harness.link('owner'))+'#/new');await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(id);
  };
  const visible=async v=>{
    await expect(page.getByLabel('What the agent should do')).toHaveValue(v.prompt);
    await disclose('#cmp-project');
    await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue(v.path);
    await expect(page.locator('#cmp-meta')).toContainText(v.path.split('/').at(-1));
    await expect(page.locator('#cmp-workdir')).toHaveValue(v.workdir);
    for(const [label,value] of [['Agent','codex'],['Model',v.model],['Effort',v.effort]])await expect(page.getByLabel(label,{exact:true})).toHaveValue(value);
    await disclose('.cmp-requested-check');await expect(page.getByLabel('Test command')).toHaveValue(v.check);
    await expect(page.locator('#cmp-saved')).toBeVisible();
  };
  try {
    for(const v of values){
      await open(v.circle.id);await disclose('#cmp-project');
      await page.getByLabel('What the agent should do').fill(v.prompt);
      await page.getByRole('textbox',{name:'Project folder',exact:true}).fill(v.path);
      await page.getByRole('textbox',{name:'Project folder',exact:true}).press('Enter');
      await expect(page.locator('#cmp-meta')).toContainText(v.path.split('/').at(-1));
      await page.locator('#cmp-workdir').fill(v.workdir);
      await page.getByLabel('Agent',{exact:true}).selectOption('codex');await disclose('.cmp-model-choice');
      await page.getByLabel('Model',{exact:true}).selectOption(v.model);await page.getByLabel('Effort',{exact:true}).selectOption(v.effort);
      await disclose('.cmp-requested-check');await page.getByLabel('Test command').fill(v.check);
      await visible(v);
      // Canonicalize through real restoration before capturing exact saved objects.
      await page.reload();await visible(v);
    }
    await open(circles[0].id);await visible(values[0]);
    const before=await both();
    for(const [i,v] of values.entries()){
      expect(before[i]).toMatchObject({prompt:v.prompt,path:v.path,sourceKind:'folder',workingDirectory:v.workdir,agent:'codex',model:v.model,effort:v.effort,verifyCmd:v.check});
      expect(before[i].id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    }
    expect(before[0].id).not.toBe(before[1].id);
    for (const key of ['prompt','path','workingDirectory','model','effort','verifyCmd'])
      expect(before[0][key],key+' must distinguish A from B').not.toEqual(before[1][key]);
    await page.getByLabel('Circle',{exact:true}).selectOption(circles[1].id);
    await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(circles[1].id);
    await expect(page.locator('.compose')).toContainText('This circle already has a saved request. We opened that request.');
    await visible(values[1]);expect(await both()).toEqual(before);expect(posts).toEqual([]);
    await open(circles[0].id);await visible(values[0]);expect(await both()).toEqual(before);expect(posts).toEqual([]);
  } finally {await context.close();}
});

test('a definite invalid request ends an uncertain send without another retry', async ({browser}) => {
  test.info().annotations.push({type:'slice',description:'D-retry'},{type:'check',description:'definite-refusal'});
  const {context,page,calls}=await composer(browser,false,'invalid_request');
  try {
    await expect.poll(()=>calls.length,{timeout:10_000}).toBe(2);
    await expect(page.getByLabel('What the agent should do')).toBeEnabled();
    const stored=await page.evaluate(circle=>JSON.parse(localStorage.getItem('faravan-compose-draft:'+circle)),circle.id);
    expect(stored.id).not.toBe(calls[0].draft_id);
    expect(stored.sending).toBe(false);
    await page.waitForTimeout(3500);
    expect(calls).toHaveLength(2);
  } finally {await context.close();}
});

test('opening B independently restores its unavailable explicit pair without moving A', async ({browser}) => {
  const context = await browser.newContext();
  const circles = [
    {...circle,id:'restore-a',name:'Circle A',origin:'https://a.example',rosterMembershipVerified:true},
    {...circle,id:'restore-b',name:'Circle B',origin:'https://b.example',rosterMembershipVerified:true},
  ];
  const savedA = {id:'restore-a-12345678',prompt:'Keep A untouched.',sourceKind:'none',path:'',agent:'codex',model:'a-only-model',effort:'high',sending:false};
  const savedB = {id:'restore-b-12345678',prompt:'Restore the independent B request.',sourceKind:'none',path:'',agent:'codex',model:'b-unavailable-model',effort:'high',sending:false};
  await context.addInitScript(({circles,savedA,savedB}) => {
    localStorage.setItem('faravan-compose-circle',circles[1].id);
    localStorage.setItem('faravan-compose-draft:'+circles[0].id,JSON.stringify(savedA));
    localStorage.setItem('faravan-compose-draft:'+circles[1].id,JSON.stringify(savedB));
  }, {circles,savedA,savedB});
  const page = await context.newPage(), sent = [];
  await page.route('**/api/circles', route => route.fulfill({json:circles}));
  let releaseB, enteredB;
  const heldB = new Promise(resolve => { releaseB = resolve; });
  const requestedB = new Promise(resolve => { enteredB = resolve; });
  await page.route('**/api/circles/*/compose', async route => {
    const circle = new URL(route.request().url()).pathname.split('/')[3];
    if (circle === circles[1].id) { enteredB(); await heldB; }
    return route.fulfill({json:{circle,networked:true,host:{reachable:true},
      lenders:[{agents:[{adapter:'codex',readiness:'ready'}]}],
      offers:[{harness:'codex',model:'b-available-model',effort:'low'}]}});
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, route => {
    if (route.request().method() !== 'POST') return route.fulfill({json:[]});
    sent.push(route.request().postDataJSON());
    return route.fulfill({status:400,json:{code:'invalid_request',outcome:'not_applied'}});
  });
  try {
    await page.goto((await harness.link('owner'))+'#/new');
    await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(circles[1].id);
    await expect(page.getByLabel('What the agent should do')).toHaveValue(savedB.prompt);
    await expect(page.getByLabel('Agent',{exact:true})).toHaveValue(savedB.agent);
    await expect(page.getByLabel('Model',{exact:true})).toHaveValue(savedB.model);
    await expect(page.getByLabel('Effort',{exact:true})).toHaveValue(savedB.effort);
    await requestedB;
    const send = page.getByRole('button',{name:'Send',exact:true});
    await expect(send).toHaveAttribute('aria-disabled','true');
    const responseB = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/circles/'+circles[1].id+'/compose');
    releaseB();
    await (await responseB).finished();
    await expect(page.locator('.compose')).toContainText('No lender offers b-unavailable-model at high right now');
    for (const [label,value] of [['Agent',savedB.agent],['Model',savedB.model],['Effort',savedB.effort]])
      await expect(page.getByLabel(label,{exact:true})).toHaveValue(value);
    await expect(send).toHaveAttribute('aria-disabled','true');
    const beforeShortcut = await page.evaluate(ids => ids.map(id =>
      localStorage.getItem('faravan-compose-draft:'+id)),circles.map(c=>c.id));
    // Exercise both platform send chords on the mounted prompt.
    for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
      await page.getByLabel('What the agent should do').press(shortcut);
      await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByRole('dialog',{name:'Before your first job goes to a friend'})).toHaveCount(0);
      await expect(send).toHaveAttribute('aria-disabled','true');
      expect(sent).toHaveLength(0);
    }
    const records = await page.evaluate(ids => ids.map(id => localStorage.getItem('faravan-compose-draft:'+id)),circles.map(c=>c.id));
    expect(records).toEqual(beforeShortcut);
    expect(records[0]).toBe(JSON.stringify(savedA));
    expect(JSON.parse(records[1])).toMatchObject(savedB);
    expect(sent).toHaveLength(0);
  } finally { releaseB(); await context.close(); }
});

test('M4 J5: delayed A offers cannot unlock B; a valid B pair sends once', async ({browser}) => {
  const context=await browser.newContext();
  const a={...circle,id:'pair-a',name:'Pair A'},b={...circle,id:'pair-b',name:'Pair B'};
  const saved={...draft,sending:false,agent:'codex',model:'example-model',effort:'low'};
  await context.addInitScript(({a,saved})=>{
    localStorage.setItem('faravan-compose-circle',a.id);
    localStorage.setItem('faravan-compose-draft:'+a.id,JSON.stringify(saved));
    // B is intentionally absent: moving into it must carry A's work, not
    // replace it with a new empty draft. Occupied destinations are untouched.
  },{a,saved});
  const page=await context.newPage(),posts=[];
  let releaseA,enteredA;
  const heldA=new Promise(resolve=>{releaseA=resolve;});
  const requestedA=new Promise(resolve=>{enteredA=resolve;});
  const offersA=[{harness:'codex',model:'example-model',effort:'low'}];
  const offersB=[{harness:'codex',model:'other-model',effort:'medium'}];
  await page.route('**/api/circles',route=>route.fulfill({json:[a,b]}));
  await page.route('**/api/circles/*/compose',async route=>{
    const id=new URL(route.request().url()).pathname.split('/')[3];
    if(id===a.id){enteredA();await heldA;}
    await route.fulfill({json:{circle:id,networked:true,host:{reachable:true},
      lenders:[{agents:[{adapter:'codex',readiness:'ready'}]}],
      offers:id===a.id?offersA:offersB}});
  });
  await page.route('**/api/repo/inspect',route=>route.fulfill({json:{
    path:draft.path,name:'fixture-project',branch:'main',head:'b'.repeat(40),files:2,changed:[],changed_count:0,
  }}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,route=>{
    if(route.request().method()!=='POST')return route.fulfill({json:[]});
    posts.push(route.request().postDataJSON());
    return route.fulfill({json:{jobDigest:digest}});
  });
  await page.route('**/api/jobs/*',route=>route.fulfill({json:{job_digest:digest,circle:b,state:'queued',local:{title:saved.prompt,prompt:saved.prompt}}}));
  try {
    await page.goto((await harness.link('owner'))+'#/new');
    await requestedA;
    await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(a.id);
    await page.getByLabel('Circle',{exact:true}).selectOption(b.id);
    await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(b.id);
    await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
    await expect(page.getByLabel('What the agent should do')).toHaveValue(saved.prompt);
    const model=page.getByLabel('Model',{exact:true}),effort=page.getByLabel('Effort',{exact:true});
    await expect(model).toHaveValue('example-model');
    await expect(effort).toHaveValue('low');
    // This reason proves B's nonempty offers have landed, not just that its
    // request is pending. A's retained pair is invalid specifically in B.
    await expect(page.locator('.compose')).toContainText('No lender offers example-model at low right now');
    const send=page.getByRole('button',{name:'Send',exact:true});
    await expect(send).toHaveAttribute('aria-disabled','true');
    const lateA=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/circles/'+a.id+'/compose');
    releaseA();
    await (await lateA).finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.getByLabel('Circle',{exact:true})).toHaveValue(b.id);
    await expect(send).toHaveAttribute('aria-disabled','true');
    await expect(page.locator('.compose')).toContainText('No lender offers example-model at low right now');
    expect(posts).toEqual([]);
    const moved=await page.evaluate(({a,b})=>({
      a:localStorage.getItem('faravan-compose-draft:'+a.id),
      b:JSON.parse(localStorage.getItem('faravan-compose-draft:'+b.id)),
    }),{a,b});
    expect(moved.a).toBeNull();
    expect(moved.b).toMatchObject({prompt:saved.prompt,path:saved.path,agent:'codex',model:'example-model',effort:'low'});
    await model.selectOption('other-model');
    await effort.selectOption('medium');
    await expect(model).toHaveValue('other-model');
    await expect(effort).toHaveValue('medium');
    await expect(send).not.toHaveAttribute('aria-disabled','true');
    await send.click();
    await confirmFirstSend(page);
    await expect.poll(()=>new URL(page.url()).hash).toBe('#/job/'+encodeURIComponent(digest)+'/'+b.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({circle:b.id,harness:'codex',model:'other-model',budget_v1:{effort:'medium'},prompt:saved.prompt});
  } finally {releaseA();await context.close();}
});
