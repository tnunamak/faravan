// Synthetic socket service accepts a write before the writer exits, then commits on request.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createServer, createConnection} from 'node:net';
import {mkdtemp, writeFile, readFile, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const exec = promisify(execFile);
const self = fileURLToPath(import.meta.url);

async function request(socket, command) {
  const connection = createConnection(socket);
  connection.setTimeout(5000, () => connection.destroy(new Error('synthetic service timed out')));
  let response = '';
  const done = new Promise((resolve, reject) => {
    connection.on('data', chunk => { response += chunk; });
    connection.once('error', reject);
    connection.once('end', () => resolve(response.trim()));
  });
  connection.end(command + '\n');
  return done;
}

if (process.argv[2] === 'daemon') {
  const [socket, marker] = process.argv.slice(3);
  let pending = false;
  const server = createServer({allowHalfOpen:true}, connection => {
    let command = '';
    connection.on('data', chunk => { command += chunk; });
    connection.on('end', async () => {
      if (command.trim() === 'accept') {
        pending = true;
        connection.end('accepted\n');
      } else if (command.trim() === 'commit' && pending) {
        await writeFile(marker, process.argv[5] || 'delegated synthetic write');
        pending = false;
        connection.end('committed\n');
      } else {
        connection.end('invalid\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  process.send({ready:true});
} else if (process.argv[2] === 'writer') {
  const [socket] = process.argv.slice(3);
  assert.equal(await request(socket, 'accept'), 'accepted');
  const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).trim();
  process.stdout.write(JSON.stringify({cgroup}) + '\n');
  // Keep the boundary populated until the experiment has bound its identity.
  process.stdin.resume();
} else {
  throw new Error('choose daemon or writer');
}
