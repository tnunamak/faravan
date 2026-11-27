import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import * as p from '../../lib/protocol/index.mjs';

let server,origin,html;
const seed=Buffer.alloc(32,7),code='abcde23456';
function publication(expires=Date.now()+3600000){
 const root=p.generateRootKeyPair().privateKey,key=p.privateKeyFromSeed(seed);
 const envelope=p.createInvite({circle:randomUUID(),coordinator:origin,invite_id:randomUUID(),invite_public_key:p.exportPublicKey(key),
  created_at:new Date(Date.now()-60000).toISOString().replace(/\.\d+Z$/,'Z'),expires_at:new Date(expires).toISOString().replace(/\.\d+Z$/,'Z'),
  display_name:'Weekend projects',owner_name:'A friend'},root);
 return {envelope,invite_binding:p.createInviteBinding(envelope,key)};
}
test.beforeAll(async()=>{
 html=await readFile(new URL('../../public/join/index.html',import.meta.url),'utf8');
 server=createServer((req,res)=>{if(req.url.startsWith('/i/')){res.writeHead(200,{'content-type':'text/html'});res.end(html);}else {res.writeHead(204);res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
const link=()=>origin+'/i/'+code+'#'+seed.toString('base64url');

test('expired invitations stay closed when browser crypto is unavailable',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(globalThis,'crypto',{value:undefined});});
 await page.route('**/v1/invites/*',route=>route.fulfill({json:publication(Date.now()-1000)}));
 await page.goto(link());
 await expect(page.locator('#status')).toContainText('has expired');
 await expect(page.locator('#open')).not.toHaveAttribute('href',/^faravan:/);
 await expect(page.locator('#copy')).toBeDisabled();
});

test('lookup deadline completes without AbortController',async({page})=>{
 await page.addInitScript(()=>{globalThis.AbortController=undefined;});
 await page.clock.install();
 let waiting;
 await page.route('**/v1/invites/*',route=>{waiting=route;});
 await page.goto(link());
 await expect.poll(()=>Boolean(waiting)).toBe(true);
 await page.clock.fastForward(10001);
 await expect(page.locator('#status')).toContainText('Could not reach this server');
 await expect(page.getByRole('button',{name:'Retry check'})).toBeVisible();
 await waiting.fulfill({json:publication()});
 await expect(page.locator('#copy')).toBeDisabled();
});

test('join actions expire in an open tab at desktop and phone sizes',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const evidence=process.env.FARAVAN_JOIN_EVIDENCE;
 if(evidence)await mkdir(evidence,{recursive:true});
 for(const [width,height]of [[1440,900],[390,844]])for(const colorScheme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme});
  const expires=Date.now()+60000;
  await page.route('**/v1/invites/*',route=>route.fulfill({json:publication(expires)}));
  await page.goto('about:blank');
  await page.goto(link());
  await expect(page.locator('#heading')).toHaveText('A friend invited you to Weekend projects.');
  await expect(page.locator('#copy')).toBeEnabled();
  if(evidence)await page.screenshot({path:evidence+`/join-ready-${width}-${colorScheme}.png`});
  await page.evaluate(()=>{const clock=Date.now();Date.now=()=>clock+120000;});
  await page.locator('#open').evaluate(el=>el.click());
  await expect(page.locator('#status')).toContainText('has expired');
  await expect(page.locator('#open')).not.toHaveAttribute('href',/^faravan:/);
  await expect(page.locator('#copy')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(evidence)await page.screenshot({path:evidence+`/join-expired-${width}-${colorScheme}.png`});
  await page.unroute('**/v1/invites/*');
 }
 expect(errors).toEqual([]);
});
