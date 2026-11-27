/** Platform opener shared by local v1 entrypoints. */
import { spawn as spawnProcess } from 'node:child_process';

// The argv carries a single-use 60 s handoff code. Accepted: a same-user process can already read app.json.
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd.exe', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export function openUrl(url, { platform = process.platform, spawn = spawnProcess, env = process.env } = {}) {
  const disabled = env.FARAVAN_NO_BROWSER;
  if (disabled !== undefined && !['', '0', 'false'].includes(disabled)) return;
  const [command, args] = openCommand(url, platform);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
    child.on('error', () => {}); // Headless hosts may not have an opener.
    child.unref();
  } catch { /* The printed local URL remains usable if opening is unavailable. */ }
}
