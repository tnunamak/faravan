import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
function fixture(t, extra = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'public-tree-'));
  t.after(() => rmSync(scratch, {recursive:true, force:true}));
  const root = join(scratch, 'source'); mkdirSync(join(root, 'scripts'), {recursive:true});
  cpSync(new URL('../scripts/public-tree.mjs', import.meta.url), join(root, 'scripts/public-tree.mjs'));
  for (const [name, body] of Object.entries({'README.md':'synthetic product', 'docs/history/private.md':'internal', ...extra})) {
    mkdirSync(join(root, name, '..'), {recursive:true}); writeFileSync(join(root, name), body);
  }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {stdio:'pipe'});
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic source');
  const run = out => spawnSync(process.execPath, [join(root, 'scripts/public-tree.mjs'), join(scratch, out)], {encoding:'utf8'});
  return {root, scratch, run, git};
}
test('public export uses HEAD, excludes working papers, and repeats byte for byte', t => {
  const f=fixture(t); writeFileSync(join(f.root,'README.md'),'uncommitted');
  assert.equal(f.run('one').status,0); assert.equal(f.run('two').status,0);
  assert.equal(readFileSync(join(f.scratch,'one/README.md'),'utf8'),'synthetic product');
  assert.equal(spawnSync('diff',['-r',join(f.scratch,'one'),join(f.scratch,'two')]).status,0);
  assert.throws(()=>readFileSync(join(f.scratch,'one/docs/history/private.md')),{code:'ENOENT'});
  assert.notEqual(f.run('one').status,0);
});
test('a test reading excluded source fails the export', t => {
  const f=fixture(t, {'tests/unsafe.mjs':"readFileSync(new URL('../docs/history/private.md', import.meta.url));"});
  const result=f.run('out'); assert.notEqual(result.status,0); assert.match(result.stderr,/reads excluded docs\/history\/private.md/);
});
test('a build script reading excluded source fails the export', t => {
  const f=fixture(t, {'packaging/unsafe.sh':'cat "$root/docs/history/private.md"'});
  assert.notEqual(f.run('out').status,0);
});
test('a symlink cannot smuggle excluded source into the export', t => {
  const f=fixture(t); mkdirSync(join(f.root,'bin')); symlinkSync('../docs/history/private.md',join(f.root,'bin/leak'));
  f.git('add','bin/leak'); f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic link');
  const result=f.run('out'); assert.notEqual(result.status,0); assert.match(result.stderr,/symlink leaves public tree/);
});
