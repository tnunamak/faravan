import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';

// Judge r10 R2: a Send that a busy host refused (429 rate_limited, not applied) never ends in a refusal. The page
// keeps "Sending…" and asks again with the same draft id, the send's idempotency key, until the host takes it.
let harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.stop(); });

const circle = {id:'busy-circle', name:'Busy circle', origin:'https://circle.example', enrollment:{state:'approved'}, rosterMembershipVerified:true};
const digest = 'sha256:' + 'c'.repeat(64);
const prompt = 'Send this through a busy host.', path = '/fixture/project';

test('a Send refused by a busy host keeps Sending… and lands with the same draft id', async ({page}) => {
  await page.addInitScript(id => localStorage.setItem('faravan-compose-circle', id), circle.id);
  const calls = [];
  await page.route('**/api/circles', route => route.fulfill({json:[circle]}));
  await page.route('**/api/circles/*/compose', route => route.fulfill({json:{circle:circle.id, networked:true, host:{reachable:true}, lenders:[]}}));
  await page.route('**/api/repo/inspect', route => route.fulfill({json:{path, name:'fixture-project', branch:'main', head:'b'.repeat(40), files:2, changed:[], changed_count:0}}));
  await page.route(/\/api\/jobs(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'POST') return route.fulfill({json:[]});
    calls.push(route.request().postDataJSON());
    if (calls.length <= 2) return route.fulfill({status:429, headers:{'retry-after':'1'}, json:{code:'rate_limited', outcome:'not_applied', message:'busy'}});
    return route.fulfill({json:{jobDigest:digest}});
  });
  await page.route('**/api/jobs/*', route => route.fulfill({json:{job_digest:digest, circle, state:'queued', local:{title:prompt, prompt}}}));
  await page.goto((await harness.link('owner')) + '#/new');
  if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
  await page.getByLabel('What the agent should do').fill(prompt);
  const folder = page.getByRole('textbox', {name:'Project folder', exact:true});
  await folder.fill(path); await folder.press('Enter');
  await expect(page.locator('#cmp-meta')).toContainText('fixture-project');
  await folder.blur();
  const refusal = /busy for a moment|handling other requests|Nothing changed|try again/i;
  await page.getByRole('button', {name:'Send', exact:true}).click();
  await confirmFirstSend(page);
  await expect(page.getByRole('button', {name:'Sending…', exact:true})).toBeVisible();
  await expect.poll(() => calls.length, {timeout:10000}).toBe(2);
  await expect(page.locator('#main')).not.toContainText(refusal);
  await expect(page).toHaveURL(/#\/job\//, {timeout:10000});
  expect(calls.length).toBe(3);
  expect(new Set(calls.map(call => call.draft_id)).size).toBe(1);
});
