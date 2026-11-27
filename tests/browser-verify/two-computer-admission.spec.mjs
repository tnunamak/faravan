import {test,expect,connect,compose,send} from './two-computer-journey.mjs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// No intercepted API responses: the offer, usage, decision and attempt all come
// from the two local apps and the hosted coordinator's durable store.
async function saveDailyMinutes(page,url,minutes) {
  await page.goto(url+'#/lend/limits');
  await page.getByRole('textbox',{name:'Minutes a day',exact:true}).fill(String(minutes));
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Saved.',{exact:true})).toBeVisible();
}

function jobAddress(hash) {
  const [,kind,digest,circle]=hash.split('/');
  expect(kind).toBe('job');
  return {jobDigest:decodeURIComponent(digest),circle:decodeURIComponent(circle)};
}

test('B: a real offer rechecks remaining minutes below and at the admission boundary',async({journey:j})=>{
  test.setTimeout(180000);
  // Accounting is seeded before the lender starts. Initial 60-minute settings
  // leave enough room to discover this genuine 20-minute offer.
  await j.apps.host.control('seed-usage',{milliseconds:20*60000,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
  await connect(j);
  await compose(j,'Exercise the real daily-minutes admission boundary.');
  const address=jobAddress(await send(j));
  await j.host.goto((await j.apps.host.link())+'#/lend');
  await j.host.getByRole('link',{name:'Review request',exact:true}).click({timeout:15000});
  const run=j.host.getByRole('button',{name:'Run it',exact:true});
  await expect(run).toBeEnabled();
  const accepted=[];
  const observe=request=>{
    if(request.method()==='POST'&&/\/api\/approvals\/[^/]+\/accept$/.test(new URL(request.url()).pathname))accepted.push(request.url());
  };
  j.host.on('request',observe);
  const settings=await j.host.context().newPage();
  try {
    const counters=JSON.parse(await readFile(join(j.apps.host.paths.FARAVAN_HOME,'v1','app-counters.json'),'utf8'));
    expect(counters.milliseconds).toBe(20*60000);
    const initial=await j.apps.host.control('job-state',address);
    expect(initial.state).toBe('queued');
    expect(initial.current_attempt).toBeNull();
    expect(initial.job.payload.requirements.limits.wall_seconds).toBe(1200);
    await test.step('10 minutes remain: the open request disables Run it and sends no accept',async()=>{
      await saveDailyMinutes(settings,await j.apps.host.link(),30);
      await expect(run).toBeDisabled();
      await j.invariants.checkpoint(j.host,'request exceeds remaining minutes',{requestDoesNotFit:true});
      await expect(j.host.getByRole('status').filter({hasText:"This request doesn't fit today's minute limit."})).toBeVisible();
      // Exercise the disabled control through the DOM; dispatch cannot bypass
      // either the disabled button or Decision's capacity guard.
      await run.dispatchEvent('click');
      expect(accepted).toEqual([]);
      expect((await j.apps.host.control('state')).runs).toBe(0);
      const queued=await j.apps.host.control('job-state',address);
      expect(queued.state).toBe('queued');expect(queued.current_attempt).toBeNull();
    });
    await test.step('19 minutes remain: a 20-minute signed request still cannot start',async()=>{
      await saveDailyMinutes(settings,await j.apps.host.link(),39);
      await expect(run).toBeDisabled();
      await run.dispatchEvent('click');
      expect(accepted).toEqual([]);
      expect((await j.apps.host.control('job-state',address)).current_attempt).toBeNull();
    });
    await test.step('21 minutes remain: a 20-minute request fits below the boundary',async()=>{
      await saveDailyMinutes(settings,await j.apps.host.link(),41);
      await expect(run).toBeEnabled();
      await j.invariants.checkpoint(j.host,'minute capacity restored',{capped:false});
      expect(accepted).toEqual([]);
      expect((await j.apps.host.control('job-state',address)).current_attempt).toBeNull();
    });
    await test.step('Exactly 20 minutes remain: one click produces one real accepted attempt',async()=>{
      await saveDailyMinutes(settings,await j.apps.host.link(),40);
      await expect(run).toBeEnabled();
      await run.click();
      await expect.poll(async()=>(await j.apps.host.control('state')).runs,{timeout:20000}).toBe(1);
      expect(accepted).toHaveLength(1);
      const started=await j.apps.host.control('job-state',address);
      expect(started.state).toBe('claimed');
      expect(started.current_attempt.state).toBe('active');
      expect(started.current_attempt.execution_started_at).toBeTruthy();
      expect(started.attempts_started).toBe(1);
      await j.apps.host.control('release');
      await expect.poll(async()=>(await j.apps.host.control('job-state',address)).state,{timeout:20000}).toBe('result-accepted');
      expect(accepted).toHaveLength(1);
    });
  } finally {
    j.host.off('request',observe);
    await settings.close();
    await test.info().attach('admission-accept-requests',{body:JSON.stringify(accepted,null,2),contentType:'application/json'});
  }
});

const dayKey=(value,zone)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
function secondsToNextMidnightQuarter(zone) {
  const now=Math.floor(Date.now()/1000),today=dayKey(now*1000,zone);
  let low=now,high=now+36*3600;
  while(high-low>1) {
    const middle=Math.floor((low+high)/2);
    if(dayKey(middle*1000,zone)===today)low=middle;else high=middle;
  }
  return high+15*60-now;
}

for(const zone of ['UTC','America/Chicago'])test('B: real signed deadlines name midnight and later dates in '+zone,async({journey:j})=>{
  test.setTimeout(180000);
  await connect(j);
  // Change only the browser's viewing zone. Server clocks remain real and the
  // deadline is configured before the normal borrower submission is signed.
  const session=await j.host.context().newCDPSession(j.host);
  await session.send('Emulation.setTimezoneOverride',{timezoneId:zone});
  try {
    const midnightSeconds=secondsToNextMidnightQuarter(zone);
    for(const [kind,seconds] of [['today',Math.min(3600,Math.floor((midnightSeconds-900)/2))],['midnight',midnightSeconds],['later',48*3600]]) {
      await j.apps.friend.control('deadline-seconds',{seconds});
      await compose(j,'Exercise the '+zone+' '+kind+' signed deadline.');
      const address=jobAddress(await send(j));
      const queued=await j.apps.host.control('job-state',address);
      const payload=queued.job.payload,expires=Date.parse(payload.expires_at),created=Date.parse(payload.created_at);
      expect(expires-created).toBe(seconds*1000);
      await j.host.goto((await j.apps.host.link())+'#/lend');
      await j.host.getByRole('link',{name:'Review request',exact:true}).click({timeout:15000});
      const clock=j.host.locator('.rq-clock');
      const time=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit'}).format(expires);
      if(kind==='today') {
        expect(dayKey(expires,zone)).toBe(dayKey(created,zone));
        await expect(clock).toHaveText('Open until '+time+' today');
      } else if(kind==='midnight') {
        expect(dayKey(expires,zone)).not.toBe(dayKey(created,zone));
        await expect(clock).toHaveText('Open until tomorrow '+time);
      } else {
        expect(expires-created).toBeGreaterThan(86400000);
        const date=new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric'}).format(expires);
        await expect(clock).toHaveText('Open until '+date+' at '+time);
      }
      const run=j.host.getByRole('button',{name:'Run it',exact:true});
      await expect(run).toBeEnabled();
      await j.invariants.checkpoint(j.host,'signed deadline '+kind,{deadlineFutureDay:kind!=='today',expiredOffer:expires<=Date.now()});
      expect((await j.apps.host.control('job-state',address)).current_attempt).toBeNull();
      if(kind!=='later') {
        await j.host.getByRole('button',{name:'Decline',exact:true}).click();
        await expect(j.host.locator('.rq-state')).toContainText('You declined this request');
        expect((await j.apps.host.control('job-state',address)).state).toBe('queued');
      } else {
        await run.click();
        await expect.poll(async()=>(await j.apps.host.control('state')).runs,{timeout:20000}).toBe(1);
        const started=await j.apps.host.control('job-state',address);
        expect(started.current_attempt.execution_started_at).toBeTruthy();
        expect(started.attempts_started).toBe(1);
        await j.apps.host.control('release');
        await expect.poll(async()=>(await j.apps.host.control('job-state',address)).state,{timeout:20000}).toBe('result-accepted');
      }
    }
  } finally {await session.detach();}
});
