import {test,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {freshLink} from '../helpers/fresh-link.mjs';
let child,harness,harnessClosed,harnessStderr='';
let harnessMessages=[];
const link=actor=>freshLink(harness[actor],harness.tokens[actor]);
const screenshots=process.env.CIRCLES_SCREENSHOTS??'test-artifacts/circles-screenshots';
async function api(actor,path,body){const response=await fetch(new URL(harness[actor]).origin+'/api/'+path,{method:body?'POST':'GET',headers:{'x-faravan-session-token':harness.tokens[actor],...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();expect(response.ok,JSON.stringify(data)).toBe(true);return data;}

test('fixture stops its real coordinator while app startup is held', async () => {
 test.setTimeout(45000);
 const fixture=spawn(process.execPath,[fileURLToPath(new URL('./v1-circles-harness.mjs',import.meta.url)),'--hold-app-start'],{
  stdio:['ignore','ignore','pipe','ipc'],
  env:{...process.env,FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''},
 });
 let stderr='';
 fixture.stderr.setEncoding('utf8');
 fixture.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);});
 const messages=[];
 fixture.on('message',message=>messages.push(message));
 const exited=once(fixture,'close');
 let cleanClose=false;
 try {
  await expect.poll(()=>messages.find(m=>m.event==='app-start-held'),{timeout:20000}).toBeTruthy();
  const held=messages.find(m=>m.event==='app-start-held');
  expect(held.coordinatorPid).toBeGreaterThan(0);
  expect(held.verifiedCoordinatorPid).toBe(held.coordinatorPid);
  expect(held.coordinatorPid).not.toBe(fixture.pid);
  fixture.kill('SIGTERM');
  // This event comes only from the actual spawned coordinator ChildProcess exit.
  // No release-app-start is sent: shutdown must abort its own startup wait.
  await expect.poll(()=>messages.find(m=>m.event==='coordinator-exited'),{timeout:8000}).toEqual({
   event:'coordinator-exited',pid:held.coordinatorPid,
   code:0,signal:null,stderr:expect.not.stringMatching(/ENOENT|Error|owner.marker|close failed/i),
  });
  await expect.poll(()=>fixture.exitCode,{timeout:8000}).toBe(0);
  const [code,signal]=await exited;
  expect({code,signal}).toEqual({code:0,signal:null});
  expect(stderr).not.toMatch(/ENOENT|Error|owner.marker|close failed/i);
  expect(typeof held.root).toBe('string');
  expect(held.root.length).toBeGreaterThan(0);
  await expect(stat(held.root)).rejects.toMatchObject({code:'ENOENT'});
  cleanClose=true;
 } finally {
  // Failure rescue only. A passing regression never releases the startup hold.
  if(!cleanClose && fixture.connected) fixture.send({event:'release-app-start'});
  if(fixture.exitCode===null && fixture.signalCode===null) fixture.kill('SIGTERM');
  let timer;
  try {
   const [code,signal]=await Promise.race([exited,new Promise((_,reject)=>{
    timer=setTimeout(()=>{fixture.kill('SIGKILL');reject(new Error('fixture did not finish cleanup'));},15000);
   })]);
   expect({code,signal}).toEqual({code:0,signal:null});
   expect(stderr).not.toMatch(/ENOENT|Error|owner.marker|close failed/i);
  } finally { clearTimeout(timer); }
 }
});

test.describe('circle browser flows',()=>{

test.beforeAll(async()=>{
 child=spawn(process.execPath,[fileURLToPath(new URL('./v1-circles-harness.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,FARAVAN_NO_BROWSER:'1',DISPLAY:'',WAYLAND_DISPLAY:''}});
 harnessStderr='';
 harnessMessages=[];
 child.on('message',message=>harnessMessages.push(message));
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{harnessStderr=(harnessStderr+chunk).slice(-65536);});
 harnessClosed=once(child,'close');
 harness=JSON.parse(await Promise.race([once(createInterface({input:child.stdout}),'line').then(([line])=>line),once(child,'exit').then(([code])=>{throw new Error('harness exited '+code);})]));
 await mkdir(screenshots,{recursive:true});
});
test.afterAll(async()=>{
 if(!child)return;
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
 const [code,signal]=await harnessClosed;
 expect({code,signal}).toEqual({code:0,signal:null});
 expect(harnessStderr).not.toMatch(/ENOENT|Error|owner.marker|close failed/i);
});

test('start, rename and use two circles on one host in every selector',async({page,browser})=>{
 test.setTimeout(180000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto((await link('owner'))+'#/circles');
 await page.getByRole('link',{name:'Start a circle',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Start another circle'})).toBeVisible();
 const requestedName='Booking site crew';
 await page.getByLabel('Circle name',{exact:true}).fill(requestedName);
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await expect(page.getByRole('button',{name:'Start circle',exact:true})).toHaveClass(/btn-primary/);
  expect(await page.getByLabel('Circle name',{exact:true}).evaluate(element=>getComputedStyle(element).boxShadow)).toBe('none');
  await page.screenshot({path:screenshots+'/create-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 await page.setViewportSize({width:1440,height:900});await page.emulateMedia({colorScheme:'light'});
 // Install the witness before the click; unrelated reads/creates cannot satisfy it.
 const ownerOrigin=new URL(page.url()).origin;
 const [createdResponse]=await Promise.all([
  page.waitForResponse(response=>{
   const request=response.request(),url=new URL(response.url());
   if(request.method()!=='POST'||url.origin!==ownerOrigin||url.pathname!=='/api/circles'||url.search)return false;
   try{return request.postDataJSON()?.name===requestedName;}catch{return false;}
  },{timeout:30000}),
  page.getByRole('button',{name:'Start circle',exact:true}).click(),
 ]);
 const created=await createdResponse.json().catch(()=>null);
 const rawCode=created?.problem?.code??created?.code;
 const code=typeof rawCode==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(rawCode)?rawCode:'unavailable';
 const diagnostic='circle create status='+createdResponse.status()+' code='+code;
 expect(createdResponse.status(),diagnostic).toBe(200);
 expect(Boolean(created&&!created.error&&!created.problem),diagnostic).toBe(true);
 expect(typeof created?.id==='string'&&created.id.trim().length>0,'circle create must return an id').toBe(true);
 const second=created.id;
 // Compare as a boolean so failure output does not dump response data or the URL.
 await expect.poll(()=>new URL(page.url()).hash==='#/circle/'+encodeURIComponent(second),
  {message:'navigation must use the created circle id'}).toBe(true);
 await expect(page.getByRole('heading',{name:requestedName,exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByLabel('Circle name',{exact:true}).fill('Small fixes');
 await page.getByLabel('Purpose',{exact:true}).fill('Help with small projects and reviews');
 await page.getByRole('button',{name:'Save circle',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Small fixes',exact:true})).toBeVisible();
 await expect(page.getByText('Help with small projects and reviews',{exact:true}).first()).toBeVisible();
 const member=await browser.newPage();member.on('pageerror',error=>errors.push(error.message));
 for(const circle of [harness.circle,second]){
  const {invite}=await api('owner','circles/'+circle+'/invite',{});
  await member.goto((await link('member'))+'#/circles');
  await member.getByRole('button',{name:'Join with an invitation',exact:true}).click();
  await member.getByLabel('Invitation',{exact:true}).fill(invite);
  await member.getByRole('button',{name:'Review invitation',exact:true}).click();
  await expect(member.getByRole('region',{name:'Join confirmation'})).toBeVisible();
  // Approval can take more than one normal circles refresh. Observe the browser's own read.
  await Promise.all([
    member.waitForResponse(async response => {
      if (response.request().method() !== 'GET' || !response.ok() ||
          new URL(response.url()).pathname !== '/api/circles') return false;
      const rows = await response.json().catch(() => null);
      return Array.isArray(rows) &&
        rows.some(row => row.id === circle && row.membershipProjection?.phase === 'approved');
    }, {timeout: 30000}),
    member.getByRole('button',{name:'Join circle',exact:true}).click(),
  ]);
  // An ordinary valid invitation must work without an owner /approve call.
  await expect(member.getByRole('link',{name:'Send your first job',exact:true})).toBeVisible();
  await expect.poll(async()=>{
   const rows=await api('member','circles');
   return rows.find(row=>row.id===circle)?.membershipProjection?.phase;
  }).toBe('approved');
  await member.getByRole('link',{name:'Send your first job',exact:true}).click();
  await expect(member).toHaveURL(/#\/new$/);
  await expect(member.getByLabel('Circle',{exact:true})).toHaveValue(circle);
  expect((await api('member','lending')).enabled).toBe(false);
 }
 const memberCircles=await api('member','circles');expect(memberCircles.find(c=>c.id===second).name).toBe('Small fixes');
 await api('member','lending/circle',{circle:second});
 await member.goto((await link('member'))+'#/new');
 await expect(member.getByLabel('Circle',{exact:true})).toHaveValue(second);
 await expect(member.getByLabel('Circle',{exact:true}).locator('option')).toHaveText(['Weekend projects','Small fixes']);
 await member.getByLabel('Circle',{exact:true}).selectOption(harness.circle);
 await expect(member.getByLabel('Circle',{exact:true})).toHaveValue(harness.circle);
 await member.goto((await link('member'))+'#/jobs');await expect(member.getByRole('heading',{name:'Jobs',exact:true})).toBeVisible();
 await member.goto((await link('member'))+'#/');await expect(member.locator('main')).toBeVisible();
 await member.goto((await link('member'))+'#/lend');
 const choices=member.getByRole('radiogroup',{name:'Choose a circle',exact:true});
 await expect(choices.getByRole('radio')).toHaveCount(2);
 const weekend=choices.getByRole('radio',{name:/Weekend projects/}),fixes=choices.getByRole('radio',{name:/Small fixes/});
 await expect(fixes).toBeChecked();
 await fixes.focus();await member.keyboard.press('ArrowUp');
 await expect(weekend).toBeChecked();await expect(weekend).toBeFocused();
 await expect.poll(async()=>(await api('member','lending')).circle).toBe(harness.circle);
 expect((await api('member','lending')).enabled).toBe(false);
 await api('member','agents/codex',{useForLending:true});await api('member','agents/refresh',{agents:['codex']});
 await api('member','lending/on',{circle:harness.circle});
 await expect(weekend).toBeDisabled();await expect(fixes).toBeDisabled();
 await api('member','lending/off',{});
 await expect(weekend).toBeEnabled();await expect(fixes).toBeEnabled();
 await expect(member.locator('.page-sub')).toHaveText(/lending is off/);
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await member.setViewportSize({width,height});
  await page.emulateMedia({colorScheme:theme});await member.emulateMedia({colorScheme:theme});
  await page.goto((await link('owner'))+'#/circles');await expect(page.getByRole('link').filter({hasText:'Small fixes'}).first()).toBeVisible();
  await expect(page.locator('[aria-label="Your circles"] li').filter({hasText:'Hosted on this computer'})).toHaveCount(2);
  await expect(page.locator('[aria-label="Your circles"]')).not.toContainText('unavailable');
  await page.screenshot({path:screenshots+'/circles-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  await page.goto((await link('owner'))+'#/circle/'+second);await page.getByRole('tab',{name:'Settings',exact:true}).click();
  await expect(page.getByLabel('Purpose',{exact:true})).toHaveValue('Help with small projects and reviews');
  await expect(page.getByText('Loading hosting details…',{exact:true})).toHaveCount(0);
  await expect(page.locator('.circle-skeleton')).toHaveCount(0);
  await expect(page.locator('.circle-header')).toContainText('2 computers');
  if(size==='phone'){
   const title=await page.locator('.circle-header>.hstack-3').boundingBox(),invite=await page.getByRole('button',{name:'Invite someone',exact:true}).boundingBox();
   expect(invite.y).toBeGreaterThanOrEqual(title.y+title.height);
   expect(invite.width).toBeGreaterThan(330);
  }
  await page.screenshot({path:screenshots+'/settings-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  await page.goto((await link('owner'))+'#/circles/host');await page.getByRole('button',{name:'Stop hosting',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Stop hosting all 2 circles?',exact:true})).toBeVisible();
  await page.screenshot({path:screenshots+'/host-stop-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  await member.screenshot({path:screenshots+'/lending-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  for(const current of [page,member])expect(await current.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 expect(errors).toEqual([]);await member.close();
});

test('a legacy member blocks rename until its computer updates',async({page})=>{
 test.setTimeout(120000);
 await api('member','devices',{name:"Sam's computer"});
 await api('member','circles/join',{link:harness.invite});
 await api('owner','circles/'+harness.circle+'/approve',{});
 await api('member','circles/'+harness.circle+'/check',{});
 // Close the owned modern app, not its process or the coordinator. Its final
 // heartbeat must settle before the manual legacy observation is installed.
 child.send({event:'stop-member-app'});
 await expect.poll(()=>harnessMessages.find(message=>
  message.event==='member-app-stopped'||message.event==='member-app-stop-failed'),
  {timeout:30000}).toEqual({event:'member-app-stopped'});
 const {openDevice}=await import('../../lib/v1/device.mjs');
 const member=await openDevice({home:harness.root+'/member',ensureDefault:false});
 const client=await member.client(harness.circle);
 await client.heartbeat({boot:'legacy-profile-browser',seq:0,intent:{state:'off'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[]});
 const capability=async()=> {
  const presence=await client.fetchPresence();
  return presence.devices.find(device=>device.device===member.keyId)?.member_capabilities??null;
 };
 await expect.poll(capability).toEqual([]);
 const original=(await api('owner','circles')).find(circle=>circle.id===harness.circle).name;
 await page.goto((await link('owner'))+'#/circle/'+harness.circle);
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByLabel('Circle name',{exact:true}).fill('Friday projects');
 const renamePath='/api/circles/'+encodeURIComponent(harness.circle)+'/profile';
 const origin=new URL(harness.owner).origin;
 const isRename=response=>response.request().method()==='POST'&&
  new URL(response.url()).origin===origin&&new URL(response.url()).pathname===renamePath;
 const renameRequests=[];
 page.on('request',request=>{
  const url=new URL(request.url());
  if(request.method()==='POST'&&url.origin===origin&&url.pathname===renamePath)
   renameRequests.push(true);
 });
 // Recheck immediately before the real click; absence is not evidence of legacy capability.
 expect(await capability()).toEqual([]);
 const [refused]=await Promise.all([
  page.waitForResponse(isRename),
  page.getByRole('button',{name:'Save circle',exact:true}).click(),
 ]);
 expect(refused.status()).toBe(409);
 const refusal=await refused.json();
 expect(refusal.problem?.code??refusal.code??refusal.error).toBe('circle_members_need_update');
 expect(renameRequests).toHaveLength(1);
 expect((await api('owner','circles')).find(circle=>circle.id===harness.circle).name).toBe(original);
 await expect(page.getByRole('heading',{name:original,exact:true})).toBeVisible();
 await expect(page.getByLabel('Circle name',{exact:true})).toHaveValue('Friday projects');
 expect(refusal.members.some(row=>row.keyId===member.keyId), 'the exact legacy member blocked the rename').toBe(true);
 await expect(page.getByText('Update the circle’s computers before changing shared details or access.',{exact:true}).first()).toBeVisible();
 await expect(page.getByText('No computers are waiting for approval.',{exact:true})).toBeVisible();
 for(const [width,height,size] of [[1440,900,'desktop'],[390,844,'phone']])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.screenshot({path:screenshots+'/compatibility-'+size+'-'+theme+'.png',fullPage:true,animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 await client.heartbeat({capabilities:['circle_profile_v1']});
 await expect.poll(capability).toContain('circle_profile_v1');
 const [saved]=await Promise.all([
  page.waitForResponse(isRename),
  page.getByRole('button',{name:'Save circle',exact:true}).click(),
 ]);
 expect(saved.ok()).toBe(true);
 expect(renameRequests).toHaveLength(2);
 expect((await api('owner','circles')).find(circle=>circle.id===harness.circle).name).toBe('Friday projects');
 await expect(page.getByRole('heading',{name:'Friday projects',exact:true})).toBeVisible();
});

});
