import {join, resolve} from 'node:path';

export function resolveInstallLayout(env, home) {
  const preview = Boolean(env.FARAVAN_INSTALL_ROOT);
  const installRoot = preview ? resolve(env.FARAVAN_INSTALL_ROOT) : join(home, '.local', 'lib', 'faravan');
  return {
    installRoot,
    nodeBin: preview && env.FARAVAN_NODE_BIN ? resolve(env.FARAVAN_NODE_BIN) : join(installRoot, 'runtime/bin/node'),
    channelFile: preview ? join(installRoot, 'channel.json') : join(home, '.local', 'channel'),
    appModule: join(installRoot, 'lib/v1/app.mjs'),
  };
}

export function parsePreviewInstallChannel(text) {
  let marker;
  try { marker = JSON.parse(text); } catch { throw new Error('invalid preview channel JSON'); }
  if (!marker || typeof marker.id !== 'string' || !/^preview-.+/.test(marker.id)) throw new Error('preview channel JSON has no preview channel');
  return marker.id;
}
