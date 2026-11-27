import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Card, Icon, Avatar, Row } from './ds/index.mjs';
import { notificationVM, youVM, SETTINGS_READY } from './settings-model.mjs';
import { ComputerProfile } from './profile.jsx';
import { Updates } from './updates.jsx';
import { NotificationSettings } from './notification-settings.jsx';
import { Phone } from './phone.jsx';
import { scopeLabel, settingsMapVM } from './settings-registry.mjs';
import { readTheme, saveTheme, applyTheme, themeVM } from './theme.mjs';
import { requestFieldFocus } from './deep-link.mjs';
import { DATA_SHARING_COPY } from './safety-copy.mjs';
import { PrivacyCard } from './telemetry-ui.jsx';
import { SupportExport } from './support-export.jsx';

const remembered = key => { try { return localStorage.getItem(key) === 'yes'; } catch { return false; } };
export function Notifications() {
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [notice, setNotice] = useState('');
  const outcome = useRef(null), asked = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      if (next !== permission) { asked.current = false; setPermission(next); setError(''); setNotice(''); }
    };
    const visible = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', visible);
    sync();
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [permission]);
  const vm = notificationVM(permission);
  useLayoutEffect(() => { if (asked.current && !pending) outcome.current?.focus(); }, [permission, pending, error]);
  return <section class="info-section ph-no-capture" aria-labelledby="browser-notifications-title" data-telemetry-private="info"><h3 id="browser-notifications-title" class="t-title3">Notifications in this browser</h3><p ref={outcome} tabIndex="-1" role={error ? 'alert' : 'status'}>{error || notice || vm.text}</p>
    {vm.action && <button type="button" class="btn btn-primary" aria-busy={pending} aria-disabled={pending} onClick={async () => {
      if (pending) return;
      asked.current = true; setError(''); setPending(true);
      try { const next = await Notification.requestPermission(); setPermission(next); setNotice(next === 'default' ? 'Notification permission was not changed. Requests still appear on Home.' : ''); }
      catch { setError('The browser could not enable notifications. Try your browser’s site settings.'); }
      finally { setPending(false); }
    }}>{pending ? 'Waiting for the browser…' : vm.action}</button>}
  </section>;
}

// The first incoming request introduces notifications once, outside Lending.
export function RequestNotificationBanner({ data = {} }) {
  const [seen, setSeen] = useState(() => remembered('faravan-notification-intro'));
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!seen && data.approvals?.length) {
      setShow(true); setSeen(true);
      try { localStorage.setItem('faravan-notification-intro', 'yes'); } catch {}
    }
  }, [data.approvals, seen]);
  if (!show || !data.approvals?.[0]) return null;
  return <aside class="notification-intro ph-no-capture" aria-label="Request notifications" data-telemetry-private="info"><Icon name="bell" />
    <p class="grow">A request is waiting · <a href={'#/request/' + encodeURIComponent(data.approvals[0].id)}>Review</a>. <a href="#/you/notifications">Manage notifications</a> for requests and your jobs.</p>
    <button class="btn btn-quiet" type="button" onClick={() => { setShow(false); document.querySelector('.page-head h1')?.focus({preventScroll:true}); }}>Dismiss</button>
  </aside>;
}

const systemDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };

// Appearance: System by default, or Light or Dark kept in this browser (theme.mjs).
export function Appearance() {
  const [choice, setChoice] = useState(readTheme), [dark, setDark] = useState(systemDark);
  useEffect(() => {
    let query; try { query = matchMedia('(prefers-color-scheme: dark)'); } catch { return undefined; }
    const change = () => setDark(query.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  const vm = themeVM(choice, {systemDark: dark});
  const choose = id => { saveTheme(id); applyTheme(id); setChoice(id); };
  return <section class="info-section ph-no-capture" aria-labelledby="appearance-title" data-telemetry-private="info">
    <h2 id="appearance-title" class="t-title2">Appearance</h2>
    <p id="setting-theme-label" class="t-sm t-2">Theme</p>
    <div id="setting-theme" class="seg" role="group" aria-labelledby="setting-theme-label" tabIndex="-1">
      {vm.options.map(option => <button key={option.id} type="button" aria-pressed={option.pressed ? 'true' : 'false'} onClick={() => choose(option.id)}>{option.label}</button>)}
    </div>
    <p class="t-sm t-2" role="status">{vm.note}</p>
  </section>;
}

// The Settings map: every setting, wherever its control lives, grouped and searchable. A row opens its page at the field.
export function SettingsMap({ computer = '', ready = SETTINGS_READY }) {
  const [query, setQuery] = useState('');
  const vm = settingsMapVM({query, ready, computer});
  return <section class="info-section settings-map ph-no-capture" aria-labelledby="settings-map-title" data-telemetry-private="info">
    <h2 id="settings-map-title" class="t-title2">All settings</h2>
    <p class="t-sm t-2">Each setting is changed where it is used. Search by what it does, for example “quota” or “dark mode”.</p>
    <input class="input" type="search" aria-label="Search settings" placeholder="Search settings" value={query} onInput={e => setQuery(e.currentTarget.value)} />
    {vm.empty ? <p role="status">{vm.empty}</p> : <p class="sr" role="status">{query.trim() ? vm.count + (vm.count === 1 ? ' setting' : ' settings') : ''}</p>}
    {vm.groups.map(group => <section key={group.id} class="settings-group" aria-labelledby={'settings-group-' + group.id}>
      <h3 id={'settings-group-' + group.id} class="t-title3">{group.label}</h3>
      {(group.note || group.scope) && <p class="t-sm t-2">{group.note || group.scope}</p>}
      <Card><ul class="list">{group.items.map(item => <li key={item.key}>
        <Row href={item.href} title={item.label} meta={item.meta || undefined}
          aria-describedby={item.help ? 'setting-help-' + item.key : undefined}
          onClick={() => requestFieldFocus(item.focus)} />
        <div class="settings-row-details t-sm t-2">
          {item.effect && <p>{item.effect}</p>}
          {item.help && <p id={'setting-help-' + item.key}>{item.help}</p>}
          {item.default != null && <p>Default: {item.default}</p>}
          {item.storage && <p>Stored: {item.storage}</p>}
        </div>
      </li>)}</ul></Card>
    </section>)}
  </section>;
}

// "Notifications · This browser": where the values below apply. A browser-local value never claims the computer.
const ScopeHeader = ({ section, computer }) => section?.scope
  ? <p class="t-sm t-2 scope-head ph-no-capture" data-telemetry-private="info">{(section.title ?? section.label) + ' · ' + scopeLabel(section.scope, {computer})}</p> : null;

export function Settings({ api, data = {}, errors = {}, route = {}, mutate, refresh, ready = SETTINGS_READY }) {
  const vm = youVM(data, route.id, {ready});
  const shown = vm.selected ?? vm.sections.find(item => item.id === 'profile');
  const computer = data.devices?.name ?? '';
  return <div class={('you-page' + (vm.selected ? ' has-section' : '')) + ' ph-no-capture'} data-telemetry-private="info">
    <nav class="you-nav" aria-label="You"><div class="you-profile"><Avatar personName={data.devices?.ownerName} id={data.devices?.fingerprint} /><div><b>{vm.name}</b><p class="t-sm t-2">{vm.device}</p></div></div>
      <Card><ul class="list">{vm.sections.map(item => <li key={item.id}><Row href={item.href ?? '#/you/' + item.id} title={item.label} avatar={<Icon name={item.icon} />} aria-current={shown?.id === item.id ? 'page' : undefined} /></li>)}</ul></Card>
    </nav>
    <div class="you-content">
      {vm.selected && <a class="back-link you-back" href="#/you"><Icon name="chev-l" size="sm" />You</a>}
      <ScopeHeader section={shown} computer={computer} />
      {shown.id === 'all' && <SettingsMap computer={computer} ready={ready} />}
      {shown.id === 'profile' && <section class="info-section">
        {/* The shell owns device-read errors here; the shared profile keeps local Retry for standalone use. */}
        {(data.devices || !errors.devices) && <ComputerProfile {...{data, mutate, refresh}} errors={{}} />}
        <a class="btn btn-secondary" href="#/devices">Manage devices</a>
      </section>}
      {shown.id === 'appearance' && <Appearance />}
      {shown.id === 'notifications' && <><NotificationSettings api={api} /><p class="t-sm t-2 scope-head">{'Browser notifications · ' + scopeLabel('browser')}</p><Notifications /></>}
      {shown.id === 'updates' && <Updates api={api} initial={data.updateStatus} />}
      {shown.id === 'phone' && <Phone api={api} live={data.phone} />}
      {shown.id === 'data' && <section class="info-section"><h2 class="t-title2">Your data</h2><p>{DATA_SHARING_COPY}</p><a href="#/jobs">Review your jobs</a><SupportExport api={api} /><PrivacyCard api={api} /></section>}
      {shown.id === 'account' && <section class="info-section"><h2 class="t-title2">Account</h2><a href="/connect/chatgpt">Connect ChatGPT or disconnect its access</a><a href="#/circles">Manage your circles</a><a href="#/lend">Manage lending</a></section>}
    </div>
  </div>;
}
