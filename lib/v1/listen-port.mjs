import {durableJsonAsync} from '../durable-write.mjs';
// The local app listens on the same loopback port across restarts, so an open tab reconnects by itself.
// If that port is taken (another program, or another Faravan home), the app takes any free port and
// remembers it; the tray and CLI find it through app.json. An explicit port is never substituted, and it is remembered too:
// a self-update relaunches without --port, and the open tab must find the app where the person put it.
import {open, readFile} from 'node:fs/promises';


function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', done); reject(error); };
    const done = () => { server.off('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', done);
    server.listen(port, host);
  });
}

async function rememberedPort(file) {
  try {
    const {port} = JSON.parse(await readFile(file, 'utf8'));
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch { return null; }
}

async function remember(file,port){await durableJsonAsync(file,{port});}

/** port > 0: exactly that port, or fail. port 0: the remembered port if free, else any. Either way the result is remembered. */
export async function listenPreferred(server, {port, host, file}) {
  if (port > 0) {
    await listen(server, port, host);
    await remember(file, port).catch(() => {});
    return;
  }
  const preferred = await rememberedPort(file);
  if (preferred !== null) {
    try { await listen(server, preferred, host); return; } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  await listen(server, 0, host);
  // Never fail the start over a convenience file.
  await remember(file, server.address().port).catch(() => {});
}
