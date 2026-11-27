import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Card, Field } from './ds/index.mjs';
import { Action, Connection, field } from './shared.jsx';
import { autostartVM } from './settings-model.mjs';
import { errorMessage } from './helpers.mjs';

export function profileNameValue(remote, confirmed) {
  return confirmed ?? remote ?? '';
}

export function finishProfileNameSave({ draft, submitted, responseValue }) {
  return {
    confirmed: responseValue,
    draft: draft?.trim() === submitted ? null : draft,
  };
}

export function nameEditState(draft, saved, pending = false) {
  return {dirty: draft !== null && draft !== saved, canSave: !pending && Boolean(draft?.trim()) && draft.trim() !== saved};
}

function NameField({ label, fieldName, maxLength, data, mutate, confirmed, setConfirmed }) {
  const {offline} = useContext(Connection);
  const remote = data.devices[fieldName] ?? '';
  const saved = profileNameValue(remote, confirmed[fieldName]);
  const [draft, setDraft] = useState(null), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  const draftRef = useRef(draft), pendingRef = useRef(false), formRef = useRef(null);
  const value = draft ?? saved;
  const edit = nameEditState(draft, saved, saving || offline);
  const focusInput = () => formRef.current?.querySelector('input')?.focus();
  function change(event) {
    draftRef.current = field(event);setDraft(draftRef.current);setMessage('');
  }
  async function saveName() {
    if (offline || !nameEditState(draftRef.current, saved, pendingRef.current).canSave) return;
    const submitted = draftRef.current.trim();
    pendingRef.current = true;setSaving(true);
    try {
      const result = await mutate('devices', {[fieldName]: submitted});
      const finished = finishProfileNameSave({draft: draftRef.current, submitted, responseValue: result?.[fieldName] ?? submitted});
      draftRef.current = finished.draft;setDraft(finished.draft);
      setConfirmed(previous => ({...previous, [fieldName]: finished.confirmed}));
      setMessage(fieldName === 'ownerName' ? 'Your name was saved.' : 'Computer name was saved.');
      focusInput();
      return result;
    } catch (error) {setMessage(errorMessage(error));throw error;}
    finally {pendingRef.current = false;setSaving(false);}
  }
  return <form class="ph-no-capture" ref={formRef} onSubmit={event => {event.preventDefault();saveName().catch(() => {});}} data-telemetry-private="profile">
    <Field id={'setting-' + fieldName} label={label} value={value} maxLength={maxLength} onInput={change} />
    <p class="t-sm t-2">{fieldName === 'ownerName' ? 'Use the name you want people to recognize.' : 'Use a different name for each computer, such as Ana’s Linux desktop or Ana’s MacBook.'}</p>
    {(saving || edit.dirty) && <div class="hstack-2">
      <button type="submit" class="btn btn-secondary" disabled={!edit.canSave}>Save {fieldName === 'ownerName' ? 'your name' : 'computer name'}</button>
      <button type="button" class="btn btn-quiet" disabled={saving} onClick={() => {draftRef.current = null;setDraft(null);setMessage('Unsaved changes discarded.');focusInput();}}>Discard unsaved changes</button>
    </div>}
    {edit.dirty && !draft?.trim() && <p class="t-sm">{fieldName === 'ownerName' ? 'Enter a name before saving.' : 'Enter a computer name before saving.'}</p>}
    {edit.dirty && draft?.trim() === saved && <p class="t-sm">No changes to save.</p>}
    {edit.dirty && offline && <p class="t-sm">Reconnect to save. Your edit is still here.</p>}
    <p role="status" aria-live="polite">{message}</p>
  </form>;
}

export function LaunchAtLogin({data,mutate,refresh}) {
  const view=autostartVM(data.home?.desktop?.autostart);
  if(!view)return null;
  return <Card pad class="stack-4 ph-no-capture" data-telemetry-private="profile">
    <div class="stack-2"><h2 class="t-section">Launch at login</h2><p class="t-2">{view.text}</p>
      <p class="t-sm t-2">Lending follows your existing choice. You can change it on Lend.</p></div>
    <div class="pair">{view.action&&<Action className="btn btn-secondary" success="Login preference saved." run={async()=>{
      await mutate('desktop/autostart',{enabled:view.enabled});await refresh();
    }}>{view.action}</Action>}
    {view.turnOff&&<Action className="btn btn-secondary" success="Login preference saved." run={async()=>{
      await mutate('desktop/autostart',{enabled:false});await refresh();
    }}>Turn off launch at login</Action>}</div>
  </Card>;
}

export function ComputerProfile({ data, mutate, refresh, errors = {} }) {
  const devices = data.devices;
  const [confirmed, setConfirmed] = useState({});

  useLayoutEffect(() => {
    if (!devices) return;
    setConfirmed(previous => {
      let changed = false;
      const next = {...previous};
      for (const key of ['ownerName', 'name']) {
        if (previous[key] !== undefined && devices[key] === previous[key]) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [devices?.ownerName, devices?.name, confirmed]);

  if (!devices) return <div class="circle-page ph-no-capture" data-telemetry-private="profile">
    {errors.devices
      ? <Card pad><p role="alert">{errorMessage(errors.devices)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry profile</Action></Card>
      : <div class="circle-skeleton" role="status" aria-label="Loading profile"><span /><span /><span /></div>}
  </div>;

  return <div class="circle-page stack-6 ph-no-capture" data-telemetry-private="profile">
    {errors.devices && <Card pad><p role="alert">{errorMessage(errors.devices)}</p><Action className="btn btn-secondary" run={refresh} success="">Retry profile</Action></Card>}
    <Card pad class="stack-4">
      <NameField label="Your name" fieldName="ownerName" maxLength="64" {...{data, mutate, confirmed, setConfirmed}} />
    </Card>
    <Card pad class="stack-4">
      <NameField label="Computer name" fieldName="name" maxLength="256" {...{data, mutate, confirmed, setConfirmed}} />
    </Card>
    <LaunchAtLogin {...{data,mutate,refresh}} />
  </div>;
}
