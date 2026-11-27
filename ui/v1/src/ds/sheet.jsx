import {useLayoutEffect, useRef} from 'preact/hooks';
import {restoreFocus} from '../focus.mjs';

export function Sheet({open, onClose, label, children, class: callerClass, className, ...rest}) {
  const ref = useRef(), previous = useRef(null);
  const classes = ['sheet-dialog', callerClass, className, 'ph-no-capture'].filter(Boolean).join(' ');
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal !== 'function') return;
    if (open && !dialog.open) { previous.current = document.activeElement; dialog.showModal(); }
    if (!open && dialog.open) { dialog.close(); restoreFocus(previous.current); }
    return () => { if (dialog.open) { dialog.close(); restoreFocus(previous.current); } };
  }, [open]);
  // onClose answers false to veto the close, for example a write that cannot be cancelled yet. The dialog closes only
  // after onClose lets it, so a vetoed Escape or backdrop click leaves the sheet, its content and its focus in place.
  const close = () => {
    if (onClose?.() === false) return;
    ref.current.close(); restoreFocus(previous.current);
  };
  return <dialog {...rest} ref={ref} class={classes} aria-label={label} onCancel={event => {event.preventDefault();close();}}
    onClick={event => {if (event.target === event.currentTarget) close();}} data-telemetry-private={rest['data-telemetry-private'] || 'ds-sheet'}>
    <div class="sheet"><div class="grab" aria-hidden="true" />{children}</div>
  </dialog>;
}
