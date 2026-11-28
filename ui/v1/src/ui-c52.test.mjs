import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {agentRowVM,lendPageVM,lendingQuotaLinesVM,machineVM,setupVM,jobsListVM} from './view-models.mjs';
import {contributionLine} from './helpers.mjs';
import {peopleListVM} from './people-view.mjs';
import {PeopleList} from './people.jsx';
import {memberAvailability} from './circles-view.mjs';
import {ResultCard} from './home.jsx';
import {Setup} from './setup.jsx';
import {renderFixture,renderedText} from './render.test-helper.mjs';
import {now,agents,circle,readiness,status,lendingReadiness} from './ui-c52.fixture.mjs';
test('H1 excludes all computers of the owner',()=>assert.equal(contributionLine({devices:2,jobs:3,rows:[{keyId:'other-own',personName:'Sam',run:2},{keyId:'friend',personName:'Ana',run:1}]},'self',{ownerName:'Sam'}),'You helped Ana with 1 job in the last 7 days.'));
test('L1 signed in Codex row shows the funding hold',()=>assert.match(agentRowVM(agents[1],null,{account:status.lendingPolicy.accounts[1]}).sub.join(' '),/Holding.*usage limit/));
test('L2 Home and Lending show the same unused weekly quota',()=>{const vm=lendPageVM(status,{agents,readiness,now});assert.equal(vm.meters[0].value,'81%');assert.equal(vm.meters[0].of,'of your weekly quota unused');assert.match(lendingQuotaLinesVM(status.lendingPolicy,false,status,{now})[0].text,/81% of your weekly quota unused/);});
test('Home and Lending agree when the live reading uses numeric timestamps', () => {
 const snapshot=structuredClone(status);
 const account=snapshot.lendingPolicy.accounts[0];
 account.decision.windows=[{state:'open',window_id:'seven_day',window_minutes:10080,used_pct:98.7,observed_at:now}];
 const [meter]=lendPageVM(snapshot,{agents,readiness,now}).meters;
 assert.equal(meter.value,'1.3%');
 assert.match(lendingQuotaLinesVM(snapshot.lendingPolicy,false,snapshot,{now})[0].text,/1.3% of your weekly quota unused/);
});

test('S1 S3 S4 setup keeps required checks and the limits editor with account holds',()=>{const props={api:{},agents,circles:[circle],circle:circle.id,lending:status.lending,data:{home:status,readiness,lendingReadiness,agents,devices:{}}};const vm=setupVM({status,readiness,lendingReadiness,agents,circle});assert.equal(vm.optionalNotReady,false);assert.equal(vm.headline,'Check lending accounts');const html=renderFixture(Setup,props),text=renderedText(html);assert.equal((text.match(/Setup complete/g)||[]).length,1);assert.match(html,/class="[^"]*setup-row-link[^"]*" href="#\/lend\/limits"/);});
test('C1 groups legacy per-computer person rows by displayed identity',()=>{const rows=peopleListVM([{personId:'p1',name:'Sam',role:'owner',computers:[{key_id:'one'}]},{personId:'p2',name:'Sam',role:'member',computers:[{key_id:'two'}]}],[],'two');assert.equal(rows.length,1);assert.equal(rows[0].computers.length,2);assert.equal(rows[0].roleName,'Owner');});
test('C2 circle list uses the same roster availability as Home',()=>{const member={key_id:'one',device_name:'laptop',online:true};const text=renderedText(renderFixture(PeopleList,{people:[{personId:'p1',name:'Ana',role:'member',computers:[member]}],members:[member],availability:m=>memberAvailability(m)}));assert.match(text,/Online/);assert.doesNotMatch(text,/Availability unknown/);});
test('J1 failed jobs retain their requested agent without claiming execution',()=>{const job={job_digest:'sha256:'+'a'.repeat(64),state:'failed',local:{agent:'codex',title:'Write a haiku'}};assert.match(JSON.stringify(jobsListVM([job])),/Codex/);});
for(const [id,file,pattern] of [['H2','home.jsx',/<h3 class="t-title2">\{row.title\}<\/h3>/],['D1','jobs.jsx',/page.receipt \? 'Sent to '/],['J2','jobs.css',/minmax\(7rem,9rem\)/]])test(id+' removes duplicate or constrained presentation',()=>assert.doesNotMatch(readFileSync(new URL(file,import.meta.url),'utf8'),pattern));

test('C1 keeps signed person identities separate even when names match',()=>{
 const rows=peopleListVM(['one','two'].map(id=>({personId:id,name:'Alex',role:'member',computers:[{key_id:id,person_id:id}]})));
 assert.equal(rows.length,2);
});
test('L3 a one-window owner hold has no duplicate warning in allowance',()=>{
 const account=structuredClone(status.lendingPolicy.accounts[0]);
 account.decision.objective.lendablePoints={seven_day:78.6};
 assert.doesNotMatch(lendingQuotaLinesVM({accounts:[account]},false,status)[0].text,/per-job limit/);
});

test('H2 the complete instruction appears once in the featured result',()=>{
 const prompt='Review the quoted-string parser carefully. '.repeat(8);
 const text=renderedText(renderFixture(ResultCard,{vm:{result:{title:'Review the quoted-string…',word:'Ready to review',kind:'on'},preview:{prompt,lines:[]},resultCopy:{lead:'Your answer is back.',action:'Read'}}}));
 assert.equal(text.split(prompt.trim()).length-1,1);
 assert.doesNotMatch(text,/What you asked|quoted-string…/);
});

test('L2 unused quota follows the account window when the summary disagrees',()=>{
 const vm=lendPageVM({...status,allowance:{...status.allowance,remaining:1}},{agents,readiness,now});
 assert.equal(vm.meters[0].value,'81%');
});
