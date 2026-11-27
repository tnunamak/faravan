import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Card } from './ds/index.mjs';
import { phoneVM, phoneErrorText } from './phone-view.mjs';
import { enc } from './shared.jsx';

// Settings › Pairing (briefs/shell-access-integration.md). Props: api ({get, post}), and optionally live (the latest
// `phone` SSE event's data) so a device claiming the code shows up without a reload. The "Is this your device?" step is
// the security boundary: never confirmed automatically, and its confirm button is never where "Pair a device" was.
export function Phone({ api, initial = null, live = null, now: fixedNow = null }) {
  const [view, setView] = useState(initial), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [removing, setRemoving] = useState(null), [now, setNow] = useState(() => fixedNow ?? Date.now()), [attempt, setAttempt] = useState(0);
  const outcome = useRef(null), heading = useRef(null);
  useEffect(() => { if (live) setView(current => ({...live, confirmHere: live.confirmHere ?? current?.confirmHere ?? false})); }, [live]);
  useEffect(() => {
    if (initial || !api?.get) return undefined;
    let active = true;
    setError('');
    api.get('phone').then(value => { if (active) setView(value); }, failure => { if (active) setError(phoneErrorText(failure)); });
    return () => { active = false; };
  }, [api, attempt]);
  const vm = phoneVM(view, {now});
  useEffect(() => {
    if (!['waiting', 'claimed'].includes(vm.state) || fixedNow) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [vm.state]);
  // The claimed step moves focus to its question, so a keyboard or screen-reader user meets the decision first.
  useLayoutEffect(() => { if (vm.state === 'claimed') heading.current?.focus(); }, [vm.state]);
  const act = async (id, run) => {
    if (pending) return;
    setPending(id); setError('');
    try { setView(await run()); return true; }
    catch (failure) { setError(phoneErrorText(failure)); requestAnimationFrame(() => outcome.current?.focus()); return false; }
    finally { setPending(''); }
  };
  const post = (path, body = {}) => api.post(path, body);
  const turnOn = () => act('on', () => post('phone/settings', {enabled: true, address: view?.address || undefined, hostname: view?.hostname, certFile: view?.certFile, keyFile: view?.keyFile}));
  const turnOff = () => act('off', () => post('phone/settings', {enabled: false, address: view?.address || undefined, hostname: view?.hostname, certFile: view?.certFile, keyFile: view?.keyFile}));
  const busy = id => pending === id ? 'true' : undefined;
  const facts = vm.facts.length > 0 && <ul class="stack-2 t-sm ph-no-capture" data-telemetry-private="phone">{vm.facts.map(line => <li key={line}>{line}</li>)}</ul>;
  return <section class="info-section phone-settings ph-no-capture" data-telemetry-private="phone" aria-labelledby="phone-title">
    <h2 id="phone-title" class="t-title2">Pairing</h2>
    <p>Use Faravan on this computer from another device. Paired devices connect to this computer directly; nothing goes through a Faravan server.</p>
    {vm.state !== 'claimed' && <p class="t-sm t-2" role={error ? 'alert' : 'status'} tabIndex="-1" ref={outcome}>{error}</p>}
    {error && !view && <button type="button" class="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>Try again</button>}
    {vm.state === 'loading' && !error && <p role="status">Loading device access…</p>}
    {vm.state === 'off' && <>
      <button type="button" class="btn btn-primary" aria-busy={busy('on')} disabled={!!pending} onClick={turnOn}>Turn on device access</button>
      {vm.headline && <><h3 class="t-title3">{vm.headline}</h3>{facts}</>}
    </>}
    {['problem', 'starting'].includes(vm.state) && <Card pad class="stack-3">
      <h3 class="t-title3">{vm.headline || 'Device access isn’t ready'}</h3>{facts}
      <div class="hstack-2 wrap">
        {vm.state === 'problem' && <button type="button" class="btn btn-primary" aria-busy={busy('on')} disabled={!!pending} onClick={turnOn}>Try again</button>}
        <button type="button" class="btn btn-secondary" aria-busy={busy('off')} disabled={!!pending} onClick={turnOff}>Turn off</button>
      </div>
    </Card>}
    {vm.state === 'on' && <Card pad class="stack-3">
      <h3 class="t-title3">{vm.headline}</h3>
      {vm.origin && <p class="t-sm t-2">Devices open <code style={{overflowWrap: 'anywhere'}}>{vm.origin}</code></p>}
      {vm.ended && <p class="t-sm" role="status">{vm.ended}</p>}
      {facts}
      {view?.fullAvailable === true && <p class="t-sm t-2">Choose access before pairing. The default lets a device see requests to this computer. The full-app option also lets it send jobs and change settings.</p>}
      <div class="hstack-2 wrap">
        <button type="button" class="btn btn-primary" aria-busy={busy('pair')} disabled={!!pending} onClick={() => act('pair', () => post('phone/pairing'))}>Pair a device</button>
        {view?.fullAvailable === true && <button type="button" class="btn btn-secondary" aria-busy={busy('pairFull')} disabled={!!pending} onClick={() => act('pairFull', () => post('phone/pairing', {access: 'full'}))}>Pair a device for the full app</button>}
        <button type="button" class="btn btn-secondary" aria-busy={busy('off')} disabled={!!pending} onClick={turnOff}>Turn off</button>
      </div>
    </Card>}
    {vm.state === 'waiting' && <Card pad class="stack-3 phone-pairing">
      {!vm.expired && <><h3 class="t-title3">{vm.pairing.qr ? 'Scan this with your device’s camera' : 'Enter this code on your device'}</h3>
      {/* Data, not markup: black squares on white in both themes, so every phone camera reads it. */}
      {vm.pairing.qr && <svg class="phone-qr" viewBox={'0 0 ' + vm.pairing.qr.size + ' ' + vm.pairing.qr.size} role="img" aria-label="QR code with the pairing link" shape-rendering="crispEdges">
        <rect width={vm.pairing.qr.size} height={vm.pairing.qr.size} fill="#fff" /><path fill="#000" d={vm.pairing.qr.d} /></svg>}
      <p>{vm.pairing.qr ? 'Or open' : 'Open'} <code style={{overflowWrap: 'anywhere'}}>{vm.pairing.shownUrl}</code> on your device and enter <strong class="phone-code">{vm.pairing.code}</strong></p></>}
      {vm.expired && <h3 class="t-title3">Pairing code expired</h3>}
      <p class="t-sm t-2">{vm.countdown}</p>
      {vm.expired && <button type="button" class="btn btn-primary" aria-busy={busy('pair')} disabled={!!pending} onClick={() => act('pair', () => post('phone/pairing'))}>Pair a device again</button>}
      <div><button type="button" class="btn btn-secondary" disabled={!!pending} onClick={() => act('cancel', () => post('phone/pairing/cancel', {id: vm.pairing.id}))}>Cancel</button></div>
    </Card>}
    {vm.state === 'claimed' && <Card pad class="stack-4 phone-confirm">
      {error && <p role="alert" tabIndex="-1" ref={outcome}>{error}</p>}
      <h3 class="t-title2" tabIndex="-1" ref={heading}>Is this your device?</h3>
      {vm.validPhrase ? <><p>“{vm.phoneLabel}”{vm.phoneAddress ? ' at ' + vm.phoneAddress : ''} wants to pair. Pair only if your device shows exactly these three words:</p>
      <p class="phone-phrase" lang="en">{vm.phrase.join(' · ')}</p></> : <p role="alert">The pairing words didn’t arrive — cancel and try again.</p>}
      <div class="t-sm stack-2">
        <p>{vm.grants.can.length ? 'This device will be able to: ' + vm.grants.can.join('; ') + '.' : 'This device will not be able to do anything yet.'}</p>
        <p class="t-2">It can’t: {vm.grants.cannot.join('; ')}.</p>
      </div>
      {!vm.confirmHere && <div class="stack-2"><p role="status">Waiting for you to confirm on {vm.computer}…</p>
        <p>Open Faravan on {vm.computer} and check the words there.</p></div>}
      <div class="hstack-2 wrap phone-confirm-actions">
        {!vm.confirmHere && <button type="button" class="btn btn-secondary" disabled={!!pending} onClick={() => act('cancel', () => post('phone/pairing/cancel', {id: vm.pairing.id}))}>Cancel</button>}
        {vm.confirmHere && <>
        <button type="button" class="btn btn-secondary" aria-busy={busy('reject')} disabled={!!pending} onClick={() => act('reject', () => post('phone/pairing/confirm', {id: vm.pairing.id, confirmed: false}))}>They don’t match</button>
        {vm.validPhrase && <button type="button" class="btn btn-primary" aria-busy={busy('confirm')} disabled={!!pending} onClick={() => act('confirm', () => post('phone/pairing/confirm', {id: vm.pairing.id, confirmed: true}))}>The words match — pair</button>}
        </>}
      </div>
    </Card>}
    {view?.reach && <details class="phone-connection">
      <summary>Connection settings</summary>
      <form class="stack-4 mt-4" key={[view.address, view.hostname, view.certFile, view.keyFile].join('|')} onSubmit={event => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        act('connection', () => post('phone/settings', {enabled: view.enabled === true,
          ...Object.fromEntries(['address', 'hostname', 'certFile', 'keyFile'].map(key => [key, String(values.get(key) || '').trim() || null]))}));
      }}>
        <label class="stack-2">Private network address
          <select class="input" name="address" defaultValue={view.address || vm.addresses[0]?.address || ''}>
            {vm.addresses.map(item => <option value={item.address} key={item.address}>{item.address} · {item.interface} · {item.kind === 'tailnet' ? 'Private network' : 'Local network'}</option>)}
          </select>
        </label>
        <p class="t-sm t-2">Choose the network your device can reach. This computer must stay awake.</p>
        <label class="stack-2">Host name <span class="t-sm t-2">Optional; must resolve to this computer and match the certificate.</span>
          <input class="input" name="hostname" defaultValue={view.hostname || ''} placeholder="faravan.home.example" autoComplete="off" />
        </label>
        <p class="t-sm">To answer requests and install the device app, use an HTTPS certificate your device trusts. Enter file paths on this computer. Faravan does not create a certificate or change your network.</p>
        <label class="stack-2">Certificate file<input class="input" name="certFile" defaultValue={view.certFile || ''} placeholder="/path/to/certificate.pem" autoComplete="off" /></label>
        <label class="stack-2">Private key file<input class="input" name="keyFile" defaultValue={view.keyFile || ''} placeholder="/path/to/private-key.pem" autoComplete="off" /></label>
        <p class="t-sm t-2">Leave both file paths blank for view only over HTTP. After adding HTTPS, pair a device again to let it answer requests. Saving an active connection reconnects paired devices.</p>
        <div><button type="submit" class="btn btn-secondary" disabled={!!pending} aria-busy={busy('connection')}>Save connection</button></div>
      </form>
    </details>}
    {vm.phones.length > 0 && <section class="stack-2" aria-labelledby="phones-title">
      <h3 id="phones-title" class="t-title3">Paired devices</h3>
      <Card><ul class="list">{vm.phones.map(phone => <li key={phone.id} class="row">
        <div class="row-main"><div class="row-title">{phone.label}</div><div class="row-meta">{[phone.access, phone.meta].filter(Boolean).join(' · ')}</div></div>
        {removing === phone.id ? <div class="hstack-2 wrap"><span class="t-sm">Remove {phone.label}? It’s signed out at once.</span>
          <button type="button" class="btn btn-danger btn-sm" disabled={!!pending} onClick={async () => { if (await act('remove', () => post('phone/phones/' + enc(phone.id) + '/revoke'))) setRemoving(null); }}>Remove</button>
          <button type="button" class="btn btn-quiet btn-sm" onClick={() => setRemoving(null)}>Keep</button></div>
          : <button type="button" class="btn btn-secondary btn-sm" onClick={() => setRemoving(phone.id)}>Remove</button>}
      </li>)}</ul></Card>
    </section>}
  </section>;
}
