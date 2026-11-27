// What makes Faravan open the setup screen by itself after the restart or log-out (D8).
//   Windows  a RunOnce entry, which Windows runs once at the next sign-in and then deletes.
//   Linux    a one-shot XDG autostart entry, removed when setup finishes.
// macOS has no step that needs either. Each effect is injected so tests touch no real registry or autostart.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
export const RUN_ONCE_NAME = 'FaravanSetup';
export const AUTOSTART_NAME = 'faravan-setup.desktop';

const quote = value => '"' + String(value).replaceAll('"', '') + '"';

export function runOnceCall(faravanCommand) {
  return ['reg', ['add', RUN_ONCE_KEY, '/v', RUN_ONCE_NAME, '/t', 'REG_SZ', '/d', quote(faravanCommand) + ' open-setup', '/f']];
}

export function autostartEntry(faravanCommand) {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Finish setting up Faravan', 'Comment=Opens Faravan where setup stopped',
    'Exec=' + faravanCommand.replaceAll(' ', '\\ ') + ' open-setup', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

export function createResumeHook({platform = process.platform, env = process.env, home, run, faravanCommand = 'faravan'} = {}) {
  const autostartDir = join(env.XDG_CONFIG_HOME || join(home ?? env.HOME ?? '', '.config'), 'autostart');
  return {
    async install() {
      if (platform === 'win32') { const [command, args] = runOnceCall(faravanCommand); await run(command, args); return true; }
      if (platform === 'linux') {
        await mkdir(autostartDir, {recursive: true});
        await writeFile(join(autostartDir, AUTOSTART_NAME), autostartEntry(faravanCommand), {mode: 0o644});
        return true;
      }
      return false;
    },
    async remove() {
      if (platform === 'win32') await run('reg', ['delete', RUN_ONCE_KEY, '/v', RUN_ONCE_NAME, '/f']);
      else if (platform === 'linux') await rm(join(autostartDir, AUTOSTART_NAME), {force: true});
    },
  };
}
