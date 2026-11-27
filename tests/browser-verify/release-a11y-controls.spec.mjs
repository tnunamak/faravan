import {test,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startHarness,projectJobFixture} from './lib.mjs';

let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test.beforeEach(async({page})=>{
  const assets=process.env.RELEASE_A11Y_ASSET_DIR;
  if(!assets)return;
  for(const name of ['app.mjs','app.css']) {
    const body=await readFile(join(assets,name));
    await page.context().route('**/'+name,route=>route.fulfill({status:200,contentType:name.endsWith('.css')?'text/css':'text/javascript',body}));
  }
});
async function record(page,name,data) {
  const directory=process.env.RELEASE_A11Y_EVIDENCE_DIR;
  if(!directory)return;
  await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,name+'.png'),fullPage:true,animations:'disabled'});
  await writeFile(join(directory,name+'.json'),JSON.stringify(data,null,2)+'\n');
}

const digest='sha256:'+'c'.repeat(64), result='sha256:'+'d'.repeat(64);
const circle={id:'review-circle',name:'Synthetic review circle',origin:'http://fixture',rosterMembershipVerified:true};
const diff='diff --git a/src/parser.js b/src/parser.js\n--- a/src/parser.js\n+++ b/src/parser.js\n@@ -1,4 +1,4 @@\n context line\n-old one\n-old two\n-old three\n+new one\n+new two\n+new three\n';
async function injectAxe(page) {
  const source=await readFile('node_modules/axe-core/axe.min.js','utf8');
  await page.evaluate(code=>new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    script.onload=resolve;script.onerror=reject;document.head.append(script);
  }),source);
}
async function showResult(page) {
  const job={job_digest:digest,circle,state:'result-accepted',result_digest:result,local:{title:'Check parser',prompt:'Check parser behavior.',sourcePath:'/fixture/project'}};
  await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
  await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'synthetic-device',circles:[]}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,r=>r.fulfill({json:[projectJobFixture(job)]}));
  await page.route('**/api/jobs/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith('/changes'))return r.fulfill({json:{format:'diff',files:[{path:'src/parser.js',status:'modified',insertions:3,deletions:3}],diffstat:{files:1,insertions:3,deletions:3},diff}});
    if(path.endsWith('/transcript'))return r.fulfill({json:{text:'Parser changes are ready.',live:false}});
    return r.fulfill({json:projectJobFixture(job)});
  });
  await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();
}

test('phone diff note targets meet 24px in both gutters and across lines',async({page})=>{
  await showResult(page);
  await page.setViewportSize({width:390,height:844});
  const targets=page.locator('.diff-row button.review-line-number');
  await expect(targets).toHaveCount(8);
  const boxes=await targets.evaluateAll(items=>items.map(el=>({name:el.getAttribute('aria-label'),...(()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()})));
  await record(page,'m6-phone-targets',{viewport:{width:390,height:844},targets:boxes,scrollContainer:await page.locator('.diff-scroll').evaluate(el=>({clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,overflowX:getComputedStyle(el).overflowX}))});
  expect(boxes.every(box=>box.width>=24&&box.height>=24),JSON.stringify(boxes)).toBe(true);
  const overlaps=boxes.some((a,index)=>boxes.slice(index+1).some(b=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y));
  expect(overlaps,JSON.stringify(boxes)).toBe(false);
  expect(boxes.map(box=>box.name).sort()).toEqual([
    'Add note on src/parser.js old line 1','Add note on src/parser.js old line 2','Add note on src/parser.js old line 3','Add note on src/parser.js old line 4',
    'Add note on src/parser.js new line 1','Add note on src/parser.js new line 2','Add note on src/parser.js new line 3','Add note on src/parser.js new line 4',
  ].sort());
  expect(await page.locator('.diff-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth||getComputedStyle(el).overflowX==='auto')).toBe(true);
});

test('decorative diff spacers have no prohibited ARIA labels',async({page})=>{
  await showResult(page);
  await injectAxe(page);
  const result=await page.evaluate(async()=>await axe.run(document,{runOnly:{type:'rule',values:['aria-prohibited-attr']}}));
  await record(page,'m1-prohibited-aria',{violations:result.violations.map(row=>({id:row.id,nodes:row.nodes.map(node=>node.target)})),spacerLabels:await page.locator('.diff-row .line-number:not(button)[aria-label]').count()});
  expect(result.violations.map(row=>row.id)).not.toContain('aria-prohibited-attr');
  expect(await page.locator('.diff-row .line-number:not(button)[aria-label]').count()).toBe(0);
  await expect(page.getByRole('button',{name:'Add note on src/parser.js new line 2',exact:true})).toBeVisible();
});

test('project row name contains its visible branch metadata',async({page})=>{
  await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
  await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'synthetic-device',circles:[]}}));
  await page.route('**/api/folders/suggest',r=>r.fulfill({json:{home:'/synthetic/home',recent:[],repos:[{name:'Parser',path:'/synthetic/home/parser',branch:'main',is_git:true},{name:'Notes',path:'/synthetic/home/notes',branch:'main',is_git:true}],truncated:false}}));
  await page.route('**/api/folders?*',r=>r.fulfill({json:{home:'/synthetic/home',path:'/synthetic/home',folders:[]}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  await page.getByRole('button',{name:'Project settings: Choose project',exact:true}).click();
  const row=page.locator('[data-picker-row]').filter({hasText:'Parser'});
  await expect(row).toBeVisible();
  await expect(row).toHaveRole('button');
  await expect(row).toContainText('main');
  await injectAxe(page);
  const scan=await page.evaluate(async()=>await axe.run(document,{runOnly:{type:'rule',values:['label-content-name-mismatch']}}));
  await record(page,'m2-project-row-name',{role:await row.getAttribute('role'),name:await row.getAttribute('aria-label'),computedName:await row.getAttribute('aria-label')||await row.innerText(),visibleText:await row.innerText(),violations:scan.violations.map(item=>item.id)});
  await expect(row).toHaveAccessibleName(/Parser.*main/);
  expect(scan.violations.map(item=>item.id)).not.toContain('label-content-name-mismatch');
});

async function showPerson(page) {
  const person='synthetic-person', circleId='synthetic-circle';
  await page.route('**/api/circles',r=>r.fulfill({json:[{...circle,id:circleId}]}));
  await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'synthetic-device',circles:[{circle:circleId,members:[{key_id:person,device_name:'Synthetic computer'}]}]}}));
  await page.route('**/api/circles/'+circleId+'/people',r=>r.fulfill({json:[{personId:person,name:'Synthetic member',role:'member',blocked:false,computers:[{key_id:person,device_name:'Synthetic computer'}]}]}));
  await page.route('**/api/jobs?circle='+circleId,r=>r.fulfill({json:[]}));
  await page.route('**/api/circles/'+circleId+'/approvals',r=>r.fulfill({json:[]}));
  await page.goto((await harness.link('owner'))+'#/person/'+person+'/'+circleId);
  await expect(page.getByRole('button',{name:'Edit device limits',exact:true})).toBeVisible();
}

for(const width of [1440,390]) test('device-limit editing keeps local keyboard focus at '+width+'px',async({page})=>{
  const mutations=[];
  await page.route('**/api/lending/requester-limits',async route=>{
    mutations.push(route.request().postDataJSON());
    return route.fulfill({json:{saved:true}});
  });
  await page.setViewportSize({width,height:844});
  await showPerson(page);
  const opener=page.getByRole('button',{name:'Edit device limits',exact:true});
  await opener.focus();await page.keyboard.press('Enter');
  const jobs=page.getByLabel('Jobs per day');
  await expect(jobs).toBeFocused();
  await record(page,'m3-device-limit-edit-'+width,{active:await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.labels?.[0]?.innerText||document.activeElement?.getAttribute('aria-label')||''})),viewport:{width,height:844}});
  await page.keyboard.press('Tab');
  const minutes=page.getByLabel('Minutes per day');
  await expect(minutes).toBeFocused();
  await page.keyboard.type('15');
  await expect(minutes).toBeFocused();
  await expect(minutes).toHaveValue('15');
  await page.getByRole('button',{name:'Cancel',exact:true}).press('Enter');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');await expect(jobs).toBeFocused();
  await page.keyboard.type('2');
  await page.getByRole('button',{name:'Save device limits',exact:true}).press('Enter');
  await expect(opener).toBeFocused();
  await expect(page.locator('.notice[role=status]')).toContainText('Device limits saved.');
  await page.keyboard.press('Enter');await expect(jobs).toBeFocused();
  await page.getByRole('button',{name:'Clear device limits',exact:true}).press('Enter');
  await expect(opener).toBeFocused();
  await expect(page.locator('.notice[role=status]')).toContainText('Device limits cleared.');
  expect(mutations).toEqual([
    {circle:'synthetic-circle',keyId:'synthetic-person',limits:{dailyJobs:2,dailyMinutes:null}},
    {circle:'synthetic-circle',keyId:'synthetic-person',limits:null},
  ]);
});

for(const width of [1440,390]) test('diff note editor receives and restores keyboard focus at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:844});
  await showResult(page);
  const opener=page.getByRole('button',{name:'Add note on src/parser.js new line 2',exact:true});
  await opener.focus();await page.keyboard.press('Enter');
  const textarea=page.getByLabel('Note on new line 2');
  await expect(textarea).toBeFocused();
  await record(page,'m4-note-editor-'+width,{active:await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.labels?.[0]?.innerText||document.activeElement?.getAttribute('aria-label')||''})),viewport:{width,height:844}});
  await page.keyboard.type('Review the parser edge case.');
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await expect(opener).toBeFocused();
  await expect(page.getByText('Review the parser edge case.',{exact:true})).toBeVisible();
  await opener.press('Enter');await expect(textarea).toBeFocused();
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await expect(opener).toBeFocused();
  await expect(page.getByText('Review the parser edge case.',{exact:true})).toBeVisible();
});
