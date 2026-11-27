import {test, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './lib.mjs';
import {RUNNING_CLAUDE, FINISHED_CLAUDE} from '../../ui/v1/src/fixtures/transcript-stream.mjs';

// "What the agent is doing": the transcript feed on the job page, from real stream-json shapes. Set TRANSCRIPT_SHOTS
// to a folder to also save the screens at desktop and phone size, light and dark.
let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id: 'transcript-circle', name: 'Faravan tomorrow', origin: 'http://fixture'};
const digest = 'sha256:' + 'e'.repeat(64);
// The command in the fixture started at 11:20:37Z; the page's clock sits 4:51 later.
const NOW = Date.parse('2026-10-20T11:25:28Z');
const runningJob = {job_digest: digest, state: 'claimed', local: {title: 'Render an interesting zoom of the mandlebrot set, cel shaded', prompt: 'Render an interesting zoom of the mandlebrot set, cel shaded', submittedAt: '2026-10-20T11:17:00Z'},
  current_attempt: {attempt_id: 'a1', holder: 'holder-1', execution_started_at: '2026-10-20T11:19:00Z'}, runTiming: {hardStopAt: '2026-10-20T11:39:00Z'}};
const finishedJob = {...runningJob, state: 'result-accepted', status: 'result-accepted', result_digest: 'sha256:' + 'f'.repeat(64), runTiming: {endedAt: '2026-10-20T11:30:00Z'}};

async function jobPage(page, job, transcript) {
  await page.clock.setFixedTime(NOW);
  await page.route('**/api/circles', route => route.fulfill({json: [circle]}));
  await page.route('**/api/circles/*/compose', route => route.fulfill({json: {}}));
  await page.route('**/api/devices', route => route.fulfill({json: {fingerprint: 'me', circles: []}}));
  await page.route('**/api/jobs', route => route.request().method() === 'GET' ? route.fulfill({json: []}) : route.continue());
  await page.route('**/api/jobs/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/transcript')) return route.fulfill({json: transcript});
    if (pathname.endsWith('/progress')) return route.fulfill({json: {entries: [{seq: 1, at: '2026-10-20T11:19:00Z', stage: 'preparing', elapsed_s: 0}, {seq: 2, at: '2026-10-20T11:19:12Z', stage: 'agent', elapsed_s: 12}, {seq: 3, at: 'x', step: 'Running a command', kind: 'step'}]}});
    if (pathname.endsWith('/retention')) return route.fulfill({json: {deletable: false}});
    if(pathname.endsWith('/changes')&&job.local.title==='Handle empty CSV input')return route.fulfill({json:{format:'diff',files:[{path:'src/parse.js',insertions:1,deletions:1}],diffstat:{files:1,insertions:1,deletions:1},diff:'diff --git a/src/parse.js b/src/parse.js\n--- a/src/parse.js\n+++ b/src/parse.js\n@@ -1 +1 @@\n-export const parse = text => text.split("\\n");\n+export const parse = text => text ? text.split("\\n") : [];\n'}});
    if (pathname.endsWith('/changes')) return route.fulfill({json: {format: 'diff', files: [{path: 'sum.mjs', insertions: 1, deletions: 1}], diffstat: {files: 1, insertions: 1, deletions: 1}, diff: 'diff --git a/sum.mjs b/sum.mjs\n--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export function sum(a, b) { return a - b; }\n+export function sum(a, b) { return a + b; }\n'}});
    return route.fulfill({json: job});
  });
  await page.goto((await harness.link('owner')) + '#/job/' + encodeURIComponent(digest) + '/' + circle.id);
  await page.getByRole('heading', {level: 1}).waitFor();
}
// Every element that scrolls sideways or reaches past the screen edge, named by its tag and class.
const sideScroll = page => page.evaluate(() => [...document.querySelectorAll('html, .activity, .activity *, .wait-card, .wait-card *')].filter(el => {
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  const scrolls = el === document.documentElement ? el.scrollWidth > el.clientWidth + 1 : ['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
  return scrolls || (box.width > 0 && box.right > innerWidth + 1 && !el.closest('[hidden], details:not([open]) > :not(summary)'));
}).map(el => el.tagName.toLowerCase() + '.' + String(el.className.baseVal ?? el.className).trim().replace(/\s+/g, '.')).slice(0, 8));
async function shoot(page, name) {
  if (!process.env.TRANSCRIPT_SHOTS) return;
  await mkdir(process.env.TRANSCRIPT_SHOTS, {recursive: true});
  await page.screenshot({path: process.env.TRANSCRIPT_SHOTS + '/' + name + '.png', fullPage: true});
}

for (const [width, height, size] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
  for (const scheme of ['light', 'dark']) {
    test(`running job feed at ${size} ${scheme}: words wrap, commands are rows, output opens, nothing scrolls sideways`, async ({page}) => {
      await page.setViewportSize({width, height});
      await page.emulateMedia({colorScheme: scheme});
      await jobPage(page, runningJob, {text: RUNNING_CLAUDE, truncated: true, live: true});
      const feed = page.getByRole('list', {name: 'What the agent is doing'});
      await expect(feed).toBeVisible();
      await expect(page.getByText('Earlier steps aren’t shown')).toBeVisible();
      await expect(page.getByText('Follow latest')).toHaveCount(0);
      await expect(page.locator('input[type=checkbox]')).toHaveCount(0);
      // The timing facts (start, time limit) are a present-execution claim, so they wait for an agent update inside the 30 s window; this transcript's last update is 4 min old.
      await expect(page.getByText(/Time limit 6:39 AM/)).toHaveCount(0);
      await expect(page.locator('.prog')).toHaveCount(0);
      await expect(page.locator('.job-timeline')).toHaveCount(0);
      const running = page.locator('.feed-tool.is-running');
      await expect(running.locator('.feed-verb')).toHaveText('Started running');
      await expect(running.locator('.feed-meta')).toHaveText('Started 4 min ago');
      await expect(running).toContainText('No update for 4 min. Current activity is unconfirmed.');
      await expect(page.getByText(/No update for/)).toHaveCount(1);
      await expect(page.locator('.feed-tool.is-error')).toContainText('Failed');
      const prose=page.locator('.feed-msg p').first();
      await expect(prose).toBeVisible();
      const typography=await prose.evaluate(el=>{const s=getComputedStyle(el);return {font:s.fontFamily,body:getComputedStyle(document.body).fontFamily,mono:getComputedStyle(document.querySelector('.feed-target')).fontFamily,whiteSpace:s.whiteSpace,scroll:el.scrollWidth,width:el.clientWidth};});
      expect(typography.font).toBe(typography.body);expect(typography.font).not.toBe(typography.mono);
      expect(typography.whiteSpace).not.toBe('nowrap');expect(typography.scroll).toBeLessThanOrEqual(typography.width+1);
      await expect(page.locator('.activity')).not.toContainText(/sorry|apolog|\[private details withheld\]/i);
      await expect(page.locator('.feed-tool.is-error summary .feed-chev')).toHaveCount(1);
      expect(await sideScroll(page)).toEqual([]);
      await shoot(page, `running-${size}-${scheme}`);
      await page.locator('.feed-tool.is-error summary').click();
      await expect(page.locator('.feed-tool.is-error .feed-output')).toContainText('ModuleNotFoundError');
      expect(await sideScroll(page)).toEqual([]);
    });
  }
}

test('follow: the feed keeps to the newest line until the reader scrolls up, then offers Jump to latest', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 600});
  await page.emulateMedia({colorScheme: 'dark'});
  const long = RUNNING_CLAUDE + '\n' + Array.from({length: 30}, (_, i) => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'Step ' + i + ' of the render: checking the bands again before the next pass.'}]}})).join('\n');
  await jobPage(page, runningJob, {text: long, truncated: true, live: true});
  const feed = page.locator('.feed');
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(33);
  await expect(page.getByRole('button', {name: 'Jump to latest'})).toHaveCount(0);
  await feed.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('button', {name: 'Jump to latest'})).toBeVisible();
  await shoot(page, 'running-scrolled-up-desktop-dark');
  await page.getByRole('button', {name: 'Jump to latest'}).click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(33);
  await expect(page.getByRole('button', {name: 'Jump to latest'})).toHaveCount(0);
});

for (const [width, height, size] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
  for (const scheme of ['light', 'dark']) {
    test(`finished job at ${size} ${scheme}: the feed starts closed and opens with its chevron`, async ({page}) => {
      await page.setViewportSize({width, height});
      await page.emulateMedia({colorScheme: scheme});
      await jobPage(page, finishedJob, {text: FINISHED_CLAUDE, truncated: false, live: false});
      const head = page.locator('#job-handoff>summary');
      await expect(head).toHaveText('Job details');
      await expect(page.locator('.feed')).toBeHidden();
      await head.click();
      await expect(page.locator('.feed')).toBeVisible();
      await expect(page.locator('.feed-tool.is-running')).toHaveCount(0);
      await page.locator('.feed-tool', {hasText: 'node --test'}).locator('summary').click();
      await expect(page.locator('.feed-output', {hasText: '# pass 2'})).toBeVisible();
      expect(await sideScroll(page)).toEqual([]);
      await shoot(page, `finished-${size}-${scheme}`);
    });
  }
}

// Exercise the actual outbound projection rather than raw provider fixtures.
for (const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']]) for (const scheme of ['light','dark']) {
  test(`private projected transcript at ${size} ${scheme}: file labels survive, filler collapses`,async({page})=>{
    const {workspaceTranscript}=await import('../../lib/v1/workspace-transcript.mjs');
    const {createRelayTranscript}=await import('../../lib/v1/live-transcript.mjs');
    const {TRANSCRIPT_CLAUDE,TRANSCRIPT_CODEX}=await import('../../ui/v1/src/fixtures/private-transcript-stream.mjs');
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme});
    const parserLocal={title:'Handle empty CSV input',prompt:'Handle empty CSV input in src/parse.js',submittedAt:runningJob.local.submittedAt};
    const projected=workspaceTranscript('/private/scratch',{privateValues:[]}).text(TRANSCRIPT_CLAUDE);
    const relay=createRelayTranscript();relay.append(projected);
    await jobPage(page,{...runningJob,local:parserLocal},{text:relay.snapshot().text,live:true,truncated:false});
    const feed=page.locator('.feed');
    await expect(feed.locator('.feed-msg')).toHaveCount(1);
    await expect(feed.locator('.feed-withheld')).toHaveCount(0);
    await expect(feed.locator('.feed-tool',{hasText:'Read'})).toContainText('src/parse.js');
    await expect(feed.locator('.feed-tool',{hasText:'Edited'})).toContainText('src/parse.js');
    await expect(feed).not.toContainText('[private details withheld]');
    expect(await sideScroll(page)).toEqual([]);
    await shoot(page,`projected-live-${size}-${scheme}`);
    // One note covers a run whose scanner was unavailable, including legacy filler records.
    const withheld=workspaceTranscript('/workspace',{scanUnavailable:true}).text(TRANSCRIPT_CLAUDE);
    await jobPage(page,{...runningJob,local:parserLocal},{text:withheld,at:'2026-10-20T11:19:12Z',live:true,truncated:false});
    await expect(feed.locator('.feed-withheld')).toHaveCount(1);
    await expect(feed.locator('.feed-msg')).toHaveCount(0);
    // The evidence line states when output was last seen; with no timestamped agent update it makes no current-activity claim.
    await expect(page.getByText(/Last visible output/)).toHaveCount(1);
    await expect(page.getByText(/No update for/)).toHaveCount(0);
    await expect(feed).toContainText('Output was withheld because it may contain private details');
    expect(await sideScroll(page)).toEqual([]);
    await shoot(page,`withheld-live-${size}-${scheme}`);
    // Codex's delivered transcript uses the same file and command presentation.
    await jobPage(page,{...finishedJob,local:parserLocal},{text:workspaceTranscript('/workspace').text(TRANSCRIPT_CODEX),live:false,truncated:false});
    await page.locator('#job-handoff>summary').click();
    await expect(feed).toBeVisible();await expect(feed.locator('.feed-tool',{hasText:'Edited'})).toContainText('src/parse.js');
    await expect(feed).not.toContainText('[private details withheld]');expect(await sideScroll(page)).toEqual([]);
    await shoot(page,`projected-finished-${size}-${scheme}`);
  });
}
