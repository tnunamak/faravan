import {test,expect,connect,compose,send,authorize,liveBoth,finish,LIVE} from './two-computer-journey.mjs';

test('J3: pause preserves execution, stop waits for cessation, then the next job needs authorization',async({journey:j})=>{
  test.setTimeout(240000);
  const reload=async(page,label)=>{
    j.invariants.boundary(page,'reload','start',label);
    await page.reload();
    j.invariants.boundary(page,'reload','finish',label);
  };
  await connect(j);await compose(j);const first=await send(j);await authorize(j);await liveBoth(j,first);
  // The friend's job page shows the observed start time and the hard time limit (jobTimingLine in transcript-feed.mjs).
  await expect(j.friend.locator('.job-page')).toContainText(/Started \d{1,2}:\d{2} [AP]M \(\d+ (?:s|min) ago\)/);
  await expect(j.friend.locator('.job-page')).toContainText(/Time limit \d{1,2}:\d{2} [AP]M/);
  await expect(j.friend.locator('.job-page')).not.toContainText(/stop time not confirmed/);
  await test.step('Pause accepts no new work and leaves the held job running',async()=>{
    await j.host.goto((await j.apps.host.link())+'#/lend');
    await j.host.getByRole('button',{name:'Pause new jobs…',exact:true}).click();
    await j.host.getByRole('dialog',{name:'Pause new jobs'}).getByRole('button',{name:'For 1 hour',exact:true}).click();
    await expect(j.host.getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
    await expect(j.friend.getByText(LIVE,{exact:true})).toBeVisible();
    expect(await j.apps.host.control('state')).toMatchObject({runs:1,cancels:0,stopPending:false});
    await compose(j,'Second job must wait for authorization.');j.next=await send(j);
    await expect(j.friend.getByText('Waiting',{exact:true}).first()).toBeVisible();
    await reload(j.host,'paused lending after queueing');
    await expect(j.host.getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
    await expect(j.host.getByRole('link',{name:'Review request',exact:true})).toHaveCount(0);
    expect((await j.apps.host.control('state')).runs).toBe(1);
    // Free the execution slot while still paused: a busy slot alone would also
    // hide offers, so it cannot prove that pause refuses the queued request.
    await j.friend.goto((await j.apps.friend.link())+first);await finish(j);
    await reload(j.host,'paused lending after first job completion');
    await expect(j.host.getByRole('button',{name:'Resume now',exact:true})).toBeVisible();
    await expect(j.host.getByRole('link',{name:'Review request',exact:true})).toHaveCount(0);
    expect((await j.apps.host.control('state')).runs).toBe(1);
    await j.apps.host.control('hold');
    await j.host.getByRole('button',{name:'Resume now',exact:true}).click();
    await j.friend.goto((await j.apps.friend.link())+j.next);
    await authorize(j,'Second job must wait for authorization.');
    await expect.poll(async()=>(await j.apps.host.control('state')).runs).toBe(2);
    await liveBoth(j,j.next);
  });
  await test.step('A successful Stop request is unconfirmed until the fake computer confirms cessation',async()=>{
    await j.friend.goto((await j.apps.friend.link())+j.next);
    await j.host.goto((await j.apps.host.link())+'#/lend');
    await j.host.getByRole('button',{name:/^Stop .+ job…$/}).click();
    const dialog=j.host.getByRole('dialog',{name:'Stop this job?',exact:true});
    await expect(dialog).toContainText('We’ll ask the running computer to stop. It may take time to confirm.');
    const accepted=j.host.waitForResponse(response=>response.url().endsWith('/api/lending/stop')&&response.request().method()==='POST');
    await dialog.getByRole('button',{name:'Stop job',exact:true}).click();
    expect((await accepted).ok()).toBe(true);
    await expect.poll(async()=>(await j.apps.host.control('state')).stopPending).toBe(true);
    // The computer link lives in the desktop sidebar. A phone has no sidebar: its only "Stopping … job" link is Lending's, which opens the job.
    if(j.host.viewportSize().width>=900)await expect(j.host.getByRole('link',{name:/Stopping .+ job/}).first()).toBeVisible();
    else await expect(j.host.getByRole('link',{name:/Stopping .+ job/})).toHaveAttribute('href',/^#\/job\//);
    await expect(j.host.getByRole('heading',{level:2,name:/Stopping .+ job/})).toBeVisible();
    for(const page of [j.host,j.friend])await expect(page.getByText(/stopped this run|confirmed that the sandbox stopped|^Stopped$/)).toHaveCount(0);
    // Judge r9 O-D/O-E: a pending stop never reads as unavailable. Lending and the lender's job say Stopping; the sender's
    // job says Stop requested until the lender confirms (EXPERIENCE.md). "Stopping" on the sender's page was only the
    // Stop control's help text, which the page drops when the stop reaches it (about a second), so it was a race.
    await j.invariants.checkpoint(j.host,'stop pending on lending',{knownState:true});
    await j.invariants.checkpoint(j.friend,'stop pending on the sender job',{knownState:true});
    await expect(j.friend.locator('#main')).toContainText('Stop requested for your job',{timeout:15000});
    await expect(j.friend.locator('#main')).toContainText('It hasn’t confirmed yet.');
    await expect(j.friend.getByRole('button',{name:'Stop this job',exact:true})).toHaveCount(0);
    const hostJob=await j.host.context().newPage();
    try {
      j.invariants.boundary(hostJob,'navigation','start','open lender job during pending Stop');
      await hostJob.goto((await j.apps.host.link())+j.next);
      j.invariants.boundary(hostJob,'navigation','finish','open lender job during pending Stop');
      await expect(hostJob.locator('#main')).toContainText(/Stopping/,{timeout:15000});
      await expect(hostJob.getByRole('button',{name:'Stop this job',exact:true})).toHaveCount(0);
      await j.invariants.checkpoint(hostJob,'stop pending on the lender job',{knownState:true});
    } finally {
      if(!hostJob.isClosed()) {
        j.invariants.boundary(hostJob,'close','start','close lender job during pending Stop');
        await hostJob.close();
        j.invariants.boundary(hostJob,'close','finish','close lender job during pending Stop');
      }
    }
    expect((await j.apps.host.control('state')).cancels).toBe(0);
    await j.apps.host.control('confirm-stop');
    await expect(j.friend.getByText(/stopped this run\. Changes up to the stop weren’t kept\./)).toBeVisible({timeout:20000});
    expect((await j.apps.host.control('state')).cancels).toBe(1);
  });
  await test.step('A synthetic sign-out is visible; restart restores provider availability and keeps lending off until the owner turns it on',async()=>{
    await j.apps.host.control('sign-out');
    await j.host.goto((await j.apps.host.link())+'#/lend');
    await j.host.getByRole('button',{name:'Check again',exact:true}).click();
    // A sandbox sign-out needs two independent observations in the product.
    await j.host.getByRole('button',{name:'Check again',exact:true}).click();
    await expect(j.host.getByText('Signed out',{exact:true})).toBeVisible({timeout:15000});
    for(const page of [j.host,j.friend])j.invariants.availability(page,false);
    await j.apps.host.stop();await j.apps.host.start();
    await j.host.goto((await j.apps.host.link())+'#/circles/host');
    await j.host.getByRole('button',{name:'Start again',exact:true}).click();
    await expect(j.host.getByRole('link',{name:'Invite someone',exact:true})).toBeVisible({timeout:30000});
    for(const page of [j.host,j.friend])j.invariants.availability(page,true);
    await j.host.goto((await j.apps.host.link())+'#/lend');
    await j.host.getByRole('button',{name:'Check again',exact:true}).click();
    // Lending was turned off on purpose (the stop saved intent off), so a restart keeps it off: the owner's turn-on
    // action is offered, and no job is offered while it is off.
    await expect(j.host.getByRole('switch',{name:'Lending',exact:true})).toHaveAttribute('aria-checked','false',{timeout:30000});
    await expect(j.host.getByRole('heading',{name:'Lending is off',exact:true})).toBeVisible();
    await expect(j.host.getByRole('link',{name:'Review request',exact:true})).toHaveCount(0);
    expect((await j.apps.host.control('state')).runs).toBe(0);
    // The owner turns lending back on through the UI; only then does the intent become ready.
    const readyIntent=j.host.waitForResponse(async response=>{
      if(!/\/api\/(?:home|status)$/.test(new URL(response.url()).pathname)||!response.ok())return false;
      const status=await response.json();
      return status.intent?.state==='ready';
    },{timeout:30000});
    await j.host.getByRole('switch',{name:'Lending',exact:true}).click();
    await readyIntent;
    // Once on, the Lending page reads Ready for requests; the big switch shows only while lending is off.
    await expect(j.host.getByRole('heading',{level:2,name:'Ready for requests',exact:true})).toBeVisible({timeout:30000});
    expect((await j.apps.host.control('state')).runs).toBe(0);
  });
  await test.step('Restored lending still requires Run it for the next queued job',async()=>{
    await compose(j,'Third job must wait after a confirmed stop.');const third=await send(j);
    await j.host.goto((await j.apps.host.link())+'#/lend');
    await expect(j.host.getByRole('heading',{level:2,name:'Ready for requests',exact:true})).toBeVisible({timeout:30000});
    expect((await j.apps.host.control('state')).runs).toBe(0);
    await authorize(j,'Third job must wait after a confirmed stop.');
    await expect.poll(async()=>(await j.apps.host.control('state')).runs).toBe(1);
    await liveBoth(j,third);await finish(j);
  });
});
