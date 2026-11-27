import {flushSync} from './ds/flush-sync.mjs';
import {focusOutcome, restoreFocus} from './focus.mjs';
import { safeName, statusView, errorMessage, createActionGate } from './helpers.mjs';
import { useId, useState, useEffect, useLayoutEffect, useMemo, useRef, useContext } from 'preact/hooks';
import { createContext } from 'preact';
import {createResourceRead} from './resource-read.mjs';
import {normalizeProblem} from '../../../lib/v1/problem.mjs';
import {problemView, browserProblemContext} from './problem-catalog.mjs';

export const enc = encodeURIComponent;
export const KEEP_CONFIRM_OPEN = Symbol('keep-confirm-open');

export const go = (page, id, circleId) => {
  location.hash = '#/' + page + (id ? '/' + enc(id) : '') + (circleId ? '/' + enc(circleId) : '');
};

export const field = (event) => event.currentTarget.value;

export const circleName = (c) => safeName(c?.name, 'Unnamed circle');

export function Link({ page, id, circleId, children, ...props }) {
  return (
    <a
      href={'#/' + page + (id ? '/' + enc(id) : '') + (circleId ? '/' + enc(circleId) : '')}
      {...props} class={(props.class ? props.class + ' ' : '') + 'ph-no-capture'} data-telemetry-private={props['data-telemetry-private'] || 'shared'}
    >
      {children}
    </a>
  );
}

// The old header picker, moved to the two pages whose action depends on the circle (Lending and
// New job). Those pages move to the design system in U3 and U7, which replace it.
export function CirclePicker({ circle, circles, setCircle, label = 'Circle', disabled }) {
  if (circles.length < 2) return null;
  return (
    <label class="context ph-no-capture" data-telemetry-private="shared">
      {label}
      <select value={circle} disabled={disabled} onChange={(e) => setCircle(field(e))}>
        {circles.map((c) => (
          <option value={c.id}>{circleName(c)}</option>
        ))}
      </select>
    </label>
  );
}

export function Panel({ title, children, ...props }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} {...props} class={(props.class ?? 'panel') + ' ph-no-capture'} data-telemetry-private={props['data-telemetry-private'] || 'shared'}>
      {title && <h2 id={id}>{title}</h2>}
      {children}
    </section>
  );
}

export function Note({ children, ...props }) {
  return <p {...props} class={'note' + (props.class ? ' ' + props.class : '') + ' ph-no-capture'} data-telemetry-private={props['data-telemetry-private'] || 'shared'}>{children}</p>;
}

export function Status({ value, facts }) {
  return <span class="badge ph-no-capture" data-telemetry-private="shared">{statusView(value, facts).label}</span>;
}

export function useResource(api, path, revision, {poll=0,minInterval=5000,adaptivePolling=true}={}) {
  const owner=useMemo(()=>({}),[api,path]);
  const [state, set] = useState(null);
  const reader=useRef(null),seenRevision=useRef(revision),latestPath=useRef(path);
  const activeReader=()=>reader.current?.owner===owner?reader.current.resource:null;
  latestPath.current=path;
  useEffect(() => {
    seenRevision.current=revision;
    if (!path) {
      set(null);
      return;
    }
    const resource=createResourceRead(api,path,next=>set(old=>{
      const previous=old?.owner===owner?old.value:null;
      if(previous&&JSON.stringify(previous.data)===JSON.stringify(next.data)&&previous.error===next.error&&
        previous.stale===next.stale&&previous.readGeneration===next.readGeneration&&
        previous.resourceGeneration===next.resourceGeneration&&previous.observedAt===next.observedAt)return old;
      return {owner,value:next};
    }),{poll,minInterval,adaptivePolling});
    reader.current={owner,resource};
    resource.invalidate();
    return () => {
      // A section this page stopped needing (its path became null) finishes unseen; leaving the page or switching to
      // another path cancels the read.
      resource.stop({detach:latestPath.current===null});
      if(reader.current?.resource===resource)reader.current=null;
    };
  }, [owner]);
  useEffect(()=>{
    if(seenRevision.current===revision)return;
    seenRevision.current=revision;activeReader()?.invalidate();
  },[revision]);
  useEffect(()=>activeReader()?.setPolling(poll),[poll]);
  // `reload` returns the invalidation's generation, for causal readers. A control the person presses uses `reloadAndWait`:
  // it is done when the read it asked for has finished (an error is shown by the resource, not swallowed here).
  return {...(state?.owner===owner?state.value:{data:null,error:null}),reload:()=>activeReader()?.invalidate({force:true}),
    reloadAndWait:()=>{const resource=activeReader();return resource?resource.completed(resource.invalidate({force:true})):Promise.resolve();}};
}

// Action results go to the page-level status region, which outlives the card that held the button.
export const Notices = createContext(null);
// Whether the app can reach Faravan. While it cannot, an action that asks the app for something waits, with a reason.
export const Connection = createContext({ offline: false });
export const OFFLINE_REASON = 'Waits until you’re back online';

// Recovery timers only redraw. A read is offered only for a catalog read intent;
// pairing, owner and local-computer guidance must never run the failed operation.
export function useProblemView(error) {
  const [pulse, setPulse] = useState(0);
  const view = error ? problemView(normalizeProblem(error?.problem??error), {...browserProblemContext(),now:Date.now()}) : null;
  const until = view?.action.notBefore, waiting = view?.action.disabled === true;
  useEffect(() => {
    if (!waiting || !Number.isFinite(until)) return;
    const timer = setTimeout(() => setPulse(value=>value+1),Math.min(2147483647,Math.max(0,until-Date.now())));
    return () => clearTimeout(timer);
  }, [waiting,until,pulse]);
  return view;
}

export function ProblemNotice({error,onRead}) {
  const view = useProblemView(error);
  if (!view) return null;
  const canRead = onRead && ['check-status','reload','check-connection','wait'].includes(view.action.kind);
  return <div class="stack-2 ph-no-capture" data-telemetry-private="shared"><p role="alert">{view.detail}</p>{canRead && <button type="button" class="btn btn-secondary" disabled={view.action.disabled} onClick={onRead}>{view.action.label}</button>}</div>;
}

export function Action({
  run,
  children,
  success = 'Saved.',
  disabled = false,
  disabledReason,
  pending: externalPending = false,
  once = false,
  className = 'btn btn-secondary',
  onSuccess,
  allowOffline = false,
}) {
  const lock = useRef(createActionGate()),
    mounted = useRef(true),
    notices = useContext(Notices),
    { offline } = useContext(Connection),
    held = offline && !allowOffline;
  const [pending, setPending] = useState(false),
    [succeeded, setSucceeded] = useState(false),
    [message, setMessage] = useState(''),
    [failure, setFailure] = useState(null);
  const note = useId(), busy = pending || externalPending;
  const recovery = useProblemView(failure);
  const waiting = recovery?.action.disabled === true;
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  async function click(event) {
    const trigger = event.currentTarget;
    if (!lock.current.start(disabled || externalPending || held || waiting, once)) return;
    flushSync(() => setPending(true));
    setMessage('');
    setFailure(null);
    notices?.set('');
    const page = notices?.page();
    try {
      const result = await run();
      lock.current.succeed();
      if (mounted.current) setSucceeded(true);
      // `success` may be a function of the result, so the message says what was found, not just that it ran.
      const said = typeof success === 'function' ? success(result) : success;
      if (notices) notices.set(said, page);
      else if (mounted.current) setMessage(said);
      if (mounted.current) onSuccess?.(result);
    } catch (error) {
      if (mounted.current) {setFailure(normalizeProblem(error?.problem ?? error));}
      if (mounted.current) setMessage(errorMessage(error));
      else notices?.set(errorMessage(error), page);
    } finally {
      lock.current.finish();
      if (mounted.current) setPending(false);
      requestAnimationFrame(() => { if (!trigger.isConnected || trigger.disabled) focusOutcome(); });
    }
  }
  return (
    <span class="action ph-no-capture" data-telemetry-private="shared">
      <button
        type="button"
        class={className}
        disabled={!busy && (disabled || held || waiting || (once && succeeded))}
        aria-disabled={busy || disabled || held || waiting || (once && succeeded) ? 'true' : undefined}
        aria-busy={busy ? 'true' : undefined}
        title={held ? OFFLINE_REASON : undefined}
        aria-describedby={busy || disabled || held || waiting || (once && succeeded) ? note : undefined}
        onClick={click}
      >
        {busy ? 'Working…' : children}
      </button>
      {(busy || disabled || held || waiting || (once && succeeded)) && <span class="hint" id={note}>
        {busy ? 'Working…' : held ? OFFLINE_REASON : waiting ? recovery.detail : once && succeeded ? 'Already completed.' : disabledReason || 'This control is unavailable right now.'}
      </span>}
      <span class="feedback" role="status">
        {message}
      </span>
    </span>
  );
}

export function Confirm({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
  allowOffline=false,
}) {
  const ref = useRef(),
    { offline } = useContext(Connection),
    previous = useRef(document.activeElement);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => { dialog.close(); restoreFocus(previous.current); };
  }, []);
  const close = () => { ref.current?.close(); onClose(); };
  const closeAfterConfirm = result => { if (result !== KEEP_CONFIRM_OPEN) close(); };
  return (
    <dialog class="ph-no-capture"
      ref={ref}
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }} data-telemetry-private="shared"
    >
      <h2 id="confirm-title">{typeof title==='function'?title():title}</h2>
      {typeof children==='function'?children():children}
      {offline && !allowOffline && <p class="t-sm" role="status">{OFFLINE_REASON}. Nothing is changed until then.</p>}
      <div class="actions">
        <button type="button" class="btn btn-secondary" onClick={close} autoFocus>
          {cancelLabel}
        </button>
        <Action className="btn btn-primary" run={onConfirm} success="" onSuccess={closeAfterConfirm} allowOffline={allowOffline}>
          {typeof confirmLabel==='function'?confirmLabel():confirmLabel}
        </Action>
      </div>
    </dialog>
  );
}

export function FormError({ text, refElement }) {
  return text ? (
    <p tabIndex="-1" ref={refElement} class="error ph-no-capture" role="alert" data-telemetry-private="shared">
      {text}
    </p>
  ) : null;
}

export function StopJob({ lending, mutate, setDialog }) {
  if (!lending.current || !['running', 'sending-result', 'paused'].includes(lending.status))
    return null;
  const attemptId = lending.current;
  return (
    <button
      type="button"
      class="btn btn-secondary ph-no-capture"
      onClick={() =>
        setDialog({
          title: 'Stop this job?',
          confirmLabel: 'Stop this job',
          children: <p>Faravan asks the agent to stop. The person who asked sees it as stopped once this computer confirms it.</p>,
          onConfirm: () => mutate('lending/stop', { attemptId, confirmed: true }),
        })
      } data-telemetry-private="shared"
    >
      Stop this job
    </button>
  );
}
