import {test, expect} from '@playwright/test';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';

let harness, root, plain;
async function appHome() {
  const ownerUrl = new URL(harness.urls.owner);
  const token = harness.urls.tokens.owner;
  if (!token) throw new Error('The local harness URL has no session token.');
  const response = await fetch(new URL('/api/folders', ownerUrl.origin), {headers:{'x-faravan-session-token':token}});
  if (!response.ok) throw new Error('The local harness did not return its folder home.');
  const listing = await response.json();
  if (typeof listing.home !== 'string' || listing.path !== listing.home) throw new Error('The local harness returned an invalid folder home.');
  return listing.home;
}
test.beforeAll(async()=>{
  harness=await startHarness();
  root=await mkdtemp(join(await appHome(),'.tmp/not-git-fixture-'));
  plain=join(root,'sandbox');await mkdir(plain);
});
test.afterAll(async()=>{await harness?.stop();if(root)await rm(root,{recursive:true,force:true});});

test('a folder that is not a git repository gets one message at the folder field, with its choices',async({page,browser})=>{
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'compose-not-git'});
  const circle={id:'not-git-circle',name:'Weekend projects',origin:'https://circle.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
  const noCircleContext=await browser.newContext(),noCirclePage=await noCircleContext.newPage();
  await noCirclePage.route('**/api/circles',route=>route.fulfill({json:[]}));
  await noCirclePage.goto((await harness.link('owner'))+'#/new');
  await noCirclePage.getByRole('textbox',{name:'What the agent should do'}).fill('Make a checklist');
  await expect(noCirclePage.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  await noCircleContext.close();

  const unavailableComposeContext=await browser.newContext(),unavailableComposePage=await unavailableComposeContext.newPage();
  await unavailableComposePage.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await unavailableComposePage.route('**/api/circles/*/compose',route=>route.fulfill({status:503,json:{code:'network_error'}}));
  await unavailableComposePage.goto((await harness.link('owner'))+'#/new');
  await unavailableComposePage.getByRole('textbox',{name:'What the agent should do'}).fill('Make a checklist');
  await expect(unavailableComposePage.getByLabel('Circle')).toHaveValue(circle.id);
  if(!await unavailableComposePage.locator('#cmp-project').evaluate(e=>e.open))await unavailableComposePage.locator('#cmp-project > summary').click();
  await unavailableComposePage.getByRole('radio',{name:'No project',exact:true}).check();
  await expect(unavailableComposePage.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  await expect(unavailableComposePage.locator('#cmp-why')).toHaveText('Circle details need an update before sending. Your request is unchanged.');
  await expect(unavailableComposePage.locator('.cmp-notice')).toContainText('Couldn’t refresh circle details');
  await unavailableComposeContext.close();

  await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
  await page.route('**/api/folders/suggest',route=>route.fulfill({json:{recent:[],repos:[],truncated:false}}));
  await page.goto((await harness.link('owner'))+'#/new');
  await page.getByRole('textbox',{name:'What the agent should do'}).fill('Make a checklist');
  await expect(page.getByLabel('Circle')).toHaveValue(circle.id);
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill(plain);await folder.press('Enter');
  const meta=page.locator('#cmp-meta'), help=page.locator('#cmp-help');
  await expect(meta).toContainText('Not a git repository');
  // One message: no notice above the title, and the words appear once on the page.
  await expect(page.locator('.cmp-notice')).toHaveCount(0);
  await expect(page.getByText('Not a git repository')).toHaveCount(1);
  // It sits under the field it is about, below the title, with the choices.
  const [title,field,note]=await Promise.all([page.getByRole('heading',{name:'New job'}).boundingBox(),folder.boundingBox(),meta.boundingBox()]);
  expect(note.y).toBeGreaterThan(field.y+field.height-1);
  expect(note.y).toBeGreaterThan(title.y+title.height);
  await expect(help).toContainText('You can send this folder as files.');
  await expect(help).toContainText('Download changed files as a ZIP');
  await expect(help.getByRole('button')).toHaveCount(0);
  await expect(folder).not.toHaveAttribute('aria-invalid','true');
  await expect(folder).toHaveAttribute('aria-describedby','cmp-meta cmp-help');
  // A non-git folder is allowed. The circle requirement remains a separate Send gate.
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
  // Send without a project switches the Project control and keeps the prompt.
  await page.getByRole('radio',{name:'No project',exact:true}).check();
  await expect(page.getByRole('radio',{name:'No project'})).toBeChecked();
  await expect(page.getByRole('textbox',{name:'What the agent should do'})).toHaveValue('Make a checklist');
  await expect(page.locator('#cmp-help')).toHaveCount(0);
  await expect(page.getByText('Not a git repository')).toHaveCount(0);
});

test('a successful plain-folder inspection keeps nested project suggestions and send-as-files',async({page})=>{
  const circle={id:'nested-circle',name:'Weekend projects',origin:'https://circle.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
  const nested={path:join(plain,'nested'),name:'Nested project',branch:'main'};
  await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',route=>route.fulfill({json:{circle:circle.id,networked:true,host:{reachable:true},lenders:[]}}));
  await page.route('**/api/repo/inspect',route=>route.fulfill({json:{kind:'folder',path:plain,name:'sandbox',branch:null,head:null,
    changed:[],changed_count:0,files:1,bytes:12,suggestions:[nested]}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const prompt=page.getByRole('textbox',{name:'What the agent should do'});
  await prompt.fill('Make a checklist');
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill(plain);await folder.press('Enter');
  await expect(page.locator('.project-suggestions')).toContainText('Projects inside this folder:');
  await expect(page.getByRole('button',{name:/^Nested project.*main$/})).toBeVisible();
  await expect(page.locator('#cmp-help')).toContainText('You can send this folder as files.');
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
  await page.getByRole('radio',{name:'No project',exact:true}).check();
  await expect(page.getByRole('radio',{name:'No project'})).toBeChecked();
  await expect(prompt).toHaveValue('Make a checklist');
});

test('Choose opens the folder chooser for a plain folder',async({page})=>{
  await page.route('**/api/folders/suggest',route=>route.fulfill({json:{recent:[],repos:[],truncated:false}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill(plain);await folder.press('Enter');
  await page.getByRole('button',{name:'Choose…',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Choose a project'})).toBeVisible();
});
