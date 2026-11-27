import {test, expect as browserExpect} from '@playwright/test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {twoFreshInstalls} from '../helpers/v1-app-fixture.mjs';
import {confirmFirstSend} from './first-send-test-helper.mjs';
import {OUT} from './lib.mjs';

// One person, one computer, the first thing a new user tries: this computer hosts circle "Tessa", has one project, and
// opens Send a job. The walk records what the page says at each step (test-artifacts/browser-verify/one-computer-walk.txt).
// Only the "host" install is used. The second install the fixture starts never joins Tessa, so Tessa has one computer.
const expect = browserExpect.configure({timeout: 30000});
test.setTimeout(240000);

test('one computer: Send a job shows why no agent can be chosen, then its own agents once it lends, and the job finishes', async ({browser}) => {
  const root = await mkdtemp(join(tmpdir(), 'faravan-one-computer-'));
  const walk = [], say = (step, text) => walk.push(`${walk.length + 1}. ${step}\n   ${text.replace(/\s+/g, ' ').trim()}`);
  let apps, context;
  try {
    apps = await twoFreshInstalls({root, hostHome: process.env.HOME});
    const me = apps.host;
    const repo = join(me.paths.HOME, 'code', 'SillyTavern');
    await mkdir(repo, {recursive: true});
    const git = (...args) => promisify(execFile)('git', ['-C', repo, ...args], {env: me.env});
    await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Walk'); await git('config', 'user.email', 'walk@example.test');
    await writeFile(join(repo, 'README.md'), 'SillyTavern walk fixture\n'); await git('add', 'README.md'); await git('commit', '-qm', 'init');

    context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    await page.goto((await me.link()) + '#/you/profile');
    await page.getByLabel('Your name', {exact: true}).fill('Tessa');
    await page.getByRole('button', {name: 'Save your name', exact: true}).click();
    await page.getByLabel('Computer name', {exact: true}).fill('Tessa’s Mac');
    await page.getByRole('button', {name: 'Save computer name', exact: true}).click();
    await page.goto((await me.link()) + '#/circles/host');
    await page.getByLabel('Circle name', {exact: true}).fill('Tessa');
    await page.getByRole('radio', {name: /Local network only/}).check();
    await page.getByRole('button', {name: 'Start circle', exact: true}).click();
    await expect(page.getByRole('link', {name: 'Invite someone', exact: true})).toBeVisible();
    say('Host circle "Tessa" on this computer', 'Circle started. No other computer has joined.');

    // Before lending: the Agent list must say why it is empty and what to do.
    await page.goto((await me.link()) + '#/new');
    await expect(page.getByRole('heading', {name: 'New job'})).toBeVisible();
    const project = page.locator('#cmp-project');
    await expect(project.locator('.cmp-setting-value')).toHaveText('SillyTavern');
    say('Open Send a job as a new user', `Project row: "${await project.locator('.cmp-setting-value').innerText()}", ${await project.evaluate(e => e.open) ? 'open' : 'closed (summary)'}; the only project was chosen for me.`);
    const reason = page.locator('#cmp-agent-empty');
    await expect(reason).toBeVisible();
    const agentOptions = async () => (await page.locator('#cmp-agent option').allInnerTexts()).join(' | ');
    say('Agent before lending', `Options: ${await agentOptions()}. Reason shown: "${await reason.locator('p').innerText()}" Actions: ${(await reason.getByRole('link').allInnerTexts()).join(', ')}.`);
    expect(await reason.getByRole('link').allInnerTexts()).toEqual(['Lend from this computer', 'Invite someone']);

    // Follow the action: lend from this computer in ask mode.
    await reason.getByRole('link', {name: 'Lend from this computer'}).click();
    await expect(page).toHaveURL(/#\/lend/);
    await page.getByRole('switch', {name: 'Lend with Codex', exact: true}).click();
    await expect(page.getByRole('radiogroup', {name: 'Choose a circle', exact: true})).toContainText('Tessa');
    await page.getByRole('switch', {name: 'Lending', exact: true}).click();
    await expect(page.getByRole('switch', {name: 'Lending', exact: true})).toHaveAttribute('aria-checked', 'true');
    say('Follow "Lend from this computer"', `Lend page: Codex chosen, lending switched on for Tessa. Mode shown: "${await page.getByText('Ask me each time', {exact: true}).count() ? 'Ask me each time' : 'other'}".`);

    // After lending: this computer's agent is offered, labelled as running here.
    await page.goto((await me.link()) + '#/new');
    const composeState = () => page.evaluate(async () => {
      // Signed in by the handoff cookie that page.goto(link()) set; the page sends no token.
      const circles = await (await fetch('/api/circles', {credentials: 'same-origin'})).json(), tessa = (circles.circles ?? circles).find(c => c.name === 'Tessa');
      return (await fetch('/api/circles/' + encodeURIComponent(tessa.id) + '/compose', {credentials: 'same-origin'})).json();
    });
    await expect.poll(async () => {
      await page.reload(); await page.locator('#cmp-agent').waitFor();
      await page.waitForTimeout(1000);
      return agentOptions();
    }, {timeout: 90000, intervals: [3000]}).toContain('Codex · available on this computer').catch(async error => {
      throw new Error(error.message + '\ncompose: ' + JSON.stringify(await composeState()));
    });
    await expect(reason).toHaveCount(0);
    say('Open Send a job again', `Options: ${await agentOptions()}. No empty-list reason shown.`);
    await page.getByLabel('Agent', {exact: true}).selectOption({label: 'Codex · available on this computer'});
    await page.getByLabel('What the agent should do').fill('Make the deterministic G2 change.');
    await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeEnabled();
    say('Choose Codex and write the request', `Send is enabled. Privacy line: "${await page.locator('.cmp-privacy-note').innerText()}"`);
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await confirmFirstSend(page);
    await expect(page).toHaveURL(/#\/job\//, {timeout: 15000});
    say('Send', `Job page opened: ${new URL(page.url()).hash.split('/').slice(0, 2).join('/')}/…`);

    // This computer claims its own job: an own job is accepted without asking, even in ask mode.
    await expect(page.getByText('G2 agent is working on the deterministic change.', {exact: true})).toBeVisible({timeout: 60000});
    say('Job page while it runs', `Status: "${await page.getByRole('status').first().innerText()}". Agent output: "G2 agent is working on the deterministic change." No approval was asked: it is this computer’s own job.`);
    await me.control('release');
    await expect(page.getByText('Ready to review', {exact: true}).first()).toBeVisible({timeout: 60000});
    const heading = await page.getByRole('heading').first().innerText();
    say('Wait on the job page', `Status "Ready to review". Heading: "${heading}". Changes: "${(await page.getByRole('region', {name: 'Changes', exact: true}).innerText()).slice(0, 160)}"`);
  } finally {
    const text = walk.join('\n');
    await mkdir(OUT, {recursive: true});
    await writeFile(join(OUT, 'one-computer-walk.txt'), text + '\n');
    await test.info().attach('walk', {body: text, contentType: 'text/plain'});
    await context?.close();
    await apps?.stop();
    await rm(root, {recursive: true, force: true});
  }
});
