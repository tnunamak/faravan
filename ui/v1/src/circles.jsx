import {PeopleList,ComputerLink,CircleExits,CircleAuthority} from './people.jsx';
import {Invitations} from './invitations.jsx';
import {MemberAddress, MemberOrigins} from './member-address.jsx';
import { Button, Icon, Card, Avatar, Row, Field, Switch, Tabs } from './ds/index.mjs';
import { circleJobsStatus, circlesListVM, joinOutcomeVM, circlePerson, memberAvailability, deviceUsage, circleHostingVM, devicesListVM, hostedHere, invitationExpiryLabel } from './circles-view.mjs';
import { useState, useRef, useEffect } from 'preact/hooks';
import {
  safeName,
  createJoinReview,
  joinPreviewView,
  errorMessage,
  enrollmentView,
} from './helpers.mjs';
import { savePetname, deletePetname } from './api.mjs';
import { Activity } from './circle-activity.jsx';
import { takeJoinIntent } from './join-intent.mjs';
import { takeJoinPrefillRejection } from './join-prefill.mjs';
import {formatMembership, membershipProjectionFor} from './membership-projection-view.mjs';
import {joinLendingNote} from './lending-projection-view.mjs';
import { useMemberHost, MemberHostNotices } from './member-host.jsx';
import { INVITATION_COPY, JOIN_COPY } from './safety-copy.mjs';
import {
  field,
  Action,
  Panel,
  Link,
  circleName,
  go,
  Note,
  useResource,
  enc,
} from './shared.jsx';

export function CircleSkeleton() {
  return <div class="circle-skeleton ph-no-capture" role="status" aria-label="Loading" data-telemetry-private="circles"><span /><span /><span /></div>;
}

export function JoinDisclosure({lendingNote = ''}) {
  return <div class="join-disclosure stack-3 ph-no-capture" data-telemetry-private="circles">
    <p>{JOIN_COPY.noSideEffect}</p>
    {lendingNote && lendingNote !== 'Joining does not turn lending on.' && <p>{lendingNote}</p>}
    <div class="stack-2">
      <h4 class="t-title3">{JOIN_COPY.heading}</h4>
      <ul>{JOIN_COPY.points.map(point => <li key={point}>{point}</li>)}</ul>
    </div>
    <p>Jobs wait while the computer hosting this circle is asleep or offline.</p>
  </div>;
}

export function InvitationDisclosure({group = false, approveEach = false}) {
  const invitation = group
    ? `Anyone with this link can ${approveEach ? 'ask to join' : 'join automatically'}, up to ten computers. Check who is in the chat before sharing.`
    : INVITATION_COPY.onePerson;
  return <div class="stack-2 ph-no-capture" data-telemetry-private="circles">
    <p class="t-sm t-2">{invitation}</p>
    <p class="t-sm t-2">{INVITATION_COPY.audience}</p>
    <p class="t-sm t-2">{JOIN_COPY.noSideEffect}</p>
  </div>;
}

// When Faravan never heard the answer, the invitation may exist. It cannot be listed with its link, so say that and
// let the person try again: an unused invitation expires by itself, so a second one is harmless (r8 O10).
const INVITATION_UNHEARD = new Set(['timeout', 'network', 'network_error', 'offline', 'service_unavailable', 'mutation_uncertain', 'mutation_pending', 'unknown']);
export function invitationProblemText(problem, {kind = 'invite'} = {}) {
  if (kind === 'preview') {
    const code = problem?.problem?.code ?? problem?.code;
    if (INVITATION_UNHEARD.has(code) || code === 'invite_unreachable' || typeof code !== 'string')
      return 'Faravan couldn’t check this invitation. You haven’t submitted a join request from this review. Try Review invitation again when the host is back.';
    return errorMessage(problem);
  }
  if (kind === 'join' && problem?.outcome === 'unknown') {
    if (problem.code === 'network_error')
      return 'Couldn’t reach the host. This join is saved and will retry with the same invitation.';
    if (problem.code === 'enrollment_pending')
      return 'Another join is still being resolved. Faravan will retry that saved request before using a different invitation.';
    return 'Faravan could not confirm this join. Check the circle status before using a different invitation.';
  }
  const raw = problem?.problem?.code ?? problem?.code;
  if (kind === 'join' && ['invite_unreachable','network_error'].includes(raw))
    return 'The circle server isn’t answering. You haven’t joined yet. Review invitation again when the host is back, then try Join circle.';
  if (kind === 'join' && (INVITATION_UNHEARD.has(raw) || typeof raw !== 'string'))
    return 'Faravan could not confirm this join. Check the circle status before using a different invitation.';
  return INVITATION_UNHEARD.has(raw) || typeof raw !== 'string'
    ? 'Faravan did not hear back, so it can’t tell whether your invitation was created. Check the Invitations tab, or create another one. An unused invitation expires by itself.'
    : errorMessage(problem);
}
export function InvitationProblem({problem, outcome, kind = 'invite'}) {
  const fallback=useRef(null), target=outcome || fallback;
  const [showDetails,setShowDetails]=useState(false);
  useEffect(() => {requestAnimationFrame(() => target.current?.focus());}, [problem]);
  const code = /^[a-z_]{1,80}$/.test(problem?.code) ? problem.code : 'invitation_failed';
  const details = JSON.stringify({code,status:Number.isInteger(problem?.status)?problem.status:null,diagnosticId:/^[a-zA-Z0-9_-]{1,128}$/.test(problem?.problem?.diagnosticId ?? '')?problem.problem.diagnosticId:null});
  return <div class="ph-no-capture" ref={target} tabIndex="-1" role="alert" data-telemetry-private="circles"><p>{invitationProblemText(problem,{kind})}</p><Action className="btn btn-quiet" run={async () => {try {await navigator.clipboard.writeText(details);} catch(error) {setShowDetails(true);throw error;}}} success="Details copied.">Copy details</Action>{showDetails && <label>Copy these details manually<textarea readOnly value={details} onFocus={event=>event.currentTarget.select()} /></label>}</div>;
}

export function validateInvitationResponse(value) {
  if (!value || typeof value.invite !== 'string' || !value.invite.trim() || value.error || value.problem)
    throw {code:'mutation_uncertain'};
  return value.invite;
}

function InvitationAction({run, onSuccess, success = '', problemKind = 'invite', children, ...props}) {
  const [problem, setProblem] = useState(null);
  const outcome = useRef(null);
  return <div class="stack-2 ph-no-capture" data-telemetry-private="circles"><Action {...props} run={async () => {
    setProblem(null);
    try {return await run();} catch(error) {
      setProblem(error);
      requestAnimationFrame(() => outcome.current?.focus());
      return null;
    }
  }} success={value => value ? typeof success === 'function' ? success(value) : success : ''} onSuccess={value => {if(value)onSuccess?.(value);}}>{children}</Action>
    {problem && <InvitationProblem problem={problem} outcome={outcome} kind={problemKind} />}
  </div>;
}

const focusOutcome = () => requestAnimationFrame(() => {
  const notice = document.querySelector('.notice[role="status"]');
  if (notice) { notice.tabIndex = -1; notice.focus(); }
});

// A members read that timed out is about the members only; it never says the whole app has not finished loading.
const memberReadMessage = error => error?.code === 'read_timeout' ? 'A circle host took too long to answer, so members may be out of date.' : errorMessage(error);
const staleMemberCircles = groups => new Set((Array.isArray(groups) ? groups : []).filter(group => group.membersLastKnown === true).map(group => group.circle));

export function Devices({ data, circles, refresh, errors = {} }) {
  const view = devicesListVM(data.devices,circles);
  if (view.state === 'loading') return <div class="circle-page ph-no-capture" data-telemetry-private="circles">{errors.devices ? <Card pad><p role="alert">{memberReadMessage(errors.devices)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry devices</Action></Card> : <CircleSkeleton />}</div>;
  return <div class="circle-page stack-6 ph-no-capture" data-telemetry-private="circles">
    {errors.devices && <Card pad><p role="alert">{memberReadMessage(errors.devices)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry devices</Action></Card>}
    <ul class="list card" aria-label="Your computers">{view.rows.map(row => <li key={row.id}><Row href={row.href} avatar={<Avatar personName={row.avatarName} id={row.id} />} title={row.name} meta={row.meta} /></li>)}</ul>
    <div class="device-actions"><Button href="#/you/profile">Edit your profile</Button><Button kind="quiet" href="#/circles">Manage circles</Button><Action className="btn btn-quiet" run={refresh} success="Devices refreshed.">Refresh devices</Action></div>
  </div>;
}

// Opens the composer on this circle, with this circle's own saved request if it has one.
export const composeIn = id => () => { try { globalThis.localStorage?.setItem('faravan-compose-circle', id); } catch {} };

// Persistent result of a join, derived from the refreshed circle list so it can never contradict it.
export function JoinOutcome({outcome}) {
  if (!outcome) return null;
  return <p role="status" class={(outcome.joined ? 'join-outcome' : 'join-outcome t-2') + ' ph-no-capture'} data-telemetry-private="circles">{outcome.message}{outcome.joined && <> · <a href="#/new" onClick={composeIn(outcome.circleId)}>Send your first job</a> · <Link page="circle" id={outcome.circleId}>View circle</Link></>}</p>;
}

function CircleJobsNotice({id, data, readError, selected = false}) {
  const coverage = selected && readError && !data.jobCircleCoverage
    ? [{circleId:id,state:'unavailable'}] : data.jobCircleCoverage;
  const status = circleJobsStatus(id, coverage, data.uncheckedJobCircles ?? [], readError);
  return status ? <span class="t-xs t-2" role={status.warning ? 'status' : undefined}>{status.message}
    {status.savedAt && <> Last synced: <time dateTime={status.savedAt}>{new Date(status.savedAt).toLocaleString()}</time>.</>}
  </span> : null;
}

export function Circles({ circles, data, mutate, api, takeJoinLink, revision, refresh, errors = {}, circlesSnapshot = null, getCirclesReadBarrier = () => 0 }) {
  const [joinLink] = useState(() => takeJoinLink?.() || '');
  const [prefillRejected, setPrefillRejected] = useState(() => takeJoinPrefillRejection());
  const [joiningOpen, setJoiningOpen] = useState(() => Boolean(joinLink) || prefillRejected || takeJoinIntent());
  const hosting = useResource(api, 'hosting', revision);
  const lastCounts = useRef({});
  for (const group of data.devices?.circles ?? []) if (group.members?.length || group.rosterHeld) lastCounts.current[group.circle] = group.members?.length ?? 0;
  const rows = circlesListVM(circles, data.devices, hosting.data, {lastCounts: lastCounts.current, uncheckedCircles: data.jobCircleCoverage ? [] : data.uncheckedJobCircles});
  const [invite, setInvite] = useState(joinLink),
    [prefillError, setPrefillError] = useState(null),
    [joinError, setJoinError] = useState(null),
    [joinResult, setJoinResult] = useState(null),
    [review, setReview] = useState(null);
  const joining = useRef(null);
  if (!joining.current)
    joining.current = createJoinReview(
      (link) => api.post('circles/join-preview', { link }),
      (body) => mutate('circles/join', body),
    );
  useEffect(() => () => joining.current.invalidate(), []);
  // A link handed over by `faravan open-link` is reviewed, never joined: the person still presses Join.
  useEffect(() => {
    if (joinLink) joining.current.inspect(joinLink).then(setReview, setPrefillError);
  }, []);
  const preview = review ? joinPreviewView(review.preview) : null;
  const retiredReceipt = useRef(null);
  const candidate = joinOutcomeVM(joinResult?.result, circles, {
    snapshot: circlesSnapshot, afterReadId: joinResult?.afterReadId,
  });
  // Latch before passive cleanup: later errors or overlays cannot revive this receipt.
  if (joinResult && !candidate) retiredReceipt.current = joinResult;
  const outcome = retiredReceipt.current === joinResult ? null : candidate;
  useEffect(() => {
    if (joinResult && retiredReceipt.current === joinResult)
      setJoinResult(current => current === joinResult ? null : current);
  }, [joinResult, candidate]);
  // Once the circle shows as joined the form has done its job, whether the approval arrived at once or later.
  useEffect(() => { if (outcome?.closeForm) setJoiningOpen(false); }, [outcome?.closeForm, outcome?.circleId]);
  const lendingNote = joinLendingNote(data.home ?? {});
  const staleCircles = staleMemberCircles(data.devices?.circles);
  const staleCircleNames = rows.filter(row => staleCircles.has(row.id)).map(row => row.name);
  return (
    <div class="circle-page stack-6 ph-no-capture" data-telemetry-private="circles">
      {errors.circles && <Card pad><p role="alert">Could not refresh circles. Any rows shown are last-known information. {errorMessage(errors.circles)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry circles</Action></Card>}
      {errors.devices && <Card pad><p role="alert">Could not refresh members. Any counts shown are last-known information. {memberReadMessage(errors.devices)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry members</Action></Card>}
      {!errors.devices && staleCircles.size > 0 && <Card pad><p role="alert">Could not refresh members{staleCircleNames.length ? ' in ' + staleCircleNames.join(', ') : ' in an affected circle'}. Counts for affected circles are last-known information.</p><Action className="btn btn-secondary" run={refresh} success="">Retry members</Action></Card>}
      {data.circles === undefined ? errors.circles ? null : <CircleSkeleton /> : rows.length ? (
        <ul class="list card" aria-label="Your circles">{rows.map(row => <li class="circle-list-row" key={row.id}><Row href={row.href} avatar={<Avatar groupName={row.name} id={row.id} />} title={row.name} meta={<><span class="row-purpose">{row.purpose || 'No description'}</span>{row.meta}<CircleJobsNotice id={row.id} data={data} readError={errors.jobs} /></>} />{row.hostingAction && <a class="btn btn-secondary" href={row.hostingAction.href}>{row.hostingAction.label}</a>}</li>)}</ul>
      ) : errors.circles ? null : <div class="empty"><Icon name="circles" size="lg" /><h2 class="t-title3">Work with people you trust.</h2><p class="t-sm t-2">Start a circle to share spare agent time, or join with an invitation.</p></div>}
      {data.circles !== undefined && <div class={'hstack-2 wrap' + (!rows.length ? ' circle-empty-actions' : '')}><Button href="#/circles/new">Start a circle</Button><Button kind="quiet" onClick={() => setJoiningOpen(!joiningOpen)} aria-expanded={joiningOpen}>Join with an invitation</Button></div>}
      <p class="t-sm t-2">A circle is a group of people who share agent time with each other.</p>
      {!joiningOpen && <JoinOutcome outcome={outcome} />}
      {joiningOpen && <Panel title="Join a circle">
        <p>
          Lend or borrow spare agent time with people you trust. {lendingNote}
        </p>
        {prefillRejected && <p role="alert">This invitation couldn’t be opened. Paste the link from your inviter into Invitation, or ask them for a new one.</p>}
        <form onSubmit={(e) => e.preventDefault()}>
          <label>
            Invitation
            <textarea
              value={invite}
              onInput={(e) => {
                joining.current.invalidate();
                setReview(null);
                setPrefillError(null);
                setJoinError(null);
                setJoinResult(null);
                setPrefillRejected(false);
                setInvite(field(e));
              }}
              autoComplete="off"
              spellCheck="false"
              aria-describedby="invite-help"
            />
          </label>
          <p id="invite-help">
            Paste the invitation link you received. Check with the sender if you weren't expecting
            it.
          </p>
          {invite.trim() && !preview && <InvitationAction key={invite}
            className="btn btn-secondary"
            problemKind="preview"
            run={async () => {setJoinError(null);setPrefillError(null);return joining.current.inspect(invite);}}
            success=""
            onSuccess={(value) => {
              setPrefillError(null);
              setJoinError(null);
              setReview(value);
              requestAnimationFrame(() => {const heading=document.querySelector('[aria-label="Join confirmation"] h3');if(heading){heading.tabIndex=-1;heading.focus();}});
            }}
          >
            Review invitation
          </InvitationAction>}
          {prefillError && <InvitationProblem problem={prefillError} kind="preview" />}
          {joinError && <InvitationProblem problem={joinError} kind="join" />}
          {preview && (
            <section class="stack-4" aria-label="Join confirmation">
              <h3>
                {preview.ownerName
                  ? preview.ownerName + ' invited you to ' + preview.name + '.'
                  : 'Join ' + preview.name + '?'}
              </h3>
              <p>
                {[
                  preview.uses,
                  invitationExpiryLabel(preview.expiresAt),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <JoinDisclosure lendingNote={lendingNote} />
              {preview.warning && <Note>{preview.warning}</Note>}
              <div class="join-actions hstack-2 wrap">
              <InvitationAction
                className="btn btn-primary"
                problemKind="join"
                run={async () => {
                  setJoinError(null);
                  setPrefillError(null);
                  try {return await joining.current.confirm(review);}
                  catch(error) {
                    setReview(null);
                  if(error?.outcome==='unknown' || error?.code==='invite_unreachable') {
                      setJoinError(error);
                      try {await refresh?.();} catch {}
                    } else setJoinError(error);
                    throw error;
                  }
                }}
                success={result => joinOutcomeVM(result, [])?.message ?? ''}
                onSuccess={(result) => {
                  setInvite('');
                  setReview(null);
                  setPrefillError(null);
                  setJoinError(null);
                  setJoinResult({result, afterReadId: getCirclesReadBarrier()});
                  if (joinOutcomeVM(result, [])?.closeForm) setJoiningOpen(false);
                  focusOutcome();
                }}
              >
                Join circle
              </InvitationAction>
              <Button
                kind="quiet"
                onClick={() => {
                  joining.current.invalidate();
                  setReview(null);
                  requestAnimationFrame(() => document.querySelector('textarea[aria-describedby="invite-help"]')?.focus());
                }}
              >
                Not now
              </Button>
              </div>
            </section>
          )}
        </form>
        {outcome && !outcome.joined && <JoinOutcome outcome={outcome} />}
      </Panel>}
    </div>
  );
}

function MemberMenu({ member, name, circle, mutate, setDialog }) {
  const [nickname, setNickname] = useState(member.localName || '');
  return <details class="member-menu ph-no-capture" data-telemetry-private="circles">
    <summary class="icon-btn" aria-label={'Actions for ' + name}><Icon name="more" /></summary>
    <div class="member-menu-body stack-4">
      <h3 class="t-title3">{name}</h3>
      <form onSubmit={e => e.preventDefault()}>
        <Field label="Nickname only you see" value={nickname} maxLength="64" onInput={e => setNickname(field(e))} hint="Saved only on this computer, for this member in this circle." />
        {nickname.trim() && nickname.trim() !== member.localName && <Action run={async () => {await savePetname(mutate, circle.id, member.key_id, nickname);focusOutcome();}} success="Nickname saved." onSuccess={focusOutcome}>Save nickname</Action>}
        {member.localName && <Action run={async () => {await deletePetname(mutate, circle.id, member.key_id);focusOutcome();}} onSuccess={() => {setNickname('');focusOutcome();}} success="Nickname removed.">Remove nickname</Action>}
      </form>
      <p class="t-sm t-2">{deviceUsage(member.requesterLimits)}</p>
      {circle.owned && <Button kind="danger" onClick={() => setDialog({title:'Remove ' + name + '?', confirmLabel:'Remove computer', children:<p>This computer loses access and cannot rejoin with the same identity, even with a new invitation. Other computers belonging to this person keep their access. Copies already shared stay shared.</p>, onConfirm:() => mutate('circles/' + enc(circle.id) + '/remove-member', {keyId:member.key_id})})}>Remove this computer</Button>}
    </div>
  </details>;
}

function ApprovalMode({ circle, mutate }) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  return <div class="stack-3 ph-no-capture" data-telemetry-private="circles">
    <div class="hstack-3"><div class="grow"><b>Approve each computer</b><p class="t-sm t-2" id="approval-reason">{circle.approveEach ? 'Each new computer waits here until you approve it.' : 'An invitation is enough. This computer approves new members while Faravan is running.'}</p></div>
      <Switch checked={circle.approveEach === true} label="Approve each computer" aria-describedby="approval-reason" aria-busy={saving} aria-disabled={saving} onChange={async approveEach => {if(saving)return;setSaving(true);setError('');try {await mutate('circles/' + enc(circle.id) + '/approval-mode', {approveEach});} catch(e) {setError(errorMessage(e));} finally {setSaving(false);}}} />
    </div>
    {saving && <p class="t-sm t-2" role="status">Saving approval choice…</p>}{error && <p role="alert">{error}</p>}
  </div>;
}

export function CircleProfileSettings({circle, mutate, onDirtyChange}) {
  const [name,setName]=useState(circle.name ?? ''),[purpose,setPurpose]=useState(circle.purpose ?? '');
  const previous=useRef({id:circle.id,name:circle.name??'',purpose:circle.purpose??''});
  useEffect(()=>{
    const old=previous.current,next={id:circle.id,name:circle.name??'',purpose:circle.purpose??''};
    if(old.id!==next.id){setName(next.name);setPurpose(next.purpose);}
    else {
      if(old.name!==next.name)setName(value=>value===old.name?next.name:value);
      if(old.purpose!==next.purpose)setPurpose(value=>value===old.purpose?next.purpose:value);
    }
    previous.current=next;
  },[circle.id,circle.name,circle.purpose]);
  const changed=name.trim()!==(circle.name??'')||purpose.trim()!==(circle.purpose??'');
  useEffect(()=>{onDirtyChange?.(changed);},[changed,onDirtyChange]);
  if(!circle.owned&&!circle.steward&&!circle.admin)return null;
  return <Card pad class="stack-4 ph-no-capture" data-telemetry-private="circles"><h2>Circle details</h2>
    <p class="t-sm t-2">Everyone in this circle sees these details.</p>
    <Field label="Circle name" value={name} maxLength={256} onInput={event=>{const value=event.currentTarget.value;setName(value);onDirtyChange?.(value.trim()!==(circle.name??'')||purpose.trim()!==(circle.purpose??''));}} />
    <Field label="Purpose" value={purpose} maxLength={256} hint="One line about what this circle is for. Optional." onInput={event=>{const value=event.currentTarget.value;setPurpose(value);onDirtyChange?.(name.trim()!==(circle.name??'')||value.trim()!==(circle.purpose??''));}} />
    <Action disabled={!name.trim()||!changed} disabledReason={!name.trim()?'Enter a circle name first':'Change the name or purpose first'} run={()=>mutate('circles/'+enc(circle.id)+'/profile',{name:name.trim(),purpose:purpose.trim()})} success="Circle details saved.">Save circle</Action>
  </Card>;
}

export function Circle({ id, circles, data, lending = {}, mutate, api, revision, setDialog, headingRef, errors = {}, refresh }) {
  const circle = circles.find(c => c.id === id);
  const people=useResource(api,circle?.origin?'circles/'+enc(id)+'/people':null,revision);
  const pending = useResource(api, (circle?.owned||circle?.steward||circle?.admin) && circle.origin ? 'circles/' + enc(id) + '/approvals' : null, revision);
  const canReadJobs = circle?.origin && membershipProjectionFor(circle).phase === 'approved';
  const taskJobs = useResource(api, canReadJobs ? 'jobs?circle=' + enc(id) + '&coverage=1' : null, revision);
  const selectedJobs = Array.isArray(taskJobs.data?.circleCoverage) && taskJobs.data.circleCoverage.some(row => row?.circleId === id) ? taskJobs.data : null;
  const memberJobs = taskJobs.error ? [] : selectedJobs?.items ?? (Array.isArray(taskJobs.data) ? taskJobs.data : []);
  const hosting = useResource(api, circle?.owned ? 'hosting' : null, revision);
  const [tab, setTab] = useState('members'), [inviting, setInviting] = useState(false), [checkingJoin, setCheckingJoin] = useState(false);
  const profileDirty=useRef({id,dirty:false});
  const [pendingTab,setPendingTab]=useState(null);
  // The element id to focus after the next render: the draft prompt when it opens, then the tab the person chose.
  const focusAfter=useRef(null);
  useEffect(()=>{if(focusAfter.current){document.getElementById(focusAfter.current)?.focus();focusAfter.current=null;}});
  const changeTab=next=>{if(next===tab)return;if(tab==='settings'&&profileDirty.current.id===id&&profileDirty.current.dirty){focusAfter.current='circle-draft-stay';setPendingTab({id,tab:next});}else setTab(next);};
  // Links out of the page wait for the same answer as the tabs. Discard then follows the link.
  const leaveFor=(href,onLeave)=>event=>{if(tab!=='settings'||profileDirty.current.id!==id||!profileDirty.current.dirty){onLeave?.();return;}event.preventDefault();focusAfter.current='circle-draft-stay';setPendingTab({id,href,onLeave});};
  const [invite, setInvite] = useState(''), [invitePreset,setInvitePreset]=useState('person');
  const currentCircle = useRef(id);
  const inviteGeneration=useRef(0), inviteBusy=useRef(false);
  if(currentCircle.current!==id){currentCircle.current=id;inviteGeneration.current++;}
  const displayedInvite=invite && invite.circleId===id && invite.requestedPreset===invitePreset ? invite : null;
  const [invitePending,setInvitePending]=useState(false);
  useEffect(() => {inviteGeneration.current++;setInvite('');setInviting(false);setTab('members');profileDirty.current={id,dirty:false};setPendingTab(null);}, [id]);
  const hostNotices = useMemberHost(api, circle ? [circle] : []);
  const memberGroup = data.devices?.circles?.find(c => c.circle === id);
  const members = memberGroup?.members;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!circle && data.circles === undefined && !errors.circles) return <div class="circle-page ph-no-capture" data-telemetry-private="circles"><CircleSkeleton /></div>;
  if (!circle && errors.circles) return <div class="circle-page ph-no-capture" data-telemetry-private="circles"><Card pad><p role="alert">Could not refresh circles. {errorMessage(errors.circles)}</p><Action run={refresh} success="">Retry circles</Action><Button href="#/circles">Switch circle</Button></Card></div>;
  if (!circle) return <div class="circle-page ph-no-capture" data-telemetry-private="circles"><Card pad><h1 class="t-page" ref={headingRef} tabIndex="-1">Circle unavailable</h1><p>Your other circles and this computer are still available.</p><Button href="#/circles">Switch circle</Button></Card></div>;
  if (!circle.origin) return <div class="circle-page ph-no-capture" data-telemetry-private="circles"><Card pad><h1 class="t-page" ref={headingRef} tabIndex="-1">This computer</h1><p>Manage the computers in your circles in Devices.</p><Button href="#/devices">Manage devices</Button></Card></div>;
  const hostingView = circleHostingVM(circle, hosting.data);
  const hostUnreachable = hostNotices.some(({banners}) => banners.some(banner => banner.id === 'host-offline' && !banner.stale));
  const leaveCircle = async () => {
    await mutate('circles/' + enc(id) + '/leave', {});
    go('circles');
  };
  const circleMembership = formatMembership(circle, {surface: 'banner', checking: checkingJoin});
  const joining = circleMembership.phase !== 'approved' ? {...circleMembership, code: circle.joinInfo?.code ?? null} : null;
  const needsOwnerApproval = joining?.phase === 'pending' && !checkingJoin && membershipProjectionFor(circle).invitationPolicy === 'each';
  const owner = safeName(circle.joinInfo?.ownerName, 'the circle’s owner');
  const joiningMessage = needsOwnerApproval
    ? joining.code
      ? `Ask ${owner} to approve this computer. Before approving, they should compare the match code below with the code beside this computer in their approval list.`
      : `Ask ${owner} to approve this computer.`
    : joining?.message;
  // One primary action: Invite while this computer is alone in the circle, Send a job once others are in it.
  const inviteFirst = (members?.length ?? 0) <= 1;
  return <div class="circle-page stack-6 ph-no-capture" data-telemetry-private="circles">
    <a class="back" href="#/circles" onClick={leaveFor('#/circles')}><Icon name="chev-l" size="sm" />Circles</a>
    <div class="circle-header"><div class="hstack-3"><Avatar groupName={circleName(circle)} id={id} /><div class="grow"><h1 class="t-page" ref={headingRef} tabIndex="-1">{circleName(circle)}</h1>{circle.purpose && <p>{safeName(circle.purpose)}</p>}<p class="t-sm t-2">{[hostedHere(circle,hosting.data) ? 'Hosted on this computer' : safeName(circle.joinInfo?.ownerName) ? 'Hosted by ' + safeName(circle.joinInfo.ownerName) : '', members ? members.length + (members.length === 1 ? ' computer' : ' computers') : ''].filter(Boolean).join(' · ')}</p></div></div>
      {(circle.owned||circle.steward||circle.admin) && circle.origin && <Button kind={inviteFirst ? 'primary' : 'secondary'} onClick={() => setInviting(!inviting)} aria-expanded={inviting}>Invite someone</Button>}
    </div>
    {errors.circles && <Card pad><p role="alert">Could not refresh circles. Circle details shown are last-known information. {errorMessage(errors.circles)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry circles</Action></Card>}
    {(errors.devices || memberGroup?.membersLastKnown === true) && <Card pad><p role="alert">Could not refresh members. Any rows and counts shown are last-known information. {errors.devices ? memberReadMessage(errors.devices) : ''}</p><Action className="btn btn-secondary" run={refresh} success="">Retry members</Action></Card>}
    <MemberHostNotices items={hostNotices} />
    {canReadJobs && <CircleJobsNotice id={id} selected data={selectedJobs ? {jobCircleCoverage:selectedJobs.circleCoverage} : data} readError={taskJobs.error ?? (selectedJobs ? null : errors.jobs)} />}
    {!joining && <div><a class={'btn ' + (inviteFirst ? 'btn-secondary' : 'btn-primary')} href="#/new" onClick={leaveFor('#/new', composeIn(id))}>Send a job</a></div>}
    {joining && <Card pad><p>{joiningMessage}</p>{joining.code && <p>Match code <strong>{joining.code}</strong>.{!needsOwnerApproval && ' The owner sees the same code beside this computer’s name.'}</p>}{joining.waiting && <Action run={async () => {setCheckingJoin(true);try{await mutate('circles/' + enc(id) + '/check', {});}finally{setCheckingJoin(false);}focusOutcome();}} success="Checked.">Check approval</Action>}</Card>}
    {inviting && <Card pad class="stack-4">
      <h2>Invite someone you trust</h2>
      <label class="stack-2">Invitation for<select value={invitePreset} disabled={invitePending} onChange={e=>{if(inviteBusy.current)return;inviteGeneration.current++;setInvitePreset(field(e));setInvite('');}}><option value="person">One computer · 24 hours</option><option value="group">Group · 10 computers · 24 hours</option></select></label>
      <InvitationDisclosure group={invitePreset === 'group'} approveEach={circle.approveEach} />
      <InvitationAction className="btn btn-secondary" disabled={invitePending} run={async () => {
        if(inviteBusy.current)return null;
        const generation=inviteGeneration.current, circleId=id, requestedPreset=invitePreset;
        inviteBusy.current=true;setInvitePending(true);
        try {
          const response=await mutate('circles/' + enc(circleId) + '/invite', {preset:requestedPreset});
          const link=validateInvitationResponse(response);
          if(circleId!==currentCircle.current || generation!==inviteGeneration.current)return null;
          return {link,circleId,requestedPreset,generation};
        } finally {inviteBusy.current=false;setInvitePending(false);}
      }} success="Invitation created." onSuccess={v => {if (v.circleId === currentCircle.current && v.generation === inviteGeneration.current) setInvite(v);}}>{displayedInvite ? 'Create another invitation' : 'Create invitation'}</InvitationAction>
      {safeName(data.devices?.ownerName) && <p class="t-sm t-2">It says {safeName(data.devices.ownerName)} invited you. <a href="#/you/profile">Change your name</a></p>}
      {displayedInvite && <><Field label="Invitation link" multiline readOnly value={displayedInvite.link} onFocus={e => e.currentTarget.select()} /><Action run={() => {if(displayedInvite.circleId!==currentCircle.current || displayedInvite.generation!==inviteGeneration.current)return;return navigator.clipboard.writeText(displayedInvite.link);}} success="Invitation copied.">Copy invitation link</Action></>}
    </Card>}
    <Tabs idPrefix="circle-tab" label="Circle sections" panelId="circle-tab-panel"
      items={[{value:'members',label:'Members'},{value:'activity',label:'Activity'},...((circle.owned||circle.steward||circle.admin)?[{value:'invitations',label:'Invitations'}]:[]),{value:'settings',label:'Settings'}]}
      current={tab} onChange={changeTab} />
    <div id="circle-tab-panel" role="tabpanel" aria-labelledby={'circle-tab-' + tab}>
    {pendingTab?.id===id && <Card pad><div role="alertdialog" aria-labelledby="circle-draft-title" aria-describedby="circle-draft-help"><h2 id="circle-draft-title">Discard unsaved circle details?</h2><p id="circle-draft-help">Your Circle name and Purpose changes have not been saved.</p><Button id="circle-draft-stay" onClick={()=>{focusAfter.current='circle-tab-settings';setPendingTab(null);}}>Stay in Settings</Button><Button kind="danger" onClick={()=>{const next=pendingTab;profileDirty.current={id,dirty:false};setPendingTab(null);if(next.href){next.onLeave?.();location.hash=next.href;}else{focusAfter.current='circle-tab-'+next.tab;setTab(next.tab);}}}>Discard changes</Button></div></Card>}
    {tab === 'members' && <div class="stack-4">
      <div class="member-head t-sm t-2"><span>People and their computers</span><span>Availability</span></div>
      {people.error && <Card pad><p role="alert">Could not refresh people. Any names shown are last-known information. {errorMessage(people.error)}</p><Action className="btn btn-secondary" run={people.reloadAndWait} success="">Retry people</Action></Card>}
      {!members ? errors.devices ? null : <CircleSkeleton /> : !members.length ? errors.devices || people.error ? null : <p class="t-sm t-2">No members are listed yet.</p> : people.data?<PeopleList people={people.data} members={members} selfKey={data.devices?.fingerprint} circleId={id} circle={circle} availability={member=>memberAvailability(member,{self:member.key_id===data.devices?.fingerprint,home:data.home,jobs:memberJobs,now:Date.now(),zone})}/>: <ul class="list card">{members.map(member => {
        const self = member.key_id === data.devices?.fingerprint;
        const name = circlePerson({...member, ownerName:self ? data.devices?.ownerName : member.ownerName}, {self, deviceName:data.devices?.name});
        const machine = circlePerson({device_name:member.device_name});
        const availability = memberAvailability(member, {self, home:data.home, jobs:memberJobs, now:Date.now(), zone});
        return <li key={member.key_id} class="member-row"><Avatar personName={self ? data.devices?.ownerName : member.localName || member.personName} id={member.key_id} /><div class="grow"><b>{name}</b>{!self && machine !== 'Unnamed computer' && machine !== name && <span class="t-sm t-2"> · {machine}</span>}{self && <p class="t-sm t-2">This computer</p>}<p class="t-xs t-2">{deviceUsage(member.requesterLimits)}</p></div><span class={'member-availability ' + (availability.kind ? 'st ' + availability.kind : 't-sm t-2')}>{availability.word}</span>{!self && <MemberMenu {...{member,name,circle,mutate,setDialog}} />}</li>;
      })}</ul>}
      <p class="t-xs t-2">Availability comes from a recent report by each computer. A past job does not mean it is online now.</p>
      {(circle.owned||circle.steward||circle.admin) && !pending.error && pending.data?.length > 0 && <Button onClick={() => {setTab('settings');requestAnimationFrame(() => document.getElementById('circle-tab-settings')?.focus());}}>{pending.data.length} waiting to join</Button>}
    </div>}
    {tab === 'invitations' && (circle.owned||circle.steward||circle.admin) && <Invitations circleId={id} {...{api,revision,mutate,setDialog}} />}
    {tab === 'activity' && <Activity data={data} circleId={id} api={api} revision={revision} />}
    {tab === 'settings' && <div class="stack-6">
      <CircleProfileSettings key={id} {...{circle,mutate}} onDirtyChange={dirty=>{profileDirty.current={id,dirty};}} />
      <Card pad class="stack-3"><h2>Agents on this computer</h2>
        <p class="t-sm t-2">Agents running as you may send jobs to this circle without asking. They can send only what you committed.</p>
        <p class="t-sm t-2">Turning this off stops new sends. Jobs already sent keep running.</p>
        <p>{lending.agentBorrowing?.[id]===true?'Allowed':'Ask each time'}</p>
        <Action run={()=>mutate('circles/'+enc(id)+'/agent-borrowing',{enabled:lending.agentBorrowing?.[id]!==true})} success="Saved.">{lending.agentBorrowing?.[id]===true?'Ask each time':'Allow agents to send to this circle'}</Action>
      </Card>
      <Card pad class="stack-4"><h2>Person identity</h2><p class="t-sm t-2">Before using computer links, member roles or circle exit controls, everyone in this circle must update Faravan.</p><ComputerLink {...{circle,members:members??[],selfKey:data.devices?.fingerprint,mutate}}/></Card>
      <CircleAuthority {...{circle,members:members??[],selfKey:data.devices?.fingerprint,mutate,setDialog}}/>
      <CircleExits {...{circle,mutate,setDialog}}/>
      {(circle.owned||circle.steward||circle.admin) && <Card pad class="stack-6"><ApprovalMode {...{circle,mutate}} /><section class="stack-3"><h2>Waiting to join</h2>{pending.error ? <div><p role="alert">{errorMessage(pending.error)}</p><Action run={pending.reloadAndWait} success="">Retry approvals</Action></div> : pending.data === null && circle.origin ? <CircleSkeleton /> : !pending.data?.length ? <p class="t-sm t-2">No computers are waiting for approval.</p> : pending.data.map(item => {const v=enrollmentView(item);return <div class="stack-2" key={v.id}><b>{v.name}</b>{v.verified ? v.code && <p>Match code <strong>{v.code}</strong></p> : <p>This request does not match your invitation, so it cannot be approved.</p>}{v.verified && <p>Before approving, ask this person for the match code through your trusted conversation. Approve only if it matches the code shown here.</p>}{v.verified && <Action once run={async () => {await mutate('circles/' + enc(id) + '/approve', {enrollmentId:v.id});focusOutcome();}} success="Approved. Approving membership does not turn lending on.">Approve {v.name}</Action>}<Action once run={async () => {await mutate('circles/' + enc(id) + '/reject', {enrollmentId:v.id});focusOutcome();}} success="Declined.">Decline request</Action></div>;})}</section></Card>}
      <MemberOrigins {...{circle,api,revision,mutate,setDialog}} />
      <MemberAddress {...{circle,api,revision,mutate,setDialog}} />
      <Card pad class="stack-3"><h2>{circle.owned ? 'Hosting' : 'Membership'}</h2>{circle.owned ? <><p class="t-sm t-2">{hostingView.text}</p>{hosting.error && <p role="alert">{errorMessage(hosting.error)}</p>}{hostingView.canStop && <><Button href="#/circles/host">Hosting details</Button><Button kind="danger" href="#/circles/host">Stop hosting</Button></>}</> : <><p class="t-sm t-2">Leaving stops the active job and cancels waiting requests in this circle. Files and results already shared stay shared.</p>{hostUnreachable ? <Action className="btn btn-danger" run={leaveCircle} success="">Leave unreachable circle</Action>
        : <Button kind="danger" onClick={() => setDialog({title:'Leave ' + circleName(circle) + '?', confirmLabel:'Leave circle', cancelLabel:'Stay', children:<p>Your active job stops and waiting requests in this circle are cancelled. Files and results already shared stay shared.</p>, onConfirm:leaveCircle})}>Leave circle</Button>}</>}</Card>
    </div>}
    </div>
  </div>;
}
