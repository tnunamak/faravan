import {test,expect} from '@playwright/test';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';
let harness,root;
const evidence=process.env.SEND_EVIDENCE || 'test-artifacts/browser-verify/send';
test.beforeAll(async()=>{root=await mkdtemp(join(homedir(),'.tmp/send-fixture-'));await writeFile(join(root,'notes.txt'),'Review this brief.');await writeFile(join(root,'.env'),'dummy exclusion');harness=await startHarness();await mkdir(evidence,{recursive:true});});
test.beforeEach(async({page})=>{
 await page.route('**/api/circles',route=>route.fulfill({json:[{id:'send-circle',name:'Weekend projects',origin:'https://circle.example',rosterMembershipVerified:true}]}));
 await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{circle:'send-circle',networked:true,host:{label:'Ana’s MacBook',reachable:true},lenders:[]}}));
 await page.route('**/api/jobs',route=>route.request().method()==='POST'?route.fulfill({json:{jobDigest:'sha256:'+'c'.repeat(64)}}):route.fallback());
});
test.afterAll(async()=>{await harness?.stop();if(root)await rm(root,{recursive:true,force:true});});

for(const theme of ['light','dark'])for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
 test(`source composer ${viewport.width} ${theme}`,async({page})=>{
  await page.setViewportSize(viewport);await page.emulateMedia({colorScheme:theme});
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const prompt=page.getByRole('textbox',{name:'What the agent should do'});await prompt.fill('Review the project and write a concise report of the risks.');
  await page.getByRole('radio',{name:'No project',exact:true}).check();
  await page.locator('.cmp-lender-settings > summary').click();
  await page.getByText('What you’re sending',{exact:true}).click();
  await expect(page.getByText('Only your request. No project files or history.')).toBeVisible();
  const send=page.getByRole('button',{name:'Send',exact:true});await expect(send).toBeEnabled();
  await page.getByRole('radio',{name:'Folder',exact:true}).check();
  const folder=page.locator('#cmp-folder');await folder.fill(root);await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('Folder snapshot');
  await expect(page.getByText('What you’re sending',{exact:true})).toBeVisible();
  await page.getByText('1 file not sent',{exact:true}).click();await expect(page.getByText('.env',{exact:true})).toBeVisible();
  await expect(page.getByText('looked like credentials',{exact:false})).toBeVisible();
  await expect(send).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:`${evidence}/folder-${viewport.width}-${theme}.png`,fullPage:true});
  await page.getByRole('radio',{name:'Files or ZIP',exact:true}).check();
  await page.locator('#cmp-files').setInputFiles({name:'brief.md',mimeType:'text/markdown',buffer:Buffer.from('A test brief.')});
  await expect(page.getByText('1 file',{exact:true})).toBeVisible();await expect(send).toBeEnabled();
  await page.screenshot({path:`${evidence}/files-${viewport.width}-${theme}.png`,fullPage:true});
  await page.getByRole('radio',{name:'Git URL',exact:true}).check();
  await expect(send).toBeDisabled();
  await page.route('**/api/repo/resolve',route=>route.fulfill({json:{url:'https://example.test/project',commit:'a'.repeat(40),branch:'main',branches:[{name:'main',commit:'a'.repeat(40)},{name:'feature/mobile',commit:'b'.repeat(40)}]}}));
  await page.getByLabel('Repository URL').fill('https://example.test/project');await page.getByRole('button',{name:'Find branches'}).click();
  await expect(page.getByLabel('Branch',{exact:true})).toHaveValue('main');await expect(send).toBeEnabled();
  await expect(page.getByText(/Pinned to commit/)).toContainText('a'.repeat(40));
  const created=page.waitForRequest(request=>request.url().endsWith('/api/jobs')&&request.method()==='POST');
  await send.click();await confirmFirstSend(page);const submitted=(await created).postDataJSON();expect(submitted.git.commit).toBe('a'.repeat(40));expect(submitted.repo).toBeUndefined();
  await expect(page).not.toHaveURL(/#\/new$/);
 });
}
test('files preview failure blocks send; stale remote response cannot replace a different source',async({page})=>{
 await page.goto((await harness.link('owner'))+'#/new');if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();await page.getByRole('textbox',{name:'What the agent should do'}).fill('Review this');
 await page.getByRole('radio',{name:'Files or ZIP',exact:true}).check();
 await page.route('**/api/source/preview',route=>route.fulfill({status:400,json:{code:'invalid_source',message:'ZIP has an unsafe path.'}}));
 await page.locator('#cmp-files').setInputFiles({name:'bad.zip',mimeType:'application/zip',buffer:Buffer.from('bad')});
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();await expect(page.getByRole('alert')).toHaveText('The selected project files cannot be sent. Choose another folder or a smaller set of files.');
 await page.getByRole('radio',{name:'Git URL',exact:true}).check();let release;
 await page.route('**/api/repo/resolve',async route=>{await new Promise(resolve=>{release=resolve;});await route.fulfill({json:{url:'https://example.test/a',commit:'a'.repeat(40),branch:'main',branches:[]}});});
 await page.getByLabel('Repository URL').fill('https://example.test/a');await page.getByRole('button',{name:'Find branches'}).click();
 await expect(page.getByText('Find branches',{exact:true})).toHaveCount(0);
 await page.getByRole('radio',{name:'No project',exact:true}).check();release();
 await expect(page.getByRole('radio',{name:'No project',exact:true})).toBeChecked();await expect(page.getByText(/Pinned to commit/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
});

test('a large upload survives reload with its exact bytes and working directory',async({page})=>{
 await page.goto((await harness.link('owner'))+'#/new');if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();await page.getByRole('textbox',{name:'What the agent should do'}).fill('Read this large brief.');
 await page.getByRole('radio',{name:'Files or ZIP',exact:true}).check();
 const buffer=Buffer.alloc(6*1024*1024,0x61);
 await page.locator('#cmp-files').setInputFiles({name:'large.txt',mimeType:'text/plain',buffer});
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
 await page.getByLabel('Working directory (optional)',{exact:true}).fill('packages/app');
 const before=await page.evaluate(()=>Object.values(localStorage).find(value=>value.includes('attachmentId')));
 expect(before.length).toBeLessThan(4096);
 await page.reload();
 await expect(page.getByRole('textbox',{name:'What the agent should do'})).toHaveValue('Read this large brief.');
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await expect(page.getByLabel('Working directory (optional)',{exact:true})).toHaveValue('packages/app');
 const send=page.getByRole('button',{name:'Send',exact:true});await expect(send).toBeEnabled();
 const request=page.waitForRequest(req=>req.url().endsWith('/api/jobs')&&req.method()==='POST');await send.click();await confirmFirstSend(page);
 const body=(await request).postDataJSON();expect(body.files[0].base64).toBe(buffer.toString('base64'));expect(body.working_directory).toBe('packages/app');
});

test('a folder changed after preview is reviewed again before a second send',async({page})=>{
 const sent=[];
 await page.route('**/api/jobs',route=>{if(route.request().method()!=='POST')return route.fallback();sent.push(route.request().postDataJSON());return sent.length===1?route.fulfill({status:409,json:{code:'source_changed',outcome:'not_applied'}}):route.fulfill({json:{jobDigest:'sha256:'+'c'.repeat(64)}});});
 await page.goto((await harness.link('owner'))+'#/new');if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();await page.getByRole('textbox',{name:'What the agent should do'}).fill('Read the reviewed snapshot');
 await page.locator('#cmp-folder').fill(root);await page.locator('#cmp-folder').press('Enter');
 const send=page.getByRole('button',{name:'Send',exact:true});await expect(send).toBeEnabled();
 await writeFile(join(root,'notes.txt'),'Changed since the first preview.');await send.click();await confirmFirstSend(page);
 await expect(page.getByRole('alert')).toContainText('Review the updated files before sending again.');await expect(send).toBeEnabled();
 await send.click();await confirmFirstSend(page);await expect.poll(()=>sent.length).toBe(2);
 expect(sent[0].repo.expected_digest).toMatch(/^sha256:/);expect(sent[1].repo.expected_digest).not.toBe(sent[0].repo.expected_digest);
 expect(sent[1].draft_id).not.toBe(sent[0].draft_id);
});
