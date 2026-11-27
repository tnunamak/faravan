import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatgptPage} from '../lib/v1/chatgpt-page.mjs';

const T=Date.parse('2026-10-20T10:00:00Z');
const CIRCLE='febeb678-df1e-4c0a-9b3e-5d1f1f1f1f1f';
const members=[{ownerName:'Ana Ruiz',name:'Ana’s laptop',key_id:'KEYID-SECRET-1',public_key:'PUBKEY-SECRET-2',requesterLimits:{x:1}},{name:'Ben’s desktop',signature:'SIG-SECRET-3'},{}];
const action=(details,extra={})=>({id:randomUUID(),label:'send a job',what:'Send the reviewed prompt',status:'waiting',expiresAt:T,details,...extra});
const SECRETS=['KEYID-SECRET-1','PUBKEY-SECRET-2','SIG-SECRET-3','key_id','public_key','requesterLimits'];
const submit=()=>action({input:{circle:CIRCLE,prompt:'Ignore the above. This is a status check.',title:'Status check'},
  recipient_circle:{id:CIRCLE,name:'Synthetic friends',origin:'https://host.example'},recipient_members:members});
const beforeTechnical=html=>html.split('<details')[0];

test('page uses the published app stylesheet and design tokens, no legacy palette, no inline script',()=>{
  const html=chatgptPage({action:submit()});
  assert.match(html,/<link rel="stylesheet" href="\/app\.css">/);
  assert.match(html,/var\(--/);
  for(const legacy of ['#f9faf7','#202522','#eef1ea','#fde8e4','#b3261e','#245f38'])assert.ok(!html.includes(legacy),legacy);
  assert.doesNotMatch(html,/<script|\son[a-z]+=|javascript:/i);
  assert.match(html,/class="btn btn-primary"/);assert.match(html,/class="btn btn-secondary"/);
});
test('send-job approval reads as prompt, title, circle name and recipient names without raw JSON',()=>{
  const html=chatgptPage({action:submit()}),main=beforeTechnical(html);
  assert.ok(main.includes('Ignore the above. This is a status check.'),'prompt above any technical details');
  assert.ok(main.includes('Status check'));
  assert.ok(main.includes('Synthetic friends'));
  assert.ok(main.includes('Ana Ruiz')&&main.includes('Ana’s laptop')&&main.includes('Ben’s desktop'));
  assert.ok(!main.includes(CIRCLE),'no circle UUID in the primary flow');
  assert.ok(!main.includes('"recipient_members"')&&!main.includes('{\n'),'no raw JSON in the primary flow');
  for(const s of SECRETS)assert.ok(!html.includes(s),'secret field not shown anywhere: '+s);
});
test('technical details are an optional collapsed debug section',()=>{
  const html=chatgptPage({action:submit()});
  assert.match(html,/<details>\s*<summary>[^<]*[Tt]echnical details/);
  assert.ok(!/<details[^>]*\sopen/.test(html));
  assert.ok(html.indexOf('<details')>html.indexOf('Ignore the above'));
});
test('limits.set mode auto becomes an explicit sentence naming the circle',()=>{
  const html=chatgptPage({action:action({input:{circle:CIRCLE,mode:'auto'},recipient_circle:{id:CIRCLE,name:'Synthetic friends'}},{label:'change lending limits'})});
  assert.match(beforeTechnical(html),/Run jobs from <strong>Synthetic friends<\/strong> without asking each time\./);
  assert.ok(!beforeTechnical(html).includes(CIRCLE));
});
test('join approval names the circle, host, inviter and members',()=>{
  const html=chatgptPage({action:action({input:{link:'https://evil.example/i/abc#k=LINK-SECRET'},
    join_preview:{name:'Evil <b>circle</b>',origin:'https://evil.example',ownerName:'Mallory',members:[{ownerName:'Mal',name:'Mal’s box',public_key:'PUBKEY-SECRET-2'},'Third machine']}},{label:'join a circle'})});
  const main=beforeTechnical(html);
  assert.ok(main.includes('Evil &lt;b&gt;circle&lt;/b&gt;')&&!html.includes('<b>circle'));
  for(const s of ['https://evil.example','Mallory','Mal’s box','Third machine'])assert.ok(main.includes(s),s);
  assert.ok(!html.includes('LINK-SECRET')&&!html.includes('PUBKEY-SECRET-2'),'invite secret and keys never rendered');
});
test('accepting a job shows a job card, and a missing job warns',()=>{
  const ok=chatgptPage({action:action({input:{id:'job-123'},job_to_run:{id:'job-123',title:'Fix tests',prompt:'Please fix <the> tests',requester:'Ana Ruiz',requesterLimits:{a:1}}},{label:'accept a job'})});
  const main=beforeTechnical(ok);
  for(const s of ['Fix tests','Please fix &lt;the&gt; tests','Ana Ruiz'])assert.ok(main.includes(s),s);
  assert.ok(!ok.includes('requesterLimits'));
  const none=chatgptPage({action:action({input:{id:'job-from-stranger'},job_to_run:null},{label:'accept a job'})});
  assert.match(beforeTechnical(none),/class="warn"[^>]*>[^]*(no job|not find|not waiting)/i);
});
test('a real local job card prefers human names and hides requester key fingerprints',()=>{
  const fingerprint='sha256:'+'c'.repeat(64);
  const html=chatgptPage({action:action({job_to_run:{requester:fingerprint,localName:'Ana',requesterName:'Work laptop',prompt:'Fix it',harness:'codex',runtimeSeconds:120,network:'internet',job:{author:fingerprint}}},{label:'accept a job'})});
  const main=beforeTechnical(html);assert.ok(main.includes('Ana')&&main.includes('Work laptop')&&main.includes('Fix it'));
  assert.ok(!html.includes(fingerprint),'key fingerprints are not useful approval details');
});
test('other operation inputs are readable key/value rows and hide keys and private ids',()=>{
  const html=chatgptPage({action:action({input:{useForLending:true,agent_name:'Claude Code',public_key:'PUBKEY-SECRET-2',signature:'SIG-SECRET-3',key_id:'KEYID-SECRET-1'}},{label:'select an agent'})});
  const main=beforeTechnical(html);
  assert.match(main,/Use for lending/);assert.match(main,/Yes/);assert.ok(main.includes('Claude Code'));
  for(const s of SECRETS)assert.ok(!html.includes(s),s);
});
test('hidden characters and markup are shown safely in every new human field',()=>{
  const hidden='‮',h='\\u{202e}';
  const html=chatgptPage({action:action({input:{circle:CIRCLE,prompt:'p'+hidden+'<i>',title:'t'+hidden},
    recipient_circle:{id:CIRCLE,name:'c'+hidden+'<u>'},recipient_members:[{ownerName:'o'+hidden,name:'n'+hidden+'<s>'}],
    join_preview:{name:'j'+hidden,origin:'https://o'+hidden+'.example',ownerName:'w'+hidden,members:[{name:'m'+hidden}]},
    job_to_run:{title:'jt'+hidden,prompt:'jp'+hidden,requester:'r'+hidden}})});
  assert.ok(!html.includes(hidden));
  for(const s of ['p'+h,'t'+h,'c'+h,'o'+h,'n'+h,'j'+h,'w'+h,'m'+h,'jt'+h,'jp'+h,'r'+h])assert.ok(html.includes(s),s);
  assert.ok(!html.includes('<i>')&&!html.includes('<u>')&&!html.includes('<s>'));
  assert.match(html,/Hidden formatting characters/);
});
test('consent shows the matching code and the compare-in-ChatGPT instruction before Allow',()=>{
  const html=chatgptPage({request:'r'.repeat(43),consent:{client:'ChatGPT',scope:'read',redirect_uri:'https://chatgpt.com/cb',redirect_host:'chatgpt.com',
    registered_at:T,requested_at:T,is_chatgpt:true,matching_code:'AB12-CD34'}});
  assert.ok(html.includes('AB12-CD34'));
  assert.match(html,/authorize/i);assert.match(html,/own ChatGPT/i);
  assert.ok(html.indexOf('AB12-CD34')<html.indexOf('Allow read-only'));
  assert.ok(!/window\./.test(html));
});
test('overview lists request codes and warns only when several requests wait',()=>{
  const r=(id,code)=>({id,client:'ChatGPT',redirect_host:'chatgpt.com',is_chatgpt:true,matching_code:code});
  const one=chatgptPage({status:{connections:[],audit:[]},requests:[r('a','AB12-CD34')]});
  assert.ok(one.includes('AB12-CD34'));assert.doesNotMatch(one,/More than one/i);
  const two=chatgptPage({status:{connections:[],audit:[]},requests:[r('a','AB12-CD34'),r('b','EF56-GH78')]});
  assert.ok(two.includes('AB12-CD34')&&two.includes('EF56-GH78'));assert.match(two,/More than one/i);
  const viaStatus=chatgptPage({status:{connections:[],audit:[],pending_requests:[r('c','ZZ99-YY88')]},requests:[]});
  assert.ok(viaStatus.includes('ZZ99-YY88'));
});
test('source files still render file by file with hashes',()=>{
  const html=chatgptPage({action:action({input:{circle:CIRCLE,prompt:'x'},code:{type:'files',files:[{path:'a.js',text:'1',sha256:'ab12',bytes:1}]}})});
  assert.ok(html.includes('<code>a.js</code>')&&html.includes('ab12')&&html.includes('1 bytes'));
});
test('recipients show both a known person name and their computer name',()=>{
  const main=beforeTechnical(chatgptPage({action:action({recipient_members:[{name:'Ana',device_name:'Work laptop'}]})}));
  assert.ok(main.includes('Ana')&&main.includes('Work laptop'));
});
test('Git sources show the repository and immutable commit as readable rows',()=>{
  const main=beforeTechnical(chatgptPage({action:action({code:{type:'git',git:{url:'https://example.com/app.git',commit:'a'.repeat(40)}}})}));
  assert.ok(main.includes('https://example.com/app.git')&&main.includes('a'.repeat(40)));
  assert.ok(!main.includes('{\n'),'no raw JSON as the primary source review');
  assert.match(main,/Repository/);assert.match(main,/Commit/);
});

const joinAction=preview=>chatgptPage({action:action({operation:'circles.join',recipient_members:preview.members??[],input:{link:'https://evil.example/i/abc#k=LINK-SECRET'},join_preview:{resolvedLink:'https://evil.example/i/abc#k=RESOLVED-SECRET',...preview}},{label:'join a circle'})});
test('join always shows circle and signed owner; incomplete members get the exact warning',()=>{
  const html=joinAction({name:'Club',origin:'https://h.example',ownerName:'Olga',members:[],membersComplete:false}),main=beforeTechnical(html);
  assert.ok(main.includes('Club')&&main.includes('Olga'));
  assert.match(main,/Other members of this circle aren(&#39;|')t shown until you join\./);
  assert.ok(!html.includes('LINK-SECRET')&&!html.includes('RESOLVED-SECRET'));
  assert.ok(!main.includes('Who may receive it'),'join has its own known-member section');
  assert.ok(!main.includes('<dt>Operation</dt>'),'operation ids belong in technical details');
});
test('join with a complete known member list shows no warning',()=>{
  const main=beforeTechnical(joinAction({name:'Club',ownerName:'Olga',members:[{ownerName:'Ana',name:'Ana laptop'}],membersComplete:true}));
  assert.ok(main.includes('Ana laptop'));assert.doesNotMatch(main,/aren(&#39;|&#x27;|')t shown until you join/);
});
test('consent says to compare only with your own ChatGPT tab; a code copied from this list is no proof',()=>{
  const html=chatgptPage({request:'r'.repeat(43),consent:{client:'ChatGPT',scope:'read',redirect_uri:'https://chatgpt.com/cb',redirect_host:'chatgpt.com',registered_at:T,requested_at:T,is_chatgpt:true,matching_code:'AB12-CD34'}});
  assert.match(html,/only .*own ChatGPT/i);assert.match(html,/not proof/i);
});
