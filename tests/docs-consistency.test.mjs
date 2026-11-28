import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const publicMarkdownPaths = [
  'README.md',
  'docs/STATUS.md',
  'docs/getting-started-with-a-friend.md',
  'docs/linux-quickstart.md',
  'docs/mac-quickstart.md',
  'docs/mcp-quickstart.md',
  'docs/connect-chatgpt.md',
  'docs/team-onboarding.md',
  'docs/install.md',
  'docs/agents.md',
  'docs/SECURITY.md',
  'packaging/README.md',
  'packaging/apt/README.md',
  'packaging/homebrew-tap/README.md',
  'packaging/macos/README.md',
  'packaging/windows/README.md',
];
const docs = new Map(publicMarkdownPaths.map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
const testStatusLabel = /\b(?:untested|not (?:yet )?(?:verified|tested)|(?<!do )(?<!does )(?<!did )not (?:yet )?run|no real job|not qualified|unqualified|have not been verified|tested on|tested with|remain unverified|unverified(?!-app\s+warning)|what the tests? do and do not prove|tests? (?:do not|does not) cover|coverage[- ]gap|without (?:an? )?(?:independent )?review or rerunning tests|not independently reviewed|without\s+independently\s+reviewing\s+code\s+or\s+rerunning\s+tests|Linux\s+fixture\s+tests?\s+do\s+not\s+build\s+the\s+Mac\s+app|it\s+does\s+not\s+cover\s+native\s+Mac\s+installation\s+or\s+public-feed\s+availability|JSON\s+receipts?|hosted\s+CI\s+does\s+not\s+run\s+for\s+this\s+repository|not checked yet|live non-exposure has not been established|core review found|checked\s+\d{4}-\d{2}-\d{2}|not a logged-in ChatGPT account|open review gaps|automated version is[\s\S]{0,80}v1-ops-e2e\.test\.mjs|tests never call a live app|optional steps are SKIP, not claimed as tested|does not independently review code or rerun tests)\b/i;

test('Linux release links use one consistent preview tag', () => {
  assert.match(docs.get('README.md'), /\(docs\/team-onboarding\.md\)/);
  // The friend walkthrough no longer links a dated release; installation goes through the team guide.
  const friend = docs.get('docs/getting-started-with-a-friend.md');
  assert.doesNotMatch(friend, /releases\/(?:tag|download)\/preview-/);
  assert.match(friend, /\(team-onboarding\.md#install-on-linux\)/);
});

test('borrowing Git requirements name the Git-project path', () => {
  for (const [path, text] of docs) {
    const sentences = text.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/);
    for (const sentence of sentences) {
      if (!/\bborrow(?:ing|ers?)?\b/i.test(sentence) || !/\bGit\b/.test(sentence)) continue;
      const requiresGit = /\b(?:needs?|requires?)\s+(?:only\s+)?Git\b/i.test(sentence)
        || /\bGit\s+is\s+(?:needed|required)\b/i.test(sentence);
      if (requiresGit) {
        assert.match(sentence, /\bGit-project\b/i, path + ': unqualified Git requirement: ' + sentence);
      }
    }
  }
});

test('Mac instructions never use a home-directory Applications path', () => {
  // Include the cross-platform docs too: each contains Mac instructions.
  const homeApplications = /(?:~|\$(?:HOME|\{HOME\})|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/Applications(?:\/|\b)/;
  for (const [path, text] of docs) {
    assert.doesNotMatch(text, homeApplications, path + ': use /Applications for the Mac app');
  }
});

const uiSource = path => readFileSync(resolve(root, 'ui/v1/src', path), 'utf8');
const labelCases = [
  ['Job details', 'docs/getting-started-with-a-friend.md', 'jobs.jsx', '<summary>Job details</summary>'],
  ['What the agent is doing', 'docs/getting-started-with-a-friend.md', 'transcript-feed.jsx', '>What the agent is doing</h2>'],
  ['You', 'README.md', 'shell.jsx', '\n              You\n'],
  ['Your data', 'README.md', 'settings-model.mjs', "label: 'Your data'"],
  ['AI provider only', 'docs/getting-started-with-a-friend.md', 'helpers.mjs', "'AI provider only'"],
  ['Ask me each time', 'README.md', 'lend.jsx', "'Ask me each time'"],
  ['Ask me each time', 'docs/getting-started-with-a-friend.md', 'lend.jsx', "'Ask me each time'"],
  ['Add as a branch…', 'README.md', 'jobs.jsx', '>Add as a branch…</Button>'],
  ['Add as a branch…', 'docs/getting-started-with-a-friend.md', 'jobs.jsx', '>Add as a branch…</Button>'],
  ['Add as a branch', 'README.md', 'apply-sheet.jsx', '>Add as a branch</h2>'],
  ['Add as a branch', 'docs/getting-started-with-a-friend.md', 'apply-sheet.jsx', '>Add as a branch</h2>'],
  ['Turn on launch at login', 'packaging/macos/README.md', 'settings-model.mjs', "'Turn on launch at login'"],
];
for (const [label, path, source, rendered] of labelCases) {
  test(path + ' uses the rendered label: ' + label, () => {
    assert.ok(docs.get(path).includes('**' + label + '**') ||
      (['You', 'Your data'].includes(label) && docs.get(path).includes('**You → Your data**')),
    path + ': missing label ' + label);
    assert.ok(uiSource(source).includes(rendered), source + ': label changed: ' + label);
  });
}

test('result review and telemetry paths omit stale navigation', () => {
  assert.doesNotMatch(docs.get('docs/getting-started-with-a-friend.md'), /\*\*Transcript\*\*|What the agent did/);
  assert.match(docs.get('docs/getting-started-with-a-friend.md'), /\*\*What the agent is doing\*\*, if shown/);
  assert.doesNotMatch(docs.get('README.md'), /Settings → You|Your data → Off/);
});

test('public docs carry no test-status labels', () => {
  for (const path of publicMarkdownPaths) {
    assert.doesNotMatch(docs.get(path), testStatusLabel, path);
  }
  assert.match(docs.get('docs/getting-started-with-a-friend.md'), /landing page may differ from the labels below/);
  assert.match(docs.get('docs/mac-quickstart.md'), /landing page may differ from the labels below/);
  assert.match(docs.get('docs/mac-quickstart.md'), /\(install\.md#mac\)/);
  assert.doesNotMatch(docs.get('docs/install.md'), /shasum|sha256sum|curl -fsSL/);
  assert.match(docs.get('docs/mcp-quickstart.md'), /Faravan does not document a local setup for it/);
  assert.doesNotMatch(docs.get('docs/mcp-quickstart.md'), /Settings → MCP servers → Add server/);
});

test('test-status guard rejects the phrases found in release docs', () => {
  for (const example of [
    'tested with development fixture binaries',
    'native builds remain unverified',
    'not yet run',
    'What the tests do and do not prove',
    'tests do not cover native installation',
    'without independent review or rerunning tests',
  ]) assert.match(example, testStatusLabel, example);
  assert.doesNotMatch('macOS shows an unverified-app warning', testStatusLabel);
});

test('test-status guard rejects exact regression wording across line breaks', () => {
  for (const example of [
    'This documentation-only update reconciles those records without independently\n  reviewing code or rerunning tests.',
    'Linux fixture tests do not build the Mac app.',
    'It does not cover native Mac installation or public-feed availability.',
    'retain JSON receipts across reboot and upgrade.',
    'hosted CI does not run for this repository.',
  ]) assert.match(example, testStatusLabel, example);
  assert.doesNotMatch('macOS shows an unverified-app warning', testStatusLabel);
  assert.doesNotMatch('Do not run this command with sudo.', testStatusLabel);
  assert.doesNotMatch('Review the changes and run your own tests before merging.', testStatusLabel);
});

test('test-status guard rejects onboarding review and test provenance', () => {
  for (const example of [
    'In this release the Mac is checked for borrowing: install, join a circle, send a job, get the result, and see a lender\'s Stop. Mac lending is not checked yet.',
    'Credential handling depends on the adapter and runtime; live non-exposure has not been established for the current v1 flow.',
    'The core review found private key files with owner-only permissions, but also found the owner\'s root key stored unencrypted beside the device key.',
    '(checked 2026-10-20)',
    'not a logged-in ChatGPT account.',
    'The security model lists the open review gaps.',
    'The automated version is `tests/v1-ops-e2e.test.mjs`: two apps with temporary homes and a synthetic\nsandbox.',
    'Those tests never call a live app, real agent, sandbox, lender, or apply operation.',
    'Disabled optional steps are SKIP, not claimed as tested.',
    'The local docs update does not independently review code or rerun tests.',
  ]) assert.match(example, testStatusLabel, example);
  assert.match('The automated version is `tests/v1-ops-e2e.test.mjs`: two apps with temporary homes and a synthetic\nsandbox.', /automated version is[\s\S]*v1-ops-e2e\.test\.mjs/);
  assert.doesNotMatch('unverified-app warning', testStatusLabel);
  assert.doesNotMatch('Do not run this command with sudo.', testStatusLabel);
  assert.doesNotMatch('Review the changes and run your own tests before merging.', testStatusLabel);
});

test('narrow network policy is not presented as a composer choice', () => {
  const friend = docs.get('docs/getting-started-with-a-friend.md');
  assert.match(friend, /not an option you can select in the composer/);
  assert.match(friend, /composer has no network-policy picker/);
  assert.doesNotMatch(friend, /choose provider-only/);
});

test('setup describes conditional checks and sign-in actions', () => {
  const team = docs.get('docs/team-onboarding.md');
  assert.match(team, /the next step becomes available after the earlier checks finish/);
  assert.match(team, /What Faravan checks → Details/);
  assert.ok(uiSource('signin.mjs').includes("'Sign in to ' + (SERVICE[target] || agentName"));
});

test('state sequence and recorded results are not exact current promises', () => {
  const friend = docs.get('docs/getting-started-with-a-friend.md');
  assert.match(friend, /It may move through/);
  for (const word of ['Waiting', 'Starting', 'Working', 'Ready to review']) {
    assert.ok(friend.includes('**' + word + '**'));
    assert.ok(uiSource('view-models.mjs').includes("word: '" + word + "'"));
  }
  assert.doesNotMatch(friend, /2 passed, 0 failed/, 'dated run output is not a current promise');
});

const onboardingPaths = [
  'docs/linux-quickstart.md',
  'docs/mac-quickstart.md',
  'docs/team-onboarding.md',
  'docs/getting-started-with-a-friend.md',
];
const dockerHeading = '## Docker Sandboxes installation (only terminal step)';
// The team guide also has the one-time Linux install command, so its Docker step is not the only one.
const dockerHeadings = new Set([dockerHeading, '## Docker Sandboxes installation (terminal step for lending)', '## Check the download (terminal step)']);
// The Linux install command, once; the app then opens from the applications menu.
const linuxInstallCommand = '   ```sh\n   curl -fsSL https://tnunamak.github.io/faravan-updates/install.sh | sh\n   ```\n';

// Only this exact level-two section is exempt, not every heading mentioning Docker.
// A sibling or parent heading ends the exemption; fenced headings cannot extend it.
function outsideDocker(text) {
  let inDocker = false;
  let fence = null;
  return text.split('\n').filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) {
      const heading = /^ {0,3}(#{1,2})\s+/.exec(line);
      if (heading) inDocker = dockerHeadings.has(line.trim());
      if (marker) fence = marker[1];
    } else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
      fence = null;
    }
    return !inDocker;
  }).join('\n');
}

function assertTerminalFree(text, path) {
  // The public Linux preview installs with one command and then opens from the applications menu.
  const prose = outsideDocker(path === 'docs/team-onboarding.md'
    ? text.replace(linuxInstallCommand, 'the install command\n') : text);
  // These guides need no fenced or indented code outside installation of Docker.
  assert.doesNotMatch(prose, /^\s*(?:>\s*)*(?:`{3,}|~{3,})/m, path + ': code block outside Docker installation');
  assert.doesNotMatch(prose, /^(?: {4,}|\t+)\S/m, path + ': indented code outside Docker installation');
  assert.doesNotMatch(prose, /(?:^|[\s`])(?:sudo|apt(?:-get)?|curl|sha256sum|shasum|chmod|systemctl|bash|zsh|sh)(?=[\s`]|$)/im,
    path + ': terminal command outside Docker installation');
  assert.doesNotMatch(prose, /(?:^|[\s`])\.\//m, path + ': executable path outside Docker installation');
  assert.doesNotMatch(prose, /\b(?:git\s+(?:status|--version)|npm\s+(?:test|run|install))\b/i,
    path + ': terminal instruction outside Docker installation');
  assert.doesNotMatch(prose, /`(?:faravan|faravan|git|npm|tailscale|tar|mkdir|node)\s[^\n`]*`/i,
    path + ': inline terminal command outside Docker installation');
}

for (const path of onboardingPaths) {
  test(path + ' is terminal-free outside Docker installation', () => {
    assertTerminalFree(readFileSync(resolve(root, path), 'utf8'), path);
  });
}

test('terminal-free guard rejects commands and fences, including optional notes', () => {
  for (const example of [
    'sudo install', 'apt install', 'curl URL', 'sha256sum file', 'chmod file', './faravan',
    '`shasum -a 256 file`', '`faravan doctor`', 'run git status', 'npm test',
    '```sh\nlaunch\n```', '~~~bash\nlaunch\n~~~',
    '    launch', '     launch', '\tlaunch', '> ```sh\nlaunch\n> ```',
    '## Optional expert notes\n`sudo install`',
    dockerHeading + '\nallowed Docker command\n## Get help\n`sudo repair`',
    '## Docker troubleshooting\n`sudo repair`',
  ]) {
    assert.throws(() => assertTerminalFree(example, 'fixture'));
  }
});

test('terminal-free guard allows only the bounded Docker section', () => {
  assert.doesNotThrow(() => assertTerminalFree(
    'See [help](../README.md).\n' + dockerHeading +
    '\n```sh\ncurl docker-install\n```\n## Continue\nOpen Setup.', 'fixture'));
});

test('security lending defaults match the real app and policy defaults', async () => {
  const security = readFileSync(resolve(root, 'docs/SECURITY.md'), 'utf8').replace(/\s+/g, ' ');
  const { APP_DEFAULTS } = await import('../lib/v1/app.mjs');
  const { LENDING_POLICY_DEFAULTS } = await import('../lib/v1/lending-policy.mjs');
  for (const key of ['dailyJobs', 'dailyMinutes', 'maxWallSeconds']) {
    assert.equal(APP_DEFAULTS[key], null, key + ': update the documented default');
  }
  assert.equal(APP_DEFAULTS.lendingPolicy.strategy, LENDING_POLICY_DEFAULTS.strategy);
  assert.equal(LENDING_POLICY_DEFAULTS.strategy, 'automatic');
  assert.equal(LENDING_POLICY_DEFAULTS.machineSlots, null);
  assert.equal(LENDING_POLICY_DEFAULTS.accountSlots, 1);
  assert.match(security, /No daily job count, daily minute cap or lender-wide per-job wall-time cap is set by default/);
  assert.match(security, /one job per account, not one job for the whole computer/);
  assert.doesNotMatch(security, /three jobs and one hour per day|twenty minutes per job/i);
});

test('security describes fresh automatic lending without claiming execution is already enabled', () => {
  const security = readFileSync(resolve(root, 'docs/SECURITY.md'), 'utf8').replace(/\s+/g, ' ');
  const app = readFileSync(resolve(root, 'lib/v1/app.mjs'), 'utf8');
  // Inspect the startup wiring; do not extract and evaluate a copy of application code.
  assert.match(app, /const freshLending\s*=\s*options\.freshLending\s*\?\?\s*'automatic'/);
  assert.match(app, /enabled:\s*false,\s*intent:\s*freshLending\s*===\s*'automatic'\s*\?\s*'on'\s*:\s*'off'/);
  assert.doesNotMatch(app, /providerConsent:\s*\{claude:\s*true,\s*codex:\s*true\}/);
  assert.match(app, /const\s*\{\s*providerConsent:\s*_legacy\s*,\s*\.\.\.rest\s*\}\s*=\s*policy/);
  assert.match(security, /Fresh app settings have lending intent On and the automatic strategy/);
  assert.match(security, /Fresh settings do not pre-grant provider consent/);
  assert.match(security, /the app checks consent for that provider/);
  assert.match(security, /Execution starts disabled/);
  assert.match(security, /explicit lending sign-in choice/);
  assert.doesNotMatch(security, /Lending starts off, with ask-each-time approval/i);
});

test('security does not promise provider-only app submissions', () => {
  const security = readFileSync(resolve(root, 'docs/SECURITY.md'), 'utf8').replace(/\s+/g, ' ');
  const app = readFileSync(resolve(root, 'lib/v1/app.mjs'), 'utf8');
  assert.match(app, /operations\s*=\s*createJobOperations\(/);
  assert.match(app, /operations\.submit\(clean,/);
  assert.match(security, /The app uses the shared CLI job-submission defaults/);
  assert.doesNotMatch(security, /app currently submits provider-only jobs/i);
});

test('install guide keeps Mac security guidance and a desktop restart instruction',()=>{
  const install=docs.get('docs/install.md');
  assert.match(install,/wording varies by macOS version/);
  assert.match(install,/Do not turn off Gatekeeper or remove quarantine attributes/);
  assert.match(install,/choose \*\*Quit\*\* from the Faravan menu bar icon, then reopen/);
});
