import {Icon} from './icon.jsx';

// `text` may hold `code` spans between backticks; nothing else in it is markup.
// A short identifier (a model id such as gpt-6-sol) is one unit: it never wraps at its hyphens. Longer code may wrap.
const withCode = (text) => String(text).split('`').map((part, i) => (i % 2 ? <code class={/^[\w.:-]{1,24}$/.test(part) ? 'id' : undefined}>{part}</code> : part));

// A fact list (safety facts before a job, "How it ran" after it). Each item is {tone, icon, text, by}: the tone
// colours the icon only, the sentence carries the meaning, and `by` names who observed it.
export function Facts({items = [], label}) {
  return (
    <div class="facts ph-no-capture" role="list" aria-label={label} data-telemetry-private="ds-facts">
      {items.map((item) => (
        <div class={'fact ' + item.tone} role="listitem">
          <span class="ic"><Icon name={item.icon} size="sm" /></span>
          <div class="grow">
            {withCode(item.text)}
            {item.by ? <div class="by">{item.by}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
