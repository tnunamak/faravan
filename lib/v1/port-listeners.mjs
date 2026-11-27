// Who serves a local TCP port. A stop is checked against the port itself, because a status file can name an older
// process than the one that answers members now.
import net from 'node:net';
import {execFile as execFileCallback} from 'node:child_process';

/** True when something accepts a TCP connection on host:port. */
export function portAnswers(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({port, host});
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const run = (execFile, command, args) => new Promise((resolve, reject) =>
  execFile(command, args, {encoding:'utf8', timeout:5000}, (error, stdout) => error && !stdout ? reject(error) : resolve(stdout ?? '')));

/**
 * The processes listening on a local TCP port, as [{pid, command}]. Uses lsof, and ss on Linux when lsof is missing.
 * An empty list means none could be named, not that the port is free.
 */
export async function portListeners(port, {platform = process.platform, execFile = execFileCallback} = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return [];
  let pids = [];
  try {
    const out = await run(execFile, 'lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-Fp']);
    pids = out.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
  } catch {
    if (platform !== 'linux') return [];
    try {
      const out = await run(execFile, 'ss', ['-ltnpH', 'sport = :' + port]);
      pids = [...out.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
    } catch { return []; }
  }
  const listeners = [];
  for (const pid of [...new Set(pids)].filter(pid => Number.isSafeInteger(pid) && pid > 0)) {
    let command = null;
    try { command = (await run(execFile, 'ps', ['-ww', '-p', String(pid), '-o', 'command='])).trim() || null; } catch { /* named by pid only */ }
    listeners.push({pid, command});
  }
  return listeners;
}
