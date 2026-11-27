import test from 'node:test';
import assert from 'node:assert/strict';
import {homePageVM, homePeopleVM} from './view-models.mjs';

const now = Date.parse('2026-10-20T05:00:00Z');
const circle = {id:'circle-1',name:'Weekend projects'};
const ago = ms => new Date(now - ms).toISOString();
const member = (key_id, extra = {}) => ({key_id, ...extra});

test('Home recent keeps the shared job title, including a real device identity named Someone', () => {
  const jobs = [
    {job_digest:'known',role:'ran',status:'Finished',circle,historyIdentity:{author:'a',localName:'Alex'}},
    {job_digest:'device',role:'ran',status:'Finished',circle,historyIdentity:{author:'b',deviceName:'Sam laptop'}},
    {job_digest:'literal',role:'ran',status:'Finished',circle,historyIdentity:{author:'c',localName:'Someone'}},
    {job_digest:'unknown',role:'ran',status:'Finished',circle,historyIdentity:{}},
  ];
  const recent = homePageVM({jobs,approvals:[],now,zone:'UTC'}).recent;
  assert.deepEqual(recent.map(row => row.title), [
    'Job for Alex', 'Job for Sam laptop', 'Job for Someone', 'A job you ran',
  ]);
});

test('Home people prefers local identity, excludes this computer, and uses the newest same-circle job time as history only', () => {
  const members = [
    member('self',{localName:'Me'}),
    member('local',{localName:'Local name',device_name:'Device name'}),
    member('person',{personName:'Person name',deviceName:'Device name'}),
    member('device',{deviceName:'Laptop'}),
    member('owner',{ownerName:'Owner name'}),
    member('activity',{device_name:'Activity laptop',last_seen_at:ago(60*60_000)}),
    member('seen',{last_seen_at:ago(60*60_000)}),
    member('fresh',{presence:{state:'running',last_poll_at:ago(1000)}}),
    member('borrower',{role:'borrower'}),
  ];
  const jobs = [
    {role:'ran',circle,historyIdentity:{author:'activity'},updated_at:ago(2*60*60_000),receipt:{finished_at:ago(30*60_000)}},
    {role:'ran',circle,historyIdentity:{author:'seen'},current_attempt:{execution_started_at:ago(2*60*60_000)}},
    {role:'ran',circle:{id:'other'},historyIdentity:{author:'seen'},current_attempt:{execution_started_at:ago(1000)}},
    {role:'ran',circle,historyIdentity:{author:'somebody-else'},requester:'seen',current_attempt:{execution_started_at:ago(1000)}},
    {role:'sent',circle,historyIdentity:{author:'fresh'},current_attempt:{execution_started_at:ago(1000)}},
  ];
  const people = homePeopleVM(members,{ownId:'self',now,zone:'UTC',jobs,circleId:circle.id});
  assert.deepEqual(people.map(person => person.name), [
    'Local name','Person name','Laptop','Owner name','Activity laptop','A circle member','A circle member','A circle member',
  ]);
  assert.deepEqual(people.map(person => person.state), [
    'Device name · No recent activity','Device name · No recent activity','No recent activity','No recent activity',
    'Last active 30 min ago','Last seen 1 h ago','Lending now','Borrows',
  ]);
});

test('Home people requires execution proof before an active reservation means a running job', () => {
  const jobs = [
    {state:'claimed',approval:'pending',circle,current_attempt:{state:'active',holder:'reserved',claimed_at:ago(60_000)}},
    {state:'claimed',approval:'approved',circle,current_attempt:{state:'active',holder:'running',approved_at:ago(60_000),claimed_at:ago(60_000),execution_started_at:ago(30_000)}},
  ];
  const people = homePeopleVM([member('reserved'),member('running')],{now,zone:'UTC',jobs,circleId:circle.id});
  assert.deepEqual(people.map(person=>person.state),['Last active 1 min ago','Running a job now']);
});

test('Home subtitle partitions the same six attention items by category and never says caught up while attention remains', () => {
  const jobs = Array.from({length:3},(_,index) => ({job_digest:'result-'+index,role:'sent',status:'Finished',circle}));
  const approval = {id:'request-1',requester:'sam'};
  const home = {
    lending:{enabled:true},
    needs_you:[{kind:'misc',id:'misc-1'}],
    lending_blockers:{
      items:[{key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending.',action:'Resume lending'}],
      first:{key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending.',action:'Resume lending'},
      canLend:false,
    },
  };
  const result = homePageVM({jobs,approvals:[approval],home,now,zone:'UTC'});
  assert.equal(result.needs,6);
  assert.deepEqual(result.counts,{results:3,requests:1,setup:1,other:1});
  assert.equal(Object.values(result.counts).reduce((sum,count)=>sum+count,0),result.needs);
  assert.equal(result.subtitle,'3 results to review · 1 request needs you · 1 setup step · 1 other item');
  assert.notEqual(result.subtitle,'You’re all caught up.');
});

test('Home keeps initial resources in a loading state instead of claiming an empty queue', () => {
  const result = homePageVM({jobs:null,approvals:null});
  assert.equal(result.subtitle,'Loading requests and results…');
  assert.equal(result.offerNewJob,false);
  const homePending = homePageVM({jobs:[],approvals:[]});
  assert.equal(homePending.subtitle,'Loading requests and results…');
  assert.equal(homePending.offerNewJob,false);
});
