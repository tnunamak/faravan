import {test, expect} from '@playwright/test';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startHarness} from './lib.mjs';

let harness, home, root, project;
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
  // Use the app's real folder home so its unmocked inspector and browse API see the fixture.
  home=await appHome();
  root=await mkdtemp(join(home,'.tmp/picker-fixture-'));
  project=join(root,'sandbox');await mkdir(project);
  execFileSync('git',['init','-q','-b','main',project]);
  await writeFile(join(project,'README.md'),'Picker fixture\n');
  execFileSync('git',['-C',project,'add','README.md']);
  execFileSync('git',['-C',project,'-c','user.name=Picker Test','-c','user.email=picker@example.test','commit','-qm','Create picker fixture']);
});
test.afterAll(async()=>{await harness?.stop();if(root)await rm(root,{recursive:true,force:true});});
test.beforeEach(async({page})=>{
  const assets=process.env.RELEASE_A11Y_ASSET_DIR;
  if(!assets)return;
  for(const name of ['app.mjs','app.css']) {
    const body=await readFile(join(assets,name));
    await page.route('**/'+name,route=>route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body}));
  }
});

test('Home and End edit the search caret and navigate only focused project rows',async({page})=>{
  await page.route('**/api/folders/suggest',route=>route.fulfill({json:{recent:[],repos:[
    {path:project,name:'Alpha project',branch:'main'},
    {path:join(root,'second'),name:'Alpine project',branch:'main'},
  ],truncated:false}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  await page.getByRole('button',{name:'Choose…',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Choose a project'});
  const search=sheet.getByRole('searchbox',{name:'Search projects'});
  await search.fill('Al');
  const rows=sheet.locator('[data-picker-row]');
  await expect(rows).toHaveCount(2);
  await search.press('Home');
  await expect(search).toBeFocused();
  expect(await search.evaluate(input=>input.selectionStart)).toBe(0);
  await search.press('End');
  await expect(search).toBeFocused();
  expect(await search.evaluate(input=>input.selectionStart)).toBe(2);
  await search.press('ArrowDown');await expect(rows.first()).toBeFocused();
  await page.keyboard.press('End');await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);
});

test('home shorthand, Choose and inner-repo suggestions all inspect the selected repository',async({page})=>{
  test.info().annotations.push({type:'slice',description:'D-compose'},{type:'check',description:'project-picker'});
  // Discovery is deterministic; repository inspection and browse are the real API.
  await page.route('**/api/folders/suggest',route=>route.fulfill({json:{recent:[{path:project,name:'sandbox',branch:'main',last_commit_at:'2026-10-20T00:00:00Z'}],repos:[],truncated:false}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill('~/'+project.slice(home.length+1));
  await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('sandbox · main');
  await page.getByRole('button',{name:'Choose…',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Choose a project'});
  await expect(sheet).toBeVisible();
  await sheet.locator('section[aria-labelledby="project-recent"]').getByRole('button',{name:/^sandbox.*main$/}).click();
  await expect(sheet).toHaveCount(0);
  await expect(folder).toHaveValue('~'+project.slice(home.length));
  await expect(page.locator('#cmp-meta')).toContainText('sandbox · main');
  await expect(page.getByRole('button',{name:'Choose…',exact:true})).toBeFocused();
  await folder.fill(root);await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('Folder snapshot');
  await folder.fill(project);await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('sandbox · main');
});

test('Browse navigates non-repos, search filters, and keyboard selection and Escape return focus',async({page})=>{
  await page.route('**/api/folders/suggest',route=>route.fulfill({json:{recent:[],repos:[{path:project,name:'sandbox',branch:'main'}],truncated:true}}));
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  const choose=page.getByRole('button',{name:'Choose…',exact:true});await choose.click();
  const sheet=page.getByRole('dialog',{name:'Choose a project'});
  const search=sheet.getByRole('searchbox',{name:'Search projects'});await expect(search).toBeFocused();
  await search.fill('sand');
  await expect(sheet.locator('section[aria-labelledby="project-discovered"] .project-row')).toHaveCount(1);
  await search.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('sandbox · main');await expect(choose).toBeFocused();
  await choose.click();await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);await expect(choose).toBeFocused();
  await choose.click();
  await sheet.getByRole('button',{name:/^\.tmp\s*~/}).count().then(n=>expect(n).toBe(0));
  // Navigate to the fixture using the breadcrumb's Home plus a deterministic initial listing response.
  await page.route('**/api/folders?path=*',route=>{
    const path=new URL(route.request().url()).searchParams.get('path');
    return path===root ? route.fallback() : route.fulfill({json:{path:home,home,folders:[{name:basename(root),path:root,is_git:false}]}});
  });
  await sheet.getByRole('button',{name:'Home',exact:true}).click();
  await sheet.getByRole('button',{name:new RegExp('^'+basename(root)+'\\s*~')}).click();
  await expect(sheet.getByRole('navigation',{name:'Folder location'})).toContainText(basename(root));
  await sheet.locator('.project-browse').getByRole('button',{name:/^sandbox.*main$/}).click();
  await expect(page.locator('#cmp-meta')).toContainText('sandbox · main');
});

test('typing pauses before checking and an old response cannot overwrite the latest project',async({page})=>{
  const checked=[];let releaseOld;
  // No obvious project, so the composer chooses none by itself and only typed paths are checked.
  await page.route('**/api/folders/suggest',r=>r.fulfill({json:{recent:[],repos:[],truncated:false}}));
  await page.route('**/api/repo/inspect',async route=>{
    const path=route.request().postDataJSON().path;checked.push(path);
    if(path==='~/old')await new Promise(resolve=>{releaseOld=resolve;});
    await route.fulfill({json:{path:project,name:path==='~/old'?'old-project':'latest-project',branch:'main',head:'a'.repeat(40),files:1,changed:[],changed_count:0}}).catch(()=>{});
  });
  await page.goto((await harness.link('owner'))+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  await page.getByRole('textbox',{name:'Project folder',exact:true}).waitFor();
  await page.clock.install();
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill('~/o');await page.clock.fastForward(499);expect(checked).toHaveLength(0);
  await folder.fill('~/old');await page.clock.fastForward(499);expect(checked).toHaveLength(0);
  await page.clock.fastForward(1);await expect.poll(()=>checked.length).toBe(1);
  await folder.fill('~/latest');await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('latest-project');
  releaseOld();await page.clock.fastForward(500);
  await expect(page.locator('#cmp-meta')).toContainText('latest-project');
  expect(checked).toEqual(['~/old','~/latest']);
  await folder.blur();expect(checked).toEqual(['~/old','~/latest']);
  await folder.press('Enter');await expect.poll(()=>checked.length).toBe(3);
  expect(checked).toEqual(['~/old','~/latest','~/latest']);
});

test('choosing a folder from the No project setting changes the source to the chosen folder',async({page})=>{
 await page.route('**/api/folders/suggest',r=>r.fulfill({json:{recent:[{path:project,name:'sandbox',branch:'main'}],repos:[],truncated:false}}));
 await page.goto((await harness.link('owner'))+'#/new');
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await page.getByRole('radio',{name:'No project',exact:true}).check();
 await page.getByRole('button',{name:'Project settings: No project',exact:true}).click();
 await page.getByRole('dialog',{name:'Choose a project'}).getByRole('button',{name:/^sandbox.*main$/}).click();
 await expect(page.getByRole('radio',{name:'Folder',exact:true})).toBeChecked();
 await expect(page.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue('~'+project.slice(home.length));
});
