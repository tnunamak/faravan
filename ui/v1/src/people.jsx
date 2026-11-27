import {useState,useEffect,useLayoutEffect,useRef} from 'preact/hooks';
import {Avatar,Button,Card,Field,Icon} from './ds/index.mjs';
import {Action,enc,field,useResource} from './shared.jsx';
import {safeName,errorMessage} from './helpers.mjs';
import {ROLE_NAMES,peopleVM,peopleListVM,memberComputerRows,personJobs,personHref,parseCircleCode,computerAvailability,roleFormState,unblockMessage} from './people-view.mjs';
import {RequesterLimitsControl} from './lend.jsx';
import {LocalNameControl} from './local-name.jsx';
import {jobStateView,whenWords} from './view-models.mjs';

export function PeopleList({people,members,selfKey,circleId,availability,circle,now=Date.now()}) {
  const rows=peopleListVM(people,members,selfKey);
  return <ul class="list card ph-no-capture" aria-label="People in this circle" data-telemetry-private="people">{rows.map(person=>{
    const {visible,older}=memberComputerRows(person.computers,selfKey,now);
    const restricted=person.blocked || ['closed','archived'].includes(circle?.lifecycle);
    const renderComputer=({computer,name,self,lastSeen})=>{
      let status;
      if(restricted)status=computerAvailability(null,{blocked:person.blocked,lifecycle:circle?.lifecycle});
      else if(lastSeen!==undefined)status='Last seen '+whenWords(lastSeen,now);
      else {
        const observed=availability?.(computer);
        status=observed?.word ?? computerAvailability(observed,{now});
      }
      return <li key={computer.key_id} class="hstack-3"><Icon name="laptop"/><span class="grow t-sm">{name||'Unnamed computer'}{self?' · This computer':''}</span><span class="t-xs t-2">{status}</span></li>;
    };
    return <li key={person.personId} class="stack-3 people-row">
      <div class="hstack-3"><Avatar personName={person.avatarName} id={person.personId}/><div class="grow"><a class="t-title3" href={personHref(circleId,person.personId)}>{person.name}</a><p class="t-sm t-2">{person.roleName}</p></div>{person.blocked&&<span class="pill off">Blocked</span>}</div>
      {visible.length>0&&<ul class="list stack-2 people-computers" aria-label={'Computers for '+person.name}>{visible.map(renderComputer)}</ul>}
      {older.length>0&&<details class="people-computers t-sm"><summary>Older computers ({older.length})</summary><ul class="list stack-2">{older.map(renderComputer)}</ul></details>}
    </li>;
  })}</ul>;
}

function JobHistory({title,rows,circleId,assigned=false}) {
  return <section class="stack-3 ph-no-capture" data-telemetry-private="people"><h2>{title}</h2>{assigned&&<p class="t-sm t-2">Assignment does not mean the job started.</p>}{rows.length?<ul class="list card">{rows.map(job=><li key={job.job_digest} class="people-row"><a href={'#/job/'+enc(job.job_digest)+'/'+enc(circleId)}>{safeName(job.local?.title||job.title,'Untitled job')}</a><p class="t-sm t-2">{assigned?'Execution on their computers unknown':(jobStateView(job,{role:['ran','received'].includes(job.role)?job.role:'sent',lender:job.lenderName||'a lender',requester:job.historyIdentity?.personName||'the requester'}).word||'Status unavailable')}</p></li>)}</ul>:<p class="t-sm t-2">No jobs in the history available to this computer.</p>}</section>;
}

export function PersonDetail({person,circle,members,selfKey,jobs=[],jobsError,jobsLoading,retryJobs,mutate,setDialog,headingRef,availability}) {
  const binding=JSON.stringify([circle.id,person.personId]);
  const [draft,setDraft]=useState(null), form=roleFormState(draft,binding,person.role), role=form.value;
  useLayoutEffect(()=>setDraft(form),[binding,person.role]);
  const base='circles/'+enc(circle.id)+'/people/';
  const history=personJobs(jobs,person);
  const manage=(circle.owned||circle.steward||circle.admin) && person.role!=='owner';
  return <div class="stack-6 ph-no-capture" data-telemetry-private="people">
    <div class="hstack-3 wrap"><h1 ref={headingRef} class="t-page grow" tabIndex="-1">{person.name}</h1><span class="pill off">{person.roleName}</span>{person.blocked&&<span class="pill off">Blocked</span>}</div>
    <p class="t-sm t-2">Computers: {person.computers.length} · Computer links are verified by both computers.</p>
    {manage&&<Card pad class="stack-4"><h2>Circle access</h2>{circle.owned&&<><label class="stack-2">Role<select value={role} onChange={event=>setDraft({...form,value:field(event)})}>{Object.entries(ROLE_NAMES).filter(([value])=>value!=='owner').map(([value,label])=><option value={value}>{label}</option>)}</select></label>
      <p class="t-sm t-2">Roles never turn lending on or approve another person's jobs. Co-admins can manage membership and invitations. Only the owner changes roles and circle authority. Changing co-admin access retires unused invitations.</p>
      {form.conflict&&<p role="alert">This role changed while you were editing. Your edit is not saved. <Button onClick={()=>setDraft(null)}>Use current role</Button></p>}<Action disabled={form.conflict||role===person.role} disabledReason={form.conflict?'This role changed. Use the current role first.':'Pick a different role first'} run={()=>!form.conflict&&mutate(base+'role',{personId:person.personId,role})} success="Role saved.">Save role</Action></>}
      <Button kind={person.blocked?'secondary':'danger'} onClick={()=>setDialog({title:person.blocked?'Unblock '+person.name+'?':'Block '+person.name+'?',confirmLabel:person.blocked?'Unblock person':'Block person',children:<p>{person.blocked?unblockMessage(circle.lifecycle):'Their computers cannot ask for or run new jobs. They stay in the circle and can still read shared history. Running jobs can finish. You can unblock them later.'}</p>,onConfirm:()=>mutate(base+'block',{personId:person.personId,blocked:!person.blocked})})}>{person.blocked?'Unblock person':'Block person'}</Button>
    </Card>}
    <section class="stack-4"><h2>Computers and your lending limits</h2><p class="t-sm t-2">These limits apply when this person borrows from this computer. Each computer has its own cap; your global lending limits still apply.</p>
      {person.computers.map(computer=><Card key={computer.key_id} pad class="stack-3"><h3 class="t-title3">{safeName(computer.device_name,'Unnamed computer')}{computer.key_id===selfKey?' · This computer':''}</h3>{computer.localName&&<p class="t-sm t-2">Your nickname: {safeName(computer.localName)}</p>}<p class="t-sm t-2">{computerAvailability(availability?.(computer),{blocked:person.blocked,lifecycle:circle.lifecycle})}</p><LocalNameControl key={JSON.stringify([circle.id,computer.key_id])} circleId={circle.id} circleLabel={circle.name} keyId={computer.key_id} remoteName={computer.device_name} current={computer.localName} mutate={mutate} label="Nickname on this computer"/><RequesterLimitsControl circleId={circle.id} keyId={computer.key_id} value={computer.requesterLimits} mutate={mutate}/></Card>)}
    </section>
    {jobsError?<div class="stack-2"><p role="alert" class="t-sm t-2">Job history is unavailable. Access controls are still available.</p>{retryJobs&&<Button kind="secondary" onClick={retryJobs}>Try again</Button>}</div>:jobsLoading?<p role="status" class="t-sm t-2">Loading job history…</p>:<><JobHistory title="Asked for" rows={history.asked} circleId={circle.id}/><JobHistory title="Assigned to their computers" assigned rows={history.ran} circleId={circle.id}/></>}
    {manage&&<section class="stack-3"><h2>Remove from circle</h2><p class="t-sm t-2">Removal ends access for all their computers. Copies already shared stay shared.</p><Button kind="danger" onClick={()=>setDialog({title:'Remove '+person.name+'?',confirmLabel:'Remove person',children:<p>All their computers lose access. These computer identities cannot rejoin with a new invitation. Use Block person above for a reversible pause.</p>,onConfirm:()=>mutate(base+'remove',{personId:person.personId})})}>Remove person</Button></section>}
  </div>;
}
export function Person({id,circleId,circles,data,api,revision,mutate,setDialog,headingRef,availability}) {
  const circle=circles.find(item=>item.id===circleId);
  const people=useResource(api,circle?'circles/'+enc(circleId)+'/people':null,revision);
  const jobs=useResource(api,circle?'jobs?circle='+enc(circleId):null,revision);
  const members=data.devices?.circles?.find(item=>item.circle===circleId)?.members??[];
  const person=people.data&&peopleVM(people.data,members,data.devices?.fingerprint).find(item=>item.personId===id);
  return <div class="circle-page stack-6 ph-no-capture" data-telemetry-private="people"><a class="back" href={'#/circle/'+enc(circleId)}><Icon name="chev-l" size="sm"/>{safeName(circle?.name,'Circle')}</a>
    {!circle?data.circles===undefined?<p role="status">Loading circle…</p>:<><h1 ref={headingRef} class="t-page" tabIndex="-1">Circle unavailable</h1><p>This circle is no longer on this computer.</p><Button href="#/circles">Your circles</Button></>:people.error?<Card pad><h1 ref={headingRef} class="t-page" tabIndex="-1">Member unavailable</h1><p role="alert">{errorMessage(people.error)}</p><Button kind="secondary" onClick={() => people.reload()}>Try again</Button></Card>:!people.data?<p role="status">Loading member…</p>:!person?<><h1 ref={headingRef} class="t-page" tabIndex="-1">Member unavailable</h1><p>This member is no longer listed in the circle.</p></>:<PersonDetail key={JSON.stringify([circleId,id])} {...{person,circle,members,selfKey:data.devices?.fingerprint,jobs:jobs.data??[],jobsError:jobs.error,jobsLoading:jobs.data===null&&!jobs.error,retryJobs:() => jobs.reload(),mutate,setDialog,headingRef,availability}}/>}
  </div>;
}

export function ComputerLink({circle,members,selfKey,mutate}) {
  const [anchor,setAnchor]=useState(selfKey||''),[target,setTarget]=useState(''),[proof,setProof]=useState('');
  const [personProof,setPersonProof]=useState(''),[deviceProof,setDeviceProof]=useState('');
  useEffect(()=>{if(!members.some(member=>member.key_id===anchor&&(!member.person_id||member.person_id===member.key_id))){const self=members.find(member=>member.key_id===selfKey);setAnchor(self?.person_id??self?.key_id??'');}},[selfKey,members.map(member=>member.key_id+':'+member.person_id).join(','),anchor]);
  const selected=members.find(member=>member.key_id===anchor);
  const personId=selected?.person_id??anchor;
  const base='circles/'+enc(circle.id)+'/people/';
  const canSign=target&&anchor!==target&&(selfKey===personId||selfKey===target);
  const signReason=!target?'Choose the computer to link first.':anchor===target?'Choose two different computers.':'Create this proof on the person’s original computer or on the computer being linked.';
  // A proof answers the pair it was asked about. The reply is read against the selection on screen now, not the one at the click.
  const selection=JSON.stringify([anchor,target]), shown=useRef(selection);
  shown.current=selection;
  return <details class="stack-4 ph-no-capture" data-telemetry-private="people"><summary>Link computers to one person</summary><div class="stack-4">
    <p class="t-sm t-2">Step 1: create a proof on each computer. Step 2: give both proofs to the circle owner. Matching names alone do not link computers.</p>
    <label class="stack-2">Person's original computer<select value={anchor} onChange={event=>{setAnchor(field(event));setProof('');}}>{members.filter(member=>!member.person_id||member.person_id===member.key_id).map(member=><option value={member.key_id}>{safeName(member.device_name,'Unnamed computer')}</option>)}</select></label>
    <label class="stack-2">Computer to link<select value={target} onChange={event=>{setTarget(field(event));setProof('');}}><option value="">Choose a computer</option>{members.filter(member=>member.key_id!==anchor).map(member=><option value={member.key_id}>{safeName(member.device_name,'Unnamed computer')}</option>)}</select></label>
    <Action disabled={!canSign} disabledReason={canSign ? '' : signReason} run={async()=>({asked:selection,value:await mutate(base+'link-proof',{otherKeyId:target,personId})})} success="Link proof created." onSuccess={({asked,value})=>{if(asked===shown.current)setProof(JSON.stringify(value));}}>Create this computer's proof</Action>
    {proof&&<><Field label="This computer's link proof" multiline readOnly value={proof}/><Action run={()=>navigator.clipboard.writeText(proof)} success="Proof copied.">Copy link proof</Action></>}
    {circle.owned&&<><Field label="Original computer's proof" multiline value={personProof} onInput={event=>setPersonProof(field(event))}/><Field label="New computer's proof" multiline value={deviceProof} onInput={event=>setDeviceProof(field(event))}/>
    <Action disabled={!personProof.trim()||!deviceProof.trim()||!target} disabledReason={!personProof.trim()||!deviceProof.trim()?'Paste both proofs first.':'Choose the computer to link first.'} run={()=>mutate(base+'link',{personId,deviceKeyId:target,personProof:parseCircleCode(personProof),deviceProof:parseCircleCode(deviceProof)})} success="Computers linked.">Verify and link computers</Action></>}
  </div></details>;
}

export function CircleExits({circle,mutate,setDialog}) {
  const state=circle.lifecycle??'active';
  const change=(next,title,description)=>setDialog({title,confirmLabel:next==='active'?'Reopen circle':next==='archived'?'Archive circle':'Close circle',children:<p data-telemetry-private="people" class="ph-no-capture">{description}</p>,onConfirm:()=>mutate('circles/'+enc(circle.id)+'/lifecycle',{state:next})});
  if(!circle.owned)return null;
  return <Card pad class="stack-4 ph-no-capture" data-telemetry-private="people"><h2>Circle lifecycle</h2><p class="t-sm t-2">{state==='active'?'Active: members can send and run jobs.':state==='archived'?'Archived: no new jobs; shared history stays available.':'Closed: no new jobs; shared history stays available.'} Hosting is managed separately.</p>
    <div class="hstack-3 wrap">{state==='active'?<Button onClick={()=>change('archived','Archive '+circle.name+'?','New jobs pause for everyone. Running jobs can finish, and shared history stays available. You can reopen the circle later.')}>Archive circle</Button>:state==='archived'?<Button onClick={()=>change('active','Reopen '+circle.name+'?','Members can send new jobs again. Their lending choices stay as they set them.')}>Reopen circle</Button>:null}
    {state==='closed'&&<Button kind="danger" onClick={()=>setDialog({title:'Delete local membership data?',confirmLabel:'Delete local data',children:<p>This removes this computer’s member list, invitation history and circle signing data. The host’s shared history and downloaded results stay where they are. This computer will forget the circle.</p>,onConfirm:async()=>{await mutate('circles/'+enc(circle.id)+'/delete-local',{});location.hash='#/circles';}})}>Delete local data</Button>}
    {state!=='closed'&&<Button kind="danger" onClick={()=>change('closed','Close '+circle.name+'?','This permanently stops new work in this circle. Running jobs can finish. Shared history stays available; copies already shared cannot be recalled.')}>Close circle</Button>}</div>
  </Card>;
}

export function CircleAuthority({circle,members,selfKey,mutate,setDialog}) {
  const [steward,setSteward]=useState(circle.authorityStewardKeyId??''),[target,setTarget]=useState(''),[offered,setOffered]=useState(''),[received,setReceived]=useState('');
  // Bumped when the new owner's computer changes or a cancel is asked; a transfer code from an earlier round is dropped.
  const offerRound=useRef(0);
  const base='circles/'+enc(circle.id)+'/';
  useEffect(()=>setSteward(circle.authorityStewardKeyId??''),[circle.authorityStewardKeyId]);
  const choices=members.filter(member=>member.key_id!==selfKey);
  return <Card pad class="stack-4 ph-no-capture" data-telemetry-private="people"><h2>Ownership and backup steward</h2>
    <p class="t-sm t-2">Everyone must update before using these controls. Authority changes retire unused invitations; approved members keep access.</p>
    {circle.owned&&<><section class="stack-3"><h3 class="t-title3">Backup steward</h3><p class="t-sm t-2">A steward can admit computers and manage membership while you are away. They cannot transfer ownership or approve someone else's lending.</p>
      <label class="stack-2">Steward's computer<select value={steward} onChange={event=>setSteward(field(event))}><option value="">No backup steward</option>{choices.map(member=><option value={member.key_id}>{safeName(member.device_name,'Unnamed computer')}</option>)}</select></label>
      <Button onClick={()=>setDialog({title:'Change backup steward?',confirmLabel:'Save backup steward',children:<p>This computer will be able to manage circle membership. Unused invitations will stop working. Everyone in the circle must update Faravan first.</p>,onConfirm:()=>mutate(base+'steward',{deviceKeyId:steward||null})})}>Save backup steward</Button>
    </section><section class="stack-3"><h3 class="t-title3">Transfer ownership</h3><p class="t-sm t-2">Choose the new owner's computer, then share its transfer code privately. You stay owner until they accept within 24 hours. Hosting stays where it is.</p>
      <label class="stack-2">New owner's computer<select value={target} onChange={event=>{setTarget(field(event));setOffered('');offerRound.current++;}}><option value="">Choose a computer</option>{choices.map(member=><option value={member.key_id}>{safeName(member.device_name,'Unnamed computer')}</option>)}</select></label>
      <Action disabled={!target} disabledReason="Choose a computer first" run={async()=>{const round=offerRound.current;return {round,value:await mutate(base+'ownership/propose',{deviceKeyId:target})};}} success="Transfer offered. You stay owner until it is accepted." onSuccess={({round,value})=>{if(round===offerRound.current)setOffered(JSON.stringify(value.proposal));}}>Create transfer code</Action>
      {offered&&<><Field label="Transfer code to share privately" multiline readOnly value={offered}/><Action run={()=>navigator.clipboard.writeText(offered)} success="Transfer code copied.">Copy transfer code</Action></>}
      <Action run={()=>{offerRound.current++;return mutate(base+'ownership/cancel',{});}} success="Transfer codes cancelled." onSuccess={()=>setOffered('')}>Cancel outstanding transfer codes</Action>
    </section></>}
    {!circle.owned&&<section class="stack-3"><h3 class="t-title3">Accept ownership</h3><p class="t-sm t-2">Paste the code the current owner gave you. Only the computer they chose can accept.</p><Field label="Ownership transfer code" multiline value={received} onInput={event=>setReceived(field(event))}/><Button disabled={!received.trim()} disabledReason="Paste the code first" onClick={()=>setDialog({title:'Accept ownership of '+circle.name+'?',confirmLabel:'Accept ownership',children:<p>You will manage circle members, roles and invitations. Hosting stays where it is. Unused invitations stop working. Lending stays as each person set it.</p>,onConfirm:()=>mutate(base+'ownership/accept',{proposal:parseCircleCode(received,'invalid_transfer_code')})})}>Accept ownership</Button></section>}
  </Card>;
}
