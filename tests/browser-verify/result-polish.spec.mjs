import {test,expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const mandelbrot=await readFile(new URL('../../ui/v1/src/fixtures/mandelbrot.png',import.meta.url));
import {join} from 'node:path';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const digest='sha256:'+'c'.repeat(64),circle={id:'review-circle',name:'Weekend projects',origin:'http://fixture'};
const diff='diff --git a/src/greeting.js b/src/greeting.js\nindex 123..456 100644\n--- a/src/greeting.js\n+++ b/src/greeting.js\n@@ -1,3 +1,4 @@\n export function greet(name) {\n-  return "Hello " + name;\n+  if (!name) return "Hello, friend";\n+  return `Hello, ${name}. This deliberately long greeting exercises review wrapping so nobody loses the end of the line when reviewing a change on a narrow phone or a desktop with the details rail open. Every character must remain readable.`;\n }\ndiff --git a/tests/greeting.test.js b/tests/greeting.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/greeting.test.js\n@@ -0,0 +1,2 @@\n+test("greets friends", () => {\n+  assert.equal(greet(), "Hello, friend");\ndiff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
async function fixture(page,result='d',options={}) {
 const job={job_digest:digest,circle,state:options.cancelled?'cancelled':'result-accepted',parentLink:options.followup?{job_digest:'sha256:'+'b'.repeat(64),result_digest:'sha256:'+'a'.repeat(64),title:'Investigate the CSV parser'}:null,result_digest:'sha256:'+result.repeat(64),local:options.lender?undefined:{title:'Make greetings work without a name',prompt:'Handle missing names and add tests.',sourcePath:options.folder?undefined:'/fixture/project',source:options.folder?'sandbox (folder)':undefined,sourceBranch:options.folder?undefined:'main'},current_attempt:options.lender?{holder:'runner'}:null,historyIdentity:options.lender?{author:'requester',deviceName:'Taylor'}:null,applied:options.applied?{repo:'/fixture/project',branch:'faravan/result',commit:'a'.repeat(40)}:null};
 const receipt={harness:'claude-code-subscription',duration_ms:48000,finished_at:'2026-10-20T15:40:00Z'};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:options.lender?'runner':'borrower',circles:[]}}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.route(/\/api\/jobs(?:\?.*)?$/,r=>{
  if(r.request().method()==='POST'){options.onSend?.(r.request().postDataJSON());return r.fulfill({json:{jobDigest:'sha256:'+'f'.repeat(64)}});}
  return r.fulfill({json:[projectJobFixture(job)]});
 });
 await page.route('**/api/jobs/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/changes')&&options.changesWait)await options.changesWait;
  if(path.endsWith('/transcript')&&options.transcriptWait)await options.transcriptWait;
  if(path.endsWith('/changes')&&options.failed)return r.fulfill({status:409,json:{code:'result_unavailable'}});
  if(path.endsWith('/changes')&&options.skipped)return r.fulfill({json:{format:'diff',diff,files:[{path:'src/greeting.js',status:'modified'}],diffstat:{files:1,insertions:2,deletions:1},receipt,checks:[{cmd:'npm test',exit:null,observed_by:'sandbox',skipped:'The fresh check workspace could not start.',check_context:{note:'Faravan ran npm test after the agent.'}}]}});
  if(path.endsWith('/changed-files'))return r.fulfill({contentType:'application/zip',headers:{'Content-Disposition':'attachment; filename="changed-files.zip"'},body:Buffer.from('PK fixture')});
  if(path.endsWith('/result'))return r.fulfill({contentType:'text/x-diff',headers:{'Content-Disposition':'attachment; filename="changes.patch"'},body:diff});
  if(path.endsWith('/changes')&&options.noChanges)return r.fulfill({json:{format:'diff',diff:'',files:[],diffstat:{files:0,insertions:0,deletions:0},receipt}});
  if(path.endsWith('/changes')&&options.poem)return r.fulfill({json:{format:'message',message:{markdown:'**The Sad Seagull**\n\nOn the pier where the grey waves fall,\nA seagull sits, the saddest of all.\nNo chips today, no crust, no fry —\nJust wind and rain and an empty sky.',url:'/message'},files:[],receipt}});
  if(path.endsWith('/changes')&&options.image)return r.fulfill({json:{format:'files',message:{markdown:'Rendered the Mandelbrot set.',url:'/message'},files:[{path:'faravan-output/mandelbrot.png',bytes:27144,url:'/file',preview:{url:'/api/jobs/x/image',media_type:'image/png'}}],receipt}});
  if(path.endsWith('/image'))return r.fulfill({contentType:'image/png',body:options.tiny?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3wAAAABJRU5ErkJggg==','base64'):mandelbrot});
  if(path.endsWith('/changes')&&options.report)return r.fulfill({json:{format:'message',message:{markdown:'# Parser comparison\n\nA **streaming** parser is a good fit.\n\n| Library | Capability | Package size including streaming dependencies | \n| --- | --- | --- |\n| papaparse | Streaming | 120 kB |\n| csv-parse | Streaming | 80 kB |\n\n```text\n   /\\_/\\\n  ( o.o )\n   > ^ <\n```',url:'/api/jobs/x/message'},files:[],receipt}});
  if(path.endsWith('/changes'))return r.fulfill({json:{format:'diff',diff,files:[{path:'src/greeting.js',status:'modified',insertions:2,deletions:1,hash:'a'},{path:'tests/greeting.test.js',status:'added',insertions:2,deletions:0,hash:'b'},{path:'package-lock.json',status:'modified',insertions:1,deletions:1,hash:'c'}],diffstat:{files:3,insertions:5,deletions:2},bytes:Buffer.byteLength(diff),shown_bytes:Buffer.byteLength(diff),total_lines:diff.trimEnd().split('\n').length,receipt}});
  if(path.endsWith('/transcript'))return r.fulfill({json:{text:JSON.stringify({type:'result',result:options.question?'QUESTION: Should missing names use a friendly greeting?':options.inline?'All pass (`npm test`: 4 passed).':'**Greetings** now handle a missing name.\n\n```text\n   /\\_/\\\n  ( o.o )\n   > ^ <\n```\n\nAdded a focused regression test.'}),live:false}});
  if(path.endsWith('/prompt'))return r.fulfill({json:{text:'Handle missing names and add tests.'}});
  if(path.endsWith('/receipt'))return r.fulfill({json:{receipt,checks:[]}});
  if(path.endsWith('/thread'))return r.fulfill({json:{thread:[]}});
  if(path.endsWith('/continuation'))return r.fulfill({json:{parentJob:digest,parentResult:job.result_digest,base:{path:'/fixture/project',branch:'main',commit:'a'.repeat(40)},handoff:{scan:{status:'passed'},objective:'## Greeting result\n\n**Missing names** now use a friendly greeting.\n\n```text\n  +---------+\n  | friends |\n  +---------+\n```',changes:['| Input | Expected result |\n| --- | --- |\n| Missing name | Hello, friend |'],mode:'summary',trust:'untrusted'}}});
  if(path.endsWith('/timeline')&&options.cancelled)return r.fulfill({json:{complete:true,stages:[{key:'sent',label:'Sent',at:'2026-10-20T15:38:00Z'},{key:'finished',label:'Cancelled',at:'2026-10-20T15:38:20Z',noticed:true}]}});
  if(path.endsWith('/timeline'))return r.fulfill({json:{job_digest:digest,complete:true,stages:[{key:'sent',label:'Sent',at:'2026-10-20T15:38:00Z'},{key:'approval',label:'Approval',at:'2026-10-20T15:38:20Z',durationMs:12000,outcome:'accepted',clock:'this-computer'},{key:'preparing',label:'Preparing the sandbox',at:'2026-10-20T15:38:30Z',durationMs:10000,clock:'reported'},{key:'running',label:'Agent working',at:'2026-10-20T15:38:40Z',durationMs:48000,clock:'reported'},{key:'finished',label:'Finished',at:'2026-10-20T15:39:28Z'}]}});
  if(path.endsWith('/working-tree')){
   const body=r.request().postDataJSON();options.onApply?.(body);
   return r.fulfill({json:body.dry_run?{status:'dry_run',repo:'/fixture/project',head:'a'.repeat(40),current_branch:'main',base:'b'.repeat(40),per_file:true,working_tree:{clean:true,changed:[],more:0},files:[{path:'src/greeting.js',state:'applies',insertions:2,deletions:1},{path:'tests/greeting.test.js',state:'applies',insertions:2,deletions:0}]}:{status:'applied',repo:'/fixture/project',applied:body.files||['src/greeting.js','tests/greeting.test.js'],undo:{restore:body.files||['src/greeting.js','tests/greeting.test.js'],remove:[]}}});
  }
  if(path.endsWith('/remove-branch')){const body=r.request().postDataJSON();options.onRemove?.(body);return r.fulfill({json:{status:body.dry_run?'removable':'removed',branch:'faravan/result',repo:'/fixture/project',commit:'a'.repeat(40)}});}
  if(path.endsWith('/retention'))return r.fulfill({json:{deletable:true,retained_until:options.retentionMissing?undefined:'2026-11-20T12:00:00Z'}});
  return r.fulfill({json:projectJobFixture(job)});
 });
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.locator('.job-page>.jh h1')).toBeVisible();
 await expect(page.getByText('Loading the agent’s summary…')).toHaveCount(0);
}
async function captureStates(page,name,focus) {
 if(!process.env.RESULTS_SHOTS)return;
 if(await page.locator('.result-reader').count())await expect(page.locator('.result-rail').getByRole('button',{name:'Download Markdown',exact:true})).toBeVisible();
 const directory=process.env.RESULTS_SHOTS==='1'?'test-artifacts/results':process.env.RESULTS_SHOTS;
 await mkdir(directory,{recursive:true});
 for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const theme of ['light','dark']) {
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);
  if(focus)await focus.scrollIntoViewIfNeeded();else await page.evaluate(()=>scrollTo(0,0));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await writeFile(join(directory,name+'.'+size+'.'+theme+'.txt'),await page.locator('main').innerText());
  await page.screenshot({path:join(directory,name+'.'+size+'.'+theme+'.png'),fullPage:!focus,animations:'disabled',style:'*,*::before,*::after{transition:none!important;animation:none!important}'});
 }
}

test('result layouts expose the phone decision, wrap long diffs, and preserve sticky headers',async({page})=>{
 await fixture(page);await page.setViewportSize({width:1440,height:900});
 await expect(page.getByLabel('Soft wrap',{exact:true})).toBeChecked();
 for(const code of await page.locator('.diff-row code').all()){expect(await code.evaluate(el=>getComputedStyle(el).fontVariantLigatures)).toBe('none');expect(await code.evaluate(el=>getComputedStyle(el).fontFeatureSettings)).toContain('\"calt\" 0');}
 expect(await page.locator('.diff-scroll').first().evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 expect(await page.locator('.job-page').evaluate(el=>Math.round(el.getBoundingClientRect().left))).toBe(362);
 expect(await page.locator('.job-page').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(1440-24);
 expect(await page.locator('.job-diff .job-file-head').first().evaluate(el=>getComputedStyle(el).position)).toBe('sticky');
 await page.getByLabel('Soft wrap',{exact:true}).uncheck();await expect(page.locator('.review-wrap')).toHaveCount(0);await page.getByLabel('Soft wrap',{exact:true}).check();
 await page.setViewportSize({width:390,height:844});
 const primary=page.getByRole('button',{name:'Add as a branch…',exact:true}).filter({visible:true});
 expect((await primary.boundingBox()).y).toBeLessThan(480);
 await captureStates(page,'code-diff');
 await captureStates(page,'finished-diff-viewport',page.locator('.job-diff').first());
});
for(const state of ['report','noChanges','failed'])test('result state '+state,async({page})=>{
 const options={[state]:true};await fixture(page,'d',options);
 if(state==='noChanges'){await expect(page.locator('.result-workspace')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Agent response',exact:true})).toBeVisible();}
 if(state==='failed'){await expect(page.locator('.jh')).toContainText('Result unavailable');await expect(page.getByText('Loading check observations…',{exact:true})).toHaveCount(0);await expect(page.getByRole('alert').filter({hasText:'The result could not be read. Check the job’s current state.'})).toBeVisible();await expect(page.getByRole('button',{name:'Check current state'})).toBeVisible();expect(await page.locator('.job-result-error').evaluate(el=>el.offsetHeight)).toBeLessThan(220);}
 if(state==='report'){await expect(page.getByRole('button',{name:'Copy message',exact:true}).filter({visible:true})).toHaveCount(1);await expect(page.locator('.result-reader .result-table')).toBeVisible();await page.setViewportSize({width:390,height:844});expect(await page.locator('.result-reader .result-table td').first().evaluate(el=>getComputedStyle(el).overflowWrap)).toBe('normal');

 await expect(page.locator('.result-reader .result-table-frame')).not.toHaveClass(/has-more/);await expect(page.getByText('Scroll to see all columns.',{exact:true})).toHaveCount(0);}
 await captureStates(page,state);
 if(state==='failed'){options.failed=false;await page.getByRole('button',{name:'Check current state'}).click();await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();}
});
test('agent transcript and handoff keep Markdown and fenced art',async({page})=>{
 await fixture(page);
 await page.locator('#job-handoff>summary').click();
 await expect(page.locator('.feed strong')).toHaveCount(0);
 await expect(page.locator('.job-summary strong')).toHaveText('Greetings');
 await expect(page.locator('.job-summary pre')).toContainText('( o.o )');
 await expect(page.locator('.activity')).toHaveCount(0);
 await captureStates(page,'transcript');

 await expect(page.locator('.handoff-fields')).toHaveCount(0);
 await expect(page.locator('#job-handoff')).not.toContainText('The agent claims');
 await expect(page.locator('.result-rail').getByRole('button',{name:'Send a follow-up job',exact:true})).toBeVisible();
 await captureStates(page,'handoff');
});
test('the agent question formats the same safe Markdown',async({page})=>{
 await fixture(page,'d',{question:true});
 await expect(page.getByRole('heading',{name:'The agent has a question'})).toBeVisible();
 await expect(page.locator('.job-summary')).toHaveCount(0);
 await captureStates(page,'agent-question',page.locator('.agent-question'));
});
test('request context formats Markdown and keeps tables and code inside the column',async({page})=>{
 const prompt='## Greeting change\n\nHandle **missing names** while preserving this diagram.\n\n```text\n  +---------+\n  | friends |\n  +---------+\n```\n\n| Example | Expected greeting |\n| --- | --- |\n| Missing name | Hello, friend |';
 const card={id:'markdown-offer',offer:true,jobDigest:digest,requester:'sam',requesterName:'Sam',prompt,harness:'codex',model:[],runtimeSeconds:1200,source:{kind:'archive',size_bytes:1024},network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true},expiresAt:Date.now()+86400000,job:{circle:circle.id,created_at:new Date().toISOString(),requirements:{egress:'provider-only',limits:{wall_seconds:1200}}}};
 for(const [path,json] of Object.entries({circles:[circle],agents:[{id:'codex',installed:true,signedIn:true,useForLending:true}],readiness:{ready:true,checks:[]},approvals:[card],devices:{name:'Tessa’s computer',fingerprint:'tessa',circles:[]},jobs:[],home:{intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{enabled:true,circle:circle.id,current:null,status:'offer',mode:'ask'},needs_you:[]}}))await page.route('**/api/'+path,r=>r.fulfill({json}));
 await page.goto((await harness.link('lender'))+'#/request/markdown-offer');
 await expect(page.locator('.rq-quote strong')).toHaveText('missing names');
 await expect(page.locator('.rq-quote pre')).toContainText('| friends |');
 await captureStates(page,'request');
});
test('phone file header remains visible and unobscured as its wrapped diff scrolls',async({page})=>{
 await fixture(page);await page.setViewportSize({width:390,height:844});
 const file=page.locator('.job-diff').first(),header=file.locator('.job-file-head');
 for(const theme of ['light','dark']){
  await page.emulateMedia({colorScheme:theme});
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await file.evaluate(el=>{el.scrollIntoView({block:'start'});scrollBy(0,60);});
  const box=await header.boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y).toBeLessThan(100);
  expect(await header.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.job-file-head')===el;})).toBe(true);
  if(process.env.RESULTS_SHOTS)await page.screenshot({path:join(process.env.RESULTS_SHOTS,'code-diff-scrolled.phone.'+theme+'.png'),animations:'disabled',style:'*,*::before,*::after{transition:none!important;animation:none!important}'});
 }
});


test('result transition stays neutral until metadata and final transcript have both arrived',async({page})=>{
 let changesDone,transcriptDone;
 const changesWait=new Promise(resolve=>changesDone=resolve),transcriptWait=new Promise(resolve=>transcriptDone=resolve);
 await fixture(page,'d',{report:true,changesWait,transcriptWait});
 await expect(page.getByRole('status',{name:'Loading result',exact:true}).last()).toBeVisible();
 await expect(page.getByText('What changed for you',{exact:true})).toHaveCount(0);
 await expect(page.getByText('Use these changes',{exact:true})).toHaveCount(0);
 await captureStates(page,'result-loading');
 changesDone();await expect(page.locator('.result-reader')).toHaveCount(0);
 transcriptDone();await expect(page.locator('.result-reader')).toBeVisible();
});
test('folder results download changed files with the patch as a secondary action',async({page})=>{
 await fixture(page,'d',{folder:true});
 await expect(page.getByRole('button',{name:'Download the patch',exact:true}).filter({visible:true})).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Add as a branch…',exact:true})).toHaveCount(0);
 await captureStates(page,'folder-result');
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download changed files',exact:true}).filter({visible:true}).click()]);
 expect(download.suggestedFilename()).toBe('changed-files.zip');
});
test('one properties panel and consistent result disclosures omit empty checks',async({page})=>{
 await fixture(page);await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();
 await expect(page.locator('.result-rail>details')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Properties',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Faravan’s checks',exact:true})).toHaveCount(0);
 await expect(page.locator('.result-rail').getByRole('button',{name:'Send a follow-up job',exact:true})).toHaveCount(1);
 for(const label of ['Agent','Time used','Kept until'])await expect(page.locator('.result-properties dt').filter({hasText:label})).toHaveCount(1);
});
test('apply sheet always has a primary action when the folder is empty',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Add as a branch…',exact:true}).filter({visible:true}).click();
 await page.getByRole('textbox',{name:'Repository folder',exact:true}).fill('');
 await expect(page.getByRole('button',{name:'Check the repository',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByText('Enter the repository folder to check it.',{exact:true})).toBeVisible();
 await captureStates(page,'apply-empty');
});

for(const state of ['poem','image','cancelled','followup'])test('r5 '+state+' result details and phone layout',async({page})=>{
 await fixture(page,'d',{[state]:true});
 if(state==='poem'){
  await expect(page.locator('.result-reader .result-prose br')).toHaveCount(3);
  await expect(page.getByRole('heading',{name:'Files',exact:true})).toHaveCount(0);
 }
 if(state==='image'){
  await expect(page.getByRole('img',{name:'Preview of mandelbrot.png'})).toBeVisible();
  await expect(page.getByText('27 KB',{exact:true})).toBeVisible();
  await expect(page.getByText('Show image preview',{exact:true})).toHaveCount(0);
 }
 if(state==='cancelled'){
  await expect(page.locator('.job-timeline')).not.toContainText('Noticed at');
  await expect(page.locator('.job-timeline')).toContainText('Recorded at');
  await expect(page.getByText('You cancelled this job before it started',{exact:true})).toBeVisible();
  await expect(page.getByText('More stages appear as they happen.',{exact:true})).toHaveCount(0);
  await expect(page.locator('.job-page>.card')).toHaveCount(0);
  await expect(page.locator('.rail').getByRole('heading',{name:'Properties',exact:true})).toBeVisible();
  await expect(page.locator('.rail').getByRole('button',{name:'Delete this job…',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Delete this job…'})).not.toHaveClass(/btn-danger/);
  await expect(page.getByText('including the one that ran this job',{exact:false})).toHaveCount(0);
 }
 if(state==='followup')await expect(page.locator('.job-parent-link')).toHaveText('Follow-up to Investigate the CSV parser');
 await captureStates(page,state);
 if(state==='poem'){
  const buttons=page.locator('.result-toolbar .btn');
  for(const button of await buttons.all())expect(await button.evaluate(el=>el.scrollWidth<=el.clientWidth && getComputedStyle(el).whiteSpace==='nowrap')).toBe(true);
 }
});

test('a skipped check says it did not run and never claims to have run it',async({page})=>{
 await fixture(page,'d',{skipped:true});
 const checks=page.locator('.job-main>section').filter({has:page.getByRole('heading',{name:'Faravan’s checks',exact:true})});
 await expect(checks).toContainText("Didn't run: The fresh check workspace could not start.");
 await expect(checks).toContainText("The check didn't run, so nothing was verified.");
 await expect(checks).not.toContainText('Faravan ran npm test');
 await captureStates(page,'skipped-check');
});

test('tiny inline images offer a readable download fallback',async({page})=>{
 await fixture(page,'d',{image:true,tiny:true});
 await expect(page.getByText('1 × 1 pixels · too small to preview. Use Download to keep the image.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Hide image preview'})).toHaveCount(0);
 await captureStates(page,'tiny-image-fallback');
});

test('lenders can read their agent’s final message once in job details',async({page})=>{
 await fixture(page,'d',{lender:true});
 await page.locator('.job-details>summary').first().click();
 await expect(page.locator('.activity')).toContainText('Greetings now handle a missing name.');
 await expect(page.locator('.activity strong')).toHaveText('Greetings');
 await expect(page.locator('.job-summary')).toHaveCount(0);
 await expect(page.getByText('Handle missing names and add tests.',{exact:true})).toBeVisible();
 await captureStates(page,'lender-details');
});

test('poem and image message actions share the result rail',async({page})=>{
 for(const kind of ['poem','image']){
  await fixture(page,'d',{[kind]:true});
  const rail=page.locator('.result-rail');
  await expect(rail.getByRole('button',{name:'Download Markdown',exact:true})).toBeVisible();
  await expect(page.locator('.result-reader button')).toHaveCount(0);
 }
});

test('composer folder input precedes Send and the Project row opens the existing picker',async({page})=>{
 await page.route('**/api/folders/suggest',r=>r.fulfill({json:{recent:[],repos:[],truncated:false}}));
 await page.goto((await harness.link('owner'))+'#/new');
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 const folder=page.getByRole('textbox',{name:'Project folder',exact:true});await expect(folder).toBeVisible();
 const send=page.getByRole('button',{name:'Send',exact:true});
 expect(await folder.evaluate(el=>Boolean(el.compareDocumentPosition(document.querySelector('.cmp-pair .btn-primary'))&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
 await expect(page.locator('summary#cmp-project')).toHaveCount(0);
 await captureStates(page,'composer');
 await page.getByRole('button',{name:'Project settings: Choose project',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Choose a project'})).toBeVisible();
 await page.keyboard.press('Escape');await expect(folder).toBeVisible();
});

test('inline code in summary parentheses has no horizontal chip padding',async({page})=>{
 await fixture(page,'d',{inline:true});
 const code=page.locator('.job-summary p code');await expect(code).toHaveText('npm test');
 expect(await code.evaluate(el=>[getComputedStyle(el).paddingLeft,getComputedStyle(el).paddingRight])).toEqual(['0px','0px']);
 await captureStates(page,'inline-code');
});

test('the apply refusal patch action downloads a patch without treating the click as an endpoint',async({page})=>{
 await fixture(page);
 await page.route('**/api/jobs/**/apply',r=>r.fulfill({status:409,json:{code:'apply_refused',apply_code:'patch_conflict',state:'job.apply-conflict',message:'The changes do not apply cleanly.'}}));
 await page.getByRole('button',{name:'Add as a branch…',exact:true}).filter({visible:true}).click();
 const sheet=page.getByRole('dialog',{name:'Add as a branch',exact:true});
 const patch=sheet.getByRole('button',{name:'Download the patch',exact:true});await expect(patch).toBeVisible();
 const [download]=await Promise.all([page.waitForEvent('download'),patch.click()]);expect(download.suggestedFilename()).toBe('changes.patch');
});

test('phone lender delivery keeps its caption when there is no primary action',async({page})=>{
 await fixture(page,'d',{lender:true});await page.setViewportSize({width:390,height:844});
 await expect(page.locator('.result-rail-section').first()).toContainText('Nothing more to do.');
 await expect(page.locator('.result-rail-section').first().locator('p')).toBeVisible();
});
test('finished results omit retention rows when no date was recorded',async({page})=>{
 await fixture(page,'d',{retentionMissing:true});
 await expect(page.locator('.result-properties')).not.toContainText('Kept until');
});

for(const width of [768,899,900,1024,1100,1199,1200,1280,1440,1600,1920])test('result reading width and one-row file headers at '+width,async({page})=>{
 await page.setViewportSize({width,height:900});await fixture(page,'d',{folder:true});
 const frame=await page.locator('.job-page').boundingBox();
 for(const name of await page.locator('.review-tree-name').all())expect(await name.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 const diffBox=await page.locator('.review-diffs').boundingBox();
 if(width===1440)expect(diffBox.width).toBeGreaterThanOrEqual(700);
 if(width===1024)expect(diffBox.width).toBeGreaterThanOrEqual(650);
 for(const header of await page.locator('.review-diffs .job-file-head').all()){
  const geometry=await header.evaluate(el=>{
   const children=[...el.children].map(child=>({tag:child.tagName,rect:child.getBoundingClientRect().toJSON()}));
   const code=el.querySelector('code'),style=getComputedStyle(code);
   return {children,codeHeight:code.getBoundingClientRect().height,lineHeight:parseFloat(style.lineHeight),codeClipped:code.scrollWidth>code.clientWidth};
  });
  expect(geometry.codeHeight).toBeLessThanOrEqual(geometry.lineHeight+1);
  expect(geometry.codeClipped).toBe(false);
  const centers=geometry.children.filter(child=>child.rect.width&&child.rect.height).map(child=>child.rect.y+child.rect.height/2);
  expect(Math.max(...centers)-Math.min(...centers)).toBeLessThan(2);
 }
 await expect(page.locator('.result-properties')).not.toContainText('Not recorded');
 await page.goto((await harness.link('owner'))+'#/new');await expect(page.locator('.compose')).toBeVisible();
 const normal=await page.locator('.compose').boundingBox();
 expect(frame.x).toBeCloseTo(normal.x,0);expect(frame.y).toBeCloseTo(normal.y,0);
});

for(const [name,options] of [['folder',{folder:true}],['git',{}],['lender',{lender:true}],['unknown',{folder:true,retentionMissing:true}]])test('result frame followup captures '+name,async({page})=>{
 await fixture(page,'d',options);
 for(const [width,height] of [[1440,900],[1024,900],[390,844]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;scrollTo(0,0);},theme);
  await expect(page.locator('.result-properties')).not.toContainText('Not recorded');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const metrics=await page.locator('.review-diffs').evaluate(el=>({width:el.getBoundingClientRect().width}));
  console.log('Result width',JSON.stringify({state:name,width,theme,diffWidth:metrics.width}));
  if(process.env.RESULT_FRAME_SHOTS){
   const prefix=join(process.env.RESULT_FRAME_SHOTS,name+'.'+width+'.'+theme);
   await mkdir(process.env.RESULT_FRAME_SHOTS,{recursive:true});
   await writeFile(prefix+'.txt',await page.locator('main').innerText());
   const options={animations:'disabled',style:'*,*::before,*::after{transition:none!important;animation:none!important}'};
   await page.screenshot({...options,path:prefix+'.png',fullPage:true});
   await page.screenshot({...options,path:prefix+'.viewport.png'});
  }
 }
});

test('phone file headers keep the extension together',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);
 const code=page.locator('.review-diffs .job-file-head>code').filter({hasText:'tests/greeting.test.js'});
 expect(await code.evaluate(el=>{
  const nodes=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode())nodes.push(node);
  let offset=el.textContent.length-3,index=0;
  while(offset>=nodes[index].length){offset-=nodes[index].length;index++;}
  const range=document.createRange();range.setStart(nodes[index],offset);range.setEnd(nodes.at(-1),nodes.at(-1).length);
  return [...range.getClientRects()].filter(rect=>rect.width&&rect.height).length;
 })).toBe(1);
});
test('result rail buttons have a consistent width',async({page})=>{
 await fixture(page);
 const widths=await page.locator('.result-rail .btn').evaluateAll(els=>els.map(el=>el.getBoundingClientRect()).filter(rect=>rect.width&&rect.height).map(rect=>rect.width));
 expect(Math.max(...widths)-Math.min(...widths)).toBeLessThan(1);
});
