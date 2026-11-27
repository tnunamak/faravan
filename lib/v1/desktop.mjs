// What the web app needs to know about this computer's desktop: whether the
// tray icon has a place to live, and whether to show the one-time Windows pin
// prompt (setup.win-pin). The platform and the tray's own report are inputs,
// so tests need no real desktop.

export function platformName(platform) {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'other';
}

/**
 * tray: true or false when the tray helper reported it (Linux only); null when unknown.
 * Mac and Windows always have a status area, so only Linux can lack one.
 */
export function desktopView({platform, lendingOn, pinPromptShown, tray}) {
  const name = platformName(platform);
  const hasTray = name === 'linux' ? (typeof tray === 'boolean' ? tray : null) : name === 'other' ? null : true;
  return {
    platform: name,
    tray: hasTray,
    // Windows 11 hides a new tray icon behind the ^ flyout, so once, after lending turns on, we say how to pin it.
    pinPrompt: name === 'windows' && lendingOn === true && pinPromptShown !== true,
    pinSettingsUri: name === 'windows' ? 'ms-settings:taskbar' : null,
    // No tray: notifications with actions, the launcher and `faravan status` carry the same state (tray.linux-notray).
    noTrayNote: name === 'linux' && hasTray === false,
  };
}

/** The tray's own report is exactly {tray: boolean}; anything else is null. */
export function parseTrayReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.tray !== 'boolean' || Object.keys(input).length !== 1) return null;
  return input.tray;
}
