import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'shared',name:'Weekend projects',origin:'http://fixture'};
async function homeFixture(page,{checks=[],approvals=[]}={}) {
 await page.route('**/api/home',r=>r.fulfill({json:{intent:{on:false,state:'off'},lending:{enabled:false,circle:'shared',status:'idle',limits:{dailyJobs:6}},today:{jobs:0,jobLimit:6}}}));
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/agents',r=>r.fulfill({json:[{id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true}]}));
 await page.route('**/api/readiness',r=>r.fulfill({json:{ready:false,checks}}));
 await page.route('**/api/approvals',r=>r.fulfill({json:approvals}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[]}));
}
const MISSING=[{name:'sbx_install',ok:false,label:'Docker Sandboxes is not installed.',remedy:'curl -fsSL https://example.invalid/install.sh | sh'}];

test('r8 O7: the Install Docker Sandboxes button stays one real button on a phone',async({page})=>{
 await homeFixture(page,{checks:MISSING});
 await page.setViewportSize({width:390,height:844});
 await page.goto((await harness.link('lender'))+'#/home');
 const card=page.locator('section[aria-labelledby=home-needs] .request-preview',{hasText:'Docker Sandboxes'});
 await expect(card).toBeVisible();
 const action=card.locator('a.btn,button.btn').first();await expect(action).toBeVisible();
 const geometry=await action.evaluate(el=>{const box=el.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect(),card=el.closest('.request-preview').getBoundingClientRect();
  return {width:box.width,height:box.height,textLeft:text.left,textRight:text.right,left:box.left,right:box.right,cardRight:card.right};});
 expect(geometry.width).toBeGreaterThan(120);
 expect(geometry.height).toBeLessThan(80);
 expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.left-1);
 expect(geometry.textRight).toBeLessThanOrEqual(geometry.right+1);
 expect(geometry.right).toBeLessThanOrEqual(geometry.cardRight);
});
