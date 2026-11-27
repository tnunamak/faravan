import {Icon} from './icon.jsx';
import {Status, InlineStatus} from './status.jsx';

export function Card({as: Tag = 'div', pad, children, ...rest}) {
  return <Tag {...rest} class={('card' + (pad ? ' card-pad' : '') + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-card'}>{children}</Tag>;
}

const hue = (text) => {
  let n = 0;
  for (const ch of String(text)) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return (n % 6) + 1;
};
const initials = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words[0][0] + (words.length > 1 ? words.at(-1)[0] : '')).toUpperCase();
};

// Person letters come only from a person name. The id controls colour, never text.
// Circles use their own name and a rounded square; an unnamed person gets a glyph.
export function Avatar({personName, groupName, id, size}) {
  const group = groupName !== undefined;
  const name = group ? groupName : personName;
  const letters = group ? initials(name).slice(0, 1) : initials(name);
  const iconSize = {sm:'sm', lg:'lg', xl:'lg'}[size];
  return <span class={('av' + (group ? ' group' : '') + ' c' + hue(id ?? name) + (size ? ' ' + size : '')) + ' ph-no-capture'} aria-hidden="true" data-telemetry-private="ds-card">{letters || <Icon name="user" size={iconSize} />}</span>;
}

// The whole row is one link when it has an href. Wrap it in <li> inside a <ul class="list card">.
export function Row({href, avatar, title, meta, status, ...rest}) {
  const Tag = href ? 'a' : 'div';
  return (
    <Tag {...rest} class={('row' + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} href={href} data-telemetry-private={rest['data-telemetry-private'] || 'ds-card'}>
      {avatar}
      <div class="row-main">
        <div class="row-title">{title}</div>
        <div class="row-meta">
          {status && <><InlineStatus {...status} />{meta && <span class="sep"> · </span>}</>}
          {meta}
        </div>
      </div>
      <div class="row-end">
        {status && <Status {...status} />}
        {href && <Icon name="chev-r" size="sm" />}
      </div>
    </Tag>
  );
}

export function Empty({icon, title, text, action}) {
  return (
    <div class="empty ph-no-capture" data-telemetry-private="ds-card">
      <span class="glyph"><Icon name={icon} size="lg" /></span>
      <h2 class="t-title3">{title}</h2>
      {text && <p class="t-sm t-2">{text}</p>}
      {action}
    </div>
  );
}
