import {useLayoutEffect, useRef, useState} from 'preact/hooks';
import {Icon} from './icon.jsx';

export const STEPS = ['Asked', 'Approved', 'Working', 'Ready'];

// The four steps of every job page. `at` is the lit step (0-3, from STEP_OF), `fail` marks it as the
// step that failed, `done` lights all four. The words are visible; colour only supports them.
export function JobSteps({at = 0, fail = false, done = false}) {
  const current = Number.isInteger(at) ? at : -1;
  return (
    <ol class="steps ph-no-capture" aria-label={'Progress: ' + (STEPS[current] ?? 'not started') + (fail ? ' (did not finish)' : '')} data-telemetry-private="ds-job">
      {STEPS.map((step, i) => (
        <li class={done || i < current ? 'done' : i === current ? (fail ? 'fail' : 'now') : ''}>{step}</li>
      ))}
    </ol>
  );
}

// `emphasis` is the one token of `text` that matters; it is brightened.
export function Command({text, emphasis}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = useRef(null), pending = useRef(false);
  useLayoutEffect(() => {
    owner.current = Symbol();
    setCopied(false);
    return () => {owner.current = null;};
  }, [text]);
  const at = emphasis ? text.indexOf(emphasis) : -1;
  const copy = async () => {
    const current = owner.current;
    if (!current || pending.current) return;
    pending.current = true;
    setBusy(true);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text);
      if (owner.current === current) setCopied(true);
    } catch { /* Keep the command available for manual copy. */ }
    finally {
      pending.current = false;
      if (owner.current) setBusy(false);
    }
  };
  return (
    <div class="cmd ph-no-capture" data-telemetry-private="ds-job">
      <span class="p" aria-hidden="true">$</span>
      <code>
        {at < 0 ? text : <>{text.slice(0, at)}<span class="em">{emphasis}</span>{text.slice(at + emphasis.length)}</>}
      </code>
      <button type="button" class="copy" aria-label="Copy command" disabled={busy} aria-busy={busy || undefined} onClick={copy}><Icon name="copy" size="sm" /></button>
      <span class="sr" role="status">{copied ? 'Copied' : ''}</span>
    </div>
  );
}

// lines: [{kind: 'hunk'|'add'|'del'|'ctx', n, text}]
export function FileDiff({file, lines}) {
  return (
    <div class="diff ph-no-capture" role="region" aria-label={'Changes in ' + file} tabIndex="0" data-telemetry-private="ds-job">
      {lines.map((line) => line.kind === 'hunk' ? <div class="hunk">{line.text}</div> : (
        <div class={'ln' + (line.kind === 'add' || line.kind === 'del' ? ' ' + line.kind : '')}>
          <span class="n">{line.n}</span>
          <span class="m" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
