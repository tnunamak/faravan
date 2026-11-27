// Stringified into the CSP-hashed bootstrap. Sign-in is the HttpOnly cookie; no token is read or sent from the page.
// mark is Faravan's mark as an <svg>, taken from #mark in icons.svg when the page is built.
export async function bootstrap(takeSession, recoveryStyles='', sessionRecovery, mark='') {
  takeSession(location,history);
  try{sessionStorage.removeItem('faravan-session');}catch{}
  const target=document.getElementById('app');
  // The theme choice (theme.mjs) is applied before the stylesheet, so a stored Light or Dark never flashes the other.
  try{const theme=localStorage.getItem('faravan-theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;}catch{}
  let scriptUrl,styleUrl;
  const recovery=()=>sessionRecovery(matchMedia('(max-width: 899px)').matches, /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname??'') || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/.test(location.href??''));
  try {
    const load=async(path,type)=>{
      const response=await fetch(path,{credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
      if(!response.ok) {
        if(response.status===401) {
          const link=document.createElement('link');link.rel='stylesheet';
          link.href=URL.createObjectURL(new Blob([recoveryStyles],{type:'text/css'}));document.head.append(link);
          const view=recovery();
          const text=view.text.replace('Settings → Pairing','<strong>Settings → Pairing</strong>');
          target.innerHTML='<main class="recovery" role="alert"><div class="recovery-brand" aria-hidden="true">'+mark+'<span>Faravan</span></div><h1>'+view.headline+'</h1><p>'+text+'</p></main>';
          target.removeAttribute('role');
          return null;
        }
        throw new Error('app_load_failed');
      }
      return URL.createObjectURL(new Blob([await response.text()],{type}));
    };
    scriptUrl=await load('/app.mjs','text/javascript');
    if(!scriptUrl)return;
    styleUrl=await load('/app.css','text/css');
    if(!styleUrl)return;
    const link=document.createElement('link');link.rel='stylesheet';
    const loaded=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=reject;});
    link.href=styleUrl;document.head.append(link);await loaded;
    const app=await import(scriptUrl);target.removeAttribute('role');app.start();
  }catch{target.textContent=recovery().failureText;}
  finally{if(scriptUrl)URL.revokeObjectURL(scriptUrl);if(styleUrl)URL.revokeObjectURL(styleUrl);}
}
