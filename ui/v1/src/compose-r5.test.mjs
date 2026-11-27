import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposeBody} from './compose.jsx';
import {RequestPage} from './request.jsx';
import {composeVM} from './view-models.mjs';
import {prepareFollowupDraft, followupBaseVM} from './job-thread.mjs';
import {loadDraft, draftBody} from './compose-draft.mjs';
import {homePath} from './project-picker-model.mjs';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';
const circle={id:'c',name:'Friends',state:{networked:true,host:{label:'Ana',reachable:true},lenders:[{label:'Ana'}]}};
const draft={id:'draft-r5-0001',prompt:'Fix parsing',path:'/home/sam/code/parser',sourceKind:'folder',agent:''};
const project={path:draft.path,name:'parser',branch:'main',head:'a'.repeat(40),files:4,changed:[],changed_count:0};
const render=(over={})=>renderFixture(ComposeBody,{draft,project,home:'/home/sam',circles:[circle],circle:'c',agents:[],vm:composeVM({prompt:draft.prompt,repo:{status:'ok',info:project},circle}),...over});
test('composer groups the selected folder under Project and its button opens the picker',()=>{
 const out=render();
 assert.equal((out.match(/>Choose…<\/button>/g)||[]).length,1);
 assert.doesNotMatch(out,/cmp-change-project/);
 assertDomOrder(out,['id="cmp-prompt"','id="cmp-project"','id="cmp-folder"','aria-label="Job choices"','aria-label="Circle"','aria-label="Agent"','id="cmp-verify"','>Send<']);
 assert.doesNotMatch(out,/<b>Model<|<b>Effort/);
 assert.match(out,/<summary>What you’re sending<\/summary>/);
 assert.match(renderedText(out),/including members who join later/);
 assert.match(renderedText(out),/AI provider/);
});
test('home paths are abbreviated in suggestions and follow-up metadata without changing submitted paths',()=>{
 assert.equal(homePath('/home/sam/code/parser','/home/sam'),'~/code/parser');
 assert.equal(homePath('/home/other/project','/home/sam'),'/home/other/project');
 assert.equal(homePath('/home/sam-other/project','/home/sam'),'/home/sam-other/project');
 assert.equal(homePath('/home/sam/code/parser'),'/home/sam/code/parser');
 const out=render({suggestions:[project],draft:{...draft,followup:{parentJob:'p',parentResult:'r'},base:{path:draft.path,title:'Fix parsing',branch:'main',commit:'a'.repeat(40)}}});
 assert.match(renderedText(out),/Continues: Fix parsing/);
 assert.match(renderedText(out),/Saved source folder: ~\/code\/parser/);
 assert.doesNotMatch(out,/\/home\/sam|Starts from this job|branch main/);
 assert.equal(draftBody(draft,'c').repo.path,'/home/sam/code/parser');
});
test('follow-up draft retains the immediate parent title through storage',()=>{
 const m=new Map(),storage={getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v)};
 prepareFollowupDraft(storage,'c',{parentJob:'p',parentResult:'r',base:{path:draft.path,branch:'main'},thread:[{job_digest:'p',title:'Fix parsing'}]});
 assert.equal(followupBaseVM(loadDraft(storage,'c').base).label,'Continues: Fix parsing');
});
const request=(source,extra={})=>renderFixture(RequestPage,{id:'r',circles:[{id:'c',name:'Friends'}],agents:[],members:[],lending:{},data:{devices:{name:'Laptop'},activity:[],approvals:[{id:'r',offer:true,jobDigest:'d',requesterName:'Sam',prompt:'Write a poem',harness:'codex',runtimeSeconds:600,network:'internet',source,expiresAt:Date.now()+60000,protection:{satisfied:true,enforced:[],unenforced:[]},job:{circle:'c'},...extra}]}});
test('a no-project offer describes a prompt and never a code download',()=>{
 const out=request({kind:'none'});
 assert.match(renderedText(out),/No project · prompt only/);
 assert.doesNotMatch(renderedText(out),/downloads.*code/);
});
test('request names the project, suppresses transport counts, and keeps protection detail behind a disclosure',()=>{
 const out=request({kind:'archive',size_bytes:385},{sourceManifest:{project_name:'parser',file_count:4,total_bytes:310,packed_bytes:385,not_sent:[]}});
 assert.match(renderedText(out),/parser/);
 assert.doesNotMatch(renderedText(out),/packed|0 files not sent/);
 assert.match(out,/<summary>Protection details<\/summary>/);
 assert.match(out,/class="rq-facts"[\s\S]*?<\/section>/);
 const visible=out.match(/class="rq-facts"([\s\S]*?)<\/section>/)?.[0]||'';
 assert.equal((visible.match(/class="fact /g)||[]).length,3);
 assert.match(renderedText(out),/Independent verification of these isolation controls is not available here/);
});

test('composer folder symbols, short commits and navigation remain consistent',()=>{
 const out=render({suggestions:[project]});
 assert.doesNotMatch(out,/<use href="#terminal"/);
 assert.match(out,/Commit <code>a{7}<\/code>\. Project history is not sent/);
 assert.doesNotMatch(out,/a{40}/);
 assert.match(out,/Back to jobs/);
 const follow=render({draft:{...draft,followup:{parentJob:'p',parentResult:'r'},base:{title:'Fix parsing',path:project.path}}});
 assert.match(renderedText(follow),/The circle and project stay the same/);
 assert.doesNotMatch(follow,/<code>~\/code\/parser<\/code>/);
});

test('final disclosure labels and no-project choice match their contents',()=>{
 const follow=render({draft:{...draft,followup:{parentJob:'p',parentResult:'r'},base:{title:'Fix parsing',path:project.path,commit:project.head}}});
 assertDomOrder(follow,['Saved source folder:','A follow-up is a new job','<summary>Commit</summary>']);
 const none=render({draft:{...draft,sourceKind:'none'}});
 const projectButton=none.match(/<button[^>]*aria-label="Project settings: No project"[\s\S]*?<\/button>/)?.[0]||'';
 assert.doesNotMatch(projectButton,/<svg/);
 assert.match(renderedText(follow),/Up to 20 minutes/);
});
