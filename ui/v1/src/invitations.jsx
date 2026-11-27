import {Card, Button} from './ds/index.mjs';
import {Action, enc, useResource} from './shared.jsx';
import {errorMessage} from './helpers.mjs';
import {invitationVM} from './invitations-view.mjs';
import {formatDate} from './dates.mjs';

// Invitation times are records: the exact local time with its zone, from the shared formatter.
export function invitationTime(value) {
  return value ? formatDate(value, 'exact') : '';
}

export function InvitationList({items,error,refresh,circleId,mutate,setDialog}) {
  if(error)return <Card class="ph-no-capture" pad data-telemetry-private="invitations"><p role="alert">{errorMessage(error)}</p><Action run={refresh} success="">Retry invitations</Action></Card>;
  if(!items)return <p class="ph-no-capture" role="status" data-telemetry-private="invitations">Loading invitations…</p>;
  if(!items.length)return <p class="t-sm t-2 ph-no-capture" data-telemetry-private="invitations">No invitations created on this computer yet.</p>;
  return <ul class="list stack-4 ph-no-capture" aria-label="Invitations" data-telemetry-private="invitations">{items.map(item=>{
    const view=invitationVM(item,invitationTime);
    return <li key={view.id}><Card pad class="stack-3">
      <div class="hstack-3 wrap"><h3 class="t-title3 grow">{view.title}</h3><span class="pill neutral">{view.state}</span></div><p class="t-sm t-2">{view.created}<br />{view.expires}</p>
      <p class="t-sm">{view.usage}</p>
      {item.state==='revocation_unconfirmed'&&<p class="t-sm">The host has not confirmed this revoke. The link may still work. Retry to confirm.</p>}
      {view.canRevoke&&<Button kind="danger" onClick={()=>setDialog({title:'Revoke this invitation?',confirmLabel:'Revoke invitation',children:<p>The link will stop working and requests still waiting for approval will be declined. Computers already approved keep their access. Copies of shared files stay shared.</p>,onConfirm:async()=>{const result=await mutate('circles/'+enc(circleId)+'/invitations/revoke',{inviteId:view.id});await refresh();return result;}})}>Revoke invitation</Button>}
    </Card></li>;
  })}</ul>;
}
export function Invitations({circleId,api,revision,mutate,setDialog}) {
  const resource=useResource(api,'circles/'+enc(circleId)+'/invitations',revision);
  return <section class="stack-4 ph-no-capture" aria-label="Invitation history" data-telemetry-private="invitations"><Action className="btn btn-secondary" run={resource.reloadAndWait} success="">Refresh invitations</Action>
    {resource.data?.length !== 0 && <p class="t-sm t-2">Created on this computer.</p>}
    <InvitationList items={resource.data} error={resource.error} refresh={resource.reloadAndWait} {...{circleId,mutate,setDialog}} />
  </section>;
}
