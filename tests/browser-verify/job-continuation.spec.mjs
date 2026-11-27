import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';

test.use({timezoneId:'America/Chicago'});
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

const circle={id:'thread-circle',name:'Weekend projects',origin:'http://fixture',rosterMembershipVerified:true},
  digest='sha256:'+'a'.repeat(64), result='sha256:'+'b'.repeat(64), commit='c'.repeat(40),
  job={job_digest:digest,circle,state:'result-accepted',result_digest:result,local:{title:'Fix the parser',prompt:'Fix the parser.',sourcePath:'/fixture/project',applied:{repo:'/fixture/project',branch:'faravan/result',commit}}},
  handoff={schema:'faravan.continuation.v1',mode:'summary',trust:'untrusted',objective:'Fix the parser',latest_instruction:'Keep the fix small',changes:['Updated the date parser'],observed_checks:[{cmd:'npm test',exit:0,timed_out:false,observed_by:'sandbox'}],agent_claims:['All tests passed'],open_issues:['Review the timezone edge case'],next_steps:['Add a regression test'],scan:{status:'passed'}},
  continuation={handoff,parentJob:digest,parentResult:result,base:{path:'/fixture/project',branch:'faravan/result',commit},thread:[
    {job_digest:'sha256:'+'d'.repeat(64),title:'Add a regression test',parentJob:digest,submittedAt:'2026-10-20T13:00:00Z',runs:[{state:'result-accepted',result_digest:'sha256:'+'e'.repeat(64)}]},
    {job_digest:digest,title:'Fix the parser',submittedAt:'2026-10-20T12:00:00Z',runs:[{state:'result-accepted',result_digest:result}]},
  ]};
const changes={format:'diff',files:[{path:'src/date.mjs',status:'modified',insertions:2,deletions:1}],diffstat:{files:1,insertions:2,deletions:1},diff:'diff --git a/src/date.mjs b/src/date.mjs\n--- a/src/date.mjs\n+++ b/src/date.mjs\n@@ -1 +1,2 @@\n-old\n+new\n'};

async function resultPage(page,{uncertain=false,onSend=()=>{},jobValue=job}={}) {
  if(uncertain) await page.addInitScript(({circle})=>{
    localStorage.setItem('faravan-compose-circle',circle.id);
    localStorage.setItem('faravan-compose-draft:'+circle.id,JSON.stringify({id:'draft-uncertain-0001',prompt:'Keep this draft',path:'/other/project',sending:true}));
  },{circle});
  await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
  await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'borrower',circles:[]}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,r=>{
    if(r.request().method()==='POST'){onSend(r.request().postDataJSON());return r.fulfill({json:{jobDigest:'sha256:'+'f'.repeat(64)}});}
    return r.fulfill({json:[jobValue]});
  });
  await page.route('**/api/repo/inspect',r=>r.fulfill({json:{path:'/fixture/project',name:'project',branch:'main',head:commit,files:3,changed:[],changed_count:0}}));
  await page.route('**/api/jobs/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/thread'))return route.fulfill({json:{thread:jobValue.state==='claimed'?[]:continuation.thread}});
    if(path.endsWith('/continuation'))return route.fulfill({json:continuation});
    if(path.endsWith('/changes'))return route.fulfill({json:changes});
    if(path.endsWith('/receipt'))return route.fulfill({json:{receipt:{harness:'claude-code-subscription'},checks:[]}});
    if(path.endsWith('/transcript'))return route.fulfill({json:{text:JSON.stringify({type:'result',result:'Updated the parser.'})}});
    if(path.endsWith('/retention'))return route.fulfill({json:{deletable:false}});
    return route.fulfill({json:jobValue});
  });
  await page.clock.setFixedTime(new Date('2026-10-20T15:00:00Z'));
  await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  await expect(page.getByRole('heading',{name:'Fix the parser'})).toBeVisible();
}

test('result review shows one summary and prepares the exact parent with a blank delta',async({page})=>{
  const sends=[];
  await resultPage(page,{onSend:body=>sends.push(body)});
  await page.locator('#job-handoff > summary').click();
  await expect(page.locator('.handoff-fields')).toHaveCount(0);
  await expect(page.getByText('Updated the parser.',{exact:true})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Send a follow-up job'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Job thread'})).toBeVisible();
  await expect(page.locator('.job-thread-list .row').first()).toContainText('Add a regression test');
  await expect(page.locator('.job-thread-parent a')).toHaveAttribute('href','#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  await page.getByRole('button',{name:'Send a follow-up job'}).click();
  await expect(page.getByRole('heading',{name:'What should change next?'})).toBeVisible();
  await expect(page.getByLabel('What should change next?')).toHaveValue('');
  await expect(page.getByLabel('Project folder')).toHaveCount(0);
  await expect(page.getByText('Saved source folder: /fixture/project',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Circle')).toBeDisabled();
  await expect(page.getByText('Continues: Fix the parser',{exact:true})).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Starts from this job’s result');
  await expect(page.locator('body')).not.toContainText(commit);
  await page.getByLabel('What should change next?').fill('Add a timezone regression test.');
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await confirmFirstSend(page);
  await expect.poll(()=>sends.length).toBe(1);
  expect(sends[0]).toMatchObject({prompt:'Add a timezone regression test.',followup:{parentJob:digest,parentResult:result}});
  expect(sends[0]).not.toHaveProperty('repo');
});

test('an own running job hides its one-job thread before a continuation summary exists',async({page})=>{
  const running={...job,state:'claimed',result_digest:undefined,current_attempt:{attempt_id:'run-live',state:'running',execution_started_at:'2026-10-20T12:30:00Z'}};
  await resultPage(page,{jobValue:running});
  await expect(page.getByRole('heading',{name:'Job thread'})).toHaveCount(0);
  await expect(page.locator('.job-thread-list')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Continue this work'})).toHaveCount(0);
});

test('preparing a continuation leaves an uncertain draft untouched and reports why',async({page})=>{
  await resultPage(page,{uncertain:true});
  await page.locator('#job-handoff > summary').click();
  await page.getByRole('button',{name:'Send a follow-up job'}).click();
  await expect(page.getByRole('alert')).toContainText('An earlier send is still waiting for an answer');
  expect(new URL(page.url()).hash).toContain('/job/');
  expect(await page.evaluate(id=>JSON.parse(localStorage.getItem('faravan-compose-draft:'+id)).prompt,circle.id)).toBe('Keep this draft');
});

test('judge fixes preserve one primary, aligned facts and rows, and short copy at every viewport',async({page})=>{
 const folder=process.env.THREAD_SHOTS;
 if(folder)await mkdir(folder,{recursive:true});
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const scheme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
  await resultPage(page);
  await page.locator('#job-handoff > summary').click();
  const rail=page.locator('.job-page .rail');
  await expect(rail.locator('.btn-primary')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Send a follow-up job'})).toHaveClass(/btn-secondary/);
  await expect(page.getByRole('button',{name:'Copy summary',exact:true})).toHaveCount(0);
  await expect(page.locator('.handoff-fields')).toHaveCount(0);
  await expect(page.locator('.job-thread-list')).toContainText('8:00 AM');
  await expect(page.locator('.job-thread-list')).not.toContainText('result recorded');
  await expect(page.locator('.job-thread-list')).toContainText('This job');
  // Text starts inside the padding of the link and lists; compare actual text rectangles.
  const textEdges=await page.locator('.job-thread-list>li').first().evaluate(li=>['.row-title','.job-thread-date','.job-thread-parent','.job-thread-runs li'].map(selector=>{const el=li.querySelector(selector),range=document.createRange();range.selectNodeContents(el);return range.getBoundingClientRect().x;}));
  expect(Math.max(...textEdges)-Math.min(...textEdges)).toBeLessThanOrEqual(1);
  if(folder)await page.screenshot({path:folder+'/job.'+size+'-'+scheme+'.png',fullPage:true});
  await expect(page.locator('#job-handoff')).toHaveAttribute('open','');
  await expect(page.locator('.job-thread-parent a')).toHaveAttribute('href','#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  await expect(page.locator('.job-thread')).not.toContainText('passed its scan');
  await expect(page.locator('.job-summary')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Copy summary',exact:true})).toHaveCount(0);
  if(folder)await page.screenshot({path:folder+'/handoff.'+size+'-'+scheme+'.png',fullPage:true});
  await page.getByRole('button',{name:'Send a follow-up job'}).click();
  await expect(page.getByRole('heading',{name:'What should change next?'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText(commit);
  if(folder)await page.screenshot({path:folder+'/followup.'+size+'-'+scheme+'.png',fullPage:true});
 }
});

test('the no-changes apply recovery also prepares a linked follow-up',async({page})=>{
 await resultPage(page);
 await page.route('**/api/jobs/*/apply',route=>route.fulfill({status:409,json:{code:'no_changes',apply_code:'no_changes',state:'job.no-changes'}}));
 await page.getByRole('button',{name:'Add as a branch…'}).click();
 const dialog=page.getByRole('dialog',{name:'Add as a branch'});
 await expect(dialog.getByRole('button',{name:'Send a follow-up job'})).toBeVisible();
 await dialog.getByRole('button',{name:'Send a follow-up job'}).click();
 await expect(page.getByRole('heading',{name:'What should change next?'})).toBeVisible();
 const saved=await page.evaluate(circle=>JSON.parse(localStorage.getItem('faravan-compose-draft:'+circle)),circle.id);
 expect(saved.followup).toEqual({parentJob:digest,parentResult:result});
});
