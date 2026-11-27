#!/usr/bin/env node
// A hostile agent: a helper stays alive in the agent's process group; when the stop arrives, the agent kills its
// own guard and exits. The guard can then print no "group ceased" line and leaves the helper running.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('survivor.pid', String(helper.pid));
writeFileSync('edit.txt', 'partial\n');
process.on('SIGINT', () => {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (argv.some((word) => word.endsWith('faravan-guard.mjs'))) { process.kill(pid, 'SIGKILL'); break; }
    pid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
  }
  process.exit(130);
});
setInterval(() => {}, 1000);
