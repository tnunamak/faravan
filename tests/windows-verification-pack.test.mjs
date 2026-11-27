import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const pack = fileURLToPath(new URL('../packaging/windows/', import.meta.url));
const acceptance = readFileSync(join(pack, 'acceptance.md'), 'utf8');
const runner = readFileSync(join(pack, 'verify.ps1'), 'utf8');

// Parse the actual plan entries, not arbitrary ID mentions in comments or log messages.
function contractProblems(markdown, powershell) {
  const plan = [...powershell.matchAll(/@\{ Id = '(WIN-\d{2})'; Phase = '(\w+)' \}/g)];
  const known = new Set(plan.map(match => match[1]));
  const problems = [];
  const section = markdown.split('## Acceptance steps\n')[1]?.split('\n## ')[0];
  if (!section) return ['missing numbered acceptance section'];
  const steps = [...section.matchAll(/^(\d+)\. \*\*\[([^\]]+)\]/gm)];
  const numbered = [...section.matchAll(/^\d+\./gm)];
  if (!steps.length || numbered.length !== steps.length) problems.push('numbered step without check ID or explicit manual marker');
  steps.forEach((match, index) => {
    if (Number(match[1]) !== index + 1) problems.push('non-sequential acceptance numbering');
    const ids = match[2].match(/WIN-\d{2}/g) ?? [];
    if (!ids.length && !/\bmanual\b/.test(match[2])) problems.push(`step ${match[1]} has no ID/manual marker`);
    for (const id of ids) if (!known.has(id)) problems.push(`step ${match[1]} has no matching check: ${id}`);
    if (/\bmanual\b/.test(match[2])) {
      for (const id of ids) if (!plan.some(entry => entry[1] === id && entry[2] === 'Review')) problems.push(`${id} lacks a Review entry`);
    }
  });
  for (const id of known) if (!steps.some(step => step[2].includes(id))) problems.push(`undocumented script check: ${id}`);
  const keys = plan.map(match => match[1] + ':' + match[2]);
  if (new Set(keys).size !== keys.length) problems.push('duplicate check/phase');
  return problems;
}

test('every numbered acceptance step has an executable check ID or explicit manual marker', () => {
  assert.deepEqual(contractProblems(acceptance, runner), []);
});

test('coverage gate rejects orphan IDs, silent manual gaps, and missing numbered steps', () => {
  assert.match(contractProblems(acceptance.replace('[WIN-07]', '[WIN-99]'), runner).join('\n'), /no matching check/);
  assert.match(contractProblems(acceptance.replace('[manual] Review and sign off', 'Review and sign off'), runner).join('\n'), /without check ID/);
  assert.match(contractProblems(acceptance, runner.replace("@{ Id = 'WIN-05'; Phase = 'Review' }", '')).join('\n'), /WIN-05/);
  assert.match(contractProblems(acceptance.replace('21. **[manual]', '22. **[manual]'), runner).join('\n'), /non-sequential/);
});

test('human scenarios cannot be satisfied by automatic check results alone', () => {
  for (const id of ['WIN-04','WIN-05','WIN-09','WIN-10','WIN-11','WIN-12','WIN-14','WIN-15','WIN-16','WIN-17','WIN-18','WIN-19','WIN-20']) {
    assert.ok(runner.includes(`@{ Id = '${id}'; Phase = 'Review' }`), id);
  }
  assert.match(runner, /result = 'not yet run'/);
  assert.match(runner, /candidateSha256 -ne \$candidateHash/);
  assert.match(runner, /\$results -contains 'not yet run'/);
});

test('native probes refuse to manufacture Windows results on another host', {skip:process.platform === 'win32'}, () => {
  const result = spawnSync(process.execPath, [join(pack, 'native-probes.mjs'), 'lock', pack, pack], {encoding:'utf8', timeout:5000});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Native Windows evidence is not yet run/);
});

// Exercise stock Windows PowerShell 5.1 when these pack tests eventually run on Windows.
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const powershell = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-Command', '$PSVersionTable.PSVersion.ToString()'], {encoding:'utf8', timeout:10000});
test('receipt lock covers the initial load through all final receipt and digest writes', () => {
  const locked = runner.indexOf('$receiptLock = Enter-ReceiptLock $OutputDirectory');
  const protectedBody = runner.indexOf('\ntry {', locked);
  const loaded = runner.indexOf('$state = Read-JsonFile $receiptPath');
  const released = runner.lastIndexOf('} finally {\n    $receiptLock.Dispose()\n}');
  assert.ok(locked >= 0 && locked < protectedBody && protectedBody < loaded);
  assert.ok(released > runner.lastIndexOf("'receipt.sha256'"));
  assert.match(runner, /\[IO.FileShare\]::None/);
  assert.match(runner, /\[IO.FileMode\]::OpenOrCreate/);
});

test('barriers reproduce the stale signer overwrite and exclusive locking preserves the failure', {skip:powershell.error?.code === 'ENOENT', timeout:30000}, async t => {
  const fixture = fileURLToPath(new URL('./fixtures/windows-verification-concurrency.ps1', import.meta.url));
  async function scenario(withoutLock) {
    const directory = mkdtempSync(join(tmpdir(), 'faravan-windows-concurrency-'));
    const candidateSha256 = 'b'.repeat(64);
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify({runId:'concurrency-fixture', candidateSha256,
      checks:[{id:'WIN-04', phase:'Inspect', result:'pass', logPaths:[], evidence:[]}], history:[], runtimeError:null,
      verdict:'awaiting sign-off', signOff:null}), 'utf8');
    writeFileSync(join(directory, 'manual.json'), JSON.stringify({runId:'concurrency-fixture', candidateSha256, observations:[]}), 'utf8');
    function peer(role) {
      const child = spawn(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
        '-Runner',join(pack, 'verify.ps1'),'-Work',directory,'-Role',role,...(withoutLock ? ['-WithoutLock'] : [])], {stdio:['pipe','pipe','pipe']});
      const lines = [], waiters = [];
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      createInterface({input:child.stdout}).on('line', line => {
        if (waiters.length) waiters.shift().resolve(line); else lines.push(line);
      });
      const ended = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => {
          for (const waiter of waiters.splice(0)) waiter.reject(Error(`peer ${role} exited ${code}: ${stderr}`));
          resolve(code);
        });
      });
      ended.catch(() => {});
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; });
      return {ended, send:message => child.stdin.write(message + '\n'),
        line:async expected => assert.equal(lines.length ? lines.shift() : await new Promise((resolve,reject) => waiters.push({resolve,reject})), expected, stderr)};
    }
    const writer = peer('Writer');
    await writer.line('WRITER_LOADED');
    const signer = peer('Signer');
    await signer.line(withoutLock ? 'SIGNER_LOADED_pass' : 'SIGNER_BUSY');
    writer.send('FAIL');
    await writer.line('FAILURE_WRITTEN');
    assert.equal(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')).verdict, 'fail');
    writer.send('RELEASE');
    assert.equal(await writer.ended, 0);
    if (!withoutLock) { signer.send('RETRY'); await signer.line('SIGNER_LOADED_fail'); }
    signer.send('COMMIT');
    await signer.line(withoutLock ? 'SIGNER_SAVED_pass' : 'SIGNER_SAVED_fail');
    assert.equal(await signer.ended, 0);
    const final = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    assert.equal(final.verdict, withoutLock ? 'pass' : 'fail');
    console.log(`Retained ${withoutLock ? 'unlocked counterexample' : 'locked regression'} fixture: ${directory}`);
  }
  await scenario(true);
  await scenario(false);
});

test('receipt logic rejects unsupported sign-offs and keeps incomplete/failing results visible', {skip:powershell.error?.code === 'ENOENT'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'faravan-windows-receipt-unit-Faraván测试-'));
  const fixture = fileURLToPath(new URL('./fixtures/windows-verification-receipt.ps1', import.meta.url));
  const result = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
    '-Runner',join(pack, 'verify.ps1'),'-Work',directory], {encoding:'utf8', timeout:20000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PASS receipt aggregation/);
  console.log('Retained receipt unit fixture: ' + directory);
});

test('all JSON file reads/writes and native stream decoding specify UTF-8', () => {
  for (const read of runner.matchAll(/Get-Content[^\n]+/g)) assert.match(read[0], /-Encoding UTF8/);
  assert.match(runner, /function Write-JsonFile[\s\S]*?\[Text.UTF8Encoding\]::new\(\$false\)/);
  assert.match(runner, /StandardOutputEncoding = \$utf8/);
  assert.match(runner, /StandardErrorEncoding = \$utf8/);
  assert.doesNotMatch(runner, /Start-Process/);
  assert.doesNotMatch(runner, /Set-Content[^\n]*\.json/);
});

test('non-ASCII artifact, output, native stream and evidence paths survive separate PowerShell invocations', {skip:powershell.error?.code === 'ENOENT'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'faravan-windows-utf8-Faraván测试-'));
  const candidate = {artifact:join(directory, '构建-café.msix'), output:directory, evidence:join(directory, '签收-café.txt')};
  writeFileSync(candidate.artifact, 'fixture, not an MSIX', 'utf8');
  writeFileSync(candidate.evidence, 'UTF-8 evidence fixture', 'utf8');
  writeFileSync(join(directory, 'candidate.json'), JSON.stringify(candidate), 'utf8');
  writeFileSync(join(directory, 'unicode-output.mjs'), "process.stdout.write(JSON.stringify({path:process.argv[2]})+'\\n');process.stderr.write(process.argv[2]+'\\n');", 'utf8');
  const fixture = fileURLToPath(new URL('./fixtures/windows-verification-round2.ps1', import.meta.url));
  for (const mode of ['EncodingWrite','EncodingRead']) {
    const result = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
      '-Runner',join(pack, 'verify.ps1'),'-Work',directory,'-Node',process.execPath,'-Mode',mode], {encoding:'utf8', timeout:20000});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /PASS UTF-8/);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'unicode-receipt.json'), 'utf8')), candidate);
  console.log('Retained UTF-8 fixture: ' + directory);
});

test('post-uninstall checks reject key-only survivors and altered state, settings, history or results', {skip:powershell.error?.code === 'ENOENT'}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'faravan-windows-retention-'));
  const fixture = fileURLToPath(new URL('./fixtures/windows-verification-round2.ps1', import.meta.url));
  const result = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
    '-Runner',join(pack, 'verify.ps1'),'-Work',directory,'-Mode','RetainedData'], {encoding:'utf8', timeout:20000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /key-only survivors and altered files rejected/);
  assert.ok(runner.indexOf('Assert-RetainedInventory -Inventory $state.uninstallRetainedInventory') > runner.indexOf('Remove-AppxPackage -Package'));
  console.log('Retained uninstall fixture: ' + directory);
});

test('Windows README distinguishes lending prerequisites from borrowing', () => {
  const readme = readFileSync(join(pack, 'README.md'), 'utf8');
  assert.match(readme, /borrowing does not require that feature or Docker Sandboxes/);
  assert.doesNotMatch(readme, /Install Docker Sandboxes before Faravan:/);
});

test('runner emits a failed receipt with no native passes when invoked on Linux', {skip:process.platform !== 'linux' || powershell.error?.code === 'ENOENT'}, () => {
  // Intentionally retain this tiny receipt fixture, matching the pack's evidence policy.
  const directory = mkdtempSync(join(tmpdir(), 'faravan-windows-pack-contract-'));
  const build = {commit:'a'.repeat(40), sha256:'b'.repeat(64), artifact:join(directory, 'not-built.msix'), version:'0.1.0.0'};
  const candidate = join(directory, 'candidate.json');
  const args = ['-NoLogo','-NoProfile','-NonInteractive','-File', join(pack, 'verify.ps1'),
    '-Phase','Baseline','-Candidate',candidate,'-OutputDirectory',directory];
  writeFileSync(candidate, '{invalid-json', 'utf8');
  const broken = spawnSync(shell, args, {encoding:'utf8', timeout:20000});
  assert.equal(broken.status, 1, broken.stderr + broken.stdout);
  assert.match(broken.stderr, /JSON|ConvertFrom-Json/);
  writeFileSync(candidate, JSON.stringify({packageName:'Faravan.Faravan', build, upgrade:{...build, version:'0.1.1.0'}}));
  const result = spawnSync(shell, args, {encoding:'utf8', timeout:20000});
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.doesNotMatch(result.stderr, /Cannot open exclusive receipt lock/);
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
  assert.equal(receipt.verdict, 'fail');
  assert.equal(receipt.signOff, null);
  assert.equal(receipt.windows, null);
  assert.match(receipt.runtimeError, /not yet run/);
  assert.ok(receipt.checks.length > 20);
  assert.ok(receipt.checks.every(check => check.result === 'not yet run'));
  // The same directory remains usable after both initialization failure and final writes.
  const repeated = spawnSync(shell, args, {encoding:'utf8', timeout:20000});
  assert.equal(repeated.status, 1, repeated.stderr + repeated.stdout);
  assert.doesNotMatch(repeated.stderr, /Cannot open exclusive receipt lock/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')).verdict, 'fail');
  console.log('Retained contract fixture: ' + directory);
});
