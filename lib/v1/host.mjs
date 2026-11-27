/** One-command local v1 hosting. Network/process operations have explicit test seams. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {captureCoordinatorOwner,coordinatorOwnerAlive,sameCoordinatorOwner,PREVIOUS_COORDINATOR_OTHER_INSTALL} from './coordinator-owner.mjs';
import { saveJsonFile } from '../local-state.mjs';
import { ensureDurableDirectory } from '../durable-directory.mjs';
import { coordinatorBindHost, coordinatorHome, hostPaths, externalHostOrigin, legacyLoopbackOrigin, resolveLanUrl, readCoordinatorStatus, FaravanHostError } from '../host.mjs';
import { openDevice, OWNER_LOCK_WAIT_MS } from './device.mjs';
import {coordinatorHosting, hostingError, publishedOrigin, readHostingState} from '../coordinator-hosting.mjs';
import {routeSelector, prepareHosting} from '../hosting-cli.mjs';
import { acquireProcessLock, coordinatorProcessLockPath, processLockOwners } from './lock.mjs';

const fail = message => { throw new FaravanHostError(message); };
const save = (paths, config) => { saveJsonFile(paths.config, config, {base:paths.home}); return config; };

export function ensureV1HostState({home = coordinatorHome(), base = path.dirname(home), port = 8787, name = 'My circle'} = {}) {
  const paths = hostPaths(home);
  ensureDurableDirectory(home, {base});
  fs.chmodSync(home, 0o700);
  if (fs.existsSync(paths.config)) {
    const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    if (config.protocol_version !== 1 || config.schema_version !== 1)
      fail('this directory already hosts v0; preserve it and choose a separate FARAVAN_COORDINATOR_HOME for v1 (FARAVAN_COORDINATOR_HOME remains supported). See docs/protocol/hosting.md for retirement steps');
    return {paths, config};
  }
  const config = save(paths, {schema_version:1, protocol_version:1, port,
    circle_name:name, collective_name:name, status_path:paths.status, data_dir:paths.data, reachability:null});
  return {paths, config};
}

/** Resolve the exact public review target without creating or changing host or exposure state. */
export function resolveHostReviewTarget({appHome, home = coordinatorHome({appHome}), port} = {}) {
  const valid = value => Number.isInteger(value) && value >= 1 && value <= 65535;
  if (port !== undefined && !valid(port)) fail('--port must be a number between 1 and 65535');
  let config;
  try { config = JSON.parse(fs.readFileSync(hostPaths(home).config, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config !== undefined && (config?.protocol_version !== 1 || config?.schema_version !== 1 || !valid(config.port)))
    throw hostingError('operation_conflict', 'The saved host configuration cannot be used for a public review.');
  if (config?.circle_id && config.reachability?.kind !== 'gozar')
    throw hostingError('operation_conflict', 'The signed circle hosting method cannot change; keep its original reach.');
  if (port !== undefined && config && port !== config.port)
    throw hostingError('operation_conflict', 'Keep the saved host port before reviewing public exposure.');

  const saved = readHostingState(home)?.spec;
  const chosen = port ?? config?.port ?? 8787;
  const target = '127.0.0.1:' + chosen;
  if (saved && (saved.target !== target || saved.reach !== 'internet' || (saved.address ?? 'stable') !== 'stable'))
    throw hostingError('operation_conflict', 'The saved exposure differs from the intended public target; keep it or close it first.');
  const origin = config?.v1_origin ?? saved?.origin;
  if (origin !== undefined && origin !== null) {
    let url;
    try { url = new URL(origin); } catch { /* reject an invalid saved origin below */ }
    if (url?.protocol !== 'https:' || url.origin !== origin || (saved?.origin && saved.origin !== origin))
      throw hostingError('operation_conflict', 'Keep the original signed HTTPS address when reviewing public exposure.');
  }
  return {home, port:chosen, target, ...(origin && {origin}),
    ...(saved?.providerId ? {retainedOffer:{providerId:saved.providerId, usage:saved.usage === 'durable' ? 'durable' : 'attached'}} : {})};
}

const catalogText = value => typeof value === 'string';
const catalogList = (value, accepts) => Array.isArray(value) && value.every(accepts);
function ownerReviewCost(value) {
  if (!value || !catalogText(value.summary)) return null;
  const {kind,summary,amount,currency,period} = value;
  if (kind === 'free' || kind === 'unknown') return {kind,summary};
  return kind === 'paid' && Number.isFinite(amount) && catalogText(currency) && catalogText(period)
    ? {kind,summary,amount,currency,period} : null;
}
function ownerReviewNotice(value) {
  if (!value || !catalogText(value.revision) || !catalogText(value.text) || !Array.isArray(value.links)) return null;
  const links = [];
  for (const link of value.links) {
    if (!link || !['terms','privacy'].includes(link.rel) || !catalogText(link.label) || !catalogText(link.href)) return null;
    const url = URL.parse(link.href);
    if (url?.protocol !== 'https:' || url.username || url.password) return null;
    links.push({rel:link.rel,label:link.label,href:link.href});
  }
  return {revision:value.revision,text:value.text,links};
}
function ownerReviewOffer(offer, {target,origin,usage}) {
  const {approval,consent,display,providerId,setup} = offer;
  const scope = consent?.scope, query = scope?.query, facts = consent?.disclosures;
  const digest = consent?.consentFactsDigest;
  if (!catalogText(providerId) || !providerId || setup?.state !== 'ready' || !approval?.candidateToken ||
      !catalogText(digest) || !digest || approval.consentFactsDigest !== digest ||
      scope?.kind !== 'route' || scope.providerId !== providerId || query?.usage?.kind !== usage ||
      query.target !== target || query.reach !== 'internet' || query.transport !== 'https' ||
      query.expectedOrigin !== (origin ?? null) || facts?.reach !== 'internet' || facts.transport !== 'https' ||
      facts.address?.stability !== 'stable' || !display ||
      ![display.label,display.description,display.needs].every(catalogText)) return null;
  const {traffic,address,ownership,lifetimes,supervision,protocols} = facts;
  const cost = ownerReviewCost(facts.cost), disclosure = ownerReviewNotice(facts.disclosure);
  if (!traffic || !['endpoint','provider','unknown'].includes(traffic.tlsTermination) ||
      !(traffic.providerCanReadPayload === null || typeof traffic.providerCanReadPayload === 'boolean') ||
      !catalogList(traffic.readers,catalogText) || !catalogList(traffic.metadataVisibleTo,catalogText) ||
      !catalogText(address.scope) || !catalogList(address.conditions,catalogText) ||
      !['gozar-owned','external-owned'].includes(ownership) || !cost || !disclosure ||
      !catalogList(lifetimes,value=>['session','attached','durable'].includes(value)) ||
      !['controller','provider-persistent','host-supervised'].includes(supervision) ||
      !protocols || ![protocols.sse,protocols.streamableHttp,protocols.oauthDcr].every(value=>typeof value === 'boolean')) return null;
  if (Object.hasOwn(address,'ports') && address.ports !== null &&
      !catalogList(address.ports,value=>Number.isSafeInteger(value) && value >= 1)) return null;
  return {
    providerId,usage,consentFactsDigest:digest,
    display:{label:display.label,description:display.description,needs:display.needs},
    disclosures:{
      reach:'internet',transport:'https',
      traffic:{tlsTermination:traffic.tlsTermination,providerCanReadPayload:traffic.providerCanReadPayload,
        readers:[...traffic.readers],metadataVisibleTo:[...traffic.metadataVisibleTo]},
      address:{stability:'stable',scope:address.scope,conditions:[...address.conditions],
        ...(Object.hasOwn(address,'ports') && {ports:address.ports === null ? null : [...address.ports]})},
      ownership,cost,lifetimes:[...lifetimes],supervision,
      protocols:{sse:protocols.sse,streamableHttp:protocols.streamableHttp,oauthDcr:protocols.oauthDcr},
      disclosure,
    },
  };
}

/** Local catalog leaf, not an authorization boundary or a launch operation. */
export async function reviewPublicHostOffers(options = {}, {hostingApi} = {}) {
  const {home,port,target,origin,retainedOffer} = resolveHostReviewTarget(options);
  const exposure = coordinatorHosting(home,hostingApi);
  const offers = [];
  for (const usage of retainedOffer ? [retainedOffer.usage] : ['attached','durable']) {
    const rows = await exposure.offers({target,reach:'internet',address:'stable',usage,
      ...(retainedOffer && {providerId:retainedOffer.providerId}),...(origin && {origin})});
    for (const row of rows) {
      if (retainedOffer && row.providerId !== retainedOffer.providerId) continue;
      const offer = ownerReviewOffer(row,{target,origin,usage});
      if (offer) offers.push(offer);
    }
  }
  return offers.length ? {status:'ready',port,offers} : {status:'unavailable',port,offers,
    nextAction:'Complete public route setup, then review the offers again.'};
}

/** Reopening checks durable identity; it never resets rosters, jobs or invites. */
export async function provisionLocalCircle({home, circle, additional = false,device}) {
  const {provisionV1Store, openV1Store} = await import('./store.mjs');
  const dbPath = additional ? path.join(home, 'v1', 'circles', circle.id, 'coordinator.sqlite')
    : path.join(home, 'v1', 'coordinator.sqlite');
  // SQLite can exist before its first configuration transaction commits. The
  // saved signed bootstrap is the only authority to finish that transaction.
  let provisioning;
  try {provisioning=JSON.parse(fs.readFileSync(circle.provisioningPath,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const provision=()=>{
    if(provisioning&&(provisioning.circle_id!==circle.id||provisioning.origin!==circle.origin||
      provisioning.root_fingerprint!==circle.pinnedRootFingerprint||Boolean(provisioning.lan_mode)!==Boolean(circle.lanMode)))
      fail('saved provisioning identity does not match this host');
    if(!fs.existsSync(dbPath))return provisionV1Store({path:dbPath,provisioning});
    const store = openV1Store({path:dbPath, circle:circle.id, origin:circle.origin,
      rootFingerprint:circle.pinnedRootFingerprint,initialRoster:provisioning?.roster,
      lanMode:circle.lanMode===true,...(provisioning?.quotas?{quotas:provisioning.quotas}:{})});
    try {
      const config = store.configuration();
      if (Boolean(config.lanMode) !== Boolean(circle.lanMode)) fail('stored circle LAN mode does not match this host');
      return config;
    } finally { store.close(); }
  };
  try{return provision();}
  catch(error){
    if(error.code!=='roster_expired'||typeof device?.refreshProvisioning!=='function')throw error;
    provisioning=await device.refreshProvisioning(circle.id);
    return provision();
  }
}

/** PID/port allow reuse only; signed publication below establishes readiness. */
export function hostProcessExists(status,{configPath,processKill,...io}={}) {
  if(processKill)io.probe=processKill;
  try {return coordinatorOwnerAlive(status,configPath,io);}
  catch(error){
    // Only a reason code from the identity layer crosses here; every other refusal keeps its generic message.
    if(error.code===PREVIOUS_COORDINATOR_OTHER_INSTALL)throw Object.assign(new FaravanHostError(error.message),{code:error.code});
    fail(error.message);
  }
}

/** A lock is discovery only: the existing identity checks still authorize every PID. */
function coordinatorStatus(config, paths, io = {}) {
  const status = readCoordinatorStatus(config);
  const owners = processLockOwners(coordinatorProcessLockPath(paths.home));
  if (!owners.length) return {status, locked:false};
  if (owners.length !== 1 || owners[0].choosing) fail('cannot verify the previous coordinator process');
  const record = owners[0];
  // Retire a stale incarnation at the same PID, but preserve named identity refusals.
  const owner = status?.pid === record.pid && status.owner
    && hostProcessExists({...status, status:'starting'}, {configPath:paths.config, ...io})
    ? status.owner : assertOwnedCoordinatorProcess(record.pid, paths.config, io);
  const starting = {protocol_version:1, status:'starting', pid:record.pid, owner, port:config.port};
  if (!hostProcessExists(starting, {configPath:paths.config, ...io}))
    fail('cannot verify the previous coordinator process');
  // Do not use an identity captured across a release/replacement of this gate.
  const current = processLockOwners(coordinatorProcessLockPath(paths.home));
  if (current.length !== 1 || current[0].choosing || current[0].token !== record.token)
    fail('cannot verify the previous coordinator process');
  return {status:sameCoordinatorOwner(status?.owner, owner) && status.status !== 'stopped' ? status : starting, locked:true};
}

/** A stale status PID must never authorize stopping an unrelated process. */
export function assertOwnedCoordinatorProcess(pid,configPath,options={}) {
  try {
    const current=captureCoordinatorOwner(pid,configPath,options);
    if(options.expectedOwner&&!sameCoordinatorOwner(current,options.expectedOwner))fail('cannot verify the previous coordinator process');
    return current;
  }
  catch(error){fail(error.message);}
}

export function stopOwnedCoordinatorProcess(pid, configPath, {signal = process.kill, ...identityOptions} = {}) {
  assertOwnedCoordinatorProcess(pid, configPath, identityOptions);
  // Limit: the OS has no atomic signal-by-incarnation call, so PID reuse can race this final signal.
  // On Windows SIGTERM is forceful; the coordinator cannot run graceful shutdown handlers.
  signal(pid, 'SIGTERM');
}

/**
 * Install the TERM barrier before startup's first await. A signal waits for startup to settle,
 * including an in-flight startServer, then stops only the handle this launch owns.
 * acknowledge must finish writing its proof before exit. No acknowledgement on uncertain cleanup.
 * A launch that fails by itself, after its own cleanup is proven (cleanupVerified), acknowledges too, so a launcher
 * that exits without a signal can still be told apart from one that left a coordinator behind. At most one acknowledgement.
 */
export function hostLaunchWithCleanup(run, {signals = process, acknowledge, exit = code => process.exit(code)} = {}) {
  const abort = new AbortController();
  let stopping = false;
  const result = Promise.resolve().then(() => run(abort.signal));
  let acknowledged = false;
  const proveCleanup = async () => {
    if (acknowledged) return;
    acknowledged = true;
    await acknowledge();
  };
  // Attached before the caller's own handler, so a synchronous acknowledge is written before the caller exits.
  result.catch(async error => {
    if (stopping || error?.cleanupVerified !== true) return;
    try { await proveCleanup(); } catch { /* no proof is written; the launcher stays unverified */ }
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    void (async () => {
      try {
        let hosted;
        try { hosted = await result; }
        catch (error) { if (error?.cleanupVerified !== true) throw error; }
        if (hosted) {
          // An adopted host is not ours to stop, and cannot authorize rollback.
          if (!hosted.process?.stop) throw new Error('host cleanup ownership is unverified');
          await hosted.process.stop();
          await hosted.closeTunnel?.();
        }
        await proveCleanup();
        exit(0);
      } catch { exit(1); }
    })();
  };
  signals.on('SIGTERM', stop);
  return {result, get stopping() { return stopping; }, dispose: () => signals.removeListener('SIGTERM', stop)};
}

// An automatic restart waits this long for the host lock, the same budget as the app's waitReady (bin/faravan). A
// restart that gives up at once leaves a wanted host down until the next app start (TLC Hosting_h4).
export const RESUME_LOCK_WAIT_MS = 10000;

export async function hostV1(options = {}, seams = {}) {
  const platform = seams.platform ?? process.platform;
  const processOptions={platform,readFile:seams.identityReadFile,execFile:seams.identityExecFile,probe:seams.processKill,...seams.identityOptions};
  const {home = coordinatorHome(), base = path.dirname(home), name, port, tunnel, origin, newCircle = false} = options;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) fail('--port must be a number between 1 and 65535');
  ensureDurableDirectory(home, {base});
  // The wait only delays the under-lock checks below (assertResumable); it never skips them.
  const release = await acquireProcessLock(path.join(home, 'host-v1'),
    options.resume ? {timeoutMs:RESUME_LOCK_WAIT_MS, signal:options.signal} : {});
  // While this is true no stop can run, so a coordinator launched now needs no restart fence (coordinatorLaunchEnv).
  let holdsLock = true;
  // Until discovery succeeds, a failed launch cannot prove this home has no live coordinator.
  let started, startAttempted = false, adopted = true, exposureForStart, launchExposure;
  const checkAbort = () => { if (options.signal?.aborted) throw Object.assign(new Error('host launch was cancelled'), {code:'host_launch_aborted'}); };
  try {
    checkAbort();
    // An automatic restart (app start, autostart, an update) runs only while the owner still wants this host. It is
    // checked under the host lock, before anything starts: an owner's stop that ran first wins (assertResumable).
    if (options.resume) assertResumable(home, options.resume);
    let device;
    try {
      device = await (seams.openDevice || openDevice)({ensureDefault:false, origin:null,
        startupLockTimeoutMs:OWNER_LOCK_WAIT_MS});
    } catch (error) {
      if (error.code !== 'device_busy') throw error;
      // No host config, tunnel, port or coordinator has been created or adopted
      // by this launch; device admission cannot require host cleanup.
      adopted = false;
      throw Object.assign(new FaravanHostError('The device is busy. Start hosting again.'), {code:'device_busy'});
    }
    let {config, paths} = ensureV1HostState({home, base, port, name});
    const primary = config.circle_id ? device.selectCircle(config.circle_id) : null;
    const additional = Boolean(config.circle_id && (newCircle || name && name !== (config.circle_name??config.collective_name) && name !== primary?.name));
    if (name && !additional) config = save(paths, {...config, circle_name:name, collective_name:name});
    if (port !== undefined && port !== config.port) {
      if (config.circle_id || coordinatorHosting(home,seams.hostingApi).read())
        fail('this host already has a local target; keep its port until the exposure is closed');
      config = save(paths, {...config, port});
    }
    const {status:previous, locked} = coordinatorStatus(config, paths, processOptions);
    const occupied = await seams.portInUse(config.port, coordinatorBindHost({reachability:config.reachability}));
    if (locked && (!occupied || !['listening','public_listening'].includes(previous.status))) {
      adopted = true;
      throw Object.assign(new FaravanHostError('The coordinator is still starting. Wait for it to become ready or stop hosting before starting again.'), {code:'coordinator_starting'});
    }
    let running = occupied && (seams.processExists || (status=>hostProcessExists(status,{configPath:paths.config,...processOptions})))(previous)
      && previous.port === config.port;
    adopted = Boolean(running);
    if (occupied && !running) {
      if (port !== undefined || config.circle_id || coordinatorHosting(home,seams.hostingApi).read()) fail(`port ${config.port} is already in use; stop the other program or choose a different --port before creating a circle`);
      config = save(paths, {...config, port:await seams.freePort()});
    }
    const existing = config.reachability;
    const exposure = coordinatorHosting(home, seams.hostingApi);
    const loopback = !tunnel && !origin && legacyLoopbackOrigin(config);
    const legacyExternal = origin && !running && externalHostOrigin(existing)===origin;
    if (existing && !['lan','gozar'].includes(existing.kind) && !legacyExternal && !loopback) {
      const inspected = await exposure.inspectLegacy({stateFiles:[paths.config], target:'127.0.0.1:'+config.port, origin:config.v1_origin});
      const detail = inspected.nextAction?.instructions ?? 'The previous owner must hand back the exact exposure.';
      throw hostingError('legacy_exposure_pending', 'Legacy exposure remains in the saved host configuration. ' + detail, {action:inspected.nextAction});
    }
    const selection = tunnel ?? (origin ? 'public' : undefined) ?? (existing?.kind === 'lan' ? 'lan' : undefined);
    let reachability = loopback ? existing : selection === 'lan' ? {kind:'lan'} : {kind:'gozar'};
    if (config.circle_id && reachability.kind !== existing?.kind && !legacyExternal)
      fail('the signed circle hosting method cannot change; keep its original reach');
    if (reachability.kind === 'lan') {
      if (exposure.read()) throw hostingError('operation_conflict','Close the saved exposure before switching to LAN.');
      if (origin) fail('an existing HTTPS origin requires public reach');
      reachability.publicUrl = resolveLanUrl({port:config.port,
        ...(seams.networkInterfaces ? {networkInterfaces:seams.networkInterfaces()} : {})});
      if (config.v1_origin && config.v1_origin !== reachability.publicUrl)
        fail('the signed circle origin cannot change; restore its original address');
    } else if (!loopback && !running && !options.resume) {
      const saved = exposure.read()?.spec;
      const requirement = selection ? routeSelector(selection) : saved ? {reach:saved.reach,providerId:saved.providerId} :
        routeSelector(await seams.chooseReachability());
      if (origin && config.v1_origin && origin !== config.v1_origin) fail('the signed circle origin cannot change');
      const requestedOrigin=origin??saved?.origin;
      const spec = {target:'127.0.0.1:'+config.port,address:'stable',...(requestedOrigin&&{origin:requestedOrigin}),...requirement};
      if (!seams.interaction) throw hostingError('consent_required','Review the Gozar exposure in an interactive Faravan terminal.');
      await prepareHosting(exposure, spec, seams.interaction);
    } else if (selection && running) {
      const saved = exposure.read()?.spec;
      const requirement = routeSelector(selection);
      if (!saved || origin && origin!==config.v1_origin || requirement.reach !== saved.reach || requirement.providerId && requirement.providerId !== saved.providerId)
        throw hostingError('operation_conflict','Stop the current exposure before selecting a different offer.');
    }
    config = save(paths, {...config, reachability});
    if (reachability.kind === 'gozar') exposureForStart=exposure;
    let circle = !additional ? primary : null;
    const createAndProvision = async origin => {
      if (circle && (circle.origin !== origin || circle.pinnedRootFingerprint !== config.root_fingerprint))
        fail('the host origin or circle root changed; restore the original configuration');
      circle = circle || await device.createCircle(origin, {name:additional ? name || 'My circle' : config.circle_name??config.collective_name, publish:false, reuse:!newCircle, lanMode:reachability.kind === 'lan'});
      if (config.circle_id && !additional && circle.id !== config.circle_id) fail('the host circle identity changed');
      if (!additional) config = save(paths, {...config, circle_id:circle.id, root_fingerprint:circle.pinnedRootFingerprint,
        reachability, v1_origin:origin, provisioning_path:circle.provisioningPath});
      await (seams.provision || provisionLocalCircle)({home, circle, additional,device});
      config = save(paths, {...config, circle_ids:[...new Set([config.circle_id, ...(config.circle_ids || []), circle.id])]});
    };
    const knownOrigin = loopback || (reachability.kind === 'lan' ? reachability.publicUrl : null);
    if (knownOrigin) await createAndProvision(knownOrigin);
    // Older processes own only the legacy handler. Replace that process once;
    // its database, blobs and signed paths stay exactly where they were.
    if (running && additional && previous.circles_router !== true) {
      if (!seams.stopServer) fail('this host needs an automatic restart before the new circle can start');
      assertOwnedCoordinatorProcess(previous.pid,paths.config,{...processOptions,expectedOwner:previous.owner});
      await seams.stopServer(config, previous);
      running = false;
      adopted = false;
    }
    adopted = Boolean(running);
    checkAbort();
    if(exposureForStart)launchExposure=exposureForStart.read();
    if (!running) {
      try {fs.unlinkSync(config.status_path);} catch (error) {if (error.code !== 'ENOENT') throw error;}
      startAttempted = true;
      // Only automatic restarts are gated by the saved intent. An explicit start records intent after proof.
      started = await seams.startServer(config, paths, {holdsLock:() => holdsLock, resume:Boolean(options.resume)});
      checkAbort();
    }
    const status = running ? previous : await seams.waitReady(config, started);
    checkAbort();
    if (status?.status === 'exposure_blocked')
      throw hostingError(status.code,'Gozar could not publish this coordinator. Review its exposure status and retry.', {route:status.route});
    if (!status || status.protocol_version !== 1 || !['listening','public_listening'].includes(status.status) || !status.public_url)
      fail(`the v1 coordinator did not become ready; its last output is saved in ${started?.logPath ?? paths.home}, fix the cause, then run faravan host again`);
    if (config.v1_origin && status.public_url !== config.v1_origin) fail('the tunnel address changed; restore the original signed circle address before inviting members');
    if (reachability.kind === 'gozar') {
      if (publishedOrigin(await exposure.operationStatus(launchExposure), '127.0.0.1:'+config.port) !== status.public_url)
        throw hostingError('verification_failed','Gozar has withdrawn the verified coordinator address.');
    }
    if (!circle || reachability.kind === 'gozar') await createAndProvision(status.public_url);
    // Both calls authenticate and verify the pinned circle. Never print a
    // ready message based on a port or status file alone.
    checkAbort();
    await device.publishRoster(circle.id);
    checkAbort();
    const links = await device.createInviteLinks(circle.id);
    checkAbort();
    // The owner wants this circle hosted until they stop it: the app starts it again after a restart (host-intent.mjs).
    // Only the owner's own start records that; an automatic restart never does.
    if (!options.resume && config.host_wanted !== true) config = save(paths, {...config, host_wanted:true});
    return {status:'ready', circle, origin:circle.origin, invite:links.short ?? links.long, inviteNote:links.note, config, reach:exposure.read()?.spec.reach ?? 'lan', process:started || null};
  } catch (error) {
    let cleanupError;
    try { await started?.stop?.(); }
    catch (failure) { cleanupError = failure; }
    let exposureQuiet=true, exposureCleanupError;
    if (startAttempted && exposureForStart) {
      try {
        const stopped=await exposureForStart.shutdown({expected:launchExposure});
        // A missing operation in the route list does not prove a failed launch retired it.
        exposureQuiet=stopped?.cleanup.state==='confirmed';
      } catch (failure) {exposureQuiet=false;exposureCleanupError=failure;}
    }
    // A start that threw before returning its handle may have effects we cannot prove stopped.
    throw Object.assign(error, {
      cleanupVerified:!cleanupError && !adopted && exposureQuiet && (!startAttempted || typeof started?.stop === 'function'),
      ...(cleanupError && {cleanupError}),
      ...(exposureCleanupError && {exposureCleanupError}),
    });
  } finally { holdsLock = false; release(); }
}


// A supervisor's crash restart carries the stop generation the supervisor saw, by environment: the coordinator's
// process identity (coordinator-owner.mjs) is its exact argv, so a flag would make the restarted coordinator unverifiable.
export const RESTART_GENERATION_ENV = 'FARAVAN_COORDINATOR_RESTART_GENERATION';
export const LAUNCH_GENERATION_ENV = 'FARAVAN_COORDINATOR_LAUNCH_GENERATION';

/**
 * Every launch carries a generation snapshot because its parent may die before child startup.
 * While hostV1 holds host-v1, the child needs no parent-lock restart fence. Later crash
 * restarts also carry RESTART_GENERATION_ENV for the existing fenceCoordinatorRestart.
 */
export function coordinatorLaunchEnv(env, {fenced, stopGeneration}) {
  const {[RESTART_GENERATION_ENV]:_inherited, [LAUNCH_GENERATION_ENV]:_launch, ...clean} = env;
  const launch = {...clean, [LAUNCH_GENERATION_ENV]:stopGeneration ?? 'initial'};
  return fenced ? {...launch, [RESTART_GENERATION_ENV]:stopGeneration ?? 'initial'} : launch;
}


/**
 * Every managed launch carries the generation read by its launcher under host-v1.
 * Run after taking coordinator-v1: an earlier stop changed the generation; a later
 * stop discovers this gate. Never wait on the parent-held host-v1 gate here.
 * An explicit start after a prior stop carries that stop's generation and is allowed.
 */
export function assertCoordinatorLaunchGeneration(configFile, env = process.env) {
  const generation = env[LAUNCH_GENERATION_ENV];
  if (generation === undefined) return;
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { /* fail closed */ }
  if (config?.protocol_version === 1 && (config.stop_generation ?? 'initial') === generation) return;
  throw Object.assign(new FaravanHostError('Hosting changed after this coordinator was launched, so it was not started.'), {code:'host_not_wanted'});
}

/**
 * Run by the coordinator before any side effect. A crash restart starts only while the owner still wants the host and
 * no stop has run since the supervisor decided to restart (assertResumable), checked under the host lock. Still under
 * the lock, writeStarting records this process in the status file, so a stop that runs next finds and stops it.
 * Throws host_not_wanted after a stop; nothing has started then.
 */
export async function fenceCoordinatorRestart({configFile, env = process.env, writeStarting = () => {}, lockTimeoutMs = 5000}) {
  const generation = env[RESTART_GENERATION_ENV];
  if (generation === undefined) return false;
  const home = path.dirname(path.resolve(configFile));
  const release = await acquireProcessLock(path.join(home, 'host-v1'), {timeoutMs:lockTimeoutMs});
  try {
    assertResumable(home, {stopGeneration:generation === 'initial' ? null : generation});
    writeStarting();
  } finally { release(); }
  return true;
}

/** The coordinator supervisor restarts a crashed coordinator only while no stop has run since it started. */
export function supervisorMayRestart(configPath, stopGeneration) {
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return saved.stop_generation === stopGeneration && saved.host_wanted !== false;
  } catch { return false; }
}

/**
 * A planned automatic restart observed stopGeneration (null when the host was never stopped). Every stop saves a new
 * generation, and the owner's stop also saves host_wanted:false, so either change means the owner stopped hosting
 * after the restart was planned. Then it refuses with host_not_wanted, and nothing starts.
 */
export function assertResumable(home, {stopGeneration = null} = {}) {
  let config = null;
  try { config = JSON.parse(fs.readFileSync(hostPaths(home).config, 'utf8')); } catch { /* no host to restart */ }
  if (config?.protocol_version === 1 && config.host_wanted !== false && (config.stop_generation ?? null) === stopGeneration) return;
  throw Object.assign(new FaravanHostError('Hosting was stopped by its owner, so it was not started again.'), {code:'host_not_wanted'});
}

/**
 * The coordinator this home runs now, as {pid, owner}, or null when none runs. Absence and a dead PID are null;
 * a live coordinator whose identity cannot be verified throws rather than reading as absent.
 */
export function hostedCoordinatorRecord(home = coordinatorHome(), io = {}) {
  const paths = hostPaths(home);
  if (!fs.existsSync(paths.config)) return null;
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  if (config.protocol_version !== 1) return null;
  const {status} = coordinatorStatus(config, paths, io);
  if (!hostProcessExists(status, {configPath: paths.config, ...io})) return null;
  return {pid: status.pid, owner: status.owner};
}

/**
 * Explicit stop and uninstall share durable ownership checks. An expectedOwner (an update's record) must still verify
 * before anything is retired, removed or signalled.
 */
export async function stopV1Host({home = coordinatorHome(), expectedOwner} = {}, seams = {}) {
  const platform = seams.platform ?? process.platform;
  const processOptions={platform,readFile:seams.identityReadFile,execFile:seams.identityExecFile,probe:seams.processKill,...seams.identityOptions};
  const paths = hostPaths(home);
  if (!fs.existsSync(paths.config)) {
    // A named coordinator whose config is gone may still run. Reading that as "stopped" would let an update swap under it.
    if (expectedOwner || coordinatorHosting(home,seams.hostingApi).read())
      fail('the host config is missing, so the recorded coordinator cannot be verified; it was not stopped');
    return;
  }
  const release = await acquireProcessLock(path.join(home, 'host-v1'));
  try {
    const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    const exposure = coordinatorHosting(home,seams.hostingApi);
    const hasExposure = exposure.read() !== null;
    if (seams.exposureOnly && !hasExposure && (!config.reachability || config.reachability.kind === 'lan')) return;
    if (config.protocol_version !== 1) fail('this directory is not a v1 host');
    const changed = () => fail('the coordinator changed after it was recorded; it was not stopped');
    if (expectedOwner) {
      const {status:current} = coordinatorStatus(config, paths, processOptions);
      if (!current || !sameCoordinatorOwner(current.owner, expectedOwner)) changed();
      assertOwnedCoordinatorProcess(expectedOwner.pid, paths.config, {...processOptions, expectedOwner});
      const reachability = config.reachability;
      if (reachability && !['lan','gozar'].includes(reachability.kind) && !legacyLoopbackOrigin(config)) {
        let action;
        try {
          const inspected = await exposure.inspectLegacy({stateFiles:[paths.config],
            target:'127.0.0.1:'+config.port,origin:config.v1_origin});
          action = inspected.nextAction;
        } catch { /* Inspection failure does not authorize stopping the live host. */ }
        throw hostingError('legacy_exposure_pending',
          'Review the saved legacy exposure before updating this host.', {action});
      }
    }
    // Retire this supervisor generation before signalling its child. A later
    // explicit start observes the new generation and may supervise again.
    // The owner's stop also ends the intent first, so the app never starts this host again, even when this stop fails.
    save(paths, {...config, stop_generation:randomUUID(), ...(seams.clearIntent ? {host_wanted:false} : {})});
    const {status} = coordinatorStatus(config, paths, processOptions);
    if (expectedOwner && (!status || !sameCoordinatorOwner(status.owner, expectedOwner))) changed();
    const alive = seams.processExists || (status=>hostProcessExists(status,{configPath:paths.config,...processOptions}));
    if (alive(status)) {
      const identityOptions={...processOptions,expectedOwner:expectedOwner ?? status.owner,signal:seams.signal??processOptions.signal};
      assertOwnedCoordinatorProcess(status.pid,paths.config,identityOptions);
      if (seams.stopServer) await seams.stopServer(config, status);
      else stopOwnedCoordinatorProcess(status.pid,paths.config,identityOptions);
      // A stop is verified, not assumed: the coordinator must be gone before this reports success. Callers that
      // depend on it (remove.sh, when the user's service manager cannot be reached) treat a failure as "still running".
      const pause = seams.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
      let stillAlive;
      try {
        stillAlive = alive(status);
        for (let i = 0; stillAlive && i < 75; i++) {
          await pause(200);
          stillAlive = alive(status);
        }
      } catch {
        fail('could not verify that the coordinator stopped; check the host status and try again');
      }
      if (stillAlive) fail('The coordinator did not stop after its signal (pid ' + status.pid + ').');
    }
    // The status file can be stale. Verify the local port even when remote cleanup cannot finish.
    let listenerError;
    try {
      if (seams.portAnswers) await stopWhatServesPort({config, status, paths, processOptions, seams});
    } catch (error) { listenerError = error; }
    try {
      // expectedOwner fences identity; it never authorizes leaving a public route forwarding.
      if (config.reachability?.kind === 'gozar' || hasExposure) {
        const route = await exposure.close({origin:config.v1_origin});
        if (route && route.cleanup.state !== 'confirmed')
          throw hostingError('cleanup_debt','Gozar could not confirm removal of the exact host exposure.',{route});
        // Internal restarts retain setup/selection intent, not the removed route's authority.
        // A later allocation needs a fresh approval because close rotates the operation.
        if (!expectedOwner || seams.clearIntent) {
          const pending = await exposure.cancelSetup();
          const operation = seams.interaction ? await seams.interaction.driveSetup(exposure,pending,{cleanup:true}) : pending;
          if (!await exposure.finishSetupCleanup(operation))
            throw hostingError('cleanup_debt','Gozar requires another cleanup step for the saved setup operation.',{operation});
        }
      } else if (config.reachability && config.reachability.kind !== 'lan' && !externalHostOrigin(config.reachability)) {
        throw hostingError('legacy_exposure_pending','The legacy exposure record is retained. Exact provider cleanup has not been confirmed.');
      }
    } catch (error) {
      if (!listenerError) throw error;
      throw hostingError(listenerError.code, listenerError.message + ' ' + error.message, {
        running:listenerError.running, route:error.route, operation:error.operation, action:error.action,
        errors:[listenerError, error],
      });
    }
    if (listenerError) throw listenerError;
  } finally { release(); }
}

/**
 * A stop is proven at the circle's port, not only by the recorded process: a status file can name an older process
 * than the one serving members. The port is checked on every address a coordinator can bind (loopback, the recorded
 * and configured bind address, and each local interface address), and its listeners are listed on any address, because
 * silence at one address does not prove the port is free. A listener this install verifies as this home's coordinator
 * is stopped too; any other program is never signalled. Anything still serving after that is named, and the stop fails
 * with host_still_running instead of reading as stopped.
 */
async function stopWhatServesPort({config, status, paths, processOptions, seams}) {
  if (!Number.isInteger(config.port)) return;
  const pause = seams.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const addresses = coordinatorAddresses({config, status, networkInterfaces:seams.networkInterfaces});
  const listeners = async () => { try { return await (seams.portListeners?.(config.port) ?? []); } catch { return []; } };
  const answers = async () => (await listeners()).length > 0
    || (await Promise.all(addresses.map(host => seams.portAnswers(config.port, host)))).some(Boolean);
  const settle = async rounds => {
    let busy = await answers();
    for (let i = 0; busy && i < rounds; i++) { await pause(200); busy = await answers(); }
    return busy;
  };
  if (!await settle(25)) return;
  let stopped = false;
  for (const listener of await listeners()) {
    try {
      const owner = assertOwnedCoordinatorProcess(listener.pid, paths.config, processOptions);
      stopOwnedCoordinatorProcess(listener.pid, paths.config, {...processOptions, expectedOwner:owner, signal:seams.signal ?? processOptions.signal});
      stopped = true;
    } catch { /* not verifiably this home's coordinator: named below, never signalled */ }
  }
  if (stopped && !await settle(75)) return;
  const still = await listeners();
  const named = still.map(l => 'pid ' + l.pid + (l.command ? ' (' + l.command + ')' : '')).join(', ');
  throw Object.assign(new FaravanHostError(named
    ? 'Hosting is still running on port ' + config.port + ': ' + named + '. Faravan could not stop it, so it was left running. Stop that program, then stop hosting again.'
    : 'Something still answers on port ' + config.port + ' after hosting stopped, and Faravan could not tell which program it is. Hosting may still be running.'),
  {code:'host_still_running', running:still});
}

/** The addresses a coordinator for this config may listen on. A wildcard bind answers on loopback. */
export function coordinatorAddresses({config, status, env = process.env, networkInterfaces = os.networkInterfaces}) {
  const hosts = new Set(['127.0.0.1', '::1']);
  if (typeof status?.host === 'string' && status.host) hosts.add(status.host);
  const envHost = env.FARAVAN_COORDINATOR_HOST;
  if (envHost) hosts.add(envHost);
  try { hosts.add(coordinatorBindHost({reachability:config.reachability})); } catch { /* no LAN address recorded */ }
  try {
    // Link-local IPv6 needs an interface scope to connect, so it is named with one.
    for (const [name, list] of Object.entries(networkInterfaces() ?? {}))
      for (const entry of list ?? []) hosts.add(/^fe80:/i.test(entry.address) ? entry.address + '%' + name : entry.address);
  } catch { /* interfaces unknown: the listener list still decides */ }
  for (const wildcard of ['0.0.0.0', '::', '']) hosts.delete(wildcard);
  return [...hosts];
}
