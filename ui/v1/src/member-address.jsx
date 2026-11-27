import {useState} from 'preact/hooks';
import {Card} from './ds/index.mjs';
import {Action, useResource, enc} from './shared.jsx';
import {errorMessage, safeName} from './helpers.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';

// This computer's own address for one circle (owner-offline topology), in Circle settings. The member reviews and
// approves the route for their own listener, starts it, and sends the verified address for approval; an owner,
// steward or admin reviews and approves that exact request. Every step is a button. Nothing opens on page open, and
// the page never shows a provider handle or a local listener target: only a state and the public host name.

const INTRO = 'An address lets other computers in this circle reach this one when the owner’s computer is off. Nothing is shared with the circle until you send the address and an owner approves it.';
const NOTES = {
  unavailable: 'No address is available on this computer right now. Try again in a moment.',
  offer_changed: 'The offer changed. Review it again.',
  needs_approval: 'Review and approve the address first.',
  start_failed: 'The address did not start, so nothing was shared. Review it and try again.',
  route_lost: 'The address stopped working, so nothing was sent. Review it again.',
  host_offline: 'The circle’s host did not answer. Send the address again when it is back.',
  host_unsupported: 'This circle’s host runs an older Faravan and cannot take an address yet. Ask the owner to update it.',
};

/** What the member sees for each state of their address, and the one next action. */
export function memberAddressCopy(state, address) {
  switch (state) {
    case 'off': return {text: INTRO, action: 'review', label: 'Review address'};
    case 'approved': return {text: 'Address approved. Start it to check that it works. Nothing is shared with the circle.', action: 'start', label: 'Start address'};
    case 'starting': return {text: 'Starting the address…'};
    case 'ready': return {text: `The address ${address} works. Send it to ask an owner to approve it. Other computers do not see it until then.`, action: 'send', label: 'Send for approval'};
    case 'sent': return {text: `Sent ${address} for approval. Other computers do not see it until an owner approves it.`, action: 'check', label: 'Check for approval'};
    case 'signed': return {text: `An owner approved ${address}. It is in the circle’s signed member list.`};
    case 'lost': return {text: 'The address stopped working. Review it again to open a new one.', action: 'review', label: 'Review address'};
    default: return null;
  }
}

export function MemberAddressBody({view, error, note, onReload, run}) {
  const copy = memberAddressCopy(view?.state, view?.address);
  if (!copy && !error) return null;
  return <Card pad class="stack-3 ph-no-capture" data-telemetry-private="member-address">
    <h2>Address for this computer</h2>
    {error ? <><p role="alert">{errorMessage(error)}</p><Action run={onReload} success="">Retry address check</Action></>
      : <>
        <p class="t-sm t-2" role={view.state === 'starting' ? 'status' : undefined}>{copy.text}</p>
        {note && <p class="t-sm" role="status">{note}</p>}
        {copy.action && <div><Action run={() => run(copy.action)} success={copy.action === 'check' ? 'Checked.' : ''}>{copy.label}</Action></div>}
      </>}
  </Card>;
}

export function MemberAddress({circle, api, revision, mutate, setDialog}) {
  const eligible = Boolean(circle.origin) && !circle.owned && membershipProjectionFor(circle).phase === 'approved';
  const base = 'circles/' + enc(circle.id) + '/member-address';
  const view = useResource(api, eligible ? base : null, revision, {poll: 20000});
  const [note, setNote] = useState('');
  const step = (action, body = {}) => mutate(base + '/' + action, body);
  const reload = () => view.reloadAndWait();
  async function run(action) {
    setNote('');
    if (action === 'review') {
      const result = await step('review');
      if (result.outcome !== 'offer') setNote(NOTES.unavailable);
      else setDialog({
        title: 'Open an address for this computer?', confirmLabel: 'Approve address',
        children: <div class="stack-3"><p>{safeName(result.offer.label, 'An address service')} will give this computer an internet address.</p>
          {result.offer.needs && <p>{safeName(result.offer.needs)}</p>}
          <p>Only signed Faravan circle requests reach this computer through it. Nothing else on this computer is served. Quitting Faravan closes the address. Nothing is shared with the circle yet.</p></div>,
        onConfirm: async () => {
          const done = await step('approve', {providerId: result.offer.providerId, consentFactsDigest: result.offer.consentFactsDigest});
          await reload();
          setNote(done.outcome === 'approved' ? '' : NOTES.offer_changed);
        },
      });
    } else if (action === 'start') {
      const result = await step('start');
      setNote(result.outcome === 'live' ? '' : NOTES[result.outcome === 'unavailable' ? 'start_failed' : result.outcome] ?? NOTES.start_failed);
    } else if (action === 'send') {
      const result = await step('send');
      setNote(result.outcome === 'sent' ? '' : NOTES[result.outcome] ?? NOTES.route_lost);
    } else if (action === 'check') {
      await mutate('circles/' + enc(circle.id) + '/check', {});
    }
    await reload();
  }
  if (!eligible) return null;
  return <MemberAddressBody view={view.data} error={view.error} note={note} onReload={reload} run={run} />;
}

const REQUEST_NOTES = {
  published: name => `Approved. ${name} can now be reached at this address.`,
  already_published: () => 'This address is already approved.',
  changed: name => `The request from ${name} changed. Review the current request.`,
  withdrawn: name => `${name} withdrew this address.`,
  expired: name => `This request expired. Ask ${name} to send it again.`,
  stale: () => 'The circle changed while you were reviewing. Review the request again.',
  gone: () => 'This request is no longer here.',
  host_offline: () => 'The circle’s host did not answer. Try again when it is back. If the address was approved, this list shows it.',
};

export function MemberOriginRow({item, note, onApprove}) {
  const name = safeName(item.name, 'This computer');
  const signed = item.state === 'proposed' && item.address && item.signedAddress === item.address;
  return <div class="stack-2">
    <b>{name}</b>
    {signed ? <p class="t-sm t-2">{item.address} is in the signed member list.</p>
      : item.state === 'proposed' ? <p class="t-sm t-2">Offers the address {item.address}. Approving adds it to the circle’s signed member list.</p>
      : item.state === 'withdrawn' ? <p class="t-sm t-2">{name} withdrew the address. There is nothing to approve.</p>
      : <p class="t-sm t-2">This request expired. Ask {name} to send it again.</p>}
    {item.state === 'proposed' && !signed && <div><Action run={() => onApprove(item)} success="">Approve address for {name}</Action></div>}
    {note && <p class="t-sm" role="status">{note}</p>}
  </div>;
}

export function MemberOriginsBody({items, unsupported, error, notes, onReload, onApprove}) {
  if (!error && !unsupported && !items?.length) return null;
  return <Card pad class="stack-4 ph-no-capture" data-telemetry-private="member-address">
    <h2>Computer addresses</h2>
    {error ? <><p role="alert">{errorMessage(error)}</p><Action run={onReload} success="">Retry address requests</Action></>
      : unsupported ? <p class="t-sm t-2">This circle’s host runs an older Faravan and cannot take computer addresses yet. Update it to use them.</p>
      : items.map(item => <MemberOriginRow key={item.keyId} item={item} note={notes?.[item.keyId]} onApprove={onApprove} />)}
  </Card>;
}

export function MemberOrigins({circle, api, revision, mutate, setDialog}) {
  const eligible = Boolean(circle.origin) && Boolean(circle.owned || circle.steward || circle.admin);
  const base = 'circles/' + enc(circle.id) + '/member-origins';
  const list = useResource(api, eligible ? base : null, revision, {poll: 20000});
  const [notes, setNotes] = useState({});
  const approve = item => {
    const name = safeName(item.name, 'This computer');
    setDialog({
      title: `Approve ${item.address} for ${name}?`, confirmLabel: 'Approve address',
      children: <p>This adds the address to the circle’s signed member list. Other computers in this circle can then use it to reach {name}, including when the owner’s computer is off. Approve only if {name} asked you to.</p>,
      onConfirm: async () => {
        const result = await mutate(base + '/accept', {keyId: item.keyId, proposalDigest: item.proposalDigest, rosterEpoch: item.rosterEpoch});
        // The dialog closes after the page shows the current requests, so a new click never meets an old dialog.
        await list.reloadAndWait();
        setNotes(old => ({...old, [item.keyId]: (REQUEST_NOTES[result.outcome] ?? REQUEST_NOTES.gone)(name)}));
      },
    });
  };
  if (!eligible) return null;
  return <MemberOriginsBody items={list.data?.items} unsupported={list.data?.unsupported} error={list.error} notes={notes}
    onReload={() => list.reloadAndWait()} onApprove={approve} />;
}
