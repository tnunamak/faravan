import { safeName } from './helpers.mjs';

// Preserve opaque validated limits and the caller's original edit revision.
// Strategy validation and account selection remain with their existing owners.
export function lenderLimitsSaveBody(limits, schedule, version) {
  return { ...limits, schedule, version };
}

// `scope` matches the settings registry's scopes, so each section's header says where its values apply.
// `reserved` sections are listed only once their module is mounted (see SETTINGS_READY).
export const YOU_SECTIONS = [
  { id: 'all', label: 'All settings', icon: 'search' },
  { id: 'profile', label: 'Profile and devices', title: 'Profile', icon: 'user', scope: 'computer' },
  { id: 'appearance', label: 'Appearance', icon: 'moon', scope: 'browser' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', scope: 'computer' },
  { id: 'updates', label: 'Updates', icon: 'refresh', scope: 'computer' },
  { id: 'phone', label: 'Pairing', icon: 'phone', scope: 'computer', reserved: true },
  { id: 'data', label: 'Your data', icon: 'box', scope: 'computer' },
  { id: 'account', label: 'Account', icon: 'key', scope: 'account' },
];
// Reserved settings destinations this build mounts.
export const SETTINGS_READY = Object.freeze(['updates', 'phone']);

export function youVM(data = {}, section = null, { ready = SETTINGS_READY } = {}) {
  const sections = YOU_SECTIONS.filter(item => !item.reserved || ready.includes(item.id));
  const selected = sections.find(item => item.id === section && !item.href) ?? null;
  return { selected, sections, name: safeName(data.devices?.ownerName, 'You'),
    device: safeName(data.devices?.name, 'This computer') };
}

export function notificationVM(permission = 'unsupported') {
  if (permission === 'granted') return { text: 'This browser has permission to request notifications. Your computer\'s notification settings may still block them. New requests also appear on Home.', action: null };
  if (permission === 'denied') return { text: 'Notifications are blocked. Open your browser’s site settings and allow notifications for Faravan. Requests still appear on Home.', action: null };
  if (permission === 'unknown') return { text: 'This browser’s notification permission is not known. Your computer’s notification settings may also block delivery. New requests still appear on Home.', action: null };
  if (permission === 'default') return { text: 'Get a notification when someone asks for your help. Notifications show people’s names, never code or job titles.', action: 'Turn on notifications' };
  return { text: 'This browser does not support notifications. New requests still appear on Home.', action: null };
}

export function autostartVM(state) {
  if(!state?.supported)return null;
  if(state.error)return {text:'Could not check launch at login. Refresh this page to try again.',action:null};
  if(state.reason==='move_to_applications')return {text:'Move Faravan.app to Applications and open that copy before enabling launch at login.',action:state.enabled?'Turn off launch at login':null,enabled:false};
  if(!state.available)return {text:'Install and open Faravan.app to choose whether it starts when you log in.',action:state.enabled?'Turn off launch at login':null,enabled:false};
  if(state.needsRepair&&state.enabled)return {text:'Update launch at login for this copy of Faravan. The change takes effect at your next login.',action:'Update login item',enabled:true,turnOff:true};
  return {text:state.enabled?'Faravan starts at login without opening a browser tab.':'Open Faravan automatically when you log in to this Mac.',
    action:state.enabled?'Turn off launch at login':'Turn on launch at login',enabled:!state.enabled};
}
