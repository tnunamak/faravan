import {test, expect} from '@playwright/test';
import {legacyProxyHarness} from '../helpers/legacy-proxy-harness.mjs';
import {appFixture, api} from '../helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from '../helpers/pace50-synthetic-source.mjs';

test('a fresh Ask-mode lender shows open quota for each signed-in account after a zero reading', {timeout: 90000}, async ({browser}) => {
  const cleanups = [], observed = [];
  const f = await appFixture({after: fn => cleanups.push(fn)});
  const source = createSyntheticPace50Source({start: Date.now(), used: {weekly: 0, short: 0}});
  const observe = source.observe.bind(source);
  source.observe = async args => {
    observed.push(args.provider);
    return observe(args);
  };
  const adapters = () => [
    {spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true, harnessVersion: 'synthetic-only',
      models: ['claude-haiku-5-5'], run: {model: 'claude-haiku-5-5'}, capabilities: []},
    {spec: legacyProxyHarness('codex'), installed: true, signedIn: true, harnessVersion: 'synthetic-only',
      models: ['gpt-6-sol'], run: {model: 'gpt-6-sol'}, capabilities: []},
  ];
  let context;
  try {
    const {lender, circle} = await f.connect({adapters, lendingPace50: {
      account_week_id: 'synthetic-week-1', source,
    }});
    await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
      dailyJobs: null, dailyMinutes: null, maxWallSeconds: null, idleOnly: false,
      lendingPolicy: {accountPlans: {claude: 'max20', codex: 'plus'}},
    }});
    const signedIn = (await api(lender.app, '/api/agents')).filter(agent => agent.signedIn === true).map(agent => agent.id).sort();
    expect(signedIn).toEqual(['claude-code-subscription', 'codex']);

    context = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await context.newPage();
    await page.goto(new URL('#/lend', lender.app.url).toString());
    await expect(page.getByRole('heading', {name: 'Lending', level: 1})).toBeVisible();
    for (const name of ['Claude', 'Codex']) {
      const control = page.getByRole('switch', {name: 'Lend with ' + name});
      if (!(await control.isChecked())) await control.click();
      await expect(control).toBeChecked();
    }
    const lending = page.getByRole('switch', {name: 'Lending', exact: true});
    observed.length = 0;
    if (!(await lending.isChecked())) await lending.click();
    await expect(lending).toBeChecked();
    await expect(page.getByText('Ask me each time', {exact: true})).toBeVisible();
    await api(lender.app, '/api/lending');
    await expect.poll(() => observed.length).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByRole('heading', {name: 'Lending', level: 1})).toBeVisible();
    const quota = page.locator('[aria-labelledby="quota-open-heading"]');
    await expect(quota).toBeVisible();
    await expect.poll(async () => {
      const lines = (await quota.innerText()).split('\n').filter(Boolean);
      return ['Claude', 'Codex'].every(name => lines.some(line => line.startsWith(name + ' ·') &&
        Number(line.match(/About ([\d.]+)%/)?.[1]) > 0 && line.includes('you approve each job')));
    }).toBe(true);
    await expect(page.getByText('Ready for requests', {exact: true}).first()).toBeVisible();
  } finally {
    await context?.close();
    await Promise.all(cleanups.reverse().map(cleanup => cleanup()));
  }
});
