import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {publishPublic} from '../scripts/publish-public.mjs';

const AUTHOR = 'Approved <12345+approved@users.noreply.github.com>';
const MARKER = 'PlantedMarker';

function fixture(t, failCheck = false) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-public-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8', stdio:'pipe'}).trim();
  const sourceRepo = join(dir, 'source'), publicClone = join(dir, 'public'), dest = join(dir,'destination.git');
  mkdirSync(dest); git(dest, 'init', '--bare', '-qb', 'main');
  for (const root of [sourceRepo, publicClone]) {
    mkdirSync(root); git(root, 'init', '-qb', 'main');
    git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  }
  mkdirSync(join(sourceRepo, 'scripts/rename'), {recursive:true});
  writeFileSync(join(sourceRepo, 'scripts/rename/faravan-codemod.mjs'), `
    import {writeFileSync} from 'node:fs';
    if (process.argv[2] === '--apply') writeFileSync('README.md', 'renamed source');
    if (process.argv[2] === '--check') { console.log('rename check'); process.exit(${failCheck ? 1 : 0}); }
  `);
  mkdirSync(join(sourceRepo, 'docs/history'), {recursive:true});
  writeFileSync(join(sourceRepo, 'docs/history/private.md'), 'excluded');
  writeFileSync(join(sourceRepo, 'private.txt'), 'not allowed');
  writeFileSync(join(sourceRepo, 'README.md'), 'original source');
  git(sourceRepo, 'add', '.'); git(sourceRepo, 'commit', '-qm', 'source');
  git(sourceRepo,'config','user.email','source@example.invalid');
  git(publicClone,'config','user.email','clone@example.invalid');
  git(publicClone,'remote','add','origin',dest);
  const scratchRoot = join(dir, 'worktrees');
  const denyFile = join(dir, 'deny.txt');
  writeFileSync(denyFile, `# private markers\n${MARKER.toLowerCase()}\n`);
  const options = {sourceRepo, publicClone, dest, author:AUTHOR, denyFile, scanner:()=>({status:0}), scratchRoot, commit:git(sourceRepo, 'rev-parse', 'HEAD')};
  const run = (extra = {}) => publishPublic({...options, ...extra});
  return {dir, git, sourceRepo, publicClone, dest, scratchRoot, denyFile, options, run};
}

test('a verified dry run leaves the clone unborn; the same export publishes only once', t => {
  const f = fixture(t);
  const dry = f.run();
  assert.equal(dry.scanned,true);
  assert.deepEqual(readdirSync(f.publicClone), ['.git']);
  assert.equal(f.git(f.dest, 'for-each-ref'), '');
  const first = f.run({push:true});
  assert.equal(f.git(f.publicClone, 'rev-list', '--parents', '-n', '1', 'HEAD'), first.publicCommit);
  assert.equal(readFileSync(join(f.publicClone, 'README.md'), 'utf8'), 'renamed source');
  const manifest = JSON.parse(readFileSync(first.manifest, 'utf8'));
  assert.ok(manifest.excluded.some(row => row.path === 'docs/history/private.md' && row.reason === 'docs/history/'));
  assert.ok(manifest.excluded.some(row => row.path === 'private.txt' && row.reason === 'not in ALLOWLIST'));
  assert.ok(manifest.exported.some(row => row.path === 'README.md' && row.sha256 === createHash('sha256').update('renamed source').digest('hex')));
  const second = f.run({push:true});
  assert.equal(f.git(f.publicClone, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(second.unchanged,true);
  assert.equal(second.publicCommit,first.publicCommit);
  assert.equal(f.git(f.publicClone, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'),
    AUTHOR.replace(/^Approved <(.*)>$/, 'Approved <$1> / Approved <$1>'));
  assert.deepEqual(readdirSync(f.scratchRoot), []);
});

test('rename check failure leaves both histories and public files untouched and removes scratch', t => {
  const f = fixture(t, true);
  assert.throws(() => f.run(), /rename.*--check/s);
  const commitObjects = f.git(f.sourceRepo, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype)')
    .split('\n').filter(type => type === 'commit');
  assert.equal(commitObjects.length, 1, 'a failed check must not leave even an unreachable scratch commit');
  assert.deepEqual(readdirSync(f.publicClone), ['.git']);
  assert.deepEqual(readdirSync(f.scratchRoot), []);
});

test('push accepts an empty remote and a fast-forward, refuses divergence without force', t => {
  const f = fixture(t), remote = f.dest;
  const trace = join(f.dir, 'git.trace'), previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  t.after(() => { if (previousTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previousTrace; });
  const first = f.run({push:true});
  assert.equal(f.git(remote, 'rev-parse', 'main'), first.publicCommit);
  writeFileSync(join(f.sourceRepo, 'LICENSE.md'), 'second public tree');
  f.git(f.sourceRepo, 'add', '.'); f.git(f.sourceRepo, 'commit', '-qm', 'second source');
  const second = f.run({push:true,commit:f.git(f.sourceRepo,'rev-parse','HEAD')});
  assert.equal(f.git(remote, 'rev-parse', 'main'), second.publicCommit);
  f.git(f.publicClone, 'reset', '--hard', first.publicCommit);
  writeFileSync(join(f.sourceRepo, 'LICENSE.md'), 'different tree');
  f.git(f.sourceRepo, 'add', '.'); f.git(f.sourceRepo, 'commit', '-qm', 'changed source');
  assert.throws(() => f.run({push:true, commit:f.git(f.sourceRepo, 'rev-parse', 'HEAD')}), /reset the clone to the destination main tip/);
  assert.equal(f.git(remote, 'rev-parse', 'main'), second.publicCommit);
  const pushes = readFileSync(trace, 'utf8').split('\n').filter(line => /built-in: git push /.test(line));
  assert.equal(pushes.length, 2, 'divergence is refused before push is invoked');
  assert.ok(pushes.every(line => !line.includes('--force') && !line.includes('HEAD:')), 'every push is unforced and never pushes the mutable HEAD');
  assert.ok(pushes[0].includes(`${first.publicCommit}:refs/heads/main`) && pushes[1].includes(`${second.publicCommit}:refs/heads/main`),
    'each push names the verified, scanned commit by SHA');
  assert.deepEqual(readdirSync(f.scratchRoot), []);
});

test('refuses a dirty public clone before changing it', t => {
  const f = fixture(t);
  writeFileSync(join(f.publicClone, 'precious.txt'), 'keep');
  assert.throws(() => f.run(), /clean/);
  assert.equal(readFileSync(join(f.publicClone, 'precious.txt'), 'utf8'), 'keep');
});

test('the source repository cannot be used as the public clone', t => {
  const f = fixture(t);
  assert.throws(() => f.run({publicClone:f.sourceRepo}), /independent Git history/);
  assert.equal(f.git(f.sourceRepo, 'rev-parse', 'HEAD'), f.options.commit);
});

test('source-tracked files stay tracked even when they match exported ignore rules', t => {
  const f = fixture(t);
  mkdirSync(join(f.sourceRepo, 'lib'));
  writeFileSync(join(f.sourceRepo, '.gitignore'), 'lib/ignored.mjs\n');
  writeFileSync(join(f.sourceRepo, 'lib/ignored.mjs'), 'export const included = true;\n');
  f.git(f.sourceRepo, 'add', '-f', '.gitignore', 'lib/ignored.mjs');
  f.git(f.sourceRepo, 'commit', '-qm', 'tracked ignored input');
  const result = f.run({push:true,commit:f.git(f.sourceRepo, 'rev-parse', 'HEAD')});
  assert.equal(result.fileCount, 3);
  assert.equal(f.git(f.publicClone, 'show', 'HEAD:lib/ignored.mjs'), 'export const included = true;');
});

test('refuses unapproved destination and source ancestry without publishing', t => {
  const f=fixture(t), other=join(f.dir,'other.git');
  mkdirSync(other);f.git(other,'init','--bare','-qb','main');
  f.git(f.publicClone,'remote','set-url','--push','origin',other);
  assert.throws(()=>f.run({push:true}),/approved destination/);
  assert.equal(f.git(other,'for-each-ref'),'');
  f.git(f.publicClone,'remote','set-url','--push','origin',f.dest);
  const clone=join(f.dir,'separate-clone');
  f.git(f.dir,'clone','--no-local',f.sourceRepo,clone);
  f.git(clone,'remote','set-url','origin',f.dest);
  assert.throws(()=>f.run({publicClone:clone,push:true}),/contains source history/);
  assert.equal(f.git(f.dest,'for-each-ref'),'');
});

test('refuses unreviewed staged content and scanner failures before moving main', t => {
  const f=fixture(t);
  for(const scanner of [()=>({status:1}),()=>{throw new Error('inert scanner failure');}]){
    assert.throws(()=>f.run({push:true,scanner}),/secret scan did not pass/);
    assert.equal(f.git(f.dest,'for-each-ref'),'');
  }
  // The scanner receives the exact preview; a tree modified during this check is never committed.
  assert.throws(()=>f.run({push:true,scanner:({output})=>{
    writeFileSync(join(output,'unexpected.txt'),'an inert extra file');
    return {status:0};
  }}),/staged tree differs from reviewed export/);
  assert.equal(f.git(f.dest,'for-each-ref'),'');
});

test('a refused refresh retries the same verified local commit', t => {
  const f=fixture(t);
  const first=f.run({push:true});
  const hook=join(f.dest,'hooks','pre-receive');
  writeFileSync(hook,'#!/bin/sh\nexit 1\n',{mode:0o755});
  writeFileSync(join(f.sourceRepo,'LICENSE.md'),'new public text');
  f.git(f.sourceRepo,'add','LICENSE.md');f.git(f.sourceRepo,'commit','-qm','refresh source');
  const commit=f.git(f.sourceRepo,'rev-parse','HEAD');
  assert.throws(()=>f.run({push:true,commit}),/push|remote rejected/);
  const held=f.git(f.publicClone,'rev-parse','HEAD');
  assert.equal(f.git(f.dest,'rev-parse','main'),first.publicCommit);
  assert.equal(f.git(f.publicClone,'rev-list','--count','HEAD'),'2');
  rmSync(hook);
  const result=f.run({push:true,commit});
  assert.equal(result.publicCommit,held);
  assert.equal(f.git(f.dest,'rev-parse','main'),held);
  assert.equal(f.git(f.publicClone,'rev-list','--count','HEAD'),'2');
});

const commitSource = (f, name, content, message = 'planted') => {
  mkdirSync(dirname(join(f.sourceRepo, name)), {recursive:true});
  writeFileSync(join(f.sourceRepo, name), content);
  f.git(f.sourceRepo, 'add', '--', name); f.git(f.sourceRepo, 'commit', '-qm', message);
  return f.git(f.sourceRepo, 'rev-parse', 'HEAD');
};
const untouched = f => {
  assert.equal(f.git(f.dest, 'for-each-ref'), '');
  assert.deepEqual(readdirSync(f.publicClone), ['.git']);
  if (existsSync(f.scratchRoot)) assert.deepEqual(readdirSync(f.scratchRoot), []);
};

test('the author must be a GitHub noreply identity, and is required', t => {
  const f = fixture(t);
  for (const author of [undefined, '', 'Approved <public@example.invalid>', 'Approved <someone@gmail.com>',
    'Approved <12345+approved@users.noreply.github.com.evil.test>', 'Approved <+approved@users.noreply.github.com>',
    'Approved <abc+def@users.noreply.github.com>', '<12345+approved@users.noreply.github.com>'])
    assert.throws(() => f.run({author}), /author/, String(author));
  untouched(f);
  for (const author of ['A <approved@users.noreply.github.com>', 'A <1+a-b@users.noreply.github.com>'])
    assert.equal(f.run({author}).scanned, true, author);
});

test('a deny-file marker in content, a file name or an archive refuses the export without naming the marker', t => {
  const f = fixture(t);
  commitSource(f, 'LICENSE.md', `first line\nsee ${MARKER} here\n`);
  commitSource(f, `lib/${MARKER.toUpperCase()}.mjs`, 'export {};\n');
  const commit = commitSource(f, 'vendor/bundle.tgz', gzipSync(`hidden ${MARKER}\n`));
  for (const push of [false, true]) {
    let message = '';
    assert.throws(() => f.run({commit, push}), error => { message = error.message; return /private markers found/.test(error.message); });
    assert.match(message, /LICENSE\.md:2 \(deny-file line 2\)/);
    assert.match(message, /export file #\d+ \(exported\[\d+\] in manifest\.json\): file name \(deny-file line 2\)/);
    assert.match(message, /vendor\/bundle\.tgz \[inside archive\]:1 \(deny-file line 2\)/);
    assert.ok(!message.toLowerCase().includes(MARKER.toLowerCase()), 'the refusal never prints the marker');
    untouched(f);
  }
});

test('a word: deny entry refuses a case-sensitive whole word, not text that merely contains it', t => {
  // The refused word is a person's first name. It is built from parts so this file does not carry it
  // into the public tree, which the same deny entry would then refuse.
  const W = ['T', 'i', 'm'].join(''), lower = W.toLowerCase(), upper = W.toUpperCase();
  const f = fixture(t);
  writeFileSync(f.denyFile, `# private markers\nword:${W}\n`);
  const clean = commitSource(f, 'LICENSE.md', `time\n${W}eout\noptimise\n${upper}ING and ${lower}\nEx${W}\nmaximum\n`);
  assert.equal(f.run({commit: clean}).denyChecked, true, 'time, <word>eout, optimise, upper case, lower case and Ex<word> pass');
  commitSource(f, 'LICENSE.md', `time\n${W}\n${W}eout\n${W}'s\noptimise\n${W}\u2019s laptop\n${lower}\n`);
  commitSource(f, `lib/${W}.mjs`, 'export {};\n');
  const commit = commitSource(f, 'vendor/bundle.tgz', gzipSync(`x\n${W} wrote this\n`));
  let message = '';
  assert.throws(() => f.run({commit}), error => { message = error.message; return /private markers found/.test(error.message); });
  for (const row of [2, 4, 6]) assert.match(message, new RegExp(`LICENSE\\.md:${row} \\(deny-file line 2\\)`), `row ${row} names the word`);
  for (const row of [1, 3, 5, 7]) assert.doesNotMatch(message, new RegExp(`LICENSE\\.md:${row} `), `row ${row} does not`);
  assert.match(message, /export file #\d+ \(exported\[\d+\] in manifest\.json\): file name \(deny-file line 2\)/);
  assert.match(message, /vendor\/bundle\.tgz \[inside archive\]:2 \(deny-file line 2\)/);
  assert.ok(!message.includes(W), 'the refusal never prints the marker');
  untouched(f);
  const blank = join(f.dir, 'empty-word.txt');
  writeFileSync(blank, 'word:\n');
  assert.throws(() => f.run({denyFile: blank}), /deny file line 1: a word: marker needs a word/);
});

test('a word: entry spares only the LICENSE.md copyright line, matched by path and exact text', t => {
  const W = ['T', 'i', 'm'].join(''); // built from parts so this file does not carry the word into the public tree
  const LINE = `Copyright 2026 ${W} Nunamaker`;
  const license = (...rest) => ['MIT License', '', 'one', 'two', 'three', 'four', 'five', 'six', LINE, ...rest].join('\n')+'\n';
  const f = fixture(t);
  writeFileSync(f.denyFile, `# private markers\nword:${W}\n`);
  const refusal = commit => {
    let message = '';
    assert.throws(() => f.run({commit}), error => { message = error.message; return /private markers found/.test(error.message); });
    assert.ok(!message.includes(W), 'the refusal never prints the marker');
    untouched(f);
    return message;
  };
  const exempt = commitSource(f, 'LICENSE.md', license('Permission is hereby granted.'));
  assert.equal(f.run({commit: exempt}).denyChecked, true, 'the exact line at line 9 of LICENSE.md passes');
  // The word on any other line of LICENSE.md refuses, and the exempt line is not named.
  const otherLine = refusal(commitSource(f, 'LICENSE.md', license(`Contact ${W}`)));
  assert.match(otherLine, /LICENSE\.md:10 \(deny-file line 2\)/);
  assert.doesNotMatch(otherLine, /LICENSE\.md:9 /);
  // The word in any other file refuses, even when a line of it equals the exempt text.
  const elsewhere = refusal(commitSource(f, 'lib/notice.txt', `${LINE}\n`));
  assert.match(elsewhere, /lib\/notice\.txt:1 \(deny-file line 2\)/);
  // A holder line that is not exactly the exempt text refuses.
  for (const changed of [`${LINE} Jr`, `${LINE}-Smith`, `${LINE}\u2019s`, LINE.replace('2026', '2027'), ` ${LINE}`, LINE.replace(W, `${W} X`)]) {
    assert.match(refusal(commitSource(f, 'LICENSE.md', license().replace(LINE, changed))), /LICENSE\.md:9 \(deny-file line 2\)/, changed);
  }
  // The exemption waives word: entries only: a plain entry that matches the exempt line still refuses.
  const plain = join(f.dir, 'plain-too.txt');
  writeFileSync(plain, `word:${W}\nnunamaker\n`);
  assert.throws(() => f.run({commit: exempt, denyFile: plain}), error => /LICENSE\.md:9 \(deny-file line 2\)/.test(error.message) && !/deny-file line 1/.test(error.message));
});

test('a lower-case word: entry beside the capitalised one refuses only the lower-case word, and spares the LICENSE.md line', t => {
  const W = ['T', 'i', 'm'].join(''), lower = W.toLowerCase(); // built from parts so this file does not carry the word
  const f = fixture(t);
  writeFileSync(f.denyFile, `# private markers\nword:${W}\nword:${lower}\n`);
  const LINE = `Copyright 2026 ${W} Nunamaker`;
  const clean = commitSource(f, 'LICENSE.md', `MIT License\n${LINE}\ntime\ntimeout\noptimise\nEstimate\n${lower.toUpperCase()}ING\n`);
  assert.equal(f.run({commit: clean}).denyChecked, true, 'time, timeout, optimise, estimate and the LICENSE.md line pass');
  for (const text of [lower, `${lower}'s laptop`, `circle-${lower}`, `${lower}_driven`]) {
    const commit = commitSource(f, 'lib/fixture.mjs', `// ok\n// ${text}\n`);
    let message = '';
    assert.throws(() => f.run({commit}), error => { message = error.message; return /private markers found/.test(error.message); }, text);
    assert.match(message, /lib\/fixture\.mjs:2 \(deny-file line 3\)/, text);
    assert.doesNotMatch(message, /deny-file line 2/, 'the capitalised entry does not match lower case');
    untouched(f);
  }
});

test('the public commit message carries the export tree hash and never a source commit', t => {
  const f = fixture(t);
  commitSource(f, 'lib/more.mjs', 'export {};\n');
  const sourceHead = f.git(f.sourceRepo, 'rev-parse', 'HEAD');
  const result = f.run({push:true, commit: sourceHead});
  const message = f.git(f.dest, 'log', '-1', '--format=%B', 'main');
  assert.match(message, new RegExp(`^Public-Tree: ${result.tree}$`, 'm'), 'the message names the export tree');
  assert.ok(!message.includes(sourceHead), 'the message never names the source head');
  assert.doesNotMatch(message, /Source-Commit/);
  // No 40-hex string in the message resolves to an object of the source repository, except none at all.
  for (const hex of message.match(/\b[0-9a-f]{40}\b/g) ?? []) {
    assert.throws(() => f.git(f.sourceRepo, 'cat-file', '-e', hex), undefined, `${hex} must not exist in the source repository`);
  }
});

test('a clean tree passes the deny-file check on a dry run and a push', t => {
  const f = fixture(t);
  const dry = f.run();
  assert.equal(dry.denyChecked, true);
  assert.equal(dry.scanned, true);
  const pushed = f.run({push:true});
  assert.equal(pushed.denyChecked, true);
  assert.equal(f.git(f.dest, 'rev-parse', 'main'), pushed.publicCommit);
});

test('a push requires the deny file; a dry run without it warns loudly', t => {
  const f = fixture(t);
  assert.throws(() => f.run({push:true, denyFile:undefined}), /--deny-file is required to push/);
  untouched(f);
  const written = [], write = process.stderr.write;
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  let dry;
  try { dry = f.run({denyFile:undefined}); } finally { process.stderr.write = write; }
  assert.equal(dry.denyChecked, false);
  assert.match(written.join(''), /WARNING: no --deny-file; private markers were NOT checked/);
});

test('a deny file inside the repositories, or with no markers, is refused', t => {
  const f = fixture(t);
  const inside = join(f.sourceRepo, 'deny.txt');
  writeFileSync(inside, MARKER+'\n');
  assert.throws(() => f.run({denyFile:inside}), /outside the source repository/);
  const blank = join(f.dir, 'blank.txt');
  writeFileSync(blank, '# only comments\n\n');
  assert.throws(() => f.run({denyFile:blank}), /no markers/);
  assert.throws(() => f.run({denyFile:'relative/deny.txt'}), /absolute path/);
  untouched(f);
});

test('the secret scan also looks inside nested archives', t => {
  const f = fixture(t), args = join(f.dir, 'scanner-args');
  const scanner = join(f.dir, 'fake-gitleaks');
  writeFileSync(scanner, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nexit 0\n`, {mode:0o755});
  assert.equal(f.run({scanner}).scanned, true);
  const seen = readFileSync(args, 'utf8').split('\n');
  assert.equal(seen[seen.indexOf('--max-archive-depth') + 1], '3');
});

test('a destination-rewriting Git config refuses the export, from a config file or the environment', t => {
  const f = fixture(t);
  for (const key of ['insteadOf', 'pushInsteadOf']) {
    f.git(f.publicClone, 'config', `url.https://rewritten.invalid/.${key}`, 'file:///nowhere/');
    assert.throws(() => f.run(), /URL rewriting/, key);
    f.git(f.publicClone, 'config', '--unset', `url.https://rewritten.invalid/.${key}`);
  }
  assert.equal(f.run().scanned, true, 'the config is clean again');
  const saved = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  Object.assign(process.env, {GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'url.https://rewritten.invalid/.insteadOf', GIT_CONFIG_VALUE_0:'file:///nowhere/'});
  assert.throws(() => f.run(), /URL rewriting/);
  untouched(f);
});

test('a missing gitleaks leaves a dry run unscanned but refuses a push', t => {
  const f = fixture(t), bin = join(f.dir, 'bin');
  mkdirSync(bin);
  for (const name of ['git', 'tar', 'sh']) symlinkSync(execFileSync('sh', ['-c', `command -v ${name}`], {encoding:'utf8'}).trim(), join(bin, name));
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = bin;
  const options = {scanner:undefined};
  assert.equal(f.run(options).scanned, false, 'a dry run says it was not scanned');
  assert.throws(() => f.run({...options, push:true}), /secret scan did not pass/);
  process.env.PATH = path;
  untouched(f);
});

test('the destination is verified again just before the push', t => {
  const f = fixture(t), other = join(f.dir, 'other.git');
  mkdirSync(other); f.git(other, 'init', '--bare', '-qb', 'main');
  const scanner = () => { f.git(f.publicClone, 'remote', 'set-url', '--push', 'origin', other); return {status:0}; };
  assert.throws(() => f.run({push:true, scanner}), /approved destination/);
  assert.equal(f.git(f.dest, 'for-each-ref'), '');
  assert.equal(f.git(other, 'for-each-ref'), '');
});

test('a public clone that already has commits cannot bootstrap an empty destination', t => {
  const f = fixture(t);
  writeFileSync(join(f.publicClone, 'local.txt'), 'a local public commit');
  f.git(f.publicClone, 'add', 'local.txt'); f.git(f.publicClone, 'commit', '-qm', 'local');
  assert.throws(() => f.run(), /bootstrap requires an unborn public main/);
  assert.throws(() => f.run({push:true}), /bootstrap requires an unborn public main/);
  assert.equal(f.git(f.dest, 'for-each-ref'), '');
});

test('a shallow public clone is refused', t => {
  const f = fixture(t), history = join(f.dir, 'history'), shallow = join(f.dir, 'shallow');
  mkdirSync(history); f.git(history, 'init', '-qb', 'main');
  f.git(history, 'config', 'user.name', 'Fixture'); f.git(history, 'config', 'user.email', 'fixture@example.invalid');
  for (const n of ['one', 'two']) { writeFileSync(join(history, n), n); f.git(history, 'add', n); f.git(history, 'commit', '-qm', n); }
  f.git(f.dir, 'clone', '-q', '--depth', '1', 'file://'+history, shallow);
  f.git(shallow, 'remote', 'set-url', 'origin', f.dest);
  assert.equal(f.git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.throws(() => f.run({publicClone:shallow}), /full history/);
  assert.equal(f.git(f.dest, 'for-each-ref'), '');
});
