import './helpers/no-browser.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const smoke = readFileSync(new URL('../packaging/journey/smoke.mjs', import.meta.url), 'utf8');
const journeyScript = readFileSync(new URL('../packaging/journey/new-user-journey.sh', import.meta.url), 'utf8');
const cleanup = readFileSync(new URL('../packaging/journey/cleanup.mjs', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../bin/faravan-install.sh', import.meta.url), 'utf8');
const uiJourney = smoke.slice(smoke.indexOf('async function checkUiPagesAndCircle()'), smoke.indexOf('async function expectVisible('));

test('owner page remains available through Lending and pages close in finally', () => {
  assert.match(uiJourney, /await owner\.goto\(lendUrl\.toString\(\)\)/);
  assert.doesNotMatch(uiJourney, /await owner\.close\(\);\s*await friend\.close\(\);/);
  assert.match(uiJourney, /finally\s*\{\s*await Promise\.all\(\[owner, friend\][\s\S]*?page\.close\(\)/);
});

test('saved Claude model is checked through the persisted agents readback', () => {
  assert.match(uiJourney, /fetch\(procs\.owner\.origin \+ '\/api\/agents'/);
  assert.match(uiJourney, /agentModelMatches\(savedAgents, CLAUDE, HAIKU\)/);
  assert.match(uiJourney, /model: savedClaude\.run\.model/);
});

test('cap monitoring stops a running job when provider evidence goes missing', () => {
  const monitor = smoke.slice(smoke.indexOf('const monitorCapDuringExecution'), smoke.indexOf('// -- 3. job one'));
  assert.match(monitor, /gate\.missing\.length && activeAttempt/);
  assert.match(monitor, /lending\.stop_job/);
});

test('journey prints PASS only after cleanup succeeds', () => {
  assert.doesNotMatch(journeyScript, /PASS journey/);
  assert.match(cleanup, /if \(finishJourney\(process\.argv\[2\], Number\(process\.argv\[3\]\), process\.argv\.slice\(4\)\)\) \{[\s\S]*?PASS journey admission=/);
  assert.equal((cleanup.match(/PASS journey admission=/g) ?? []).length, 1);
});

test('stopped job receipt reason is called and included in the verdict', () => {
  assert.match(smoke, /const receipt2 = await receiptOrReason\(d2\)/);
  assert.match(smoke, /judgeOwnerStop\(\{[\s\S]*?receiptUnavailable: stoppedReceiptUnavailable/);
  assert.match(smoke, /ownerStopHonored: j2\.ownerStop\.pass === true/);
});

test('installer verifies apt and deb installs and checks failed deb downloads', () => {
  assert.match(installer, /if \[ "\$INSTALLED_VIA" != "tarball" \]; then[\s\S]*?"\$PACKAGED_BIN" --readiness/);
  assert.match(installer, /download "\$deb_url" "\$deb_file" \|\| die/);
  assert.match(installer, /curl -fsSL "\$API_URL" -o "\$TMP_DIR\/release\.json" --max-filesize "\$MAX_DOWNLOAD_BYTES" \|\| return 1/);
});

test('installed launcher commands have bounded timeouts', () => {
  const launch = journeyScript.slice(journeyScript.indexOf('installed_launcher()'), journeyScript.indexOf('stage_release_tarball()'));
  assert.equal((launch.match(/timeout 120/g) ?? []).length, 2);
});

test('smoke summary requires checks and observed provider deltas', () => {
  assert.match(smoke, /Object\.keys\(summary\.checks\)\.length > 0 && Object\.values\(summary\.checks\)\.every/);
  assert.match(smoke, /liveProviderDeltaRecorded = summary\.meter\.providerPointDeltas\.length > 0/);
});

test('admission mode check uses the app readback', () => {
  assert.match(smoke, /summary\.ui\.lendingReadback\?\.enabled === true && summary\.ui\.lendingReadback\?\.mode === 'auto'/);
});

test('Claude model is re-read after settings save, after restart, and at final check', () => {
  assert.match(smoke, /agentModelMatches\(agentReadback, CLAUDE, HAIKU\)/);
  assert.match(smoke, /agentModelMatches\(agentsAfterRestart, CLAUDE, HAIKU\)/);
  assert.match(smoke, /agentModelMatches\(finalAgentReadback, CLAUDE, HAIKU\)/);
  assert.match(smoke, /lendingSettingsThroughUi: summary\.checks\.lendingSettingsThroughUi === true && restartModelPersisted && finalModelPersisted/);
});
