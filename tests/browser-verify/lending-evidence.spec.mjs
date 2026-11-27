import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
test('a definite Codex sign-out stays visible beside a compact safety-test hero',async({page})=>{
 const safety={key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'The sandbox could reach your home network. Check Docker Sandboxes, then resume lending.',action:'Resume lending'};
 let checked;
 await page.route('**/api/home',r=>r.fulfill({json:{intent:{on:true,state:'blocked'},lending:{enabled:true,circle:'shared',status:'idle',limits:{dailyJobs:3,dailyMinutes:60}},lending_blockers:{items:[safety,{key:'agent',agent:'codex',label:'Codex',status:'waits',detail:'Waits for the sandbox safety test.'}],first:safety,canLend:false}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[{id:'shared',name:'Weekend projects',origin:'http://fixture'}]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'codex',installed:true,signedIn:false,signInReason:'credential_missing',signInSupported:true,useForLending:false}]}));
 await page.route('**/api/agents/refresh',async r=>{checked=r.request().postDataJSON();await r.fulfill({json:[{id:'codex',installed:true,signedIn:false,signInReason:'credential_missing',signInSupported:true,useForLending:false}]});});
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:true,checks:[]}}));
 await page.goto((await harness.link('lender'))+'#/lend');
 const row=page.locator('.lagent');await expect(row).toContainText('Signed out');await expect(row).toContainText(/Sign in to Codex/);
 await expect(row.getByRole('switch',{name:'Lend with Codex'})).toBeVisible();
 await expect(row.getByRole('button',{name:'Check Codex'})).toHaveCount(0);
 await expect(row.getByRole('button',{name:'Sign in to Codex',exact:true})).toHaveCount(1);
 await expect(page.locator('.hero .btn-primary')).toHaveText('Resume lending');await expect(page.locator('.btn-primary:visible')).toHaveCount(1);
 const shots='test-artifacts/browser-verify/send-readiness';await mkdir(shots,{recursive:true});
 for(const [width,height] of [[1440,900],[390,844]]){
  await page.setViewportSize({width,height});
  const sizes=await page.evaluate(()=>{const hero=document.querySelector('.hero'),cs=getComputedStyle(hero),last=hero.lastElementChild.getBoundingClientRect();return {blank:hero.getBoundingClientRect().bottom-last.bottom-parseFloat(cs.paddingBottom),body:parseFloat(getComputedStyle(document.querySelector('.lstate p')).fontSize),notes:[...document.querySelectorAll('.agent-check-note,.limits p.t-xs')].map(el=>({size:parseFloat(getComputedStyle(el).fontSize),color:getComputedStyle(el).color,expected:getComputedStyle(el).getPropertyValue('--text-2').trim()})),overflow:document.documentElement.scrollWidth-innerWidth};});
  expect(sizes.blank).toBeLessThanOrEqual(2);expect(sizes.overflow).toBeLessThanOrEqual(1);
  expect(sizes.notes.length).toBeGreaterThan(1);for(const note of sizes.notes)expect(note.size).toBeLessThanOrEqual(sizes.body);
  if(width===390)await row.evaluate(el=>el.scrollIntoView({block:'center'}));
  for(const colorScheme of ['light','dark']){
   await page.emulateMedia({colorScheme});
   await page.waitForTimeout(150);
   await page.screenshot({path:join(shots,width+'-'+colorScheme+'.png'),fullPage:width!==390});
  }
 }
 await page.getByRole('button',{name:'Check again',exact:true}).click();await expect.poll(()=>checked).toEqual({agents:['codex']});
 await expect(row.getByRole('button',{name:/Sign in to Codex/})).toBeVisible();
});
test('Lending font sizes use design tokens',()=>{
 const css=readFileSync(new URL('../../ui/v1/src/lend.css',import.meta.url),'utf8');
 expect(css).not.toMatch(/font-size:\s*(?!var\()[\d.]/);
 expect(css).not.toMatch(/font:[^;{}]*\b\d+(?:px|rem)\b/);
});
