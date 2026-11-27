import {test,expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const digest='sha256:'+'c'.repeat(64),circle={id:'review-circle',name:'Weekend projects',origin:'http://fixture',rosterMembershipVerified:true};
const diff='diff --git a/src/greeting.js b/src/greeting.js\nindex 123..456 100644\n--- a/src/greeting.js\n+++ b/src/greeting.js\n@@ -1,3 +1,4 @@\n export function greet(name) {\n-  return "Hello " + name;\n+  if (!name) return "Hello, friend";\n+  return `Hello, ${name}`;\n }\ndiff --git a/tests/greeting.test.js b/tests/greeting.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/greeting.test.js\n@@ -0,0 +1,2 @@\n+test("greets friends", () => {\n+  assert.equal(greet(), "Hello, friend");\ndiff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
async function fixture(page,result='d',options={}) {
 const job={job_digest:digest,circle,state:'result-accepted',result_digest:'sha256:'+result.repeat(64),local:options.lender?undefined:{title:'Make greetings work without a name',prompt:'Handle missing names and add tests.',sourcePath:'/fixture/project'},current_attempt:options.lender?{holder:'runner'}:null,historyIdentity:options.lender?{author:'requester',deviceName:'Taylor'}:null,applied:options.applied?{repo:'/fixture/project',branch:'faravan/result',commit:'a'.repeat(40)}:null};
 const receipt={harness:'claude-code-subscription',duration_ms:48000,finished_at:'2026-10-20T15:40:00Z'};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:options.lender?'runner':'borrower',circles:[]}}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.route(/\/api\/jobs(?:\?.*)?$/,r=>{
  if(r.request().method()==='POST'){options.onSend?.(r.request().postDataJSON());return r.fulfill({json:{jobDigest:'sha256:'+'f'.repeat(64)}});}
  return r.fulfill({json:[projectJobFixture(job)]});
 });
 await page.route('**/api/jobs/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/changes'))return r.fulfill({json:{format:'diff',diff,files:[{path:'src/greeting.js',status:'modified',insertions:2,deletions:1,hash:'a'},{path:'tests/greeting.test.js',status:'added',insertions:2,deletions:0,hash:'b'},{path:'package-lock.json',status:'modified',insertions:1,deletions:1,hash:'c'}],diffstat:{files:3,insertions:5,deletions:2},bytes:Buffer.byteLength(diff),shown_bytes:Buffer.byteLength(diff),total_lines:diff.trimEnd().split('\n').length,receipt}});
  if(path.endsWith('/transcript')&&options.transcriptReply)return options.transcriptReply(r);
  if(path.endsWith('/transcript'))return r.fulfill({json:{text:JSON.stringify({type:'result',result:options.question?'QUESTION: Should missing names use a friendly greeting?':'Greetings now handle a missing name. Added a focused regression test.'}),live:false}});
  if(path.endsWith('/receipt'))return r.fulfill({json:{receipt,checks:[]}});
  if(path.endsWith('/thread'))return r.fulfill({json:{thread:[]}});
  if(path.endsWith('/continuation'))return r.fulfill({json:{parentJob:digest,parentResult:job.result_digest,base:{path:'/fixture/project',branch:'main',commit:'a'.repeat(40)},handoff:{scan:{status:'passed'},objective:'Handle missing names',changes:['Updated the greeting'],mode:'summary',trust:'untrusted'}}});
  if(path.endsWith('/timeline'))return r.fulfill({json:{job_digest:digest,complete:true,stages:[{key:'sent',label:'Sent',at:'2026-10-20T15:38:00Z'},{key:'approval',label:'Approval',at:'2026-10-20T15:38:20Z',durationMs:12000,outcome:'accepted',clock:'this-computer'},{key:'preparing',label:'Preparing the sandbox',at:'2026-10-20T15:38:30Z',durationMs:10000,clock:'reported'},{key:'running',label:'Agent working',at:'2026-10-20T15:38:40Z',durationMs:48000,clock:'reported'},{key:'finished',label:'Finished',at:'2026-10-20T15:39:28Z'}]}});
  if(path.endsWith('/working-tree')){
   const body=r.request().postDataJSON();options.onApply?.(body);
   return r.fulfill({json:body.dry_run?{status:'dry_run',repo:'/fixture/project',head:'a'.repeat(40),current_branch:'main',base:'b'.repeat(40),per_file:true,working_tree:{clean:true,changed:[],more:0},files:[{path:'src/greeting.js',state:'applies',insertions:2,deletions:1},{path:'tests/greeting.test.js',state:'applies',insertions:2,deletions:0}]}:{status:'applied',repo:'/fixture/project',applied:body.files||['src/greeting.js','tests/greeting.test.js'],undo:{restore:body.files||['src/greeting.js','tests/greeting.test.js'],remove:[]}}});
  }
  if(path.endsWith('/remove-branch')){const body=r.request().postDataJSON();options.onRemove?.(body);return r.fulfill({json:{status:body.dry_run?'removable':'removed',branch:'faravan/result',repo:'/fixture/project',commit:'a'.repeat(40)}});}
  if(path.endsWith('/retention'))return r.fulfill({json:{}});
  return r.fulfill({json:projectJobFixture(job)});
 });
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();
}
async function captureStates(page,name,focus) {
 if(!process.env.RESULTS_SHOTS)return;
 const directory=process.env.RESULTS_SHOTS==='1'?'test-artifacts/results':process.env.RESULTS_SHOTS;
 await mkdir(directory,{recursive:true});
 for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const theme of ['light','dark']) {
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);
  if(focus)await focus.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:join(directory,name+'.'+size+'.'+theme+'.png'),fullPage:!focus});
 }
}
test('viewed review survives reload and is invalidated for another result',async({page})=>{
 await fixture(page);
 const viewed=page.getByRole('checkbox',{name:'Viewed src/greeting.js',exact:true});
 await viewed.check();await expect(page.getByText('1 of 3 viewed',{exact:true})).toBeVisible();
 await page.reload();await expect(viewed).toBeChecked();
 await page.unroute('**/api/jobs/**');await fixture(page,'e');await expect(viewed).not.toBeChecked();
 await expect(page.locator('.review-generated').getByRole('button',{name:'Expand package-lock.json',exact:true})).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.review-generated .diff-scroll')).not.toBeVisible();
});
test('result review has no overflow in desktop and phone, light and dark',async({page})=>{
 await fixture(page);
 await captureStates(page,'review');
 for(const [width,height] of [[1440,900],[390,844]]) {
  await page.setViewportSize({width,height});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});

test('private line notes survive reload and Ask for changes sends the anchored delta with its parent',async({page})=>{
 const sends=[];await fixture(page,'d',{onSend:body=>sends.push(body)});
 await page.getByRole('button',{name:'Add note on src/greeting.js new line 2',exact:true}).click();
 await page.getByLabel('Note on new line 2').fill('Please cover whitespace-only names too.');
 await page.getByRole('button',{name:'Save note',exact:true}).click();
 await page.reload();await expect(page.getByText('Please cover whitespace-only names too.',{exact:true})).toBeVisible();
 await captureStates(page,'notes',page.getByText('Please cover whitespace-only names too.',{exact:true}));
 await page.getByRole('button',{name:'Ask for changes…'}).click();
 await expect(page.getByLabel('What should change next?')).toHaveValue(/src\/greeting.js \(new line 2\): Please cover whitespace-only names too/);
 await page.getByRole('button',{name:'Send',exact:true}).click();await confirmFirstSend(page);await expect.poll(()=>sends.length).toBe(1);
 expect(sends[0].followup).toEqual({parentJob:digest,parentResult:'sha256:'+'d'.repeat(64)});expect(sends[0]).not.toHaveProperty('repo');
});
test('a declared question becomes an answer follow-up rather than a waiting live run',async({page})=>{
 const sends=[];await fixture(page,'d',{question:true,onSend:body=>sends.push(body)});
 await expect(page.getByRole('heading',{name:'The agent has a question'})).toBeVisible();
 await page.getByLabel('Your answer').fill('Yes, use a friendly greeting.');
 await captureStates(page,'question',page.getByRole('heading',{name:'The agent has a question'}));
 await page.getByRole('button',{name:'Prepare follow-up',exact:true}).click();
 await expect(page.getByLabel('What should change next?')).toHaveValue(/Yes, use a friendly greeting/);
 await page.getByRole('button',{name:'Send',exact:true}).click();await confirmFirstSend(page);await expect.poll(()=>sends.length).toBe(1);
 expect(sends[0].followup.parentJob).toBe(digest);expect(sends[0].prompt).toContain('Answer to the agent’s question');
});
test('working-tree preview sends only selected files and branch removal confirms the saved branch',async({page})=>{
 const applies=[],removes=[];await fixture(page,'d',{applied:true,onApply:body=>applies.push(body),onRemove:body=>removes.push(body)});
 await page.locator('#job-handoff>summary').click();
 await page.getByText('Advanced: apply directly to your working tree',{exact:true}).click();
 await page.getByRole('button',{name:'Check the folder',exact:true}).click();
 const files=page.getByRole('list',{name:'Files to apply'});await expect(files).toBeVisible();
 await captureStates(page,'apply',files);
 await files.getByRole('checkbox').nth(1).uncheck();await page.getByRole('button',{name:'Apply 1 file',exact:true}).click();
 await expect.poll(()=>applies.length).toBe(2);expect(applies[1]).toMatchObject({circle:circle.id,dry_run:false,files:['src/greeting.js'],expect:{head:'a'.repeat(40),current_branch:'main'}});
 await expect(page.getByText(/Applied 1 file to/)).toBeVisible();
 await page.getByRole('button',{name:'Remove this branch…',exact:true}).click();
 await expect(page.getByRole('button',{name:'Remove faravan/result',exact:true})).toBeVisible();
 expect(removes).toEqual([{circle:circle.id,dry_run:true}]);
 await page.getByRole('button',{name:'Remove faravan/result',exact:true}).click();await expect.poll(()=>removes.length).toBe(2);expect(removes[1]).toEqual({circle:circle.id,dry_run:false});
});
test('split layout pairs changes, and phones retain unified gutters',async({page})=>{
 await fixture(page);await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'Split view',exact:true}).click();await expect(page.locator('.review-split-labels').first()).toContainText('BeforeAfter');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.review-unified-lines').first()).toBeVisible();await expect(page.locator('.review-split-lines').first()).not.toBeVisible();
});
test('lenders can review the delivered diff and timeline without borrower apply controls',async({page})=>{
 await fixture(page,'d',{lender:true});await expect(page.getByRole('heading',{name:'Result delivered'})).toBeVisible();await page.locator('.job-main>.job-details>summary').click();await expect(page.getByRole('region',{name:'Timeline'})).toBeVisible();
 await captureStates(page,'lender',page.getByRole('heading',{name:'Result delivered'}));
 await expect(page.getByRole('button',{name:'Add as a branch…'})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Apply to working tree'})).toHaveCount(0);
});
test('circle activity pages saved events and changes its exact type filter',async({page})=>{
 await fixture(page);const reads=[],observedAt=Date.now();
 const event=(id,type,data)=>({id,type,at:new Date(observedAt-id*1000).toISOString(),circle:circle.id,data:{circle:circle.id,...data}});
 await page.route('**/api/activity/history?**',route=>{
  const query=new URL(route.request().url()).searchParams;reads.push(Object.fromEntries(query));
  const events=query.has('types')?[event(20,'enrollment',{state:'joined',deviceName:'Morgan’s laptop'})]
    :query.has('before')?[event(10,'job',{job_digest:'sha256:'+'b'.repeat(64),status:'Finished'})]
    :[event(30,'job',{job_digest:digest,status:'Running'})];
  return route.fulfill({json:{events,nextBefore:query.has('types')||query.has('before')?null:30,retention:{days:90,durable:true}}});
 });
 await page.goto((await harness.link('owner'))+'#/circle/'+circle.id);await page.getByRole('tab',{name:'Activity',exact:true}).click();
 await expect(page.getByText(/Job started ·/)).toBeVisible();
 await page.getByRole('button',{name:'Show older',exact:true}).click();await expect(page.getByText(/Job finished ·/)).toBeVisible();
 await page.getByRole('combobox',{name:'Activity type',exact:true}).selectOption('people');
 await expect(page.getByText(/Device joined ·/)).toBeVisible();await expect(page.getByText(/Job finished ·/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Show older',exact:true})).toHaveCount(0);
 expect(reads).toContainEqual({circle:circle.id,before:'30'});expect(reads.at(-1)).toEqual({circle:circle.id,types:'enrollment,member-left'});
 await expect(page.getByText('This computer keeps activity for 90 days.',{exact:true})).toBeVisible();
 await captureStates(page,'activity',page.getByRole('heading',{name:'Recent activity',exact:true}));
});
test('refreshing saved activity resets older pagination without leaving an unrecoverable gap',async({page})=>{
 await page.addInitScript(()=>{
  const fetch=window.fetch.bind(window);
  window.fetch=(input,init)=>String(input?.url??input).includes('/api/events?')?Promise.resolve(new Response(new ReadableStream({start(controller){window.refreshResultHistory=()=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:9000,type:'job',data:{refresh:true}})+'\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}})):fetch(input,init);
 });
 await fixture(page);let refreshed=false;const observedAt=new Date().toISOString();
 await page.route('**/api/activity/history?**',route=>{
  const older=new URL(route.request().url()).searchParams.has('before');
  const events=[{id:older?10:refreshed?50:30,type:'job',at:observedAt,data:{circle:circle.id,job_digest:older?'sha256:'+'b'.repeat(64):digest,status:older?'Finished':'Running'}}];
  return route.fulfill({json:{events,nextBefore:older?null:refreshed?50:30,retention:{days:90,durable:true}}});
 });
 await page.goto((await harness.link('owner'))+'#/circle/'+circle.id);await page.getByRole('tab',{name:'Activity',exact:true}).click();
 await page.getByRole('button',{name:'Show older',exact:true}).click();await expect(page.getByText(/Job finished ·/)).toBeVisible();
 refreshed=true;await page.evaluate(()=>window.refreshResultHistory());
 await expect(page.getByRole('button',{name:'Show older',exact:true})).toBeVisible();
 await expect(page.getByText(/Job finished ·/)).toHaveCount(0);
 await page.getByRole('button',{name:'Show older',exact:true}).click();await expect(page.getByText(/Job finished ·/)).toBeVisible();
});

test('phone line-number notes, stacked tree and single file header',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedReviewPath=text;}}}));
 await page.setViewportSize({width:390,height:844});await fixture(page);
 const file=page.locator('#diff-file-0'),head=file.locator('.job-file-head');
 await expect(head).toHaveCount(1);await expect(head.getByRole('checkbox',{name:'Viewed src/greeting.js',exact:true})).toBeVisible();
 await expect(head.getByRole('button',{name:'Copy path for src/greeting.js',exact:true})).toBeVisible();
 await head.getByRole('button',{name:'Copy path for src/greeting.js',exact:true}).click();
 expect(await page.evaluate(()=>window.copiedReviewPath)).toBe('src/greeting.js');
 await expect(file.locator('.diff-scroll')).toBeVisible();
 await expect(file.locator('.review-line-note').first()).not.toBeVisible();
 for(const side of ['old','new']) {
  await file.getByRole('button',{name:'Add note on src/greeting.js '+side+' line 2',exact:true}).click();
  await expect(page.getByLabel('Note on '+side+' line 2')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 const groups=page.locator('.review-group'),a=await groups.nth(0).boundingBox(),b=await groups.nth(1).boundingBox();
 expect(b.y).toBeGreaterThan(a.y);
 expect(await page.locator('.review-tree-name').first().evaluate(e=>getComputedStyle(e).fontFamily)).toMatch(/mono/i);
 await head.getByRole('button',{name:'Collapse src/greeting.js',exact:true}).click();
 await expect(file.locator('.diff-scroll')).not.toBeVisible();
 await head.getByRole('checkbox',{name:'Viewed src/greeting.js',exact:true}).check();
 await expect(file.locator('.diff-scroll')).not.toBeVisible();
 await head.getByRole('button',{name:'Expand src/greeting.js',exact:true}).click();
 await expect(file.locator('.diff-scroll')).toBeVisible();
});
test('unwrapped split sides scroll independently with fixed gutters',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await fixture(page);
 await page.getByRole('button',{name:'Split view',exact:true}).click();
 await page.getByRole('checkbox',{name:'Soft wrap',exact:true}).uncheck();
 const panes=page.locator('#diff-file-0 .review-split-pane');
 await expect(panes).toHaveCount(2);
 // Make existing lines long without changing their line anchors.
 await panes.evaluateAll(nodes=>nodes.forEach(node=>node.querySelectorAll('code').forEach(code=>code.textContent+='x'.repeat(500))));
 for(const index of [0,1]) {
  const pane=panes.nth(index),gutter=pane.locator('.line-number').first(),before=await gutter.boundingBox();
  const other=await panes.nth(1-index).evaluate(e=>e.scrollLeft);
  await pane.evaluate(e=>e.scrollLeft=160);
  expect(await pane.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);
  expect((await gutter.boundingBox()).x).toBeCloseTo(before.x,0);
  expect(await panes.nth(1-index).evaluate(e=>e.scrollLeft)).toBe(other);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(process.env.RESULTS_SHOTS)for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('#diff-file-0').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(process.env.RESULTS_SHOTS,'split-nowrap.desktop.'+theme+'.png'),animations:'disabled'});
 }
});

for(const width of [1440,1600])test('desktop changed files remain readable and filterable at '+width,async({page})=>{
 await page.setViewportSize({width,height:900});await fixture(page);
 const tree=page.getByRole('navigation',{name:'Changed files'}),diff=page.locator('.review-diffs');
 const treeBox=await tree.boundingBox(),diffBox=await diff.boundingBox();
 // One page frame at every width: the file list sits above the full-width diff, never beside it.
 expect(treeBox.y+treeBox.height).toBeLessThanOrEqual(diffBox.y);expect(diffBox.width).toBeGreaterThanOrEqual(680);
 for(const name of await tree.locator('.review-tree-name').all()) {
  expect(await name.evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('nowrap');
  expect(await name.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 }
 await page.getByRole('searchbox',{name:'Filter changed files'}).fill('greeting.test');
 await expect(tree.getByRole('button')).toHaveCount(1);
 await tree.getByRole('button').click();
 await expect(page.locator('#diff-file-1')).toBeInViewport();
});

test('the branch sheet hides the advanced working-tree folder form',async({page})=>{
 await fixture(page);
 await page.locator('#job-handoff>summary').click();
 await page.getByText('Advanced: apply directly to your working tree',{exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Repository folder for apply',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add as a branch…',exact:true}).filter({visible:true}).click();
 await expect(page.getByRole('textbox',{name:'Repository folder for apply',exact:true})).toHaveCount(0);
 await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Repository folder for apply',exact:true})).toBeVisible();
});

test('summary Reload queues behind the single-flight reader and refetches immediately',async({page})=>{
 let reads=0,releasePoll;
 await fixture(page,'d',{transcriptReply:r=>{
  reads++;
  if(reads===1)return r.fulfill({status:408,json:{code:'read_timeout'}});
  if(reads===2)return new Promise(resolve=>{releasePoll=async()=>{await r.fulfill({status:408,json:{code:'read_timeout'}});resolve();};});
  return r.fulfill({json:{text:JSON.stringify({type:'result',result:'The recovered final summary.'}),live:false}});
 }});
 await expect(page.getByText('Faravan has not finished loading. Check the connection before reloading.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Reload and review',exact:true})).toBeVisible();
 await expect.poll(()=>reads).toBe(2);
 const started=Date.now();await page.getByRole('button',{name:'Reload and review',exact:true}).click();
 expect(reads).toBe(2);
 await releasePoll();
 await expect(page.locator('.job-summary')).toContainText('The recovered final summary.',{timeout:3000});
 expect(Date.now()-started).toBeLessThan(4000);expect(reads).toBe(3);
});
