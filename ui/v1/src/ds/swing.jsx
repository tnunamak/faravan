import {Icon} from './icon.jsx';

// Shared card surface for the lead swing system. Keep content and decisions in callers.
export function SwingCard({as: Tag = 'div', className = '', children, ...rest}) {
  return <Tag {...rest} class={('swing-card' + (className ? ' ' + className : '') + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-swing'}>{children}</Tag>;
}

export function SwingChip({tone = 'neutral', icon, children, ...rest}) {
  return <span {...rest} class={('swing-chip ' + tone + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-swing'}>
    {icon && <Icon name={icon} size="sm" />}{children}
  </span>;
}

export function SwingSectionLabel({children, needsYou = false, ...rest}) {
  return <div {...rest} class={('swing-section-label' + (needsYou ? ' needs-you' : '') + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-swing'}>
    {needsYou && <span class="swing-section-dot" aria-hidden="true" />}{children}
  </div>;
}

export function SwingLink({href, children, className = '', ...rest}) {
  return <a {...rest} href={href} class={('swing-link' + (className ? ' ' + className : '') + (rest.class ? ' ' + rest.class : '')) + ' ph-no-capture'} data-telemetry-private={rest['data-telemetry-private'] || 'ds-swing'}>
    <span>{children}</span><Icon name="chev-r" size="sm" />
  </a>;
}

// Common item anatomy: who, title, observed/requested metadata, disclosure, actions.
export function SwingItemCard({
  actor,
  verb,
  when,
  avatar,
  status,
  title,
  meta = [],
  disclosure,
  actions,
  className = '',
  ...rest
}) {
  const chip = status && (typeof status === 'string' ? {label: status} : status);
  return <SwingCard class="ph-no-capture" as="article" {...rest} className={'swing-item-card' + (className ? ' ' + className : '')} data-telemetry-private={rest['data-telemetry-private'] || 'ds-swing'}>
    <div class="swing-item-who">
      {avatar}
      <p class="swing-item-byline">
        {actor && <strong>{actor}</strong>}{verb && <> {verb}</>}
        {when && <span class="swing-item-when"> · {when}</span>}
      </p>
      {chip && <SwingChip tone={chip.tone || 'neutral'} icon={chip.icon}>{chip.label}</SwingChip>}
    </div>
    {title != null && <h2 class="swing-item-title">{title}</h2>}
    {meta.length > 0 && <div class="swing-item-meta" role="list">
      {meta.map((item, index) => <span class="swing-item-meta-item" role="listitem" key={item.key ?? index}>
        {item.icon && <Icon name={item.icon} size="sm" />}
        <span class={item.mono ? 'mono' : ''}>{item.value}</span>
      </span>)}
    </div>}
    {(disclosure || actions) && <footer class="swing-item-footer">
      <div class="swing-item-disclosure">{disclosure}</div>
      <div class="swing-item-actions">{actions}</div>
    </footer>}
  </SwingCard>;
}

export function SwingPanelRows({rows = [], className = ''}) {
  if (!rows.length) return null;
  return <dl class={('swing-panel-rows' + (className ? ' ' + className : '')) + ' ph-no-capture'} data-telemetry-private="ds-swing">
    {rows.map((row, index) => <div key={row.key ?? row.label ?? index}>
      <dt>{row.label}</dt><dd>{row.value}</dd>
    </div>)}
  </dl>;
}
