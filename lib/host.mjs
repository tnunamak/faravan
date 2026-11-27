/**
 * Durable operator-side state and pure reachability choices for
 * `faravan host`. Keeping this separate from the command lets
 * tests prove idempotency without starting a server, a service manager, or a
 * tunnel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateOrigin } from './protocol/index.mjs';
import { compatEnv } from './compat/env.mjs';
import { configHome } from './local-state.mjs';

export class FaravanHostError extends Error {
  constructor(message) { super(message); this.name = 'FaravanHostError'; }
}

// One app data folder owns its coordinator. Old circles stay in the migration archive.
export function coordinatorHome({appHome} = {}) {
  return compatEnv('COORDINATOR_HOME') || path.join(path.resolve(appHome ?? configHome()), 'coordinator');
}

export function hostPaths(home = coordinatorHome()) {
  return {
    home,
    config: path.join(home, 'host.json'),
    status: path.join(home, 'status.json'),
    data: path.join(home, 'tasks'),
  };
}

/** Older host records for an operator's existing HTTPS address have no owned route data. */
export function externalHostOrigin(reachability) {
  return reachability?.kind==='url' && typeof reachability.publicUrl==='string' &&
    Object.keys(reachability).every(key=>['kind','publicUrl'].includes(key)) ? reachability.publicUrl : null;
}

/** A legacy loopback listener has no provider resources and cannot change address. */
export function legacyLoopbackOrigin({reachability, port, v1_origin}) {
  const origin = externalHostOrigin(reachability);
  return origin === 'http://127.0.0.1:'+port && (!v1_origin || v1_origin===origin) ? origin : null;
}

export function resolveLanUrl({ port, networkInterfaces = os.networkInterfaces() }) {
  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        const url = `http://${address.address}:${port}`;
        if (validateOrigin(url, { lanMode:true }).ok) return url;
      }
    }
  }
  throw new FaravanHostError('could not find a local-network IPv4 address; choose another reach requirement');
}

/**
 * The address the coordinator listens on. LAN mode binds the one private
 * address the invite names (never all interfaces, which would also expose the
 * queue on public, VPN or Docker-bridge interfaces); otherwise the explicit
 * host setting, then loopback.
 */
export function coordinatorBindHost({ reachability, envHost } = {}) {
  if (reachability?.kind !== 'lan') return envHost || '127.0.0.1';
  let hostname;
  try { hostname = new URL(reachability.publicUrl).hostname; } catch { hostname = ''; }
  if (!hostname) throw new FaravanHostError('LAN mode needs the chosen local-network address (reachability.publicUrl)');
  return hostname;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new FaravanHostError(`could not read ${label} at ${file}: ${error.message}`);
  }
}

export function readCoordinatorStatus(config) {
  if (!fs.existsSync(config.status_path)) return null;
  return readJson(config.status_path, 'coordinator status');
}
