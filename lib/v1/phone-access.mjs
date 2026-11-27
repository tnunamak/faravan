import {durableJsonAsync} from '../durable-write.mjs';
// Device access: a paired phone sees (and, over HTTPS, answers) review requests from this computer.
// It is a second listener with its own address, cookie and routes. It never serves the local app, never
// accepts the local session or token, and a device session only carries the scopes it was paired with.
// Pairing: the computer shows a short code (and a QR of the pairing link); the device claims it and both
// screens show the same three words; a person at this computer confirms. Then the device gets its session.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import {open, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCookie } from './loopback-security.mjs';
import { listenPreferred } from './listen-port.mjs';
import { qrPath } from './qr.mjs';

export const PAIRING_TTL_MS = 5 * 60000;
export const CONFIRM_WINDOW_MS = 2 * 60000;
export const MAX_CODE_FAILURES = 5;
const PHONE_COOKIE_MAX_AGE_S = 30 * 86400;
// Crockford base32: no I, L, O or U, so a code read aloud or typed on a device has one spelling.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PHRASE_WORDS = ['amber','anchor','apple','arrow','badger','basil','beacon','birch','bison','canyon','cedar','cobalt',
  'comet','coral','cricket','daisy','delta','ember','falcon','fern','fjord','garnet','ginger','glacier','harbor','hazel',
  'heron','indigo','iris','jasper','juniper','kestrel','lantern','lemon','lilac','lotus','maple','marble','meadow','mint',
  'nectar','nutmeg','oak','olive','orbit','otter','pebble','pepper','pine','plum','quartz','raven','river','saffron',
  'sage','salmon','tango','thistle','tulip','umber','velvet','walnut','willow','zephyr'];
const SCOPES_HTTP = ['inbox:read'];
const SCOPES_HTTPS = ['inbox:read', 'requests:answer'];
// The whole local app, chosen by the person who starts pairing. Only over a link that encrypts: HTTPS, or a
// Tailscale (WireGuard) address. Never on plain HTTP over a home network.
export const SCOPE_APP_FULL = 'app:full';
// Paths the device page owns; a full-access phone gets every other path from the local app.
const PHONE_ONLY = new Set(['/pair', '/phone.mjs', '/phone-view.mjs', '/phone.css', '/sw.js', '/manifest.webmanifest']);
const PHONE_WEB = fileURLToPath(new URL('../../public/phone/', import.meta.url));
const ICONS = fileURLToPath(new URL('../../public/v1/', import.meta.url));
const STATIC = {
  '/': ['index.html', PHONE_WEB], '/pair': ['index.html', PHONE_WEB], '/phone.mjs': ['phone.mjs', PHONE_WEB],
  '/phone-view.mjs': ['phone-view.mjs', PHONE_WEB], '/phone.css': ['phone.css', PHONE_WEB], '/sw.js': ['sw.js', PHONE_WEB],
  '/manifest.webmanifest': ['manifest.webmanifest', PHONE_WEB],
  '/fonts/instrument-sans.woff2': ['fonts/instrument-sans.woff2', PHONE_WEB], '/fonts/young-serif.woff2': ['fonts/young-serif.woff2', PHONE_WEB],
  '/icon-192.png': ['icon-192.png', ICONS], '/icon-512.png': ['icon-512.png', ICONS], '/icon-maskable-512.png': ['icon-maskable-512.png', ICONS],
  '/apple-touch-icon.png': ['apple-touch-icon.png', ICONS], '/favicon.svg': ['favicon.svg', ICONS],
};
const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 4096;

const problem = (code, status = 409, message) => Object.assign(new Error(code), {code, status, ...(message ? {message} : {})});
const sha = value => createHash('sha256').update(value).digest();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(sha(a), sha(b));

/** The canonical form of a typed code: separators dropped (space, hyphen, en dash, em dash), then ASCII only, then upper case and
 *  Crockford look-alikes folded. Other characters return '' before upper-casing, because Unicode upper-casing maps \u0131 to I and \u017f to S. */
export function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  const bare = value.replace(/[\s\-\u2013\u2014]/g, '');
  if (!/^[A-Za-z0-9]+$/.test(bare)) return '';
  return bare.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}
export const displayCode = code => code.slice(0, 4) + '-' + code.slice(4);

/** One pairing at a time. Memory only: a restart ends it, and the person starts again. */
export function createPairing({now = Date.now} = {}) {
  let current = null;
  const collecting = new Map();
  const live = () => {
    if (current && ['waiting', 'claimed'].includes(current.state) && now() >= current.expiresAt) current = {...current, state: 'expired'};
    return current;
  };
  return {
    start({full = false} = {}) {
      const code = Array.from({length: 8}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      current = {id: randomUUID(), code, state: 'waiting', createdAt: now(), expiresAt: now() + PAIRING_TTL_MS, failures: 0, full: full === true};
      return this.view();
    },
    cancel(id, matches = () => true) {
      for (const pairing of collecting.values()) {
        if ((id === undefined || pairing.id === id) && matches(pairing)) pairing.endedAs ??= 'cancelled';
      }
      if (current && (id === undefined || current.id === id) && matches(current) && ['waiting', 'claimed', 'confirmed'].includes(live().state)) {
        current.endedAs = 'cancelled';
        current = {...current, state: 'cancelled'};
      }
      return this.view();
    },
    /** The device side. A wrong code counts against the pairing; five wrong codes end it. */
    claim(code, {label, address, scopes = SCOPES_HTTP}) {
      const pairing = live();
      if (!pairing || pairing.state !== 'waiting') throw problem('pairing_not_open', 409, 'There is no pairing code waiting on the computer. Start pairing again there.');
      if (!same(normalizeCode(code), pairing.code)) {
        pairing.failures++;
        if (pairing.failures >= MAX_CODE_FAILURES) { current = {...pairing, state: 'too_many_tries'}; throw problem('too_many_tries', 429, 'Too many wrong codes. Start pairing again on the computer.'); }
        throw problem('wrong_code', 400, 'That code does not match. Check the code on the computer.');
      }
      const words = Array.from({length: 3}, () => PHRASE_WORDS[randomInt(PHRASE_WORDS.length)]);
      const secret = randomBytes(32).toString('base64url');
      current = {...pairing, state: 'claimed', phrase: words, scopes: [...scopes, ...(pairing.full ? [SCOPE_APP_FULL] : [])], claimHash: sha(secret).toString('hex'),
        // Once claimed, the person gets a fresh window to compare the words, whatever was left of the code's.
        phone: {label: cleanLabel(label), address: typeof address === 'string' ? address : null}, expiresAt: now() + CONFIRM_WINDOW_MS};
      return {secret, phrase: words, scopes: [...current.scopes], expiresAt: current.expiresAt};
    },
    /** The computer side, after a person compared the words. */
    decide(id, confirmed) {
      const pairing = live();
      if (!pairing || pairing.id !== id || pairing.state !== 'claimed') throw problem('pairing_not_open', 409, 'This pairing is no longer waiting. Start again.');
      current = {...pairing, state: confirmed ? 'confirmed' : 'rejected', decidedAt: now()};
      return this.view();
    },
    /**
     * The device polls with its claim secret. A confirmed pairing is collected exactly once: create(phone) makes the
     * session, and only its success consumes the pairing, so a refusal (too many phones) can be fixed and retried.
     * Cancellation or expiry discards the pending session; the listener commits only after collection.
     */
    async collect(secret, create, discard) {
      if (typeof discard !== 'function') throw new TypeError('collect() needs discard(session) to undo a session made for an ended pairing');
      const pairing = live();
      if (!pairing?.claimHash || typeof secret !== 'string' || !same(sha(secret).toString('hex'), pairing.claimHash)) return {state: 'unknown'};
      if (pairing.state === 'confirmed') {
        if (now() - pairing.decidedAt >= CONFIRM_WINDOW_MS) {
          pairing.endedAs = 'expired';
          current = {...pairing, state: 'expired'};
          return {state: 'expired'};
        }
        if (pairing.collecting) return {state: 'waiting_for_computer'};
        pairing.collecting = true;
        collecting.set(pairing.id, pairing);
        try {
          const created = await create(pairing.phone, [...pairing.scopes]);
          if (!pairing.endedAs && now() - pairing.decidedAt >= CONFIRM_WINDOW_MS) {
            pairing.endedAs = 'expired';
            if (current === pairing) current = {...pairing, state: 'expired'};
          }
          if (pairing.endedAs) { await discard(created); return {state: pairing.endedAs}; }
          if (current === pairing) current = {...pairing, state: 'collected', claimHash: null, collecting: false};
          return {state: 'confirmed', created};
        } finally { pairing.collecting = false; collecting.delete(pairing.id); }
      }
      return {state: pairing.state === 'claimed' ? 'waiting_for_computer' : pairing.state};
    },
    view() {
      const pairing = live();
      if (!pairing) return null;
      return {id: pairing.id, state: pairing.state, full: pairing.full === true, ...(pairing.scopes ? {scopes: [...pairing.scopes]} : {}), code: pairing.state === 'waiting' ? displayCode(pairing.code) : null,
        rawCode: pairing.state === 'waiting' ? pairing.code : null,
        expiresAt: new Date(pairing.expiresAt).toISOString(), phrase: pairing.state === 'claimed' ? pairing.phrase : null,
        phone: pairing.state === 'claimed' ? pairing.phone : null};
    },
  };
}

// Control, zero-width and bidi-override characters are dropped: the confirm card shows this label to the owner,
// and a reordered or hidden-character label could pass for another phone's name.
function cleanLabel(value) {
  const label = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 40) : '';
  return label || 'Device';
}

/** Addresses a device on the same network might use. Read-only: Faravan changes no network settings. */
export function lanAddresses(interfaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces ?? {})) for (const item of list ?? []) {
    if (item.internal || (item.family !== 'IPv4' && item.family !== 4)) continue;
    const [a, b] = item.address.split('.').map(Number);
    // Private networks only. A public address would put this listener on the internet, and the reach copy says
    // "same network"; offering it needs its own wording and design. (Only a test network reports a non-internal 127.x.)
    const kind = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 ? 'lan'
      : a === 100 && b >= 64 && b <= 127 ? 'tailnet' : null;
    if (kind) out.push({address: item.address, interface: name, kind});
  }
  const order = {lan: 0, tailnet: 1};
  return out.sort((x, y) => order[x.kind] - order[y.kind]);
}

/**
 * What a device can and cannot do with this setup, in plain words. Never more reach than is real:
 * a LAN or tailnet address works only where the device can reach it, and only while this computer is awake.
 */
export function phoneReach({enabled, listening, https, address, kind, error, full = false, tailscaleHttps = false}) {
  if (!enabled) return {state: 'off', headline: 'Device access is off', facts: ['This computer accepts connections only from itself.']};
  if (error) return {state: 'problem', headline: 'Device access is not running', facts: [error]};
  if (!listening) return {state: 'starting', headline: 'Starting device access…', facts: []};
  const where = kind === 'tailnet'
    ? 'Works while a paired device is connected to the same private network (tailnet) as this computer, this computer is awake, and Faravan is running.'
    : 'Works only while a paired device is on the same network as this computer (' + address + '), this computer is awake, and Faravan is running.';
  const choice = 'Each device gets the access you choose when you pair it: requests only, or the whole Faravan app.';
  if (https) return {state: 'https', headline: full ? 'Paired devices can use Faravan on this computer' : 'Paired devices can see and answer requests',
    facts: [where, ...(full ? [choice] : []),
      tailscaleHttps
        ? 'This connection uses HTTPS at this computer’s Tailscale address. Keep Tailscale connected on each paired device. If the browser shows a certificate warning, do not continue.'
        : 'Connections are encrypted with your certificate. Each paired device must trust it, or it will show a warning: do not continue past that warning.',
      'You can install it from the browser: Share or menu, then Add to Home Screen.',
      'No notifications yet. The device shows new requests when you open it.']};
  // Plain HTTP over a Tailscale address: WireGuard encrypts it, so the full app may be offered; answering stays HTTPS-only.
  if (full) return {state: 'http', headline: 'Paired devices can use Faravan on this computer', facts: [where,
    'Each device gets the access you choose when you pair it: requests only (it can see them, not answer them), or the whole Faravan app.',
    'Tailscale encrypts this connection.',
    'Over HTTP a paired device can add a Home Screen shortcut, but cannot install it as an app or get notifications.']};
  // Over a Tailscale address the link is encrypted; on a LAN, plain HTTP can be read by anyone on that network.
  const transport = kind === 'tailnet'
    ? 'Tailscale encrypts this connection. Answering requests still needs HTTPS.'
    : 'This uses plain HTTP, so anyone on this network could read what the device sees. That is why a device paired this way can look but not answer.';
  return {state: 'http', headline: 'Paired devices can see requests, not answer them', facts: [where,
    transport,
    'To answer from a paired device, add an HTTPS certificate that device trusts.',
    'Over HTTP a paired device can add a Home Screen shortcut, but cannot install it as an app or get notifications.']};
}

/** The device's view of one review card: who, what and how long. Prompt text only over an encrypted connection. */
export function phoneCard(card, {https}) {
  const prompt = typeof card.prompt === 'string' ? card.prompt : '';
  return {id: card.id, requester: card.localName ?? card.requesterName ?? 'A circle member', agent: card.harness ?? null,
    runtimeSeconds: Number.isFinite(card.runtimeSeconds) ? card.runtimeSeconds : null,
    network: typeof card.network === 'string' ? card.network : null,
    sourceFiles: card.sourceFiles ?? null, offer: card.offer === true, startsNow: card.startsNow !== false,
    expiresAt: Number.isFinite(card.expiresAt) ? new Date(card.expiresAt).toISOString() : null,
    ...(https ? {prompt: prompt.length > 600 ? prompt.slice(0, 599) + '…' : prompt} : {promptHidden: !!prompt}),
    ...(card.identityNotice ? {notice: card.identityNotice} : {})};
}

async function writePrivate(file, value) {
  await durableJsonAsync(file,value);
}

// Tailscale HTTPS: `tailscale serve` (tailnet only, never Funnel) terminates TLS with the machine's real ts.net
// certificate and forwards to a listener on this computer's loopback. It works where the OS firewall blocks the
// app's own listener (macOS stops incoming connections to an ad-hoc signed binary) and gives the device HTTPS.
export const TAILSCALE_SERVE_PORT = 9443;
const TAILSCALE_PATHS = ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
function runTailscale(args) {
  return TAILSCALE_PATHS.reduce((tried, bin) => tried.catch(error => {
    if (error && error.code !== 'ENOENT') throw error;
    return new Promise((resolve, reject) => execFile(bin, args, {timeout: 15000, maxBuffer: 1 << 20},
      (e, stdout, stderr) => e ? reject(Object.assign(e, {stderr: String(stderr ?? '')})) : resolve(String(stdout)))); }),
  Promise.reject(Object.assign(new Error('start'), {code: 'ENOENT'})));
}
/** The real `tailscale` CLI; tests pass their own. */
export const tailscaleCli = {
  async self() {
    const self = JSON.parse(await runTailscale(['status', '--json'])).Self;
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : '';
    const addresses = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.filter(ip => typeof ip === 'string') : [];
    return dnsName && self.Online !== false ? {dnsName, addresses} : null;
  },
  /** The proxy target already served on this HTTPS port, or null. */
  async served(port) {
    const web = JSON.parse(await runTailscale(['serve', 'status', '--json']) || '{}').Web ?? {};
    const entry = Object.entries(web).find(([host]) => host.endsWith(':' + port));
    return entry ? entry[1]?.Handlers?.['/']?.Proxy ?? 'other' : null;
  },
  serve: (port, target) => runTailscale(['serve', '--bg', '--https=' + port, target]),
  unserve: port => runTailscale(['serve', '--https=' + port, 'off']),
};

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw problem('invalid_content_type', 415);
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) throw problem('payload_too_large', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw problem('invalid_request', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('invalid_request', 400);
  return value;
}

/**
 * The app wires four seams: the session store (kind 'phone'), the pending review cards, how to answer one,
 * and the computer's name. Everything else (pairing, the listener, history, reach) stays in here.
 */
export function createPhoneAccess({directory, sessions, now = Date.now, inbox, answer, appRequest = null, computerName = () => 'This computer',
  interfaces = networkInterfaces, tailscale = tailscaleCli, onChange = () => {}, onResponse = () => {}, onTelemetry = () => {},
  writeConfig = writePrivate, httpServer = createHttpServer} = {}) {
  const configFile = join(directory, 'phone.json');
  const pairing = createPairing({now});
  const cookieName = 'faravan_phone_' + sessions.instance, claimName = 'faravan_pair_' + sessions.instance;
  const seen = new Map(), history = [], answeredBy = new Map();
  let config = {enabled: false}, server = null, origin = null, error = null, https = false, tailnet = false, restarting = Promise.resolve(), closed = false;
  // Set while `tailscale serve` forwards to this listener: {dnsName, port, target}.
  let served = null;
  // Full app access needs an encrypting link: HTTPS, or a listener on a Tailscale address.
  const fullAllowed = secure => !!appRequest && (secure || tailnet);

  const addresses = () => lanAddresses(interfaces());
  const allowedHosts = () => {
    if (!server) return new Set();
    if (served) return new Set([served.dnsName + ':' + served.port, ...(served.port === 443 ? [served.dnsName] : [])]);
    const port = server.address().port;
    return new Set([config.address + ':' + port, ...(config.hostname ? [config.hostname.toLowerCase() + ':' + port] : []),
      ...(https && port === 443 && config.hostname ? [config.hostname.toLowerCase()] : [])]);
  };

  async function stopListener() {
    const current = server, wasServed = served; server = null; origin = null; served = null;
    // A stale serve entry would forward the tailnet to whatever takes this loopback port next.
    if (wasServed) await tailscale.served(wasServed.port).then(target => target === wasServed.target ? tailscale.unserve(wasServed.port) : null).catch(() => {});
    if (current) { const closing = new Promise(resolve => current.close(resolve)); current.closeAllConnections?.(); await closing; }
  }
  async function startListener() {
    error = null; https = false; tailnet = false;
    if (!config.enabled) return;
    if (config.tailscaleHttps) return startServed();
    const choices = addresses();
    if (!choices.some(choice => choice.address === config.address)) {
      error = choices.length ? 'The network address ' + config.address + ' is not on this computer any more. Choose another one.'
        : 'This computer is not on a network a device could reach.';
      return;
    }
    let tls = null;
    if (config.certFile || config.keyFile) {
      try { tls = {cert: await readFile(config.certFile), key: await readFile(config.keyFile)}; }
      catch { error = 'The HTTPS certificate or key file could not be read. Check the two file paths.'; return; }
    }
    let next;
    try { next = tls ? createHttpsServer(tls, handle) : httpServer(handle); }
    catch { error = 'The HTTPS certificate and key do not form a valid pair.'; return; }
    try { await listenPreferred(next, {port: config.port ?? 0, host: config.address, file: join(directory, 'phone-listen.json')}); }
    catch (e) { error = e.code === 'EADDRINUSE' ? 'Port ' + config.port + ' on ' + config.address + ' is in use by another program.' : 'Device access could not start (' + (e.code ?? 'error') + ').'; return; }
    // 100.64/10 is also carrier-grade NAT: an address counts as a tailnet only when Tailscale reports it as its own.
    let tailscaleOwns = false;
    if (choices.find(choice => choice.address === config.address)?.kind === 'tailnet')
      tailscaleOwns = await tailscale.self().then(self => !!self?.addresses?.includes(config.address), () => false);
    server = next; https = !!tls; tailnet = tailscaleOwns;
    const port = server.address().port, host = config.hostname || config.address;
    origin = (https ? 'https://' : 'http://') + host + (https && port === 443 ? '' : ':' + port);
  }
  async function startServed() {
    const port = Number.isInteger(config.servePort) ? config.servePort : TAILSCALE_SERVE_PORT;
    let self;
    try { self = await tailscale.self(); } catch { self = null; }
    if (!self) { error = 'Tailscale is not running on this computer. Start Tailscale, then turn device access on again.'; return; }
    let current;
    try { current = await tailscale.served(port); } catch { error = 'Faravan could not read the Tailscale serve settings.'; return; }
    // Never take over a port another program serves. Our own entry from an earlier run is replaced.
    if (current && current !== config.serveTarget) { error = 'Tailscale already serves another program on port ' + port + '.'; return; }
    const next = httpServer(handle);
    try { await listenPreferred(next, {port: 0, host: '127.0.0.1', file: join(directory, 'phone-listen.json')}); }
    catch (e) { error = 'Device access could not start (' + (e.code ?? 'error') + ').'; return; }
    const target = 'http://127.0.0.1:' + next.address().port;
    try { await tailscale.serve(port, target); }
    catch (e) {
      next.close();
      error = /access denied|operator|permission/i.test(e.stderr ?? '')
        ? 'Tailscale did not let Faravan share this computer. Run: sudo tailscale set --operator=$USER'
        : 'Tailscale could not share device access (' + (e.code ?? 'error') + ').';
      return;
    }
    if (config.serveTarget !== target) { config = {...config, serveTarget: target}; await writeConfig(configFile, config); }
    server = next; https = true; tailnet = true; served = {dnsName: self.dnsName, port, target};
    origin = 'https://' + self.dnsName + (port === 443 ? '' : ':' + port);
  }
  const restart = () => (restarting = restarting.catch(() => {}).then(async () => { if (closed) return; await stopListener(); if (closed) return; await startListener(); onChange(status()); }));

  function status() {
    const kind = config.tailscaleHttps ? 'tailnet' : addresses().find(item => item.address === config.address)?.kind ?? null;
    return {computer: computerName(), enabled: !!config.enabled, tailscaleHttps: !!config.tailscaleHttps, address: config.address ?? null, hostname: config.hostname ?? null, https,
      certFile: config.certFile ?? null, keyFile: config.keyFile ?? null, origin,
      reach: phoneReach({enabled: config.enabled, listening: !!server, https, address: config.address, kind, error,
        full: !!server && fullAllowed(https), tailscaleHttps: !!served}),
      addresses: addresses(), phones: sessions.list('phone'), pairing: pairingView(), fullAvailable: !!server && fullAllowed(https)};
  }
  function pairingView() {
    const view = pairing.view();
    if (!view) return null;
    const {rawCode, ...rest} = view;
    const url = rawCode && origin ? origin + '/pair#' + rawCode : null;
    let qr=null;
    // A long valid DNS name can exceed the encoder capacity; the typed code still works.
    if(url)try{qr=qrPath(url);}catch(error){if(error.code!=='qr_too_long')throw error;}
    return {...rest, url, qr, scopes: rest.scopes ?? [...(https ? SCOPES_HTTPS : SCOPES_HTTP), ...(rest.full ? [SCOPE_APP_FULL] : [])]};
  }

  const assertRoom = () => {
    if (sessions.room('phone') <= 0) throw problem('too_many_phones', 409, 'This computer has as many paired devices as it allows. Remove one, then pair again.');
  };

  // ----- owner API (mounted by the app under /api/phone, behind the local session) -----
  async function owner({method, parts, input = {}, browserSession}) {
    const ownerStatus = () => ({...status(), confirmHere: browserSession === true});
    if (method === 'GET' && parts.length === 0) return ownerStatus();
    if (method !== 'POST') throw problem('not_found', 404);
    if (parts[0] === 'settings' && parts.length === 1) {
      const keys = ['enabled', 'address', 'hostname', 'certFile', 'keyFile', 'tailscaleHttps'];
      if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.enabled !== 'boolean') throw problem('invalid_request', 400);
      if (input.tailscaleHttps !== undefined && typeof input.tailscaleHttps !== 'boolean') throw problem('invalid_request', 400);
      for (const key of ['address', 'hostname', 'certFile', 'keyFile'])
        if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || input[key].length > 4096)) throw problem('invalid_request', 400);
      if (input.hostname && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(input.hostname)) throw problem('invalid_hostname', 400, 'Use a host name like faravan.home.example.');
      // Turning access on (or changing where it listens) opens this computer to the network: a person here, never the token alone.
      // Turning it off is a safety action and needs only local auth.
      if (input.enabled && !browserSession) throw problem('local_session_required', 403, 'Turn on device access in the Faravan window on this computer.');
      if (input.tailscaleHttps) {
        if (input.address || input.hostname || input.certFile || input.keyFile) throw problem('invalid_request', 400, 'Tailscale HTTPS uses its own address and certificate.');
        config = {...config, enabled: input.enabled, tailscaleHttps: true, hostname: null, certFile: null, keyFile: null};
        if (!input.enabled) pairing.cancel();
        await writeConfig(configFile, config);
        await restart();
        return ownerStatus();
      }
      if (!!input.certFile !== !!input.keyFile) throw problem('invalid_request', 400, 'HTTPS needs both a certificate file and a key file.');
      // A device answer needs encryption; a device paired over HTTP keeps its read-only scope after HTTPS is added.
      if (input.address && !addresses().some(item => item.address === input.address))
        throw problem('address_not_available', 400, 'Choose one of this computer’s private network addresses.');
      const address = input.address ?? config.address ?? addresses()[0]?.address;
      if (input.enabled && !address) throw problem('no_network', 409, 'This computer is not on a network a device could reach.');
      config = {...config, enabled: input.enabled, tailscaleHttps: false, address, hostname: input.hostname || null,
        certFile: input.certFile || null, keyFile: input.keyFile || null};
      if (!input.enabled) pairing.cancel();
      else if (!input.certFile) pairing.cancel(undefined, grant =>
        grant.scopes?.includes('requests:answer') || grant.scopes?.includes(SCOPE_APP_FULL));
      await writeConfig(configFile, config);
      await restart();
      return ownerStatus();
    }
    if (parts[0] === 'pairing' && parts.length === 1) {
      if (!server) throw problem('phone_access_off', 409, 'Turn on device access first.');
      if (input.access !== undefined && !['requests', 'full'].includes(input.access)) throw problem('invalid_request', 400);
      const full = input.access === 'full';
      if (full && !fullAllowed(https)) throw problem('full_access_needs_encryption', 409, 'Full app access needs HTTPS or a Tailscale address. Choose one in Connection settings.');
      assertRoom();
      pairing.start({full}); onChange(status()); return ownerStatus();
    }
    if (parts[0] === 'pairing' && parts[1] === 'cancel' && parts.length === 2) {
      // Name the pairing: a stale id cancels nothing, and no id must never cancel whichever pairing is current.
      if (typeof input.id !== 'string') throw problem('invalid_request', 400, 'Say which pairing to cancel.');
      pairing.cancel(input.id); onChange(status()); return ownerStatus();
    }
    if (parts[0] === 'pairing' && parts[1] === 'confirm' && parts.length === 2) {
      // A person at this computer compares the words: the browser here, never the session token alone (an agent or script).
      if (!browserSession) throw problem('confirm_on_this_computer', 403, 'Confirm pairing in the Faravan window on this computer.');
      if (typeof input.id !== 'string' || typeof input.confirmed !== 'boolean') throw problem('invalid_request', 400);
      if (input.confirmed) assertRoom();
      pairing.decide(input.id, input.confirmed); onChange(status()); return ownerStatus();
    }
    if (parts[0] === 'phones' && parts[2] === 'revoke' && parts.length === 3) {
      if (!await sessions.revoke(parts[1])) throw problem('not_found', 404, 'This device is not paired any more.');
      onChange(status()); return ownerStatus();
    }
    throw problem('not_found', 404);
  }

  // ----- review history the device shows: Needs your answer / Answered / Expired -----
  function observe(data) {
    if (!data) return;
    // Offer acceptance is published after the claim succeeds, keyed by job rather than the old review id.
    if (typeof data.id !== 'string' && data.offer && data.state === 'accepted' && data.jobDigest) {
      const card = [...seen.values()].find(card => card.jobDigest === data.jobDigest);
      if (card) data = {...data, id: card.id};
    }
    if (typeof data.id !== 'string') return;
    if (['taken', 'closed'].includes(data.state)) { seen.delete(data.id); answeredBy.delete(data.id); return; }
    if (data.job && data.label) { seen.set(data.id, data); return; }
    const card = seen.get(data.id);
    if (!['accepted', 'skipped', 'expired', 'identity-changed'].includes(data.state)) return;
    seen.delete(data.id);
    if (!card || data.state === 'identity-changed' || data.auto) return;
    history.unshift({card, state: data.state === 'expired' ? 'expired' : data.state === 'accepted' ? 'accepted' : card.offer ? 'dismissed' : 'declined',
      by: answeredBy.get(data.id) ?? (data.state === 'expired' ? null : 'this computer'), at: new Date(now()).toISOString()});
    answeredBy.delete(data.id);
    history.length = Math.min(history.length, 30);
  }

  // ----- the device listener -----
  function headers(res, type = 'application/json') {
    res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  const cookie = (name, value, maxAge, secure) => name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
  const phoneSession = req => sessions.verify(readCookie(req, cookieName), 'phone');

  async function handle(req, res) {
    // A connection keeps its transport even if Settings restarts the listener while a handler awaits.
    // Behind `tailscale serve` the device's connection is TLS to tailscaled; this loopback hop never leaves the computer.
    const secure = req.socket.encrypted === true || (!!served && req.socket.localAddress === '127.0.0.1');
    const send = (value, status = 200, extra = {}) => { if (!res.headersSent) { headers(res); res.writeHead(status, extra); res.end(JSON.stringify(value)); onResponse({req, status, body: value}); } };
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts().has(host)) return send({code: 'invalid_host', message: 'Use the address shown on the computer.'}, 403);
      const scheme = secure ? 'https://' : 'http://';
      if (req.headers.origin && req.headers.origin.toLowerCase() !== scheme + host) return send({code: 'invalid_origin'}, 403);
      const url = new URL(req.url, scheme + host);
      if (!PHONE_ONLY.has(url.pathname) && !url.pathname.startsWith('/phone/api/') && fullAllowed(secure)) {
        const full = phoneSession(req);
        if (full?.scopes?.includes(SCOPE_APP_FULL)) {
          res.setHeader('Set-Cookie', cookie(cookieName, readCookie(req, cookieName), PHONE_COOKIE_MAX_AGE_S, secure));
          return await appRequest(req, res, full);
        }
      }
      if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
        const [file, root] = STATIC[url.pathname];
        let bytes; try { bytes = await readFile(join(root, file)); } catch { return send({code: 'not_found'}, 404); }
        headers(res, TYPES[file.slice(file.lastIndexOf('.'))]);
        if (url.pathname === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
        if (/\.(png|svg|woff2)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=86400');
        res.writeHead(200); return res.end(bytes);
      }
      if (!url.pathname.startsWith('/phone/api/')) return send({code: 'not_found'}, 404);
      const path = url.pathname.slice('/phone/api/'.length).split('/');
      // State changes need the page's own Origin (a form post from another site has a different one or none).
      if (req.method === 'POST' && !req.headers.origin) return send({code: 'invalid_origin'}, 403);
      if (req.method === 'POST' && path[0] === 'pair' && path[1] === 'claim' && path.length === 2) {
        const input = await readJson(req);
        const claimed = pairing.claim(input.code, {label: input.label, address: served ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim() || null : req.socket.remoteAddress?.replace(/^::ffff:/, ''), scopes: secure ? SCOPES_HTTPS : SCOPES_HTTP});
        onChange(status());
        return send({phrase: claimed.phrase, expiresAt: new Date(claimed.expiresAt).toISOString(), computer: computerName(),
          scopes: claimed.scopes}, 200, {'Set-Cookie': cookie(claimName, claimed.secret, Math.ceil(PAIRING_TTL_MS / 1000), secure)});
      }
      if (req.method === 'GET' && path[0] === 'pair' && path[1] === 'status' && path.length === 2) {
        let result, full = false;
        try {
          result = await pairing.collect(readCookie(req, claimName), (phone, scopes) => {
            full = scopes.includes(SCOPE_APP_FULL);
            if(scopes.includes('requests:answer')&&!secure)throw problem('forbidden',403);
            if(scopes.includes(SCOPE_APP_FULL)&&!fullAllowed(secure))throw problem('forbidden',403);
            return sessions.create({kind: 'phone', label: phone.label, scopes, pending: true});
          }, created => sessions.revoke(created.id));
        } catch (e) {
          if (e.code !== 'too_many_phones') throw e;
          return send({state: 'too_many_phones', message: 'This computer has as many paired devices as it allows. Remove one on the computer; this device will then finish pairing.'});
        }
        if (result.state !== 'confirmed') return send({state: result.state});
        await sessions.commit(result.created.id);
        onChange(status());
        res.setHeader('Set-Cookie', [cookie(cookieName, result.created.secret, PHONE_COOKIE_MAX_AGE_S, secure), cookie(claimName, '', 0, secure)]);
        return send({state: 'paired', ...(full ? {full: true} : {})});
      }
      const session = phoneSession(req);
      if (!session) return send({code: 'not_paired', message: 'This device is not paired. Pair it from Faravan on your computer.'}, 401);
      const scopes = new Set(session.scopes);
      // Re-send the cookie so a device that keeps opening the app stays paired; the idle window is the store's.
      res.setHeader('Set-Cookie', cookie(cookieName, readCookie(req, cookieName), PHONE_COOKIE_MAX_AGE_S, secure));
      if (req.method === 'GET' && path[0] === 'inbox' && path.length === 1) {
        if (!scopes.has('inbox:read')) return send({code: 'forbidden'}, 403);
        const canAnswer = scopes.has('requests:answer') && secure;
        const cards = await inbox();
        return send({computer: computerName(), phone: {label: session.label, scopes: session.scopes}, https: secure, canAnswer,
          needs: cards.map(card => phoneCard(card, {https: canAnswer})),
          answered: history.filter(item => item.state !== 'expired').map(item => ({...phoneCard(item.card, {https: canAnswer}), state: item.state, by: item.by, at: item.at})),
          expired: history.filter(item => item.state === 'expired').map(item => ({...phoneCard(item.card, {https: canAnswer}), state: 'expired', at: item.at}))});
      }
      if (req.method === 'POST' && path[0] === 'requests' && ['accept', 'decline'].includes(path[2]) && path.length === 3) {
        // Answering lends this computer: only a device paired for it, and only over an encrypted connection.
        if (!scopes.has('requests:answer') || !secure) return send({code: 'forbidden', message: 'This device can see requests but not answer them. Answer on the computer.'}, 403);
        await readJson(req);
        answeredBy.set(path[1], session.label);
        try { return send(await answer(path[1], path[2] === 'accept' ? 'accept' : 'skip', {surface:'phone',identity:{sessionId:session.id,label:session.label}})); }
        catch (e) { answeredBy.delete(path[1]); throw e; }
      }
      if (req.method === 'POST' && path[0] === 'telemetry' && path.length === 1) {
        // Friction from this device: a device that cannot read its inbox sends none, and Sec-GPC: 1 asks that nothing be
        // recorded, so the request is answered and dropped. The app projects what is kept (design §2.2, §4.5).
        if (!scopes.has('inbox:read')) return send({code: 'forbidden'}, 403);
        const input = await readJson(req);
        if (req.headers['sec-gpc'] !== '1') onTelemetry(input?.records, {headers: req.headers});
        return send({ok: true});
      }
      if (req.method === 'POST' && path[0] === 'unpair' && path.length === 1) {
        await sessions.revoke(session.id); onChange(status());
        res.setHeader('Set-Cookie', cookie(cookieName, '', 0, secure));
        return send({unpaired: true});
      }
      return send({code: 'not_found'}, 404);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : e.code === 'not_found' ? 404 : 409;
      if (!e.code || status >= 500) console.error('Faravan device access:', e?.code ?? e?.message ?? e);
      return send({code: e.code ?? 'internal_error', ...(e.message && e.message !== e.code ? {message: e.message} : {})}, e.code ? status : 500);
    }
  }

  return {
    async start() {
      try { const saved = JSON.parse(await readFile(configFile, 'utf8')); if (saved && typeof saved === 'object') config = {...config, ...saved}; }
      catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      await restart();
    },
    owner, observe, status,
    get origin() { return origin; },
    async close() { closed = true; pairing.cancel(); await restarting.catch(() => {}); await stopListener(); },
  };
}
