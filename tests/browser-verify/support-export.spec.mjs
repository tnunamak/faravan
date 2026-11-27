import '../helpers/no-browser.mjs';
import {test, expect} from '@playwright/test';
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {startApp} from '../../lib/v1/app.mjs';
import {readArchiveFiles} from '../../lib/archive.mjs';
import {syntheticBackend} from '../helpers/v1-app-fixture.mjs';

test('support preview downloads exactly the reviewed archive through the real app', async ({page}) => {
  const scratch = fileURLToPath(new URL('../../test-artifacts/support-browser/', import.meta.url));
  await mkdir(scratch, {recursive:true});
  const root = await mkdtemp(join(scratch,'case-')), home = join(root,'profile');
  await mkdir(join(home,'v1'), {recursive:true});
  const secret = 'PLANTED_BROWSER_PRIVATE_CONTENT';
  await writeFile(join(home,'v1','app-settings.json'), JSON.stringify({version:1,name:secret,intent:'off',enabled:false,
    token:secret, prompt:secret, futureSecret:secret, limits:{dailyJobs:3}, agents:{}}));
  const app = await startApp({home,origin:null,port:0,freshLending:'off',adapters:[],
    backendFactory:() => syntheticBackend(root), env:{DO_NOT_TRACK:'1'}, fetch:async () => {throw new Error('offline');}});
  try {
    const job = 'sha256:' + 'c'.repeat(64);
    await mkdir(join(home,'v1','history'), {recursive:true});
    await writeFile(join(home,'v1','history','events.jsonl'), JSON.stringify({at:'2026-10-28T00:00:00.000Z',
      type:'job',job,data:{state:'queued',prompt:secret}}) + '\n');
    await page.goto(app.url);
    await page.evaluate(() => {location.hash = '#/you/data';});
    await expect(page.getByText('Saving downloads this archive to your computer; it does not send it to support.', {exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Preview support export',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Save support archive',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Preview support export',exact:true}).click();
    // <pre> has an accessible label and keyboard focus, independent of its implicit role.
    const pre = page.locator('pre[aria-label="Diagnostic preview entry 1"]');
    await expect(pre).toBeVisible();
    await expect(pre).toBeFocused();
    const shown = await pre.textContent();
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain(job);
    expect(JSON.parse(shown).jobs[0].id).toMatch(/^job:[0-9a-f]{32}$/);
    let requestsAfterPreview = 0;
    page.on('request', request => {if (request.url().includes('/api/ops/diagnostics.preview')) requestsAfterPreview++;});
    const pending = page.waitForEvent('download');
    await page.getByRole('button',{name:'Save support archive',exact:true}).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('faravan-support.tar.gz');
    const output = join(root,'browser-saved.tar.gz');
    await download.saveAs(output);
    const bytes = await readFile(output);
    expect(readArchiveFiles(bytes).map(file => file.path)).toEqual(['support.json']);
    expect(readArchiveFiles(bytes)[0].bytes.toString()).toBe(shown);
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(gunzipSync(bytes).includes(Buffer.from(secret))).toBe(false);
    expect(gunzipSync(bytes).includes(Buffer.from(job))).toBe(false);
    expect(requestsAfterPreview).toBe(0);
  } finally {await app.close();}
});
