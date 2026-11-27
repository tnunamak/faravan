import './helpers/no-browser.mjs';
// Register the Node JSX hook before the dynamic component imports below.
import '../ui/v1/src/jsx-register.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '@playwright/test';
import {posthogConfig,guardRecorder} from '../ui/v1/src/posthog.mjs';

// Use the exact pinned recorder: unmarked controls plus real private views.
// No SDK init, remote flag or live network. Emit is the serialization boundary.
test('real PostHog recorder masks unmarked text/input and blocks marked synthetic six-channel snapshots',{timeout:30000},async t=>{
 const [{renderFixture},{jobAnnouncements},{MainNotice},{ComputerProfile},{SaveFailed},{MASK_CANARIES,maskCanaryContent}]=await Promise.all([
  import('../ui/v1/src/render.test-helper.mjs'),import('../ui/v1/src/announcements.mjs'),
  import('../ui/v1/src/main.jsx'),import('../ui/v1/src/profile.jsx'),import('../ui/v1/src/limits.jsx'),
  import('../ui/v1/src/telemetry-mask-fixtures.mjs'),
 ]);
 // Identity only: not a bundle hash or qualification of the host's Chromium.
 const declaredVersion=JSON.parse(readFileSync(new URL('../ui/package.json',import.meta.url),'utf8')).dependencies['posthog-js'];
 const lockedVersion=JSON.parse(readFileSync(new URL('../ui/package-lock.json',import.meta.url),'utf8')).packages['node_modules/posthog-js'].version;
 const installedVersion=JSON.parse(readFileSync(new URL('../ui/node_modules/posthog-js/package.json',import.meta.url),'utf8')).version;
 assert.match(declaredVersion,/^\d+\.\d+\.\d+$/,'recorder dependency must be an exact version');
 assert.equal(installedVersion,declaredVersion,'installed recorder must match the declared dependency');
 assert.equal(installedVersion,lockedVersion,'installed recorder must match the lock entry');
 const privateValues={title:'ANNOUNCED_LOCAL_TITLE_79ac',direct:'DIRECT_NOTICE_CONTROL_79ac',
  owner:'PROFILE_OWNER_79ac',computer:'PROFILE_COMPUTER_79ac',typedOwner:'PROFILE_TYPED_OWNER_79ac',
  typedComputer:'PROFILE_TYPED_COMPUTER_79ac',mutatedNotice:'ANNOUNCEMENT_MUTATION_79ac'};
 const job={job_digest:'sha256:'+'a'.repeat(64),circle:{id:'mask-circle'},borrowerCircle:'mask-circle',
  state:'result-accepted',status:'result-accepted',result_digest:'sha256:'+'b'.repeat(64),
  current_attempt:{attempt_id:'mask-attempt',holder:'other-device',compute_stopped:true},
  local:{title:privateValues.title}};
 const baseline=jobAnnouncements(null,[]);
 assert.deepEqual(baseline.messages,[]);
 const announced=jobAnnouncements(baseline.seen,[job]);
 assert.equal(announced.messages.length,1,'real job producer must announce this row');
 assert.ok(announced.messages[0].includes(privateValues.title),'producer must retain local.title canary');
 const noop=()=>{};
 const fixtureHtml=[
  // Synthetic channel probe, not a claim that these are user-data producers.
  // Attributes/links use the marked blockSelector boundary, not global text masking.
  '<section id="mask-channels" class="ph-no-capture" data-telemetry-private="fixture-channels">'+renderFixture(maskCanaryContent)+'</section>',
  '<section id="produced-notice">'+renderFixture(MainNotice,{notice:announced.messages[0]})+'</section>',
  '<section id="direct-notice">'+renderFixture(MainNotice,{notice:privateValues.direct})+'</section>',
  '<section id="profile">'+renderFixture(ComputerProfile,{data:{devices:{ownerName:privateValues.owner,name:privateValues.computer}},mutate:noop})+'</section>',
  '<section id="save-failed">'+renderFixture(SaveFailed,{error:{code:'network'},onCheck:noop,onShow:noop})+'</section>',
 ].join('');
 const browser=await chromium.launch({headless:true});
 let page;
 try {
 page=await browser.newPage();
 await page.route('**/*',route=>route.abort());
 const canaries=['JOB_PROMPT_8f91','CODE_CONTENT_92ba','INPUT_VALUE_a9ef','TEXTAREA_VALUE_b3ef','PERSON_NAME_81ee','FILE_NAME_d9ab','TYPED_INPUT_3abc','TYPED_TEXTAREA_4abc','MUTATED_PROMPT_5abc','DEVICE_NAME_6abc'];
 await page.setContent(`<p id="prompt">${canaries[0]}</p><pre><code>${canaries[1]}</code></pre><input id="control-input" value="${canaries[2]}"><textarea>${canaries[3]}</textarea><span>${canaries[4]}</span><p>${canaries[5]}</p>${fixtureHtml}`);
 // Presence precedes every absence claim: inspect the real rendered DOM.
 assert.ok((await page.locator('#produced-notice').textContent()).includes(privateValues.title));
 assert.equal(await page.locator('#direct-notice [role="status"]').textContent(),privateValues.direct);
 assert.equal(await page.locator('#setting-ownerName').inputValue(),privateValues.owner);
 assert.equal(await page.locator('#setting-name').inputValue(),privateValues.computer);
 const failedText=await page.locator('#save-failed').textContent();
 assert.ok(failedText.includes('We could not confirm whether your changes were saved.'));
 assert.ok(failedText.includes('Check the saved settings before you change anything else.'));
 // Read each real DOM channel independently of the expected-value list.
 const channelState=()=>page.locator('#mask-channels [data-mask-probe]').evaluate(root=>({
  text:root.querySelector('p').textContent,
  input:root.querySelector('input').value,
  title:root.querySelector('span').getAttribute('title'),
  label:root.querySelector('span').getAttribute('aria-label'),
  href:root.querySelector('a').getAttribute('href'),
  hidden:root.querySelector('[hidden]').textContent,
  hiddenPresent:root.querySelector('[hidden]').hasAttribute('hidden'),
  svg:root.querySelector('svg text').textContent,
  svgLabel:root.querySelector('svg').getAttribute('aria-label'),
  marked:root.closest('.ph-no-capture[data-telemetry-private]')?.id,
 }));
 const expectedChannels=values=>({
  text:values.text,input:values.input,title:values.attribute,label:values.attribute,
  href:'https://example.invalid/'+values.link,hidden:values.hidden,hiddenPresent:true,
  svg:values.svg,svgLabel:values.svg,marked:'mask-channels',
 });
 assert.equal(Object.keys(MASK_CANARIES).length,6);
 assert.deepEqual(await channelState(),expectedChannels(MASK_CANARIES));
 // SaveFailed is fixed catalog copy, not an Error.message/email leak fixture.
 await page.addScriptTag({content:readFileSync(new URL('../ui/node_modules/posthog-js/dist/posthog-recorder.js',import.meta.url),'utf8')});
 const config=posthogConfig('11111111-1111-4111-8111-111111111111',()=>{}).session_recording;
 assert.equal(config.maskAllInputs,true);assert.equal(config.maskTextSelector,'*');
 // Functions are reconstructed in the page so Playwright does not erase them.
 await page.evaluate(({config,guard,maskText,maskInput})=>{
  const guarded=(0,eval)('('+guard+')');window.snapshots=[];
  window.stopRecording=guarded(window.__PosthogExtensions__.rrweb.record,{reserveReplay:()=>true})({...config,
   maskTextFn:(0,eval)('('+maskText+')'),maskInputFn:(0,eval)('('+maskInput+')'),emit:event=>window.snapshots.push(event)});
 },{config:JSON.parse(JSON.stringify(config)),guard:guardRecorder.toString(),maskText:config.maskTextFn.toString(),maskInput:config.maskInputFn.toString()});
 await page.waitForFunction(()=>window.snapshots.some(event=>event.type===2));
 await page.locator('#control-input').fill(canaries[6]);await page.locator('textarea').fill(canaries[7]);
 await page.evaluate(values=>{document.querySelector('#prompt').firstChild.textContent=values[8];const name=document.createElement('p');name.textContent=values[9];document.body.append(name);},canaries);
 await page.waitForFunction(()=>window.snapshots.some(event=>event.type===3&&event.data.source===5)&&window.snapshots.some(event=>event.type===3&&event.data.source===0));
 await page.locator('#setting-ownerName').fill(privateValues.typedOwner);
 await page.locator('#setting-name').fill(privateValues.typedComputer);
 await page.evaluate(value=>{document.querySelector('#produced-notice [role="status"]').textContent=value;},privateValues.mutatedNotice);
 assert.equal(await page.locator('#setting-ownerName').inputValue(),privateValues.typedOwner);
 assert.equal(await page.locator('#setting-name').inputValue(),privateValues.typedComputer);
 assert.equal(await page.locator('#produced-notice [role="status"]').textContent(),privateValues.mutatedNotice);
 // Exercise changes in every synthetic channel, including hidden DOM (no
 // visibility assertion). A blocked subtree need not emit its own event.
 const changedChannels=Object.fromEntries(Object.entries(MASK_CANARIES).map(([key,value])=>[key,value+'_CHANGED']));
 await page.locator('#mask-channels [data-mask-probe]').evaluate((root,values)=>{
  root.querySelector('p').textContent=values.text;
  const input=root.querySelector('input');input.value=values.input;
  input.dispatchEvent(new Event('input',{bubbles:true}));
  root.querySelector('span').setAttribute('title',values.attribute);
  root.querySelector('span').setAttribute('aria-label',values.attribute);
  root.querySelector('a').setAttribute('href','https://example.invalid/'+values.link);
  root.querySelector('[hidden]').textContent=values.hidden;
  root.querySelector('svg text').textContent=values.svg;
  root.querySelector('svg').setAttribute('aria-label',values.svg);
 },changedChannels);
 assert.deepEqual(await channelState(),expectedChannels(changedChannels));
 // Require a later unblocked mutation to arrive before inspecting the wire.
 const mutationsBefore=await page.evaluate(()=>window.snapshots.filter(event=>event.type===3&&event.data.source===0).length);
 await page.evaluate(()=>{document.querySelector('#prompt').textContent='PUBLIC_MUTATION_BARRIER';});
 await page.waitForFunction(count=>window.snapshots.filter(event=>event.type===3&&event.data.source===0).length>count,mutationsBefore);
 const events=await page.evaluate(()=>window.snapshots);
 const wire=JSON.stringify(events);
 // Scan actual captured full and incremental payloads separately as well.
 for(const type of [2,3]){
  const captured=events.filter(event=>event.type===type);
  assert.ok(captured.length,'snapshot class '+type+' must be captured');
  for(const value of [...Object.values(MASK_CANARIES),...Object.values(changedChannels)])
   assert.equal(JSON.stringify(captured).includes(value),false,'channel leaked in snapshot class '+type+': '+value);
 }
 for(const value of [...canaries,...Object.values(privateValues),...Object.values(MASK_CANARIES),...Object.values(changedChannels)])assert.equal(wire.includes(value),false,`private content leaked: ${value}`);
 assert.ok(events.some(event=>event.type===2),'full snapshot captured');
 assert.ok(events.some(event=>event.type===3&&event.data.source===0),'text mutation captured');
 assert.ok(events.some(event=>event.type===3&&event.data.source===5),'typed input captured');
 const text=[];const walk=node=>{if(node?.type===3)text.push(node.textContent);for(const child of node?.childNodes??[])walk(child);};
 walk(events.find(event=>event.type===2).data.node);
 assert.ok(text.includes('***'),'global text masking, without private markers');
 t.diagnostic('Masked full snapshot text: '+JSON.stringify(text));
 t.diagnostic('Masked typed input: '+JSON.stringify(events.filter(event=>event.type===3&&event.data.source===5).map(event=>event.data.text)));
 } finally {
  // Stop even after a failed presence/leak assertion; do not orphan a recorder.
  try {if(page&&!page.isClosed())await page.evaluate(()=>{const stop=window.stopRecording;window.stopRecording=undefined;stop?.();});}
  finally {try {await page?.close();} finally {await browser.close();}}
 }
});
