import {Icon} from './icon.jsx';
import {useLayoutEffect, useRef} from 'preact/hooks';

// items: [{page, label, icon, href, count?}]; `current` is the page name.
// The badge is an image with a name: "2 need you" (a bare number means nothing to a screen reader).
const needYou = (count) => count + (count === 1 ? ' needs you' : ' need you');

export function TabBar({items, current, ...rest}) {
  const bar = useRef(null);
  // Reserve the real bar height, including safe-area and enlarged text, in the page.
  useLayoutEffect(() => {
    const node = bar.current;
    const app = node?.closest('.app');
    if (!app) return;
    const measure = () => app.style.setProperty('--bar-h', node.getBoundingClientRect().height + 'px');
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      app.style.removeProperty('--bar-h');
    };
  }, []);
  return (
    <nav {...rest} class={'tabbar' + (rest.class ? ' ' + rest.class : '')} aria-label="Main" ref={bar}>
      {items.map((item) => (
        <a href={item.href} aria-current={item.page === current ? 'page' : undefined}>
          <span class="tab-icon"><Icon name={item.icon} size="lg" /></span>
          <span class="tab-label">{item.label}</span>
          {item.count > 0 && <span class="badge ph-no-capture" data-telemetry-private="ds-nav-count" role="img" aria-label={needYou(item.count)}>{item.count}</span>}
          {item.progress && <span class="progress-mark" role="img" aria-label="Setup incomplete" title="Finish setup" />}
        </a>
      ))}
    </nav>
  );
}

// Arrow keys move focus and selection together; Home and End jump to the edges.
export function Tabs({idPrefix, label, items, current, onChange, panelId, ...rest}) {
  function onKeyDown(event) {
    const index = items.findIndex(item => item.value === current);
    const next = event.key === 'ArrowRight' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].value);
    event.currentTarget.children[next].focus();
  }
  return <div {...rest} class={'section-tabs' + (rest.class ? ' ' + rest.class : '')} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
    {items.map(item => <button type="button" id={idPrefix + '-' + item.value} role="tab"
      aria-selected={current === item.value} aria-controls={panelId}
      tabIndex={current === item.value ? 0 : -1} onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>;
}

export function Sidebar({items, current, brand, search, children, foot, ...rest}) {
  return (
    <aside {...rest} class={'sidebar' + (rest.class ? ' ' + rest.class : '')}>
      {brand}
      {search}
      <nav aria-label="Main" class="side-nav">
        {items.map((item) => (
          <a class="side-link" href={item.href} aria-current={item.page === current ? 'page' : undefined}>
            <Icon name={item.icon} />
            {item.label}
            {item.count > 0 && <span class="count ph-no-capture" data-telemetry-private="ds-nav-count" role="img" aria-label={needYou(item.count)}>{item.count}</span>}
            {item.progress && <span class="progress-mark" role="img" aria-label="Setup incomplete" title="Finish setup" />}
          </a>
        ))}
      </nav>
      {children}
      {foot && <div class="side-foot">{foot}</div>}
    </aside>
  );
}

export function Brand({size, inline}) {
  return (
    <div class={inline ? 'hstack-2' : 'side-brand'}>
      <span class="mark" aria-hidden="true" style={size ? {width: size, height: size, borderRadius: Math.round(size * 0.28)} : undefined}><svg><use href="#mark" /></svg></span>
      <span class="brand-name">Faravan</span>
    </div>
  );
}

// The sidebar's search field. It opens the jump palette (U14); `href` is where it goes until then.
export function SideSearch({href, onOpen, ...rest}) {
  return (
    <a {...rest} class={'side-search' + (rest.class ? ' ' + rest.class : '')} href={href} onClick={onOpen ? (event) => { event.preventDefault(); onOpen(); } : undefined}>
      <Icon name="search" size="sm" />
      <span class="grow">Search or jump to…</span>
      <span class="kbd" aria-hidden="true">⌘K</span>
    </a>
  );
}

// "This computer" chip: its name, one line about lending, and the effective state as a dot.
// The word is for screen readers; the dot and the line say the rest.
export function ThisComputer({name, line, kind, word, href}) {
  return (
    <a class="machine ph-no-capture" data-telemetry-private="ds-nav-computer" href={href}>
      <Icon name="laptop" />
      <div class="grow">
        <div style={{ fontWeight: '600' }}>{name}</div>
        <div class="t-3 t-xs">{line}</div>
      </div>
      <span class={'st ' + kind}><span class="sr">{word}</span></span>
    </a>
  );
}
