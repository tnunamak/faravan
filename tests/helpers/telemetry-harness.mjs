// Shared by the telemetry runtime tests: a telemetry instance on a synthetic home with a manual clock, a deterministic
// random source and a capture transport that records the decompressed request bodies.
import { ownTempDir, tempDir } from './temp-dir.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {CATALOG} from '../../lib/v1/telemetry/catalog.mjs';
import {createConsent} from '../../lib/v1/telemetry/consent.mjs';
import { createTelemetry } from '../../lib/v1/telemetry/index.mjs';

export const catalogRemoteFactory=({consent})=>{
 const renew=()=>consent.current().effective==='on'?consent.grantRemoteLease(consent.current().generation):consent.revokeRemoteLease();
 renew();return {allowed:()=>consent.current().effective==='on',poll:async()=>consent.tryWithAuthority(renew),reset:renew,cancel(){}};
};
/** Fixture evidence for tests of catalog projection rather than remote polling. */
export function edgeCapture(h) {
 const consent=createConsent({dir:h.dir,base:h.dir,uploadable:true,now:h.clock.now});
 const lease=consent.grantRemoteLease(h.tel.status().generation);
 return lease?{lease_id:lease.id,captured_at:h.clock.now()}:undefined;
}


export const RELEASE = '0.1.0-preview.20261020.7';
export const ENDPOINT = 'https://us.i.posthog.com/batch/';
export const START = Date.UTC(2026, 9, 21, 19, 5, 0);

/** A repeatable byte source: the same seed gives the same IDs. */
export function seededBytes(seed = 1) {
  let state = seed >>> 0;
  return length => Buffer.from(Array.from({length}, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; }));
}

export function manualClock(start = START) {
  let t = start;
  return {now: () => t, advance: ms => { t += ms; return t; }, set: ms => { t = ms; return t; }};
}

export function catalogView(event) {
    const {schema_version,app_version,surface,$geoip_disable,$set,...properties}=event.properties;
    const top=['value','buckets','counts','duration_ms','status','period','hour'];
    return {name:event.event,attrs:{...Object.fromEntries(Object.entries(properties).filter(([key])=>!top.includes(key))),...(CATALOG.entries[event.event]?.attrs?.surface && surface ? {surface}: {})},...Object.fromEntries(top.filter(key=>properties[key]!==undefined).map(key=>[key,properties[key]]))};
  }

/** A transport that answers `status` (or whatever `respond` returns) and records every request body. */
export function captureTransport({status = 200, respond} = {}) {
  const requests = [];
  const transport = async (url, init) => {
    const body = gunzipSync(init.body).toString();
    const reply = respond ? await respond({url, init, body, count: requests.length}) : {status};
    requests.push({url, headers: init.headers, body, status: reply.status, gzipBytes: init.body.length});
    return {status: reply.status, headers: new Headers(reply.headers ?? {}), body: {cancel: async () => {}}};
  };
  transport.requests = requests;
  transport.bodies = () => requests.map(request => {const body=JSON.parse(request.body);return {...body,records:body.batch.map(event=>catalogView(event))};});
  // Catalog projection view for existing producer tests; wire tests use the unchanged batch property.
  transport.records = () => transport.bodies().flatMap(body=>body.records);
  return transport;
}

/**
 * makeTelemetry({level, region, ...}) -> {tel, dir, clock, transport, home}. Choosing `level` happens at the start unless it is
 * null (a fresh install). Options reach createTelemetry unchanged.
 */
export function makeTelemetry({t, level = 'on', region = 'US', env = {}, version = RELEASE, endpoint = ENDPOINT, dir, transport = captureTransport(),
  clock = manualClock(), health, preset = () => 'automatic', seed = 7, ...rest} = {}) {
  const home = dir ?? (t ? ownTempDir(t, 'tel-test-') : tempDir('tel-test-'));
  const tel = createTelemetry({dir: home, base: home, env, version, endpoint, transport, now: clock.now, bytes: seededBytes(seed), random: () => 0, health, preset,
    // Pure catalog tests inject a known flag result; the PostHog transport tests exercise real flag polling.
    remoteFactory:catalogRemoteFactory,
    tripwire: async () => null, ...rest});
  if (level !== null) tel.choose({level, region});

  return {tel, dir: home, clock, transport, cleanup: () => rmSync(home, {recursive: true, force: true})};
}

/** Move the clock to just past the end of the current UTC hour, run the housekeeping and upload everything due. */
export async function settle(h, {hours = 1} = {}) {
  const next = Math.ceil((h.clock.now() + 1) / 3600000) * 3600000 + 1000;
  h.clock.set(next + (hours - 1) * 3600000);
  h.tel.tick();
  h.clock.advance(11 * 60000); // past the largest hour-class delay (10 min); diagnostics wait 5 min between batches
  await h.tel.flushNow();
}

/** A loopback server that records gunzipped request bodies, for tests that need a real HTTP round trip. */
export async function captureServer({status = 200, headers = {}} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({method: req.method, headers: req.headers, raw, body: gunzipSync(raw).toString()});
      res.writeHead(status, headers);
      res.end('{"accepted":true,"ignored":"' + 'x'.repeat(100) + '"}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {requests, url: `http://127.0.0.1:${server.address().port}/v1/batch`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })};
}

/**
 * Replace fetch, http(s).request/get, net.connect and tls.connect with functions that throw for any target that is not
 * loopback. Returns {hits, restore}: every refused attempt is in `hits`. Always call restore() (try/finally).
 */
export function networkGuard() {
  const hits = [];
  const loopback = host => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(String(host));
  const hostOfUrl = value => { try { return new URL(String(value)).hostname; } catch { return String(value); } };
  const refuse = (kind, host) => {
    if (loopback(host)) return;
    hits.push({kind, host});
    throw new Error(`network guard: ${kind} to ${host}`);
  };
  const saved = {fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get,
    netConnect: net.connect, netCreate: net.createConnection, tlsConnect: tls.connect};
  const hostOfRequest = first => (typeof first === 'string' || first instanceof URL ? hostOfUrl(first) : (first?.hostname ?? first?.host ?? 'localhost'));
  const hostOfSocket = args => {
    const [first, second] = args;
    if (first && typeof first === 'object') return first.path ? 'localhost' : (first.host ?? 'localhost');
    return typeof second === 'string' ? second : 'localhost';
  };
  globalThis.fetch = (input, ...rest) => { refuse('fetch', hostOfUrl(typeof input === 'object' && input && 'url' in input ? input.url : input)); return saved.fetch(input, ...rest); };
  http.request = (...args) => { refuse('http.request', hostOfRequest(args[0])); return saved.httpRequest(...args); };
  http.get = (...args) => { refuse('http.get', hostOfRequest(args[0])); return saved.httpGet(...args); };
  https.request = (...args) => { refuse('https.request', hostOfRequest(args[0])); return saved.httpsRequest(...args); };
  https.get = (...args) => { refuse('https.get', hostOfRequest(args[0])); return saved.httpsGet(...args); };
  net.connect = net.createConnection = (...args) => { refuse('net.connect', hostOfSocket(args)); return saved.netConnect(...args); };
  tls.connect = (...args) => { refuse('tls.connect', hostOfSocket(args)); return saved.tlsConnect(...args); };
  return {hits, restore() {
    globalThis.fetch = saved.fetch; http.request = saved.httpRequest; http.get = saved.httpGet; https.request = saved.httpsRequest; https.get = saved.httpsGet;
    net.connect = saved.netConnect; net.createConnection = saved.netCreate; tls.connect = saved.tlsConnect;
  }};
}
