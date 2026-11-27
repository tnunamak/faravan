import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isNewerMacUpdate as newer} from '../lib/v1/macos-update-version.mjs';
test('stable numeric updates advance strictly',()=>{
  assert.equal(newer('1.2.4','1.2.3','faravan'),true);
  for(const a of ['1.2.3','1.2.2','1.2.03','1.2.9007199254740992','1.2.4-preview.20261030.1'])assert.equal(newer(a,'1.2.3','faravan'),false);
});
test('preview updates are monotone across build dates within a fixed install label',()=>{
  const current='0.1.0-preview.20261029.20';
  assert.equal(newer('0.1.0-preview.20261029.21',current,'faravan'),true);
  for(const a of [current,'0.1.0-preview.20261029.19','0.1.0-preview.20261028.999','0.1.0-preview.20261029.021','0.1.0-preview.20261029.9007199254740992','0.1.0'])assert.equal(newer(a,current,'faravan'),false);
  assert.equal(newer('0.1.0-preview.20261030.1',current,'faravan'),true);
  assert.equal(newer('0.1.0-preview.20261029.21',current,'faravan'),true);
  assert.equal(newer('0.1.0-preview.20261399.21','0.1.0-preview.20261399.20','faravan'),false);
});
