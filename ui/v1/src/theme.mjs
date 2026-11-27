// Theme choice: follow the system by default, or keep Light or Dark for this browser. tokens.css already defines
// [data-theme=light|dark]; with no attribute it follows prefers-color-scheme. The choice is browser-local on purpose:
// another browser on the same computer may want a different one.
export const THEME_KEY = 'faravan-theme';
export const THEMES = Object.freeze([
  {id: 'system', label: 'System'},
  {id: 'light', label: 'Light'},
  {id: 'dark', label: 'Dark'},
].map(Object.freeze));

export const themeOf = value => (value === 'light' || value === 'dark' ? value : 'system');

export function readTheme(storage = globalThis.localStorage) {
  try { return themeOf(storage?.getItem(THEME_KEY)); } catch { return 'system'; }
}

export function applyTheme(choice, root = globalThis.document?.documentElement) {
  if (!root) return;
  const theme = themeOf(choice);
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// Saving "system" removes the override rather than storing a value that would outlive a future default.
export function saveTheme(choice, storage = globalThis.localStorage) {
  const theme = themeOf(choice);
  try {
    if (theme === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
    return true;
  } catch { return false; }
}

export function themeVM(choice, {systemDark = false} = {}) {
  const theme = themeOf(choice);
  const shown = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  return {
    choice: theme,
    options: THEMES.map(option => ({...option, pressed: option.id === theme})),
    note: theme === 'system' ? 'Follows your system. It is ' + shown + ' now.' : 'Kept ' + shown + ' in this browser, whatever the system uses.',
  };
}
