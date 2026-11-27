// Product capabilities required before an installed-host journey can run:
// - Linux installer accepting pinned local bytes without sudo or shared hooks.
// - No-clobber Mac archive installation with validated members and links.
// - Private UI endpoint handoff bound to the installed process.
// - Native GUI, install, listener and process-incarnation identity.
// - A run-owned normal quit operation with a completion receipt.
// These gaps block the journey; they do not authorize bypassing the product.

import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import path from 'node:path';

const blocked = code => ({status: 'blocked', code});
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function validatePath(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) ||
      value !== path.posix.normalize(value) || /[\x00-\x1f\x7f]/.test(value) ||
      /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|Keychains|keychain|credentials?)(?:\/|$)/i.test(value)) {
    throw new TypeError('unsafe path');
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// The injected Mac runner executes argv without a shell and with stdin closed.
export function createHostAdapter(options) {
  const allowed = new Set(['platform', 'runId', 'machineId', 'artifact', 'sha256', 'destination', 'runner']);
  if (!options || Object.keys(options).some(key => !allowed.has(key))) throw new TypeError('unknown option');
  const {platform, runId, machineId, artifact, sha256, destination, runner} = options;
  if (!['linux', 'darwin'].includes(platform) || !idPattern.test(runId ?? '') ||
      !idPattern.test(machineId ?? '') || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    throw new TypeError('invalid identity or digest');
  }
  validatePath(artifact);
  validatePath(destination);
  if (platform === 'darwin' && typeof runner !== 'function') throw new TypeError('Mac runner required');
  if (platform === 'linux' && runner !== undefined) throw new TypeError('Linux runs locally');
  if (platform === 'darwin' && !destination.endsWith('/Applications/Faravan.app')) throw new TypeError('invalid Mac destination');
  let verified = false;
  const identity = {runId, machineId, installDigest: sha256, processIncarnation: null};

  async function command(program, args) {
    const result = await runner({program, args, stdin: 'ignore'});
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      throw new Error('invalid runner result');
    }
    if (/password|prompt|authenticate|permission required/i.test(result.stdout + result.stderr)) throw new Error('interactive prompt');
    return result;
  }

  return Object.freeze({
    async verify() {
      verified = false;
      let actual, exists;
      try {
        if (platform === 'linux') {
          const info = await lstat(artifact);
          if (!info.isFile() || info.isSymbolicLink()) return blocked('artifact_not_regular_file');
          actual = await hashFile(artifact);
          try { await lstat(destination); exists = true; } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            exists = false;
          }
        } else {
          const file = await command('/usr/bin/test', ['-f', artifact]);
          const link = await command('/usr/bin/test', ['-L', artifact]);
          if (file.code !== 0 || link.code !== 1) return blocked('artifact_not_regular_file');
          const sum = await command('/usr/bin/shasum', ['-a', '256', artifact]);
          if (sum.code !== 0) return blocked('artifact_unreadable');
          actual = sum.stdout.slice(0, 64);
          const present = await command('/usr/bin/test', ['-e', destination]);
          const symlink = await command('/usr/bin/test', ['-L', destination]);
          if (![0, 1].includes(present.code) || ![0, 1].includes(symlink.code)) return blocked('destination_unknown');
          exists = present.code === 0 || symlink.code === 0;
        }
      } catch { return blocked('verification_unavailable'); }
      if (actual !== sha256) return blocked('artifact_digest_mismatch');
      if (exists) return blocked('destination_unowned');
      verified = true;
      // Hash and existence checks do not validate archive members or authorize writes.
      return {status: 'preflight', identity: {...identity}, destination};
    },
    async install() {
      if (!verified) return blocked('verification_required');
      return blocked(platform === 'linux' ? 'linux_pinned_noninteractive_installer_missing' : 'macos_safe_archive_install_missing');
    },
    async open() { return blocked('installed_process_identity_unavailable'); },
    async endpoint() { return blocked('private_ui_endpoint_handoff_missing'); },
    async facts() { return blocked('installed_process_identity_unavailable'); },
    async close() { return blocked('run_owned_quit_unavailable'); },
  });
}
