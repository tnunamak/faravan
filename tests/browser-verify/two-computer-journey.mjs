import {test as base,expect as browserExpect,devices} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {twoFreshInstalls} from '../helpers/v1-app-fixture.mjs';
import {journeyInvariants} from './invariants-journey.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';

// Process startup and signed mutations use a bounded real-server wait. Journey
// latency contracts (live output, Jobs load, Retry) override this explicitly.
export const expect=browserExpect.configure({timeout:30000});
export const CHECK="test \"$(cat answer.txt)\" = 'the deterministic G2 change'";
export const LIVE='G2 agent is working on the deterministic change.';
export const CHANGE='the deterministic G2 change\n';
export const PHONE_USER_AGENT=devices['iPhone 13'].userAgent;
export const test=base.extend({automaticEvidence:[false,{option:true}],journey:async({browser,automaticEvidence},use)=>{
  const root=await mkdtemp(join(tmpdir(),'faravan-g2-'));
  const cleanupMarker=process.env.FARAVAN_TEST_RUNNER_ROOT?join(process.env.FARAVAN_TEST_RUNNER_ROOT,'pending-cleanup',basename(root)):null;
  if(cleanupMarker)await writeFile(cleanupMarker,root+'\n');
  let apps,preserveRoot=false;const contexts=[],pages={};
  // The host computer is the one that lends in these journeys: I45 holds every "ready" to its real admission check.
  const invariants=journeyInvariants(test.info(),{admission:async()=>{const value=await apps?.host?.control('admission');return value===undefined?undefined:value;}});
  const people=[{device:'G2 host computer',person:'Alex Rivera'},{device:'G2 friend computer',person:'Morgan Chen'}];
  try {
    const host = process.env.FARAVAN_TEST_INSTALLED_HOST;
    const friend = process.env.FARAVAN_TEST_INSTALLED_FRIEND;
    const installedRoots = host || friend ? {host,friend} : undefined;
    apps=await twoFreshInstalls({root,automaticEvidence,installedRoots,hostHome:process.env.FARAVAN_TEST_HOST_HOME??process.env.HOME});
    for(const actor of [apps.host,apps.friend]) {
      const viewport=test.info().project.use.viewport??{width:1280,height:900};
      const phone=viewport.width<=390;
      const context=await browser.newContext({viewport,isMobile:phone,hasTouch:phone,...(phone?{userAgent:PHONE_USER_AGENT}:{})});contexts.push(context);
      const identity={people,selfDevice:people[actor.name==='host'?0:1].device};
      context.on('page',page=>invariants.register(page,actor.name,identity));
      pages[actor.name]=await context.newPage();
      await pages[actor.name].goto((await actor.link())+'#/circles');
      await expect(pages[actor.name].getByRole('heading',{name:'Circles',exact:true})).toBeVisible();
      await expect(pages[actor.name].getByRole('heading',{name:'Work with people you trust.',exact:true})).toBeVisible();
      if(phone)expect(await pages[actor.name].evaluate(()=>matchMedia('(pointer: coarse)').matches),'Phone checks must exercise touch CSS').toBe(true);
      expect(actor.reportedPaths).toEqual(actor.paths);
      for(const path of Object.values(actor.reportedPaths))expect(path).not.toBe(process.env.FARAVAN_TEST_HOST_HOME??process.env.HOME);
      const page=pages[actor.name];
      await invariants.checkpoint(page,'fresh circles');
      await page.goto((await actor.link())+'#/you/profile');
      await page.getByLabel('Your name',{exact:true}).fill(identity.people[actor.name==='host'?0:1].person);
      await page.getByRole('button',{name:'Save your name',exact:true}).click();
      await page.getByLabel('Computer name',{exact:true}).fill(identity.selfDevice);
      await page.getByRole('button',{name:'Save computer name',exact:true}).click();
      await invariants.checkpoint(page,'saved distinct profile');
      await page.goto((await actor.link())+'#/circles');
    }
    expect(apps.host.pid).not.toBe(apps.friend.pid);
    for(const key of Object.keys(apps.host.paths))expect(apps.host.reportedPaths[key]).not.toBe(apps.friend.reportedPaths[key]);
    const repo=join(root,'project');await mkdir(repo);
    const git=async(...args)=>(await promisify(execFile)('git',['-C',repo,...args],{env:{...apps.friend.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer'})).stdout;
    await git('init','-q','-b','main');
    await git('config','user.name','G2 test');await git('config','user.email','g2@example.test');
    for(const [path,bytes] of Object.entries({'answer.txt':'original\n','staged.txt':'base staged\n','unstaged.txt':'base unstaged\n'}))await writeFile(join(repo,path),bytes);
    await git('add','answer.txt','staged.txt','unstaged.txt');await git('commit','-qm','Establish the submitted source');
    await writeFile(join(repo,'staged.txt'),'precious staged work\n');await git('add','staged.txt');
    await writeFile(join(repo,'unstaged.txt'),'precious unstaged work\n');await writeFile(join(repo,'sentinel.txt'),'precious untracked work\n');
    await use({...apps,...pages,apps,root,repo,git,invariants});
  } catch(error){preserveRoot=error.preserveFixtureRoot===true;throw error;
  } finally {
    let invariantResult;
    try {invariantResult=await invariants.finish();}
    finally {
    if(test.info().status!==test.info().expectedStatus)for(const [name,page] of Object.entries(pages))await test.info().attach(name+'-page',{body:await page.locator('body').innerText().catch(()=>''),contentType:'text/plain'});
    await Promise.allSettled(contexts.map(context=>context.close()));
    await apps?.stop();
    if(!preserveRoot){await rm(root,{recursive:true,force:true});if(cleanupMarker)await rm(cleanupMarker,{force:true});}
    }
    expect(invariantResult?.failures??[],'Rendered invariants (full evidence attached)').toEqual([]);
  }
}});

export async function connect(j,{beforeInvite}={}) {
  const {host,friend}=j;
  await test.step('Two fresh installations host, invite, request admission and approve through the UI',async()=>{
    await host.goto((await j.apps.host.link())+'#/circles/host');
    await host.getByLabel('Circle name',{exact:true}).fill('G2 friends');
    await host.getByRole('radio',{name:/Local network only/}).check();
    await j.invariants.checkpoint(host,'valid circle form',{circleFormReady:true,personName:'Alex Rivera'});
    await host.getByRole('button',{name:'Start circle',exact:true}).click();
    await host.getByRole('link',{name:'Invite someone',exact:true}).click({timeout:30000});
    j.circleHash=new URL(host.url()).hash;
    await host.getByRole('tab',{name:'Settings',exact:true}).click();
    const approve=host.getByRole('switch',{name:'Approve each computer',exact:true});
    await approve.click();await expect(approve).toHaveAttribute('aria-checked','true');
    if(beforeInvite) {
      await beforeInvite(j);
      await host.goto((await j.apps.host.link())+j.circleHash);
      await host.getByRole('tab',{name:'Settings',exact:true}).click();
    }
    await host.getByRole('button',{name:'Invite someone',exact:true}).click();
    await host.getByLabel('Invitation for').selectOption('person');
    await host.getByRole('button',{name:'Create invitation',exact:true}).click();
    const invitationField=host.getByLabel('Invitation link');
    await expect(invitationField).toBeVisible();
    const invitation=await invitationField.inputValue();
    expect(invitation).toBeTruthy();
    await friend.getByRole('button',{name:'Join with an invitation',exact:true}).click();
    await friend.getByRole('textbox',{name:'Invitation',exact:true}).fill(invitation);
    await friend.getByRole('button',{name:'Review invitation',exact:true}).click();
    await expect(friend.getByRole('region',{name:'Join confirmation'})).toContainText('G2 friends');
    await j.invariants.checkpoint(friend,'join review');
    await friend.getByRole('button',{name:'Join circle',exact:true}).click();
    await expect(friend.getByRole('status').filter({hasText:/^Request sent\./}).first()).toBeVisible();
    await friend.getByRole('list',{name:'Your circles',exact:true}).getByRole('link',{name:/G2 friends/}).click();
    await j.invariants.checkpoint(friend,'join pending');
    const matchCode=await friend.getByText(/^Match code /).locator('strong').innerText();
    await host.getByRole('tab',{name:'Settings',exact:true}).click();
    const approval=host.getByRole('button',{name:/^Approve /});
    await expect(approval).toHaveCount(1,{timeout:15000});
    await expect(host.getByText(/^Match code /).first()).toContainText(matchCode);
    await approval.click();
    await expect(host.getByText('Approved. Approving membership does not turn lending on.',{exact:true})).toBeVisible();
    await friend.goto((await j.apps.friend.link())+j.circleHash);
    await expect(friend.getByRole('heading',{name:'G2 friends',exact:true})).toBeVisible();
    if(await friend.getByRole('button',{name:'Check approval',exact:true}).isVisible())await friend.getByRole('button',{name:'Check approval',exact:true}).click();
    await expect(friend.getByRole('button',{name:'Check approval',exact:true})).toHaveCount(0);
    await j.invariants.checkpoint(friend,'joined',{joined:true,noRestart:true});
  });
  // A caller that configured lending before inviting keeps that saved choice.
  if(beforeInvite)return;
  await test.step('The lender deliberately chooses Codex and enables ask-each-time lending',async()=>{
    await host.goto((await j.apps.host.link())+'#/lend');
    await host.getByRole('switch',{name:'Lend with Codex',exact:true}).click();
    await host.goto((await j.apps.host.link())+'#/lend/limits');
    await host.getByText('Account plan and consent',{exact:true}).click();
    const providerConsent=host.getByRole('switch',{name:'Let rules run friends’ jobs on Codex automatically',exact:true});
    await providerConsent.click();
    await expect(providerConsent).toHaveAttribute('aria-checked','true');
    await host.getByRole('button',{name:'Save',exact:true}).click();
    await expect(host.getByRole('status').filter({hasText:'Saved.'})).toBeVisible();
    const jobLimit=host.getByRole('spinbutton',{name:'Most one friend’s job may spend',exact:true});
    await expect(jobLimit).toBeEnabled();
    await jobLimit.fill('10');
    await host.getByRole('button',{name:'Save limit',exact:true}).click();
    await expect(host.getByRole('heading',{name:'Confirm the saved limit',exact:true})).toBeVisible();
    await host.getByRole('button',{name:'Save the limit',exact:true}).click();
    await expect(host.getByRole('status').filter({hasText:'Saved.'})).toBeVisible();
    // A newly hosted circle defaults to Automatic. Save the fixture owner's Ask
    // choice through the authenticated app operation before turning lending on.
    const [, , circle] = j.circleHash.split('/');
    const mode = await host.request.post(j.apps.host.origin + '/api/lending/mode', {
      headers: {'x-faravan-session-token': j.apps.host.token},
      data: {circle: decodeURIComponent(circle), mode: 'ask'},
    });
    expect(mode.ok(), 'The fixture owner saved Ask mode').toBe(true);
    await host.goto((await j.apps.host.link())+'#/lend');
    const lendingCircle=host.getByRole('radiogroup',{name:'Choose a circle',exact:true});
    await expect(lendingCircle).toContainText('G2 friends');
    await expect(lendingCircle).toContainText('Selected');
    await expect(host.getByText('Ask me each time',{exact:true})).toBeVisible();
    await host.getByRole('switch',{name:'Lending',exact:true}).click();
    await expect(host.getByRole('switch',{name:'Lending',exact:true})).toHaveAttribute('aria-checked','true');
    await j.invariants.checkpoint(host,'lending enabled');
  });
}

export async function compose(j,prompt='Make the deterministic G2 change.') {
  const page=j.friend;
  await page.goto((await j.apps.friend.link())+'#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  await page.getByLabel('Circle',{exact:true}).selectOption({label:'G2 friends'});
  await page.getByLabel('What the agent should do').fill(prompt);
  const folder=page.getByRole('textbox',{name:'Project folder',exact:true});
  await folder.fill(j.repo);await folder.press('Enter');await folder.blur();
  await expect(page.locator('#cmp-meta')).toContainText('project');
  await page.locator('#cmp-verify-heading').click();
  await page.getByLabel('Test command',{exact:true}).fill(CHECK);
  await j.invariants.checkpoint(page,'composed');
}
export async function send(j) {
  await j.friend.getByRole('button',{name:'Send',exact:true}).click();
  await confirmFirstSend(j.friend);
  await expect(j.friend).toHaveURL(/#\/job\//,{timeout:15000});
  await j.invariants.checkpoint(j.friend,'sent',{userAction:true,knownState:true});
  return new URL(j.friend.url()).hash;
}
export async function authorize(j,prompt='Make the deterministic G2 change.',{holdPreparation=false}={}) {
  await j.host.goto((await j.apps.host.link())+'#/lend');
  await j.host.getByRole('link',{name:'Review request',exact:true}).click({timeout:15000});
  await expect(j.host.getByRole('region',{name:'The request'})).toContainText(prompt);
  await expect(j.host.getByText(CHECK,{exact:true}), 'The lender must review the signed verification command before Run it').toBeVisible();
  const previousRuns=(await j.apps.host.control('state')).runs;
  await j.invariants.checkpoint(j.host,'request review',{promptKnown:true});
  if(holdPreparation)await j.apps.host.control('hold-prepare');
  try {
    await j.invariants.checkpoint(j.host,'before own accept',{accepting:true});
    await j.host.getByRole('button',{name:'Run it',exact:true}).click();
    // Judge r9 O-A: right after Run it the page shows the job being prepared, never "not available yet".
    await j.invariants.checkpoint(j.host,'just accepted',{accepting:true});
    if(holdPreparation) {
      try {
        await expect.poll(async()=>(await j.apps.host.control('state')).preparing,{timeout:20000}).toBe(true);
      } catch(error) {
        const decision=await j.host.evaluate(async()=>{
          // Signed in by the handoff cookie from link(); the page sends no token.
          const response=await fetch('/api/lending',{credentials:'same-origin'});
          const view=await response.json();
          const row=view?.objective?.accounts?.find(item=>item.provider==='codex')?.decision;
          return {reason:row?.reason,objective:row?.objective};
        });
        throw new Error(`${error.message}\nCodex admission: ${JSON.stringify(decision)}`);
      }
      const [, ,encodedDigest,encodedCircle]=new URL(j.friend.url()).hash.slice(1).split('/');
      const address={jobDigest:decodeURIComponent(encodedDigest),circle:decodeURIComponent(encodedCircle)};
      const preparing=await j.apps.host.control('job-state',address);
      expect(preparing.state).toBe('claimed');expect(preparing.current_attempt.execution_started_at).toBeNull();
      // An execution latch is too late: the approved headline must exist while
      // backend.prepare is held, before the coordinator records execution start.
      await expect(j.friend.getByText(/ said yes$/)).toBeVisible();
      expect(await j.apps.host.control('state')).toMatchObject({preparing:true,runs:previousRuns});
      expect((await j.apps.host.control('job-state',address)).current_attempt.execution_started_at).toBeNull();
    }
  } finally {if(holdPreparation)await j.apps.host.control('release-prepare');}
  await expect.poll(async()=>(await j.apps.host.control('state')).runs,{timeout:20000}).toBe(previousRuns+1);
  await j.invariants.checkpoint(j.host,'accepted',{accepting:true,promptKnown:true});
}
export async function liveBoth(j,hash) {
  await j.host.goto((await j.apps.host.link())+hash);
  const start=Date.now();
  await Promise.all([j.host,j.friend].map(async page=>{
    // Record the strict five-second rule without making a newly detected defect
    // prevent the rest of the existing journey's twenty-second progress guard.
    await page.getByText(LIVE,{exact:true}).waitFor({state:'visible',timeout:5000}).catch(()=>{});
    await j.invariants.checkpoint(page,'five-second live guard',{liveMarker:LIVE,liveLatencyMs:Date.now()-start,promptKnown:page===j.host});
    await expect(page.getByText(LIVE,{exact:true})).toBeVisible({timeout:Math.max(1,20000-(Date.now()-start))});
    await expect(page.getByText('Ready to review',{exact:true})).toHaveCount(0);
    await j.invariants.checkpoint(page,'live both',{liveMarker:LIVE,liveLatencyMs:Date.now()-start,promptKnown:page===j.host});
  }));
}
export async function finish(j) {
  await j.apps.host.control('release');
  await expect(j.friend.getByText('Ready to review',{exact:true}).first()).toBeVisible({timeout:30000});
  await expect(j.friend.getByRole('region',{name:'Changes',exact:true})).toContainText('the deterministic G2 change',{timeout:30000});
  await j.invariants.checkpoint(j.friend,'finished',{resultAvailable:true});
}
export async function snapshot(j) {
  return {head:await j.git('rev-parse','HEAD'),branch:await j.git('symbolic-ref','--short','HEAD'),
    index:await readFile(join(j.repo,'.git/index')),staged:await j.git('diff','--cached','--binary','--no-ext-diff'),
    unstaged:await j.git('diff','--binary','--no-ext-diff'),status:await j.git('status','--porcelain=v1','-z','--untracked-files=all'),
    files:await Promise.all(['answer.txt','staged.txt','unstaged.txt','sentinel.txt'].map(path=>readFile(join(j.repo,path))))};
}
