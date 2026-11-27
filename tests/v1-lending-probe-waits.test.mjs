import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { guestProbeScript, PROBE_REQUESTS } from '../lib/v1/lending-probe.mjs';

const CLAUDE_BODY = { five_hour: { utilization: 25, resets_at: '2026-10-20T16:19:59.550398Z', used_dollars: null },
  seven_day: { utilization: 37, resets_at: '2026-10-23T01:59:59.550422Z' }, seven_day_opus: null, spend: { used: { amount_minor: 5 } },
  extra_usage: { is_enabled: false, used_credits: null }, limits: [{ kind: 'session', group: 'g', percent: 25, resets_at: '2026-10-20T16:20:00Z', is_active: true }] };

function runScripted(provider, script, prelude = '') {
  return new Promise((resolve, reject) => {
    const seen = {};
    const proxy = createServer((req, res) => {
      const path = new URL(req.url, 'http://provider.invalid').pathname;
      const left = script[path] ?? [];
      const step = left.length > 1 ? left.shift() : left[0];
      seen[path] = (seen[path] ?? 0) + 1;
      res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) });
      res.end(JSON.stringify(step.body ?? {}));
    });
    proxy.listen(0, '127.0.0.1', () => {
      let body = guestProbeScript(provider);
      for (const url of [PROBE_REQUESTS[provider].url, PROBE_REQUESTS[provider].identity?.url].filter(Boolean)) {
        body = body.replace(url, url.replace('https://', 'http://'));
      }
      execFile('python3', ['-I', '-c', prelude + '\n' + body], { env: { PATH: process.env.PATH, http_proxy: 'http://127.0.0.1:' + proxy.address().port }, timeout: 60000 },
        (err, stdout, stderr) => { proxy.close(); err ? reject(err) : resolve({ stdout, stderr, seen }); });
    });
  });
}
const USAGE_PATH = '/api/oauth/usage';
const PROFILE_PATH = '/api/oauth/profile';
const PROFILE = { account: { uuid: 'acct-uuid-1', email: 'Someone@Example.com' }, organization: { uuid: 'org-uuid-1' } };
// Observe the exact guest get() call site, not a duration threshold: even a
// wrongly tiny retry must remain visible. subprocess timeout polling also calls
// time.sleep, so replacing it globally without this distinction is flaky.
const WAIT_LOG = `import time as _t,atexit as _a,sys as _s,json as _j,subprocess as _sp
_w=[]
_other=[]
def _sleep(x):
 caller=_s._getframe(1)
 if caller.f_code is globals()["get"].__code__: _w.append(x)
 else: _other.append(x)
_t.sleep=_sleep
def _auth(*args,**kwargs):
 # Deterministically exercise unrelated polling-sized sleeps. Never invoke the
 # installed Claude CLI or consult its account state in this offline test.
 for delay in (0.001,0.002,0.004,0.05): _t.sleep(delay)
 return _sp.CompletedProcess(args[0],0,stdout="{}")
_sp.run=_auth
_a.register(lambda: print("WAITS "+_j.dumps(_w),file=_s.stderr))
_a.register(lambda: print("OTHER_WAITS "+_j.dumps(_other),file=_s.stderr))`;

function assertWaits(stderr, expected) {
  const rows = stderr.split('\n').filter(line => line.startsWith('WAITS '));
  assert.equal(rows.length, 1, 'exactly one retry-wait report');
  assert.deepEqual(JSON.parse(rows[0].slice(6)), expected);
  const other = stderr.split('\n').filter(line => line.startsWith('OTHER_WAITS '));
  assert.equal(other.length, 1);
  assert.deepEqual(JSON.parse(other[0].slice(12)), [0.001, 0.002, 0.004, 0.05],
    'unrelated polling waits were exercised, not included in retry waits');
}

test('without a Retry-After the guest waits 5 s, then 10 s, before the next try', async () => {
  const { stderr } = await runScripted('claude', {
    [USAGE_PATH]: [{ status: 429, body: {} }, { status: 429, body: {} }, { status: 200, body: CLAUDE_BODY }],
    [PROFILE_PATH]: [{ status: 200, body: PROFILE }],
  }, WAIT_LOG);
  assertWaits(stderr, [5, 10]);
});

test('a Retry-After longer than 15 s is capped at 15 s, so the admission stays inside its probe timeout', async () => {
  const { stderr } = await runScripted('claude', {
    [USAGE_PATH]: [{ status: 429, headers: { 'retry-after': '60' }, body: {} }, { status: 200, body: CLAUDE_BODY }],
    [PROFILE_PATH]: [{ status: 200, body: PROFILE }],
  }, WAIT_LOG);
  assertWaits(stderr, [15]);
});

