// The merged U slices the lane verifies, with how to put each screen in a known state and what its main task is.
// `expect` lists known failures, per check, as {id, match, why}: `match` picks the problem out of the check's list.
// U2c ones name U2c (the UI lane's landmark and label fixes); DEFECT-n ones are real defects listed in
// docs/testing-browser.md. Each listed problem must still be there and no other may appear, so a known failure cannot
// hide a new one, and a fixed one fails the lane until its entry is removed.
import { patchHome, patchJson, READINESS, JOBS, withRequestAdmission } from './lib.mjs';

const KNOWN = {
  noCache: {id: 'DEFECT-1', match: /reload offline: the browser shows its own error page/, why: 'nothing caches the app, so a reload while offline shows the browser error page and a draft cannot survive it'},
};

/** Press Tab until the element with this role and name has focus. */
export async function tabTo(page, role, name, max = 45, exact = false) {
  const target = page.getByRole(role, {name, exact}).first();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(el => el === document.activeElement, null, {timeout: 400}).catch(() => false)) return;
  }
  throw new Error('Tab never reached the ' + role + ' "' + name + '" in ' + max + ' presses');
}
const heading = (name, level = 1) => page => page.getByRole('heading', {level, name}).first().waitFor();
const expectHeading = async (page, name, level = 1) => { await page.getByRole('heading', {level, name}).first().waitFor({timeout: 6000}); };
const requests = page => { const seen = []; page.on('request', r => { if (r.url().includes('/api/')) seen.push(r.method() + ' ' + new URL(r.url()).pathname); }); return seen; };
const disabled = async (locator) => locator.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);

/** Lending is on and an agent is signed in, so the Lending page and Home show the running-order screens. */
const lendingOn = async page => {
  await patchHome(page,{effective:{intent:{on:true,state:'ready'},execution:{state:'idle'},version:'fixture-lending-ready'},dailyLimitReached:false},body => ({...body,lending_blockers:null,intent:{on:true,state:'ready'},execution:{state:'idle'},lending:{...(body.lending ?? {}),enabled:true,paused:false,status:'idle'}}));
  await patchJson(page, '**/api/agents', body => body.map(a => ({...a, useForLending: true, signedIn: true, installed: true})));
};
const REQUEST = withRequestAdmission({id:'r1',offer:true,jobDigest:'sha256:'+'a'.repeat(64),requester:'key-r1',requesterName:'Sam',prompt:'The login page loops back to itself after the Google sign-in.',harness:'claude-code-subscription',model:[],runtimeSeconds:1200,
  job:{circle:'c1',created_at:new Date().toISOString(),requirements:{egress:'provider-only',limits:{wall_seconds:1200}}},source:{kind:'archive',size_bytes:1},network:'provider-only',protection:{satisfied:true,enforced:[],unenforced:[]},expiresAt:Date.now()+3600e3,
  identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true}},
  {usage:{jobs:0,jobLimit:3,minutes:0,minuteLimit:60},accountedMilliseconds:0,dailyMinutes:60,now:Date.now()});

export const SLICES = [
  {
    id: 'U2b', title: 'Shell v2', hash: '#/home', ready: heading('What would you like to get done?'),
    async task(page) {
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
      if (!/Skip to content/.test(first)) { page.findings.push('the first Tab stop is "' + first + '", not the skip link'); }
      await tabTo(page, 'link', 'Lending');
      await page.keyboard.press('Enter');
      await expectHeading(page, 'Lending');
      await tabTo(page, 'link', 'Circles');
      await page.keyboard.press('Enter');
      await expectHeading(page, 'Circles');
    },
    // U2c: the account link is named "You", and a badge says how many need you (BUILD-PLAN, changes to merged slices).
    async labels(page) {
      const found = [];
      if (!await page.getByRole('link', {name: 'You', exact: true}).count()) found.push('the account link is not named "You" (it is named after the person and goes to Settings)');
      return found;
    },
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U3', title: 'Lending', hash: '#/lend', fixtures: lendingOn,
    ready: async page => {await heading('Lending')(page);await page.getByRole('switch',{name:'Lending',exact:true}).waitFor();},
    async task(page) {
      const before = await page.getByRole('switch', {name: 'Lending'}).getAttribute('aria-checked');
      await tabTo(page, 'switch', 'Lending');
      await page.keyboard.press('Space');
      await page.waitForFunction(was => document.querySelector('[role=switch][aria-label=Lending],[role=switch]')?.getAttribute('aria-checked') !== was || !!document.querySelector('[role=alert],[role=status]:not(:empty)'), before, {timeout: 6000})
        .catch(() => { throw new Error('pressing Space on the Lending switch gave no visible response'); });
    },
    heldActionName: 'the Lending switch', heldAction: page => disabled(page.getByRole('switch', {name: 'Lending'})),
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U3b', title: 'Lending: Pause', hash: '#/lend',
    async ready(page) { await heading('Lending')(page); await page.getByRole('button', {name:'Pause new jobs…', exact:true}).waitFor(); },
    async fixtures(page) { await lendingOn(page); },
    async task(page) {
      const seen = requests(page);
      await tabTo(page, 'button', 'Pause new jobs…');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', {name: 'Pause new jobs'}).waitFor();
      await tabTo(page, 'button', 'For 1 hour', 8);
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', {name: 'Pause new jobs'}).waitFor({state: 'hidden', timeout: 6000}).catch(() => { throw new Error('choosing "For 1 hour" did not close the Pause sheet'); });
      if (!seen.includes('POST /api/lending/pause')) throw new Error('"For 1 hour" did not ask the app to pause');
    },
    dialog: {
      selector: 'dialog[open]', openerSelector: 'button:has-text("Pause new jobs…")',
      async open(page) { await page.getByRole('button', {name: 'Pause new jobs…'}).focus(); await page.keyboard.press('Enter'); },
    },
    // Opening the sheet needs no network; choosing a time does.
    heldActionName: 'For 1 hour', async heldAction(page) { await page.getByRole('button', {name: 'Pause new jobs…'}).click(); const held = await disabled(page.getByRole('button', {name: 'For 1 hour'})); await page.keyboard.press('Escape'); return held; },
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U4', title: 'Home', hash: '#/home', ready: heading('What would you like to get done?'),
    async fixtures(page) {
      await lendingOn(page);
      await page.route(/\/api\/approvals$/, r => r.request().method() === 'GET' ? r.fulfill({json: [REQUEST]}) : r.continue());
    },
    async task(page) {
      await page.getByText('Sam asked to use your computer').waitFor();
      await tabTo(page, 'link', 'Review request');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash === '#/request/r1', null, {timeout:6000});
      const run=page.getByRole('button',{name:'Run it',exact:true});
      await run.waitFor();
      if(await disabled(run)) throw new Error('the explicitly eligible request was blocked');
    },
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U9', title: 'Setup checklist', hash: '#/setup', ready: heading('Get ready to lend'),
    async fixtures(page) { await patchJson(page, '**/api/home', body => ({...body,lending_blockers:null,intent:{...body.intent,on:false,state:'off'},lending:{...body.lending,enabled:false}})); await page.route(/\/api\/readiness(?:\?.*)?$/, r => r.fulfill({json:{ready:false,observed_at:'2026-10-20T07:14:00Z',checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false},{name:'docker_login',ok:true}]}})); },
    async task(page) {
      let forced = false;
      page.on('request', r => { const url = new URL(r.url()); if (url.pathname === '/api/readiness' && url.searchParams.get('refresh') === 'true') forced = true; });
      await tabTo(page, 'button', 'Check again');
      await page.keyboard.press('Enter');
      // A button must look alive at once: "Checking…" or what it found, within a second.
      await page.getByText(/^(Checking this computer…|Checked )/).first().waitFor({timeout: 1000})
        .catch(() => { throw new Error('Check again showed nothing within a second'); });
      await new Promise(resolve => setTimeout(resolve, 800));
      if (!forced) throw new Error('Check again did not force a fresh readiness check');
    },
    heldActionName: 'Check again', heldAction: page => disabled(page.getByRole('button', {name: 'Check again'}).first()),
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U14', title: 'Jobs list and palette', hash: '#/jobs', ready: async page => { await expectHeading(page, 'Jobs'); await page.getByText('Fix parser').first().waitFor(); },
    async fixtures(page) {
      // The list is only asked for when a circle has a queue address; give the fixture circle one.
      await patchJson(page, /\/api\/circles$/, body => body.map(c => ({...c, origin: c.origin ?? 'https://queue.example'})));
      await page.route(/\/api\/jobs(\?.*)?$/, r => r.request().method() === 'GET' ? r.fulfill({json: JOBS}) : r.continue());
      // The palette's synthetic job also needs a detail response. The job page now shows a
      // skeleton until its own data arrives, rather than an invented placeholder heading.
      await page.route(/\/api\/jobs\/sha256/, route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/changes')) return route.fulfill({json: {format: 'diff', files: [], diff: '', diffstat: {files: 0, insertions: 0, deletions: 0}, checks: []}});
        if (path.endsWith('/transcript')) return route.fulfill({json: {text: '', live: false}});
        return route.fulfill({json: {...JOBS[0], state: 'result-accepted'}});
      });
    },
    async task(page) {
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog', {name: 'Search'}).waitFor();
      await page.keyboard.type('Fix');
      await page.getByRole('option', {name: /Fix parser/}).first().waitFor();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^#\/job\//.test(location.hash), null, {timeout: 6000}).catch(() => { throw new Error('Enter on a search result did not open the job'); });
      await expectHeading(page, 'Fix parser');
    },
    dialog: {
      selector: '[role=dialog]', openerSelector: 'a:has-text("Search or jump to")',
      async open(page) { await page.locator('a:has-text("Search or jump to")').first().focus(); await page.keyboard.press('Control+k'); },
    },
    phoneSetup: async page => { await page.locator('a:has-text("Search or jump to")').first().focus(); await page.keyboard.press('Control+k'); await page.getByRole('dialog', {name: 'Search'}).waitFor(); },
    phoneInput: 'input[aria-label="Search or jump to"]',
    heldActionName: 'the search', heldAction: async () => true,
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U7m', title: 'MVP composer', hash: '#/jobs/new', ready: heading('New job'),
    async task(page) {
      const send = page.getByRole('button', {name: 'Send', exact: true});
      await page.getByLabel('What the agent should do').fill('Make the booking form reject a checkout before check-in.');
      if (!await disabled(send)) page.findings.push('Send is on before any folder was chosen');
      // The Project row opens by itself when a choice is needed; Enter would close it then.
      if (!await page.locator('#cmp-project').evaluate(el => el.open)) {
        await page.locator('#cmp-project > summary').focus();
        await page.keyboard.press('Enter');
      }
      await page.getByRole('textbox',{name:'Project folder',exact:true}).fill('/no/such/folder/anywhere');
      await page.getByRole('textbox',{name:'Project folder',exact:true}).blur();
      await page.getByRole('alert').filter({hasText:'Choose an existing project folder before sending.'}).waitFor({timeout:6000});
      if (!await disabled(send)) page.findings.push('Send is on for a folder that does not exist');
      const reasonId = await send.getAttribute('aria-describedby');
      if (!reasonId || !(await page.locator('#' + reasonId).textContent().catch(() => '')).trim()) page.findings.push('Send is off but says nothing about why');
    },
    heldActionName: 'Send', heldAction: page => disabled(page.getByRole('button', {name: 'Send', exact: true})),
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'H1', title: 'Hosting in the app', hash: '#/circles/host', ready: heading('Start a circle on this computer'),
    async fixtures(page) { await page.route(/\/api\/hosting$/, r => r.fulfill({json: {configured: false}})); },
    async task(page) {
      await page.getByLabel('Circle name').fill('Weekend projects');
      await page.getByRole('radio', {name:/Public HTTPS/}).focus();
      await page.keyboard.press('Space');
      await page.getByText('Review and approve an offer in a terminal on the host computer.').waitFor({timeout:6000});
      if (await page.getByRole('button',{name:'Start circle'}).count()) page.findings.push('public hosting bypasses terminal approval');
      const shown=(await page.locator('.cmd code').textContent()).trim();
      if (shown !== "faravan host --tunnel public --circle-name 'Weekend projects'") page.findings.push('the command is "'+shown+'"');
      await page.getByRole('radio',{name:/Local network only/}).focus();
      await page.keyboard.press('Space');
      await page.getByRole('button',{name:'Start circle'}).waitFor({timeout:6000});
      await page.getByText('Start from a terminal',{exact:true}).focus();
      await page.keyboard.press('Enter');
      await page.getByText('faravan host --tunnel lan --circle-name').waitFor({timeout:6000});
    },
    heldActionName: 'Copy command', heldAction: async () => true,
    expect: {offline:[KNOWN.noCache]},
  },
  {
    id: 'U16', title: 'What you lend', hash: '#/lend/limits', ready: heading('What you lend'),
    async task(page) {
      const seen = requests(page);
      await tabTo(page, 'textbox', 'Jobs a day');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('4');
      await tabTo(page, 'button', 'Save', 45, true);
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!seen.some(r => r.startsWith('POST /api/lending/limits'))) throw new Error('Save with the keyboard did not save the limits');
    },
    draft: {
      async type(page) { await page.getByRole('textbox', {name: 'Jobs a day'}).fill('7'); },
      async kept(page) { return (await page.getByRole('textbox', {name: 'Jobs a day'}).inputValue().catch(() => '')) === '7'; },
    },
    phoneInput: 'main input', heldActionName: 'Save', heldAction: page => disabled(page.getByRole('button', {name: 'Save', exact: true})),
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U20', title: 'Setup failure states', hash: '#/setup', ready: heading('Get ready to lend'),
    async fixtures(page) {
      await page.route('**/api/readiness', r => r.fulfill({json: READINESS.linux}));
      await patchJson(page, '**/api/home', body => ({...body,intent:{...body.intent,on:false,state:'off'},lending:{...body.lending,enabled:false}, desktop: {...(body.desktop ?? {}), platform: 'linux'}}));
    },
    async task(page) {
      await page.getByText(/kvm/i).first().waitFor();
      await tabTo(page, 'button', 'Check again');
      await page.keyboard.press('Enter');
    },
    heldActionName: 'Check again', heldAction: page => disabled(page.getByRole('button', {name: 'Check again'}).first()),
    expect: {offline: [KNOWN.noCache]},
  },
  {
    id: 'U21', title: 'Shell states', hash: '#/home', ready: heading('What would you like to get done?'),
    async fixtures(page) { await patchJson(page, '**/api/home', body => ({...body, update: {ready: true, version: '9.9.9'}})); },
    async task(page) {
      await page.getByText('A new version of Faravan is ready.').waitFor();
      await tabTo(page, 'button', 'Reload');
      const loaded = page.waitForEvent('load', {timeout: 6000});
      await page.keyboard.press('Enter');
      await loaded.catch(() => { throw new Error('Enter on Reload did not reload the page'); });
    },
    heldActionName: 'Reload', heldAction: async () => true, reloads: true,
    expect: {offline: [KNOWN.noCache]},
  },
];
