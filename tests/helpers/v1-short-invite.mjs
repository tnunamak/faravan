import './no-browser.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '../../lib/v1/device.mjs';
import { openV1Store } from '../../lib/v1/store.mjs';
import { createV1Handler } from '../../lib/v1/server.mjs';
import * as p from '../../lib/protocol/index.mjs';

// What a malicious or compromised coordinator can do with only public material: it knows the real
// envelope and binding (it stores them) and every public key, but never the invite seed. These are its
// best forgeries of the publication for a code; every joiner must refuse each one.
export function forgeries(real) {
  const attackerRoot = p.generateRootKeyPair().privateKey;
  const {schema, root_public_key, root_fingerprint, ...fields} = real.envelope.payload;
  // Same circle, origin and invite_public_key, but a root the attacker controls.
  const forged = p.createInvite({...fields, owner_name: 'Tessa'}, attackerRoot);
  const attackerKey = p.generateDeviceKeyPair().privateKey;
  const lookalike = {algorithm: 'Ed25519', key_id: real.invite_binding.key_id,
    value: Buffer.alloc(64, 1).toString('base64url')};
  return [
    {label: 'forged root with the real binding', publication: {envelope: forged, invite_binding: real.invite_binding}},
    {label: 'forged root with a binding the server signed with its own key', publication: {envelope: forged,
      invite_binding: {algorithm: 'Ed25519', key_id: real.invite_binding.key_id,
        value: sign(null, Buffer.concat([Buffer.from('faravan/invite-binding/v1\0'),
          createHash('sha256').update(p.canonicalize(forged)).digest()]), attackerKey).toString('base64url')}}},
    {label: 'forged root with a made-up signature', publication: {envelope: forged, invite_binding: lookalike}},
    {label: 'forged root and a binding from an unrelated key', publication: {envelope: forged,
      invite_binding: p.createInviteBinding(p.createInvite({...fields, invite_public_key: p.exportPublicKey(attackerKey)}, attackerRoot), attackerKey)}},
    {label: 'real envelope with a swapped binding', publication: {envelope: real.envelope, invite_binding: lookalike}},
  ];
}

/**
 * A real coordinator (SQLite store + HTTP handler on loopback) with a real owner device, so the whole
 * short-link path runs over actual HTTP. `seen` holds every request as the server received it and
 * `sent` every request body as a client sent it, for secrecy assertions.
 */
export async function realCoordinator(t, {name = 'Critics', clock = () => Math.floor(Date.now() / 1000), limits} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-short-invite-'));
  const seen = [], sent = [];
  let handler, store;
  const server = createServer((req, res) => {
    seen.push({method: req.method, url: req.url, headers: {...req.headers}});
    if (c.override?.(req, res)) return; // lets a test play a dishonest coordinator
    if (handler) return handler(req, res);
    res.writeHead(503); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const dbPath = join(dir, 'coordinator.sqlite');
  const open = initial => {
    store = openV1Store({path: dbPath, clock, ...initial});
    handler = createV1Handler({store, blobDir: join(dir, 'blobs'), clock, limits});
  };
  const traced = async (url, options = {}) => {
    if (c.refusePublication && /"envelope":/.test(String(options.body ?? ''))) {
      // Plays an older coordinator that does not know publications: the exact problem the real server sends.
      return new Response(p.canonicalize({type: 'urn:faravan:problem:invalid_request', title: 'invalid request',
        status: 400, code: 'invalid_request', retryable: false, outcome: 'not_applied'}),
      {status: 400, headers: {'content-type': 'application/problem+json'}});
    }
    sent.push({url: String(url), headers: {...options.headers}, body: options.body === undefined ? '' : String(options.body)});
    return fetch(url, options);
  };
  const c = {dir, origin, seen, sent, traced, override: null, refusePublication: false, get store() { return store; }, clock};
  c.device = async (home, extra = {}) => openDevice({home: join(dir, home), origin: null, clock, fetch: traced, ...extra});
  c.restart = () => { handler.close(); store.close(); open({}); };
  const owner = await c.device('owner', {provisionCircle: async ({provisioning}) => {
    open({circle: provisioning.circle_id, origin: provisioning.origin,
      rootFingerprint: provisioning.root_fingerprint, initialRoster: provisioning.roster});
  }});
  c.owner = owner;
  c.circle = await owner.createCircle(origin, {name});
  t.after(async () => {
    handler?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store?.close();
    await rm(dir, {recursive: true, force: true});
  });
  c.get = async path => { const r = await fetch(origin + path); return {status: r.status, headers: r.headers, text: await r.text()}; };
  c.provisioning = async () => JSON.parse(await readFile(c.circle.provisioningPath, 'utf8'));
  return c;
}
