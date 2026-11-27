// V1: every merged U slice against every check in lib.mjs. One Playwright test per cell of the table.
//
// A known failure (slice.expect[check] = [{id, match, why}]) is checked problem by problem: every listed problem must
// still be there, and no other problem may be. So a known failure cannot hide a new one, and a fixed one shows up as
// a failing cell that says to remove its entry.
import { test, expect } from '@playwright/test';
import { startHarness, patchJson, CHECKS, bannedCopyProblems, JOBS } from './lib.mjs';
import { SLICES } from './slices.mjs';
import { ROUTES } from '../../ui/v1/src/helpers.mjs';
import { projectMembership } from '../../lib/v1/membership-projection.mjs';

let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

for (const slice of SLICES) {
  test.describe(slice.id, () => {
    for (const check of CHECKS) {
      test(`${slice.id} | ${check.id}`, async ({browser }) => {
        test.info().annotations.push({type: 'slice', description: slice.id}, {type: 'check', description: check.id});
        if (check.needs && !check.needs(slice)) test.skip(true, 'n/a: ' + check.na);
        const known = slice.expect?.[check.id] ?? [];
        const result = await check.run(browser, harness.urls, slice);
        const problems = result.ok ? [] : result.problems;
        const unexplained = problems.filter(p => !known.some(k => k.match.test(p)));
        const gone = known.filter(k => !problems.some(p => k.match.test(p)));
        if (known.length) test.info().annotations.push({type: 'known', description: known.map(k => k.id).join(',')});
        if (unexplained.length || gone.length) {
          const note = [...unexplained.map(p => 'NEW: ' + p), ...gone.map(k => 'FIXED? ' + k.id + ' is no longer seen: remove it from expect in slices.mjs')].join('; ');
          test.info().annotations.push({type: 'reason', description: note}, ...(result.shots ?? []).map(s => ({type: 'screenshot', description: s})));
          expect.soft(unexplained, 'a problem that is not a known failure').toEqual([]);
          expect.soft(gone.map(k => k.id), 'a known failure that is gone').toEqual([]);
        } else if (known.length) {
          test.info().annotations.push({type: 'reason', description: problems.join('; ')}, ...(result.shots ?? []).map(s => ({type: 'screenshot', description: s})));
        }
      });
    }
  });
}

// Every route type, including subsections and detail routes, gets the rendered-copy gate.
// The two detail fixtures are the same ones used by the interactive slice checks above.
const jobFixture = SLICES.find(slice => slice.id === 'U14').fixtures;
const requestFixture = SLICES.find(slice => slice.id === 'U4').fixtures;
const circleFixture = async page => {
  await patchJson(page, /\/api\/circles$/, circles =>
    circles.map((circle, index) => index === 0 ? {...circle, origin:'https://queue.example', owned:false} : circle));
  await page.route(/\/api\/jobs\?circle=/, route => route.fulfill({json:[]}));
};
const personFixture = async page => {
  const circle={id:'vocabulary-circle',name:'Weekend projects',origin:'https://fixture.test',owned:true};
  const computer={key_id:'vocabulary-computer',device_name:'Travel laptop'};
  await page.route('**/api/circles',route=>route.fulfill({json:[circle]}));
  await page.route('**/api/devices',route=>route.fulfill({json:{fingerprint:'self',circles:[{circle:circle.id,members:[computer]}]}}));
  await page.route('**/api/circles/'+circle.id+'/people',route=>route.fulfill({json:[{personId:computer.key_id,name:'Morgan',role:'member',blocked:false,computers:[computer]}]}));
  await page.route('**/api/jobs?circle='+circle.id,route=>route.fulfill({json:[]}));
};
// The route id is a flow id. An unknown id is a 404 the app handles ("no longer available"), but the browser logs every
// failed fetch as a console error, so the gate needs a real flow waiting on the browser. No url: a url makes the page
// replace itself with the provider's sign-in page (signin.jsx), which the offline sandbox cannot load.
const signinFixture = async page => {
  await page.route('**/api/signin/claude', route => route.fulfill({json:{flowId:'claude', target:'claude', status:'awaiting_browser', codeEntry:false, url:null, code:null}}));
};
const routeCases = [
  ['home', '#/home'], ['jobs', '#/jobs', jobFixture], ['devices', '#/devices'],
  ['circles', '#/circles'], ['activity', '#/activity'], ['settings', '#/settings'],
  ['trust', '#/trust'], ['lend', '#/lend'], ['limits', '#/lend/limits'],
  ['setup', '#/setup'], ['borrow', '#/new'], ['host', '#/circles/host'],
  ['job', '#/job/' + encodeURIComponent(JOBS[0].job_digest) + '/c1', jobFixture],
  ['person', '#/person/vocabulary-computer/vocabulary-circle', personFixture],
  ['circle', null, circleFixture], ['request', '#/request/r1', requestFixture],
  ['settings/profile', '#/you/profile'], ['settings/notifications', '#/you/notifications'],
  ['settings/data', '#/you/data'], ['telemetry', '#/you/data/telemetry'], ['settings/account', '#/you/account'],
  ['setup/details', '#/setup/details'], ['signin', '#/signin/claude', signinFixture], ['not-found', '#/missing'],
];

test('vocabulary matrix covers every route type', () => {
  const covered = new Set(routeCases.map(([name]) => name.split('/')[0]));
  expect(Object.keys(ROUTES).filter(route => !covered.has(route))).toEqual([]);
});

test('banned copy distinguishes a bare Key label from API key', () => {
  expect(bannedCopyProblems('Claude (API key) and Gemini (API key)')).toEqual([]);
  expect(bannedCopyProblems('Key')).toContain('rendered page contains banned copy: bare Key');
});

test('pending circle does not request jobs before enrollment is approved', async ({browser}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  let jobReads = 0;
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  try {
    await patchJson(page, /\/api\/circles$/, circles => circles.map((circle, index) => {
      if (index !== 0) return circle;
      const pending={...circle,origin:'https://queue.example',owned:false,enrollment:{state:'pending'},
        joinInfo:{approval:'each',ownerName:'Sam'}};
      return {...pending,membershipProjection:projectMembership(pending)};
    }));
    await page.route(/\/api\/jobs\?circle=/, route => {
      jobReads++;
      return route.fulfill({status:409, json:{code:'enrollment_pending'}});
    });
    await page.goto((await harness.link('lender')) + '#/circles');
    const detail = await page.locator('a[href^="#/circle/"]').first().getAttribute('href');
    await page.goto((await harness.link('lender')) + detail);
    await page.getByText('Ask Sam to approve this computer').waitFor();
    await page.waitForTimeout(800);
    expect(jobReads).toBe(0);
    expect(errors).toEqual([]);
  } finally {await context.close();}
});

test('You avatar uses the local person name or the person glyph on both layouts', async ({browser}) => {
  for (const ownerName of ['Alex Example', '']) {
    const context = await browser.newContext({viewport:{width:1280,height:800}});
    const page = await context.newPage();
    try {
      await patchJson(page, /\/api\/devices$/, devices => ({...devices, ownerName, name:'Tessa laptop', fingerprint:'account-tessa'}));
      await page.goto((await harness.link('lender')) + '#/home');
      const desktop = page.locator('a.side-link[href="#/you"] .av');
      await desktop.waitFor();
      const phone = page.locator('.page-head .phone-only .av');
      if (ownerName) {
        await expect(desktop).toHaveText('TN');
        await expect(phone).toHaveText('TN');
      } else {
        await expect(desktop).toHaveText('');
        await expect(phone).toHaveText('');
        await expect(desktop.locator('use')).toHaveAttribute('href', '#user');
        await expect(phone.locator('use')).toHaveAttribute('href', '#user');
      }
    } finally {await context.close();}
  }
});

for (const [name, target, fixture] of routeCases) {
  test(`rendered copy and console | ${name}`, async ({browser}) => {
    const context = await browser.newContext({viewport:{width:1280,height:800}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    try {
      await fixture?.(page);
      let hash = target;
      if (name === 'circle') {
        await page.goto((await harness.link('lender')) + '#/circles');
        hash = await page.locator('a[href^="#/circle/"]').first().getAttribute('href');
      }
      await page.goto((await harness.link('lender')) + hash);
      if (name === 'circle') await page.getByRole('tab', {name:'Members'}).waitFor();
      await page.locator('h1').first().waitFor();
      await page.waitForTimeout(800);
      const heading = await page.locator('h1').first().evaluate(element => {
        const style = getComputedStyle(element);
        return {className:element.className,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight};
      });
      expect(heading.className, `${name} heading role`).toContain('t-page');
      expect(heading.fontFamily, `${name} heading face`).toContain('Source Sans 3');
      expect(heading.fontSize, `${name} heading size`).toBe('34px');
      expect(heading.fontWeight, `${name} heading weight`).toBe('600');
      const visible = await page.locator('body').evaluate(element => element.innerText || '');
      expect(bannedCopyProblems(visible), `${name} visible copy`).toEqual([]);
      expect(errors, `${name} console`).toEqual([]);
      await page.setViewportSize({width:390,height:844});
      const phoneSize = await page.locator('h1').first().evaluate(element => getComputedStyle(element).fontSize);
      expect(phoneSize, `${name} phone heading size`).toBe('30px');
    } finally { await context.close(); }
  });
}

test('circle tabs move focus and selection with arrow keys', async ({browser}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await circleFixture(page);
    await page.goto((await harness.link('lender')) + '#/circles');
    const detail = await page.locator('a[href^="#/circle/"]').first().getAttribute('href');
    await page.goto((await harness.link('lender')) + detail);
    const members = page.getByRole('tab', {name:'Members'});
    await members.focus();
    await members.press('ArrowRight');
    const activity = page.getByRole('tab', {name:'Activity'});
    await expect(activity).toHaveAttribute('aria-selected', 'true');
    await expect(activity).toBeFocused();
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'circle-tab-activity');
    await activity.press('End');
    const settings = page.getByRole('tab', {name:'Settings'});
    await expect(settings).toHaveAttribute('aria-selected', 'true');
    await expect(settings).toBeFocused();
    await settings.press('Home');
    await expect(members).toHaveAttribute('aria-selected', 'true');
    await expect(members).toBeFocused();
    await members.press('ArrowLeft');
    await expect(settings).toBeFocused();
  } finally {await context.close();}
});
