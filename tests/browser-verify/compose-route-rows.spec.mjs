import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
import {checkPage} from './invariants.mjs';

// At 1280 px the Model and Effort rows keep label, control and hint in one card. The hint wraps below the control,
// and the chevron sits on the select's own line, inside the select.
const circle={id:'route-rows',name:'Weekend projects',origin:'https://fixture.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
const project={path:'/home/sam/code/booking-site',name:'booking-site',branch:'main',head:'a'.repeat(40),files:4,changed:[],changed_count:0};
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

test('compose route rows at 1280 px: no overflow past the card, the hint below the control, the chevron inside the select',async({browser})=>{
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();
  await page.addInitScript(({circle,project})=>{
    localStorage.setItem('faravan-compose-circle',circle.id);
    // No agent chosen: Model and Effort show "Choose an agent first." beside their controls.
    localStorage.setItem('faravan-compose-draft:'+circle.id,JSON.stringify({id:'route-rows-draft',prompt:'Check the booking widths.',sourceKind:'folder',path:project.path}));
  },{circle,project});
  await page.route('**/api/folders?path=',r=>r.fulfill({json:{home:'/home/sam',path:'/home/sam',folders:[]}}));
  await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose',r=>r.fulfill({json:{networked:true,host:{label:'Ana’s MacBook',reachable:true},lenders:[{label:'Ana’s MacBook',agents:[{adapter:'codex',readiness:'ready'}]}]}}));
  await page.route('**/api/repo/inspect',r=>r.fulfill({json:project}));
  await page.goto((await harness.link('owner'))+'#/new');
  await expect(page.locator('#cmp-prompt')).toBeVisible();
  await expect(page.locator('#cmp-model')).toBeVisible();

  const geometry=await page.evaluate(()=>{
    const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const card=document.querySelector('#cmp-model').closest('.cmp')??document.querySelector('#cmp-model').closest('.card');
    return ['cmp-model','cmp-effort'].map(id=>{
      const select=document.getElementById(id), row=select.closest('.cmp-route-field');
      const hint=row.querySelector('.hint'), chevron=row.querySelector('svg');
      return {id, card:box(card), row:box(row), select:box(select), hint:hint?box(hint):null, chevron:chevron?box(chevron):null,
        hintText:hint?.textContent??''};
    });
  });

  for(const row of geometry) {
    // The row stays inside the card: nothing runs past its right edge.
    expect(row.row.right, row.id+' row past card').toBeLessThanOrEqual(row.card.right+1);
    expect(row.row.left, row.id+' row before card').toBeGreaterThanOrEqual(row.card.left-1);
    // The chevron is inside the select, on the select's line.
    expect(row.chevron, row.id+' chevron').not.toBeNull();
    expect(row.chevron.left, row.id+' chevron left of select').toBeGreaterThanOrEqual(row.select.left);
    expect(row.chevron.right, row.id+' chevron right of select').toBeLessThanOrEqual(row.select.right+1);
    expect(row.chevron.top, row.id+' chevron above select line').toBeGreaterThanOrEqual(row.select.top-1);
    expect(row.chevron.bottom, row.id+' chevron below select line').toBeLessThanOrEqual(row.select.bottom+1);
  }
  // The hint names the reason and sits under its control, inside the card, not in a one-word column beside it.
  for(const row of geometry.filter(item=>item.hint)) {
    expect(row.hintText, row.id+' hint').toMatch(/Choose an agent first\./);
    expect(row.hint.top, row.id+' hint under select').toBeGreaterThanOrEqual(row.select.bottom-1);
    expect(row.hint.left, row.id+' hint left edge').toBeGreaterThanOrEqual(row.select.left-1);
    expect(row.hint.right, row.id+' hint past card').toBeLessThanOrEqual(row.card.right+1);
  }
  expect(geometry.filter(item=>item.hint).length, 'hint on Model and Effort').toBeGreaterThan(0);

  const {failures}=await checkPage(page,{});
  expect(failures.filter(f=>['I02','I04'].includes(f.id)),'overflow and squeezed text at 1280 px').toEqual([]);
  await context.close();
});
