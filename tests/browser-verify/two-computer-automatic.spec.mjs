import {test,expect,connect,compose,send,finish} from './two-computer-journey.mjs';
test.use({automaticEvidence:true});

// Real app APIs, authenticated by the fixture's one-time browser handoff.
// No route interception, provider call, real sandbox, or external network.
async function api(page,path,body) {
  return page.evaluate(async({path,body})=>{
    const response=await fetch('/api/'+path,{credentials:'same-origin',
      ...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    if(!response.ok)throw new Error(path+': '+response.status+' '+await response.text());
    return response.json();
  },{path,body});
}
const enc=encodeURIComponent;
function address(hash) {
  const [,kind,digest,circle]=hash.split('/');
  expect(kind).toBe('job');
  return {jobDigest:decodeURIComponent(digest),circle:decodeURIComponent(circle)};
}

// The mode API is the supported explicit circle choice. Assert durable readback
// so a default Automatic label or a different circle cannot pass.
async function chooseMode(j,circle,mode) {
  await j.host.goto((await j.apps.host.link())+'#/lend/limits');
  await api(j.host,'lending/mode',{circle,mode});
  await expect.poll(async()=>{
    const saved=await api(j.host,'lending');
    return {circle:saved.circle,mode:saved.mode};
  }).toEqual({circle,mode});
  await j.host.reload();
  expect(await api(j.host,'lending')).toMatchObject({circle,mode});
}

async function configureBeforeInvite(j) {
  const circle=(await api(j.host,'circles')).find(row=>row.name==='G2 friends');
  expect(circle?.id).toBeTruthy();
  j.automaticCircle=circle;
  const borrower=(await api(j.friend,'devices')).fingerprint;
  const before=(await api(j.host,'devices')).circles.find(row=>row.circle===circle.id);
  expect(before.rosterHeld).toBe(true);
  expect(before.members.map(row=>row.key_id)).not.toContain(borrower);
  expect(await api(j.friend,'jobs')).toEqual([]);

  await j.host.goto((await j.apps.host.link())+'#/lend');
  const lending=await api(j.host,'lending');
  if(lending.enabled)await api(j.host,'lending/off',{});
  await j.host.reload();
  await j.host.getByRole('radiogroup',{name:'Choose a circle',exact:true})
    .getByRole('radio',{name:/G2 friends/}).check();
  const codex=j.host.getByRole('switch',{name:'Lend with Codex',exact:true});
  if(await codex.getAttribute('aria-checked')!=='true')await codex.click();
  await expect(codex).toHaveAttribute('aria-checked','true');

  await j.host.goto((await j.apps.host.link())+'#/lend/limits');
  await j.host.getByText('Account plan and consent',{exact:true}).click();
  const consent=j.host.getByRole('switch',{name:'Let rules run friends’ jobs on Codex automatically',exact:true});
  if(await consent.getAttribute('aria-checked')!=='true')await consent.click();
  await j.host.getByRole('button',{name:'Save',exact:true}).click();
  await expect(j.host.getByRole('status').filter({hasText:'Saved.'})).toBeVisible();
  await j.host.getByRole('spinbutton',{name:'Most one friend’s job may spend',exact:true}).fill('10');
  await j.host.getByRole('button',{name:'Save limit',exact:true}).click();
  await j.host.getByRole('button',{name:'Save the limit',exact:true}).click();
  await expect(j.host.getByRole('status').filter({hasText:'Saved.'})).toBeVisible();
  const settings=await api(j.host,'lending');
  await api(j.host,'lending/limits',{idleOnly:false,lendingPolicy:{...settings.limits.lendingPolicy,strategy:'fixed_share',strategyParams:{fixedSharePct:20,keepPct:30}}});
  await j.host.goto((await j.apps.host.link())+'#/lend');
  const on=j.host.getByRole('switch',{name:'Lending',exact:true});
  if(await on.getAttribute('aria-checked')!=='true')await on.click();
  await expect(on).toHaveAttribute('aria-checked','true');
  // With one circle, the radio can already be selected before its ID is saved.
  // The UI turn-on commits that choice; wait for its durable response.
  await expect.poll(async()=>{
    const saved=await api(j.host,'lending');return {circle:saved.circle,enabled:saved.enabled};
  }).toEqual({circle:circle.id,enabled:true});
  // Force a real change before Automatic; the new-circle default alone is not proof.
  await chooseMode(j,circle.id,'ask');
  await chooseMode(j,circle.id,'auto');
  expect(await api(j.host,'lending')).toMatchObject({circle:circle.id,mode:'auto',enabled:true});
}

async function coveredBorrower(j) {
  const circle=j.automaticCircle.id,borrower=(await api(j.friend,'devices')).fingerprint;
  await expect.poll(async()=>{
    const roster=(await api(j.host,'devices')).circles.find(row=>row.circle===circle);
    return roster?.members.some(row=>row.key_id===borrower);
  }).toBe(true);
  // Do not save mode/rules again here: doing so masks the first-borrower bug.
  let saved;
  try {
    await expect.poll(async()=>{
      saved=await api(j.host,'lending');
      return saved.standingRules.some(rule=>rule.circle===circle&&rule.people.includes(borrower)
        &&rule.agents.includes('codex')&&rule.expiresAt>Date.now());
    },{message:'The saved Automatic rule must cover the newly approved borrower before any submission'}).toBe(true);
    expect(saved).toMatchObject({circle,mode:'auto',enabled:true});
    return {borrower,rules:saved.standingRules};
  } finally {
    await test.info().attach('automatic-rule-before-send',{body:JSON.stringify({circle,borrower,saved},null,2),contentType:'application/json'});
  }
}

async function observeLender(j) {
  const page=await j.host.context().newPage();
  await page.goto((await j.apps.host.link())+'#/home');
  await expect(page.locator('.home-page')).toBeVisible();
  await page.evaluate(async()=>{
    const state=globalThis.__automaticEvidence={events:[],cards:[],errors:[],connected:false,controller:new AbortController()};
    const selector='article.home-request, a[href^="#/request/"]';
    const inspect=node=>{
      if(node.nodeType!==Node.ELEMENT_NODE)return;
      if(node.matches(selector))state.cards.push(node.outerHTML);
      for(const card of node.querySelectorAll(selector))state.cards.push(card.outerHTML);
    };
    inspect(document.body);
    state.observer=new MutationObserver(records=>{
      // Inspect added nodes too: a transient card added and removed in the same
      // turn must not disappear from the evidence before the callback runs.
      for(const record of records)for(const node of record.addedNodes)inspect(node);
    });
    state.observer.observe(document.body,{childList:true,subtree:true});
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('No /api/events connected handshake')),15000);
      const pump=async()=>{
        const response=await fetch('/api/events?after=0',{credentials:'same-origin',headers:{Accept:'text/event-stream'},signal:state.controller.signal});
        if(!response.ok)throw new Error('events: '+response.status);
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        for(;;){
          const {value,done}=await reader.read();
          if(done)throw new Error('Lender event stream closed before observation ended');
          buffer+=decoder.decode(value,{stream:true});
          for(let end;(end=buffer.indexOf('\n\n'))>=0;){
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(frame.split('\n').some(line=>line.trim()===': connected')){
              state.connected=true;clearTimeout(timeout);resolve();
            }
            const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
            if(data)state.events.push(JSON.parse(data));
          }
        }
      };
      void pump().catch(error=>{
        if(state.controller.signal.aborted)return;
        state.errors.push(error.message);clearTimeout(timeout);reject(error);
      });
    });
  });
  return {
    page,
    read:()=>page.evaluate(()=>{
      const {events,cards,errors,connected}=globalThis.__automaticEvidence;
      return {events,cards,errors,connected};
    }),
    close:async()=>{
      await page.evaluate(()=>{globalThis.__automaticEvidence.observer.disconnect();globalThis.__automaticEvidence.controller.abort();});
      await page.close();
    },
  };
}
const requestsFor=(events,digest)=>events.filter(event=>event.type==='approval'&&event.data?.jobDigest===digest&&event.data.job);
const reviewsFor=(events,digest)=>events.filter(event=>event.type==='lending'&&event.data?.jobDigest===digest&&['offer','awaiting-approval'].includes(event.data.status));

function watchMutations(j) {
  const sends=[],accepts=[];
  const borrowerRequest=request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/jobs')sends.push(request.postDataJSON());
  };
  const lenderRequest=request=>{
    if(request.method()==='POST'&&/\/api\/approvals\/[^/]+\/accept$/.test(new URL(request.url()).pathname))accepts.push(request.url());
  };
  j.friend.context().on('request',borrowerRequest);
  j.host.context().on('request',lenderRequest);
  return {sends,accepts,stop:()=>{
    j.friend.context().off('request',borrowerRequest);
    j.host.context().off('request',lenderRequest);
  }};
}

test('Automatic: an explicitly configured circle runs its first newly approved borrower once without review',async({journey:j})=>{
  test.setTimeout(240000);
  await connect(j,{beforeInvite:configureBeforeInvite});
  const coverage=await coveredBorrower(j);
  expect(await api(j.friend,'jobs?circle='+enc(j.automaticCircle.id))).toEqual([]);
  expect((await j.apps.host.control('state')).runs).toBe(0);
  const observation=await observeLender(j),mutations=watchMutations(j);
  let job,completed;
  try {
    await compose(j);
    job=address(await send(j)); // Exactly one Send; never call authorize().
    expect(job.circle).toBe(j.automaticCircle.id);
    try { await expect.poll(async()=>(await j.apps.host.control('state')).runs,{timeout:30000}).toBe(1); }
    catch(error) {throw new Error(error.message+'\nLending: '+JSON.stringify(await api(j.host,'lending'))+'\nApprovals: '+JSON.stringify(await api(j.host,'approvals'))+'\nAdmission: '+JSON.stringify(await j.apps.host.control('admission')));}
    const running=await j.apps.host.control('job-state',job);
    expect(running.state).toBe('claimed');
    expect(running.attempts_started).toBe(1);
    expect(running.current_attempt.execution_started_at).toBeTruthy();
    await finish(j);
    await expect.poll(async()=>{
      completed=await j.apps.host.control('job-state',job);return completed.state;
    }).toBe('result-accepted');
    expect(completed.attempts_started).toBe(1);
    // Acceptance is a lifecycle event even for a standing-rule run. Its arrival
    // positively proves this observer saw the ordered stream, not just silence.
    await expect.poll(async()=>(await observation.read()).events.some(event=>
      event.type==='approval'&&event.data?.jobDigest===job.jobDigest&&event.data.state==='accepted')).toBe(true);
    expect(completed.current_attempt.attempt_id).toBe(running.current_attempt.attempt_id);
    const jobs=await api(j.friend,'jobs?circle='+enc(job.circle));
    expect(jobs.map(row=>row.job_digest)).toEqual([job.jobDigest]);
    expect((await j.apps.host.control('state')).runs).toBe(1);
    expect(mutations.sends).toHaveLength(1);
    expect(mutations.accepts).toEqual([]);
    expect(await api(j.host,'approvals')).toEqual([]);
    // Fence the end of observation with a new off event after the result. All
    // earlier review/approval frames must precede it on this same connection.
    const offAt=Date.now();
    await api(j.host,'lending/off',{});
    await expect.poll(async()=>(await observation.read()).events.some(event=>
      event.type==='lending-action'&&event.data?.action==='off'&&Date.parse(event.at)>=offAt)).toBe(true);
    const evidence=await observation.read();
    expect(evidence.connected).toBe(true);
    expect(evidence.errors).toEqual([]);
    expect(requestsFor(evidence.events,job.jobDigest)).toEqual([]);
    expect(reviewsFor(evidence.events,job.jobDigest)).toEqual([]);
    expect(evidence.cards).toEqual([]);
    await expect(observation.page.locator('article.home-request, a[href^="#/request/"]')).toHaveCount(0);
  } finally {
    mutations.stop();
    await test.info().attach('automatic-first-borrower',{body:JSON.stringify({coverage,job,completed,
      sends:mutations.sends,manualAccepts:mutations.accepts,...await observation.read()},null,2),contentType:'application/json'});
    await observation.close();
  }
});

test('Automatic is circle-scoped: an approved borrower in a different Ask circle waits for review',async({journey:j})=>{
  test.setTimeout(240000);
  await connect(j,{beforeInvite:configureBeforeInvite});
  // This control is independent of the first-borrower regression. Explicitly
  // refresh this circle's rule after admission, then prove it cannot leak.
  await chooseMode(j,j.automaticCircle.id,'ask');
  await chooseMode(j,j.automaticCircle.id,'auto');
  const coverage=await coveredBorrower(j);
  await api(j.host,'lending/off',{});
  const other=await api(j.host,'circles',{name:'G2 Ask control',origin:j.automaticCircle.origin});
  expect(other.id).not.toBe(j.automaticCircle.id);
  await api(j.host,'circles/'+enc(other.id)+'/approval-mode',{approveEach:true});
  const invitation=await api(j.host,'circles/'+enc(other.id)+'/invite',{preset:'person'});
  await api(j.friend,'circles/join',{link:invitation.invite,acknowledgedWarning:true});
  await api(j.host,'circles/'+enc(other.id)+'/approve',{});
  await api(j.friend,'circles/'+enc(other.id)+'/check',{});
  const roster=(await api(j.host,'devices')).circles.find(row=>row.circle===other.id);
  expect(roster.members.map(row=>row.key_id)).toContain(coverage.borrower);
  await api(j.host,'lending/circle',{circle:other.id});
  await chooseMode(j,other.id,'ask');
  await api(j.host,'lending/on',{circle:other.id});
  const saved=await api(j.host,'lending');
  expect(saved).toMatchObject({circle:other.id,mode:'ask',enabled:true});
  expect(saved.standingRules.some(rule=>rule.circle===other.id)).toBe(false);
  expect(saved.standingRules.some(rule=>rule.circle===j.automaticCircle.id&&rule.people.includes(coverage.borrower))).toBe(true);
  const observation=await observeLender(j),mutations=watchMutations(j);
  let job;
  try {
    await compose(j,'Ask-circle control must not run automatically.');
    await j.friend.getByLabel('Circle',{exact:true}).selectOption({label:'G2 Ask control'});
    job=address(await send(j));
    expect(job.circle).toBe(other.id);
    await expect.poll(async()=>requestsFor((await observation.read()).events,job.jobDigest).length).toBeGreaterThan(0);
    await expect(observation.page.locator('article.home-request')).toHaveCount(1);
    // A positive request/card proves discovery completed. Then hold the pending
    // decision through multiple polls, instead of passing on immediate zero runs.
    const until=Date.now()+3000;
    do {
      const state=await j.apps.host.control('job-state',job);
      expect(state.state).toBe('queued');
      expect(state.current_attempt).toBeNull();
      expect(state.attempts_started).toBe(0);
      expect((await j.apps.host.control('state')).runs).toBe(0);
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<until);
    expect(mutations.sends).toHaveLength(1);
    expect(mutations.accepts).toEqual([]);
    expect((await observation.read()).errors).toEqual([]);
  } finally {
    mutations.stop();
    await test.info().attach('automatic-ask-circle-control',{body:JSON.stringify({coverage,job,
      sends:mutations.sends,manualAccepts:mutations.accepts,...await observation.read()},null,2),contentType:'application/json'});
    await observation.close();
  }
});
