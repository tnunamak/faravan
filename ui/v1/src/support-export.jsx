import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {Card} from './ds/index.mjs';

const unverifiablePreview='This support preview could not be verified. Refresh the preview before saving.';

// Renderer shape validation only; the producer owns archive/preview correspondence.
export function validSupportPreview(preview) {
  if(!preview || !Array.isArray(preview.entries) || !preview.entries.length ||
    !preview.entries.every(entry=>entry&&typeof entry.body==='string') ||
    typeof preview.archiveBase64!=='string')return false;
  try {return atob(preview.archiveBase64).length>0;} catch {return false;}
}

export function downloadSupportArchive(preview) {
  if(!validSupportPreview(preview))throw new Error(unverifiablePreview);
  const bytes = Uint8Array.from(atob(preview.archiveBase64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], {type:'application/gzip'}));
  const link = Object.assign(document.createElement('a'), {href:url, download:'faravan-support.tar.gz'});
  link.classList.add('ph-no-capture'); link.setAttribute('data-telemetry-private', 'support-export-download'); document.body.append(link);
  try {link.click();} finally {link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);}
}

export function SupportExport({api, save = downloadSupportArchive}) {
  const [preview, setPreview] = useState(null), [pending, setPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const busy = useRef(false), previewRef = useRef(null), openerRef = useRef(null);
  useLayoutEffect(() => {if (preview) previewRef.current?.focus();}, [preview]);
  async function prepare() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(''); setNotice('');
    setPreview(null);
    try {
      const value=await api.post('ops/diagnostics.preview', {});
      if(!validSupportPreview(value)) {setError(unverifiablePreview);return;}
      setPreview(value);
    }
    catch {setError('The support preview could not load. Try again.');}
    finally {busy.current = false; setPending(false);}
  }
  return <Card as="section" pad class="stack-4 ph-no-capture" aria-labelledby="support-title" data-telemetry-private="support-export">
    <div class="stack-2"><h2 id="support-title" class="t-title2">Get help</h2>
      <p class="t-sm">Review this diagnostic snapshot before sharing it. It may identify your computer or jobs.</p>
      <p class="t-sm">Saving downloads this archive to your computer; it does not send it to support.</p></div>
    <div><button ref={openerRef} type="button" class="btn btn-secondary" disabled={pending} aria-busy={pending} onClick={prepare}>
      {pending ? 'Preparing preview…' : preview ? 'Refresh support preview' : 'Preview support export'}</button></div>
    {error && <p role="alert">{error}</p>}
    {preview && <div class="stack-3">
      <p class="t-sm">Diagnostic preview supplied separately from the download. The archive may contain different or additional data. Archive contents and privacy are not verified by this screen.</p>
      {preview.entries.map((entry,index)=><pre key={index} ref={index===0?previewRef:undefined} class="telemetry-body" tabIndex="0" aria-label={'Diagnostic preview entry '+(index+1)}>{entry.body}</pre>)}
      <div class="hstack-2 wrap"><button type="button" class="btn btn-primary" disabled={pending} onClick={() => {
        if(pending||!validSupportPreview(preview)) {setError(unverifiablePreview);return;}
        setError('');
        try {save(preview); setNotice('Download requested. Saving does not send the archive to support.');}
        catch {setError('The download could not start. Try saving again.');}
      }}>Save support archive</button>
      <button type="button" class="btn btn-quiet" disabled={pending} onClick={() => {setPreview(null); setNotice(''); setError(''); openerRef.current?.focus();}}>Close preview</button></div>
    </div>}
    {notice && <p class="t-sm" role="status">{notice}</p>}
  </Card>;
}
