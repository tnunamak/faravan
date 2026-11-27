import mandelbrot from '../../ui/v1/src/fixtures/mandelbrot-final-message.json' with {type:'json'};
import {test,expect} from '@playwright/test';
import {startHarness} from './lib.mjs';
import {changesView} from '../../lib/v1/apply.mjs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});
const png=(await readFile(new URL('../../ui/v1/src/fixtures/mandelbrot.png',import.meta.url))).toString('base64');
async function fixture(page,changes,summary='Created the image in faravan-output/circle.png.'){
 const circle={id:'outputs-circle',name:'Outputs',origin:'http://fixture'},digest='sha256:'+'c'.repeat(64);
 const job={job_digest:digest,circle,state:'result-accepted',result_digest:'sha256:'+'d'.repeat(64),local:{title:'Create a red circle',prompt:'create a 64x64 PNG of a red circle'}};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[job]}));
 await page.route('**/api/jobs/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/image'))return route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')});
  if(path.endsWith('/changes'))return route.fulfill({json:changes});
  if(path.endsWith('/receipt'))return route.fulfill({json:{receipt:changes.receipt,checks:[]}});
  if(path.endsWith('/transcript'))return route.fulfill({json:{text:JSON.stringify({type:'result',result:summary})+'\n'+JSON.stringify({type:'faravan.job_context',job_framing_version:1,workspace_path:'/work/project'})}});
  if(path.endsWith('/retention'))return route.fulfill({json:{}});
  return route.fulfill({json:job});
 });
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
}
test('an added PNG in the returned patch loads as a preview on desktop and phone',async({page})=>{
 const dir=await mkdtemp(join(tmpdir(),'faravan-image-preview-'));
 let changes;
 try {
  execFileSync('git',['init','-q',dir]);
  await writeFile(join(dir,'circle.png'),Buffer.from(png,'base64'));
  execFileSync('git',['add','circle.png'],{cwd:dir});
  const patch=execFileSync('git',['diff','--binary','--cached'],{cwd:dir});
  changes=changesView({bytes:patch,mediaType:'text/x-diff',digest:'sha256:'+'c'.repeat(64)});
 }finally{await rm(dir,{recursive:true,force:true});}
 await fixture(page,{...changes,receipt:{harness:'claude-code-subscription'}});
 await page.getByRole('button',{name:'Show image preview'}).click();
 const img=page.getByRole('img',{name:'Preview of circle.png'});
 await expect(img).toBeVisible();
 await expect.poll(()=>img.evaluate(el=>el.complete&&el.naturalWidth>0)).toBe(true);
 await expect(page.getByText('New file',{exact:true})).toBeVisible();
 await expect(page.getByText('GIT binary patch',{exact:true})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 await expect(img).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('output previews share bounded work and release blob URLs when scrolled away',async({page})=>{
 const dir=await mkdtemp(join(tmpdir(),'faravan-image-budget-'));
 let changes;
 try {
  execFileSync('git',['init','-q',dir]);
  await writeFile(join(dir,'circle.png'),Buffer.from(png,'base64'));
  execFileSync('git',['add','circle.png'],{cwd:dir});
  const patch=execFileSync('git',['diff','--binary','--cached'],{cwd:dir});
  const one=changesView({bytes:patch,mediaType:'text/x-diff',digest:'sha256:'+'c'.repeat(64)});
  changes={...one,files:Array.from({length:14},(_,index)=>({...one.files[0],path:`circle-${index}.png`,preview:{media_type:'image/png',url:`/api/jobs/test/image?path=circle-${index}.png`}}))};
 }finally{await rm(dir,{recursive:true,force:true});}
 let requests=0;
 await page.addInitScript(()=>{
  const revoke=URL.revokeObjectURL.bind(URL);
  const fetch=window.fetch.bind(window);
  window.previewRevocations=0;
  window.previewFetchActive=0;window.previewFetchPeak=0;
  URL.revokeObjectURL=url=>{window.previewRevocations++;revoke(url);};
  window.fetch=(input,init)=>{
   if(!String(input).includes('/image?'))return fetch(input,init);
   window.previewFetchActive++;
   window.previewFetchPeak=Math.max(window.previewFetchPeak,window.previewFetchActive);
   let done=false;const finish=()=>{if(!done){done=true;window.previewFetchActive--;}};
   init?.signal?.addEventListener('abort',finish,{once:true});
   return fetch(input,init).finally(finish);
  };
 });
 const circle={id:'outputs-circle',name:'Outputs',origin:'http://fixture'},digest='sha256:'+'c'.repeat(64);
 const job={job_digest:digest,circle,state:'result-accepted',result_digest:'sha256:'+'d'.repeat(64),local:{title:'Create images',prompt:'create images'}};
 await page.route('**/api/circles',r=>r.fulfill({json:[circle]}));
 await page.route('**/api/jobs',r=>r.fulfill({json:[job]}));
 await page.route('**/api/jobs/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/image')){requests++;await new Promise(resolve=>setTimeout(resolve,80));return route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')});}
  if(path.endsWith('/changes'))return route.fulfill({json:changes});
  if(path.endsWith('/receipt'))return route.fulfill({json:{receipt:changes.receipt,checks:[]}});
  if(path.endsWith('/transcript'))return route.fulfill({json:{text:'{}'}});
  if(path.endsWith('/retention'))return route.fulfill({json:{}});
  return route.fulfill({json:job});
 });
 await page.goto((await harness.link('owner'))+'#/job/'+encodeURIComponent(digest)+'/'+circle.id);
 await expect(page.getByRole('heading',{name:'Changes',exact:true})).toBeVisible();
 await page.locator('.job-image-preview').first().scrollIntoViewIfNeeded();
 await page.locator('.job-image-preview').first().getByRole('button',{name:'Show image preview'}).click();
 await expect.poll(()=>requests).toBeGreaterThan(0);
 await expect.poll(()=>page.evaluate(()=>window.previewFetchActive)).toBe(0);
 await page.locator('.job-image-preview').last().scrollIntoViewIfNeeded();
 await page.locator('.job-image-preview').last().getByRole('button',{name:'Show image preview'}).click();
 const last=page.getByRole('img',{name:'Preview of circle-13.png'});
 await expect(last).toBeVisible();
 await expect.poll(()=>last.evaluate(el=>el.complete&&el.naturalWidth>0)).toBe(true);
 expect(await page.evaluate(()=>window.previewFetchPeak)).toBeLessThanOrEqual(3);
 expect(await page.evaluate(()=>window.previewRevocations)).toBeGreaterThan(0);
});
test('lost Mandelbrot output explains why no files came back',async({page})=>{
 await fixture(page,{format:'diff',files:[],diff:'',diffstat:{files:0,insertions:0,deletions:0},receipt:{}},mandelbrot.message);
 await expect(page.getByText("The agent saved files outside the project, which don't come back: /tmp/mandelbrot_cel_shaded.png",{exact:true})).toBeVisible();
 await expect(page.getByText('The agent made no changes.',{exact:true})).toHaveCount(0);
});
test('outside files are named even when other changes came back',async({page})=>{
 await fixture(page,{format:'diff',files:[{path:'README.md',status:'added',insertions:1,deletions:0}],diff:'diff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1 @@\n+Render notes\n',diffstat:{files:1,insertions:1,deletions:0},receipt:{}},mandelbrot.message);
 await expect(page.getByText("The agent saved files outside the project, which don't come back: /tmp/mandelbrot_cel_shaded.png",{exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Use these changes'})).toBeVisible();
});

test('inline output images retain the two-preview budget and release object URLs',async({page})=>{
 await page.setViewportSize({width:1440,height:1600});
 await page.addInitScript(()=>{const revoke=URL.revokeObjectURL.bind(URL),create=URL.createObjectURL.bind(URL),images=new Set();window.previewRevocations=[];URL.createObjectURL=blob=>{const url=create(blob);if(blob.type.startsWith('image/'))images.add(url);return url;};URL.revokeObjectURL=url=>{if(images.delete(url))window.previewRevocations.push(url);return revoke(url);};});
 let imageRequests=0;page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/image'))imageRequests++;});
 const files=[1,2,3].map(n=>({path:'faravan-output/'+n+'.png',bytes:27144,preview:{media_type:'image/png',width:480,height:320,url:'/api/jobs/x/image?path='+n+'.png'},url:'/api/jobs/x/file'}));
 await fixture(page,{format:'message',message:{markdown:'# Images'},files,receipt:{}},'Images');
 await expect(page.locator('.job-image-preview img')).toHaveCount(2);
 await expect.poll(()=>imageRequests).toBeGreaterThanOrEqual(2);
 await expect(page.locator('.result-file code').first()).toHaveText('1.png');
 const count=imageRequests;await page.getByRole('button',{name:'Hide image preview'}).first().click();
 await expect(page.locator('.job-image-preview img')).toHaveCount(1);
 expect(imageRequests).toBe(count);
 await page.evaluate(()=>{location.hash='#/jobs';});await expect.poll(()=>page.evaluate(()=>window.previewRevocations.length)).toBeGreaterThanOrEqual(2);
});
