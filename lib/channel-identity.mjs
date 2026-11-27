/** Install-scoped identity. Stable or missing metadata preserves the stable paths. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const STABLE_CHANNEL = Object.freeze({id:'faravan', name:'Faravan', dataFolder:'Faravan', bundleId:'com.faravan.app', helperBundleId:'com.faravan.app.notify', launchAgentLabel:'com.faravan.agent', linuxPrefix:'faravan'});
const REQUIRED_FIELDS = ['id','name','dataFolder','bundleId','helperBundleId','launchAgentLabel','linuxPrefix'];

function absoluteWindowsDataPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  const unc = value.replaceAll('/', '\\');
  if (!unc.startsWith('\\\\')) return false;
  const [server, share] = unc.slice(2).split('\\');
  return Boolean(server && share);
}

// Encode an XML plist string for a sed replacement using # as the delimiter.
export function plistSedReplacement(value) {
  const xml = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;');
  return xml.replace(/\\/g, '\\\\').replace(/&/g, '\\&').replace(/#/g, '\\#');
}

export function isChannelIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (REQUIRED_FIELDS.some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || /[\u0000-\u001f\u007f]/.test(value[key]))) return false;
  if (value.id !== value.id.trim()) return false;
  if (!/^[A-Za-z0-9._+-][A-Za-z0-9 ._+-]*$/.test(value.dataFolder) || value.dataFolder.includes('..') || /[ .]$/.test(value.dataFolder)) return false;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.helperBundleId)) return false;
  if (value.id === 'faravan') return REQUIRED_FIELDS.every(key => value[key] === STABLE_CHANNEL[key]);
  return true;
}

// The install root has one channel.json beside lib/. Missing metadata is a stable install;
// present but malformed metadata is an installation error and must not borrow stable values.
export function channelIdentity(modulePath = fileURLToPath(import.meta.url)) {
  const channelPath = path.join(path.dirname(modulePath), '..', 'channel.json');
  let raw;
  try {
    raw = fs.readFileSync(channelPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return STABLE_CHANNEL;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid channel metadata at ${channelPath}: ${error.message}`, {cause:error});
  }
  if (!isChannelIdentity(value)) throw new Error(`Invalid channel metadata at ${channelPath}: expected a complete channel identity with a safe dataFolder`);
  return value.id === 'faravan' ? STABLE_CHANNEL : value;
}

export function channelDataHome({channel = channelIdentity(), platform = process.platform, home = os.homedir(), env = process.env} = {}) {
  const explicit = env.FARAVAN_DATA_HOME;
  if (explicit) {
    const absolute = platform === 'win32' ? path.win32.isAbsolute(explicit) : path.isAbsolute(explicit);
    if (!absolute) throw new Error('FARAVAN_DATA_HOME must be absolute');
    return explicit;
  }
  if (!isChannelIdentity(channel)) throw new Error('Invalid channel identity: expected a complete channel identity with a safe dataFolder');
  
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', channel.dataFolder);
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    const base = localAppData && absoluteWindowsDataPath(localAppData) ? localAppData : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, channel.dataFolder);
  }
  if (platform === 'linux') {
    const xdg = env.XDG_DATA_HOME;
    const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
    return path.join(base, channel.dataFolder);
  }
  return null;
}
