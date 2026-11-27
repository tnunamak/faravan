import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startHarness} from './lib.mjs';

let harness,project;
const shotDir=process.env.FARAVAN_SOURCE_SHOTS || join('test-artifacts','browser-verify','source-disclosure');
test.beforeAll(async()=>{
  const scratch=join(homedir(),'.tmp');await mkdir(scratch,{recursive:true});
  project=await mkdtemp(join(scratch,'faravan-secrets-browser-'));
  const git=(...args)=>execFileSync('git',['-C',project,...args],{stdio:'pipe'});
  git('init','-q','-b','main');
  for(const [path,text] of [['main.js','export const fixture=1;'],['.env','DUMMY_ONLY=inert-browser-fixture'],['.env.example','DUMMY_ONLY=replace-me'],['dist/source.js','export const committed=1;']]) {
    await mkdir(join(project,path,'..'),{recursive:true});await writeFile(join(project,path),text);
  }
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  await mkdir(join(project,'build'));await writeFile(join(project,'build/cache.js'),'cache');
  await writeFile(join(project,'.env.local'),'DUMMY_ONLY=another-inert-fixture');
  harness=await startHarness();
});
test.afterAll(async()=>{await harness?.stop();if(project)await rm(project,{recursive:true,force:true});});

for(const viewport of [{width:1440,height:900},{width:390,height:844}]) for(const colorScheme of ['light','dark']) {
  test(`source exclusions are visible and expand at ${viewport.width} ${colorScheme}`,async({browser})=>{
    const context=await browser.newContext({viewport,colorScheme});
    const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto((await harness.link('owner'))+'#/new');
      if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
      const path=page.getByRole('textbox',{name:'Project folder',exact:true});await path.fill(project);await path.press('Enter');
      await expect(page.locator('#cmp-meta')).toContainText('main @');
      await page.locator('.cmp-lender-settings > summary').click();
      await page.getByText('What you’re sending',{exact:true}).click();
      const details=page.locator('.source-manifest details').filter({has:page.locator('summary', {hasText:/not sent$/})}), summary=details.locator('summary');
      const options=page.locator('.opt-col').filter({has:page.getByLabel('Also send my uncommitted changes')});
      await expect(summary).toHaveText('1 file not sent');
      await summary.click();await expect(details.getByRole('listitem')).toHaveText(['.env — looked like credentials']);
      await expect(details).not.toContainText('dist/source.js');
      await expect(options).toContainText('Uncommitted changes are not sent.');
      await page.getByLabel('Also send my uncommitted changes').check();
      await expect(options).toContainText('Your uncommitted changes will be sent (2 files).');
      await expect(summary).toHaveText('3 files not sent');
      await expect(details.getByRole('listitem')).toHaveCount(3);
      expect((await details.getByRole('listitem').locator('code').allTextContents()).sort()).toEqual(['.env','.env.local','build/cache.js']);
      for(const path of ['.env','.env.local']) await expect(details.getByRole('listitem').filter({has:page.getByText(path,{exact:true})})).toContainText('looked like credentials');
      const band=await page.locator('#cmp-meta').evaluate(el=>el.closest('.src').getBoundingClientRect().bottom-el.getBoundingClientRect().bottom);
      expect(band).toBeLessThanOrEqual(20);
      if(!await details.evaluate(el=>el.open)) await summary.click();
      await expect(details.getByRole('listitem').first()).toBeVisible();
      await expect(details).toContainText('.env.local');
      await expect(details).toContainText('build/cache.js');
      await expect(details).not.toContainText('inert-browser-fixture');
      await expect(details).not.toContainText('.env.example');
      await expect(options).not.toContainText('Also sending 2 files');
      await expect(summary).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await mkdir(shotDir,{recursive:true});
      await details.scrollIntoViewIfNeeded();
      if(viewport.width===390) await details.evaluate(el=>el.scrollIntoView({block:'center'}));
      await page.screenshot({path:join(shotDir,`${viewport.width}-${colorScheme}.png`),fullPage:false});
      await summary.focus();await page.keyboard.press('Enter');await expect(details).not.toHaveAttribute('open');
      expect(errors).toEqual([]);
    } finally {await context.close();}
  });
}
