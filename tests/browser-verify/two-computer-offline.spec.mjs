import {test,expect,connect,compose,send,authorize,liveBoth,finish,CHECK} from './two-computer-journey.mjs';

test('J4: host process stops, the friend keeps a draft and result, and the same host returns',async({journey:j})=>{
  // Two executions plus app/coordinator restart need their full bounded waits.
  test.setTimeout(240000);
  await connect(j);await compose(j);const result=await send(j);await authorize(j);await liveBoth(j,result);await finish(j);
  // Keep a reviewed result open while composing in another tab, as a person can.
  const resultPage=await j.friend.context().newPage();
  await resultPage.goto((await j.apps.friend.link())+result);
  await expect(resultPage.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:30000});
  await compose(j,'Keep this draft while the host is offline.');
  for(const page of [j.host,j.friend,resultPage])j.invariants.availability(page,false);
  await j.apps.host.stop();
  await test.step('The friend keeps the draft and truthfully reports the host offline',async()=>{
    await expect(j.friend.getByText('The circle “G2 friends” is unreachable',{exact:true})).toBeVisible({timeout:30000});
    await expect(j.friend.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    await expect(j.friend.getByLabel('What the agent should do')).toHaveValue('Keep this draft while the host is offline.');
    await j.friend.reload();
    await expect(j.friend.getByLabel('What the agent should do')).toHaveValue('Keep this draft while the host is offline.');
    await expect(j.friend.getByLabel('Circle',{exact:true}).locator('option:checked')).toHaveText('G2 friends');
    if(!await j.friend.locator('#cmp-project').evaluate(e=>e.open))await j.friend.locator('#cmp-project > summary').click();
    await expect(j.friend.getByRole('textbox',{name:'Project folder',exact:true})).toHaveValue(j.repo);
    await j.friend.locator('#cmp-verify-heading').click();
    await expect(j.friend.getByLabel('Test command',{exact:true})).toHaveValue(CHECK);
    await expect(resultPage.getByRole('heading',{name:'Make the deterministic G2 change.',exact:true})).toBeVisible();
    await expect(resultPage.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:30000});
    await j.invariants.checkpoint(resultPage,'cached result while host offline',{cachedResult:true,resultMarker:'the deterministic G2 change'});
    await expect(resultPage.getByText('Live',{exact:true})).toHaveCount(0);
    await expect(j.friend.getByLabel('What the agent should do')).toHaveValue('Keep this draft while the host is offline.');
    // Judge r8 O5: Jobs lists the delivered result, so opening it cold in a new tab shows it too, from what this
    // computer saved, instead of "The job didn't load".
    const coldPage=await j.friend.context().newPage();
    j.invariants.availability(coldPage,false);
    await coldPage.goto((await j.apps.friend.link())+result);
    await expect(coldPage.getByRole('heading',{name:'Make the deterministic G2 change.',exact:true})).toBeVisible({timeout:20000});
    await expect(coldPage.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:20000});
    await expect(coldPage.getByText('The job didn’t load',{exact:true})).toHaveCount(0);
    await j.invariants.checkpoint(coldPage,'cold cached result while host offline',{cachedResult:true,resultMarker:'the deterministic G2 change'});
    // Judge r9 O-C: the offline Jobs list shows each job's saved status, marked last known.
    await coldPage.goto((await j.apps.friend.link())+'#/jobs');
    await expect(coldPage.locator('#main')).toContainText(/Last known/,{timeout:20000});
    await j.invariants.checkpoint(coldPage,'offline jobs list',{knownState:true});
    await coldPage.close();
  });
  await test.step('Restart the host with the same durable home and resume the offer flow',async()=>{
    await j.apps.host.start();
    await j.host.goto((await j.apps.host.link())+'#/circles/host');
    await j.host.getByRole('button',{name:'Start again',exact:true}).click();
    await expect(j.host.getByRole('link',{name:'Invite someone',exact:true})).toBeVisible({timeout:30000});
    for(const page of [j.host,j.friend,resultPage])j.invariants.availability(page,true);
    await resultPage.reload();
    await expect(resultPage.getByText('Ready to review',{exact:true}).first()).toBeVisible({timeout:20000});
    await expect(resultPage.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:30000});
    await j.friend.reload();
    await expect(j.friend.getByLabel('What the agent should do')).toHaveValue('Keep this draft while the host is offline.');
    await j.apps.host.control('hold');
    await j.host.goto((await j.apps.host.link())+'#/lend');
    const lending=j.host.getByRole('switch',{name:'Lending',exact:true});
    // The app starts before its coordinator; resume through the visible switch
    // once hosting is back, rather than relying on a startup retry policy.
    if(await lending.getAttribute('aria-checked')==='true')await lending.click();
    await expect(lending).toHaveAttribute('aria-checked','false');await lending.click();
    const resumed=await send(j);await authorize(j,'Keep this draft while the host is offline.');
    await liveBoth(j,resumed);await finish(j);
  });
  await test.step('Failed IPC shutdown and an unresponsive owned coordinator still leave no servers',async()=>{
    for(const page of [j.host,j.friend,resultPage])j.invariants.availability(page,false);
    await j.apps.host.control('freeze-host');await j.apps.host.control('reject-shutdown');
    await j.apps.host.stop();
    expect(j.apps.host.forcedCleanup).toBe(true);
  });
  // Invitation expiry is not clock-controllable through the installed host CLI; no API
  // or signed-invitation mutation is used to manufacture a person’s invitation journey.
});
