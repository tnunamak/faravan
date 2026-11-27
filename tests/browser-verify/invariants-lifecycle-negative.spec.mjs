import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { journeyInvariants, checkMutationConfirmation } from './invariants-journey.mjs';

const shell = '<!doctype html><html><body><main role="status" aria-label="Loading job">Last known: Running.</main><button id="read" onclick="fetch(\'/api/jobs/a\').then(r=>r.json()).catch(()=>{})">Read job</button><button id="meta" onclick="fetch(\'/api/meta\').then(r=>r.json())">Refresh metadata</button></body></html>';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function recorder() {
  return journeyInvariants({ attach: (name, data) => test.info().attach('negative-fixture-' + name, data) });
}

test('job freshness and loading deadlines belong to the current same-document visit', async ({ page }) => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell);
    }
  });
  const base = await listen(server);
  const invariants = recorder();
  invariants.register(page, 'same-document fixture');
  try {
    await page.goto(base + '/#/job/a');
    const firstRead = page.waitForResponse(response => response.url().endsWith('/api/jobs/a'));
    await page.getByRole('button', { name: 'Read job' }).click();
    await firstRead;
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'A success proves stale-text finding');
    await page.evaluate(() => { location.hash = '#/job/b'; });
    await invariants.checkpoint(page, 'B without success');

    await page.evaluate(() => { location.hash = '#/job/a'; });
    const returnedRead = page.waitForResponse(response => response.url().endsWith('/api/jobs/a'));
    await page.getByRole('button', { name: 'Read job' }).click();
    await (await returnedRead).finished();
    await page.waitForTimeout(10100);
    await invariants.checkpoint(page, 'A loading exceeds deadline');
    const metadata = page.waitForResponse(response => response.url().endsWith('/api/meta'));
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    await metadata;
    await page.waitForTimeout(50);
    await page.evaluate(() => { location.hash = '#/job/b'; });
    await invariants.checkpoint(page, 'B revisit');
    await page.evaluate(() => { location.hash = '#/home'; });
    await invariants.checkpoint(page, 'home between visits');
    await page.evaluate(() => { location.hash = '#/job/a'; });
    await invariants.checkpoint(page, 'A revisit without a new job read');
    const result = await invariants.finish();
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'A success proves stale-text finding')).toBe(true);
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'B without success')).toBe(false);
    expect(result.failures.some(f => f.id === 'I31' && f.label === 'A loading exceeds deadline')).toBe(true);
    expect(result.failures.some(f => f.id === 'I31' && f.label === 'A revisit without a new job read')).toBe(false);
  } finally {
    await invariants.finish();
    await close(server);
  }
});

test('app freshness requires a completed successful response body', async ({ page }) => {
  let releaseBody;
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      bodyStarted();
      releaseBody = () => res.end('}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell.replace('Last known: Running.', 'Live updates paused.'));
    }
  });
  const base = await listen(server);
  const invariants = recorder();
  invariants.register(page, 'partial response fixture');
  try {
    await page.goto(base + '/#/job/a');
    const headers = page.waitForResponse(response => response.url().endsWith('/api/meta'));
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    const response = await headers;
    await started;
    await invariants.checkpoint(page, 'headers before body completion');
    releaseBody();
    await response.finished();
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'complete current epoch response');
    const result = await invariants.finish();
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'headers before body completion')).toBe(false);
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'complete current epoch response')).toBe(true);
  } finally {
    if (releaseBody) releaseBody();
    await invariants.finish();
    await close(server);
  }
});

test('a response from an earlier availability epoch cannot refresh app status', async ({ page }) => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      count++;
      if (count === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        firstStarted();
        releaseFirst = () => res.end('}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell.replace('Last known: Running.', 'Live updates paused.'));
    }
  });
  const base = await listen(server);
  const invariants = recorder();
  invariants.register(page, 'availability epoch fixture');
  try {
    await page.goto(base + '/#/job/a');
    const oldHeaders = page.waitForResponse(response => response.url().endsWith('/api/meta'));
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    const oldResponse = await oldHeaders;
    await started;
    invariants.availability(page, false);
    invariants.availability(page, true);
    releaseFirst();
    await oldResponse.finished();
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'old epoch response completed');
    const freshResponse = page.waitForResponse(response => response.url().endsWith('/api/meta') && count >= 2);
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    await (await freshResponse).finished();
    await page.waitForTimeout(100);
    await invariants.checkpoint(page, 'fresh epoch response completed');
    const result = await invariants.finish();
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'old epoch response completed')).toBe(false);
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'fresh epoch response completed')).toBe(true);
  } finally {
    if (releaseFirst) releaseFirst();
    await invariants.finish();
    await close(server);
  }
});

test('same-document A-home-A visits do not inherit an expired loading deadline', async ({ page }) => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell);
    }
  });
  const base = await listen(server), invariants = recorder(), navigations = [];
  invariants.register(page, 'loading deadline roundtrip fixture');
  const navigated = frame => { if (frame === page.mainFrame()) navigations.push(new URL(page.url()).hash); };
  page.on('framenavigated', navigated);
  try {
    await page.goto(base + '/#/job/a');
    const read = page.waitForResponse(response => response.url().endsWith('/api/jobs/a'));
    await page.getByRole('button', { name: 'Read job' }).click();
    await (await read).finished();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/job/a');
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'A read starts loading deadline');
    await page.waitForTimeout(10100);
    await invariants.checkpoint(page, 'A loading deadline expired');

    // Both history transitions run in one page task. The recorder cannot sample
    // between them, so only its navigation event handling can observe the visit.
    const before = navigations.length;
    await page.evaluate(() => {
      history.pushState({}, '', '#/home');
      dispatchEvent(new PopStateEvent('popstate'));
      history.pushState({}, '', '#/job/a');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(navigations.length - before, 'Chromium reports both same-document visits').toBe(2);
    await invariants.checkpoint(page, 'returned A without a job read');
    const result = await invariants.finish();
    expect(result.failures.some(f => f.id === 'I31' && f.label === 'A loading deadline expired')).toBe(true);
    expect(result.failures.some(f => f.id === 'I31' && f.label === 'returned A without a job read')).toBe(false);
  } finally {
    page.off('framenavigated', navigated);
    await invariants.finish();
    await close(server);
  }
});

test('a completed response held across A-home-A cannot refresh the returned visit', async ({ page }) => {
  let releaseBody, bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      count++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (count === 1) {
        res.write('{'); bodyStarted(); releaseBody = () => res.end('}');
      } else res.end('{}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell.replace('Last known: Running.', 'Live updates paused.'));
    }
  });
  const base = await listen(server), invariants = recorder();
  invariants.register(page, 'app freshness roundtrip fixture');
  try {
    await page.goto(base + '/#/job/a');
    const oldHeaders = page.waitForResponse(response => response.url().endsWith('/api/meta'));
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    const oldResponse = await oldHeaders;
    await started;
    await page.evaluate(() => {
      history.pushState({}, '', '#/home'); dispatchEvent(new PopStateEvent('popstate'));
      history.pushState({}, '', '#/job/a'); dispatchEvent(new PopStateEvent('popstate'));
    });
    releaseBody();
    await oldResponse.finished();
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'old response completed after roundtrip');
    const currentHeaders = page.waitForResponse(response => response.url().endsWith('/api/meta') && count >= 2);
    await page.getByRole('button', { name: 'Refresh metadata' }).click();
    await (await currentHeaders).finished();
    await page.waitForTimeout(50);
    await invariants.checkpoint(page, 'new response refreshes returned visit');
    const result = await invariants.finish();
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'old response completed after roundtrip')).toBe(false);
    expect(result.failures.some(f => f.id === 'I06' && f.label === 'new response refreshes returned visit')).toBe(true);
  } finally {
    if (releaseBody) releaseBody();
    await invariants.finish();
    await close(server);
  }
});


for(const delay of [100,5000])test(`mutation confirmation deadline is independent of a ${delay}ms dialog close`,async({page})=>{
  const html='<!doctype html><html><body><dialog open>Adding the branch…</dialog><main id="confirmation"></main></body></html>';
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html);});
  const base=await listen(server),invariants=recorder();
  invariants.register(page,'mutation deadline fixture');
  try {
    await page.goto(base+'/#/job/a');
    const completedAt=await page.evaluate(delay=>{
      setTimeout(()=>{document.querySelector('dialog').remove();document.querySelector('#confirmation').textContent='Added as a branch';},delay);
      return Date.now();
    },delay);
    await checkMutationConfirmation(invariants,page,completedAt,'Added as a branch');
    await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:7000});
    await expect(page.getByText('Added as a branch',{exact:true})).toBeVisible();
    const result=await invariants.finish();
    expect(result.failures.some(f=>f.id==='I33'&&f.label==='mutation confirmation')).toBe(delay>2000);
  } finally {await invariants.finish();await close(server);}
});
