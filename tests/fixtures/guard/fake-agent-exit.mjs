import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if ((process.env.FAKE_MODE || '').includes('child')) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync('leftover.pid', String(child.pid));
}
console.log('READY');
process.stderr.write('fake agent stderr without newline');
process.exit((process.env.FAKE_MODE || '').includes('nonzero') ? 3 : 0);
