import {createServiceVerifier} from '@tnunamak/gozar';
/**
 * Faravan coordinator HTTP server. It serves the v1 protocol only: the v1
 * handler for /v1, /join and /i/<code>, and a JSON 404 for every other path.
 *
 * v1 reopens an explicitly provisioned circle (see provisionV1Store). The
 * server never trusts Host or X-Forwarded-* as its public origin, never accepts
 * a network-supplied root and never provisions membership itself. Until the
 * local store exists it answers v1 requests with `circle_not_provisioned`, then
 * picks the store up on the first request after local provisioning.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readFaravanVersion } from './v1/credential-probe.mjs';
import { createServer } from 'node:http';
import { openV1Store } from './v1/store.mjs';
import { createV1Handler } from './v1/server.mjs';
import { createCirclesRouter } from './v1/circles-router.mjs';
import { validateOrigin } from './protocol/index.mjs';

export class CoordinatorError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'CoordinatorError'; this.status = status; }
}
const fail = (message, status = 400) => { throw new CoordinatorError(message, status); };

export const COORDINATOR_SCHEMA_VERSION = 2;
const PUBLIC_ICON_ASSETS=new Map([['/favicon.svg',['favicon.svg','image/svg+xml']],['/favicon.ico',['favicon.ico','image/vnd.microsoft.icon']],
  ['/apple-touch-icon.png',['apple-touch-icon.png','image/png']],['/icon-192.png',['icon-192.png','image/png']],
  ['/icon-512.png',['icon-512.png','image/png']],['/icon-maskable-512.png',['icon-maskable-512.png','image/png']],
  ['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']]]);

/**
 * Creates (but does not start listening on) the coordinator's node:http
 * server. `deps.v1` is `{ dbPath, blobDir, origin }`.
 */
export function createCoordinatorServer(deps) {
  if (!deps) fail('v1 coordinator settings are required', 500);
  // v0 credentials are never interpreted: v0 state belongs to a separate home.
  if (deps.token !== undefined || deps.roster !== undefined) {
    fail('v0 collective token/roster settings are no longer supported; host v1 from a separate FARAVAN_COORDINATOR_HOME (FARAVAN_COORDINATOR_HOME remains supported)', 500);
  }
  if (deps.v1 === undefined) fail('v1 settings are required (v1.dbPath, v1.blobDir, v1.origin)', 500);

  // v1 only reopens an explicitly provisioned circle. Never trust Host or
  // X-Forwarded-* as its public origin and never provision membership here.
  const v1 = deps.v1;
  // R1: v1.circlesDir hosts many circles, each in <circlesDir>/<circle id>/ (own store, blobs and quotas).
  const multi = typeof v1?.circlesDir === 'string' && v1.circlesDir !== '';
  if (!v1 || (!multi && (typeof v1.dbPath !== 'string' || !v1.dbPath || typeof v1.blobDir !== 'string' || !v1.blobDir))) {
    fail('v1.dbPath and v1.blobDir are required', 500);
  }
  // A LAN-shaped candidate is allowed here, but the store must independently
  // authorize it from the locally provisioned, root-signed roster.
  if (!(v1.deferOrigin && multi && v1.origin == null) && !validateOrigin(v1.origin, { lanMode: true }).ok) {
    fail('v1.origin must be an explicit HTTPS, loopback or signed LAN origin', 500);
  }
  let v1Store, v1Handler, configuredOrigin, proofExpiresAt;
  let serving = !v1.deferOrigin;
  const verifyService = v1.deferOrigin ? createServiceVerifier() : null;
  function configureOrigin(origin, validUntil) {
    if (!validateOrigin(origin, {lanMode:true}).ok || (configuredOrigin && configuredOrigin !== origin))
      fail('the coordinator cannot change its signed origin', 500);
    if (!v1Handler) v1Handler = createCirclesRouter({circlesDir:v1.circlesDir, origin, versions:hostVersions(),
      legacy:typeof v1.dbPath === 'string' && typeof v1.blobDir === 'string' ? {dbPath:v1.dbPath,blobDir:v1.blobDir} : null});
    configuredOrigin = origin;
    proofExpiresAt = validUntil ? Date.parse(validUntil) : undefined;
    serving = true;
  }
  if (v1.deferOrigin && multi) {
    // The proof listener is available before a circle has a signed origin.
  } else if (multi) {
    configureOrigin(v1.origin);
  } else if (existsSync(v1.dbPath)) {
    v1Store = openV1Store({ path: v1.dbPath, origin: v1.origin, ...hostVersions() });
    try { v1Handler = createV1Handler({ store: v1Store, blobDir: v1.blobDir }); }
    catch (error) { v1Store.close(); throw error; }
  } else {
    // No network-supplied root or implicit circle provisioning.
    const body = JSON.stringify({
      type: 'urn:faravan:problem:circle_not_provisioned',
      title: 'Circle not provisioned', status: 404,
      code: 'circle_not_provisioned', retryable: false, outcome: 'not_applied',
    });
    v1Handler = async (request, response) => {
      if (existsSync(v1.dbPath)) {
        const opened = openV1Store({ path: v1.dbPath, origin: v1.origin, ...hostVersions() });
        let handler;
        try { handler = createV1Handler({ store: opened, blobDir: v1.blobDir }); }
        catch (error) { opened.close(); throw error; }
        v1Store = opened; v1Handler = handler;
        return handler(request, response);
      }
      response.writeHead(404, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    v1Handler.close = () => {};
  }
  const server = createServer((request, response) => {
    (async () => {
      try {
        if (verifyService?.(request, response)) return;
        if (!serving || (proofExpiresAt !== undefined && Date.now() >= proofExpiresAt))
          fail('coordinator exposure is awaiting verification', 503);
        const pathname = new URL(request.url, 'http://coordinator.internal').pathname;
        if(request.method==='GET'&&PUBLIC_ICON_ASSETS.has(pathname)) {
          const [name,type]=PUBLIC_ICON_ASSETS.get(pathname),asset=await readFile(new URL('../public/v1/'+name,import.meta.url));
          response.writeHead(200,{'Content-Type':type,'Content-Length':asset.length,'Cache-Control':'public, max-age=86400',
            'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});response.end(asset);return;
        }
        // The invite landing pages at /join (long links, #invite=) and /i/<code> (short links, #seed) are v1's.
        if (pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/join' || pathname.startsWith('/i/')) {
          return await v1Handler(request, response);
        }
        fail('not found', 404);
      } catch (error) {
        const known = error instanceof CoordinatorError;
        response.writeHead(known ? error.status : 500, { 'content-type': 'application/json', 'x-faravan-coordinator-schema': String(COORDINATOR_SCHEMA_VERSION) });
        response.end(JSON.stringify({ error: known ? error.message : 'internal coordinator error' }));
      }
    })();
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { v1Handler?.close(); } finally { v1Store?.close(); v1Handler?.dispose?.(); }
  };
  const close = server.close;
  server.close = function (...args) {
    // Abort pending long polls before waiting for HTTP requests to drain.
    v1Handler?.close();
    return close.apply(this, args);
  };
  if (v1.deferOrigin) {
    server.configureOrigin = configureOrigin;
    server.withdrawOrigin = () => {serving = false;};
  }
  server.once('close', dispose);
  server.once('error', () => { if (!server.listening) dispose(); });
  return server;
}

/**
 * Convenience entrypoint used by the CLI (and tests): builds the v1 server and
 * starts listening. Returns the listening `http.Server` so callers can read
 * back the bound port (useful for `port: 0` ephemeral binding in tests) and
 * close it later.
 */
// P22: what GET /capabilities tells members about this host. FARAVAN_MIN_MEMBER sets the oldest member version it works with.
function hostVersions() { return { faravanVersion: readFaravanVersion(), minMember: process.env.FARAVAN_MIN_MEMBER || null }; }

export async function startCoordinator({ token, roster, port = 0, host = '127.0.0.1', v1 }) {
  const server = createCoordinatorServer({ token, roster, v1 });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    // listen can also throw synchronously (for example, an invalid port).
    // Closing a never-listening server still emits close for disposal.
    server.close();
    throw error;
  }
  return server;
}
