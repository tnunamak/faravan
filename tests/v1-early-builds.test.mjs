import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {readEarlyBuilds,updateFeedURL,CANDIDATE_FEED_URL} from '../lib/v1/update-feed.mjs';
test('candidate preference defaults off and preserves explicit feed override',()=>{
  assert.equal(updateFeedURL({earlyBuilds:true}),CANDIDATE_FEED_URL);
  assert.equal(updateFeedURL({earlyBuilds:false}),undefined);
  assert.equal(updateFeedURL({earlyBuilds:true,override:'https://example.test/update.json'}),'https://example.test/update.json');
});
test('early builds setting persists in app settings and is available on next start',{timeout:60000},async t=>{
  const f=await appFixture(t);const {app,home}=await f.start('early-builds',{updater:null});
  assert.deepEqual(await api(app,'/api/update-settings'),{earlyBuilds:false,canSelfUpdate:false});
  await api(app,'/api/update-settings',{method:'POST',body:{earlyBuilds:'yes'},status:400});
  assert.deepEqual(await api(app,'/api/update-settings',{method:'POST',body:{earlyBuilds:true}}),{earlyBuilds:true});
  assert.equal(await readEarlyBuilds(home),true);
  const settings=JSON.parse(await readFile(join(home,'v1/app-settings.json'),'utf8'));
  assert.equal(settings.earlyBuilds,true);
  await api(app,'/api/update-settings',{method:'POST',body:{earlyBuilds:false}});
  assert.equal(await readEarlyBuilds(home),false);
});

test('MCP can turn early builds off but only the local session can turn them on', {timeout:60000},async t=>{
  const f=await appFixture(t);const {app}=await f.start('early-mcp',{updater:null});
  const request={method:'POST',headers:{'faravan-surface':'mcp'}};
  for(const path of ['/api/update-settings','/api/ops/update_settings.set']) {
    const denied=await api(app,path,{...request,body:{earlyBuilds:true},status:403});
    assert.equal(denied.code,'human_only');
    await api(app,path,{...request,body:{earlyBuilds:false}});
  }
  assert.equal((await api(app,'/api/update-settings')).earlyBuilds,false);
});

test('self-updating installs report their updater capability', {timeout:60000},async t=>{
  const f=await appFixture(t);
  const updater={startDelayMs:3600000,intervalMs:3600000,check:async()=>({current:'1.0.0'}),tick:async()=>{}};
  const {app}=await f.start('portable-early',{updater});
  assert.equal((await api(app,'/api/update-settings')).canSelfUpdate,true);
});
