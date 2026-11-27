import { expect, test } from '@playwright/test';
import { checkPage } from './invariants.mjs';

const shell = (body) => `<!doctype html><html><head><style>
  * { box-sizing: border-box } body { margin: 0; font: 16px Arial, sans-serif; color: #222 }
  .result-prose,.job-summary,.request-context-markdown,.transcript-feed { max-width: 680px; padding: 16px; }
  pre { font-family: monospace; }
  ${body.css ?? ''}
  </style></head><body>${body.html}</body></html>`;

async function expectInvariant(page, html, context, id, shouldFail) {
  await page.setContent(shell({ html }));
  const { failures } = await checkPage(page, context);
  const ids = failures.map(({ id: failureId }) => failureId);
  if (shouldFail) expect(ids, `${id} should fail on its broken fixture`).toContain(id);
  else expect(ids, `${id} should pass on its valid fixture`).not.toContain(id);
}

test('I23 uses rendered clipping geometry instead of screen-reader class names', async ({ page }) => {
  await expectInvariant(page, '<div class="notice sr-only" aria-live="polite">Job saved</div>', {}, 'I23', true);
  await expectInvariant(page, '<div class="notice sr-only" aria-live="polite" style="width:10px;height:10px;clip-path:inset(50%)">Job saved</div>', {}, 'I23', false);
  await expectInvariant(page, '<div class="notice" aria-live="polite" style="clip-path:inset(0)">Job saved</div>', {}, 'I23', true);
  await expectInvariant(page, '<div class="notice" aria-live="polite" style="width:100px;height:400px;clip-path:inset(25%)">Job saved</div>', {}, 'I23', false);
  await expectInvariant(page, '<div class="notice" aria-live="polite" style="width:100px;height:400px;clip-path:inset(25%);padding-top:120px;padding-left:26px">Job saved</div>', {}, 'I23', true);
  await expectInvariant(page, '<div class="notice" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Job saved</div>', {}, 'I23', false);
});

test('I23 intersects nested clip bounds before deciding text is visible',async({page})=>{
  for(const [left,shouldFail] of [[50,false],[40,true]]) {
    await expectInvariant(page,`<div style="width:100px;height:40px;clip-path:inset(0 50% 0 0)"><div class="notice" aria-live="polite" style="width:100px;height:40px;clip-path:inset(0 0 0 ${left}%);font:20px/40px monospace;white-space:nowrap;text-indent:44px">X</div></div>`,{},'I23',shouldFail);
  }
});

test('markdown heading detection follows rendered whitespace',async({page})=>{
  for(const whiteSpace of ['normal','nowrap'])await expectInvariant(page,`<div class="result-prose" style="white-space:${whiteSpace}">Introduction\n# ordinary inline hashtag</div>`,{},'I19',false);
  for(const whiteSpace of ['pre-line','pre-wrap'])await expectInvariant(page,`<div class="result-prose" style="white-space:${whiteSpace}">Introduction\n# raw heading</div>`,{},'I19',true);
});

test('text outside supported clipping bounds cannot create markdown or status failures',async({page})=>{
  for(const clipping of ['clip-path:inset(25%)','overflow:hidden;height:0px']) {
    await page.setContent(shell({html:`<main class="job-page"><div class="jh">Approved</div><section style="width:100px;height:400px;${clipping}"><div class="job-timeline">Waiting for approval</div><div class="result-prose">**raw markdown**</div><p>HTTP 503</p></section></main>`}));
    for(const id of ['I01','I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),clipping+' '+id).not.toContain(id);
  }
});

test('I20 checks line breaks within each of two rendered panes', async ({ page }) => {
  const context = { expectedLines: ['First line', 'Second line'] };
  await expectInvariant(page, '<div class="transcript-feed">First line<br>Second line</div><div class="result-prose">First line Second line</div>', context, 'I20', true);
  await expectInvariant(page, '<div class="transcript-feed">First line<br>Second line</div><div class="result-prose">First line<br>Second line</div>', context, 'I20', false);
});

test('I41 distinguishes collapsed ASCII spacing under pre-line from preserved pre-wrap', async ({ page }) => {
  const ascii = '    /\\\n   (oo)';
  await expectInvariant(page, `<div class="result-prose"><pre style="white-space:pre-line">${ascii}</pre></div>`, {}, 'I41', true);
  await expectInvariant(page, `<div class="result-prose"><pre style="white-space:pre-wrap">${ascii}</pre></div>`, {}, 'I41', false);
});

test('I03 still checks prose inside an intentionally scrolling pane',async({page})=>{
  await expectInvariant(page,'<div style="width:100px;overflow-x:auto"><div style="width:500px"><p style="width:20px;word-break:break-all">unbreakable</p></div></div>',{},'I03',true);
});

test('closed terminal disclosures contribute no visible text or word boxes',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.setContent(shell({html:'<main class="job-page"><p>Approved</p><details><summary>Start from a terminal</summary>HTTP 503<section><div class="cmd">$ <code>faravan host</code></div><p>Waiting for approval</p><div class="result-prose">**unrendered markdown**</div><p style="width:20px;word-break:break-all">unbreakable</p></section></details></main>'}));
  for(const id of ['I01','I03','I05','I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'closed disclosure '+id).not.toContain(id);
  await page.getByText('Start from a terminal',{exact:true}).click();
  for(const id of ['I01','I03','I05','I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'open disclosure '+id).toContain(id);
});


test('transparent content does not create visible markdown or a status contradiction',async({page})=>{
  await page.setContent(shell({html:'<main class="job-page"><div class="jh">Approved</div><div id="fading" style="opacity:0"><div class="job-timeline">Waiting for approval</div><div class="result-prose">**unrendered markdown**</div></div></main>'}));
  for(const id of ['I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'transparent '+id).not.toContain(id);
  await page.locator('#fading').evaluate(el=>el.style.opacity='1');
  for(const id of ['I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'opaque '+id).toContain(id);
});

test('hidden descendants do not leak markdown or statuses through visible containers',async({page})=>{
  await page.setContent(shell({html:'<main class="job-page"><div class="result-prose">Visible result<span class="hidden" style="opacity:0">**hidden markdown**</span></div><div class="job-timeline">Approved<span class="hidden" style="opacity:0">Waiting for approval</span></div></main>'}));
  for(const id of ['I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'hidden descendant '+id).not.toContain(id);
  await page.locator('.hidden').evaluateAll(elements=>elements.forEach(el=>el.style.opacity='1'));
  for(const id of ['I07','I19'])expect((await checkPage(page)).failures.map(f=>f.id),'opaque descendant '+id).toContain(id);
  await page.setContent(shell({html:'Approved<span id="hidden" style="opacity:0">Waiting for approval</span>'}));
  expect((await checkPage(page)).failures.map(f=>f.id),'status fallback excludes hidden text').not.toContain('I07');
  await page.locator('#hidden').evaluate(el=>el.style.opacity='1');
  expect((await checkPage(page)).failures.map(f=>f.id),'status fallback sees opaque text').toContain('I07');
  await page.setContent(shell({html:'<div class="result-prose">Introduction<p># Raw heading</p></div>'}));
  expect((await checkPage(page)).failures.map(f=>f.id),'block boundaries retain raw markdown heading').toContain('I19');
});

test('a descendant can override inherited visibility and become painted',async({page})=>{
  await page.setContent(shell({html:'<div class="notice result-prose" aria-live="polite" style="visibility:hidden"><section id="child"><p>HTTP 503</p><p>**raw markdown**</p><p style="width:20px;word-break:break-all">unbreakable</p></section></div>'}));
  for(const id of ['I01','I03','I19','I23'])expect((await checkPage(page)).failures.map(f=>f.id),'hidden child '+id).not.toContain(id);
  await page.locator('#child').evaluate(el=>el.style.visibility='visible');
  for(const id of ['I01','I03','I19','I23'])expect((await checkPage(page)).failures.map(f=>f.id),'visible child '+id).toContain(id);
  await page.setContent(shell({html:'<main class="jlist"><a class="row" style="visibility:hidden"><span style="visibility:visible">Approved. Waiting for approval.</span></a></main>'}));
  expect((await checkPage(page)).failures.map(f=>f.id),'visible status in an inherited hidden row').toContain('I07');
});
