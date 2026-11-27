import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
// Bug (tester, sandpiper, 11-01): "Start another circle" with a stopped earlier hosted circle showed that circle's
// "isn't running" status as the page. On #/circles/new the page is always the new-circle form; the stopped circle is one note.
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const circle={id:'demo',name:'Faravan demo',origin:'http://fixture',owned:true};
for(const width of [1440,390])test(`new circle form with a stopped hosted circle ${width}`,async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height:900});
  let hosting={configured:true,running:false,processState:'stopped',name:'Faravan demo',circle:'demo',circles:[{id:'demo',name:'Faravan demo'}],origin:'http://fixture',reach:{kind:'url',domain:null,tailscale:false}};
  const created=[];
  await page.route('**/api/hosting',r=>r.fulfill({json:hosting}));
  await page.route('**/api/circles',r=>{
    if(r.request().method()==='POST'){created.push(r.request().postDataJSON());return r.fulfill({json:{id:'weekend',name:'Weekend',origin:'http://fixture',owned:true}});}
    return r.fulfill({json:[circle]});
  });
  await page.goto((await harness.link('lender'))+'#/circles/new');await page.locator('#main').waitFor();
  await expect(page.getByRole('heading',{name:'Start another circle',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Circle name'})).toBeVisible();
  await expect(page.getByText('Faravan demo isn’t running on this computer. Starting a new circle starts hosting here again, at the same address.')).toBeVisible();
  await expect(page.getByRole('link',{name:'Open Faravan demo hosting',exact:true})).toHaveAttribute('href','#/circles/host');
  await expect(page.locator('#main')).not.toContainText('Members can’t send or get jobs');
  await expect(page.getByRole('button',{name:'Start again',exact:true})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Circle name'}).fill('Weekend');
  await page.getByRole('button',{name:'Start circle',exact:true}).click();
  await expect.poll(()=>created).toEqual([{name:'Weekend'}]);
  await expect(page).toHaveURL(/#\/circle\/weekend$/);
  expect(errors).toEqual([]);
});
