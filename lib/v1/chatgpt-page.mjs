import {escapeHtml} from './chatgpt-oauth.mjs';
import {REVIEW_HIDDEN_CHARS} from './chatgpt-policy.mjs';

const visible=value=>String(value).replace(new RegExp(REVIEW_HIDDEN_CHARS.source,'gu'),char=>'\\u{'+char.codePointAt(0).toString(16)+'}');
const e=value=>escapeHtml(visible(value));
const when=ms=>Number.isFinite(ms)?'<time datetime="'+new Date(ms).toISOString()+'">'+e(new Date(ms).toLocaleString())+'</time>':'unknown';
const pretty=value=>{const text=typeof value==='string'?value:JSON.stringify(value??null,null,2);return (REVIEW_HIDDEN_CHARS.test(text)?'<p class="warn">Hidden formatting characters are shown as Unicode escapes below.</p>':'')+'<pre>'+e(text)+'</pre>';};
const present=value=>typeof value==='string'?value.trim()!=='':value!==undefined&&value!==null;
const SENSITIVE=/key|signature|secret|token|link|password|credential|private|public|limits$/;
const sensitive=name=>{const k=String(name).replace(/[^a-z0-9]/gi,'').toLowerCase();return SENSITIVE.test(k)||k==='id'||k.endsWith('id');};
const human=name=>{
  if(name==='verdict')return 'Assessment';
  const t=String(name).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase()+t.slice(1);
};
// Short values stay inline; prompts and file text get a block so line breaks survive.
const block=value=>'<pre class="sk-text">'+e(value)+'</pre>';
const code=value=>{const raw=String(value),flat=raw.replace(/[^a-z0-9]/gi,'').toUpperCase();return flat.length===8?flat.slice(0,4)+'-'+flat.slice(4):raw;};
const nameOf=value=>{
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object')return '';
  return value.ownerName??value.owner_name??value.name??value.deviceName??value.device_name??'';
};
// A member is shown as the person and the computer. Keys, signatures and limits are never read.
function person(m) {
  if(typeof m==='string')return m.trim()?e(m):'<em>Unnamed computer</em>';
  const owner=m?.ownerName??m?.owner_name??m?.owner??(m?.deviceName||m?.device_name||m?.computer?m?.localName??m?.name:null),computer=m?.deviceName??m?.device_name??m?.computer??m?.localName??m?.name;
  const parts=[present(owner)?'<strong>'+e(owner)+'</strong>':'',present(computer)&&computer!==owner?e(computer):''].filter(Boolean);
  return parts.length?parts.join(' · '):'<em>Unnamed computer</em>';
}
function people(list) {
  const items=Array.isArray(list)?list:[],shown=items.slice(0,50);
  return items.length?'<ul class="sk-list">'+shown.map(m=>'<li>'+person(m)+'</li>').join('')+(items.length>shown.length?'<li>and '+(items.length-shown.length)+' more</li>':'')+'</ul>':'<p class="sk-muted">No members are listed.</p>';
}
function scalar(value) {
  if(typeof value==='boolean')return value?'Yes':'No';
  return e(value);
}
function rows(object,depth=0) {
  const out=[];
  for(const [key,value] of Object.entries(object??{})) {
    if(sensitive(key)||!present(value))continue;
    let shown;
    if(Array.isArray(value)) {
      const flat=value.filter(v=>v===null||typeof v!=='object');
      shown=flat.length===value.length?e(flat.map(v=>typeof v==='boolean'?(v?'Yes':'No'):v).join(', ')):'<span class="sk-muted">'+value.length+' items</span>';
    }else if(typeof value==='object')shown=depth<2?rows(value,depth+1):'';
    else shown=scalar(value);
    if(shown)out.push('<dt>'+e(human(key))+'</dt><dd>'+shown+'</dd>');
  }
  return out.length?(depth?'<dl class="sk-kv sk-nested">':'<dl class="sk-kv">')+out.join('')+'</dl>':'';
}
// Debug view only: everything a person needs is already shown above it, so keys never need to appear.
const redact=(key,value)=>sensitive(key)||(typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value))?undefined:value;
const technical=value=>{
  const text=JSON.stringify(value??null,redact,2);
  return '<details><summary>Technical details (for debugging)</summary>'+pretty(text)+'</details>';
};
const notChatgpt='<p class="warn"><strong>This is not ChatGPT.</strong> Its callback is not ChatGPT\'s address. Deny unless you set up this client yourself.</p>';
const BUCKETS={_local:'this computer',_unapproved:'clients not yet approved',_legacy:'older entries'};
const ERRORS={start_failed:'Could not verify the ChatGPT address. Run faravan connect chatgpt in a terminal to review the exposure.',
  approval_required:'Review and approve an exposure in a terminal with faravan connect chatgpt.',
  cleanup_pending:'ChatGPT access is closed here. Run faravan connect chatgpt --stop to review remaining cleanup.'};

const MATCH_HELP='<p class="sk-match-help">Compare this code only with the authorize tab in your own ChatGPT browser. Allow only if that tab shows this same code. A code copied from a list on this computer is not proof.</p>';
const matchBlock=value=>present(value)?'<div class="sk-match"><span class="sk-label">Matching code</span><strong class="sk-code">'+e(code(value))+'</strong></div>':'';

function consentView(request,consent) {
  const act=consent.scope.split(' ').includes('act');
  return `<h1>${consent.is_chatgpt?'Allow ChatGPT to use Faravan on this computer?':'Allow this client to use Faravan on this computer?'}</h1>
    <p>Only approve if you just selected <strong>Connect</strong> here and then started connecting Faravan in your own ChatGPT account.
    Do not approve a request someone else sent you.</p>
    ${consent.is_chatgpt?'':notChatgpt}
    ${present(consent.matching_code)?'<section class="sk-card">'+matchBlock(consent.matching_code)+MATCH_HELP+'</section>':''}
    <dl><dt>Name (supplied by the client)</dt><dd><strong>${e(consent.client)}</strong>. A name does not prove who published the client.</dd>
    <dt>Returns to</dt><dd><code>${e(consent.redirect_host)}</code> (<code>${e(consent.redirect_uri)}</code>)</dd>
    <dt>Client registered</dt><dd>${when(consent.registered_at)}</dd>
    <dt>Requested</dt><dd>${when(consent.requested_at)}</dd>
    <dt>Requested permissions</dt><dd><strong>${e(consent.scope)}</strong></dd></dl>
    <h2>What read access shares with the client</h2>
    <ul><li>Your name and this computer's name.</li>
    <li>The names of people in your circles.</li>
    <li>Invitation previews: the circle name, host, owner, known member names, expiry and network warning.</li>
    <li>Membership checks for saved joins: pending, approved, expired, rejected or unknown.</li>
    <li>Circle presence: which computers are lending, resting or offline.</li>
    <li>Agents and models that circle lenders offer.</li>
    <li>Job prompts, including prompts from other people for jobs this computer ran or was asked to run.</li>
    <li>Job status, changes and saved results.</li>
    <li>Repository information (paths, branches, changed file names) only inside the folders you allowed.</li>
    <li>Job transcripts only after you approve each request here.</li></ul>
    <h2>What actions mean</h2>
    <p>With actions, the client can only <em>request</em> a change. Every write is queued until you select Allow on this computer.
    A confirmation in ChatGPT does not count. Before you allow, Faravan shows the exact prompt, code and recipients here.
    Applying changes or previewing an apply also needs local approval, because Git can store objects during a preview.</p>
    <form method="post" action="/api/chatgpt/consent"><input type="hidden" name="request" value="${e(request)}">
    <button class="btn btn-primary" name="scope" value="read">Allow read-only</button>
    ${act?'<button class="btn btn-secondary" name="scope" value="read act">Allow read and request actions</button>':''}
    <button class="btn btn-danger" name="allow" value="no">Deny</button></form>`;
}

// The exact source a job would send: one block per file, so a person can read each one.
function codeView(code) {
  if(!code||typeof code!=='object')return '';
  const repo=code.repo?.original_path?'<p>From <code>'+e(code.repo.original_path)+'</code></p>':'';
  const git=code.git?'<dl class="sk-kv"><dt>Repository</dt><dd><code>'+e(code.git.url)+'</code></dd><dt>Commit</dt><dd><code>'+e(code.git.commit)+'</code></dd></dl>':'';
  const files=Array.isArray(code.files)?code.files:[];
  return '<h2>Code that would be sent'+(code.type?' ('+e(code.type)+')':'')+'</h2>'+repo+git+
    (files.length?'<p>'+files.length+(files.length===1?' file':' files')+'.</p>':'')+
    files.map(f=>'<h3><code>'+e(f?.path)+'</code></h3><p>'+e(f?.bytes)+' bytes, sha256 <code>'+e(f?.sha256)+'</code></p>'+
      (f?.hidden_characters?'<p class="warn">This file contains hidden or invisible characters. Read it carefully.</p>':'')+
      (f?.binary||f?.text_omitted||f?.text===undefined?'<p>Text not shown. Check the file on this computer against this hash.</p>':pretty(f?.text??''))).join('');
}

// Details fields that have their own readable section; the rest become key/value rows.
const HANDLED=new Set(['operation','input','code','recipient_circle','recipient_members','join_preview','job_to_run','delivery','prompt','title']);

function joinView(preview) {
  if(!preview||typeof preview!=='object')return '';
  const owner=preview.ownerName??preview.owner_name;
  return '<h2>The circle you would join</h2><dl class="sk-kv"><dt>Circle</dt><dd><strong>'+e(preview.name??'Unnamed circle')+'</strong></dd>'+
    (present(preview.origin)?'<dt>Hosted at</dt><dd><code>'+e(preview.origin)+'</code></dd>':'')+
    (present(owner)?'<dt>Invited by</dt><dd>'+e(owner)+'</dd>':'')+'</dl>'+
    '<h3>Members already known on this computer</h3>'+(Array.isArray(preview.members)&&preview.members.length?people(preview.members):'')+
    (preview.membersComplete===true?'':'<p class="warn">Other members of this circle aren\'t shown until you join.</p>');
}

function jobCard(job) {
  if(!job||typeof job!=='object')return '';
  const who=job.localName??job.requesterName??job.requester??job.requested_by??job.from??job.owner;
  const requester=typeof who==='string'&&/^sha256:/.test(who)?'Unnamed requester':nameOf(who);
  const title=job.title??job.job?.title;
  return '<h2>Job to run</h2><section class="sk-card">'+(present(title)?'<h3>'+e(title)+'</h3>':'')+
    (present(requester)?'<p class="sk-muted">Requested by <strong>'+e(requester)+'</strong></p>':'')+
    (present(job.prompt)?block(job.prompt):'')+rows({computer:job.requesterName,agent:job.harness,maximumRuntime:present(job.runtimeSeconds)?job.runtimeSeconds+' seconds':undefined,network:job.network,startsNow:job.startsNow})+'</section>';
}

function modeSentence(mode,circle) {
  const name='<strong>'+e(circle)+'</strong>';
  if(mode==='auto')return 'Run jobs from '+name+' without asking each time.';
  if(['ask','manual','confirm'].includes(mode))return 'Ask you before running each job from '+name+'.';
  return '';
}

function actionView(action) {
  // The gateway manager reports a waiting action as status 'waiting'.
  const pending=['waiting','pending'].includes(action.status),id=encodeURIComponent(action.id);
  const d=action.details&&typeof action.details==='object'?action.details:{},input=d.input&&typeof d.input==='object'?d.input:{};
  const circle=d.recipient_circle?.name,prompt=input.prompt??d.prompt,title=input.title??d.title;
  const mode=modeSentence(input.mode,circle??'this circle');
  const rest={...Object.fromEntries(Object.entries(d).filter(([k])=>!HANDLED.has(k))),
    ...Object.fromEntries(Object.entries(input).filter(([k])=>!['prompt','title','circle','mode','link','repo'].includes(k)))};
  if(input.repo&&!d.code)rest.repository=typeof input.repo==='object'?input.repo.path:input.repo;
  if(present(input.mode)&&!mode)rest.mode=input.mode;
  const hidden=REVIEW_HIDDEN_CHARS.test(JSON.stringify([action.label,action.what,d]));
  const kv=rows(rest);
  return `<h1>Allow ChatGPT to ${e(action.label)}?</h1>
    <p>${pending?'ChatGPT asked for this. Nothing happens until you allow it here.':'This request is no longer waiting for approval. Its status is shown below.'}</p>
    ${hidden?'<p class="warn">Hidden formatting characters are shown as Unicode escapes below.</p>':''}
    <h2>Effect</h2><p><strong>${e(action.what)}</strong></p>
    ${mode?'<p>'+mode+'</p>':''}
    ${circle?'<h2>Circle</h2><p><strong>'+e(circle)+'</strong>'+(present(d.recipient_circle?.origin)?' · <code>'+e(d.recipient_circle.origin)+'</code>':'')+'</p>':''}
    ${present(title)?'<h2>Title</h2><p>'+e(title)+'</p>':''}
    ${present(prompt)?'<h2>Prompt</h2>'+block(prompt):''}
    ${!d.join_preview&&Array.isArray(d.recipient_members)?'<h2>Who may receive it</h2>'+people(d.recipient_members)+(present(d.delivery)?'<p class="sk-muted">'+e(d.delivery)+'</p>':''):''}
    ${joinView(d.join_preview)}
    ${'job_to_run' in d&&!d.job_to_run?'<p class="warn"><strong>Faravan can not find that job.</strong> No job is waiting under this request. Decline unless you expect one.</p>':jobCard(d.job_to_run)}
    ${codeView(d.code)}
    ${kv?'<h2>Other details</h2>'+kv:''}
    ${Number.isFinite(action.expiresAt)&&pending?'<p>Expires at '+when(action.expiresAt)+'.</p>':''}
    ${pending?`<form method="post" action="/api/chatgpt/actions/${id}/approve"><button class="btn btn-primary">Allow ChatGPT to ${e(action.label)}</button></form>
    <form method="post" action="/api/chatgpt/actions/${id}/decline"><button class="btn btn-secondary">Decline</button></form>`:
    '<p>Status: <strong>'+e(action.status)+'</strong>.</p>'}
    ${action.localResult!==undefined?'<h2>Result</h2><p>Shown only on this computer. ChatGPT does not receive secrets such as invitation links.</p>'+pretty(action.localResult):''}
    <p><a href="/connect/chatgpt">Back to ChatGPT connections</a></p>
    ${technical(action.details)}`;
}

function overview({status,requests,actions,error}) {
  const connections=status?.connections??[],groups=new Map();
  if(!requests.length&&Array.isArray(status?.pending_requests))requests=status.pending_requests;
  for(const a of status?.audit??[]) {
    const key=a.client_id??'';
    if(!groups.has(key))groups.set(key,{client:a.client,entries:[]});
    groups.get(key).entries.push(a);
  }
  // Clearing works per audit bucket. Without bucket data, each identified client is its own bucket.
  const clearable=(status?.audit_buckets??[...groups].filter(([key])=>key).map(([client_id,g])=>({client_id,client:g.client,entries:g.entries.length})))
    .filter(b=>b.entries>0||b.full||b.read_calls>0).map(b=>({...b,name:b.client??BUCKETS[b.client_id]??'a client'}));
  return `<h1>ChatGPT</h1>${ERRORS[error]?'<p class="warn">'+e(ERRORS[error])+'</p>':''}
    <p>${status?.url?'MCP URL: <code>'+e(status.url)+'</code>':'ChatGPT access is not published.'}</p>
    <form method="post" action="/api/chatgpt/start"><button class="btn btn-primary">Connect</button></form>
    <p>Select <strong>Connect</strong> just before you add Faravan in ChatGPT. New connection requests are accepted for 10 minutes afterwards.</p>
    ${actions.length?'<h2>ChatGPT is waiting for you</h2><ul>'+actions.map(a=>'<li>Allow ChatGPT to '+e(a.label)+'? '+e(a.what)+
      ' <a href="/connect/chatgpt?action='+encodeURIComponent(a.id)+'">Review</a></li>').join('')+'</ul>':''}
    ${requests.length?'<h2>Connection requests</h2>'+(requests.length>1?'<p class="warn">More than one request is waiting. Match each code only with the one in your own ChatGPT authorize tab. A code copied from this list is not proof. Deny any you do not recognize.</p>':'')+
      '<ul>'+requests.map(r=>'<li><strong>'+e(r.client)+'</strong> returns to <code>'+e(r.redirect_host)+'</code>'+
      (r.is_chatgpt?'':' (not ChatGPT)')+(present(r.matching_code)?' · code <strong class="sk-code">'+e(code(r.matching_code))+'</strong>':'')+
      ' <a href="/connect/chatgpt?request='+encodeURIComponent(r.id)+'">Review</a></li>').join('')+'</ul>':''}
    <h2>Connections</h2>
    ${connections.length?'<ul>'+connections.map(c=>'<li><strong>'+e(c.client??'Unnamed client')+'</strong> has access to '+e(c.scope)+
      ', returns to <code>'+e(c.redirect_host??'unknown')+'</code>'+(c.is_chatgpt?'':' (not ChatGPT)')+', registered '+when(c.registered_at)+
      '<form method="post" action="/api/chatgpt/connections/'+encodeURIComponent(c.id)+'/revoke"><button class="btn btn-secondary btn-sm">Revoke</button></form></li>').join('')+'</ul>':
      '<p>No client is connected. New connections always need your approval here.</p>'}
    <form method="post" action="/api/chatgpt/disconnect"><button class="btn btn-danger">Disconnect ChatGPT</button></form>
    <h2>Activity</h2>
    ${groups.size?[...groups.values()].map(g=>'<h3>'+e(g.client??'This computer')+'</h3><ul>'+g.entries.map(a=>'<li>'+e(a.outcome)+' '+e(a.op)+
      (a.effect?'; effect: '+e(a.effect):'')+(a.count>1?' ('+e(a.count)+' calls)':'')+' at '+when(a.at)+'</li>').join('')+'</ul>').join(''):'<p>No remote calls yet.</p>'}
    ${clearable.map(b=>(b.full?'<p class="warn">The activity log for '+e(b.name)+' is full. It cannot make new requests until you clear it.</p>':'')+
      '<form method="post" action="/api/chatgpt/audit/clear"><input type="hidden" name="client" value="'+e(b.client_id)+'"><button class="btn btn-secondary">Clear activity for '+e(b.name)+'</button></form>').join('')}
    ${groups.size?'<form method="post" action="/api/chatgpt/audit/clear"><button class="btn btn-secondary">Clear all activity</button></form>':''}
    <p>Activity stays on this computer until you clear it here. ChatGPT cannot clear it.</p>`;
}

// Scoped to this page. The shared look (type, buttons, colours) comes from /app.css tokens; none of it is redefined here.
export const CHATGPT_PAGE_CSS=`.sk-page{max-width:760px;margin:0 auto;padding:var(--s-8) var(--s-5) var(--s-14);display:grid;gap:var(--s-3)}
.sk-page h1{font:600 var(--text-title1)/var(--lh-title1) var(--font-sans);letter-spacing:-.01em}
.sk-page h2{font:600 var(--text-title3)/var(--lh-title3) var(--font-sans);margin-top:var(--s-4)}
.sk-page h3{font:600 var(--text-body)/var(--lh-body) var(--font-sans)}
.sk-page dt{font-weight:600}.sk-page dd{margin:0 0 var(--s-2)}
.sk-page li{margin:var(--s-2) 0}.sk-page form{display:inline}.sk-page .btn{margin:var(--s-1) var(--s-2) var(--s-1) 0}
.sk-page code,.sk-page pre{overflow-wrap:anywhere;white-space:pre-wrap}
.sk-page pre{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-sm);padding:var(--s-3)}
.sk-page .warn{background:var(--bad-soft);color:var(--bad-text);border:1px solid var(--bad);border-radius:var(--r-xs);padding:var(--s-2) var(--s-3)}
.sk-page a{color:var(--text);text-decoration:underline}
.sk-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-1);padding:var(--s-4)}
.sk-muted{color:var(--text-2);font-size:var(--text-sm)}
.sk-list{padding-left:var(--s-5);margin:0}
.sk-kv{margin:0}.sk-nested{margin-left:var(--s-4)}
.sk-label{display:block;color:var(--text-2);font-size:var(--text-sm)}
.sk-code{font:600 var(--text-title2)/var(--lh-title2) var(--font-mono);letter-spacing:.08em}
.sk-match-help{margin-top:var(--s-2)}
.sk-page details{margin-top:var(--s-6);color:var(--text-2)}.sk-page summary{cursor:pointer}
.sk-top{display:block;padding:var(--s-4) var(--s-5) 0;max-width:760px;margin:0 auto}`;

/** Owner-only page. No OAuth approval or local session credential is present in its URL. */
export function chatgptPage({status,request,consent,requests=[],actions=[],action,error}) {
  const content=action?actionView(action):consent?consentView(request,consent):overview({status,requests,actions,error});
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest"><title>ChatGPT · Faravan</title>
    <link rel="stylesheet" href="/app.css"><style>${CHATGPT_PAGE_CSS}</style>
    <a class="sk-top" href="/">Faravan</a><main class="sk-page">${content}</main></html>`;
}
