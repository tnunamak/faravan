import {test,expect,connect,compose,send,authorize,liveBoth,finish,snapshot,CHANGE,PHONE_USER_AGENT} from './two-computer-journey.mjs';
import {checkMutationConfirmation} from './invariants-journey.mjs';

test('J1: invitation to reviewed branch preserves the borrower’s original work',async({journey:j})=>{
  test.setTimeout(240000);
  await connect(j);
  const before=await snapshot(j);
  await compose(j);
  const hash=await send(j);
  expect((await j.apps.host.control('state')).runs,'Nothing executes before Run it').toBe(0);
  await authorize(j,undefined,{holdPreparation:true});
  await expect(j.host.locator('.rq-decide')).toContainText('Started on your computer');
  await expect(j.host.locator('a.machine')).toContainText(/Running .*job/,{timeout:15000});
  await expect(j.host.locator('a.machine')).not.toContainText('Starting a job');
  // O1/O2 assertions require the cycle2-r6-data/transcript integration fixes.
  await liveBoth(j,hash);
  const reads=new Map(),aborted=[],completed=new Map(),failedReads=[],pending=new Map(),maxConcurrent=new Map();
  const listeners=[],evidence=[];
  const documents=await Promise.all([j.host,j.friend].map(page=>page.evaluate(()=>globalThis.__g2Document=crypto.randomUUID())));
  for(const page of [j.host,j.friend]) {
    const request=req=>{
      const path=new URL(req.url()).pathname;
      if(req.method()!=='GET'||!path.startsWith('/api/')||path.endsWith('/events'))return;
      const key=new URL(page.url()).origin+path;reads.set(key,(reads.get(key)??0)+1);pending.set(req,key);
      maxConcurrent.set(key,Math.max(maxConcurrent.get(key)??0,[...pending.values()].filter(value=>value===key).length));
    };
    const failure=req=>{if(pending.has(req)){aborted.push(req.url()+': '+req.failure()?.errorText);pending.delete(req);}};
    const finished=async req=>{
      if(!pending.has(req))return;pending.delete(req);
      const response=await req.response();
      if(!response?.ok())failedReads.push(req.url()+': '+response?.status());
      else if(new URL(req.url()).pathname.endsWith('/transcript'))completed.set(page,(completed.get(page)??0)+1);
    };
    page.on('request',request);page.on('requestfailed',failure);page.on('requestfinished',finished);
    listeners.push(()=>{page.off('request',request);page.off('requestfailed',failure);page.off('requestfinished',finished);});
  }
  try {
    const schedule=await j.apps.host.control('stream-records');
    for(let index=1;index<=6;index++) {
      let record;
      await expect.poll(async()=>{
        record=(await j.apps.host.control('stream-state')).emitted.find(row=>row.index===index);return !!record;
      },{timeout:15000,intervals:[50,100]}).toBe(true);
      await Promise.all([j.host,j.friend].map(async(page,actor)=>{
        await expect(page.getByText(record.marker,{exact:true})).toBeVisible({timeout:Math.max(1,5000-(Date.now()-record.at))});
        evidence.push({actor,index,emittedAt:record.at,plannedAt:record.plannedAt,visibleAt:Date.now()});
        expect(Date.now()-record.at,'Live marker delivery on '+actor).toBeLessThanOrEqual(5000);
        await j.invariants.checkpoint(page,'stream marker '+index,{liveMarker:record.marker,liveLatencyMs:evidence.at(-1).visibleAt-record.at});
        expect(await page.evaluate(()=>globalThis.__g2Document)).toBe(documents[actor]);
        await expect(page.getByText('src/parser.js',{exact:true}).first()).toBeVisible();
        await expect(page.locator('main')).not.toContainText('[private details withheld]');
        await expect(page.locator('main')).not.toContainText(/unreachable|couldn’t load|couldn't load/);
      }));
    }
    const state=await j.apps.host.control('stream-state');
    expect(Date.now()-schedule.startedAt,'Execution remains held for at least 60 seconds').toBeGreaterThanOrEqual(60000);
    expect(state.streamEvents,'Record real stream events separately from read traffic').toBeGreaterThan(0);
    for(const page of [j.host,j.friend])await expect(page.locator('main')).not.toContainText(state.workspace);
    expect(aborted).toEqual([]);expect(failedReads).toEqual([]);
    for(const [path,count] of reads)expect(count,path).toBeLessThanOrEqual(path.endsWith('/transcript')?68:14);
    for(const [path,count] of maxConcurrent)expect(count,'Concurrent reads: '+path).toBeLessThanOrEqual(1);
    for(const page of [j.host,j.friend])expect(completed.get(page)??0).toBeGreaterThanOrEqual(3);
    evidence.push({streamEvents:state.streamEvents,heldMs:Date.now()-schedule.startedAt});
  } finally {
    // The observation ends before explicit execution release/navigation; removing
    // conditional running resources may cancel their outstanding reads at that point.
    for(const stop of listeners)stop();
    for(const actor of [j.apps.host,j.apps.friend])evidence.push({actor:actor.name,transport:(await actor.control('stream-state')).relayRequests});
    await test.info().attach('job-read-evidence',{body:JSON.stringify({reads:[...reads],aborted,failedReads,maxConcurrent:[...maxConcurrent],evidence},null,2),contentType:'application/json'});
  }
  await finish(j);
  await test.step('Own and other attribution survives Home, Jobs and detail reloads',async()=>{
    for(const [page,actor,own] of [[j.friend,j.apps.friend,true],[j.host,j.apps.host,false]]){
      await page.goto((await actor.link())+'#/home');
      await expect(page.getByRole('region',{name:'New job',exact:true})).toBeVisible();
      await page.reload();
      if(own){
        await expect(page.getByRole('heading',{name:'Make the deterministic G2 change.',exact:true})).toBeVisible({timeout:30000});
        await expect(page.getByText('Your result is back. Review the changes before you use them.',{exact:true})).toBeVisible();
      } else await expect(page.getByText('Sent back',{exact:true}).first()).toBeVisible({timeout:30000});
      await page.goto((await actor.link())+'#/jobs');
      await expect(page.locator('.jlist a.row')).toHaveCount(1);
      await page.reload();
      const ownFilter=page.getByRole('button',{name:/^Sent by me /}),otherFilter=page.getByRole('button',{name:/^Ran for others /});
      await (own?ownFilter:otherFilter).click();
      await expect(page.locator('.jlist a.row')).toHaveCount(1,{timeout:5000});
      await expect(page.locator('.jlist a.row')).toContainText(own?'Ready to review':'Sent back');
      await (own?otherFilter:ownFilter).click();
      await expect(page.locator('.jlist a.row')).toHaveCount(0);
      await page.goto((await actor.link())+hash);
      await expect(page.getByRole('heading',{name:own?'What changed for you':'Result delivered',exact:true})).toBeVisible();
      await page.reload();
      if(own)await expect(page.getByRole('button',{name:'Add as a branch…',exact:true})).toBeVisible({timeout:30000});
      else {
        await expect(page.getByRole('heading',{name:'Result delivered',exact:true})).toBeVisible({timeout:30000});
        await expect(page.getByRole('button',{name:'Add as a branch…',exact:true})).toHaveCount(0);
        await expect(page.getByText(/^Morgan Chen can review the returned changes\.$/)).toBeVisible();
      }
    }
  });
  await test.step('Review the exact diff and add a new branch through the UI',async()=>{
    await expect(j.friend.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:30000});
    await expect(j.friend.getByText('answer.txt',{exact:true}).first()).toBeVisible();
    await j.friend.getByRole('button',{name:'Add as a branch…',exact:true}).click();
    const dialog=j.friend.getByRole('dialog',{name:'Add as a branch',exact:true});
    const repo = dialog.getByRole('textbox',{name:'Repository folder',exact:true});
    if (await repo.inputValue()!==j.repo) {
      await repo.fill(j.repo);
      await dialog.getByRole('button',{name:'Check the repository',exact:true}).click();
    }
    await expect(dialog.getByText('answer.txt',{exact:true})).toBeVisible();
    j.resultBranch=await dialog.getByLabel('Branch name',{exact:true}).inputValue();
    expect(j.resultBranch).toBeTruthy();
    expect((await j.git('branch','--list',j.resultBranch)).toString()).toBe('');
    const applied=j.friend.waitForResponse(response=>response.request().method()==='POST'&&
      new URL(response.url()).pathname.endsWith('/apply')&&response.request().postDataJSON().dry_run===false);
    await dialog.getByRole('button',{name:'Add the branch',exact:true}).click();
    const appliedResponse=await applied;expect(appliedResponse.ok()).toBe(true);await appliedResponse.finished();
    const appliedAt=Date.now();
    await checkMutationConfirmation(j.invariants,j.friend,appliedAt,'Added as a branch');
    await expect(dialog).toHaveCount(0);
    await expect(j.friend.getByText('Added as a branch',{exact:true}).first()).toBeVisible({timeout:30000});
  });
  await test.step('Original HEAD, branch, raw index, staged/unstaged work and sentinel are untouched',async()=>{
    expect(await snapshot(j)).toEqual(before);
    const base=before.head.toString().trim(),ref='refs/heads/'+j.resultBranch;
    expect((await j.git('rev-parse',ref+'^')).toString().trim()).toBe(base);
    expect(await j.git('show',ref+':answer.txt')).toEqual(Buffer.from(CHANGE));
    expect((await j.git('diff','--name-only',base,ref)).toString()).toBe('answer.txt\n');
    expect((await j.git('rev-list','--count',base+'..'+ref)).toString().trim()).toBe('1');
    const [, , encodedDigest, encodedCircle]=hash.slice(1).split('/');
    const jobDigest=decodeURIComponent(encodedDigest);
    const job=await j.apps.friend.control('job-state',{jobDigest,circle:decodeURIComponent(encodedCircle)});
    expect(job.state).toBe('result-accepted');
    expect(job.result_digest).toBeTruthy();
    expect(job.current_attempt?.attempt_id).toBeTruthy();
    await test.info().attach('result-and-apply',{contentType:'application/json',body:JSON.stringify({
      jobDigest, resultDigest:job.result_digest,
      attemptId:job.current_attempt.attempt_id, appliedBranch:j.resultBranch, base,
      resultCommit:(await j.git('rev-parse',ref)).toString().trim(),
      changedFiles:['answer.txt'], originalUnchanged:true,
      lender:j.apps.host.runtime, borrower:j.apps.friend.runtime,
    },null,2)});
    if (process.env.FARAVAN_TEST_INSTALLED_FRIEND) {
      await test.info().attach('installed-applied-branch',{contentType:'image/png',body:await j.friend.screenshot()});
    }
  });
  await test.step('Own result survives missing presentation metadata and delayed roster',async()=>{
    const [, , encodedDigest]=hash.slice(1).split('/');
    expect(await j.apps.friend.control('hide-job-metadata',{jobDigest:decodeURIComponent(encodedDigest)})).toEqual({removed:true});
    await j.apps.friend.control('hold-read',{section:'devices'});
    const viewport=test.info().project.use.viewport??{width:1280,height:900};
    const phone=viewport.width<=390;
    const context=await j.friend.context().browser().newContext({viewport,isMobile:phone,hasTouch:phone,...(phone?{userAgent:PHONE_USER_AGENT}:{})});
    context.on('page',page=>j.invariants.register(page,'friend cold result',{people:[{device:'G2 host computer',person:'Alex Rivera'},{device:'G2 friend computer',person:'Morgan Chen'}],selfDevice:'G2 friend computer'}));
    const page=await context.newPage(),initialReads=new Map(),initialResponses=[],initialFailures=[];
    let navigationStartedAt;
    let devicesCompleted=false;
    const observeDevices=response=>{if(new URL(response.url()).pathname==='/api/devices')devicesCompleted=true;};
    page.on('response',observeDevices);
    const countInitial=request=>{
      const path=new URL(request.url()).pathname;
      if(request.method()==='GET'&&path.startsWith('/api/')&&path!=='/api/events')initialReads.set(path,(initialReads.get(path)??0)+1);
    };
    const recordInitialResponse=response=>{
      const path=new URL(response.url()).pathname;
      if(response.request().method()==='GET'&&path.startsWith('/api/')&&path!=='/api/events')initialResponses.push({path,status:response.status(),elapsedMs:Date.now()-navigationStartedAt});
    };
    const recordInitialFailure=request=>{
      const path=new URL(request.url()).pathname;
      if(request.method()==='GET'&&path.startsWith('/api/')&&path!=='/api/events')initialFailures.push({path,errorText:request.failure()?.errorText??null,elapsedMs:Date.now()-navigationStartedAt});
    };
    page.on('request',countInitial);
    page.on('response',recordInitialResponse);
    page.on('requestfailed',recordInitialFailure);
    try {
      const identityRead=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/devices');
      const detailRead=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs/'+encodedDigest&&response.status()===200);
      navigationStartedAt=Date.now();
      await page.goto((await j.apps.friend.link())+hash);await identityRead;
      const actual=await(await detailRead).json();
      expect(actual.local).toBeUndefined();expect(actual.borrowerCircle).toBeTruthy();
      await expect(page.getByText('Ready to review',{exact:true}).first()).toBeVisible({timeout:30000});
      await expect(page.getByRole('heading',{name:'What changed for you',exact:true})).toBeVisible();
      await expect(page.getByRole('heading',{name:'Result delivered',exact:true})).toHaveCount(0);
      expect(devicesCompleted,'Own result renders while the real devices response is still held').toBe(false);
      await j.apps.friend.control('release-read',{section:'devices'});
      await expect.poll(()=>devicesCompleted).toBe(true);
      await expect(page.getByRole('heading',{name:'What changed for you',exact:true})).toBeVisible();
      page.off('request',countInitial);page.off('response',recordInitialResponse);page.off('requestfailed',recordInitialFailure);
      for(const [path,count] of initialReads)expect(count,'Initial reads: '+path).toBeLessThanOrEqual(2);
      await expect(page.getByRole('heading',{name:'Result delivered',exact:true})).toHaveCount(0);
      await page.goto((await j.apps.friend.link())+'#/jobs');await page.reload();
      await page.getByRole('button',{name:/^Sent by me /}).click();
      await expect(page.locator('.jlist a.row')).toHaveCount(1,{timeout:5000});
      await page.getByRole('button',{name:/^Ran for others /}).click();
      await expect(page.locator('.jlist a.row')).toHaveCount(0);
      await page.goto((await j.apps.friend.link())+'#/home');await page.reload();
      await expect(page.getByText('Your result is back. Review the changes before you use them.',{exact:true})).toBeVisible();
    } finally {
      page.off('request',countInitial);page.off('response',observeDevices);page.off('response',recordInitialResponse);page.off('requestfailed',recordInitialFailure);
      try {
        const bodySnapshot=await page.locator('body').innerText({timeout:1000}).catch(error=>'Unable to read new-page body: '+error.message);
        await test.info().attach('initial-read-evidence',{body:JSON.stringify({reads:[...initialReads],responses:initialResponses,requestFailures:initialFailures},null,2),contentType:'application/json'});
        await test.info().attach('new-page-body-snapshot',{body:bodySnapshot,contentType:'text/plain'});
      } finally {
        await j.apps.friend.control('release-read',{section:'devices'});
        await context.close();
      }
    }
  });
});
