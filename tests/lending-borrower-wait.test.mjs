import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {waitingCopyVM} from '../ui/v1/src/view-models.mjs';
const until=Date.parse('2026-11-26T15:00:00Z');
test('queued give-back shows its reason and retry time',()=>{
 const job={state:'queued',job_digest:'sha256:'+'1'.repeat(64),current_attempt:{state:'released',holder:'a',reason:JSON.stringify({code:'outside_hours',until})}};
 const copy=waitingCopyVM(job,{lender:'Alex',zone:'UTC',now:until-1000});
 assert.match(copy.text,/outside its lending hours/);assert.match(copy.text,/3:00 PM/);
 assert.match(copy.text,/Another member may take it sooner/);assert.match(copy.headline,/Alex/);
});
test('queued job without give-back keeps ordinary queue copy',()=>{
 const copy=waitingCopyVM({state:'queued'},{circle:'Team',zone:'UTC'});
 assert.match(copy.text,/Sent to Team/);assert.doesNotMatch(copy.text,/Next check/);
});

test('the shared job view and CLI show the same give-back reason and deadline',async()=>{
 const {jobStatusContract}=await import('../lib/v1/status-contract.mjs');
 const {waitingLine}=await import('../lib/v1/cli.mjs');
 const job={state:'queued',current_attempt:{state:'released',reason:JSON.stringify({code:'outside_hours',until})}};
 const contract=jobStatusContract(job,{now:until-1000,formatTime:()=> '15:00'});
 assert.equal(contract.reasonCode,'outside_hours');
 assert.equal(contract.nextCheckAt,new Date(until).toISOString());
 assert.equal(contract.explanation,'Waiting: This computer is outside its lending hours. Next check: 15:00. Another member may take it sooner.');
 assert.equal(waitingLine({...job,statusContract:contract}),contract.explanation);
});
