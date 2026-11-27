import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { safeName } from './helpers.mjs';
import { savePetname, deletePetname } from './api.mjs';
import { Connection, field } from './shared.jsx';

// A local name binds to one computer in one circle. Changing that binding resets the form;
// remote names never prefill the local nickname, and the binding identifier is not displayed.
export function LocalNameControl({ circleId, circleLabel, keyId, remoteName, current, mutate, label }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null), restore = useRef(false);
  const [message, setMessage] = useState('');
  useLayoutEffect(() => {if (!open && restore.current) {trigger.current?.focus();restore.current = false;}}, [open]);
  const close = (outcome = 'Local name edit cancelled.') => {restore.current = true;setMessage(outcome);setOpen(false);};
  if (!keyId || !circleId) return null;
  return (
    <div class="local-name ph-no-capture" data-telemetry-private="local-name">
      {!open ? (
        <button ref={trigger} type="button" class="btn btn-secondary" onClick={() => {setMessage('');setOpen(true);}}>
          {label}
        </button>
      ) : (
        <LocalNameForm
          key={circleId + '|' + keyId}
          {...{ circleId, circleLabel, keyId, remoteName, current, mutate }}
          onClose={close}
        />
      )}
      <p role="status" aria-live="polite">{message}</p>
    </div>
  );
}

function LocalNameForm({ circleId, circleLabel, keyId, remoteName, current, mutate, onClose }) {
  const {offline} = useContext(Connection);
  const [text, setText] = useState(current || '');
  const trimmed = text.trim();
  const input = useRef(null), pending = useRef(false), textRef = useRef(text);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [message, setMessage] = useState('');
  useLayoutEffect(() => {input.current?.focus();}, []);
  async function update(remove = false) {
    const submitted = textRef.current;
    const value = submitted.trim();
    if (offline || pending.current || (!remove && (!value || value === (current || '')))) return;
    pending.current = true;setBusy(true);setProblem('');setMessage('');
    try {
      if (remove) await deletePetname(mutate, circleId, keyId);
      else await savePetname(mutate, circleId, keyId, submitted);
      if (textRef.current !== submitted) setMessage(remove ? 'Local name removed. Your new edit is not saved.' : 'Local name saved. Your new edit is not saved.');
      else onClose(remove ? 'Local name removed.' : 'Local name saved on this computer.');
    } catch {setProblem('Could not save the local name. Try again.');}
    finally {pending.current = false;setBusy(false);}
  }
  return (
    <form class="ph-no-capture" onSubmit={e => {e.preventDefault();update();}} data-telemetry-private="local-name">
      <p class="t-sm t-2">
        This name is private to this computer. It is never sent to the circle, and it applies only to this computer in this circle.
      </p>
      <dl>
        <dt>Circle</dt>
        <dd>{safeName(circleLabel, 'Unnamed circle')}</dd>
        {remoteName && (
          <div>
            <dt>Device name (from the circle)</dt>
            <dd>
              <bdi>{remoteName}</bdi>
            </dd>
          </div>
        )}
      </dl>
      <label>
        Your local name
        <input
          ref={input}
          value={text}
          dir="auto"
          maxLength="64"
          onInput={e => {textRef.current = field(e);setText(textRef.current);}}
          aria-describedby="local-name-help"
        />
      </label>
      <p id="local-name-help" class="t-sm t-2">
        1 to 64 visible characters. If you already use this name for another member of this circle,
        add a qualifier.
      </p>
      <div class="hstack-2 wrap">
        <button type="submit" class="btn btn-secondary" disabled={offline || busy || !trimmed || trimmed === (current || '')}>Save local name</button>
        {current && <button type="button" class="btn btn-secondary" disabled={offline || busy} onClick={() => update(true)}>Remove local name</button>}
        <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => onClose()}>Cancel</button>
        <p role="alert">{problem}</p>
        <p role="status" aria-live="polite">{message}</p>
      </div>
    </form>
  );
}
