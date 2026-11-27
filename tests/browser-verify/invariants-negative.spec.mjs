import { expect, test } from '@playwright/test';
import { INVARIANTS, checkPage } from './invariants.mjs';
import {FINDINGS} from './invariants-findings.mjs';
import {journeyInvariants} from './invariants-journey.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';

const shell = (body, css = '') => `<!doctype html><html><head><style>
  * { box-sizing: border-box } body { margin: 0; font: 16px Arial, sans-serif; color: #222 }
  .result-prose,.job-summary,.request-context-markdown,.transcript-feed { max-width: 680px; padding: 16px; }
  button { font: inherit } ${css}
  </style></head><body>${body}</body></html>`;

const cases = {
  I01: { good: '<main class="result-prose">The job finished and the result is ready.</main>', bad: '<main class="result-prose">The request failed: HTTP 503 at /home/runner/app.</main>' },
  I02: { good: '<main>All project details fit this page.</main>', bad: '<main style="width:1200px">A result panel extends beyond the viewport.</main>' },
  I03: { good: '<p class="result-prose" style="width:200px;overflow-wrap:normal">word</p>', bad: '<p class="result-prose" style="width:20px;word-break:break-all">unbreakable</p>' },
  I04: { good: '<p class="result-prose" style="width:80px">A brief note fits this card.</p>', bad: '<p class="result-prose" style="width:80px">The complete sentence keeps squeezing across this narrow panel for every reader.</p>' },
  I05: { viewport: { width: 390, height: 844 }, good: '<main>Pair this device again from Settings on your computer.</main>', bad: '<main>Run faravan from the tray to continue the job.</main>' },
  I06: { good: '<main>Current status: Running.</main>', bad: '<main>Last known: Running.</main>', goodContext: { fresh: true }, badContext: { fresh: true } },
  I07: { good: '<main>Agent working. The job is underway.</main>', bad: '<main>Approved. Waiting for a decision.</main>' },
  I08: { good: '<main>Done for today. Your daily limit is used.</main>', bad: '<main>Done for today. <button>Run it</button></main>', goodContext: { capped: true }, badContext: { capped: true } },
  I09: { good: '<main>No job can start until the safety test finishes.</main>', bad: '<main>No job can start. Lending is on and ready for requests.</main>' },
  I10: { good: '<main>Didn’t run: the check was skipped.</main>', bad: '<main>Didn’t run: the check was skipped. Faravan ran the formatter after the agent.</main>' },
  I11: { good: '<main>Jordan’s agent wants to run this job.</main>', bad: '<main>desk-7’s agent wants to run this job.</main>', goodContext: { people: [{ device: 'desk-7', person: 'Jordan' }] }, badContext: { people: [{ device: 'desk-7', person: 'Jordan' }] } },
  I12: { good: '<main>Your computer is running the agent.</main>', bad: '<main>desk-7’s computer is running the agent.</main>', goodContext: { selfDevice: 'desk-7' }, badContext: { selfDevice: 'desk-7' } },
  I13: { good: '<main class="transcript-feed"><p>The agent read the project and found the issue.</p></main>', bad: '<main class="transcript-feed"><li>Read</li><p>The agent found the issue.</p></main>' },
  I14: { good: '<main>The accepted prompt is available for review.</main>', bad: '<main>The prompt is not available right now.</main>', goodContext: { promptKnown: true }, badContext: { promptKnown: true } },
  I15: { good: '<main>Your request was accepted on this computer.</main>', bad: '<main>Your request was answered somewhere else.</main>', goodContext: { accepting: true }, badContext: { accepting: true } },
  I16: { good: '<main>You joined the circle. Members can now share jobs.</main>', bad: '<main>You joined, but are not in the circle yet.</main>', goodContext: { joined: true }, badContext: { joined: true } },
  I17: { good: '<main><button>Download changed files</button></main>', bad: '<main><button disabled>Download changed files</button></main>', goodContext: { plainFolderResult: true }, badContext: { plainFolderResult: true } },
  I18: { good: '<main>Your poem is ready.</main>', bad: '<main>What changed for you. The agent made no changes.</main>', goodContext: { messageResult: true }, badContext: { messageResult: true } },
  I19: { good: '<main class="result-prose"><p><strong>Result</strong> is ready.</p></main>', bad: '<main class="result-prose"><p>**Result** is ready.</p></main>' },
  I20: { good: '<main class="transcript-feed"><p>First line<br>Second line</p></main>', bad: '<main class="transcript-feed"><p>First line Second line</p></main>', goodContext: { expectedLines: ['First line', 'Second line'] }, badContext: { expectedLines: ['First line', 'Second line'] } },
  I21: { good: '<main class="diff"><pre style="font-variant-ligatures:none">const value = 1;</pre></main>', bad: { html: '<main class="diff"><pre>const value = 1;</pre></main>', context: {} } },
  I22: { viewport: { width: 390, height: 844 }, good: '<main><button>Add note</button></main>', bad: '<main><button class="review-line-note" style="position:fixed;right:8px;bottom:8px">＋</button></main>' },
  I23: { good: '<main><div class="notice" aria-live="polite" style="position:absolute;width:1px;height:1px;clip-path:inset(50%)">Job saved</div><p>Job saved.</p></main>', bad: '<main><div class="notice" aria-live="polite">Job saved.</div></main>' },
  I24: { good: '<main><input value="Project name" style="width:100%;height:60px"><div style="position:fixed;right:12px;top:12px;background:white;padding:8px">Saved</div></main>', bad: '<main><input value="Project name" style="width:100%;height:60px"><div style="position:fixed;right:12px;top:12px;background:transparent;padding:8px">Saved</div></main>' },
  I25: { good: '<main class="job-page" style="width:800px"><header class="pagehead" style="width:800px;height:40px">Job</header><section style="width:800px">Details</section></main>', bad: '<main class="job-page" style="width:800px"><header class="pagehead" style="width:800px;height:40px">Job</header><section style="width:1000px">Details exceed the frame</section></main>' },
  I26: { viewport: { width: 390, height: 844 }, good: '<main><button style="display:block">Add as a branch</button><pre aria-label="Changes" style="margin-top:40px">+ change</pre></main>', bad: '<main><pre aria-label="Changes">+ change</pre><button style="display:block;margin-top:40px">Add as a branch</button></main>' },
  I27: { good: '<main>Offer is open until Friday.</main>', bad: '<main>Open until</main>', goodContext: { deadlineFutureDay: true }, badContext: { deadlineFutureDay: true } },
  I28: { good: '<main>Offer expired. <button disabled>Run it</button></main>', bad: '<main>Offer expired. <button>Run it</button></main>', goodContext: { expiredOffer: true }, badContext: { expiredOffer: true } },
  I29: { good: '<main>Output marker: alpha-42</main>', bad: '<main>Output marker: alpha-42</main>', goodContext: { liveMarker: 'alpha-42', liveLatencyMs: 3000 }, badContext: { liveMarker: 'alpha-42', liveLatencyMs: 5001 } },
  I30: { good: '<main>Dashboard ready.</main>', bad: '<main>Dashboard ready.</main>', goodContext: { network: { reads: 20, maxPerPath: 4, maxConcurrent: 1, aborted: 0 } }, badContext: { network: { reads: 121, maxPerPath: 4, maxConcurrent: 1, aborted: 0 } } },
  I31: { good: '<main>Job details are ready.</main>', bad: '<main>Loading job details…</main>', goodContext: { dataAvailable: true, stateAgeMs: 1000 }, badContext: { dataAvailable: true, stateAgeMs: 10000 } },
  I32: { good: '<main>Cached result marker: result-9</main>', bad: '<main>Cached result marker: result-9. The job didn’t load.</main>', goodContext: { cachedResult: true, resultMarker: 'result-9' }, badContext: { cachedResult: true, resultMarker: 'result-9' } },
  I33: { good: '<main>Settings saved.</main>', bad: '<main>Settings are still updating.</main>', goodContext: { mutation: { ageMs: 1000, confirmation: 'Settings saved' } }, badContext: { mutation: { ageMs: 2000, confirmation: 'Settings saved' } } },
  I34: { good: '<main>You ran 3 of your own jobs.</main>', bad: '<main>You helped 3 people this week.</main>', goodContext: { onlyOwnJobs: true }, badContext: { onlyOwnJobs: true } },
  I35: { good: '<main>The sandbox is missing. Open a terminal to finish setup.</main>', bad: '<main>The sandbox is missing. Finish setup to continue.</main>', goodContext: { missingSandbox: true }, badContext: { missingSandbox: true } },
  I36: { good: '<main>The result is ready for review.</main>', bad: '<main>Result unavailable. Faravan couldn’t complete this action. Try again.</main>', goodContext: { resultAvailable: true }, badContext: { resultAvailable: true } },
  I37: { good: '<main>You joined the circle. The app is still running.</main>', bad: '<main>You joined. This did not resume after Faravan restarted.</main>', goodContext: { noRestart: true }, badContext: { noRestart: true } },
  I38: { good: '<main>Your session expired. Sign in again.</main>', bad: '<style>body{font-family:Times New Roman,serif}</style><main>Your session expired. Sign in again.</main>', goodContext: { expiredSession: true }, badContext: { expiredSession: true } },
  I39: {good:'<main><button>Start circle</button></main>',bad:'<main>Start from a terminal</main>',goodContext:{circleFormReady:true},badContext:{circleFormReady:true}},
  I40: {good:'<main>Choose a folder to continue. <button>Browse</button></main>',bad:'<main>This is a folder but not a git repository.</main>',goodContext:{plainFolderRejected:true},badContext:{plainFolderRejected:true}},
  I41: {good:'<main class="result-prose"><pre style="font-family:monospace"> /\\\n(oo)</pre></main>',bad:'<main class="result-prose"><pre style="font-family:Arial;white-space:normal"> /\\\n(oo)</pre></main>'},
  I42: {good:'<main class="job-summary">Work finished.</main>',bad:'<main class="job-summary">Starting the work.</main>',goodContext:{firstLiveMessage:'Starting the work.',finalSummary:'Work finished.'},badContext:{firstLiveMessage:'Starting the work.',finalSummary:'Work finished.'}},
  I43: {good:'<main>Last known: Waiting. Showing what Faravan saved.</main>',bad:'<main>Status unavailable. We can’t tell what happened to this job.</main>',goodContext:{knownState:true},badContext:{knownState:true}},
  I45: {good:'<main>Ready for requests</main>',bad:'<main>Ready for requests</main>',goodContext:{readyAdmission:null},badContext:{readyAdmission:'daily_limit',readyRefusedMs:5000}},
  I44: {good:'<main>Sending…</main>',bad:'<main>Please wait before continuing. Nothing changed. Faravan is busy for a moment; the button works again when it is ready.</main>',goodContext:{userAction:true},badContext:{userAction:true}},
};

const invariantIds = new Set(INVARIANTS.map(({ id }) => id));
expect(Object.keys(cases).length).toBe(45);
expect(new Set(Object.keys(cases))).toEqual(invariantIds);
expect(FINDINGS).toHaveLength(50);
expect(new Set(FINDINGS.map(f=>f.finding)).size).toBe(50);
for(const finding of FINDINGS)for(const id of finding.invariants)expect(invariantIds.has(id),finding.finding+' references '+id).toBe(true);

for (const { id, title } of INVARIANTS) {
  test(`${id}: ${title} has passing and failing rendered examples`, async ({ page }) => {
    const fixture = cases[id];
    const options = fixture.viewport ?? { width: 800, height: 900 };
    await page.setViewportSize(options);
    const good = typeof fixture.good === 'string' ? { html: fixture.good, context: fixture.goodContext ?? {} } : fixture.good;
    const bad = typeof fixture.bad === 'string' ? { html: fixture.bad, context: fixture.badContext ?? {} } : fixture.bad;

    await page.setContent(shell(good.html));
    const passing = await checkPage(page, good.context);
    expect(passing.failures.map(({ id: failureId }) => failureId), `${id} should pass on its good fixture`).not.toContain(id);

    await page.setContent(shell(bad.html));
    const failing = await checkPage(page, bad.context);
    expect(failing.failures.map(({ id: failureId }) => failureId), `${id} should fail on its broken fixture`).toContain(id);
  });
}

// Judge r10 R1: an empty "Last known:" fails on any page; "unreachable" fails while the host process is up.
test('I43: an empty Last known fails, and an unreachable saved copy fails while the host is up',async({page})=>{
  await page.setContent(shell('<main><p>Job status is updating.</p><p>Last known: </p></main>'));
  expect((await checkPage(page,{})).failures.map(f=>f.id)).toContain('I43');
  await page.setContent(shell('<main><p>Last known: Waiting</p></main>'));
  expect((await checkPage(page,{})).failures.map(f=>f.id)).not.toContain('I43');
  await page.setContent(shell('<main><p>Weekend projects is unreachable. Showing what Faravan saved 2 min ago.</p></main>'));
  expect((await checkPage(page,{hostAvailable:true})).failures.map(f=>f.id)).toContain('I43');
  expect((await checkPage(page,{hostAvailable:false})).failures.map(f=>f.id)).not.toContain('I43');
  await page.setContent(shell('<main><p>Faravan is catching up with Weekend projects. Showing what it saved 2 min ago.</p></main>'));
  expect((await checkPage(page,{hostAvailable:true})).failures.map(f=>f.id)).not.toContain('I43');
});

test('a smaller remaining budget can still be ready for smaller requests',async({page})=>{
  await page.setContent(shell('<main>Ready for requests. <button disabled>Run it</button></main>'));
  expect((await checkPage(page,{requestDoesNotFit:true})).failures.map(f=>f.id)).not.toContain('I08');
});

test('a successful mutation may disable its submitted form while pending',async({page})=>{
  await page.setContent(shell('<main><button disabled>Start circle</button><p>Starting circle…</p></main>'));
  expect((await checkPage(page)).failures.map(f=>f.id)).not.toContain('I39');
});

test('a deliberately held summary does not count as available data',async({page})=>{
  await page.setContent(shell('<main role="status" aria-label="Loading result">Preparing the summary…</main>'));
  expect((await checkPage(page,{availableResources:{'Loading job':20000}})).failures.map(f=>f.id)).not.toContain('I31');
  expect((await checkPage(page,{availableResources:{'Loading result':10000}})).failures.map(f=>f.id)).toContain('I31');
});

test('unrelated jobs and membership instructions do not contradict each other',async({page})=>{
  await page.setContent(shell('<main class="jlist"><a class="row" href="#/job/a">Ready to review</a><a class="row" href="#/job/b">Waiting for approval</a></main>'));
  expect((await checkPage(page)).failures.map(f=>f.id)).not.toContain('I07');
  await page.setContent(shell('<main class="circle-page">Approved. Lending remains off. No computers are waiting for approval.</main>'));
  expect((await checkPage(page)).failures.map(f=>f.id)).not.toContain('I07');
  await page.setContent(shell('<main class="job-page">Ready to review. Waiting for approval.</main>'));
  expect((await checkPage(page)).failures.map(f=>f.id)).toContain('I07');
});

test('fresh app metadata is not proof of fresh job status',async({page})=>{
  await page.setContent(shell('<main>Last known: Running.</main>'));
  expect((await checkPage(page,{appFresh:true,jobFresh:false})).failures.map(f=>f.id)).not.toContain('I06');
  expect((await checkPage(page,{appFresh:true,jobFresh:true})).failures.map(f=>f.id)).toContain('I06');
});

test('the recorder catches overlapping reads without carrying them to another route',async({page})=>{
  const server=createServer((req,res)=>{
    if(req.url==='/api/read')setTimeout(()=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}');},150);
    else {res.writeHead(200,{'content-type':'text/html'});res.end(shell('<main><button onclick="Promise.all([fetch(\'/api/read\'),fetch(\'/api/read\')])">Read twice</button><button id="start" onclick="this.disabled=true">Start circle</button><a href="#/clean">Clean page</a></main>'));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const recorder=journeyInvariants({attach:(name,data)=>test.info().attach('negative-fixture-'+name,data)});recorder.register(page,'negative fixture');
  let finished=false;
  try {
    await page.goto('http://127.0.0.1:'+server.address().port+'/#/broken');
    await recorder.checkpoint(page,'valid form',{circleFormReady:true});
    await page.getByRole('button',{name:'Start circle',exact:true}).click();
    await page.getByRole('button',{name:'Read twice',exact:true}).click();
    await page.waitForTimeout(400);
    await recorder.checkpoint(page,'overlapping reads');
    await page.getByRole('link',{name:'Clean page',exact:true}).click();
    await recorder.checkpoint(page,'clean route');
    const result=await recorder.finish();
    finished=true;
    expect(result.failures.some(f=>f.id==='I30'&&f.route==='#/broken')).toBe(true);
    expect(result.failures.some(f=>f.id==='I30'&&f.route==='#/clean')).toBe(false);
    expect(result.failures.some(f=>f.id==='I39')).toBe(false);
  } finally {if(!finished)await recorder.finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('unexpected cancellation fails but an explicitly declared outage is not a read storm',async({page})=>{
  const server=createServer((req,res)=>{
    if(req.url==='/api/held')return;
    res.writeHead(200,{'content-type':'text/html'});
    res.end(shell('<button onclick="const c=new AbortController();fetch(\'/api/held\',{signal:c.signal}).catch(()=>{});setTimeout(()=>c.abort(),50)">Cancel read</button>'));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    for(const outage of [false,true]) {
      const recorder=journeyInvariants({attach:(name,data)=>test.info().attach('negative-fixture-'+name,data)});
      recorder.register(page,'cancellation fixture');
      try {
        await page.goto('http://127.0.0.1:'+server.address().port+'/#/'+(outage?'outage':'available'));
        if(outage)recorder.availability(page,false);
        const failed=page.waitForEvent('requestfailed');
        await page.getByRole('button',{name:'Cancel read',exact:true}).click();await failed;
        const result=await recorder.finish();
        expect(result.failures.some(f=>f.id==='I30')).toBe(!outage);
        const diagnostic=recorder.diagnostics(page);
        const aborted=diagnostic.abortedRequests.find(item=>item.path==='/api/held');
        expect(aborted).toMatchObject({path:'/api/held',startedRoute:'#/'+(outage?'outage':'available'),startedAvailable:!outage,failedAvailable:!outage,counted:!outage});
        expect(aborted.startedAt).toBeLessThanOrEqual(aborted.failedAt);
        expect(aborted.startedTime).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(aborted.failedTime).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(aborted.startedEpoch).toBeLessThanOrEqual(aborted.failedEpoch);
        if(!outage) {
          const failure=result.failures.find(item=>item.id==='I30');
          expect(failure.diagnostics.abortedRequests).toContainEqual(aborted);
          expect(failure.diagnostics.timeline.some(item=>item.event==='api-read-start'&&item.path==='/api/held')).toBe(true);
        }
      } finally {await recorder.finish();}
    }
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('I43 failure evidence keeps the exact visible status and last successful job read',async({page})=>{
  const server=createServer((req,res)=>{
    if(req.url==='/api/jobs/one'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
    res.writeHead(200,{'content-type':'text/html'});
    res.end(shell('<main id="main">Last known: Running.</main><script>fetch(\'/api/jobs/one\')</script>'));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const recorder=journeyInvariants({attach:(name,data)=>test.info().attach('negative-fixture-'+name)});recorder.register(page,'status-loss fixture');
  try {
    const response=page.waitForResponse('**/api/jobs/one');
    await page.goto('http://127.0.0.1:'+server.address().port+'/#/job/one');
    await (await response).finished();
    await expect.poll(()=>recorder.diagnostics(page)?.lastSuccessfulJobStatus?.path).toBe('/api/jobs/one');
    const exactText='Status unavailable. The job status is not available yet. Refresh the job to check its status.';
    await page.locator('#main').evaluate((main,text)=>{main.textContent=text;},exactText);
    await recorder.checkpoint(page,'known state status loss',{knownState:true});
    const result=await recorder.finish();
    const failure=result.failures.find(item=>item.id==='I43');
    expect(failure).toBeDefined();
    expect(failure.diagnostics.statusEvidenceText).toContain(exactText);
    expect(failure.diagnostics.knownState).toBe(true);
    expect(failure.diagnostics.lastSuccessfulJobStatus.path).toBe('/api/jobs/one');
    expect(failure.diagnostics.lastSuccessfulJobStatus.at).toBeLessThan(failure.diagnostics.capturedAt);
    expect(JSON.stringify(failure.diagnostics)).not.toMatch(/(?:[?&]token=|Bearer\s+\S+)/i);
  } finally {await recorder.finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('fast resource evidence survives the first sample and resets on a same-hash reload',async({page})=>{
  const server=createServer((req,res)=>{
    if(req.url==='/api/jobs/one'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');}
    else {res.writeHead(200,{'content-type':'text/html'});res.end(shell('<main role="status" aria-label="Loading job">Preparing the page…</main><script>fetch("/api/jobs/one")</script>'));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const recorder=journeyInvariants({attach:(name,data)=>test.info().attach('negative-fixture-'+name,data)});recorder.register(page,'resource fixture');
  try {
    const first=page.waitForResponse('**/api/jobs/one');
    await page.goto('http://127.0.0.1:'+server.address().port+'/#/job/one');await (await first).finished();
    await recorder.checkpoint(page,'response before first sample');
    await page.waitForTimeout(10100);
    await recorder.checkpoint(page,'available but never rendered');
    const next=page.waitForResponse('**/api/jobs/one');await page.reload();await (await next).finished();
    await recorder.checkpoint(page,'same-hash reload is a new deadline');
    const result=await recorder.finish();
    expect(result.failures.some(f=>f.id==='I31'&&f.label==='available but never rendered')).toBe(true);
    expect(result.failures.some(f=>f.id==='I31'&&f.label==='same-hash reload is a new deadline')).toBe(false);
  } finally {await recorder.finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('the recorder attributes freshness to the job that actually answered',async({page})=>{
  const server=createServer((req,res)=>{
    if(req.url.startsWith('/api/jobs/')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');}
    else {res.writeHead(200,{'content-type':'text/html'});res.end(shell('<main class="job-page">Last known: Running.</main>'));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const recorder=journeyInvariants({attach:(name,data)=>test.info().attach('negative-fixture-'+name,data)});recorder.register(page,'job identity fixture');
  try {
    await page.goto('http://127.0.0.1:'+server.address().port+'/#/job/one');
    await page.evaluate(()=>fetch('/api/jobs/other').then(r=>r.json()));
    await recorder.checkpoint(page,'unrelated job answered');
    await page.evaluate(()=>fetch('/api/jobs/one').then(r=>r.json()));
    // The finished-response event is asynchronous; the next tick observes it.
    await page.waitForTimeout(50);await recorder.checkpoint(page,'this job answered');
    const result=await recorder.finish();
    expect(result.failures.some(f=>f.id==='I06'&&f.label==='unrelated job answered')).toBe(false);
    expect(result.failures.some(f=>f.id==='I06'&&f.label==='this job answered')).toBe(true);
  } finally {await recorder.finish();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

// r8 O14: a modal sheet is a viewport overlay, not a page-column child, but only while it is a usable one: inside the
// viewport on every side, named, and every action reachable by scrolling.
const modalPage=(dialog,inner='Add as a branch')=>'<main class="job-page" style="width:358px;margin:0 16px"><header class="jh" style="height:40px">Job</header><dialog id="sheet" '+dialog+'>'+inner+'</dialog></main>';
const longBody='<div style="height:1200px">Long review</div><button id="last">Add as a branch</button>';
const modalFailures=async(page,html,{width=390,height=844}={})=>{
  await page.setViewportSize({width,height});await page.setContent(shell(html));
  await page.evaluate(()=>{const d=document.getElementById('sheet');d.matches('[data-modal]')?d.showModal():d.show();});
  return (await checkPage(page)).failures.map(f=>f.id);
};
const sheetOk='aria-label="Add as a branch" data-modal style="margin:auto 0 0;max-width:none;padding:0;width:100%"';
test('I25: a labelled modal sheet with long content is allowed, and its last action scrolls into reach',async({page})=>{
  expect(await modalFailures(page,modalPage(sheetOk,longBody))).not.toContain('I25');
  await page.locator('#last').focus();
  expect(await page.locator('#last').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
});
for(const [name,html] of Object.entries({
  'wider than the viewport':modalPage('aria-label="Sheet" data-modal style="margin:auto 0 0;max-width:none;padding:0;width:480px"'),
  'shifted off the left edge':modalPage('aria-label="Sheet" data-modal style="margin:auto 0 0 -60px;max-width:none;padding:0;width:100%"'),
  'taller than the viewport':modalPage('aria-label="Sheet" data-modal style="max-height:none;height:2000px;margin:0;max-width:none;padding:0;width:100%"'),
  'clipping an action beneath an overflow:clip wrapper':modalPage(sheetOk,'<div style="height:100px;overflow:clip"><div style="height:600px">Long review</div><button id="last">Add as a branch</button></div>'),
  'hiding an action when the dialog itself cannot scroll':modalPage('aria-label="Sheet" data-modal style="margin:auto 0 0;max-width:none;padding:0;width:100%;max-height:200px;overflow:hidden"','<button>Cancel</button>'+longBody),
  'unnamed':modalPage('data-modal style="margin:auto 0 0;max-width:none;padding:0;width:100%"'),
}))test('I25: a modal sheet '+name+' still fails the page frame',async({page})=>{
  expect(await modalFailures(page,html)).toContain('I25');
});
test('I25: an open non-modal dialog wider than the page column still fails',async({page})=>{
  expect(await modalFailures(page,modalPage('aria-label="Sheet" style="width:480px;position:static"'))).toContain('I25');
});
