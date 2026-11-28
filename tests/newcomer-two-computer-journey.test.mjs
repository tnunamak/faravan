import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, access, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {connect} from 'node:net';
import {appFixture, api, browserApi, syntheticBackend, waitFor} from './helpers/triage-small-app-fixture.mjs';
import {git} from './helpers/git-guest.mjs';
import {formatMembership} from '../ui/v1/src/membership-projection-view.mjs';
import {jobVM} from '../ui/v1/src/view-models.mjs';

const answer = 'I changed the greeting to Hello from your friend.';
const changedFile = 'Hello from your friend.\n';
const wait = (check, label) => waitFor(check, label, 30000);
const post = (app, path, body = {}) => api(app, path, {method:'POST', body, ...((path==='/api/jobs'||path.endsWith('/apply'))?{headers:{'faravan-confirm':'yes'}}:{})});
const children = () => process._getActiveHandles().filter(handle =>
  handle.constructor?.name === 'ChildProcess' && handle.exitCode === null && handle.signalCode === null);

async function assertPortClosed(origin) {
  const url = new URL(origin);
  await new Promise((resolve, reject) => {
    const socket = connect({host:url.hostname, port:Number(url.port)});
    socket.once('connect', () => {socket.destroy(); reject(new Error('A test server is still listening.'));});
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.setTimeout(5000, () => {socket.destroy(); reject(new Error('Could not check the closed test port.'));});
  });
}

test('a friend joins, sends a job, reads the answer and adds a branch without changing their work',
  {timeout:85000}, async t => {
    const cleanup = [], peers = [], previousChildren = new Set(children());
    let f, run, cleaned = false;
    // Run every fixture cleanup even if a prior cleanup or a journey assertion fails.
    const close = async () => {
      if (cleaned) return;
      cleaned = true;
      const errors = [];
      if (run) run.hold = false;
      for (const peer of peers) peer.backend.release?.();
      for (const action of cleanup.reverse()) {
        try {await action();} catch (error) {errors.push(error);}
      }
      for (const peer of peers) {
        try {assert.equal(peer.app.server.listening, false, 'The app server stopped.');}
        catch (error) {errors.push(error);}
      }
      if (f) {
        try {await assertPortClosed(f.origin);} catch (error) {errors.push(error);}
        try {await assert.rejects(access(f.root), {code:'ENOENT'}, 'Both homes and the project were removed.');}
        catch (error) {errors.push(error);}
      }
      try {await wait(() => children().every(child => previousChildren.has(child)), 'all test child processes to exit');}
      catch (error) {errors.push(error);}
      if (errors.length) throw new AggregateError(errors, 'Test cleanup failed.');
    };
    t.after(close);
    f = await appFixture({after:action => cleanup.push(action)});
    run = {hold:true, captureStream:true, finalMessage:answer,
      change:{path:'greeting.txt', bytes:changedFile}};
    const homeA = await f.home('computer-a'), homeB = await f.home('computer-b');
    const a = await f.start('computer-a', {userHome:homeA, backend:syntheticBackend(f.root, run)});
    peers.push(a);
    const b = await f.start('computer-b', {userHome:homeB, pollMs:250});
    peers.push(b);
    assert.notEqual(a.home, b.home, 'The two computers have separate homes.');
    assert.notEqual(a.app.origin, b.app.origin, 'The two computers have separate app servers.');
    for (const peer of [a, b]) {
      const circles = await api(peer.app, '/api/circles');
      assert.equal(circles.length, 1, 'A fresh computer starts with its local circle.');
      assert.equal(circles[0].owned, true);
      assert.equal(circles[0].origin, null, 'A fresh computer has not joined a remote circle.');
    }

    // Only the coordinator trust root is fixture setup. Every user action below uses HTTP.
    await f.provisionFromHome('computer-a');
    const circle = await post(a.app, '/api/circles', {origin:f.origin, name:'Our friends'});
    const circlePath = '/api/circles/' + encodeURIComponent(circle.id);
    assert.equal((await api(a.app, '/api/circles')).find(row => row.id === circle.id)?.name, 'Our friends');
    await post(a.app, circlePath + '/approval-mode', {approveEach:true});
    const {invite} = await post(a.app, circlePath + '/invite');
    assert.equal(typeof invite, 'string');
    assert.ok(invite.length > 0, 'The invitation is available to copy.');
    await post(b.app, '/api/circles/join', {link:invite});
    const membership = async () => (await api(b.app, '/api/circles')).find(row => row.id === circle.id);
    assert.equal(formatMembership(await membership()).status, 'Waiting for approval');
    const pending = await api(a.app, circlePath + '/approvals');
    assert.equal(pending.length, 1, 'Only the new computer needs approval.');
    await post(a.app, circlePath + '/approve', {enrollmentId:pending[0].enrollment_id});
    await post(b.app, circlePath + '/check');
    assert.equal(formatMembership(await membership(), {surface:'join-status'}).message, 'This computer is a member.');
    assert.equal((await api(a.app, '/api/status')).intent.on, false, 'Approving a friend does not turn lending on.');

    const repo = join(homeB, 'project');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Journey test');
    git(repo, 'config', 'user.email', 'journey@example.test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    const originals = {'greeting.txt':'Hello.\n', 'staged.txt':'Original staged file.\n', 'unstaged.txt':'Original unstaged file.\n'};
    for (const [path, bytes] of Object.entries(originals)) await writeFile(join(repo, path), bytes);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Original project');
    await writeFile(join(repo, 'staged.txt'), 'Keep my staged work.\n');
    git(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'unstaged.txt'), 'Keep my unstaged work.\n');
    await writeFile(join(repo, 'untracked.txt'), 'Keep my untracked work.\n');
    const snapshot = async () => ({
      branch:git(repo, 'symbolic-ref', 'HEAD'), head:git(repo, 'rev-parse', 'HEAD'),
      status:git(repo, 'status', '--porcelain=v1', '--untracked-files=all'),
      staged:git(repo, 'diff', '--cached', '--binary'), unstaged:git(repo, 'diff', '--binary'),
      files:await Promise.all([...Object.keys(originals), 'untracked.txt'].map(path => readFile(join(repo, path), 'utf8'))),
    });
    const before = await snapshot();

    await post(a.app, '/api/lending/limits', {dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, idleOnly:false});
    await post(a.app, '/api/agents/codex', {useForLending:true});
    await post(a.app, '/api/lending/mode', {circle:circle.id, mode:'ask'});
    await post(a.app, '/api/lending/on', {circle:circle.id});
    const prompt = 'Change greeting.txt to Hello from your friend. Explain what changed.';
    // The friend uses the app on their own computer: the browser owner, who sends no confirm header.
    const ui = await browserApi(b.app);
    const sent = await ui('/api/jobs', {method:'POST', body:{circle:circle.id, prompt, harness:'codex',
      repo:{path:repo, includeUncommitted:false}}});
    const path = '/api/jobs/' + encodeURIComponent(sent.jobDigest);
    const query = '?circle=' + encodeURIComponent(circle.id);
    const view = () => api(b.app, path + query);
    const waiting = await view();
    assert.match(waiting.status, /^Waiting/);
    assert.match(jobVM(waiting).word, /^Waiting/);
    const card = await wait(async () => (await api(a.app, '/api/approvals')).find(row => row.jobDigest === sent.jobDigest), 'the request to review');
    assert.equal(card.prompt, prompt, 'The friend sees the same request.');
    assert.equal(a.backend.calls.filter(([kind]) => kind === 'run').length, 0, 'The job has not run before approval.');
    await post(a.app, '/api/approvals/' + encodeURIComponent(card.id) + '/accept');
    const working = await wait(async () => {const value = await view(); return value.status === 'Working' && value;}, 'Working');
    assert.equal(jobVM(working).word, 'Working');
    assert.equal(a.backend.calls.filter(([kind]) => kind === 'run').length, 1, 'The synthetic runner starts exactly once.');
    assert.deepEqual(await snapshot(), before, 'Sending the project left local work unchanged.');
    run.hold = false;
    a.backend.release();
    const finished = await wait(async () => {const value = await view(); return value.status === 'Finished' && value;}, 'Finished');
    const transcript = await api(b.app, path + '/transcript' + query);
    assert.ok(transcript.text.includes(answer), 'The answer reaches the computer that sent the job.');
    const changes = await api(b.app, path + '/changes' + query);
    assert.equal(jobVM(finished, 'sent', {changes}).word, 'Ready to review');
    assert.equal(b.backend.calls.filter(([kind]) => kind === 'run').length, 0, 'The sender did not run its own job.');
    await wait(() => a.backend.calls.filter(([kind]) => kind === 'destroy').length === 1, 'the synthetic workspace to be removed');
    await assert.rejects(access(run.workspace), {code:'ENOENT'});

    const branch = 'friend-greeting';
    const branchesBefore = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    const input = {circle:circle.id, repo, branch};
    const preview = await post(b.app, path + '/apply', {...input, dry_run:true});
    assert.equal(preview.status, 'dry_run');
    assert.equal(typeof preview.preview_token, 'string');
    assert.deepEqual(await snapshot(), before, 'Preview leaves the current branch and work unchanged.');
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), branchesBefore);
    // Applying changes the person's repository; the app's Apply button sends as the browser owner, with no confirm header.
    const applied = await ui(path + '/apply', {method:'POST', body:{...input, dry_run:false, expect:{preview_token:preview.preview_token}}});
    assert.equal(applied.status, 'applied');
    assert.equal(applied.branch, branch);
    assert.equal(git(repo, 'show', branch + ':greeting.txt'), changedFile.trim());
    assert.equal(git(repo, 'show', branch + ':staged.txt'), originals['staged.txt'].trim());
    assert.equal(git(repo, 'show', branch + ':unstaged.txt'), originals['unstaged.txt'].trim());
    assert.equal(git(repo, 'ls-tree', '--name-only', branch, 'untracked.txt'), '');
    assert.equal(git(repo, 'rev-parse', branch + '^'), before.head, 'The new branch starts from the submitted commit.');
    assert.deepEqual(await snapshot(), before, 'Adding the branch preserves the current branch, index and all local edits.');
    const added = await view();
    assert.equal(added.applied?.branch, branch);
    assert.equal(jobVM(added, 'sent', {changes}).word, 'Added as a branch');
    const jobs = await api(b.app, '/api/jobs');
    assert.equal(jobs.length, 1, 'The sender sees the one job it sent.');
    assert.equal(jobs[0].job_digest, sent.jobDigest);
    await close();
  });
