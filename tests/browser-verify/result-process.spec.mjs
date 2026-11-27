import {freshLink} from '../helpers/fresh-link.mjs';
import {test,expect} from '@playwright/test';
import {confirmFirstSend} from './first-send-test-helper.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {startResultProcesses} from '../helpers/result-process-harness.mjs';
import {api,waitFor} from '../helpers/v1-app-fixture.mjs';
let harness;
test.beforeAll(async()=>{harness=await startResultProcesses();});
test.afterAll(async()=>{await harness?.stop();});
test('plain folder picker, send, lender approval and changed-files download across separate app processes',async({page,browser})=>{
 test.setTimeout(120000);const {owner,lender,circle,folder}=harness;
 expect(owner.app.environmentIsolated).toBe(true);expect(lender.app.environmentIsolated).toBe(true);
 expect(owner.app.pid).not.toBe(lender.app.pid);expect(owner.app.pid).not.toBe(harness.coordinatorPid);
 const ownIdentity=await api(owner.app,'/api/devices'),peerIdentity=await api(lender.app,'/api/devices');
 expect(ownIdentity.name).toBe('sandpiper');expect(ownIdentity.ownerName).toBe('Alex Example');expect(peerIdentity.name).toBe('kestrel');expect(peerIdentity.ownerName).toBe('Maya Okafor');
 console.log('Result process setup',JSON.stringify({owner:{pid:owner.app.pid,device:ownIdentity.name,person:ownIdentity.ownerName},lender:{pid:lender.app.pid,device:peerIdentity.name,person:peerIdentity.ownerName},coordinatorPid:harness.coordinatorPid}));
 await api(lender.app,'/api/lending/limits',{method:'POST',body:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,idleOnly:false}});
 const ownerSettings=await api(lender.app,'/api/lending/owner-settings');
 const engineMinimum=Math.max(ownerSettings.defaultMaxJobUsd,...ownerSettings.minimums.map(row=>row.minimumMaxJobUsd));
 await api(lender.app,'/api/lending/owner-settings',{method:'POST',body:{maxJobUsd:engineMinimum,reason:'Synthetic result journey needs room for one worst-case call.'}});
 await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
 await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
 await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
 await page.goto((await freshLink(owner.app.origin, owner.app.token))+'#/new');
 if(!await page.locator('#cmp-project').evaluate(e=>e.open))await page.locator('#cmp-project > summary').click();
 await page.getByRole('textbox',{name:'What the agent should do',exact:true}).fill('Update notes and add a plan.');
 await page.getByRole('button',{name:'Project settings: Choose project',exact:true}).click();
 const picker=page.getByRole('dialog',{name:'Choose a project'});await expect(picker).toBeVisible();
 await picker.getByRole('button',{name:'Home',exact:true}).click();
 await picker.getByRole('button',{name:'Choose this folder',exact:true}).click();
 await expect(page.locator('#cmp-meta')).toContainText('Folder snapshot');
 const sendButton=page.getByRole('button',{name:'Send',exact:true});
 try{await expect(sendButton).toBeEnabled();}catch(error){
  const why=await page.locator('#cmp-why').count()?await page.locator('#cmp-why').textContent():'no explanation element';
  error.message='Send disabled: '+why+'\n'+error.message;throw error;
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Send',exact:true}).scrollIntoViewIfNeeded();
 const sendBox=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
 expect(sendBox.y).toBeGreaterThanOrEqual(0);
 expect(sendBox.y+sendBox.height).toBeLessThan(780);
 await capture(page,'real-composer');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await confirmFirstSend(page);
 const approval=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'approval',30000);
 const accepted=await api(lender.app,'/api/approvals/'+approval.id+'/accept',{method:'POST',body:{}});
 expect(accepted.accepted).toBe(true);
 try{await expect(page.getByRole('button',{name:'Download changed files',exact:true}).filter({visible:true})).toBeVisible({timeout:60000});}
 catch(error){
  const digest=approval.jobDigest;
  const [job,lending,decisions]=await Promise.all([
   api(owner.app,'/api/jobs/'+encodeURIComponent(digest)).catch(e=>({error:e.message})),
   api(lender.app,'/api/lending').catch(e=>({error:e.message})),
   api(lender.app,'/api/decisions').catch(e=>({error:e.message})),
  ]);
  error.message+='\nAfter accepted approval: '+JSON.stringify({job,lending,decisions});throw error;
 }
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download changed files',exact:true}).filter({visible:true}).click()]);
 expect(download.suggestedFilename()).toMatch(/changed-files.zip$/);expect((await readFile(await download.path())).readUInt32LE(0)).toBe(0x04034b50);
 expect(await readFile(join(folder,'notes.txt'),'utf8')).toBe('old\n');
 await capture(page,'real-owner-result-interim');
 await page.waitForTimeout(10000);await capture(page,'real-owner-result');
 const context=await browser.newContext();const peer=await context.newPage();
 try{await peer.goto(lender.app.url+new URL(page.url()).hash);await expect(peer.getByRole('heading',{name:'Result delivered',exact:true})).toBeVisible({timeout:30000});await expect(peer.locator('.result-properties')).toContainText('Your computer');await capture(peer,'real-lender-result-interim');await peer.waitForTimeout(10000);await capture(peer,'real-lender-result');}finally{await context.close();}
});

async function capture(page,name){
 if(!process.env.RESULTS_SHOTS)return;await mkdir(process.env.RESULTS_SHOTS,{recursive:true});
 for(const [size,width,height] of [['desktop',1440,900],['phone',390,844]])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},theme);
  if(name==='real-composer')await expect(page.locator('#cmp-folder')).toBeVisible();else await expect(page.locator('.result-properties')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await writeFile(join(process.env.RESULTS_SHOTS,name+'.'+size+'.'+theme+'.txt'),await page.locator('main').innerText());
  await page.screenshot({animations:'disabled',style:'*,*::before,*::after{transition:none!important;animation:none!important}',path:join(process.env.RESULTS_SHOTS,name+'.'+size+'.'+theme+'.png'),fullPage:true});
  await page.screenshot({animations:'disabled',style:'*,*::before,*::after{transition:none!important;animation:none!important}',path:join(process.env.RESULTS_SHOTS,name+'-viewport.'+size+'.'+theme+'.png')});
 }
}
