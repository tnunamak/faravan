import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectPickerBody} from './project-picker.jsx';
import {filterProjects, homePath, folderCrumbs, createRepoChecker} from './project-picker-model.mjs';
import {composeVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {createApi} from './api.mjs';

const repo={path:'/home/sam/code/sandbox',name:'sandbox',branch:'main'};
test('picker filters names and paths without case sensitivity, and shortens only home descendants',()=>{
  assert.deepEqual(filterProjects([repo], ' CODE/SAND '),[repo]);
  assert.deepEqual(filterProjects([repo], 'other'),[]);
  assert.equal(homePath(repo.path,'/home/sam'),'~/code/sandbox');
  assert.equal(homePath('/home/samantha/project','/home/sam'),'/home/samantha/project');
  assert.deepEqual(folderCrumbs('/home/sam/code/sandbox','/home/sam'),[{name:'Home',path:'/home/sam'},{name:'code',path:'/home/sam/code'},{name:'sandbox',path:repo.path}]);
});
test('picker shows recent, discovered projects, branch chips and navigable non-repo folders',()=>{
  const out=renderFixture(ProjectPickerBody,{data:{recent:[repo],repos:[repo],truncated:true},browse:{path:'/home/sam',home:'/home/sam',folders:[{name:'code',path:'/home/sam/code',is_git:false},{...repo,is_git:true}]},query:'',onQuery(){},onBrowse(){},onChoose(){},onClose(){}});
  const text=renderedText(out);
  for(const copy of ['Recent','Projects on this computer','~/code/sandbox','main','Browse','Home','Scan limited to 1 projects; browse or type a path for others'])assert.ok(text.includes(copy),copy);
  assert.match(out,/data-picker-row/);
  assert.doesNotMatch(out,/data-picker-row="true"[^>]*aria-label=/);
});
test('empty picker explains there are no projects and offers Browse; search has its own empty state',()=>{
  const base={data:{recent:[],repos:[]},browse:{home:'/home/sam',path:'/home/sam',folders:[]},onClose(){},onQuery(){},onBrowse(){},onChoose(){}};
  assert.match(renderedText(renderFixture(ProjectPickerBody,{...base,query:''})),/No projects found.*Browse/);
  assert.match(renderedText(renderFixture(ProjectPickerBody,{...base,query:'missing'})),/No projects match/);
});
test('folder refusal uses the designed recovery rather than a raw backend path',()=>{
  const message='No folder at /home/sam/sandbx';
  assert.match(composeVM({repo:{status:'refused',refusal:{state:'compose.repo-missing',message}}}).folderError,/Choose an existing project folder/);
});
test('API carries actionable repo suggestions and an abort signal through POST',async()=>{
  const controller=new AbortController(); let sent;
  const message=repo.path+' is a folder but not a git repository';
  const api=createApi('test',async(_url,options)=>{sent=options;return new Response(JSON.stringify({code:'repo_refused',repo_code:'not_git',state:'compose.not-git',message,path:repo.path,suggestions:[repo]}),{status:400});});
  await assert.rejects(api.post('repo/inspect',{path:'~/code/sandbox'},controller.signal),e=>{
    assert.equal(e.repoRefusal.message,undefined);assert.doesNotMatch(e.message,/\/home\//);assert.deepEqual(e.repoRefusal.suggestions,[repo]);return true;
  });
  assert.equal(sent.signal,controller.signal);
});
function checkerFixture(){
  const timers=new Map(), requests=[],results=[];let seq=0;
  const checker=createRepoChecker({setTimer:fn=>{timers.set(++seq,fn);return seq;},clearTimer:id=>timers.delete(id),inspect:(path,signal)=>new Promise(resolve=>requests.push({path,signal,resolve})),onResult:value=>results.push(value)});
  const tick=()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}};
  return {checker,timers,requests,results,tick};
}
test('typing waits for a pause; Enter/blur checks immediately without duplicate in-flight requests',async()=>{
  const f=checkerFixture();f.checker.schedule('~/s');f.checker.schedule('~/sandbox');assert.equal(f.requests.length,0);assert.equal(f.timers.size,1);
  f.tick();assert.equal(f.requests[0].path,'~/sandbox');f.checker.check('~/sandbox');assert.equal(f.requests.length,1);
  f.requests[0].resolve(repo);await Promise.resolve();await Promise.resolve();assert.deepEqual(f.results,[{status:'ok',info:repo}]);
  f.checker.dispose();
});
test('changing a path aborts and invalidates stale checks even if a transport ignores abort',async()=>{
  const f=checkerFixture();f.checker.check('old');f.checker.schedule('new');assert.equal(f.requests[0].signal.aborted,true);f.tick();
  f.requests[0].resolve({name:'old'});f.requests[1].resolve(repo);await Promise.resolve();await Promise.resolve();
  assert.deepEqual(f.results,[{status:'ok',info:repo}]);f.checker.dispose();
});
test('clearing a path cancels pending checks and never inspects an empty path',()=>{
  const f=checkerFixture();f.checker.schedule('repo');f.checker.schedule(' ');f.tick();assert.equal(f.requests.length,0);f.checker.dispose();
});
test('folder browsing preserves the clear home-boundary error without changing authentication handling',async()=>{
  const message='Faravan only shows folders inside your home folder (/home/sam).';
  const api=createApi('test',async()=>new Response(JSON.stringify({code:'outside_home',message}),{status:403}));
  await assert.rejects(api.get('folders?path=/'),e=>/Choose a folder inside your home folder/.test(e.message)&&!e.message.includes('/home/sam'));
});
test('the app API guard forwards cancellation to the real repo check',async()=>{
  const {guardApi}=await import('./api.mjs');
  const controller=new AbortController();let signal;
  await guardApi({post:async(_path,_body,next)=>{signal=next;}},()=>false).post('repo/inspect',{path:'~/x'},controller.signal);
  assert.equal(signal,controller.signal);
});
test('composer renders exact inline errors and tappable suggested projects beside Choose',async()=>{
  const {ComposeBody}=await import('./compose.jsx');
  const refusal={state:'compose.not-git',message:'/home/sam/code is a folder but not a git repository'};
  const vm=composeVM({repo:{status:'refused',refusal}});
  const html=renderFixture(ComposeBody,{vm,home:'/home/sam',draft:{prompt:'x',path:'/home/sam/code'},suggestions:[repo]});
  assert.match(html,/aria-haspopup="dialog"/);assert.match(html,/aria-invalid="true"/);
  assert.match(renderedText(html),/Projects inside this folder:/);
  assert.match(html,/data-picker-row/);
  assert.match(renderedText(html),/sandbox.*main/);
});
test('plain folder keeps send-as-files recovery and shows nested project suggestions',async()=>{
  const {ComposeBody}=await import('./compose.jsx');
  const info={kind:'folder',path:'/home/sam/code',name:'code',suggestions:[repo]};
  const vm=composeVM({prompt:'x',sourceKind:'folder',repo:{status:'ok',info},circle:{id:'c1',state:{networked:true}}});
  const html=renderFixture(ComposeBody,{vm,home:'/home/sam',project:info,draft:{prompt:'x',path:info.path},suggestions:info.suggestions});
  assert.equal(vm.plainFolder,true);
  assert.match(renderedText(html),/You can send this folder as files/);
  assert.match(renderedText(html),/Projects inside this folder:/);
  assert.match(html,/data-picker-row/);
  assert.match(renderedText(html),/sandbox.*main/);
});
test('suggestions cannot change a frozen uncertain send',async()=>{
  const {ComposeBody}=await import('./compose.jsx');
  const vm=composeVM({submission:'uncertain',repo:{status:'refused',refusal:{state:'compose.not-git'}}});
  const html=renderFixture(ComposeBody,{vm,home:'/home/sam',draft:{prompt:'x',path:'/home/sam/code'},suggestions:[repo]});
  assert.match(withoutMaskMarkers(html),/<button[^>]*class="project-row"[^>]*disabled/);
});
test('an unchanged refused path is checked again after the folder is repaired',async()=>{
  const f=checkerFixture();f.checker.check('~/sandbox');
  f.requests[0].resolve({refusal:{state:'compose.no-commits',message:'Make a first commit.'}});await Promise.resolve();await Promise.resolve();
  f.checker.check('~/sandbox');assert.equal(f.requests.length,2,'Enter must retry after making the requested first commit');
  f.requests[1].resolve(repo);await Promise.resolve();await Promise.resolve();assert.equal(f.results.at(-1).status,'ok');f.checker.dispose();
});
test('an explicit recheck refreshes a successful project after external file changes',async()=>{
  const f=checkerFixture();f.checker.check('~/sandbox');f.requests[0].resolve(repo);await Promise.resolve();await Promise.resolve();
  f.checker.check('~/sandbox');assert.equal(f.requests.length,2,'blur must refresh git state for the same path');
  f.requests[1].resolve({...repo,changed_count:1});await Promise.resolve();await Promise.resolve();assert.equal(f.results.at(-1).info.changed_count,1);f.checker.dispose();
});

test('picker lists each project once, removes Git badges, and can select the current plain folder',()=>{
 const props={data:{recent:[repo],repos:[repo,{...repo,path:'/home/sam/other/sandbox'}]},browse:{path:'/home/sam',home:'/home/sam',folders:[{...repo,is_git:true}]},onChoose(){},onBrowse(){},onQuery(){},onClose(){}};
 const out=renderFixture(ProjectPickerBody,props);
 assert.equal((out.match(/~\/code\/sandbox/g)||[]).length,1);
 assert.doesNotMatch(out,/>Git</);assert.match(out,/Choose this folder/);
 assert.match(out,/~\/other\/sandbox/);
});

test('suggested plain folders browse from Recent and discovery',async t=>{
 const {h}=await import('preact');
 const {mount,click,resetPage,teardown}=await import('./mounted.test-helper.mjs');
 t.after(teardown);resetPage();const browsed=[];
 const view=await mount(h(ProjectPickerBody,{data:{recent:[{name:'recent folder',path:'/home/sam/recent',is_git:false}],repos:[{name:'found folder',path:'/home/sam/found',is_git:false}]},browse:{home:'/home/sam',path:'/home/sam',folders:[]},onBrowse:path=>browsed.push(path),onChoose:()=>assert.fail('plain folder must browse'),onQuery(){},onClose(){}}));
 for(const row of view.$$('[data-picker-row]'))await click(row);
 assert.deepEqual(browsed,['/home/sam/recent','/home/sam/found']);
});
test('stale history cannot suppress a usable discovery or Browse row',()=>{
 for(const discovered of [false,true]){
  const out=renderFixture(ProjectPickerBody,{data:{recent:[{...repo,stale:true}],repos:discovered?[{...repo,is_git:true}]:[]},browse:{home:'/home/sam',path:'/home/sam',folders:[{...repo,is_git:true}]},onBrowse(){},onChoose(){},onQuery(){},onClose(){}});
  assert.equal((out.match(/data-picker-row/g)||[]).length,1,'one usable copy survives stale history');
 }
});
