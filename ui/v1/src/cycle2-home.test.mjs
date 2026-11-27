import test from 'node:test';
import assert from 'node:assert/strict';
import {Home} from './home.jsx';
import {Lend} from './lend.jsx';
import {Setup} from './setup.jsx';
import {HostChoose} from './host.jsx';
import {ComposeBody} from './compose.jsx';
import {Circles} from './circles.jsx';
import {composeVM, lendingVerdictVM, lendPageVM} from './view-models.mjs';
import {routeFromHash} from './helpers.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

const agent={id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true,run:{}};
const circle={id:'friends',name:'Friends',origin:'http://fixture',owned:true};
const lending={enabled:true,circle:circle.id,mode:'ask',status:'idle',limits:{timeZone:'UTC'}};
const readiness={ready:true,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:true},{name:'docker_login',ok:true}]};
const home=withLendingProjection({intent:{on:true,state:'blocked',reason:'sandbox_not_ready'},lending},
  {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'sandbox_not_ready'});
const data={home,readiness,agents:[agent],circles:[circle],jobs:[],approvals:[],activity:[],devices:{name:'Laptop',ownerName:'Tessa',fingerprint:'self',circles:[]}};
const props={data,agents:[agent],circles:[circle],circle:circle.id,selected:circle,lending,members:[],api:{get:async()=>[]},mutate:async()=>({}),refresh(){},setDialog(){},setCircle(){}};

test('rendered Home, Lending and Setup never expose raw harness ids, including old saved failures',()=>{
  const first={key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:'Failed: claude-code-subscription sign-in.',action:'Resume lending'};
  const server={...home,lending_blockers:{items:[first],first,byAgent:{},canLend:false,needsYou:[first]}};
  for(const status of [home,server])for(const Component of [Home,Lend,Setup]){
    const html=renderFixture(Component,{...props,data:{...data,home:status}}), text=renderedText(html);
    assert.doesNotMatch(text,/claude-code-(subscription|api-key)|gh-cli/);

  }
});

test('the projected reason owns the headline explanation while blocker details stay in the checklist',()=>{
  const first={key:'isolation_check',status:'blocked',detail:'Failed: Claude Code sign-in.',action:'Resume lending'};
  const vm=lendingVerdictVM(home,{first,items:[first],byAgent:{}});
  assert.equal(vm.headline,'Lending can’t start here');
  assert.equal(vm.reason,'Set up the protected workspace to lend on this computer. You can still send jobs to another lender.');
  assert.match(vm.headline,/lending can’t start here/i);
  assert.equal(vm.on,true);
  const checking=withLendingProjection({...home,lendingProjection:undefined},{intent:'on',intentState:'blocked',admission:'unknown',admissionReason:null});
  const checkingVerdict=lendingVerdictVM(checking,{first:null,items:[{key:'isolation_check',status:'unknown',label:'Sandbox isolation'}],byAgent:{}});
  assert.equal(checkingVerdict.headline,'Status unavailable');
  assert.equal(lendPageVM(withLendingProjection({...home,intent:{on:false,state:'off'}},{intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'}),{agents:[agent],readiness}).headline,'Lending is off');
});

test('Start a circle links straight to a new-circle route even on a hosting computer',()=>{
  assert.deepEqual(routeFromHash('#/circles/new'),{page:'host',id:'new'});
  const html=renderFixture(Circles,props);
  assert.match(html,/href="#\/circles\/new"[^>]*>Start a circle/);
  const off={...lending,enabled:false,circle:null};
  const empty=renderFixture(Home,{...props,lending:off,agents:[],circles:[],data:{...data,agents:[],circles:[],home:{...home,intent:{on:false,state:'off'},lending:off}}});
  assert.match(empty,/href="#\/circles\/new"[^>]*>Start a circle/);
});

test('first circle form keeps an empty name and a visible disabled primary until fields are valid',()=>{
  const html=renderFixture(HostChoose,{choice:{method:'tailscale',address:'',domain:'',name:''},onChoice(){},onStart(){}});
  assert.match(html,/<input[^>]*aria-label="Circle name"[^>]*placeholder="For example, Weekend projects"/);
  assert.match(html,/<button[^>]*class="btn btn-primary"[^>]*disabled[^>]*>Start circle/);
  assert.doesNotMatch(html,/Tessa/);
});

test('not-git refusal uses the designed explanation and recovery, never a raw path error',()=>{
  const vm=composeVM({prompt:'Help',circle,repo:{status:'refused',refusal:{state:'compose.not-git',message:'/private/sandbox is a folder but not a git repository'}}});
  assert.doesNotMatch(vm.folderError,/private|is a folder but/);
  const html=renderFixture(ComposeBody,{vm,draft:{sourceKind:'folder',path:'~/sandbox',prompt:'Help'},onChoose(){},onCancel(){},agents:[]});
  const text=renderedText(html);
  assert.match(text,/folder snapshot returns changed files for download/);
  assert.doesNotMatch(text,/git init/);
  assert.match(text,/Choose another folder/);
  assert.doesNotMatch(text,/private\/sandbox|is a folder but/);
});
