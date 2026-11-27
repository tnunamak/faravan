import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireCredentialMutation} from '../lib/sandbox-credentials.mjs';
import {createUsageAccountStore, credentialLockMutation} from '../lib/v1/usage-account-store.mjs';
import {createProviderSource, publishProviderGeneration, currentProviderGeneration, publishClaudeAccount} from '../lib/credential-generations.mjs';

// Throwaway home and synthetic tokens only. No real credential file is read.
const claudeValue = (token, refresh = 'synthetic-refresh') => ({claudeAiOauth: {accessToken: token, refreshToken: refresh, expiresAt: 9999999999999}});
const codexValue = token => ({tokens: {access_token: token, id_token: 'synthetic-id', refresh_token: 'synthetic-refresh'}});
async function freshHome(t) {
  await mkdir(join(homedir(), '.tmp'), {recursive: true});
  const home = await mkdtemp(join(homedir(), '.tmp', 'usage-store-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  return home;
}
// The identity is bound on an account's first successful read; these tests bind it directly.
const bind = async (store, key, hash) => assert.equal(await store.bindIdentity(key, (await store.credential(key)).generation, hash), true);
async function signIn(home, provider, value) {
  const source = await createProviderSource(home, provider);
  await writeFile(join(source.directory, provider === 'claude' ? '.credentials.json' : 'auth.json'), JSON.stringify(value), {mode: 0o600});
  return publishProviderGeneration(home, source);
}

test('the default account of each provider reads its own sign-in, in memory, bound to a generation', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  const claude = await signIn(home, 'claude', claudeValue('synthetic-claude-a'));
  await signIn(home, 'codex', codexValue('synthetic-codex-a'));
  const c = await store.credential('claude'), x = await store.credential('codex');
  assert.deepEqual([c.kind, c.bearer, c.generation, c.provider], ['oauth', 'synthetic-claude-a', claude.id, 'claude']);
  assert.deepEqual([x.kind, x.bearer, x.provider], ['oauth', 'synthetic-codex-a', 'codex']);
  assert.ok(!JSON.stringify(Object.keys(c)).includes('synthetic'));
});

test('an added Claude account reads its own value and is never answered by the default account', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-claude-default'));
  const id = randomUUID(), token = 'sk-ant-oat01-' + 'a'.repeat(40);
  await publishClaudeAccount(home, id, {kind: 'subscription-token', token});
  const added = await store.credential('claude:' + id);
  assert.deepEqual([added.kind, added.bearer], ['setup-token', token]);
  assert.notEqual(added.bearer, (await store.credential('claude')).bearer);
  const apiId = randomUUID();
  await publishClaudeAccount(home, apiId, {kind: 'api-key', token: 'sk-ant-api03-' + 'b'.repeat(40)});
  assert.equal((await store.credential('claude:' + apiId)).kind, 'api-key');
});

test('a missing account fails alone, with a reason and no secret', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'codex', codexValue('synthetic-codex-a'));
  await assert.rejects(store.credential('claude'), error => error.code === 'usage_credential_unavailable' && error.reason === 'not_signed_in');
  await assert.rejects(store.credential('claude:' + randomUUID()), error => error.code === 'usage_credential_unavailable');
  await assert.rejects(store.credential('not a key'), error => error.reason === 'account_unknown');
  assert.equal((await store.credential('codex')).bearer, 'synthetic-codex-a');
});

test('a rotation is accepted only after a verified same-account read, and publishes one successor record', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old'));
  const seen = [];
  const hash = 'a'.repeat(16);
  await bind(store, 'claude', hash);
  const result = await store.rotate('claude', {value: claudeValue('synthetic-new', 'synthetic-refresh-2'), measuredAt: 1000,
    verify: async bearer => { seen.push(bearer); return {ok: true, identity_sha256_16: hash}; }});
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ['synthetic-new']);
  const now = await store.credential('claude');
  assert.equal(now.bearer, 'synthetic-new');
  assert.notEqual(now.generation, first.id);
  const record = await store.successor('claude');
  assert.deepEqual([record.prior_generation, record.generation, record.identity_sha256_16, record.measured_at],
    [first.id, now.generation, hash, 1000]);
  assert.ok(!JSON.stringify(record).includes('synthetic'));
  // a second refresh keeps the first measurement time and must name the same account
  const again = await store.rotate('claude', {value: claudeValue('synthetic-3'), measuredAt: 9999, verify: async () => ({ok: true, identity_sha256_16: hash})});
  assert.equal(again.ok, true);
  assert.equal((await store.successor('claude')).measured_at, 1000);
  const mismatch = await store.rotate('claude', {value: claudeValue('synthetic-4'), verify: async () => ({ok: true, identity_sha256_16: 'b'.repeat(16)})});
  assert.deepEqual(mismatch, {ok: false, reason: 'identity_changed'});
  assert.equal((await store.credential('claude')).bearer, 'synthetic-3');
});

test('a failed or unverified refresh writes nothing', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  const first = await signIn(home, 'codex', codexValue('synthetic-old'));
  for (const verify of [async () => ({ok: false}), async () => { throw new Error('network'); }, async () => ({ok: true})]) {
    const result = await store.rotate('codex', {value: codexValue('synthetic-new'), verify});
    assert.equal(result.ok, false);
  }
  assert.equal((await currentProviderGeneration(home, 'codex')).id, first.id);
  assert.equal(await store.successor('codex'), null);
  assert.equal((await readdir(home)).some(name => name.includes('usage-successor')), false);
});

test('a generation change during verification refuses the rotation', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  await bind(store, 'claude', 'c'.repeat(16));
  const result = await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => {
    await signIn(home, 'claude', claudeValue('synthetic-other-sign-in'));
    return {ok: true, identity_sha256_16: 'c'.repeat(16)};
  }});
  assert.deepEqual(result, {ok: false, reason: 'generation_changed'});
  assert.equal((await store.credential('claude')).bearer, 'synthetic-other-sign-in');
});

test('a crash after publishing the generation is finished on recovery; a crash before it is dropped', async t => {
  const home = await freshHome(t);
  const crashing = createUsageAccountStore({home, withMutation: async run => run()});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old'));
  // Simulate a crash before publication: only the intent exists.
  const hash = 'd'.repeat(16);
  await bind(crashing, 'claude', hash);
  const attempt = await crashing.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: hash})});
  assert.equal(attempt.ok, true);
  const {writeFile: w, rm: r} = await import('node:fs/promises');
  const intent = JSON.stringify({version: 1, account_key: 'claude', prior_generation: first.id, output_source: (await currentProviderGeneration(home, 'claude')).source.id, identity_sha256_16: hash, measured_at: 5});
  await r(join(home, 'usage-successor-claude.json'));
  await w(join(home, 'usage-successor-claude.json.pending'), intent);
  assert.equal(await crashing.recover('claude'), 'finished');
  assert.equal((await crashing.successor('claude')).generation, (await currentProviderGeneration(home, 'claude')).id);
  await w(join(home, 'usage-successor-claude.json.pending'), JSON.stringify({version: 1, account_key: 'claude',
    prior_generation: (await currentProviderGeneration(home, 'claude')).id, identity_sha256_16: hash, measured_at: 5}));
  assert.equal(await crashing.recover('claude'), 'dropped');
  assert.equal(await crashing.recover('claude'), 'none');
});

test('recovery never gives a pending rotation credit for a later sign-in: the rotation is abandoned and the new sign-in stays unbound', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  const a = await signIn(home, 'claude', claudeValue('synthetic-account-a'));
  const hashA = 'a'.repeat(16);
  await bind(store, 'claude', hashA);
  // A rotation for account A recorded its intent and its output source, then the process died before it published.
  const orphan = await createProviderSource(home, 'claude');
  await writeFile(join(home, 'usage-successor-claude.json.pending'), JSON.stringify({version: 1, account_key: 'claude', prior_generation: a.id,
    output_source: orphan.id, identity_sha256_16: hashA, measured_at: 5}));
  // Later the owner signs in as account B.
  const b = await signIn(home, 'claude', claudeValue('synthetic-account-b'));
  assert.equal(await store.recover('claude'), 'dropped', 'B is not the output of A\'s rotation');
  assert.equal(await store.successor('claude'), null, 'no successor record vouches for B');
  assert.equal(await store.identity('claude'), null, 'B stays unbound until its own first read');
  // A candidate that matches account A's identity is refused for B: with nothing bound, nothing is saved.
  const refused = await store.rotate('claude', {value: claudeValue('synthetic-b-refreshed'), verify: async () => ({ok: true, identity_sha256_16: hashA})});
  assert.deepEqual(refused, {ok: false, reason: 'identity_unbound'});
  assert.equal((await store.credential('claude')).generation, b.id);
});

test('the successor record is private and the credential file mode is unchanged', {skip: process.platform === 'win32'}, async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  await bind(store, 'claude', 'e'.repeat(16));
  await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: 'e'.repeat(16)})});
  assert.equal((await stat(join(home, 'usage-successor-claude.json'))).mode & 0o777, 0o600);
  const generation = await currentProviderGeneration(home, 'claude');
  assert.equal((await stat(join(generation.directory, generation.file))).mode & 0o777, 0o600);
});

test('two rotations of one account run one at a time; another account is not held back', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  await signIn(home, 'codex', codexValue('synthetic-codex'));
  await bind(store, 'claude', 'a'.repeat(16)); await bind(store, 'codex', 'f'.repeat(16));
  let inside = 0, overlap = 0;
  const verify = hash => async () => { inside++; overlap = Math.max(overlap, inside); await new Promise(r => setTimeout(r, 30)); inside--; return {ok: true, identity_sha256_16: hash}; };
  const first = store.rotate('claude', {value: claudeValue('synthetic-new-1'), verify: verify('a'.repeat(16))});
  const second = store.rotate('claude', {value: claudeValue('synthetic-new-2'), verify: verify('a'.repeat(16))});
  const other = await store.rotate('codex', {value: codexValue('synthetic-codex-2'), verify: async () => ({ok: true, identity_sha256_16: 'f'.repeat(16)})});
  assert.equal(other.ok, true, 'a different account does not wait for the first');
  const results = await Promise.all([first, second]);
  assert.equal(overlap, 1, 'two rotations of one account never overlapped');
  assert.deepEqual(results.map(r => r.ok), [true, true], 'the second ran after the first and rotated its result');
  assert.equal((await store.credential('claude')).bearer, 'synthetic-new-2');
});

test('a rotation waits for the credential lock held by a sign-in and writes nothing while it is held', async t => {
  const home = await freshHome(t);
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  const store = createUsageAccountStore({home, withMutation: credentialLockMutation(home, {leaseWaitMs: 0})});
  await bind(store, 'claude', '1'.repeat(16));
  const release = await acquireCredentialMutation(home, {isolatedSources: true, concurrentSources: true});
  await assert.rejects(store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: '1'.repeat(16)})}),
    error => error.code === 'usage_credential_locked');
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old');
  assert.equal(await store.successor('claude'), null);
  await release();
  const result = await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: '1'.repeat(16)})});
  assert.equal(result.ok, true);
});

// A barrier: a promise the test settles, so the order of events is decided by the test and not by timing.
const barrier = () => { let open; const wait = new Promise(resolve => { open = resolve; }); return {wait, open}; };
const settled = async promise => { let done = false; promise.then(() => { done = true; }, () => { done = true; }); await new Promise(r => setTimeout(r, 40)); return done; };

test('account B finishes while account A is held, and A finishes only after it is released', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  await signIn(home, 'codex', codexValue('synthetic-codex'));
  await bind(store, 'claude', 'a'.repeat(16)); await bind(store, 'codex', 'f'.repeat(16));
  const hold = barrier(), reached = barrier();
  const a = store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => { reached.open(); await hold.wait; return {ok: true, identity_sha256_16: 'a'.repeat(16)}; }});
  await reached.wait;                       // A is now inside its verification read and holds its account
  const b = await store.rotate('codex', {value: codexValue('synthetic-codex-2'), verify: async () => ({ok: true, identity_sha256_16: 'f'.repeat(16)})});
  assert.equal(b.ok, true, 'B completed while A was still blocked');
  assert.equal((await store.credential('codex')).bearer, 'synthetic-codex-2');
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old', 'A has not been saved');
  assert.equal(await settled(a), false, 'A is still blocked');
  hold.open();
  assert.equal((await a).ok, true);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-new');
});

test('recover of an account waits for a rotation of the same account, and runs after it', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  await bind(store, 'claude', 'a'.repeat(16));
  const hold = barrier(), reached = barrier(), events = [];
  const rotation = store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => { reached.open(); await hold.wait; return {ok: true, identity_sha256_16: 'a'.repeat(16)}; }})
    .then(r => { events.push('rotate'); return r; });
  await reached.wait;
  const recovery = store.recover('claude').then(r => { events.push('recover'); return r; });
  assert.equal(await settled(recovery), false, 'recover did not run during the rotation');
  hold.open();
  await Promise.all([rotation, recovery]);
  assert.deepEqual(events, ['rotate', 'recover']);
});

test('a refresh and a rotation of the same account never overlap', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old', 'synthetic-refresh', ));
  await bind(store, 'claude', 'a'.repeat(16));
  const {createUsageTokenRefresher} = await import('../lib/v1/usage-token-refresh.mjs');
  const hold = barrier(), reached = barrier(), events = [];
  const first = store.rotate('claude', {value: claudeValue('synthetic-manual'), verify: async () => { events.push('manual-verify'); reached.open(); await hold.wait; return {ok: true, identity_sha256_16: 'a'.repeat(16)}; }})
    .then(r => { events.push('manual-done'); return r; });
  await reached.wait;
  const reader = {verify: async () => { events.push('refresh-verify'); return {ok: true, identity_sha256_16: 'a'.repeat(16)}; }};
  const fetchImpl = async () => ({status: 200, headers: {get: () => null}, json: async () => ({access_token: 'synthetic-refreshed', refresh_token: 'synthetic-r2', expires_in: 28800})});
  const refresher = createUsageTokenRefresher({store, reader, fetchImpl, now: () => 1, sleep: async () => {}, backoffMs: 0});
  const refreshing = refresher.refresh('claude', {force: true}).then(r => { events.push('refresh-done'); return r; });
  assert.equal(await settled(refreshing), false, 'the refresh waits for the rotation of its account');
  assert.deepEqual(events, ['manual-verify']);
  hold.open();
  await Promise.all([first, refreshing]);
  assert.deepEqual(events.slice(0, 3), ['manual-verify', 'manual-done', 'refresh-verify'], 'the refresh verified only after the rotation ended');
});

test('two added Codex accounts and a default Codex account each read, rotate and keep identity on their own', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'codex', codexValue('synthetic-default'));
  const [a, b] = [randomUUID(), randomUUID()];
  await store.addCodexAccount(a, codexValue('synthetic-a'));
  await store.addCodexAccount(b, codexValue('synthetic-b'));
  assert.deepEqual([(await store.credential('codex:' + a)).bearer, (await store.credential('codex:' + b)).bearer, (await store.credential('codex')).bearer],
    ['synthetic-a', 'synthetic-b', 'synthetic-default']);
  const credA = await store.credential('codex:' + a);
  assert.equal(credA.kind, 'oauth');
  assert.equal((await store.value('codex:' + a)).value.tokens.access_token, 'synthetic-a');
  await bind(store, 'codex:' + a, '1111111111111111');
  await bind(store, 'codex:' + b, '2222222222222222');
  const done = await store.rotate('codex:' + a, {value: codexValue('synthetic-a2'), verify: async bearer => ({ok: bearer === 'synthetic-a2', identity_sha256_16: '1111111111111111'})});
  assert.equal(done.ok, true);
  const after = await store.credential('codex:' + a);
  assert.deepEqual([after.bearer, after.generation === credA.generation], ['synthetic-a2', false]);
  assert.equal(await store.identity('codex:' + a), '1111111111111111');
  assert.equal((await store.credential('codex:' + b)).bearer, 'synthetic-b');
  assert.equal(await store.identity('codex:' + b), '2222222222222222');
  assert.equal((await store.credential('codex')).bearer, 'synthetic-default');
  const wrong = await store.rotate('codex:' + b, {value: codexValue('synthetic-b2'), verify: async () => ({ok: true, identity_sha256_16: '1111111111111111'})});
  assert.deepEqual([wrong.ok, wrong.reason], [false, 'identity_changed']);
  assert.equal((await store.credential('codex:' + b)).bearer, 'synthetic-b');
  await assert.rejects(store.credential('codex:' + randomUUID()), error => error.code === 'usage_credential_unavailable');
});

test('a first rotation must match the old account: the check of the new token cannot name the identity it is compared with', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  // Nothing bound yet, and the check even claims a "known" identity: the rotation still refuses.
  const unbound = await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: 'aaaaaaaaaaaaaaaa', known_identity_sha256_16: 'aaaaaaaaaaaaaaaa'})});
  assert.deepEqual([unbound.ok, unbound.reason], [false, 'identity_unbound']);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old');
  await bind(store, 'claude', 'bbbbbbbbbbbbbbbb');
  const other = await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: 'aaaaaaaaaaaaaaaa'})});
  assert.deepEqual([other.ok, other.reason], [false, 'identity_changed']);
  const same = await store.rotate('claude', {value: claudeValue('synthetic-new'), verify: async () => ({ok: true, identity_sha256_16: 'bbbbbbbbbbbbbbbb'})});
  assert.equal(same.ok, true);
});

test('an old successor record never vouches for a newer sign-in: a different account cannot inherit its identity or measurement time', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  await signIn(home, 'claude', claudeValue('synthetic-old'));
  const hashA = 'a'.repeat(16), hashB = 'b'.repeat(16);
  await bind(store, 'claude', hashA);
  assert.equal((await store.rotate('claude', {value: claudeValue('synthetic-a2'), measuredAt: 1000, verify: async () => ({ok: true, identity_sha256_16: hashA})})).ok, true);
  assert.equal((await store.successor('claude')).identity_sha256_16, hashA);
  // The owner signs in again, as another account. The old successor record is still on disk and names the earlier generation.
  await signIn(home, 'claude', claudeValue('synthetic-other-account'));
  assert.equal(await store.identity('claude'), null);
  // A token that reads as the OLD account must not be accepted on the strength of the old record.
  const stale = await store.rotate('claude', {value: claudeValue('synthetic-x'), verify: async () => ({ok: true, identity_sha256_16: hashA})});
  assert.deepEqual([stale.ok, stale.reason], [false, 'identity_unbound']);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-other-account');
  // Once the new account's own identity is bound, its rotation is judged against that identity and keeps no old measurement time.
  await bind(store, 'claude', hashB);
  assert.equal((await store.rotate('claude', {value: claudeValue('synthetic-b2'), measuredAt: 5000, verify: async () => ({ok: true, identity_sha256_16: hashB})})).ok, true);
  assert.equal((await store.successor('claude')).measured_at, 5000);
});

test('modern unpublished rotation drops only its pending intent', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home});
  const first = await signIn(home, 'claude', claudeValue('synthetic-unpublished-original'));
  const before = await store.value('claude'), orphan = await createProviderSource(home, 'claude');
  const pending = join(home, 'usage-successor-claude.json.pending');
  await writeFile(join(orphan.directory, '.credentials.json'), JSON.stringify(claudeValue('synthetic-unpublished-output')), {mode: 0o600});
  await writeFile(pending, JSON.stringify({version: 1, account_key: 'claude', prior_generation: first.id,
    output_source: orphan.id, identity_sha256_16: 'a'.repeat(16), measured_at: 101}), {mode: 0o600});
  assert.equal(await store.recover('claude'), 'dropped');
  assert.equal((await currentProviderGeneration(home, 'claude')).id, first.id);
  assert.equal((await store.value('claude')).generation, before.generation);
  assert.ok(JSON.stringify((await store.value('claude')).value) === JSON.stringify(before.value), 'stored value unchanged');
  await assert.rejects(stat(pending), {code: 'ENOENT'});
  await assert.rejects(stat(join(home, 'usage-successor-claude.json')), {code: 'ENOENT'});
  await assert.rejects(stat(join(home, 'usage-identity-claude.json')), {code: 'ENOENT'});
  assert.ok((await stat(orphan.directory)).isDirectory(), 'only the pending record is dropped');
  assert.equal(await store.recover('claude'), 'none');
});

test('same-account sign-in after interrupted rotation does not inherit its measurement', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home}), hash = 'b'.repeat(16);
  const first = await signIn(home, 'claude', claudeValue('synthetic-same-first'));
  await bind(store, 'claude', hash);
  const orphan = await createProviderSource(home, 'claude'), pending = join(home, 'usage-successor-claude.json.pending');
  await writeFile(join(orphan.directory, '.credentials.json'), JSON.stringify(claudeValue('synthetic-same-orphan')), {mode: 0o600});
  await writeFile(pending, JSON.stringify({version: 1, account_key: 'claude', prior_generation: first.id,
    output_source: orphan.id, identity_sha256_16: hash, measured_at: 111}), {mode: 0o600});
  const signedIn = await signIn(home, 'claude', claudeValue('synthetic-same-later'));
  await bind(store, 'claude', hash); // The later sign-in independently reads as the SAME account.
  assert.equal(await store.recover('claude'), 'dropped');
  await assert.rejects(stat(pending), {code: 'ENOENT'});
  assert.equal((await store.credential('claude')).generation, signedIn.id);
  assert.equal(await store.identity('claude'), hash);
  assert.equal(await store.successor('claude'), null);
  const rotated = await store.rotate('claude', {value: claudeValue('synthetic-same-refreshed'), measuredAt: 222,
    verify: async () => ({ok: true, identity_sha256_16: hash})});
  assert.equal(rotated.ok, true);
  const successor = await store.successor('claude');
  assert.deepEqual([successor.prior_generation, successor.generation, successor.identity_sha256_16, successor.measured_at],
    [signedIn.id, rotated.generation, hash, 222]);
});

test('two durable pending rotations recover only their own source and exact measurement', async t => {
  const home = await freshHome(t), store = createUsageAccountStore({home}), cases = [];
  for (const [key, make, hash, measured] of [
    ['claude', claudeValue, 'c'.repeat(16), 301], ['codex', codexValue, 'd'.repeat(16), 902],
  ]) {
    const first = await signIn(home, key, make('synthetic-independent-first'));
    const source = await createProviderSource(home, key);
    const pending = join(home, 'usage-successor-' + key + '.json.pending');
    await writeFile(pending, JSON.stringify({version: 1, account_key: key, prior_generation: first.id,
      output_source: source.id, identity_sha256_16: hash, measured_at: measured}), {mode: 0o600});
    await writeFile(join(source.directory, key === 'claude' ? '.credentials.json' : 'auth.json'),
      JSON.stringify(make('synthetic-independent-output')), {mode: 0o600});
    const published = await publishProviderGeneration(home, source);
    cases.push({key, first, source, published, pending, hash, measured});
  }
  assert.notEqual(cases[0].source.id, cases[1].source.id);
  assert.ok((await stat(cases[0].pending)).isFile() && (await stat(cases[1].pending)).isFile());
  for (const {key, first, source, published, pending, hash, measured} of cases) {
    assert.equal(await store.recover(key), 'finished');
    const successor = await store.successor(key);
    assert.deepEqual(successor, {version: 1, account_key: key, prior_generation: first.id,
      identity_sha256_16: hash, measured_at: measured, generation: published.id, carried: true});
    const current = await currentProviderGeneration(home, key);
    assert.deepEqual([current.id, current.source.id], [published.id, source.id]);
    await assert.rejects(stat(pending), {code: 'ENOENT'});
    assert.equal(await store.recover(key), 'none');
    if (key === 'claude') assert.ok((await stat(cases[1].pending)).isFile(), 'other account intent remains');
  }
});
