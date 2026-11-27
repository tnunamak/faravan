import {test as base, expect as browserExpect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from '../../lib/v1/app.mjs';
import {openV1Store} from '../../lib/v1/store.mjs';
import {createV1Handler} from '../../lib/v1/server.mjs';
import {resolveHarness} from '../../lib/executor.mjs';
import {adapters, api, bounded, boundedFetch, syntheticBackend} from '../helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from '../helpers/pace50-synthetic-source.mjs';

export const expect = browserExpect.configure({timeout:30000});
export {api};
export const LIVE = 'Decision journey: the synthetic agent is still running.';

// Real UI -> real app -> signed HTTP -> real coordinator/store. Only execution
// and its readiness/allowance evidence are synthetic. No page.route responses.
export const test = base.extend({decision:async ({browser}, use) => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-decision-'));
  const apps = [], contexts = [], coordinatorRequests = [], outboundRequests = [], browserWrites = [], pageErrors = [];
  const pendingReads = new Map();
  const requestWindow = new AsyncLocalStorage();
  let activeWindow = null, nextWindow = 0;
  let handler, store;
  const server = createServer((req, res) => {
    const proof = req.headers['faravan-proof'];
    const row = {method:req.method, path:new URL(req.url, 'http://127.0.0.1').pathname,
      device:proof ? JSON.parse(Buffer.from(proof, 'base64url')).payload.key_id : null,
      window:req.headers['x-test-decision-window'] ?? null};
    coordinatorRequests.push(row); // Every inbound request, including rejected requests; no ring-buffer truncation.
    res.once('finish', () => {row.status = res.statusCode;});
    if (handler) handler(req, res);
    else res.writeHead(503).end();
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function install(name, fresh = true) {
      const home = join(root, name);
      await mkdir(home, {recursive:true});
      const execution = {hold:true, captureStream:true, liveMessage:LIVE};
      const backend = syntheticBackend(root, execution);
      // Keep this lane's scratch for inspection. Teardown still releases work
      // and closes every app/server; it does not delete the retained fixture.
      backend.destroy = async handle => {backend.calls.push(['destroy']);handle._release?.();return {removed:true};};
      const app = await startApp({home,port:0,origin:null,token:'decision-session-' + name,backendFactory:async () => backend,adapters:[...adapters(), {spec:resolveHarness('claude-code-subscription'),
          installed:true, signedIn:true, harnessVersion:'synthetic-only', models:['claude-haiku-4-5'], capabilities:[]}],freshLending:'off',pollMs:60000,approvalPollMs:60000,autoApprove:false,joinWaitMs:0,quotaReader:async () => ({remaining:100, observedAt:Date.now()}),idleReader:async () => false,signInProbe:async () => ({signedIn:null, source:'unavailable'}),identityProbe:async ({harnessNames}) => ({providers:harnessNames.map(harness_id => ({harness_id, installed:true, signedIn:true}))}),lendingPace50:{source:createSyntheticPace50Source({start:Date.now()}), account_week_id:'synthetic-week-1'},fetch:async (url, init) => {
          const window = requestWindow.getStore() ?? null;
          const row = {actor:name, method:init?.method ?? 'GET', path:new URL(url).pathname, window};
          if (row.method === 'POST' && row.path.endsWith('/release')) row.reason = JSON.parse(init.body).reason;
          outboundRequests.push(row); // Record before dispatch, so failures count too.
          try {const response = await boundedFetch(url, {...init,
            headers:{...init?.headers, ...(window ? {'x-test-decision-window':window} : {})}});row.status = response.status;return response;}
          catch (error) {row.error = error.name;throw error;}
        }});
      const actor = {app, backend, execution, home};
      apps.push(actor);
      const handlers = app.server.listeners('request');
      app.server.removeAllListeners('request');
      app.server.on('request', (req, res) => requestWindow.run(req.headers['x-test-decision-window'] ?? null, () => {
        for (const handle of handlers) handle.call(app.server, req, res);
      }));
      if(fresh){
        await api(app, '/api/devices', {method:'POST', body:{name:'Decision ' + name + ' computer', ownerName:'Decision ' + name}});
        await api(app, '/api/agents/codex/run', {method:'POST', body:{model:'gpt-6-luna', effort:null}});
        await api(app, '/api/agents/claude-code-subscription/run', {method:'POST', body:{model:'claude-haiku-4-5', effort:null}});
      }
      return actor;
    }
    const owner = await install('owner'), lender = await install('lender');
    const circle = await api(owner.app, '/api/circles', {method:'POST', body:{origin, name:'Decision journey friends', publish:false}});
    const initialRoster = (await owner.app.device.rosterCache(circle.id).get()).current;
    store = openV1Store({path:join(root, 'coordinator.sqlite'), circle:circle.id,
      rootFingerprint:circle.pinnedRootFingerprint, origin, initialRoster});
    handler = createV1Handler({store, blobDir:join(root, 'blobs')});
    const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method:'POST', body:{}});
    await api(lender.app, '/api/circles/join', {method:'POST', body:{link:invite}});
    await api(owner.app, '/api/circles/' + circle.id + '/approve', {method:'POST', body:{}});
    await lender.app.device.refreshRoster(circle.id);
    // Inspect authoritative attempt state through signed HTTP without making
    // the observer compete with the borrower's local job-cache/write lock.
    const observer = await owner.app.device.client(circle.id);
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    contexts.push(context);
    const page = await context.newPage();
    page.on('requestfinished', req => pendingReads.delete(req));
    page.on('requestfailed', req => pendingReads.delete(req));
    page.on('pageerror', error => pageErrors.push(error.message));
    // Transparent transport observation only. Tag the initiating local request,
    // then propagate its async context; never fulfil or suppress an API response.
    await page.route('**/api/**', route => route.continue({headers:{...route.request().headers(),
      ...(activeWindow ? {'x-test-decision-window':activeWindow} : {})}}));
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/') && path !== '/api/events') {
        pendingReads.set(req, {window:activeWindow, path});
      }
      if (path.startsWith('/api/') && req.method() !== 'GET') {
        browserWrites.push({method:req.method(), path});
      }
    });
    const j = {root, owner, lender, circle, page, coordinatorRequests, outboundRequests, browserWrites,
      async restartLender() {
        await bounded(lender.app.close(), 'lender restart close', 30000);
        lender.app.server.closeAllConnections();
        apps.splice(apps.indexOf(lender),1);
        const restarted=await install('lender',false);
        Object.assign(lender,restarted);
        apps[apps.indexOf(restarted)]=lender;
      },
      restartCoordinator() {
        handler.close();store.close();
        store=openV1Store({path:join(root,'coordinator.sqlite'),circle:circle.id,
          rootFingerprint:circle.pinnedRootFingerprint,origin});
        handler=createV1Handler({store,blobDir:join(root,'blobs')});
      },
      async roster() {
        const roster=await observer.refreshRoster();
        return roster.payload.members.map(member=>member.key_id).sort();
      },
      async lenderOffers() {
        const client=await lender.app.device.client(circle.id),digests=[];
        for await(const offer of client.listOffers({waitSeconds:0}))digests.push(offer.job_digest);
        return digests;
      },
      async enable({secondProvider = false} = {}) {
        await api(lender.app, '/api/lending/limits', {method:'POST', body:{dailyJobs:10, dailyMinutes:240,
          maxWallSeconds:1200, idleOnly:false, lendingPolicy:{accountSlots:1, machineSlots:secondProvider ? 2 : 1}}});
        await api(lender.app, '/api/agents/codex', {method:'POST', body:{useForLending:true}});
        if (secondProvider) await api(lender.app, '/api/agents/claude-code-subscription', {method:'POST', body:{useForLending:true}});
        await api(lender.app, '/api/lending/mode', {method:'POST', body:{circle:circle.id, mode:'ask'}});
        await api(lender.app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
      },
      async submit(prompt, harness = 'codex') {
        return api(owner.app, '/api/jobs', {method:'POST', body:{circle:circle.id, prompt, harness,
          git:'https://github.com/example/synthetic.git', commit:'1'.repeat(40), send_anyway:true}});
      },
      async card(digest) {
        await expect.poll(async () => (await api(lender.app, '/api/approvals')).some(card => card.jobDigest === digest)).toBe(true);
        return (await api(lender.app, '/api/approvals')).find(card => card.jobDigest === digest);
      },
      job:digest => observer.getJob(digest),
      async open(hash) {await page.goto(lender.app.url + hash);await expect(page.getByRole('heading', {level:1})).toBeVisible();},
      async settleAction() {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (activeWindow !== null) {
          const pending = () => [...pendingReads.values()].filter(row => row.window === activeWindow).length;
          await expect.poll(pending).toBe(0);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await expect.poll(pending).toBe(0);
        }
        await expect(page.locator('main [aria-disabled="true"]')).toHaveCount(0);
      },
      async revisitHome() {
        await j.open('#/jobs');
        await j.open('#/home');
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/approvals' && response.request().method() === 'GET');
        await page.reload();
        expect((await refreshed).ok()).toBe(true);
        await expect(page.getByRole('heading', {name:'What would you like to get done?', level:1, exact:true})).toBeVisible();
        await j.settleAction();
      },
      mark() {activeWindow = String(++nextWindow);return {window:activeWindow, inbound:coordinatorRequests.length, outbound:outboundRequests.length, writes:browserWrites.length};},
      since(mark) {
        activeWindow = null;
        const outbound = outboundRequests.slice(mark.outbound);
        const coordinator = coordinatorRequests.slice(mark.inbound);
        return {coordinator, outbound, actionCoordinator:coordinator.filter(row => row.window === mark.window),
          actionOutbound:outbound.filter(row => row.window === mark.window), writes:browserWrites.slice(mark.writes)};
      },
    };
    await use(j);
    expect(pageErrors, 'Uncaught browser errors cannot be hidden by known contract failures').toEqual([]);
  } finally {
    await test.info().attach('decision-request-spy.json', {body:JSON.stringify({root, coordinatorRequests, outboundRequests, browserWrites}, null, 2), contentType:'application/json'});
    await Promise.allSettled(contexts.map(context => context.close()));
    for (const actor of apps) {actor.execution.hold = false;actor.backend.release();}
    const closed = await Promise.allSettled(apps.reverse().map(async ({app}) => {
      try {await bounded(app.close(), 'decision app close', 30000);}
      finally {app.server.closeAllConnections();}
    }));
    handler?.close();server.closeAllConnections();
    await bounded(new Promise(resolve => server.close(resolve)), 'decision coordinator close');
    store?.close();
    expect(closed.filter(row => row.status === 'rejected')).toEqual([]);
  }
}});

// Same mechanism as verify.spec.mjs/slices.mjs: match individual known problems,
// fail on any new problem or on a disappeared allowance. Never skip a journey.
export async function contract(problems, known, evidence) {
  const unexplained = problems.filter(problem => !known.some(row => row.match.test(problem)));
  const gone = known.filter(row => !problems.some(problem => row.match.test(problem)));
  if (known.length) test.info().annotations.push({type:'known', description:known.map(row => row.id).join(',')});
  test.info().annotations.push({type:'reason', description:problems.join('; ') || 'Contract passed'});
  await test.info().attach('decision-contract.json', {body:JSON.stringify({problems, known:known.map(({id, why}) => ({id, why})), ...evidence}, null, 2), contentType:'application/json'});
  expect.soft(unexplained, 'NEW: contract violations without an expected-failure entry').toEqual([]);
  expect.soft(gone.map(row => row.id), 'FIXED?: remove expected-failure entries that no longer reproduce').toEqual([]);
}
