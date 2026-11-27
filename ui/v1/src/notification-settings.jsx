import {errorMessage} from './helpers.mjs';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Card, Switch } from './ds/index.mjs';
import { notificationSettingsVM, createNotificationSettingsEditor } from './notification-settings-model.mjs';

export function NotificationSettings({api, initialSettings = null}) {
  const [editorState, setEditorState] = useState({saved:initialSettings, draft:null, status:'idle', error:'', notice:''});
  const editor = useRef(null);
  if (!editor.current) editor.current = createNotificationSettingsEditor(initialSettings, setEditorState);
  const {saved, draft, status, error:saveError, notice} = editorState;
  const pending = status === 'saving' || status === 'checking';
  const locked = status !== 'idle';
  const [loading, setLoading] = useState(!initialSettings);
  const [readError, setReadError] = useState('');
  const [readVersion, setReadVersion] = useState(0);
  const outcome = useRef(null), focusOutcome = useRef(false);

  useEffect(() => {
    if (initialSettings || !api) return;
    const controller = new AbortController();
    setLoading(true); setReadError('');
    api.get('notification-settings', controller.signal).then(settings => {
      notificationSettingsVM(settings);
      if (!controller.signal.aborted) {editor.current.load(settings); setLoading(false);}
    }).catch(error => {
      if (!controller.signal.aborted) {
        setReadError(errorMessage(error)); setLoading(false);
      }
    });
    return () => controller.abort();
  }, [api, initialSettings, readVersion]);

  useLayoutEffect(() => {
    if (focusOutcome.current && !pending) {
      outcome.current?.focus({preventScroll:true}); focusOutcome.current = false;
    }
  }, [pending, notice, saveError]);

  const settings = draft ?? saved;
  const dirty = editor.current.dirty;

  async function save() {
    focusOutcome.current = true;
    await editor.current.save(api);
  }

  async function checkSaved() {
    focusOutcome.current = true;
    await editor.current.reconcile(api);
  }

  return <section class="notification-settings" aria-labelledby="notification-settings-title">
    <div class="stack-2"><h2 id="notification-settings-title" class="t-title2">Notifications on this computer</h2>
      <p class="t-sm t-2">Choose which events to keep in history and request as desktop notifications. Desktop delivery also depends on Faravan running; your computer's notification permissions and Do Not Disturb settings still apply.</p>
    </div>
    {loading ? <p role="status">Loading notification settings…</p> : readError ? <div class="stack-3">
      <p role="alert">{readError}</p><button class="btn btn-secondary" type="button" onClick={() => setReadVersion(version => version + 1)}>Retry notification settings</button>
    </div> : settings && <>
      <Card class="notification-card">
        <table class="notification-table">
          <thead><tr><th scope="col" aria-label="Category" /><th scope="col">History</th><th scope="col">Desktop</th></tr></thead>
          <tbody>{notificationSettingsVM(settings).map(row => <tr key={row.key}>
            <th class="notification-category" scope="row"><span class="notification-category-name">{row.label}</span><span class="notification-category-hint t-sm t-2">{row.description}</span></th>
            {['history','desktop'].map(channel => <td class="notification-channel" key={channel}><Switch checked={row.value[channel]} label={row.label + ': ' + (channel === 'history' ? 'history' : 'desktop notifications')} disabled={locked} onChange={value => editor.current.edit(row.key, channel, value)} /></td>)}
          </tr>)}</tbody>
        </table>
      </Card>
      <div class={'notification-footer' + (dirty ? ' has-changes' : '')}>
        <p class="t-sm" role={saveError ? 'alert' : 'status'} tabIndex="-1" ref={outcome}>{saveError || notice || (dirty ? 'You have unsaved changes.' : '')}</p>
        {(status === 'unknown' || status === 'checking') && <button class="btn btn-secondary" type="button" disabled={pending} onClick={checkSaved}>{pending ? 'Checking saved settings…' : 'Check saved settings'}</button>}
        {dirty && <div class="notification-save-actions"><button class="btn btn-secondary" type="button" disabled={locked} onClick={() => {focusOutcome.current = true; editor.current.discard();}}>Discard</button>
          <button class="btn btn-primary" type="button" disabled={locked} aria-busy={pending} onClick={save}>{pending ? 'Saving…' : 'Save notification settings'}</button>
        </div>}
      </div>
    </>}
  </section>;
}
