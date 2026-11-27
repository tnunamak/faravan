import {test,expect} from '@playwright/test';
import {projectJobFixture, startHarness} from './lib.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const digest='sha256:'+'c'.repeat(64),circle={id:'journey',name:'Weekend projects',origin:'http://fixture'};
const members=[{key_id:'owner',device_name:'sandpiper',personName:'Alex Example'},{key_id:'friend',device_name:'kestrel',personName:'Maya Okafor'}];
const diff='diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/parse.js b/src/parse.js\n--- a/src/parse.js\n+++ b/src/parse.js\n@@ -1 +1,2 @@\n-export const parse = text => text;\n+export const parse = text => text.trim();\n+export const lines = text => parse(text).split("\\n");\n';
async function fixture(page,{viewer='owner',state='result-accepted',poem=false,applied=false,missingDocker=false,stop=false}={}){
 const self=members.find(member=>member.key_id===viewer),running=['running','cancelled'].includes(state);
 const job={job_digest:digest,circle,state,result_digest:state==='result-accepted'?'sha256:'+'d'.repeat(64):null,
  ...(viewer==='owner'?{local:{title:poem?'Write a poem':'Update notes',prompt:poem?'Write a poem':'Update the notes',sourcePath:'/home/sam/code/weekend-app',sourceBranch:'main'}}:{}),
  current_attempt:{holder:'friend',attempt_id:'attempt',execution_started_at:new Date(Date.now()-60000).toISOString()},historyIdentity:{author:'owner',deviceName:'sandpiper'},
  runTiming:stop?{stopRequestedAt:new Date().toISOString()}:undefined,
  // Keep the long legacy-prefixed branch as a compatibility and wrapping fixture.
  applied:applied?{repo:'/home/sam/code/weekend-app',branch:'faravan/a-very-long-branch-name-to-test-phone-width'}:null};
 let deleted=false;
 const receipt={harness:'codex',duration_ms:48000};
 const home={intent:{on:true,state:'ready'},desktop:{platform:'linux'},execution:{state:viewer==='friend'&&running?'running':'idle'},lending:{enabled:true,circle:circle.id,status:viewer==='friend'&&running?'running':'idle',limits:{dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200},mode:'ask'}};
 const data={circles:[circle],devices:{fingerprint:viewer,name:self.device_name,ownerName:self.personName,circles:[{circle:circle.id,members}]},agents:[{id:'codex',installed:true,signedIn:true,useForLending:true}],readiness:{ready:!missingDocker,checks:[{name:'sbx_install',ok:!missingDocker,remedy:missingDocker?'curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-sbx':''},{name:'sbx_daemon',ok:!missingDocker},{name:'docker_login',ok:true}]},approvals:[],home};
 for(const [path,json] of Object.entries(data))await page.route('**/api/'+path,r=>r.fulfill({json}));
 await page.route(/\/api\/jobs(?:\?.*)?$/,r=>r.fulfill({json:deleted?[]:[projectJobFixture(job)]}));
 await page.route('**/api/jobs/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/delete')){deleted=true;return r.fulfill({json:{deleted:true}});}
  if(path.endsWith('/apply')){
   const body=r.request().postDataJSON();
   return r.fulfill({json:{status:body.dry_run?'dry_run':'applied',branch:body.branch,repo:body.repo,head:'a'.repeat(40),base:'b'.repeat(40),current_branch:'main',files:1,files_changed:[{path:'notes.txt',insertions:1,deletions:1}],commit:'e'.repeat(40)}});
  }
  if(path.endsWith('/changes'))return r.fulfill({json:poem?{format:'message',message:{markdown:'Grey waves fall,\nA seagull calls.\n\n```text\n  <(o )___\n   ( ._> /\n```',url:'/message'},files:[],receipt}:{format:'diff',diff,files:[{path:'notes.txt',insertions:1,deletions:1,status:'modified'},{path:'src/parse.js',insertions:2,deletions:1,status:'modified'}],diffstat:{files:2,insertions:3,deletions:2},receipt}});
  if(path.endsWith('/transcript'))return r.fulfill({json:{text:JSON.stringify(running?{type:'assistant',message:{content:[{type:'text',text:'Reading notes.txt and preparing the result.'}]}}:{type:'result',result:'Updated the notes.'}),live:running}});
  if(path.endsWith('/prompt'))return r.fulfill({json:{text:poem?'Write a poem':'Update the notes'}});
  if(path.endsWith('/retention'))return r.fulfill({json:{deletable:true,retained_until:'2026-11-20T12:00:00Z'}});
  if(path.endsWith('/thread'))return r.fulfill({json:{thread:[]}});
  if(path.endsWith('/progress'))return r.fulfill({json:{entries:[]}});
  if(path.endsWith('/timeline'))return r.fulfill({json:{complete:true,stages:[]}});
  return r.fulfill({json:projectJobFixture(job)});
 });
 await page.goto((await harness.link(viewer==='owner'?'owner':'lender'))+(missingDocker?'#/setup':'#/job/'+encodeURIComponent(digest)+'/'+circle.id));
 if(missingDocker)await expect(page.locator('.docker-install')).toBeVisible();
 else if(!running)await expect(page.locator('.result-properties')).toBeVisible();
 else if(state==='running')await expect(page.locator('.activity')).toContainText('Reading notes.txt');
 else await expect(page.locator('.job-page')).toContainText('asked');
}
async function captures(page,name){
 if(!process.env.JOURNEY_SHOTS)return;
 await mkdir(process.env.JOURNEY_SHOTS,{recursive:true});
 for(const [width,height] of [[1440,900],[390,844]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;scrollTo(0,0);},theme);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const prefix=join(process.env.JOURNEY_SHOTS,name+'.'+width+'.'+theme);
  await writeFile(prefix+'.txt',await page.locator('main').innerText());
  await page.screenshot({path:prefix+'.png',fullPage:true,animations:'disabled'});
  await page.screenshot({path:prefix+'.viewport.png',animations:'disabled'});
 }
}
test('O9 results keep both common page edges and a full width diff',async({page})=>{
 await page.setViewportSize({width:1440,height:900});await fixture(page);
 const frame=await page.locator('.job-page').boundingBox(),rail=await page.locator('.result-rail').boundingBox();
 await expect(page.locator('.review-diffs')).toBeVisible();
 const tree=await page.getByRole('navigation',{name:'Changed files'}).boundingBox(),diffBox=await page.locator('.review-diffs').boundingBox();
 expect(diffBox.width).toBeGreaterThanOrEqual(700);expect(tree.y+tree.height).toBeLessThanOrEqual(diffBox.y);expect(diffBox.x+diffBox.width).toBeLessThanOrEqual(1323);
 await captures(page,'git-result');
 await page.setViewportSize({width:1440,height:900});await page.goto((await harness.link('owner'))+'#/new');await expect(page.locator('.compose')).toBeVisible();
 const common=await page.locator('.page').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left+parseFloat(s.paddingLeft),right:r.right-parseFloat(s.paddingRight)};});
 expect(frame.x).toBeCloseTo(common.left,0);expect(frame.x+frame.width).toBeCloseTo(common.right,0);
 expect(common.right).toBe(1322);expect(rail.x+rail.width).toBeLessThanOrEqual(common.right+1);
});
test('O8 Add confirms from the mutation even while detail reads still report Ready',async({page})=>{
 await fixture(page);await page.getByRole('button',{name:'Add as a branch…',exact:true}).filter({visible:true}).click();
 const sheet=page.getByRole('dialog',{name:'Add as a branch',exact:true});
 await expect(sheet.getByRole('button',{name:'Add the branch',exact:true})).toBeVisible();
 await sheet.getByRole('button',{name:'Add the branch',exact:true}).click();
 await expect(page.locator('.job-applied')).toContainText('Added as branch faravan/cccccccccccc',{timeout:1500});
 await expect(page.getByRole('button',{name:'Add as a branch…',exact:true})).toHaveCount(0);
 await captures(page,'branch-confirmed');
 await page.setViewportSize({width:390,height:844});
 await expect(page.getByText('The branch is on your computer, in weekend-app. Switch to it there.',{exact:true})).toBeVisible();
 await expect(page.locator('.job-applied .cmd')).not.toBeVisible();
});
test('O10 desktop branch command wraps with a copy button and phone gives computer instructions',async({page})=>{
 await fixture(page,{applied:true});
 await expect(page.locator('.job-applied .cmd')).toBeVisible();
 await expect(page.locator('.job-applied').getByRole('button',{name:'Copy command',exact:true})).toBeVisible();
 expect(await page.locator('.job-applied .cmd code').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
 await captures(page,'long-branch');
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.job-applied .cmd')).not.toBeVisible();
});
test('O8 Delete confirms and leaves the job',async({page})=>{
 await fixture(page);
 await page.getByRole('button',{name:'Delete this job…',exact:true}).click();await page.getByRole('button',{name:'Delete job',exact:true}).click();
 await expect(page).toHaveURL(/#\/jobs$/,{timeout:1500});await expect(page.getByText('Job deleted',{exact:true})).toBeVisible();
 await captures(page,'job-deleted');
});
for(const viewer of ['owner','friend'])test('O3 live person copy on '+viewer,async({page})=>{
 await fixture(page,{viewer,state:'running'});
 await expect(page.locator('.job-page')).not.toContainText(/sandpiper|kestrel/);
 await captures(page,viewer+'-live');
 await fixture(page,{viewer,state:'cancelled',stop:true});
 await expect(page.locator('.job-page')).toContainText(viewer==='friend'?'Alex Example asked to stop this job':'You asked Maya Okafor’s computer to stop');
 await captures(page,viewer+'-stop');
});
test('O3 lender poem delivery fits a message job',async({page})=>{
 await fixture(page,{viewer:'friend',poem:true});await expect(page.locator('.job-page')).not.toContainText(/sandpiper|kestrel|add it to their project/);
 await expect(page.locator('.job-page')).toContainText('Sent to Alex Example');await captures(page,'poem-delivered');
});
test('O6 setup links Docker and shows the complete terminal step',async({page})=>{
 await fixture(page,{missingDocker:true});await expect(page.locator('.docker-install a')).toHaveAttribute('href',/docker\.com\/ai\/sandboxes\/install\/#install-on-ubuntu/);
 await expect(page.locator('.docker-install')).toContainText('This step needs a terminal');await expect(page.locator('.docker-install code')).toContainText('sudo apt-get install');
 await captures(page,'docker-missing');
});
// Noticeable items on the journey screens (r7 N3, N9, N10).
test('N3 Save confirms inside the sticky footer, on screen after scrolling',async({page})=>{
 let limits={timeZone:'America/Chicago',dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,quotaReserve:30,idleOnly:true,lendingPolicy:{preset:'unlikely_to_need'}};
 await page.route('**/api/home',r=>r.fulfill({json:{state:'off',lending:{enabled:false,circle:'shared',mode:'ask',standingRules:[],limits,configVersion:7}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Friends',origin:'http://fixture'}]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',circles:[{circle:'shared',members:[{key_id:'me',device_name:'Laptop'}]}]}}));
 await page.route('**/api/agents',r=>r.fulfill({json:[]}));
 await page.route('**/api/lending/limits',r=>{limits={...limits,...r.request().postDataJSON()};return r.fulfill({json:{ok:true}});});
 await page.setViewportSize({width:1440,height:900});await page.goto((await harness.link('lender'))+'#/lend/limits');
 await page.getByLabel('Minutes a day',{exact:true}).fill('65');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 const saved=page.locator('.limits-footer [role=status]');await expect(saved).toHaveText('Saved.');
 await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
 const box=await saved.boundingBox();expect(box.y).toBeGreaterThan(0);expect(box.y+box.height).toBeLessThanOrEqual(900);
 await captures(page,'limits-saved');
});
test('N9 a used invitation button says what the next one does',async({page})=>{
 const circle={id:'shared',name:'Friends',origin:'http://fixture',owned:true};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',ownerName:'Alex Example',circles:[{circle:'shared',members:[{key_id:'me',device_name:'Laptop'}]}]}}));
 await page.route('**/api/circles/shared/invite',r=>r.fulfill({json:{invite:'https://circle.example/i/abcdefghij#link'}}));
 for(const part of ['people','approvals','invitations'])await page.route('**/api/circles/shared/'+part,r=>r.fulfill({json:[]}));
 await page.goto((await harness.link('owner'))+'#/circle/shared');
 await page.getByRole('button',{name:'Invite someone',exact:true}).click();
 await page.getByRole('button',{name:'Create invitation',exact:true}).click();
 await expect(page.getByLabel('Invitation link')).toBeVisible();
 await expect(page.getByRole('button',{name:'Create invitation',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Create another invitation',exact:true})).toBeVisible();
 await captures(page,'invite-created');
});
test('N10 Home join-with-an-invitation opens the join form on Circles at once',async({page})=>{
 await page.route('**/api/circles',r=>r.fulfill({json:[]}));
 await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'me',name:'Laptop',circles:[]}}));
 await page.route(/\/api\/jobs(?:\?.*)?$/,r=>r.fulfill({json:[]}));
 await page.goto((await harness.link('owner'))+'#/home');
 await page.getByRole('link',{name:'Join with an invitation',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Join a circle',exact:true})).toBeVisible({timeout:1500});
 await expect(page.getByRole('textbox',{name:'Invitation',exact:true})).toBeVisible();
 await captures(page,'join-from-home');
});
