// What the app says about the circle this computer hosts (EXPERIENCE M5): read from the host's own files, never written.
// `faravan host` starts the circle; this only reports on it, so the page can follow the command without a terminal.
import fs from 'node:fs';
import { hostPaths, readCoordinatorStatus } from '../host.mjs';
import { hostProcessExists } from './host.mjs';
import { saveJsonFile } from '../local-state.mjs';

import {coordinatorHosting} from '../coordinator-hosting.mjs';
// Only a missing file is absent. Any other failure (unreadable, not JSON, not an object) is unknown and carries its reason.
const readConfig = file => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {absent: true};
    return {error: 'could not read host config at ' + file + ': ' + error.message};
  }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return {config: value};
    return {error: 'could not read host config at ' + file + ': not a JSON object'};
  } catch (error) { return {error: 'could not read host config at ' + file + ': ' + error.message}; }
};
const readFailed = reason => Object.assign(new Error(reason), {code: 'host_config_unreadable'});

export async function hostingView({home, device, presence, now = Date.now,processExists=hostProcessExists}) {
  const paths = hostPaths(home), read = readConfig(paths.config);
  if (read.error) return {configured: null, unreadable: {what: 'config', reason: read.error}};
  const config = read.config;
  if (!config || config.protocol_version !== 1 || config.schema_version !== 1) return {configured: false};
  let status = null, statusError = null;
  try { status = readCoordinatorStatus(config); } catch (error) { statusError = error.message; }
  let running=null,processState='unknown';
  if (statusError) processState = 'unreadable';
  else try {
    running=processExists(status,{configPath:paths.config})&&['listening','public_listening'].includes(status.status);
    processState=running?'running':'stopped';
    if (running && config.reachability?.kind==='gozar') {
      const proof=status.route?.verification;
      running=proof?.status==='verified' && proof.validUntil.known && Date.parse(proof.validUntil.value)>now();
    }
  }catch{/* Unknown ownership is visible and never authorizes a restart or stop. */}
  const expected = config.v1_origin ?? config.reachability?.publicUrl ?? null;
  const observed = running && typeof status.public_url === 'string' ? status.public_url : null;
  const kind = config.reachability?.kind ?? null;
  const owned = (await device.listCircles()).filter(c => c.owned && c.origin === expected
    && [config.circle_id, ...(config.circle_ids ?? [])].includes(c.id));
  const circle = config.circle_id ? (await device.listCircles()).find(c => c.id === config.circle_id) ?? null : null;
  let members = null, lastReachedAt = null;
  if (running && circle && presence) {
    try { members = ((await device.rosterCache(circle.id).get()).current?.payload.members ?? []).length; } catch { /* unknown, not zero */ }
    try {
      const page = await presence(circle.id);
      const seen = page.devices.filter(d => d.device !== device.keyId).flatMap(d => [d.last_poll_at, d.last_heartbeat_at]).map(Date.parse).filter(Number.isFinite);
      if (seen.length) lastReachedAt = new Date(Math.max(...seen)).toISOString();
    } catch { /* the page then says nothing about when */ }
  }
  return {
    configured: true, wanted:config.host_wanted===true, running,processState,...(statusError?{statusError}:{}), name: circle?.name ?? config.collective_name ?? null, circle: circle?.id ?? null,
    circles: owned.map(c => ({id:c.id,name:c.name})), origin: expected, port: config.port ?? null,
    reach:{kind,audience:kind==='gozar'?coordinatorHosting(home).read()?.spec.reach??null:kind==='lan'?'lan':null},
    ...(status?.route && {route:status.route}),
    members, lastReachedAt,
    // H2: the keep-awake switch (the host config's keep_awake, on unless turned off), what the host process says it is doing, and the
    // last time it found the computer had slept (the gap between two of its own ticks): the page's "was asleep" banner.
    keepAwake: {enabled: config.keep_awake !== false, active: running && status?.keep_awake?.active === true, reason: running ? status?.keep_awake?.reason ?? null : null},
    lastWake: running && status?.last_wake && Number.isFinite(Date.parse(status.last_wake.at)) ? {at: status.last_wake.at, gapSeconds: status.last_wake.gap_seconds ?? null} : null,
    addressChanged: running && expected && observed && observed !== expected ? {expected, observed} : null,
    observedAt: new Date(now()).toISOString(),
  };
}

/** H2: the person's keep-awake switch. The host process reads its config every few seconds, so this takes effect without a restart. */
export function setKeepAwake({home, on}) {
  const paths = hostPaths(home), read = readConfig(paths.config);
  if (read.error) throw readFailed(read.error);
  const config = read.config;
  if (!config || config.protocol_version !== 1 || config.schema_version !== 1) return false;
  saveJsonFile(paths.config, {...config, keep_awake: on === true}, {base:home});
  return true;
}
