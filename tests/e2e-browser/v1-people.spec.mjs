import {test,expect as baseExpect} from '@playwright/test';
// Real fsynced authority changes took 15 s under shared-host load; this is a hang bound, not a latency budget.
const expect=baseExpect.configure({timeout:30000});
test.use({actionTimeout:30000});
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {freshLink} from '../helpers/fresh-link.mjs';
let child,harness;
const link=actor=>freshLink(harness[actor],harness.tokens[actor]);
const screenshots=process.env.CIRCLES_PEOPLE_SCREENSHOTS??'test-artifacts/people-screenshots';
async function api(actor,path,body){const response=await fetch(new URL(harness[actor]).origin+'/api/'+path,{method:body?'POST':'GET',headers:{'x-faravan-session-token':harness.tokens[actor],...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();expect(response.ok,JSON.stringify(data)).toBe(true);return data;}
test.beforeAll(async()=>{
 child=spawn(process.execPath,[fileURLToPath(new URL('./v1-circles-harness.mjs',import.meta.url))],{stdio:['ignore','pipe','inherit'],env:{...process.env,FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''}});
 harness=JSON.parse(await Promise.race([once(createInterface({input:child.stdout}),'line').then(([line])=>line),once(child,'exit').then(([code])=>{throw new Error('harness exited '+code);})]));
 await mkdir(screenshots,{recursive:true});
});
test.afterAll(async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});

test('link computers, govern a person, transfer ownership and use separate exits',async({page,browser})=>{
 test.setTimeout(240000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const id=harness.circle,base='circles/'+id+'/';
 await api('member','devices',{name:'Travel laptop',ownerName:'Morgan'});await api('other','devices',{name:'Office desktop',ownerName:'Morgan'});
 for(const actor of ['member','other']){
  const {invite}=await api('owner',base+'invite',{});await api(actor,'circles/join',{link:invite});await api('owner',base+'approve',{});await api(actor,base+'check',{});
 }
 const a=(await api('member','devices')).fingerprint,b=(await api('other','devices')).fingerprint;
 await api('owner',base+'petnames',{keyId:a,label:'Morgan'});
 const personProof=await api('member',base+'people/link-proof',{otherKeyId:b});
 const deviceProof=await api('other',base+'people/link-proof',{otherKeyId:b,personId:a});
 await page.goto((await link('owner'))+'#/circle/'+id);await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByText('Link computers to one person',{exact:true}).click();
 await page.getByRole('combobox',{name:"Person's original computer",exact:true}).selectOption(a);await page.getByRole('combobox',{name:'Computer to link',exact:true}).selectOption(b);
 await page.getByLabel("Original computer's proof",{exact:true}).fill(JSON.stringify(personProof));await page.getByLabel("New computer's proof",{exact:true}).fill(JSON.stringify(deviceProof));
 await page.getByRole('button',{name:'Verify and link computers',exact:true}).click();
 await expect(page.getByText('Computers linked.',{exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Members',exact:true}).click();
 const list=page.getByRole('list',{name:'People in this circle',exact:true});await expect(list.locator(':scope>li')).toHaveCount(2);
 await expect(page.getByRole('list',{name:'Computers for Morgan',exact:true}).locator('li')).toHaveCount(2);
 await page.getByRole('link',{name:'Morgan',exact:true}).click();await expect(page.getByRole('heading',{name:'Morgan',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Asked for',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Ran',exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'Role',exact:true}).selectOption('borrow-only');await page.getByRole('button',{name:'Save role',exact:true}).click();await expect(page.getByText('Role saved.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Block person',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('They stay in the circle');await page.getByRole('dialog').getByRole('button',{name:'Block person',exact:true}).click();
 await expect(page.getByText('Blocked',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Unblock person',exact:true})).toBeVisible();
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.screenshot({path:screenshots+'/person-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 await page.getByRole('button',{name:'Unblock person',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Unblock person',exact:true}).click();
 await expect(page.getByText('Blocked',{exact:true})).toHaveCount(0);
 await page.getByRole('combobox',{name:'Role',exact:true}).selectOption('co-admin');await page.getByRole('button',{name:'Save role',exact:true}).click();
 await expect.poll(async()=>(await api('owner',base+'people')).find(p=>p.personId===a)?.role).toBe('co-admin');
 await page.goto((await link('owner'))+'#/circle/'+id);await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByRole('combobox',{name:"Steward's computer",exact:true}).selectOption(a);await page.getByRole('button',{name:'Save backup steward',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Save backup steward',exact:true}).click();
 await expect.poll(async()=>(await api('owner','circles')).find(c=>c.id===id)?.authorityStewardKeyId).toBe(a);
 await page.getByRole('combobox',{name:"New owner's computer",exact:true}).selectOption(b);await page.getByRole('button',{name:'Create transfer code',exact:true}).click();
 const code=await page.getByLabel('Transfer code to share privately',{exact:true}).inputValue();expect(JSON.parse(code).payload.owner.key_id).toBe(b);
 const recipient=await browser.newPage();recipient.on('pageerror',error=>errors.push(error.message));await recipient.goto((await link('other'))+'#/circle/'+id);await recipient.getByRole('tab',{name:'Settings',exact:true}).click();
 await recipient.getByLabel('Ownership transfer code',{exact:true}).fill(code);await recipient.getByRole('button',{name:'Accept ownership',exact:true}).click();
 await recipient.getByRole('dialog').getByRole('button',{name:'Accept ownership',exact:true}).click();
 await expect.poll(async()=>(await api('other','circles')).find(c=>c.id===id)?.owned).toBe(true);
 await api('owner',base+'check',{});expect((await api('owner','circles')).find(c=>c.id===id).owned).toBe(false);
 await page.reload();await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByRole('button',{name:'Leave circle',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Leave circle',exact:true}).click();
 await expect(page).toHaveURL(/#\/circles$/);
 await recipient.reload();await recipient.getByRole('tab',{name:'Settings',exact:true}).click();
 await recipient.getByRole('button',{name:'Archive circle',exact:true}).click();await recipient.getByRole('dialog').getByRole('button',{name:'Archive circle',exact:true}).click();await expect(recipient.getByRole('button',{name:'Reopen circle',exact:true})).toBeVisible();
 await recipient.getByRole('button',{name:'Reopen circle',exact:true}).click();await recipient.getByRole('dialog').getByRole('button',{name:'Reopen circle',exact:true}).click();await expect(recipient.getByRole('button',{name:'Archive circle',exact:true})).toBeVisible();
 await expect(recipient.getByRole('dialog')).toHaveCount(0);
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await recipient.setViewportSize({width,height});await recipient.emulateMedia({colorScheme:theme});
  await recipient.screenshot({path:screenshots+'/authority-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await recipient.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 await recipient.getByRole('button',{name:'Close circle',exact:true}).click();await recipient.getByRole('dialog').getByRole('button',{name:'Close circle',exact:true}).click();
 await expect(recipient.getByRole('button',{name:'Delete local data',exact:true})).toBeVisible();await expect(recipient.getByRole('button',{name:'Reopen circle',exact:true})).toHaveCount(0);
 await recipient.getByRole('button',{name:'Delete local data',exact:true}).click();await expect(recipient.getByRole('dialog')).toContainText('downloaded results stay');await recipient.getByRole('dialog').getByRole('button',{name:'Delete local data',exact:true}).click();
 await expect(recipient).toHaveURL(/#\/circles$/);await expect.poll(async()=>(await api('other','circles')).some(c=>c.id===id)).toBe(false);
 await recipient.close();expect(errors).toEqual([]);
});
