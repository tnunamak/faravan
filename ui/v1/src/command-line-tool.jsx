import {useEffect,useRef,useState} from 'preact/hooks';
import {Action} from './shared.jsx';
import {Card,Button} from './ds/index.mjs';

import {boundedUI} from './lending-checks.mjs';
export const COMMAND_STATUS_TIMEOUT_MS=10000;
export const COMMAND_INSTALL_TIMEOUT_MS=15000;
// Ownership survives card remounts for the same stable API context.
const installations=new WeakMap();
function installation(api,initialResult) {
  if(!installations.has(api))installations.set(api,{pending:false,unknown:false,epoch:0,result:initialResult??null,checking:false,loadFailed:false,listeners:new Set()});
  return installations.get(api);
}
const publish=state=>state.listeners.forEach(listener=>listener());
const copyFullPath=path=>navigator.clipboard.writeText(path);
const failed=result=>Boolean(result?.error);
const shellQuote=value=>`'${String(value).replaceAll("'", "'\\''")}'`;

export function CommandLineTool({api,initialResult,installActionAvailable=true,statusTimeoutMs=COMMAND_STATUS_TIMEOUT_MS,installTimeoutMs=COMMAND_INSTALL_TIMEOUT_MS}) {
  const state=installation(api,initialResult);
  const previous=useRef({api,initialResult}),currentState=useRef(state);currentState.current=state;
  const [,render]=useState(0);
  const heading=useRef(null),installButton=useRef(null);
  const {result,unknown,checking,loadFailed}=state;
  const busy=state.pending&&!unknown;
  function accept(value) {
    if(currentState.current===state&&globalThis.document?.activeElement===installButton.current)heading.current?.focus();
    state.result=value;state.loadFailed=false;publish(state);
  }
  async function checkStatus() {
    const epoch=++state.epoch;state.checking=true;state.loadFailed=false;publish(state);
    try {
      const value=await boundedUI(Promise.resolve().then(()=>api.post('ops/command_path.status',{})),statusTimeoutMs);
      if(epoch!==state.epoch)return;
      state.result=value;
      // A negative snapshot cannot prove a pending or response-lost install stopped.
      if((value?.installed===true&&!state.pending)||(state.terminalConfirmed&&typeof value?.installed==='boolean'))state.unknown=false;
    } catch {if(epoch===state.epoch)state.loadFailed=true;}
    finally {if(epoch===state.epoch){state.checking=false;publish(state);}}
  }
  useEffect(()=>{
    const update=()=>render(value=>value+1);state.listeners.add(update);
    if(previous.current.api===api&&previous.current.initialResult!==initialResult&&initialResult){state.epoch++;state.result=initialResult;state.loadFailed=false;publish(state);}
    else if(!initialResult)checkStatus();
    previous.current={api,initialResult};
    return()=>state.listeners.delete(update);
  },[api,initialResult]);
  const path=result?.path??'';
  const command=path.slice(path.lastIndexOf('/')+1)||'faravan';
  const isInstalled=result?.installed===true;
  const managed=isInstalled&&result?.managed===true;
  const hasFailed=failed(result);
  async function install(event) {
    if(state.pending||state.unknown)return;
    installButton.current=event?.currentTarget;
    const epoch=++state.epoch;
    state.pending=true;state.unknown=false;state.terminalConfirmed=false;state.checking=false;publish(state);
    const request=Promise.resolve().then(()=>api.post('ops/command_path.install',{}));
    state.operation=request;
    // Keep ownership even when this card unmounts or its UI wait expires.
    request.then(async value=>{
      if(state.operation!==request)return;
      const confirmed=typeof value?.installed==='boolean';state.terminalConfirmed=confirmed;
      if(epoch!==state.epoch&&confirmed) {
        // Hold single-flight ownership until a post-completion snapshot is reconciled.
        state.unknown=true;publish(state);
        await checkStatus();
        state.pending=false;publish(state);
      } else {
        state.pending=false;state.unknown=!confirmed;
        if(confirmed)accept(value);else publish(state);
      }
    },()=>{if(state.operation===request){state.pending=false;state.unknown=true;publish(state);}});
    try {await boundedUI(request,installTimeoutMs);}
    catch {if(state.pending){state.unknown=true;publish(state);}}
  }
  const dir=result?.error?.directory??path.replace(/\/[^/]+$/,'');
  const marker=command==='faravan'?'# Faravan command path':`# Faravan command path (${command})`;
  const pathBlock='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
  const profiles=result?.profiles??[result?.profile];
  const commandBin=path.replace(/\/[^/]+$/,'');
  const linkCommand=`mkdir -p ${shellQuote(commandBin)} && if [ ! -e ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]; then ln -s ${shellQuote(result?.launcher??path)} ${shellQuote(path)}; fi`;
  const errorCode=typeof result?.error==='string'?result.error:result?.error?.code;
  const unsupported=errorCode==='command_path_unsupported_platform'||errorCode==='command_path_unsupported_shell';
  const dataHomeConflict=errorCode==='command_path_data_home_conflict';
  const setupBusy=errorCode==='lock_busy';
  const errorPath=result?.error?.path??path;
  const errorCopy={
    launcher_missing:<>Faravan's launcher couldn't be found. Reopen the app and try again.</>,
    command_path_conflict:<>Something else is already at <code data-telemetry-private="command-line-tool" class="ph-no-capture">{errorPath}</code>. Remove that file if it is an old Faravan install, or use Faravan's built-in terminal.</>,
    command_path_data_home_conflict:<>This data home is already used by another Faravan install. Choose a different data home (<code data-telemetry-private="command-line-tool" class="ph-no-capture">FARAVAN_DATA_HOME</code>) for this install.</>,
    lock_busy:<>Command setup is busy or its lock owner could not be verified. Close other Faravan setup windows and try again.</>,
    command_path_unresolved:<>Your login shell still can't find <code data-telemetry-private="command-line-tool" class="ph-no-capture">{command}</code>. Check the profile block, then open a new terminal window.</>,
    command_path_shell_failed:<>Could not check the PATH for your login shell. Check that your shell can start, then try again.</>,
    command_path_unsupported_shell:<>Automatic setup does not support this shell yet. You can still use Faravan’s built-in terminal.</>,
    command_path_unsupported_platform:<>The command-line tool isn't supported on Windows yet.</>,
    command_path_write_failed:<>Couldn't write to <code data-telemetry-private="command-line-tool" class="ph-no-capture">{result?.error?.directory??dir}</code>. Check the folder's permissions, then try again.</>,
  };
  if(!result)return <Card data-telemetry-private="command-line-tool" class="ph-no-capture"><div class="card-pad stack-3 command-line-tool">
    <h2 class="t-title3" ref={heading} tabIndex={-1}>Command-line tool</h2>
    <p class="t-sm" role={loadFailed?'alert':'status'}>{loadFailed?'Could not check command-line tool status. Check again.':'Checking command-line tool status…'}</p>
    {loadFailed&&<Button disabled={checking} disabledReason="Checking now. Wait for the result." onClick={checkStatus}>Check again</Button>}
  </div></Card>;
  return <Card data-telemetry-private="command-line-tool" class="ph-no-capture"><div class="card-pad stack-3 command-line-tool">
    <h2 class="t-title3" ref={heading} tabIndex={-1}>Command-line tool</h2>
    {loadFailed&&<p role="alert">Could not check command-line tool status. Check again.</p>}
    {unknown&&<p role="status">Installation status is unknown. A negative check cannot confirm the earlier setup stopped. Install stays disabled; you can use the built-in terminal while waiting for confirmation.</p>}
    {(loadFailed||unknown)&&<Button disabled={checking} disabledReason="Checking now. Wait for the result." onClick={checkStatus}>Check again</Button>}
    {managed? <>
      <p class="t-sm" role="status">Installed.</p>
      <p class="t-sm t-2">Open a new terminal window and try <code>{command} help</code>.</p>
      <Action className="btn btn-secondary btn-sm" allowOffline run={()=>copyFullPath(path)} success="Full path copied.">Copy full path</Action>
    </>:isInstalled? <>
      <p class="t-sm" role="status">Another <code>{command}</code> is already installed at <code>{path}</code>.</p>
      <Action className="btn btn-secondary btn-sm" allowOffline run={()=>copyFullPath(path)} success="Full path copied.">Copy full path</Action>
    </>: <>
      <p class="t-sm">The <code>{command}</code> command isn't available in your terminal yet.</p>
      {hasFailed&&<p class="t-sm" role="alert">{errorCopy[errorCode]??<>Couldn't set up the command-line tool. Try again, or use the built-in terminal.</>}</p>}
      <div class="pair setup-pair">
        {!unsupported&&installActionAvailable&&<Button kind="primary" pending={busy} disabled={busy||unknown||state.pending} disabledReason={unknown?'The install status is unknown. Check again first.':'Waiting for the current change to finish.'} onClick={install}>Install command-line tool</Button>}
        {hasFailed&&path&&<Action className="btn btn-secondary btn-sm" allowOffline run={()=>copyFullPath(path)} success="Full path copied.">Copy full path</Action>}
      </div>
      <details class="setup-details"><summary>Details</summary><div class="stack-2">
        <p class="t-sm">Command location: <code>{path||'Unavailable'}</code></p>
        {dataHomeConflict||setupBusy?null:hasFailed&&!unsupported?<div class="stack-2">
          {result?.launcher!==path&&<p class="t-sm"><code>{linkCommand}</code></p>}
          <p class="t-sm">Shell profiles: {profiles.map((item,index)=><span key={item}>{index>0?', ':''}<code>{item}</code></span>)}</p>
          <p class="t-sm">Edit your shell profiles yourself and add these lines if needed:</p>
          <pre><code>{marker}{'\n'}{pathBlock}</code></pre>
        </div>:unsupported?null:<p class="t-sm">Add <code>~/.local/bin</code> to your login PATH, then open a new terminal window.</p>}
        {!hasFailed&&path&&<Action className="btn btn-secondary btn-sm" allowOffline run={()=>copyFullPath(path)} success="Full path copied.">Copy full path</Action>}
      </div></details>
    </>}
  </div></Card>;
}
