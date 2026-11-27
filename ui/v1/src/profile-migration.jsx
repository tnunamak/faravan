import {useState} from 'preact/hooks';

export function ProfileMigrationNotice({notice, api}) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!notice || dismissed) return null;
  const dismiss = async () => {
    setBusy(true);
    setError('');
    try { await api.post('profile-migration', {}); setDismissed(true); }
    catch { setError('Could not save your dismissal. Try again.'); }
    finally { setBusy(false); }
  };
  return <aside class="banner ph-no-capture" data-telemetry-private="profile-migration" role="status">
    <p>{notice.message}</p>
    <details><summary>Archive details</summary><p class="t-sm">{notice.archive}</p></details>
    <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={dismiss}>Dismiss</button>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
