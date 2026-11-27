import {test, expect} from '@playwright/test';
import {startHarness} from './lib.mjs';

test('expanded request Details never exposes the sender key or fingerprint', async ({browser}) => {
  test.info().annotations.push({type:'slice', description:'D-request'}, {type:'check', description:'details'});
  const harness = await startHarness(), context = await browser.newContext();
  try {
    const page = await context.newPage(), key = 'sha256:' + 'a'.repeat(64);
    await page.route('**/api/approvals', route => route.fulfill({json:[{
      id:'details-fixture', requester:key, requesterName:'Sam', localName:'Sammy', prompt:'Fix the checkout date.',
      harness:'codex', model:[], source:{kind:'archive', size_bytes:1}, runtimeSeconds:1200,
      expiresAt:Date.now()+600000, network:'provider-only', protection:{satisfied:true, enforced:[], unenforced:[]},
      identity:{memberPresent:true, rosterFresh:true, rootMatches:true, circleMatches:true},
    }]}));
    await page.goto((await harness.link('lender')) + '#/request/details-fixture');
    const details = page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Details$/})});
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    await expect(details).toContainText('Sent from');
    await expect(details).toContainText('Sam');
    await expect(page.locator('main')).not.toContainText(/\bKey\b|fingerprint|sha256:|[a-f0-9]{64}/i);
  } finally { await context.close(); await harness.stop(); }
});
