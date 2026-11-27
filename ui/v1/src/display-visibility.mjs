// Visual reads pause in hidden tabs. Streams and user actions have separate lifetimes.
export const displayVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
export function visibleInterval(run, milliseconds, {document:doc=globalThis.document}={}) {
  let timer=null,stopped=false;
  const changed=()=>{
    clearInterval(timer);timer=null;
    if(stopped||doc?.visibilityState==='hidden')return;
    run();timer=setInterval(run,milliseconds);
  };
  doc?.addEventListener('visibilitychange',changed);changed();
  return ()=>{stopped=true;clearInterval(timer);doc?.removeEventListener('visibilitychange',changed);};
}
