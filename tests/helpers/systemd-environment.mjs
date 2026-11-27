// What `systemctl --user show -p Environment` prints, so fixtures stop hiding quoting bugs.
// systemd quotes each whole assignment on its own: a bare token when every character is plain, otherwise
// one double-quoted token that backslash-escapes ", \, ` and $ (seen live on systemd 259, for example
// "KWIN_DRM_DEVICES=/dev/dri/by-path/pci-0000\\:01\\:00.0-card" for a value holding single backslashes).
// Entries are joined by one space on one line.
const NEEDS_QUOTES = /[\s"\\`$*?['()<>|&;!]/;

export function systemdQuoteAssignment(name, value) {
  const assignment = `${name}=${value}`;
  if (assignment.length > 0 && !NEEDS_QUOTES.test(assignment)) return assignment;
  return `"${assignment.replace(/["\\`$]/g, '\\$&')}"`;
}

export function systemdShowEnvironment(entries) {
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  return pairs.map(([name, value]) => systemdQuoteAssignment(name, value)).join(' ');
}
