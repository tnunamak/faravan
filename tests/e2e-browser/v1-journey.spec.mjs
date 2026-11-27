import {freshLink} from '../helpers/fresh-link.mjs';
// Real lender + borrower journeys through the v1 web UI (role/label locators only).
// Backing services come from v1-harness.mjs: in-process queue server, fake sandbox backend.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const harnessPath = fileURLToPath(new URL('./v1-harness.mjs', import.meta.url));
const DESKTOP = {width: 1280, height: 800}, PHONE = {width: 390, height: 844};
const CIRCLE = 'Weekend projects', LENDER_NAME = 'Lender laptop';

let harness, urls;
const link=name=>freshLink(urls[name],urls.tokens[name]);
test.beforeAll(async () => {
  harness = spawn(process.execPath, [harnessPath], {stdio: ['ignore', 'pipe', 'inherit']});
  const lines = createInterface({input: harness.stdout});
  urls = JSON.parse(await Promise.race([
    once(lines, 'line').then(([line]) => line),
    once(harness, 'exit').then(([code]) => {throw new Error('harness exited early: ' + code);}),
  ]));
});
test.afterAll(async () => {
  if (!harness || harness.exitCode !== null) return;
  harness.kill('SIGTERM');
  await once(harness, 'exit');
});

// The shell shows the four destinations in a sidebar (desktop) or a tab bar (phone). A badge adds "1 needs you" to the link's name.
const nav = (page, name) => page.getByRole('navigation', {name: 'Main'}).first().getByRole('link', {name: new RegExp(`^${name}\\b`)}).click();
// Devices and Settings are not main destinations; follow the app's own address.
const openDevices = page => page.evaluate(() => {location.hash = '#/devices';});
async function expectNoHorizontalScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page must not scroll sideways').toBeLessThanOrEqual(0);
}
async function submitFilesJob(page, {title, prompt}) {
  await nav(page, 'Jobs');
  await page.getByRole('link', {name: /Run a job|New job/}).first().click();
  // The composer sends a folder on this computer; files and links are the other way in.
  await page.getByRole('button', {name: 'Send files or a repository link instead'}).click();
  await page.getByRole('combobox', {name: 'Run on'}).selectOption({label: CIRCLE});
  await page.getByLabel('Job title').fill(title);
  await page.getByLabel('What should the agent do?').fill(prompt);
  await page.getByRole('combobox', {name: /^Source\b/}).selectOption('files');
  await page.getByLabel('Choose files').setInputFiles([
    {name: 'README.md', mimeType: 'text/markdown', buffer: Buffer.from('# Synthetic project\n')},
    {name: 'app.js', mimeType: 'text/javascript', buffer: Buffer.from('console.log("hi");\n')},
  ]);
  await expect(page.getByText(/^2 files · /)).toBeVisible();
  // The default is "whatever your circle lends": no agent or model to pick.
  await expect(page.getByRole('paragraph').filter({hasText: 'Whatever your circle lends (recommended)'})).toBeVisible();
  await page.getByRole('button', {name: 'Review job'}).click();
  await expect(page.getByRole('heading', {name: 'Send this job?'})).toBeVisible();
  await page.getByRole('button', {name: 'Submit job'}).click();
}

test('lender and borrower journey through the web UI', async ({browser}) => {
  const context = await browser.newContext({viewport: DESKTOP, permissions: ['clipboard-read', 'clipboard-write']});
  const owner = await context.newPage(), lender = await context.newPage();
  // Record system notifications instead of showing them; permission is already granted.
  await lender.addInitScript(() => {
    window.__notes = [];
    window.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted';
      constructor(title, options) { window.__notes.push({title, body: options?.body, tag: options?.tag}); } close() {} };
  });
  const pageErrors = [];
  for (const page of [owner, lender]) page.on('pageerror', error => pageErrors.push(error.message));

  await test.step('owner: first run shows My devices at both viewport sizes', async () => {
    await owner.goto(await link('owner'));
    await expect(owner.getByRole('heading', {name: 'Home', level: 1})).toBeVisible();
    await expect(owner.getByRole('heading', {name: /is ready to lend$/})).toBeVisible();
    await expect(owner.getByRole('link', {name: /Lending is off/})).toBeVisible();
    // A brand-new owner gets one primary action; lending controls wait until there is a circle to lend to.
    await expect(owner.getByRole('main').locator('.btn-primary')).toHaveText(['Start a circle']);
    await expect(owner.getByRole('heading', {name: 'Lending on this computer'})).toHaveCount(0);
    await owner.setViewportSize(PHONE);
    await expect(owner.getByRole('link', {name: 'Start a circle'})).toBeVisible();
    await expectNoHorizontalScroll(owner);
    await owner.screenshot({path: 'test-artifacts/e2e-v1/home-390.png'});
    await owner.setViewportSize(DESKTOP);
    await owner.screenshot({path: 'test-artifacts/e2e-v1/home-1280.png'});
  });

  await test.step('owner: reloading the tab keeps the session and keeps the token out of the URL', async () => {
    expect(owner.url()).not.toContain('token');
    await owner.reload();
    await expect(owner.getByRole('heading', {name: 'Home', level: 1})).toBeVisible();
    // The shell says nothing while updates flow; it speaks only when they pause.
    await expect(owner.getByText(/Live updates/)).toHaveCount(0);
    expect(owner.url()).not.toContain('token');
    // A tab with no saved session (a new context) is asked for the local app link instead of seeing a raw error.
    const stranger = await browser.newPage();
    await stranger.goto(urls.owner.split('?')[0]);
    await expect(stranger.getByText('Reopen the local app link from Faravan to reconnect.')).toBeVisible();
    await stranger.close();
  });

  let invite;
  await test.step('owner: create a circle, create an invitation and copy the link', async () => {
    await owner.getByRole('link', {name: 'Start a circle'}).click();
    await owner.getByLabel('Circle name').fill(CIRCLE);
    await owner.getByLabel('Server address').fill(urls.queue);
    await owner.getByRole('button', {name: 'Create circle'}).click();
    await expect(owner.getByRole('heading', {name: CIRCLE, level: 2})).toBeVisible();
    await owner.getByRole('button', {name: 'Create invitation'}).click();
    await expect(owner.getByText('Invitation created.')).toBeVisible();
    await owner.getByRole('button', {name: 'Copy invitation'}).click();
    await expect(owner.getByText('Invitation copied.')).toBeVisible();
    invite = await owner.evaluate(() => navigator.clipboard.readText());
    // The app hands out the short link: origin, /i/<code>, and the seed alone in the fragment.
    expect(invite).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/i\/[a-z2-7]{10}#[A-Za-z0-9_-]{43}$/);
    expect(invite.length).toBeLessThan(100);
  });

  await test.step('invitee: the landing page names the inviter after checking the invitation in the browser', async () => {
    const landing = await context.newPage();
    landing.on('pageerror', error => pageErrors.push(error.message));
    const fetches = [];
    landing.on('request', request => fetches.push(request.url()));
    await landing.goto(invite);
    await expect(landing.getByRole('heading', {level: 1, name: new RegExp(`^.+ invited you to ${CIRCLE}\\.$`)})).toBeVisible();
    await expect(landing.getByText('Checked in this browser: this invitation matches the link you were sent.')).toBeVisible();
    // "I already have Faravan" is one tap into the installed app, with the paste steps as the fallback.
    const open = landing.getByRole('link', {name: 'I already have Faravan'});
    await expect(open).toHaveAttribute('href', /^faravan:\/\/join\?link=/);
    expect(new URL(await open.getAttribute('href')).searchParams.get('link')).toBe(invite);
    // The seed left the address bar and was never requested; only the public lookup went out.
    expect(landing.url()).toBe(invite.split('#')[0]);
    const seed = invite.split('#')[1];
    expect(fetches.filter(url => url.includes(seed))).toEqual([]);
    expect(fetches.some(url => url.endsWith('/v1/invites/' + invite.split('/i/')[1].split('#')[0]))).toBe(true);
    await expectNoHorizontalScroll(landing);
    await landing.screenshot({path: 'test-artifacts/e2e-v1/landing-1280.png'});
    await landing.setViewportSize(PHONE);
    await expectNoHorizontalScroll(landing);
    await landing.screenshot({path: 'test-artifacts/e2e-v1/landing-390.png'});
    await landing.close();
  });

  await test.step('lender: the handed-over link opens the join review in the app but joins nothing', async () => {
    // This is the URL `faravan open-link` opens: the app address plus the invitation in the fragment.
    const handoff = await context.newPage();
    handoff.on('pageerror', error => pageErrors.push(error.message));
    await handoff.goto((await link('lender')) + '#/circles?join=' + encodeURIComponent(invite));
    await expect(handoff.getByLabel('Invitation')).toHaveValue(invite);
    await expect(handoff.getByRole('heading', {name: new RegExp(`^.+ invited you to ${CIRCLE}\\.$`)})).toBeVisible();
    await expect(handoff.getByRole('button', {name: 'Join circle'})).toBeVisible();
    await expect(handoff.getByText('Check the circle for approval.')).toHaveCount(0);
    expect(handoff.url()).not.toContain('join=');
    expect(handoff.url()).not.toContain(invite.split('#')[1]);
    await handoff.close();
  });

  await test.step('lender: name the computer, then join by pasting the link', async () => {
    await lender.goto(await link('lender'));
    await openDevices(lender);
    await lender.getByLabel('Name this computer').fill(LENDER_NAME);
    await lender.getByRole('button', {name: 'Save name'}).click();
    await expect(lender.getByText('Saved.')).toBeVisible();
    await nav(lender, 'Circles');
    // Headless Chromium ignores Ctrl+V, so paste = read the shared clipboard and fill the field.
    await lender.getByLabel('Invitation').fill(await lender.evaluate(() => navigator.clipboard.readText()));
    await expect(lender.getByLabel('Invitation')).toHaveValue(invite);
    await lender.getByRole('button', {name: 'Review invitation'}).click();
    await expect(lender.getByRole('heading', {name: new RegExp(`^.+ invited you to ${CIRCLE}\\.$`)})).toBeVisible();
    await expect(lender.getByText('Joining does not turn lending on.').first()).toBeVisible();
    // The LAN warning only applies to private-network invitations; the loopback fixture has none.
    if (/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(urls.queue)) {
      await expect(lender.getByText(/local network|LAN/i).first()).toBeVisible();
    }
    await lender.getByRole('button', {name: 'Join circle'}).click();
    await expect(lender.getByText('Check the circle for approval.')).toBeVisible();
  });

  await test.step('lender: Check again fetches the signed roster and clears the waiting status', async () => {
    // The owner's app approves this computer in the background; this computer learns it only by asking the queue.
    await nav(lender, 'Circles');
    await lender.getByRole('link', {name: CIRCLE}).first().click();
    await expect(lender.getByText('Waiting for approval', {exact: true}).first()).toBeVisible();
    await expect(async () => {
      const again = lender.getByRole('button', {name: 'Check again'});
      if (await again.count()) await again.click({timeout: 1000}).catch(() => {});
      await expect(lender.getByText('Waiting for approval')).toHaveCount(0, {timeout: 3000});
    }).toPass({timeout: 20_000});
    await expect(lender.getByRole('button', {name: 'Check again'})).toHaveCount(0);
  });

  await test.step('lender: agent, reset bound, ask each time, lending on', async () => {
    await nav(lender, 'Lending');
    await expect(lender.getByRole('heading', {name: 'Lending', level: 1, exact: true})).toBeVisible();
    await expect(lender.getByRole('heading', {name: 'Agents you lend', level: 2})).toBeVisible();
    // Agents are listed by name with their own switch; the adapter ID sits in a closed Details disclosure.
    await expect(lender.getByText('codex', {exact: true})).toBeHidden();
    await lender.getByRole('switch', {name: 'Lend with Codex'}).click();
    await expect(lender.getByText('Codex is ready to lend when lending is on.')).toBeVisible();
    await expect(lender.getByRole('switch', {name: 'Lend with Codex'})).toBeChecked();
    // A computer in two circles picks which one to lend to on this page; there is no picker in the shell.
    await lender.getByRole('radio', {name: new RegExp(CIRCLE)}).click();
    await expect(lender.getByRole('radio', {name: new RegExp(CIRCLE)})).toBeChecked();
    await lender.getByRole('link', {name: 'Edit'}).click();
    await expect(lender.getByRole('heading', {name: 'What you lend', level: 1})).toBeVisible();
    await expect(lender.getByText('Anyone without a rule: Faravan shows you the request first.')).toBeVisible();
    await expect(lender.getByRole('switch', {name: 'Stop a running job when I return'})).toBeChecked();
    await expect(lender.getByLabel('Longest job')).toHaveCount(0);
    await nav(lender, 'Lending');
    await expect(lender.getByText('No cap', {exact:true})).toHaveCount(2);
    await expect(lender.getByText('Must fit before reset', {exact:true})).toBeVisible();
    await expect(lender.getByRole('heading', {name: 'Lends to', level: 2})).toBeVisible();
    await expect(lender.getByText('One circle at a time for now.')).toBeVisible();
  });

  await test.step('owner: the redeemed invitation is approved without a click', async () => {
    // The owner is still on the circle page: the new member must appear without navigating away.
    await expect(owner.getByText(/^Member 2/)).toBeVisible({timeout: 20_000});
    await expect(owner.getByRole('button', {name: `Approve ${LENDER_NAME}`})).toHaveCount(0);
  });

  await test.step('borrower: submit a job from uploaded files and wait for a lender', async () => {
    await submitFilesJob(owner, {title: 'Greeting', prompt: 'Write a friendly greeting into hello.txt.'});
    // The title typed in the form is the job's title, not the first words of the prompt.
    await expect(owner.getByRole('heading', {name: 'Greeting', level: 1, exact: true})).toBeVisible();
    // M7: where it was sent and when it expires; never a start or finish time.
    await expect(owner.getByText('Waiting for a computer', {exact: true}).first()).toBeVisible();
    await expect(owner.getByText(/^Sent to .+\. A lender’s computer takes it when it is free and has time left today\. Expires .+ if nobody takes it\.$/)).toBeVisible();
    await expect(owner.getByRole('button', {name: 'Copy a nudge'}).first()).toBeVisible();
    await owner.screenshot({path: 'test-artifacts/e2e-v1/borrower-waiting.png'});
  });

  await test.step('lender: turn lending on', async () => {
    await nav(lender, 'Circles');
    await lender.getByRole('link', {name: CIRCLE}).first().click();
    await nav(lender, 'Home');
    // An invited lender sees one next step; its button is the only way to turn lending on here.
    const next = lender.getByRole('region', {name: 'Your next step'}).or(lender.locator('section,article').filter({has: lender.getByRole('heading', {name: 'Your next step'})})).first();
    await expect(next.getByRole('heading', {name: 'Ready to turn lending on'})).toBeVisible();
    await expect(next.getByText('Press Turn lending on below when you are ready.')).toBeVisible();
    await lender.getByRole('switch', {name: 'Lending'}).click();
    await expect(lender.getByRole('switch', {name: 'Lending'})).toBeChecked();
  });

  await test.step('lender: review card shows requester and size; accept; job runs', async () => {
    await nav(lender, 'Home');
    // Away from the Lend page, a new request raises one notification and counts in the tab title.
    await expect.poll(() => lender.evaluate(() => window.__notes.length), {timeout: 15000}).toBe(1);
    const [note] = await lender.evaluate(() => window.__notes);
    expect(note.title).toMatch(/ asked for your help$/);
    expect(note.body).toBe('A job is waiting for your review.', 'task text never goes to the OS notification');
    await expect(lender).toHaveTitle('(1) Review job · Faravan');
    // The Home tab carries the same count as the tab title.
    await expect(lender.getByRole('navigation', {name: 'Main'}).first().getByRole('link', {name: /^Home\b.*1 needs you/})).toBeVisible();
    await expect(lender.getByRole('heading', {name: 'Needs you', level: 2})).toBeVisible();
    await lender.getByRole('link', {name: 'Review', exact: true}).click();
    // The request page: who asked, what, what it can do on this computer, then Not now and Run it.
    const card = lender.getByRole('main');
    await expect(lender.getByRole('heading', {level: 1, name: / asked for help$/})).toBeVisible();
    await expect(card.getByText('Write a friendly greeting into hello.txt.')).toBeVisible();
    await expect(card.getByText(/^Uploaded files · \d/)).toBeVisible();
    await expect(card.getByRole('heading', {level: 2, name: /^What this job can do on your /})).toBeVisible();
    await expect(card.getByRole('button', {name: 'Run it'})).toBeVisible();
    await expect(card.getByRole('button', {name: 'Not now'})).toBeVisible();
    // Identity details (names, circle, key) sit behind Details so the task and buttons come first.
    await card.locator('summary', {hasText: /^Details$/}).click();
    // A private local name: explicit, bound to the shown key, and the headline uses it.
    await card.getByRole('button', {name: 'Save a local name'}).click();
    await expect(card.getByText('This name is private to this computer.', {exact: false})).toBeVisible();
    await card.getByLabel('Your local name').fill('Owner from e2e');
    await card.getByRole('button', {name: 'Save local name'}).click();
    const named = lender.getByRole('main');
    await expect(lender.getByRole('heading', {level: 1, name: 'Owner from e2e asked for help'})).toBeVisible();
    // Saving re-issues the card for the new name (the page follows it), so its Details start closed again.
    if (!(await named.getByText('Device name (from the circle)').isVisible())) await named.locator('summary', {hasText: /^Details$/}).click();
    await expect(named.getByText('Device name (from the circle)')).toBeVisible();
    await expect(named.getByRole('button', {name: 'Change local name'})).toBeVisible();
    await expect(named.getByText(/^This device: today 0 jobs, 0 min · no device limit$/)).toBeVisible();
    await lender.screenshot({path: 'test-artifacts/e2e-v1/review-local-name.png'});
    await lender.screenshot({path: 'test-artifacts/e2e-v1/review-1280.png'});
    await lender.setViewportSize(PHONE);
    await expect(named.getByRole('button', {name: 'Run it'})).toBeVisible();
    await expectNoHorizontalScroll(lender);
    await lender.screenshot({path: 'test-artifacts/e2e-v1/review-390.png'});
    await lender.setViewportSize(DESKTOP);
    await named.getByRole('button', {name: 'Run it'}).click();
    // Answering returns to Home; the result stays in the page-level status region until the page changes.
    const sent = lender.getByRole('status').filter({hasText: 'Accepted.'});
    await expect(sent).toBeVisible();
    await nav(lender, 'Home');
    await expect(sent).toHaveCount(0);
  });

  await test.step('borrower: job reaches Finished; the result downloads', async () => {
    // The one status word says the result is ready; the page then shows the changes, not the four steps.
    await expect(owner.getByText('Ready to review').first()).toBeVisible({timeout: 30_000});
    await owner.getByRole('tab', {name: 'Changes'}).click();
    await owner.getByRole('button', {name: 'Check result'}).click();
    const download = owner.getByRole('link', {name: /^Download (result|patch)$/});
    await expect(download).toBeVisible();
    const [file] = await Promise.all([owner.waitForEvent('download'), download.click()]);
    expect(file.suggestedFilename()).not.toBe('');
    // The borrower records a private verdict; it stays separate from the receipt.
    const verdict = owner.getByRole('region', {name: 'Your verdict (private to this computer)'});
    await verdict.getByLabel('Your verdict').selectOption({label: 'Used it'});
    await verdict.getByLabel('Checks you ran (optional)').fill('Opened hello.txt; greeting present.');
    await verdict.getByRole('button', {name: 'Save verdict'}).click();
    await expect(verdict.getByRole('button', {name: 'Clear verdict'})).toBeEnabled();
    await verdict.screenshot({path: 'test-artifacts/e2e-v1/borrower-verdict.png'});
  });

  await test.step('borrower: Home shows the latest job and one primary action', async () => {
    await nav(owner, 'Home');
    const jobs = owner.getByRole('region', {name: 'Your jobs'});
    await expect(jobs.getByRole('link', {name: /^Greeting/})).toBeVisible();
    await expect(jobs.getByText('Ready to review')).toBeVisible();
    await expect(owner.getByRole('main').locator('.btn-primary')).toHaveCount(0); // nothing needs the borrower, so no primary action
    await expect(owner.getByRole('link', {name: 'New job'}).first()).toBeVisible();
    await owner.screenshot({path: 'test-artifacts/e2e-v1/home-borrower-1280.png'});
  });

  await test.step('lender: pause lending, see the Off state, then turn it back on', async () => {
    await nav(lender, 'Home');
    const lending = lender.getByRole('switch', {name: 'Lending'});
    await expect(lending).toBeChecked();
    await lending.click();
    await expect(lender.getByText('No new jobs will start. A running job may finish.')).toBeVisible();
    await expect(lending).not.toBeChecked();
    await expect(lender.getByText(/1 of 5 jobs today/).last()).toBeVisible();
    await lender.screenshot({path: 'test-artifacts/e2e-v1/lender-off-1280.png'});
    await lending.click();
    await expect(lending).toBeChecked();
  });

  await test.step('lender: stop a second, running job; lending ends up Off', async () => {
    await fetch(urls.control + '/hold', {method: 'POST'});
    await submitFilesJob(owner, {title: 'Slow job', prompt: 'Take your time.'});
    await nav(lender, 'Home');
    await lender.getByRole('link', {name: 'Review', exact: true}).click();
    await lender.getByRole('main').getByRole('button', {name: 'Run it'}).click();
    await nav(lender, 'Home');
    await lender.getByRole('button', {name: /^Stop .*job…$/}).click();
    const dialog = lender.getByRole('dialog', {name: 'Stop this job?'});
    await expect(dialog.getByText('The job stops now. The person who asked will see it was stopped.')).toBeVisible();
    await dialog.getByRole('button', {name: 'Stop this job'}).click();
    await expect(dialog).toBeHidden();
    await expect(lender.getByRole('button', {name: /^Stop .*job…$/})).toHaveCount(0, {timeout: 20_000});
    // Stopping a job pauses lending; it stays Off until the lender turns it on again.
    await expect(lender.getByRole('switch', {name: 'Lending'})).not.toBeChecked();
    await lender.screenshot({path: 'test-artifacts/e2e-v1/lender-stopped-1280.png'});
    // The borrower's job page says the lender stopped it, not just "Waiting".
    await expect(owner.getByText('The lender stopped this job on their computer. It is waiting for another lender.')).toBeVisible({timeout: 20_000});
    // The copy matches the Stop this job button that exists.
    await lender.evaluate(() => {location.hash = '#/trust';});
    await expect(lender.getByText(/or you can end it with Stop this job on Home\./)).toBeVisible();
    await expect(lender.getByText(/stopping a lent job directly is not available/i)).toHaveCount(0);
    await lender.evaluate(hash => {location.hash = hash;}, new URL(owner.url()).hash);
    await expect(lender.getByText('If this computer is running it, use Stop this job on Home.')).toBeVisible();
  });

  await test.step('owner approves a third computer by hand; the list, the result and the members update in place', async () => {
    const GUEST_NAME = 'Guest laptop';
    // Last on purpose: the synthetic queue only accepts requests signed at its newest roster epoch,
    // so a lender that missed this approval could not refresh.
    await nav(owner, 'Circles');
    await owner.getByRole('link', {name: CIRCLE}).first().click();
    await owner.getByRole('checkbox', {name: 'Approve each computer'}).check();
    await owner.getByRole('button', {name: 'Create invitation'}).click();
    await expect(owner.getByText('Invitation created.')).toBeVisible();
    await owner.getByRole('button', {name: 'Copy invitation'}).click();
    await expect(owner.getByText('Invitation copied.')).toBeVisible();
    const guestInvite = await owner.evaluate(() => navigator.clipboard.readText());

    const guest = await context.newPage();
    guest.on('pageerror', error => pageErrors.push(error.message));
    await guest.goto(await link('guest'));
    await openDevices(guest);
    await guest.getByLabel('Name this computer').fill(GUEST_NAME);
    await guest.getByRole('button', {name: 'Save name'}).click();
    await expect(guest.getByText('Saved.')).toBeVisible();
    await nav(guest, 'Circles');
    await guest.getByLabel('Invitation').fill(guestInvite);
    await guest.getByRole('button', {name: 'Review invitation'}).click();
    await guest.getByRole('button', {name: 'Join circle'}).click();
    await expect(guest.getByText('Check the circle for approval.')).toBeVisible();

    // The owner never navigates: the request appears from the live event stream.
    const request = owner.getByRole('article').filter({has: owner.getByRole('heading', {name: GUEST_NAME})});
    await expect(request).toBeVisible({timeout: 20_000});
    const code = (await request.getByText(/^Match code/).textContent()).replace('Match code', '').trim();
    expect(code).toMatch(/^[0-9A-F]{6}$/);

    await nav(guest, 'Circles');
    await guest.getByRole('link', {name: CIRCLE}).first().click();
    await expect(guest.getByText('Waiting for approval', {exact: true}).first()).toBeVisible();
    await expect(guest.getByText(code).first()).toBeVisible();
    // The two apps share one machine in this test and may refuse once as busy; a person would click again.
    await expect(async () => {
      const again = guest.getByRole('button', {name: 'Check again'});
      if (await again.count()) await again.click({timeout: 1000}).catch(() => {});
      await expect(guest.getByRole('status').filter({hasText: 'Checked.'})).toBeVisible({timeout: 3000});
    }).toPass({timeout: 20_000});

    // Retry a busy action, but never replay an approval that already returned 200.
    // The request card can survive the successful response while its list refreshes.
    let approved = false;
    const observeApproval = response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/approve') && response.ok()) approved = true;
    };
    const notice = owner.getByRole('status').filter({hasText: 'Approved. Lending remains off.'});
    owner.on('response', observeApproval);
    try {
      await expect(async () => {
        const approve = request.getByRole('button', {name: `Approve ${GUEST_NAME}`});
        if (!approved && await approve.count()) await approve.click({timeout: 1000}).catch(() => {});
        await expect(notice).toBeVisible({timeout: 3000});
      }).toPass({timeout: 20_000});
    } finally {
      owner.off('response', observeApproval);
    }
    await expect(request).toHaveCount(0, {timeout: 3000});
    await expect(owner.getByText(/^Member 3/)).toBeVisible({timeout: 20_000});
    // Check again (or the app's 5-second check) brings the guest into the circle.
    await expect(async () => {
      const again = guest.getByRole('button', {name: 'Check again'});
      if (await again.count()) await again.click({timeout: 1000}).catch(() => {});
      await expect(guest.getByText('Waiting for approval')).toHaveCount(0, {timeout: 1000});
    }).toPass({timeout: 20_000});
    await guest.close();
  });

  expect(pageErrors, 'uncaught page errors').toEqual([]);
  await context.close();
});
