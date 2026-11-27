import test from 'node:test';
import assert from 'node:assert/strict';
import {JobsList,WaitingJob} from './jobs.jsx';
import {jobsListVM} from './view-models.mjs';
import {renderFixture,renderedText,assertDomOrder} from './render.test-helper.mjs';
const circle={id:'circle',name:'Weekend projects'};
const sentence='Sam declined this request. It went back to the circle; another computer can pick it up.';
const job={job_digest:'declined',circle,role:'sent',state:'queued',current_attempt:{holder:'lender',reason:'approval_denied'},local:{title:'Fix the dates',prompt:'Fix the dates',agent:'codex'},waitingTiming:{submittedAt:'2026-10-20T15:00:00Z',expiresAt:'2026-10-22T15:00:00Z'}};
const devices={fingerprint:'owner',circles:[{circle:'circle',members:[{key_id:'lender',localName:'Sam'}]}]};
function page(fields={}) {
 return renderFixture(WaitingJob,{job:{...job,...fields},circleLabel:circle.name,lender:'Sam',now:Date.parse('2026-10-20T15:00:00Z')});
}
test('a declined request explains the decision before queue age, waiting and expiry',()=>{
 const out=page(),text=renderedText(out);
 assertDomOrder(out,[sentence,'Waiting for a computer','Waiting under 1 min','Sent to Weekend projects']);
 assert.match(text,/Expires/);
 assert.doesNotMatch(out,/role="alert"/);
 const list=renderFixture(JobsList,{vm:jobsListVM([job],{devices}),onFilter(){}});
 assert.match(list,new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
test('a declined send-anyway request retains the exact unavailable-agent explanation',()=>{
 const message='No computer in Weekend projects lends Codex right now';
 const out=page({waiting_reason:'agent_unavailable',waiting_message:message});
 assertDomOrder(out,[sentence,message,'Sent to Weekend projects']);
 const list=renderFixture(JobsList,{vm:jobsListVM([{...job,waiting_reason:'agent_unavailable',waiting_message:message}],{devices}),onFilter(){}});
 assert.match(renderedText(list),/Waiting · no lender/);
 assert.ok(list.includes(message));
});

test('signed jobs without a ready count show the generic waiting status once',()=>{
 const headline='Waiting for someone to run it';
 const request={job_digest:'signed',circle,role:'sent',state:'queued',
   job:{payload:{runRequest:{schemaVersion:1,models:'any',effortId:null}}},
   offerWaiting:{readyCount:null},statusContract:{lifecycle:'waiting',reasonCode:null,explanation:headline+'.'}};
 const render=job=>renderedText(renderFixture(WaitingJob,{job,circleLabel:circle.name}));
 assert.equal(render(request),headline);
 const distinct='Account availability is unconfirmed.';
 assert.equal(render({...request,statusContract:{...request.statusContract,explanation:distinct}}),headline+' '+distinct);
 assert.equal(render({...request,job:undefined}),headline+' '+headline+'.','the legacy fallback keeps its prior copy');
});
