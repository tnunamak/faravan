import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();await mkdir('test-artifacts/reports',{recursive:true});});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'reports-circle',name:'Research circle',origin:'https://fixture.example',rosterMembershipVerified:true},digest='sha256:'+'c'.repeat(64);
const markdown='# Rain gardens for a small yard\n\nA rain garden collects **runoff** from roofs and paved areas. Start with a shallow basin and plants suited to local soil.\n\n## What to compare\n\n- Place the garden downhill from the water source.\n- Check drainage before choosing plants.\n\n| Question | Next action |\n| --- | --- |\n| Does water drain? | Test the soil |\n| Which plants fit? | Ask a local extension service |\n\n## Sources and limitations\n\n[US EPA: rain gardens](https://www.epa.gov/soakuptherain/soak-rain-rain-gardens). This short report does not replace a site assessment.\n\n```text\nObserve → measure → choose plants\n```';
async function compose(page){
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.goto((await harness.link('owner'))+'#/new');
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await page.getByRole('radio',{name:'No project',exact:true}).click();
 await page.getByLabel('What the agent should do').fill('Research rain gardens for a small yard. Cite sources and explain limitations.');
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
}
async function report(page){
 const job={job_digest:digest,circle,sourceKind:'none',resultKind:'message',state:'result-accepted',result_digest:'sha256:'+'d'.repeat(64),local:{title:'Research rain gardens',prompt:'Research rain gardens for a small yard.'}};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[job]}));
 await page.route('**/api/jobs/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/changes'))return r.fulfill({json:{format:'message',message:{url:'/api/jobs/x/message',markdown},files:[{path:'faravan-output/report.md',bytes:markdown.length,url:'/api/jobs/x/file'},{path:'faravan-output/plant-notes.csv',bytes:31,text:'Plant,Soil\nSedge,Moist',url:'/api/jobs/x/file'}],receipt:{candidate_format:'tree',harness:'claude-code-subscription'}}});
  if(path.endsWith('/transcript'))return r.fulfill({json:{text:JSON.stringify({type:'result',result:'Research is in faravan-output/report.md.'})}});
  if(path.endsWith('/receipt'))return r.fulfill({json:{receipt:{candidate_format:'tree',harness:'claude-code-subscription'}}});
  if(path.endsWith('/retention'))return r.fulfill({json:{}});
  if(path.endsWith('/message') || path.endsWith('/file'))return r.fulfill({body:markdown,headers:{'content-disposition':'attachment; filename="message.md"'}});
  if(path.endsWith('/result'))return r.fulfill({body:'zip fixture',headers:{'content-disposition':'attachment; filename="files.zip"'}});
  return r.fulfill({json:job});
 });
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.getByRole('heading',{name:'Rain gardens for a small yard',exact:true})).toBeVisible();
}
test('prompt-only source restores and submits no local path alongside the four source choices',async({page})=>{
 await compose(page);
 await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveCount(0);
 await expect(page.getByRole('radio',{name:'Git URL',exact:true})).toBeVisible();
 await expect(page.getByRole('radio',{name:'Files or ZIP',exact:true})).toBeVisible();
 await expect(page.getByLabel('Test command')).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'Return as'})).toHaveCount(0);
 await expect(page.getByText('Files or zip and Git URL are coming soon.')).toHaveCount(0);
 await page.reload();
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await expect(page.getByRole('radio',{name:'No project',exact:true})).toBeChecked();
 await page.route(/\/api\/jobs(?:\?.*)?$/,async r=>{
  if(r.request().method()!=='POST')return r.fulfill({json:[]});
  const body=r.request().postDataJSON();expect(body.noSource).toBe(true);expect(body.result).toEqual({kind:'message'});expect(body.repo).toBeUndefined();
  return r.fulfill({json:{jobDigest:digest}});
 });
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await confirmFirstSend(page);
 await expect(page).toHaveURL(/#\/job\//);
});
test('report is readable, files preview, Markdown copies and downloads',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await report(page);
 await expect(page.getByRole('heading',{name:/Use these changes|Changes/})).toHaveCount(0);
 await expect(page.locator('.result-workspace,.job-diff')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Add as a branch|Apply to working tree|Download the patch/})).toHaveCount(0);
 await expect(page.locator('.job-status-skeleton')).toHaveCount(0);
 await page.getByText('Preview',{exact:true}).click();await expect(page.getByText('Plant,Soil',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Copy message',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(markdown);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download Markdown',exact:true}).click();expect((await download).suggestedFilename()).toBe('message.md');
 await expect(page.getByRole('button',{name:'Download all files'})).toBeVisible();
});
for(const theme of ['light','dark'])for(const [device,width,height] of [['desktop',1440,900],['phone',390,844]])test(`report and composer ${device} ${theme}`,async({page})=>{
 await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
 await compose(page);await page.screenshot({path:`test-artifacts/reports/compose-${device}-${theme}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await report(page);await page.screenshot({path:`test-artifacts/reports/report-${device}-${theme}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('sending a failed no-project job again preserves its source and automatic result',async({page})=>{
 const job={job_digest:digest,circle,state:'failed',sourceKind:'none',resultKind:'message',attempts_started:1,local:{title:'Write a welcome note',prompt:'Write a welcome note.'}};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
 await page.route('**/api/jobs/**',r=>r.fulfill({json:new URL(r.request().url()).pathname.endsWith('/retention')?{}:job}));
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await page.getByRole('button',{name:'Send to someone else…',exact:true}).click();
 await page.getByRole('button',{name:'Prepare a new request',exact:true}).click();
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await expect(page.getByRole('radio',{name:'No project',exact:true})).toBeChecked();
 await expect(page.getByRole('combobox',{name:'Return as'})).toHaveCount(0);
 await expect(page.getByLabel('What the agent should do')).toHaveValue('Write a welcome note.');
 await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveCount(0);
});

test('a valid no-project send has active styling and no nested focus ring',async({page})=>{
 await compose(page);
 const send=page.getByRole('button',{name:'Send',exact:true});
 await expect(send).toBeEnabled();
 expect(await send.evaluate(e=>getComputedStyle(e).opacity)).toBe('1');
 await page.getByLabel('What the agent should do').focus();
 const task=page.locator('.cmp-task'),field=page.getByLabel('What the agent should do');
 // One ring on the prompt section; the bare textarea draws none.
 expect(await task.evaluate(e=>{const s=getComputedStyle(e);return [s.outlineWidth,s.outlineStyle,s.outlineOffset];})).toEqual(['2px','solid','3px']);
 expect(await field.evaluate(e=>{const s=getComputedStyle(e);return [s.outlineStyle,s.boxShadow];})).toEqual(['none','none']);
});

test('project segments support arrow keys and a blocked no-project send explains why',async({page})=>{
 await compose(page);
 const none=page.getByRole('radio',{name:'No project',exact:true}),folder=page.getByRole('radio',{name:'Folder',exact:true});
 await none.focus();await page.keyboard.press('ArrowRight');await expect(folder).toBeChecked();await expect(folder).toBeFocused();
 await page.keyboard.press('ArrowLeft');await expect(none).toBeChecked();await expect(none).toBeFocused();
 await page.getByLabel('What the agent should do').fill('');
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 await expect(page.getByRole('status').filter({hasText:'Send is off until you say what the agent should do.'})).toBeVisible();
});
test('report properties show recorded facts and omit missing observations',async({page})=>{
 await report(page);
 const card=page.locator('.result-rail-section').filter({has:page.getByRole('heading',{name:'Properties',exact:true})});
 await expect(card).toBeVisible();
 await expect(card.locator('dt').filter({hasText:'Agent'})).toHaveCount(1);
 await expect(card).toContainText('Claude Code');
 await expect(card).not.toContainText("Some run details weren't recorded.");
 await expect(card).not.toContainText('The agent time used isn’t known.');
 await expect(card.locator('details')).toHaveCount(0);
});

test('download-only files keep the final message and whole-file download action',async({page})=>{
 await report(page);
 await page.route('**/api/jobs/**/changes*',r=>r.fulfill({json:{format:'message',message:{markdown:'# Answer with large files'},files:[],download_only:true,warning:'Files exceed the preview limits. Download all files to review them.',receipt:{}}}));
 await page.reload();await expect(page.getByRole('heading',{name:'Answer with large files'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Download all files'})).toBeVisible();await expect(page.getByText('No output files came back.')).toHaveCount(0);
});

for(const sourceKind of ['none','folder'])test(`${sourceKind} result follow-up restores its source, enables Send and keeps the parent link`,async({page})=>{
 await report(page);
 const followup={parentJob:digest,parentResult:'sha256:'+'d'.repeat(64)};
 const base=sourceKind==='none'?{path:'',branch:'',commit:''}:{path:'/saved/does-not-need-to-exist',branch:'faravan/result',commit:'a'.repeat(40)};
 await page.route('**/api/jobs/**/continuation?*',r=>r.fulfill({json:{...followup,base,sourceKind,handoff:{scan:{status:'withheld'}}}}));
 await page.reload();
 await page.locator('.result-rail').getByRole('button',{name:'Send a follow-up job',exact:true}).click();
 await expect(page.getByRole('heading',{name:'What should change next?',exact:true})).toBeVisible();
 await expect(page.getByRole('radiogroup',{name:'Project'})).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveCount(0);
 if(sourceKind==='none')await expect(page.getByLabel('Test command')).toHaveCount(0);
 await page.getByLabel('What should change next?',{exact:true}).fill('Explain one more step');
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
 const child='sha256:'+'e'.repeat(64);
 await page.route(/\/api\/jobs(?:\?.*)?$/,async r=>{
  if(r.request().method()!=='POST')return r.fulfill({json:[]});
  const body=r.request().postDataJSON();expect(body.followup).toEqual(followup);expect(body.repo).toBeUndefined();expect(body.noSource).toBeUndefined();
  if(sourceKind==='none')expect(body.result).toEqual({kind:'message'});else expect(body.result).toBeUndefined();
  return r.fulfill({json:{jobDigest:child}});
 });
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await confirmFirstSend(page);
 await expect(page).toHaveURL(new RegExp(encodeURIComponent(child)));
});
