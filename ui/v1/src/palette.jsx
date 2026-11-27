import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Avatar, Icon } from './ds/index.mjs';
import { jobsListVM, paletteVM } from './view-models.mjs';
import { jobsListPath } from './helpers.mjs';
import { useResource } from './shared.jsx';
import { requestFieldFocus, takeFieldFocus, findField } from './deep-link.mjs';

// ⌘K: search and jump. It reads the same data the pages read and changes nothing by itself;
// an action runs only on Enter or a click.
// Keys the palette handles. Focus stays in the search field, so the highlighted option and the one Enter
// opens are always the same; Tab is held inside the dialog instead of moving to the page behind it.
export function paletteKeyAction(key, { at = 0, count = 0 } = {}) {
  at = Math.max(0, Math.min(at, Math.max(0, count - 1)));
  if (key === 'Escape') return { close: true, preventDefault: true, at };
  if (key === 'ArrowDown') return { at: Math.min(Math.max(0, count - 1), at + 1), preventDefault: true };
  if (key === 'ArrowUp') return { at: Math.max(0, at - 1), preventDefault: true };
  if (key === 'Enter') return { choose: count > 0, at, preventDefault: count > 0 };
  if (key === 'Tab') return { at, preventDefault: true };
  return { at };
}

export function Palette({ api, open, onClose, circles, data, lending, devices, revision, run }) {
  const [query, setQuery] = useState(''), [at, setAt] = useState(0), input = useRef(), previous = useRef(null), dialog = useRef(null);
  const [shortcuts, setShortcuts] = useState(false);
  const shortcutClose = useRef(null);
  const visible = open || shortcuts;
  // Let the initial read finish even while background updates advance the page revision.
  // Reopening refreshes it; the last loaded jobs stay searchable during that read.
  const state = useResource(api, open ? jobsListPath(circles) : null, 0);
  const lastJobs = useRef(null);
  if (Array.isArray(state.data)) lastJobs.current = state.data;
  const jobs = useMemo(() => jobsListVM(lastJobs.current ?? [], {
    now: Date.now(), machine: devices?.name ?? '', owner: devices?.ownerName ?? '' }).groups.flatMap((g) => g.rows), [state.data, devices]);
  const result = paletteVM(query, { approvals: data.approvals ?? [], jobs, circles, lendingOn: lending?.enabled === true });
  const selected = paletteKeyAction('', {at, count: result.items.length}).at;
  const loadingJobs = jobsListPath(circles) && !lastJobs.current && !state.error;
  const sections = [...result.sections];
  if (loadingJobs) sections.splice(sections.findIndex(s => s.title === 'Go to') + 1, 0, {title:'Jobs', items:[], loading:true});
  useLayoutEffect(() => {
    if (!visible) return;
    previous.current = document.activeElement;
    setQuery('');
    setAt(0);
    dialog.current?.showModal();
    input.current?.focus();
    return () => { dialog.current?.close(); previous.current?.focus?.(); };
  }, [visible]);
  useLayoutEffect(() => setAt(0), [query]);
  useLayoutEffect(() => { if (shortcuts) shortcutClose.current?.focus(); }, [shortcuts]);
  useEffect(() => {
    const key = event => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey || /^(input|textarea|select)$/i.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
      event.preventDefault(); setShortcuts(true);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { if (visible) document.getElementById('pal-' + at)?.scrollIntoView({block:'nearest'}); }, [at, visible]);
  if (!visible) return null;
  const close = () => { setShortcuts(false); onClose(); };
  const choose = (item) => {
    close();
    if (item.focus) requestFieldFocus(item.focus);
    // Already on that page: no route change will take the field, so focus it once the dialog has closed.
    if (item.focus && item.href === location.hash) setTimeout(() => findField(takeFieldFocus())?.focus());
    else if (item.href?.startsWith('/')) location.assign(item.href);
    else if (item.href) location.hash = item.href;
    else if (item.op) run(item.op);
  };
  const onKey = (event) => {
    if (shortcuts) { if (event.key === 'Escape') { event.preventDefault(); close(); } return; }
    const action = paletteKeyAction(event.key, { at: selected, count: result.items.length });
    if (action.preventDefault) event.preventDefault();
    if (action.close) close();
    else if (action.choose) choose(result.items[action.at]);
    else if (action.at !== at) setAt(action.at);
    if (event.key === 'Tab') input.current?.focus();
  };
  let index = -1;
  return (
      <dialog ref={dialog} class="palette card ph-no-capture" role="dialog" aria-modal="true" aria-label={shortcuts ? 'Keyboard shortcuts' : 'Search'} onKeyDown={onKey}
        onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === dialog.current) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }} data-telemetry-private="palette">
        {shortcuts ? <div class="shortcuts"><h2 class="t-title2">Keyboard shortcuts</h2><dl><dt>⌘K / Ctrl+K</dt><dd>Search pages, jobs and settings</dd><dt>⌘, / Ctrl+,</dt><dd>Open settings</dd><dt>N</dt><dd>New job from Home or Jobs</dd><dt>Shift+P</dt><dd>Pause lending</dd><dt>?</dt><dd>Keyboard shortcuts</dd><dt>Esc</dt><dd>Close a dialog</dd></dl><button type="button" ref={shortcutClose} class="btn btn-secondary" onClick={close} autofocus>Close</button></div> : <>
        <div class="in">
          <Icon name="search" />
          <input ref={input} value={query} onInput={(e) => setQuery(e.currentTarget.value)} placeholder="Search or jump to…" aria-label="Search or jump to"
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={result.items[selected] ? 'pal-' + selected : undefined} autocomplete="off" />
          <span class="kbd" aria-hidden="true">Esc</span>
        </div>
        <div id="palette-list" class="palette-results" role="listbox">
          {result.items.length === 0 && !loadingJobs && <p class="none" role="status">Nothing matches “{query}”.</p>}
          {sections.map((section) => (
            <div key={section.title} role="group" aria-label={section.title}>
              <div class="sec">{section.title}</div>
              {section.loading && <div aria-label="Loading recent jobs" role="status">{[1,2,3].map(n => <div key={n} class="palette-loading"><span class="skeleton" /></div>)}</div>}
              {section.items.map((item) => {
                index += 1;
                const mine = index;
                return (
                  <button key={item.id} id={'pal-' + mine} type="button" role="option" tabIndex="-1" aria-selected={mine === selected ? 'true' : 'false'}
                    class={'it' + (mine === selected ? ' sel' : '')} onClick={() => choose(item)} onMouseMove={() => setAt(mine)}>
                    {item.icon === 'avatar' ? <Avatar personName={item.avatarName} id={item.id} size="sm" /> : <Icon name={item.icon} size="sm" />}
                    <span class="grow">{item.label}</span>
                    {item.key ? <span class="kbd" aria-hidden="true">{item.key}</span> : item.enter && mine === at ? <span class="kbd" aria-hidden="true">↵</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <footer class="palette-footer"><span>↑↓ to move · ↵ to open · esc</span><button type="button" class="linkish" tabIndex="-1" onClick={() => setShortcuts(true)} aria-label="Keyboard shortcuts">?</button></footer>
        </>}
      </dialog>
  );
}
