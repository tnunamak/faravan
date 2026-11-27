import {useId} from 'preact/hooks';
import {usePendingControl, controlReason} from './button.jsx';
import {Icon} from './icon.jsx';

export function Switch({checked, onChange, label, size, warn, disabled, disabledReason, pending, class: className = '', ...rest}) {
  const {busy, invoke} = usePendingControl(pending, disabled);
  const note = useId(), reason = controlReason(disabled, disabledReason, busy);
  const cls = 'switch' + (size ? ' ' + size : '') + (warn ? ' warn' : '') + (className ? ' ' + className : '');
  return (
    <><button {...rest} type="button" role="switch" class={cls} aria-checked={checked ? 'true' : 'false'} aria-label={label}
      aria-disabled={disabled || busy ? 'true' : undefined} aria-busy={busy ? 'true' : rest['aria-busy']}
      aria-describedby={[rest['aria-describedby'], reason && note].filter(Boolean).join(' ') || undefined}
      onClick={event => invoke(event, () => onChange?.(!checked))} />
      {reason && <span class="hint ph-no-capture" data-telemetry-private="ds-form-reason" id={note}>{reason}</span>}</>
  );
}

export function Field({label, hint, error, multiline, class: className = '', 'data-telemetry-private': privateRegion, ...rest}) {
  const generated = useId(), id = rest.id || generated, note = id + '-note';
  const Input = multiline ? 'textarea' : 'input';
  return (
    <div class={'field' + (className ? ' ' + className : '') + ' ph-no-capture'} data-telemetry-private={privateRegion || 'ds-form-field'}>
      <label for={id}>{label}</label>
      <Input {...rest} id={id} class={multiline ? 'textarea' : 'input'}
        aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? note : undefined} />
      {(error || hint) && <p class="hint" id={note}>{error || hint}</p>}
    </div>
  );
}

// One per screen. An error the person just caused is announced at once (alert).
export function Banner({kind, action, children, ...rest}) {
  const bad = kind === 'bad';
  return (
    <div {...rest} class={'banner' + (bad ? ' bad' : '') + (rest.class ? ' ' + rest.class : '') + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-form-banner'} role={bad ? 'alert' : 'status'}>
      <Icon name="alert" />
      <div class="grow">{children}</div>
      {action}
    </div>
  );
}

// Native select semantics, with the same pending/reason contract as buttons.
export function Select({pending, disabled, disabledReason, onChange, children, ...rest}) {
  const {busy, invoke} = usePendingControl(pending, disabled);
  const note = useId(), reason = controlReason(disabled, disabledReason, busy);
  return <><select {...rest} disabled={disabled || busy} aria-disabled={disabled || busy ? 'true' : undefined}
    aria-busy={busy ? 'true' : undefined}
    aria-describedby={[rest['aria-describedby'], reason && note].filter(Boolean).join(' ') || undefined}
    onChange={event => invoke(event, () => onChange?.(event))}>{children}</select>
    {reason && <span class="hint ph-no-capture" data-telemetry-private="ds-form-reason" id={note}>{reason}</span>}</>;
}
