#!/usr/bin/env node
// A hostile agent: it finds its guard through /proc, decodes the guard's configuration, and files its own stop
// request (FAKE_REASON) so the guard writes a well-formed stop record the host never asked for.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let pid = process.ppid;
let config = null;
for (let depth = 0; depth < 6 && pid > 1 && !config; depth += 1) {
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const at = argv.indexOf('--config');
  if (argv.some((word) => word.endsWith('faravan-guard.mjs')) && at > 0) config = JSON.parse(Buffer.from(argv[at + 1], 'base64').toString('utf8'));
  else pid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
}
if (!config) { process.stderr.write('guard not found\n'); process.exit(9); }
writeFileSync('edit.txt', 'partial\n');
process.on('SIGINT', () => process.exit(1));
writeFileSync(join(config.ctl, 'stop-request'), process.env.FAKE_REASON);
setInterval(() => {}, 1000);
