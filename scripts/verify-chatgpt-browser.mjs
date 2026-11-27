// Headless consent journey. No real tunnel, external navigation, or display window.
import {chromium} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startApp} from '../lib/v1/app.mjs';
import assert from 'node:assert/strict';

const home=await mkdtemp(join(tmpdir(),'faravan-browser-'));
let app,browser;
try {
  app=await startApp({home,resumeLending:false,chatgptStartTunnel:async()=>({url:'https://faravan.example',close:async()=>{}})});
  const localHeaders={'x-faravan-session-token':app.token,'content-type':'application/json'};
  await fetch(app.origin+'/api/chatgpt/start',{method:'POST',headers:localHeaders,body:'{}'});
  const config=JSON.parse(await readFile(join(home,'v1/chatgpt-connect.json')));
  const endpoint='http://127.0.0.1:'+config.port;
  const client=await fetch(endpoint+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    client_name:'ChatGPT browser check',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:'none'})}).then(r=>r.json());
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',state:'browser-check',
    resource:'https://faravan.example/mcp',scope:'read act',code_challenge:createHash('sha256').update('v'.repeat(64)).digest('base64url'),code_challenge_method:'S256'});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();let blockedCallback=false;
  page.on('console',message=>{if(message.text().includes('form-action'))blockedCallback=true;});
  await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'ChatGPT callback reached'}));
  await page.goto(app.handoffUrl());
  const authorizePage=await browser.newPage();
  await authorizePage.goto(endpoint.replace('127.0.0.1','localhost')+'/oauth/authorize?'+params);
  assert.ok(!(await authorizePage.content()).includes(app.origin),'public page must not reveal the app port');
  const matching=(await authorizePage.locator('body').innerText()).match(/[0-9A-F]{4}-[0-9A-F]{4}/)?.[0];
  assert.ok(matching,'the owner’s public authorize tab must show the matching code');
  // The person returns to the local tab: no attacker-supplied local approval link is needed.
  await page.goto(app.origin+'/connect/chatgpt');
  await page.getByRole('link',{name:'Review',exact:true}).click();
  await page.getByRole('heading',{name:'Allow ChatGPT to use Faravan on this computer?'}).waitFor();
  assert.ok((await page.locator('main').innerText()).includes(matching),'local consent must match the owner’s public tab');
  assert.ok(await page.locator('main').evaluate(el=>Boolean(getComputedStyle(el).getPropertyValue('--text').trim()&&document.querySelector('link[href="/app.css"]').sheet)), 'app stylesheet and design tokens load');
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
  }
  await page.getByRole('button',{name:'Allow read and request actions',exact:true}).click();
  // Report only the policy failure, never the callback URL/code.
  if(blockedCallback)throw Error('Consent callback blocked by form-action Content Security Policy');
  try {await page.waitForURL('https://chatgpt.com/**',{timeout:5000});}
  catch(error){throw Error('Callback failed: '+new URL(page.url()).pathname+'; CSP blocked='+blockedCallback+'; '+(await page.locator('body').innerText()).slice(0,200));}
  assert.ok(new URL(page.url()).searchParams.has('code'));
  assert.equal((await fetch(app.origin+'/api/chatgpt/status',{headers:localHeaders}).then(r=>r.json())).pairing_until,null,'consent closes pairing');
  const code=new URL(page.url()).searchParams.get('code');
  const tokens=await fetch(endpoint+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
    grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:client.redirect_uris[0],code_verifier:'v'.repeat(64),resource:'https://faravan.example/mcp'})}).then(r=>r.json());
  const tool=async(name,args={})=>{
    const reply=await fetch(endpoint+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tokens.access_token,
      accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json());
    return JSON.parse(reply.result.content[0].text.split('---\n')[1].split('\n---')[0]);
  };
  const requested=await tool('limits_set',{dailyJobs:19,confirm:true});
  assert.equal(requested.status,'needs_your_ok');
  const before=await fetch(app.origin+'/api/lending',{headers:localHeaders}).then(r=>r.json());assert.equal(before.limits.dailyJobs,3);
  await page.goto(requested.approve_at);
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'action page horizontal overflow');
  }
  await page.getByRole('button',{name:'Allow ChatGPT to Change lending limits',exact:true}).click();
  assert.equal((await tool('approvals_wait',{approval_id:requested.approval_id,timeout_seconds:1})).limits.dailyJobs,19);
  const declined=await tool('lending_off');await page.goto(declined.approve_at);
  await page.getByRole('button',{name:'Decline',exact:true}).click();
  assert.equal((await tool('approvals_wait',{approval_id:declined.approval_id,timeout_seconds:0})).status,'declined');

  await page.goto(app.origin+'/connect/chatgpt');
  await page.getByRole('button',{name:'Disconnect ChatGPT',exact:true}).click();
  await page.waitForURL(app.origin+'/connect/chatgpt');
  const status=await fetch(app.origin+'/api/chatgpt/status',{headers:localHeaders}).then(r=>r.json());
  assert.equal(status.connected,false);
  console.log('PASS: headless local sign-in, desktop/mobile consent and action approval, callback, decline, and Disconnect ChatGPT.');
} finally {
  await browser?.close();await app?.close();await rm(home,{recursive:true,force:true});
}
