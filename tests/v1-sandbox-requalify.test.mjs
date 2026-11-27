import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const RUN_HELP = [
  'Usage: sbx run [flags] AGENT PATH', 'Flags:',
  '  -d, --detach                    Start the sandbox and print its ID without opening an agent session',
  '      --detach-keys string          Override the detach keys', '      --name string', '      --kit stringArray',
  '      --cpus', '      --memory', '      --skills', '      --static-mcp', '      --deny-network',
].join('\n');

// A fake sbx host. `failVersion` makes the next `sbx version` fail the way a real read does (nonzero exit, or a timeout).
function sbxHost() {
  const state = {failVersion: null, diagnoses: 0, reads: [], monotonic:0};
  const runCommand = async (command, args) => {
    if (command === 'dpkg-query') return ok('docker-sbx\tinstalled\t0.51.0\ndocker-ce\tinstalled\t28.0.0\ncontainerd.io\tinstalled\t2.1.0\n');
    if (command === 'docker') return ok('28.0.0');
    if (command === 'containerd') return ok('containerd github.com/containerd/containerd v2.1.0');
    if (command === 'test') return ok();
    if (args[0] === 'version') {
      if (state.failVersion === 'exit') return {code: 1, stdout: '', stderr: 'sbx version: the service did not answer'};
      if (state.failVersion === 'timeout') return {code: 1, stdout: '', stderr: 'The sandbox check timed out.', errorCode: 'ETIMEDOUT', timedOut: true};
      return ok('sbx version: v0.51.0 abc123');
    }
    // `sbx diagnose` as sbx 0.50 prints it: one line per check.
    if (args[0] === 'diagnose') {
      state.diagnoses++;
      return ok(['Diagnostics', '  ! Binary version — could not check for updates', '  ✓ Daemon — healthy',
        '  ✓ Authentication — authenticated', '  ✓ Global network policy — initialized'].join('\n'));
    }
    if (args[0] === 'ls') return ok('[]');
    if (args[0] === 'policy' && args[1] === 'ls') return ok('Policy rules');
    if (args.join(' ') === 'run --help') return ok(RUN_HELP);
    throw new Error(`unexpected sbx command: ${command} ${args.join(' ')}`);
  };
  return {state, runCommand};
}

// The app's readiness reads the preflight through lenderCapabilities, which does not take the backend's runCommand.
// This test seam hands the fake host to that read and nothing else.
class FakeSbxHost extends DockerSbxBackend {
  constructor(options, host) { super({...options,monotonic:()=>host.state.monotonic,guestRuntime:async()=>({node:process.execPath})}); this.host = host; }
  lenderCapabilities(options = {}) {
    // A full read is the one without observation; it is the read that forces sbx's own checks again.
    this.host.state.reads.push({at: Date.now(), full: options.observation !== true});
    return super.lenderCapabilities({...options, platformName: 'linux', runCommand: this.host.runCommand});
  }
}

for (const failure of ['exit', 'timeout']) {
  test(`a failed sbx version read (${failure}) recovers at cooldown expiry without periodic diagnostics`, {timeout: 120000}, async t => {
    const host = sbxHost();
    const f = await appFixture(t);
    const {lender} = await f.connect({
      backendFactory: async options => new FakeSbxHost(options, host),
      blockerRecheckMs: 200,
    });
    const initial=await waitFor(async()=>{const report=await api(lender.app,'/api/readiness');return report.ready?report:null;},'ready before the failure');

    // The skipped diagnostic cannot replace verified evidence for the unchanged executor.
    host.state.failVersion = failure;
    const failed = await api(lender.app, '/api/readiness?refresh=true');
    host.state.failVersion = null;
    assert.equal(failed.ready, false);
    assert.equal(failed.checks.find(c => c.name === 'sbx_version')?.ok, false);

    const diagnosesAfterFailure=host.state.diagnoses;
    host.state.monotonic=15000;
    const recovered=await waitFor(async()=>{const report=await api(lender.app,'/api/readiness');return report.ready?report:null;},'background requalification after cooldown',5000);
    assert.equal(recovered.protection.diagnostics_observed_at,initial.protection.diagnostics_observed_at);
    assert.equal(host.state.diagnoses,diagnosesAfterFailure,'blocker ticks do not queue diagnostics');

    // Ordinary polls read observation only once ready: no new `sbx diagnose`.
    const diagnosesBefore = host.state.diagnoses;
    for (let i = 0; i < 5; i++) await api(lender.app, '/api/readiness');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(host.state.diagnoses, diagnosesBefore, 'ordinary polls never run a diagnostic refresh');
    assert.ok(diagnosesBefore >= 1, 'the initial healthy read established diagnostic evidence');
  });
}

test('a persistent failed sbx version read never schedules periodic diagnostics', {timeout: 120000}, async t => {
  const host = sbxHost();
  const f = await appFixture(t);
  const {lender} = await f.connect({
    backendFactory: async options => new FakeSbxHost(options, host),
    blockerRecheckMs: 500,
  });
  await waitFor(async () => (await api(lender.app, '/api/readiness')).ready === true, 'ready before the failure');
  host.state.failVersion = 'exit'; // persistent: every full read keeps failing
  host.state.reads.length = 0;
  const start = Date.now();
  await api(lender.app, '/api/readiness?refresh=true');
  await new Promise(resolve => setTimeout(resolve, 1600));
  const full = host.state.reads.filter(read => read.full && read.at >= start).map(read => read.at);
  assert.equal(full.length,1,'only the explicit refresh performs a full read');
});
