import {useEffect,useRef,useState} from 'preact/hooks';

export function EarlyBuilds({api}) {
  const [saved,setSaved]=useState(null),[canSelfUpdate,setCanSelfUpdate]=useState(null),[pending,setPending]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const owner=useRef(null);
  useEffect(()=>{
    const session={active:true};owner.current=session;setSaved(null);setCanSelfUpdate(null);setPending(false);setMessage('');setError('');
    api.get('update-settings').then(value=>{if(session.active){setSaved(value.earlyBuilds);setCanSelfUpdate(value.canSelfUpdate);}},()=>{if(session.active)setError('Update settings could not be read. Reopen this page to try again.');});
    return()=>{session.active=false;};
  },[api]);
  async function change(event) {
    const earlyBuilds=event.currentTarget.checked,session=owner.current;
    if(pending||saved===null)return;
    setPending(true);setError('');setMessage('');
    try {
      const value=await api.post('update-settings',{earlyBuilds});
      if(session.active){setSaved(value.earlyBuilds);setMessage('Restart Faravan to use this update setting. Turning it off keeps your installed version until a newer regular build is available.');}
    } catch {if(session.active)setError('Update setting could not be saved. Try again.');}
    finally {if(session.active)setPending(false);}
  }
  if(canSelfUpdate===false)return <p>This install updates through your package manager.</p>;
  return <section class="info-section stack-2" aria-label="Early builds">
    <label class="hstack-2"><input id="early-builds" type="checkbox" checked={saved===true} disabled={saved===null||pending} onChange={change} />Get early builds</label>
    <p class="t-sm t-2">Try candidate updates before they are released to everyone. They may contain unfinished changes.</p>
    {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
