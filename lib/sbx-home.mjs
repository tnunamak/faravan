import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {channelDataHome} from './channel-identity.mjs';
const {existsSync} = fs;
export const SBX_SOCKET_PATH_LIMIT = 104;
const SBX_CONTAINERD_SOCKET_RELATIVE_PATH = '.local/state/sandboxes/sandboxes/sandboxd/containerd/containerd.sock.ttrpc';

export function containerdSocketPathForSbxHome(home) {
  return path.join(home, SBX_CONTAINERD_SOCKET_RELATIVE_PATH);
}

// macOS's 104-byte sun_path needs a terminating NUL; preserve the other platforms' existing budget.
export function sbxSocketPathLimit(platform = process.platform) {
  return platform === 'darwin' ? 103 : SBX_SOCKET_PATH_LIMIT;
}

export function socketPathFits(socketPath, platform) {
  return Buffer.byteLength(socketPath) <= sbxSocketPathLimit(platform);
}

/**
 * Selects Faravan's isolated sbx HOME without moving existing state.
 * The full socket pathname, including sbx's suffix, must fit channelPlatform's UTF-8 byte budget.
 */
export function selectSbxHome({ home = os.homedir(), override = process.env.FARAVAN_SBX_HOME, channel, channelPlatform = process.platform, channelEnv = process.env, dataHome = process.env.FARAVAN_HOME || channelDataHome({home, channel, platform: channelPlatform, env: channelEnv}), pathExists = existsSync,
  userHome = path.isAbsolute(channelEnv.FARAVAN_SBX_SHORT_HOME_BASE ?? '') ? channelEnv.FARAVAN_SBX_SHORT_HOME_BASE : accountHome() } = {}) {
  if (override) return { home: override, migration: null };
  // A second install is isolated by its own data dir, never by a fake HOME, so its sandbox identity (Docker sign-in,
  // policy, agent secrets) lives beside that data. The default profile keeps ~/.wfsbx so existing installs never move.
  if (dataHome && path.resolve(dataHome) !== path.join(home, '.spare' + 'kin')) {
    return { home: fitSbxHome(path.join(path.resolve(dataHome), 'sbx'), userHome, channelPlatform), migration: null };
  }

  const defaultHome = fitSbxHome(path.join(home, '.wfsbx'), userHome, channelPlatform);
  const legacyHome = path.join(home, '.waspflow', 'sbx-home');
  if (!pathExists(legacyHome) || pathExists(defaultHome)) return { home: defaultHome, migration: null };

  if (socketPathFits(containerdSocketPathForSbxHome(legacyHome), channelPlatform)) {
    return { home: legacyHome, migration: 'using_legacy_home' };
  }
  return { home: defaultHome, migration: 'legacy_home_too_long' };
}

// An app given its own long HOME (the Mac app's "Library/Application Support/..." folder, or a long user name) would
// put the socket past the limit, so its sandbox home moves to a short folder in the account's own home, one per app
// HOME. If even that is too long, the long path stays and the socket_path_length check says so.
function fitSbxHome(candidate, userHome, platform) {
  if (socketPathFits(containerdSocketPathForSbxHome(candidate), platform) || !userHome) return candidate;
  const short = path.join(userHome, '.fsbx', createHash('sha256').update(candidate).digest('hex').slice(0, 6));
  return socketPathFits(containerdSocketPathForSbxHome(short), platform) ? short : candidate;
}

// The account's own home from the account database. An app run with its own long HOME still keeps short sandbox homes here;
// a caller that must not touch the real account passes `userHome` to selectSbxHome.
export function accountHome() {
  try { return os.userInfo().homedir || null; } catch { return null; }
}

