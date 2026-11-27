import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
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

const digest='sha256:'+'e'.repeat(64), result='sha256:'+'f'.repeat(64);
const circle={id:'review-circle',name:'Synthetic review circle',origin:'http://fixture',rosterMembershipVerified:true};
const paths=['src/alpha.js','lib/beta.js'];
const diff=paths.map((path,index)=>[
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,4 +1,${index?5:4} @@`,
  ` context ${index}`,
  `-old first ${index}`,
  `-old second ${index}`,
  `+new first ${index}`,
  `+new second ${index}`,
  ...(index?['+   ']:[]),
  ` tail ${index}`,
  '',
].join('\n')).join('');

async function showResult(page,width) {
  const job={job_digest:digest,circle,state:'result-accepted',result_digest:result,local:{title:'Check parser',prompt:'Check parser behavior.',sourcePath:'/fixture/project'}};
  await page.setViewportSize({width,height:844});
  await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
  await page.route('**/api/devices',r=>r.fulfill({json:{fingerprint:'synthetic-device',circles:[]}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/,r=>r.fulfill({json:[projectJobFixture(job)]}));
  await page.route('**/api/jobs/**',r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith('/changes'))return r.fulfill({json:{format:'diff',files:paths.map((path,index)=>({path,status:'modified',insertions:index?3:2,deletions:2})),diffstat:{files:2,insertions:5,deletions:4},diff}});
    if(path.endsWith('/transcript'))return r.fulfill({json:{text:'Parser changes are ready.',live:false}});
    return r.fulfill({json:projectJobFixture(job)});
  });
  await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
  await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();
  await expect(page.locator('.review-tree button')).toHaveCount(2);
}

for(const scenario of [
  {name:'desktop unified',width:1440,split:false,wrap:true,selector:'.review-unified-lines [data-diff-line]'},
  {name:'phone unified',width:390,split:false,wrap:true,selector:'.review-unified-lines [data-diff-line]'},
  {name:'desktop split wrapped',width:1440,split:true,wrap:true,selector:'.review-split-lines [data-diff-line]'},
  {name:'desktop split panes',width:1440,split:true,wrap:false,selector:'.review-split-pane [data-diff-line]'},
]) test(`one Tab stop per diff line and arrow note access: ${scenario.name}`,async({page})=>{
  await showResult(page,scenario.width);
  if(scenario.split)await page.getByRole('button',{name:'Split view',exact:true}).click();
  if(!scenario.wrap)await page.getByLabel('Soft wrap').uncheck();
  const rows=page.locator(scenario.selector);
  const count=await rows.count();
  expect(count).toBeGreaterThanOrEqual(8);
  await expect.poll(()=>rows.evaluateAll(items=>items.filter(item=>item.tabIndex===0).length)).toBe(count);
  await expect(page.locator('.review-diffs button.review-line-number, .review-diffs button.review-line-note').evaluateAll(items=>items.every(item=>item.tabIndex===-1))).resolves.toBe(true);
  const targets=await page.locator('.review-diffs .review-line-number, .review-diffs .review-line-note').evaluateAll(items=>items.filter(item=>item.getClientRects().length>0).map(item=>{const box=item.getBoundingClientRect();return {name:item.getAttribute('aria-label'),width:box.width,height:box.height};}));
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.every(item=>item.width>=24&&item.height>=24)).toBe(true);
  expect(targets.some(item=>item.name.includes('old line'))).toBe(true);
  expect(targets.some(item=>item.name.includes('new line'))).toBe(true);

  const fileRows=page.locator('#diff-file-0 '+scenario.selector),fileCount=await fileRows.count();
  await fileRows.first().focus();
  for(let index=1;index<fileCount;index++) {
    await page.keyboard.press('Tab');
    await expect(fileRows.nth(index)).toBeFocused();
  }

  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  const changedRow=rows.filter({hasText:'new first 0'}).first();
  await changedRow.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button',{name:'Add note on src/alpha.js new line 2',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  const editor=page.getByLabel('Note on new line 2');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Keep the new-side note reachable.');
  await page.getByRole('button',{name:'Save note',exact:true}).press('Enter');
  await expect(page.getByText('Keep the new-side note reachable.',{exact:true})).toBeVisible();
  const contextRow=rows.filter({hasText:'context 0'}).first();
  await contextRow.focus();await page.keyboard.press('ArrowLeft');
  const oldTarget=page.getByRole('button',{name:'Add note on src/alpha.js old line 1',exact:true});
  await expect(oldTarget).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByLabel('Note on old line 1')).toBeFocused();
  await page.getByRole('button',{name:'Cancel',exact:true}).press('Enter');

  if(!scenario.wrap&&scenario.split) {
    await expect(oldTarget).toBeFocused();
    const oldRow=page.locator('#diff-file-0 .review-split-pane').first().locator('[data-diff-line]').filter({hasText:'old first 0'});
    const newRow=page.locator('#diff-file-0 .review-split-pane').last().locator('[data-diff-line]').filter({hasText:'new first 0'});
    await oldRow.focus();await page.keyboard.press('ArrowRight');
    const focusEvidence=await page.evaluate(()=>({active:document.activeElement.outerHTML,panes:[...document.querySelectorAll('#diff-file-0 .review-split-pane')].map(pane=>[...pane.querySelectorAll('[data-diff-line]')].map(row=>({label:row.getAttribute('aria-label'),targets:[...row.querySelectorAll('button')].map(button=>({side:button.dataset.noteSide,label:button.getAttribute('aria-label')}))})))}));
    await expect(newRow,JSON.stringify(focusEvidence)).toBeFocused();
    await page.keyboard.press('ArrowLeft');await expect(oldRow).toBeFocused();
  }

});

test('changed-file navigation exposes viewed state in its accessible name',async({page})=>{
  await showResult(page,1440);
  const treeRow=page.getByRole('button',{name:/alpha\.js.*Not viewed/});
  await expect(treeRow).toBeVisible();
  await expect(treeRow).toHaveAccessibleName(/alpha\.js.*Not viewed/);
  await page.getByLabel('Viewed src/alpha.js').check();
  await expect(page.getByRole('button',{name:/alpha\.js.*Viewed/})).toBeVisible();
});

test('note editor returns focus to the edited file when its opener disappears',async({page})=>{
  await showResult(page,1440);
  const whitespaceLine=page.locator('#diff-file-1 .review-unified-lines .diff-add').last();
  const opener=await whitespaceLine.locator('button.review-line-number[data-note-side="new"]').elementHandle();
  const openerLabel=await opener.getAttribute('aria-label');
  await whitespaceLine.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
  await expect(page.getByLabel(/Note on new line/)).toBeFocused();
  await page.getByLabel('Hide whitespace-only lines').check();
  await expect.poll(()=>opener.evaluate(element=>element.getAttribute('aria-label'))).not.toBe(openerLabel);
  await expect(page.locator('#diff-file-1 .review-note-form')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('#diff-file-1 .review-collapse')).toBeFocused();
});

test('diff controls have no prohibited ARIA attributes',async({page})=>{
  await showResult(page,1440);
  const source=await readFile('node_modules/axe-core/axe.min.js','utf8');
  await page.evaluate(code=>new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    script.onload=resolve;script.onerror=reject;document.head.append(script);
  }),source);
  const scan=await page.evaluate(async()=>axe.run(document,{runOnly:{type:'rule',values:['aria-prohibited-attr']}}));
  expect(scan.violations.map(item=>item.id)).not.toContain('aria-prohibited-attr');
});
