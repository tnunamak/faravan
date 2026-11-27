import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ensureSbxOwner, readSbxOwner, sbxOwnerFile} from '../lib/sbx-daemon-owner.mjs';

test('service ownership survives restart and stays separate across data profiles', t => {
  const root = mkdtempSync(join(tmpdir(),'sbx-owner-'));
  const previous = process.env.FARAVAN_HOME;
  t.after(() => {
    if(previous===undefined) delete process.env.FARAVAN_HOME; else process.env.FARAVAN_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  });
  const binary=join(root,'sbx');
  writeFileSync(binary,'#!/bin/sh\nexit 99\n',{mode:0o755});
  process.env.FARAVAN_HOME=join(root,'one');
  const first=ensureSbxOwner('sbx',{PATH:root});
  assert.match(first.id,/^[0-9a-f]{64}$/);
  assert.equal(first.executable,binary);
  assert.deepEqual(readSbxOwner(),first);
  assert.deepEqual(ensureSbxOwner(binary,{}),first);
  assert.equal(readSbxOwner(process.env.FARAVAN_HOME,'/another-install'),null);
  process.env.FARAVAN_HOME=join(root,'two');
  assert.notEqual(ensureSbxOwner(binary,{}).id,first.id);
  writeFileSync(sbxOwnerFile(),'{broken');
  assert.equal(readSbxOwner(),null);
  assert.throws(()=>ensureSbxOwner(binary,{}),/ownership record is unreadable/);
});


test('ownership is published only after a complete private file is synced', t => {
  const root=mkdtempSync(join(tmpdir(),'sbx-owner-atomic-'));
  const previous=process.env.FARAVAN_HOME;
  process.env.FARAVAN_HOME=join(root,'profile');
  t.after(()=>{if(previous===undefined)delete process.env.FARAVAN_HOME;else process.env.FARAVAN_HOME=previous;rmSync(root,{recursive:true,force:true});});
  const binary=join(root,'sbx');writeFileSync(binary,'#!/bin/sh\nexit 99\n',{mode:0o755});
  const original=fs.openSync;
  fs.openSync=function(file,flags,...rest){
    assert.notEqual(file,sbxOwnerFile(),'the final record must not be opened before it is complete');
    return original.call(this,file,flags,...rest);
  };
  try {ensureSbxOwner(binary,{});} finally {fs.openSync=original;}
  const record=readSbxOwner();
  assert.equal(readFileSync(sbxOwnerFile(),'utf8'),JSON.stringify(record)+'\n');
  const helper=fileURLToPath(new URL('../lib/sbx-daemon-owner.mjs',import.meta.url));
  assert.equal(execFileSync(process.execPath,[helper,'--id'],{encoding:'utf8'}).trim(),record.id);
});
