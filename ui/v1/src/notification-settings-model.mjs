export const notificationCategories = [
  {key:'requests', label:'Requests', description:'When someone asks you to run a job.'},
  {key:'job_ready', label:'Job ready', description:'When your job is ready to review.'},
  {key:'needs_attention', label:'Needs attention', description:'When your job fails, stops or expires.'},
  {key:'security', label:'Security and devices', description:'Changes to your devices and access.'},
  {key:'lending_attention', label:'Lending needs attention', description:'When lending needs attention or reaches your allowance warning.'},
  {key:'circle_activity', label:'Circle activity', description:'Routine updates, including when your job starts. Desktop notifications are off by default.'},
];

export function notificationSettingsVM(settings) {
  return notificationCategories.map(category => {
    const value = settings?.[category.key];
    if (typeof value?.history !== 'boolean' || typeof value?.desktop !== 'boolean') {
      throw new Error('Notification settings could not be loaded. Retry to get the saved settings.');
    }
    return {...category, value:{history:value.history, desktop:value.desktop}};
  });
}

// A partial update keeps unrelated settings from another client intact.
export function notificationSettingsPatch(saved, draft) {
  const patch = {};
  for (const {key} of notificationCategories) {
    for (const channel of ['history', 'desktop']) {
      if (saved[key][channel] !== draft[key][channel]) {
        (patch[key] ??= {})[channel] = draft[key][channel];
      }
    }
  }
  return patch;
}

export const UNKNOWN_SAVE = 'We could not confirm whether your changes were saved. Check saved settings before trying again.';
export const UNKNOWN_READ = 'Saved settings are still unknown. Your edits are kept here.';

// Only explicit HTTP request rejections are safe to retry without read-back.
// Network failures, 5xx and malformed successful replies may follow a commit.
export function notificationSaveRejected(error) {
  return [400, 401, 403, 404, 405, 413, 415, 422].includes(error?.status);
}

export function createNotificationSettingsEditor(initialSettings, changed = () => {}) {
  let state = {saved:initialSettings, draft:null, status:'idle', error:'', notice:''};
  let intent = null;
  const publish = patch => { state = {...state, ...patch}; changed(state); };
  const locked = () => state.status !== 'idle';
  const dirty = () => !!(state.saved && state.draft && Object.keys(notificationSettingsPatch(state.saved, state.draft)).length);
  const editor = {
    get state() { return state; },
    get dirty() { return dirty(); },
    load(settings) { notificationSettingsVM(settings); publish({saved:settings}); },
    edit(key, channel, value) {
      if (locked()) return;
      const previous = state.draft ?? state.saved;
      publish({draft:{...previous, [key]:{...previous[key], [channel]:value}}, error:'', notice:''});
    },
    discard() {
      if (locked()) return;
      publish({draft:null, error:'', notice:'Changes discarded.'});
    },
    async reconcile(api) {
      if (state.status !== 'unknown') return;
      publish({status:'checking', error:UNKNOWN_SAVE});
      try {
        const saved = await api.get('notification-settings');
        notificationSettingsVM(saved);
        // Preserve only the channels this editor intended to change, not stale
        // values belonging to other clients. Keep the intent if read-back fails.
        const draft = {...saved};
        for (const [key, channels] of Object.entries(intent ?? {})) draft[key] = {...saved[key], ...channels};
        const differs = Object.keys(notificationSettingsPatch(saved, draft)).length > 0;
        intent = null;
        publish({saved, draft:differs ? draft : null, status:'idle', error:'',
          notice:differs ? 'Saved settings checked. Your edits are kept here.' : 'Saved settings checked. Your changes are saved.'});
      } catch {
        publish({status:'unknown', error:UNKNOWN_READ});
      }
    },
    async save(api) {
      if (locked() || !dirty()) return;
      intent = notificationSettingsPatch(state.saved, state.draft);
      publish({status:'saving', error:'', notice:''});
      try {
        const result = await api.post('notification-settings', intent);
        notificationSettingsVM(result);
        intent = null;
        publish({saved:result, draft:null, status:'idle', notice:'Notification settings saved.'});
      } catch (error) {
        if (notificationSaveRejected(error)) {
          intent = null;
          publish({status:'idle', error:'Notification settings were not saved.'});
        } else {
          publish({status:'unknown', error:UNKNOWN_SAVE});
          await editor.reconcile(api);
        }
      }
    },
  };
  return editor;
}
