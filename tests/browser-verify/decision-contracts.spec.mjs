import {test, expect, api, LIVE, contract} from './decision-journey.mjs';

// No expected-failure allowances remain. Pause is temporary: held offers return
// on Resume if still available. The earlier waiting-decline requirement was retired.

test.describe('Release gap 29: decisions at the real UI call sites', () => {
  test.setTimeout(180000);

  test('Not now sends zero coordinator requests and the request returns later', async ({decision:j}) => {
    test.info().annotations.push({type:'slice', description:'R29'}, {type:'check', description:'not-now'});
    const sent = await j.submit('Defer this request locally.');
    await j.enable();
    const card = await j.card(sent.jobDigest);
    await j.open('#/home');
    const problems = [];
    await j.page.getByRole('region', {name:'Needs your attention'}).getByRole('link', {name:'Review', exact:true}).click();
    await expect(j.page.getByRole('button', {name:'Run it', exact:true})).toBeEnabled();
    const reviewNotNow = j.page.getByRole('button', {name:'Not now', exact:true});
    const hasReviewNotNow = await reviewNotNow.count() === 1;
    if (!hasReviewNotNow) problems.push('Review request has no local Not now control.');
    else {
      const reviewMark = j.mark();
      await reviewNotNow.click();await j.settleAction();
      const reviewAction = j.since(reviewMark);
      expect(reviewAction.actionOutbound).toEqual([]);expect(reviewAction.writes).toEqual([]);
      expect((await api(j.lender.app, '/api/approvals')).some(row => row.jobDigest === sent.jobDigest)).toBe(true);
    }
    await j.open('#/home');
    await expect(j.page.getByRole('button', {name:'Not now', exact:true})).toBeVisible();
    const mark = j.mark();
    await j.page.getByRole('button', {name:'Not now', exact:true}).click();
    await j.settleAction();
    await expect(j.page.getByRole('status').filter({hasText:'Still pending'})).toBeVisible();
    const action = j.since(mark);
    const endpoints = rows => rows.map(row => row.method + ' ' + row.path).sort();
    expect(endpoints(action.actionCoordinator), 'The real coordinator must see every action-attributed dispatch').toEqual(endpoints(action.actionOutbound));
    // Leave and return through a full reload: a local deferral must not become
    // a durable skip, and the signed request must still be pending/unexpired.
    await j.revisitHome();
    const approvals = await api(j.lender.app, '/api/approvals');
    const returnedCard = approvals.find(row => row.jobDigest === sent.jobDigest);
    const returned = Boolean(returnedCard);
    const reviewLinks = returnedCard ? await j.page.locator('a[href="#/request/' + returnedCard.id + '"]').count() : 0;
    const job = await j.job(sent.jobDigest);
    expect(job.state).toBe('queued');expect(job.current_attempt).toBeNull();
    expect(returnedCard.expiresAt).toBeGreaterThan(Date.now()+60000);
    if (action.actionOutbound.length) problems.push('Not now sent ' + action.actionOutbound.length + ' coordinator requests.');
    if (action.writes.length) problems.push('Not now sent ' + action.writes.length + ' local mutation requests.');
    if (!returned || !reviewLinks) problems.push('Not now removed the pending request; it did not return after navigation and reload.');
    await contract(problems, [], {hasReviewNotNow, action, returned, reviewLinks, jobState:job.state});
    await j.restartLender();
    await api(j.lender.app, '/api/lending/resume', {method:'POST',body:{circle:j.circle.id}});
    const afterRestart=await j.card(sent.jobDigest);
    await j.open('#/request/'+afterRestart.id);
    await j.page.getByRole('button',{name:'Run it',exact:true}).click();
    await expect.poll(()=>j.lender.backend.calls.filter(([kind])=>kind==='run').length).toBe(1);
  });

  test('Decline excludes one request but the same borrower can send another', async ({decision:j}) => {
    test.info().annotations.push({type:'slice', description:'R29'}, {type:'check', description:'decline'});
    const sent = await j.submit('Decline this request explicitly.');
    await j.enable();
    const roster=await j.roster();
    expect(roster).toContain(j.owner.app.device.keyId);expect(roster).toContain(j.lender.app.device.keyId);
    const card = await j.card(sent.jobDigest);
    const borrowerPage=await j.page.context().newPage();
    await borrowerPage.goto(j.owner.app.url+'#/job/'+encodeURIComponent(sent.jobDigest));
    await expect(borrowerPage.getByText('A lender declined this request. Another computer can still pick it up.')).toHaveCount(0);
    await j.open('#/home');
    await j.page.getByRole('region', {name:'Needs your attention'}).getByRole('link', {name:'Review', exact:true}).click();
    await expect(j.page.getByRole('button', {name:'Run it', exact:true})).toBeEnabled();
    const decline = j.page.getByRole('button', {name:'Decline', exact:true});
    const problems = [], mark = j.mark();
    expect(sent.jobDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const isDecline = row => row.actor === 'lender' && row.method === 'POST' &&
      (row.path.endsWith('/jobs/' + sent.jobDigest.split(':')[1] + '/decline') ||
       row.path.endsWith('/release') && row.reason === JSON.stringify({code:'approval_denied'}));
    const matchingDeclines = () => j.outboundRequests.slice(mark.outbound).filter(isDecline);
    const hasDecline = await decline.count() === 1;
    if (!hasDecline) problems.push('Review request has no separate explicit Decline control.');
    else {
      await expect(j.page.getByRole('button', {name:'Not now', exact:true})).toBeVisible();
      await decline.click();await j.settleAction();
      await expect.poll(() => matchingDeclines().filter(row => row.status >= 200 && row.status < 300).length).toBe(1);
      await expect.poll(async () => (await api(j.lender.app, '/api/approvals')).some(row => row.jobDigest === sent.jobDigest)).toBe(false);
    }
    const action = j.since(mark);
    await j.revisitHome();
    const declines = matchingDeclines();
    expect(declines.every(row=>row.path.startsWith('/v1/circles/'+j.circle.id+'/'))).toBe(true);
    const returned = (await api(j.lender.app, '/api/approvals')).some(row => row.jobDigest === sent.jobDigest);
    // A missing action is reported on its own; never substitute "Not for me"
    // and claim the explicit Decline journey ran. These remain strict once it exists.
    if (hasDecline) {
      if (declines.length !== 1) problems.push('Decline sent ' + declines.length + ' coordinator declines; expected exactly one.');
      if (returned || await j.page.locator('a[href="#/request/' + card.id + '"]').count()) problems.push('Decline returned after navigation and reload.');
    }
    expect(j.lender.backend.calls.filter(([kind]) => kind === 'run')).toHaveLength(0);
    const borrowerJob=await j.job(sent.jobDigest);
    // Decline excludes only this lender; the job stays queued for other lenders.
    expect(borrowerJob.state).toBe('queued');
    if(hasDecline){
      expect(borrowerJob.declined_count).toBe(1);
      await expect.poll(async () => (await api(j.owner.app, '/api/jobs/'+encodeURIComponent(sent.jobDigest))).declined_count).toBe(1);
      await expect(borrowerPage.getByText('A lender declined this request. Another computer can still pick it up.')).toBeVisible();
      await j.open('#/request/'+card.id);
      await expect(j.page.getByText(/You declined this request/)).toBeVisible();
    }
    expect(await j.roster()).toEqual(roster);
    const later=await j.submit('A later request from the same borrower.');
    expect(later.jobDigest).not.toBe(sent.jobDigest);
    j.restartCoordinator();
    await j.restartLender();
    await api(j.lender.app, '/api/lending/resume', {method:'POST',body:{circle:j.circle.id}});
    expect((await j.job(sent.jobDigest)).declined_count).toBe(1);
    expect(await j.lenderOffers()).not.toContain(sent.jobDigest);
    expect((await api(j.lender.app, '/api/approvals')).some(row=>row.jobDigest===sent.jobDigest)).toBe(false);
    const laterCard=await j.card(later.jobDigest);
    expect(laterCard.requester).toBe(j.owner.app.device.keyId);
    expect(laterCard.job.circle).toBe(j.circle.id);
    await j.open('#/request/'+laterCard.id);
    await expect(j.page.getByRole('button',{name:'Run it',exact:true})).toBeEnabled();
    await j.page.getByRole('button',{name:'Run it',exact:true}).click();
    await expect.poll(()=>j.lender.backend.calls.filter(([kind])=>kind==='run').length).toBe(1);
    expect((await api(j.lender.app,'/api/approvals')).some(row=>row.jobDigest===sent.jobDigest)).toBe(false);
    expect(matchingDeclines()).toHaveLength(1);
    expect(await j.roster()).toEqual(roster);
    await contract(problems, [], {hasDecline, action, declineTraffic:declines, declineCount:declines.length, returned,
      downstreamAssertions:hasDecline ? 'executed' : 'blocked by missing Decline control'});
  });

  test('Pause holds waiting offers for Resume and running work keeps running', async ({decision:j}) => {
    test.info().annotations.push({type:'slice', description:'R29'}, {type:'check', description:'pause'});
    const first = await j.submit('Keep this job running through Pause.');
    const second = await j.submit('Hold this unanswered offer for Resume.', 'claude-code-subscription');
    await j.enable({secondProvider:true});
    const roster=await j.roster();
    expect(roster).toContain(j.owner.app.device.keyId);expect(roster).toContain(j.lender.app.device.keyId);
    const card = await j.card(first.jobDigest);
    await j.open('#/request/' + card.id);
    await j.page.getByRole('button', {name:'Run it', exact:true}).click();
    await expect.poll(() => j.lender.backend.calls.filter(([kind]) => kind === 'run').length).toBe(1);
    const running = await j.job(first.jobDigest);
    expect(running.current_attempt.execution_started_at).toBeTruthy();
    await j.card(second.jobDigest);
    await j.open('#/lend');
    const before = j.mark();
    await j.page.getByRole('button', {name:'Pause new jobs…', exact:true}).click();
    const dialog = j.page.getByRole('dialog', {name:'Pause new jobs', exact:true});
    await expect(dialog).toBeVisible();
    const copy = await dialog.locator('p').first().innerText();
    const beforeConfirmation = j.since(before);
    expect(beforeConfirmation.writes.filter(row => /\/lending\/(?:pause|off)$/.test(row.path))).toEqual([]);
    expect((await api(j.lender.app, '/api/lending')).enabled).toBe(true);
    expect((await api(j.lender.app, '/api/approvals')).some(row => row.jobDigest === second.jobDigest)).toBe(true);
    const problems = [];
    if (!/^Pause new jobs\./.test(copy)) problems.push('Pause confirmation does not explain that no new jobs start.');
    if (!/waiting offers are held, not declined, and return on Resume if still available/i.test(copy)) problems.push('Pause confirmation does not explain that waiting offers are held, not declined, and return on Resume if still available.');
    if (!/Running jobs continue within their saved limits\./.test(copy)) problems.push('Pause confirmation does not explain that running jobs continue.');
    const accepted = j.page.waitForResponse(response => response.url().endsWith('/api/lending/pause') && response.request().method() === 'POST');
    await dialog.getByRole('button', {name:'For 1 hour', exact:true}).click();
    expect((await accepted).ok()).toBe(true);
    await expect(j.page.getByRole('button', {name:'Resume now', exact:true})).toBeVisible();
    expect(j.browserWrites.slice(before.writes).filter(row => row.path === '/api/lending/pause')).toHaveLength(1);
    expect((await api(j.lender.app, '/api/approvals')).some(row=>row.jobDigest===second.jobDigest)).toBe(false);
    expect((await j.job(second.jobDigest)).current_attempt).toBeNull();
    const duringPause=await j.submit('Submitted during Pause.', 'claude-code-subscription');
    const held=await j.job(duringPause.jobDigest);
    expect(held.state).toBe('queued');expect(held.current_attempt).toBeNull();
    expect((await api(j.lender.app,'/api/approvals')).some(row=>row.jobDigest===duringPause.jobDigest)).toBe(false);
    expect(await j.roster()).toEqual(roster);
    const pauseDeclines=()=>j.outboundRequests.slice(before.outbound).filter(row=>row.actor==='lender'&&row.method==='POST'&&
      [second,duringPause].some(job=>row.path.endsWith('/jobs/'+job.jobDigest.split(':')[1]+'/decline')));
    expect(pauseDeclines()).toHaveLength(0);
    expect(j.lender.backend.calls.filter(([kind]) => kind === 'cancel')).toHaveLength(0);
    const after = await j.job(first.jobDigest);
    expect(after.current_attempt.attempt_id).toBe(running.current_attempt.attempt_id);
    expect(after.current_attempt.state).toBe('active');expect(after.current_attempt.compute_stopped).toBe(false);
    j.lender.execution.emitLog('Decision journey: output produced after Pause.');
    await j.open('#/job/' + encodeURIComponent(first.jobDigest) + '/' + j.circle.id);
    await expect(j.page.getByText(LIVE, {exact:true})).toBeVisible();
    await expect(j.page.getByText('Decision journey: output produced after Pause.', {exact:true})).toBeVisible();
    expect((await j.job(duringPause.jobDigest)).current_attempt).toBeNull();
    expect((await api(j.lender.app,'/api/approvals')).some(row=>row.jobDigest===duringPause.jobDigest)).toBe(false);
    const afterConfirmation=j.since(before);
    await j.open('#/lend');
    const resumed=j.page.waitForResponse(response=>response.url().endsWith('/api/lending/resume')&&response.request().method()==='POST');
    await j.page.getByRole('button',{name:'Resume now',exact:true}).click();
    expect((await resumed).ok()).toBe(true);
    const returned=await j.card(second.jobDigest);
    const returnedDuringPause=await j.card(duringPause.jobDigest);
    expect(await j.roster()).toEqual(roster);
    expect(returned.expiresAt).toBeGreaterThan(Date.now()+60000);
    expect(returnedDuringPause.expiresAt).toBeGreaterThan(Date.now()+60000);
    expect((await j.job(second.jobDigest)).current_attempt).toBeNull();
    expect(pauseDeclines()).toHaveLength(0);
    expect((await j.job(first.jobDigest)).current_attempt.attempt_id).toBe(running.current_attempt.attempt_id);
    expect(j.lender.backend.calls.filter(([kind])=>kind==='run')).toHaveLength(1);
    expect(j.lender.backend.calls.filter(([kind])=>kind==='cancel')).toHaveLength(0);
    await contract(problems, [], {copy, beforeConfirmation, afterConfirmation,
      runningAttemptUnchanged:true, cancels:0, outputAfterPause:true, waitingOfferReturned:true, pauseDeclines:0});
  });

  test('Pause survives a lender restart and held offers return on Resume', async ({decision:j}) => {
    test.info().annotations.push({type:'slice',description:'R29'},{type:'check',description:'pause-restart'});
    const waiting=await j.submit('Waiting before Pause.');
    await j.enable();
    const roster=await j.roster();
    const waitingCard=await j.card(waiting.jobDigest);
    expect(waitingCard.job.circle).toBe(j.circle.id);
    await j.open('#/lend');
    await j.page.getByRole('button',{name:'Pause new jobs…',exact:true}).click();
    const dialog=j.page.getByRole('dialog',{name:'Pause new jobs',exact:true});
    await dialog.getByRole('button',{name:'For 1 hour',exact:true}).click();
    await expect(j.page.getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
    const during=await j.submit('Waiting during Pause.');
    const before=await api(j.lender.app,'/api/lending');
    expect(before.paused).toBe(true);expect(before.enabled).toBe(false);
    expect(before.pause_until).toBeGreaterThan(Date.now());
    await j.restartLender();
    const after=await api(j.lender.app,'/api/lending');
    expect(after.paused).toBe(true);expect(after.enabled).toBe(false);
    expect(after.pause_until).toBe(before.pause_until);
    const approvals=await api(j.lender.app,'/api/approvals');
    expect(approvals.some(row=>[waiting.jobDigest,during.jobDigest].includes(row.jobDigest))).toBe(false);
    for(const sent of [waiting,during]) {
      const job=await j.job(sent.jobDigest);
      expect(job.job.payload.circle).toBe(j.circle.id);
      expect(job.state).toBe('queued');expect(job.current_attempt).toBeNull();
      expect(job.declined_count).toBe(0);
    }
    expect(await j.roster()).toEqual(roster);
    await j.open('#/lend');
    const resumed=j.page.waitForResponse(response=>response.url().endsWith('/api/lending/resume')&&response.request().method()==='POST');
    await j.page.getByRole('button',{name:'Resume now',exact:true}).click();
    expect((await resumed).ok()).toBe(true);
    const returned=await j.card(waiting.jobDigest);
    const later=await j.card(during.jobDigest);
    expect(returned.job.circle).toBe(j.circle.id);expect(later.job.circle).toBe(j.circle.id);
    expect(returned.expiresAt).toBeGreaterThan(Date.now()+60000);
    expect(later.expiresAt).toBeGreaterThan(Date.now()+60000);
    expect(await j.roster()).toEqual(roster);
    await contract([],[],{pausedAfterRestart:after.paused,pauseUntilPreserved:after.pause_until===before.pause_until,
      heldOffersReturned:true,declineCount:0});
  });
});
