// A native <details> with the browser triangle replaced by a chevron that turns when open (components.css). The focus
// ring sits on the summary label only. `rows` renders aligned key/value pairs; `children` is any other body.
export function Disclosure({summary, rows, children, open, class: callerClass, className, ...rest}) {
  const classes = ['disc', callerClass, className, 'ph-no-capture'].filter(Boolean).join(' ');
  return (
    <details {...rest} class={classes} open={open} data-telemetry-private={rest['data-telemetry-private'] || 'ds-disclosure'}>
      <summary>{summary}</summary>
      <div class="disc-body">
        {rows?.length > 0 && <dl class="kv">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
        {children}
      </div>
    </details>
  );
}
