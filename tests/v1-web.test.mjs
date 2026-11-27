import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {appIconState} from '../lib/v1/app.mjs';
import {appFixture,boundedFetch} from './helpers/v1-app-fixture.mjs';
const build=new URL('../public/v1/',import.meta.url);
function rawRequest(app,path,headers={},method='GET') {
  return new Promise((resolve,reject)=>{
    const request=httpRequest(app.origin+path,{method,headers},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString()}));});
    request.setTimeout(4000,()=>request.destroy(new Error('test deadline')));request.on('error',reject);request.end();
  });
}
test('v1 page and every authenticated asset use the unchanged loopback boundary',async t=>{
  const f=await appFixture(t),{app}=await f.start('web');
  const page=await boundedFetch(app.url),html=await page.text();
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/^text\/html/);
  assert.equal(html,await readFile(new URL('index.html',build),'utf8'));
  assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await rawRequest(app,'/',{'host':'attacker.test','x-faravan-session-token':app.token})).status,403);
  // The shell holds no data or secret, so a reload (no token in its URL) can load it; its Host check still applies.
  const bare=await rawRequest(app,'/');
  assert.equal(bare.status,200);assert.equal(bare.text,html);assert.equal(bare.headers['cache-control'],'no-store');
  assert.equal((await rawRequest(app,'/index.html')).text,html);
  assert.equal((await rawRequest(app,'/',{'host':'attacker.test'})).status,403);
  assert.equal((await rawRequest(app,'/?x=1',{},'POST')).status,401);
  assert.equal((await rawRequest(app,'/',{'x-faravan-session-token':app.token,origin:'https://attacker.test'})).status,403);
  assert.equal((await rawRequest(app,'/',{'x-faravan-session-token':app.token},'POST')).status,404);
  const assets=[...html.matchAll(/name="app-(?:module|style)" content="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(assets.sort(),['/app.css','/app.mjs']);
  for(const path of assets) {
    assert.doesNotMatch(path,/token|\?/);
    assert.equal((await rawRequest(app,path)).status,401);
    const response=await boundedFetch(app.origin+path,{headers:{'x-faravan-session-token':app.token}});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),path.endsWith('.css')?/^text\/css/:/^text\/javascript/);
    assert.equal(await response.text(),await readFile(new URL(path.slice(1),build),'utf8'));
  }
  for(const path of ['/missing.js','/%2e%2e%2fsecret.js','/api-nope','/package.json'])assert.equal((await rawRequest(app,path,{'x-faravan-session-token':app.token})).status,404);
  const status=await boundedFetch(app.origin+'/api/status',{headers:{'x-faravan-session-token':app.token}});
  assert.equal(status.status,200);assert.match(status.headers.get('content-type'),/application\/json/);
  const view=await status.json();assert.ok(['Lending on','Paused','Needs attention'].includes(view.iconState));
});
test('built bootstrap strips session before authenticated fetch, CSP hashes it, bundle is self contained',async()=>{
  const html=await readFile(new URL('index.html',build),'utf8'),js=await readFile(new URL('app.mjs',build),'utf8');
  const script=html.match(/<script>([\s\S]+)<\/script>/)[1];
  const hash=createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes("'sha256-"+hash+"'"));assert.ok(html.includes("base-uri 'none'"));
  assert.doesNotMatch(html,/<script[^>]+src=|unsafe-inline|unsafe-eval/);
  assert.deepEqual([...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map(([,href])=>href),
    ['/favicon.svg','/favicon.ico','/apple-touch-icon.png','/manifest.webmanifest']);
  const take=script.search(/takeSession\w*\(location,\s*history\)/),fetchAt=script.indexOf('await fetch(');
  assert.ok(take>=0&&fetchAt>take,'session is stripped before any fetch');
  assert.doesNotMatch(script,/x-faravan-session-token|x-faravan-session-token|getItem\("faravan-session"\)|setItem\("faravan-session"/);
  assert.match(script,/removeItem\("faravan-session"\)/);assert.match(script,/revokeObjectURL/);
  assert.match(script,/data:font\/woff2;base64,/);
  assert.match(script,/var\(--text-title1\)/);
  assert.match(script,/Reconnect to Faravan/);
  assert.doesNotMatch(script,/Faravan restarted|SESSION ENDED/);
  assert.match(script,/localStorage\.getItem\("faravan-theme"\)/);
  assert.doesNotMatch(script,/document\.cookie|localStorage\.setItem\("faravan-session"/);
  assert.equal([...script.matchAll(/localStorage\b/g)].length,1,'bootstrap uses local storage only for the theme');
  assert.deepEqual([...script.matchAll(/localStorage\.getItem\(["']([^"']+)["']\)/g)].map(([,key])=>key),['faravan-theme']);
  assert.doesNotMatch(script,/document\.cookie|localStorage\.(?:setItem|removeItem)\(/);
  assert.doesNotMatch(js,/(?:from\s*|import\s*)["']\.{1,2}\//);
});

test('API icon projection has exactly three states with blocker precedence',()=>{
  assert.equal(appIconState({enabled:false}),'Paused');
  assert.equal(appIconState({enabled:true}),'Lending on');
  for(const reason of ['policy_unenforceable','readiness_changed','lease_expired','quota_unknown','new_unknown_reason'])assert.equal(appIconState({enabled:true,reason}),'Needs attention');
  assert.equal(appIconState({enabled:true,reason:'user_active'}),'Lending on');
  assert.equal(appIconState({enabled:true,reason:'daily_limit',label:'Daily cap'},[{label:'Daily cap'}]),'Paused');
  assert.equal(appIconState({enabled:true,reason:'quota_reserve',label:'Reserve'},[{label:'Reserve'},{label:'Sign-in needed'}]),'Needs attention');
});


test('self-clearing probe holds do not ask for attention, but unrelated attention still wins',()=>{
  for(const reason of ['account_busy','probe_deferred']) {
    const state={enabled:true,reason,label:'Allowance check is waiting'};
    assert.equal(appIconState(state),'Lending on');
    assert.equal(appIconState({...state,enabled:false}),'Paused');
    assert.equal(appIconState(state,[{label:'Sign-in needed'}]),'Needs attention');
  }
});
