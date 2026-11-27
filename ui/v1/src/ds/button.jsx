import {useId, useRef, useState} from 'preact/hooks';
import {flushSync} from './flush-sync.mjs';
import {Icon, Spinner} from './icon.jsx';

const sizes = {sm: ' btn-sm', lg: ' btn-lg'};
const kinds = new Set(['primary', 'secondary', 'quiet', 'danger']);

// A ref closes the gate before user code runs; flushSync paints feedback before
// returning from the event, rather than treating a scheduled state update as a lock.
export function usePendingControl(pending, disabled) {
  const gate = useRef(false), [local, setLocal] = useState(false);
  const busy = Boolean(pending || local);
  async function invoke(event, run) {
    if (gate.current || busy || disabled) { event?.preventDefault(); return; }
    gate.current = true;
    try {
      let result;
      // Read a select's event value before a controlled rerender restores it.
      flushSync(() => { result = run?.(); setLocal(true); });
      return await result;
    }
    finally {
      gate.current = false;
      flushSync(() => setLocal(false));
    }
  }
  return {busy, invoke};
}

export function controlReason(disabled, disabledReason, pending) {
  return pending ? 'Working…' : disabled ? disabledReason || 'This control is unavailable right now.' : '';
}

// One primary per view. A disabled button keeps its reason in the label.
export function Button({kind = 'secondary', size, block, pending, disabled, disabledReason, noHint = false, href, onClick, children, ...rest}) {
  if (!kinds.has(kind)) throw new TypeError('Unsupported button variant: ' + kind);
  const {busy, invoke} = usePendingControl(pending, disabled);
  // noHint: the caller already shows the reason elsewhere, so the control prints no hint beside itself.
  const note = useId(), reason = noHint && !busy ? '' : controlReason(disabled, disabledReason, busy);
  const inert = busy || disabled;
  const cls = 'btn btn-' + kind + (sizes[size] || '') + (block ? ' btn-block' : '') + (rest.class ? ' ' + rest.class : '');
  const props = {
    ...rest, class: cls, 'aria-disabled': inert ? 'true' : undefined, 'aria-busy': busy ? 'true' : undefined,
    'aria-describedby': [rest['aria-describedby'], reason && note].filter(Boolean).join(' ') || undefined,
    onClick: event => { if (href && !onClick && !inert) return; return invoke(event, () => onClick?.(event)); },
  };
  const content = <>{busy && <Spinner />}{children}</>;
  return <>{href && !inert ? <a {...props} href={href}>{content}</a> : <button {...props} type={rest.type || 'button'}>{content}</button>}{reason && <span class="hint ph-no-capture" data-telemetry-private="ds-button-reason" id={note}>{reason}</span>}</>;
}

export function IconButton({label, icon, ...rest}) {
  return (
    <button type="button" {...rest} class={'icon-btn' + (rest.class ? ' ' + rest.class : '')} aria-label={label}>
      <Icon name={icon} />
    </button>
  );
}
