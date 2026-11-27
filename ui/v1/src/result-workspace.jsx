import {errorMessage} from './helpers.mjs';
import {useEffect,useRef,useState} from 'preact/hooks';
import {Button, Card, Icon} from './ds/index.mjs';
import {changeSummary} from './helpers.mjs';
import {jobDiffVM} from './view-models.mjs';
import {reviewFiles,reviewKey,reviewCoverage,readReview,writeReview,reviewNotePrompt,splitRows,syntaxParts} from './result-review.mjs';

export function ResultWorkspace({data,outputWarning='',circle='',resultDigest='',onAskChanges,renderImage,showDetails=true}) {
  const files=reviewFiles(data), vm=jobDiffVM(data);
  const [collapsed,setCollapsed]=useState({}),[copyStatus,setCopyStatus]=useState(''),[fileQuery,setFileQuery]=useState('');
  const [reviews,setReviews]=useState({}), [editing,setEditing]=useState(null), [note,setNote]=useState('');
  const noteEditor=useRef(null), noteOpener=useRef(null), noteWasOpen=useRef(false), notePath=useRef(''), noteOpenerLabel=useRef('');
  const [wrap,setWrap]=useState(true), [split,setSplit]=useState(false), [hideSpace,setHideSpace]=useState(false), [saveError,setSaveError]=useState('');
  const [preparing,setPreparing]=useState(false),[actionError,setActionError]=useState('');
  let storage;try {storage=globalThis.localStorage;}catch {}
  const key=file=>reviewKey(circle,resultDigest||data.result_digest||data.digest||'',file);
  const state=file=>reviews[key(file)]??readReview(storage,key(file));
  function save(file,value) {
    setReviews(previous=>({...previous,[key(file)]:value}));
    if(!writeReview(storage,key(file),value))setSaveError('Review marks are kept for this visit. Browser storage is unavailable.');
  }
  const notes=files.flatMap(file=>state(file).notes.map(row=>({...row,path:file.path})));
  const groups=[...new Set(files.map(file=>file.directory))];
  const viewed=files.filter(file=>state(file).viewed).length;
  useEffect(()=>{
    if(editing){noteWasOpen.current=true;noteEditor.current?.focus();return;}
    if(!noteWasOpen.current)return;
    noteWasOpen.current=false;
    if(noteOpener.current?.isConnected&&noteOpener.current.getAttribute('aria-label')===noteOpenerLabel.current)noteOpener.current.focus();
    else document.querySelector('#diff-file-'+files.findIndex(file=>file.path===notePath.current)+' .review-collapse')?.focus();
    noteOpener.current=null;noteOpenerLabel.current='';
  },[editing]);
  function addNote(e,file) {
    e.preventDefault();if(!note.trim())return;
    if(state(file).notes.length>=50){setSaveError('This file already has 50 notes. Remove a note before adding another.');return;}
    save(file,{...state(file),notes:[...state(file).notes,{side:editing.side,line:editing.line,text:note.trim().slice(0,2000)}].slice(0,50)});
    setNote('');setEditing(null);
  }
  async function askChanges() {
    if(preparing)return;setPreparing(true);setActionError('');
    try {await onAskChanges(reviewNotePrompt(notes));}catch(error){setActionError(errorMessage(error));}finally{setPreparing(false);}
  }
  function openNote(file,side,number,opener) {noteOpener.current=opener;noteOpenerLabel.current=opener?.getAttribute('aria-label')||'';notePath.current=file.path;setEditing({path:file.path,side,line:number});setNote('');}
  function lineIdentity(file,line) {
    if(!line)return file.path+', empty diff line';
    if(line.kind==='meta')return file.path+', '+line.text;
    const numbers=[line.old&&'old line '+line.old,line.next&&'new line '+line.next].filter(Boolean).join(', ');
    return (file.path+', '+(numbers||'diff line')+' '+({add:'added',del:'removed',context:'context'}[line.kind]||'')).trim();
  }
  function lineKeys(event) {
    const row=event.currentTarget, targets=[...row.querySelectorAll('button.review-line-number,button.review-line-note')].filter(button=>getComputedStyle(button).display!=='none');
    if(event.key==='ArrowLeft'||event.key==='ArrowRight') {
      event.preventDefault();
      const side=event.key==='ArrowLeft'?'old':'new', sideTarget=targets.find(button=>button.dataset.noteSide===side);
      if(sideTarget){sideTarget.focus();return;}
      const pane=row.closest('.review-split-pane');
      if(pane){
        const panes=[...pane.parentElement.querySelectorAll('.review-split-pane')],other=panes.find(item=>item!==pane),rows=[...pane.querySelectorAll('[data-diff-line]')],otherRows=other&&[...other.querySelectorAll('[data-diff-line]')];
        otherRows?.[rows.indexOf(row)]?.focus();return;
      }
      (event.key==='ArrowLeft'?targets.at(-1):targets[0])?.focus();return;
    }
    if(event.key==='ArrowUp'||event.key==='ArrowDown') {
      event.preventDefault();
      const container=row.closest('.review-unified-lines,.review-split-lines,.review-split-pane'), rows=[...container.querySelectorAll('[data-diff-line]')].filter(item=>getComputedStyle(item).display!=='none');
      rows[rows.indexOf(row)+(event.key==='ArrowDown'?1:-1)]?.focus();return;
    }
    if((event.key==='Enter'||event.key===' ')&&event.target===row&&targets.length) {event.preventDefault();targets[0].click();}
  }
  function lineNumber(file,side,number) {
    if(number&&onAskChanges)return <button class="line-number review-line-number ph-no-capture" type="button" tabIndex="-1" data-note-side={side} aria-label={'Add note on '+file.path+' '+side+' line '+number} onClick={event=>openNote(file,side,number,event.currentTarget)} data-telemetry-private="result-workspace">{number}</button>;
    return <span class="line-number ph-no-capture" data-telemetry-private="result-workspace">{number?<><span class="sr">{side==='old'?'Old line ':'New line '}</span>{number}</>:null}</span>;
  }
  function lineButton(file,line) {
    const number=line.next||line.old;if(!number||!onAskChanges)return null;
    return <button class="review-line-note ph-no-capture" type="button" tabIndex="-1" data-note-side={line.next?'new':'old'} aria-label={'Add note shortcut on '+file.path+' '+(line.next?'new':'old')+' line '+number} onClick={event=>openNote(file,line.next?'new':'old',number,event.currentTarget)} data-telemetry-private="result-workspace"><Icon name="plus" size="sm" /></button>;
  }
  async function copyPath(file) {
    try {await navigator.clipboard.writeText(file.path);setCopyStatus('Copied '+file.path);}
    catch {setCopyStatus('Could not copy '+file.path+'. Select the path in the header to copy it.');}
  }
  function splitCell(file,line,side) {
    return <div class={('review-split-cell diff-'+(line?.kind||'empty')) + ' ph-no-capture'} data-telemetry-private="result-workspace">{lineNumber(file,side,line?(side==='old'?line.old:line.next):'')}<code>{syntaxParts(line?.text||' ',file.path).map(part=>part.kind?<span class={'syntax-'+part.kind}>{part.text}</span>:part.text)}</code>{line&&lineButton(file,{...line,...(side==='old'?{next:''}:{old:''})})}</div>;
  }
  return <section class="stack-4 result-workspace ph-no-capture" aria-label="Changes" data-telemetry-private="result-workspace">
    <div class="review-heading"><div><h2 class="t-title2">Changes</h2><p class="t-sm t-2">{changeSummary(data.diffstat)}</p></div><span class="t-sm t-2 review-progress">{viewed} of {files.length} viewed</span></div>
    {data.blocked?.length>0&&<p class="banner bad" role="alert">Faravan didn’t add these changes: they write outside the project or create links. Nothing was added.</p>}
    {outputWarning&&<p class="banner warn" role="status">{outputWarning}</p>}
    {!files.length&&!outputWarning&&!data.blocked?.length&&<p>The agent made no changes.</p>}
    {files.length>0&&<div class="review-toolbar"><p class="t-xs t-2">{vm.truncated&&reviewCoverage(data)}{vm.truncated&&' Download the patch for the complete diff.'}</p><div class="review-options"><label class="t-xs"><input type="checkbox" checked={wrap} onChange={e=>setWrap(e.currentTarget.checked)} />Soft wrap</label><label class="t-xs"><input type="checkbox" checked={hideSpace} onChange={e=>setHideSpace(e.currentTarget.checked)} />Hide whitespace-only lines</label><Button size="sm" kind="secondary" class="review-split-toggle" aria-pressed={split} onClick={()=>setSplit(!split)}>{split?'Unified view':'Split view'}</Button></div></div>}
    {hideSpace&&<p class="t-xs t-2" role="status">Whitespace-only added and removed lines are hidden. Review counts still include them.</p>}
    {copyStatus&&<p class="t-xs t-2" role="status">{copyStatus}</p>}
    {saveError&&<p class="t-xs t-2" role="status">{saveError}</p>}
    <div class={'review-layout'+(files.length>1?' has-tree':'')}>
      {files.length>1&&<nav class="review-tree" aria-label="Changed files"><label class="review-tree-filter"><span class="sr">Filter changed files</span><input class="input" type="search" placeholder="Filter files" value={fileQuery} onInput={e=>setFileQuery(e.currentTarget.value)} /></label>{groups.filter(group=>files.some(file=>file.directory===group&&file.path.toLowerCase().includes(fileQuery.toLowerCase()))).map(group=><div key={group} class="review-group"><h3 class="t-xs t-2">{group}</h3><ul>{files.filter(file=>file.directory===group&&file.path.toLowerCase().includes(fileQuery.toLowerCase())).map(file=><li key={file.path}><button type="button" onClick={()=>{const panel=document.getElementById('diff-file-'+files.indexOf(file));setCollapsed(previous=>({...previous,[file.path]:false}));panel?.scrollIntoView({block:'start'});panel?.focus({preventScroll:true});}}><span class={'review-tree-mark'+(state(file).viewed?' is-viewed':'')}>{state(file).viewed?<Icon name="check" size="sm" />:<Icon name="file" size="sm" />}</span><span class="review-tree-name" title={file.path}>{file.path.slice(file.path.lastIndexOf('/')+1)}</span><span class="sr">{state(file).viewed?'Viewed':'Not viewed'}</span><span class="t-xs t-2">{file.status==='added'?'A':file.status==='deleted'?'D':file.status==='renamed'?'R':'M'}</span></button></li>)}</ul></div>)}</nav>}
      <div class="review-diffs stack-4">
        {files.map((file,i)=>{
          const review=state(file),rows=file.rows.filter(line=>!hideSpace||!['add','del'].includes(line.kind)||line.text.slice(1).trim());
          const isCollapsed=collapsed[file.path]??file.generated;
          const header=<><button class="review-collapse" type="button" aria-label={(isCollapsed?'Expand ':'Collapse ')+file.path} aria-expanded={!isCollapsed} aria-controls={'diff-content-'+i} onClick={()=>setCollapsed(previous=>({...previous,[file.path]:!isCollapsed}))}><Icon name={isCollapsed?'chev-r':'chev-d'} size="sm"/></button><code>{file.path.includes('/')?file.path.split(/(?<=\/)/).map((part,index)=><span key={index}>{part}<wbr/></span>):file.path}</code>{file.status==='added'&&<span class="t-xs t-2 review-file-status">New file</span>}{file.status==='deleted'&&<span class="t-xs t-2 review-file-status">Deleted</span>}{file.status==='renamed'&&<span class="t-xs t-2 review-file-status">Renamed</span>}{file.generated&&<span class="t-xs t-2 review-file-status">Generated / lockfile</span>}<span class="diff-count"><span class="plus">+{file.plus}</span> <span class="minus">−{file.minus}</span></span><button class="review-copy" type="button" title="Copy path" aria-label={'Copy path for '+file.path} onClick={()=>copyPath(file)}><Icon name="copy" size="sm"/></button><label class="review-viewed t-xs"><input type="checkbox" checked={review.viewed} onChange={e=>save(file,{...review,viewed:e.currentTarget.checked})} /><span class="review-viewed-label">Viewed</span><span class="sr"> {file.path}</span></label></>;
          const content=<>
            {file.preview?renderImage?.(file):file.binary?<p class="card-pad t-sm t-2">Binary file. Download the patch to review it.</p>:rows.length?<div class={'diff-scroll'+(wrap?' review-wrap':'')+(split?' review-split':'')} tabIndex="0" role="region" aria-label={'Diff for '+file.path}><div class="diff-lines review-unified-lines">{rows.map((line,n)=><div key={n} class={'diff-row diff-'+line.kind} data-diff-line={line.kind==='meta'?undefined:true} tabIndex={line.kind==='meta'?-1:0} role="group" aria-label={lineIdentity(file,line)} onKeyDown={lineKeys}><span class="review-line-gutters">{lineNumber(file,'old',line.old)}{lineNumber(file,'new',line.next)}</span><code>{syntaxParts(line.text,file.path).map(part=>part.kind?<span class={"syntax-"+part.kind}>{part.text}</span>:part.text)}</code>{lineButton(file,line)}</div>)}</div>{split && <div class="review-split-lines"><div class="review-split-labels" aria-hidden="true"><span>Before</span><span>After</span></div>{wrap?splitRows(rows).map((pair,n)=><div class="review-split-pair" key={n} data-diff-line={pair.old?.kind==='meta'?undefined:true} tabIndex={pair.old?.kind==='meta'?-1:0} role="group" aria-label={[lineIdentity(file,pair.old),lineIdentity(file,pair.new)].filter(Boolean).join('; ')} onKeyDown={lineKeys}>{splitCell(file,pair.old,'old')}{splitCell(file,pair.new,'new')}</div>):<div class="review-split-panes">{['old','new'].map(side=><div key={side} class="review-split-pane" role="region" aria-label={(side==='old'?'Before':'After')+' diff for '+file.path}>{splitRows(rows).map((pair,n)=><div key={n} data-diff-line={pair[side]?.kind==='meta'?undefined:true} tabIndex={pair[side]?.kind==='meta'?-1:0} role="group" aria-label={lineIdentity(file,pair[side])} onKeyDown={lineKeys}>{splitCell(file,pair[side],side)}</div>)}</div>)}</div>}</div>}</div>:<p class="card-pad t-sm t-2">{file.rows.length?'Only whitespace changes in this view.':file.binary?'Binary content is not shown.':'No text lines in this preview. Download the patch to inspect metadata or omitted content.'}</p>}
            {review.notes.length>0&&<ul class="review-notes">{review.notes.map((row,n)=><li key={n}><div class="review-note-head"><b class="t-xs">{row.side==='new'?'New':'Old'} line {row.line}</b><Button kind="quiet" size="sm" onClick={()=>save(file,{...review,notes:review.notes.filter((_,index)=>index!==n)})} aria-label={'Remove note on '+file.path+' line '+row.line}>Remove</Button></div><p class="t-sm prewrap">{row.text}</p></li>)}</ul>}
            {editing?.path===file.path&&<form class="review-note-form stack-2" onSubmit={e=>addNote(e,file)}><label class="field">Note on {editing.side} line {editing.line}<textarea ref={noteEditor} class="input" value={note} maxLength="2000" rows="3" required onInput={e=>setNote(e.currentTarget.value)} /></label><p class="t-xs t-2">Private on this browser until you send a follow-up.</p><div class="pair"><Button type="submit" disabled={!note.trim()} disabledReason="Write a note first">Save note</Button><Button kind="quiet" onClick={()=>setEditing(null)}>Cancel</Button></div></form>}
          </>;
          return <Card class={'job-diff'+(file.generated?' review-generated':'')} key={file.path} id={'diff-file-'+i} tabIndex="-1"><div class="job-file-head">{header}</div><div id={'diff-content-'+i} hidden={isCollapsed}>{content}</div></Card>;
        })}
      </div>
    </div>
    {showDetails&&vm.details&&<details class="job-details"><summary>Details</summary><pre class="job-code">{vm.details}</pre></details>}
    {onAskChanges&&notes.length>0&&<div class="review-followup"><div><b class="t-sm">{notes.length} private {notes.length===1?'note':'notes'}</b><p class="t-xs t-2">Prepare a follow-up from this result. A lender must accept the new request.</p></div><Button disabled={preparing} disabledReason="Preparing your request…" onClick={askChanges}>{preparing?'Preparing…':'Ask for changes…'}</Button></div>}
    {actionError&&<p class="form-error" role="alert">{actionError}</p>}
  </section>;
}
