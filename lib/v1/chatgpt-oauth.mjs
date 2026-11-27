import {durableJson} from '../durable-write.mjs';
// Single-owner OAuth authority. Owner authentication belongs exclusively to the loopback app.
import {randomBytes, createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createChatgptAudit, UNAPPROVED, LOCAL} from './chatgpt-audit.mjs';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const fail = (error, status = 400, extra = {}) => { throw Object.assign(new Error(error), {oauthError:error, status, ...extra}); };
const scopes = value => {
  const result = [...new Set(String(value || 'read act').split(' ').filter(Boolean))];
  if (!result.length || result.some(s => !['read','act'].includes(s))) fail('invalid_scope');
  return result.join(' ');
};
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function oauthBody(req, json = false) {
  if (!(json ? /^application\/json(?:;|$)/i : /^application\/x-www-form-urlencoded(?:;|$)/i).test(req.headers['content-type'] || '')) fail('invalid_request', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) fail('invalid_request', 413); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString();
  try {
    if (json) { const body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_request'); return body; }
    const params = new URLSearchParams(raw);
    for (const key of params.keys()) if (params.getAll(key).length !== 1) fail('invalid_request');
    return Object.fromEntries(params);
  } catch { fail('invalid_request'); }
}
export const oauthJson = (res, value, status = 200, headers = {}) => {
  res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store', 'pragma':'no-cache', ...headers});
  res.end(JSON.stringify(value));
};
// Redirects are an allowlist, not a pattern: the two ChatGPT callbacks OpenAI documents
// (https://developers.openai.com/plugins/build/auth, "Redirect URL"), plus loopback for local
// clients such as MCP Inspector. Exact strings only, so no normalization trick can widen them.
const CHATGPT_STABLE = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
export function classifyRedirect(uri) {
  if (typeof uri !== 'string' || uri.length > 2048) return null;
  if (uri === CHATGPT_STABLE || CHATGPT_CALLBACK.test(uri)) return {kind:'chatgpt', host:'chatgpt.com'};
  let u; try { u = new URL(uri); } catch { return null; }
  if (u.href !== uri || /[?#]/.test(uri) || u.username || u.password || !['http:','https:'].includes(u.protocol) ||
    !['127.0.0.1','[::1]','localhost'].includes(u.hostname)) return null;
  return {kind:'loopback', host:u.host};
}

const DAY = 86400000, PAIRING_MS = 600000, CONSENT_MS = 300000, CODE_MS = 60000, USED_CODE_MS = 600000;
const GRANT_LIFETIME_MS = 30 * DAY, ACCESS_PER_GRANT = 3, MAX_CLIENTS = 100, MAX_USED_CODES = 100;

export function createChatgptOAuth({home, origin, localOrigin, now = Date.now, accessLifetimeMs = 600000}) {
  const directory = join(home, 'v1'); mkdirSync(directory, {recursive:true, mode:0o700});
  const file = join(directory, 'chatgpt-oauth.json');
  const log = createChatgptAudit({file:join(directory, 'chatgpt-audit.json'), now});
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  log.migrateLegacy(saved?.audit);
  let state = saved?.origin === origin ? (saved.version === 2 ? saved : migrate(saved)) : {version:2, origin, clients:{}, grants:{}};
  // Pairing, pending consent and codes live in memory only: a restart or token refresh never reopens pairing.
  let pairingUntil = 0;
  const pending = new Map(), codes = new Map(), usedCodes = new Map();
  const save = () => {
    durableJson(file,state);
  };
  if (saved && (state !== saved || saved.audit)) { delete state.audit; prune(); save(); }

  // Version 1 kept global access/refresh maps and the audit log in this file.
  function migrate(old) {
    const next = {version:2, origin, clients:{}, grants:{}}, t = now();
    for (const [id, c] of Object.entries(old.clients ?? {})) {
      const redirects = (c.redirect_uris ?? []).filter(classifyRedirect);
      // A client that ever allowed a non-allowlisted redirect is dropped with its grants.
      if (!redirects.length || redirects.length !== c.redirect_uris.length) continue;
      next.clients[id] = {...c, registered_at:c.registered_at ?? (c.client_id_issued_at ? c.client_id_issued_at * 1000 : t)};
    }
    const credentials = (map, grant) => Object.entries(map ?? {}).filter(([, v]) => v.grant === grant && v.expires > t).sort(([, a], [, b]) => b.expires - a.expires);
    for (const [id, g] of Object.entries(old.grants ?? {})) {
      const client = next.clients[g.client_id]; if (!client) continue;
      const created_at = g.created_at ?? t, expires_at = created_at + GRANT_LIFETIME_MS;
      const live = credentials(old.refresh, id).filter(([, v]) => !v.used)[0], used = credentials(old.refresh, id).filter(([, v]) => v.used)[0];
      next.grants[id] = {id, client_id:g.client_id, scope:g.scope, created_at, expires_at,
        redirect_uri:client.redirect_uris.length === 1 ? client.redirect_uris[0] : null,
        refresh:live ? {hash:live[0], expires:Math.min(live[1].expires, expires_at)} : null, previous_refresh:used?.[0] ?? null,
        access:credentials(old.access, id).slice(0, ACCESS_PER_GRANT).map(([hash, v]) => ({hash, expires:Math.min(v.expires, expires_at)}))};
    }
    return next;
  }
  function prune() {
    const t = now();
    for (const map of [pending, codes, usedCodes]) for (const [key, v] of map) if (v.expires <= t) map.delete(key);
    let changed = false;
    for (const g of Object.values(state.grants)) {
      g.access = g.access.filter(a => a.expires > t);
      // A grant with no live refresh token can never be used again.
      if (g.expires_at <= t || !g.refresh || g.refresh.expires <= t) { delete state.grants[g.id]; changed = true; }
    }
    return changed;
  }
  const pairingOpen = () => now() < pairingUntil;
  // Pairing is one-shot: the first valid decision closes it and drops every other pending consent.
  const closePairing = () => { pairingUntil = 0; pending.clear(); };
  // A UI label that tells this request apart from a lookalike. Not a secret and never authority.
  const matchingCode = id => {
    const taken = new Set([...pending.values()].map(r => r.matching_code));
    for (let i = 0; ; i++) {
      const hex = createHash('sha256').update(i ? id + ':' + i : id).digest('hex').slice(0, 8).toUpperCase();
      const code = hex.slice(0, 4) + '-' + hex.slice(4);
      if (!taken.has(code)) return code;
    }
  };
  const requirePairing = () => { if (!pairingOpen()) fail('temporarily_unavailable', 503, {reason:'pairing_closed'}); };
  const grants = () => Object.values(state.grants);
  const view = g => g && {id:g.id, client_id:g.client_id, scope:g.scope, created_at:g.created_at, expires_at:g.expires_at};
  const byAccess = h => grants().find(g => g.access.some(a => a.hash === h && a.expires > now()));
  const byRefresh = h => { for (const g of grants()) { if (g.refresh?.hash === h) return {grant:g, current:true}; if (g.previous_refresh === h) return {grant:g, current:false}; } return null; };
  const clientInfo = (clientId, redirect) => ({client:state.clients[clientId]?.client_name ?? null,
    redirect_host:classifyRedirect(redirect ?? state.clients[clientId]?.redirect_uris?.[0])?.host ?? null});
  const bucketOf = clientId => state.clients[clientId]?.approved_at ? clientId : UNAPPROVED;
  // OAuth lifecycle entries use the reserve; when even that is full they only bump the sticky overflow counter.
  const lifecycle = (clientId, op, outcome, effect, actor = 'ChatGPT', redirect) =>
    log.record(bucketOf(clientId), {client_id:clientId, actor, op, outcome, effect}, {reserve:true, info:bucketOf(clientId) === clientId ? clientInfo(clientId, redirect) : undefined});

  const resource = origin + '/mcp';
  function metadata() {
    return {issuer:origin, authorization_endpoint:origin+'/oauth/authorize', token_endpoint:origin+'/oauth/token',
      registration_endpoint:origin+'/oauth/register', revocation_endpoint:origin+'/oauth/revoke',
      response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none'], revocation_endpoint_auth_methods_supported:['none'],
      code_challenge_methods_supported:['S256'], scopes_supported:['read','act'], authorization_response_iss_parameter_supported:true};
  }
  function register(body) {
    prune(); requirePairing();
    if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 10 || !body.redirect_uris.every(classifyRedirect)) fail('invalid_redirect_uri');
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') fail('invalid_client_metadata');
    if (body.grant_types && (!Array.isArray(body.grant_types) || body.grant_types.some(g => !['authorization_code','refresh_token'].includes(g)))) fail('invalid_client_metadata');
    if (body.response_types && JSON.stringify(body.response_types) !== '["code"]') fail('invalid_client_metadata');
    if (Object.keys(state.clients).length >= MAX_CLIENTS) {
      // Evict only a client nobody is waiting on: never approved, no pending consent, no grant.
      const busy = new Set([...[...pending.values()].map(r => r.client_id), ...grants().map(g => g.client_id)]);
      const victim = Object.values(state.clients).find(c => !Object.hasOwn(c, 'approved_at') && !busy.has(c.client_id));
      if (!victim) fail('temporarily_unavailable', 503);
      delete state.clients[victim.client_id];
    }
    const client_id = random(), client = {client_id, client_name:typeof body.client_name === 'string' ? body.client_name.slice(0,120) : 'OAuth client',
      redirect_uris:[...body.redirect_uris], token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code'], scope:scopes(body.scope), client_id_issued_at:Math.floor(now()/1000)};
    state.clients[client_id] = {...client, registered_at:now()}; save();
    lifecycle(client_id, 'oauth.register', 'completed', client.client_name + ' -> ' + client.redirect_uris.map(u => classifyRedirect(u).host).join(', '));
    return client;
  }
  function authorize(params) {
    prune(); requirePairing();
    for (const key of params.keys()) if (params.getAll(key).length !== 1) fail('invalid_request');
    const p = Object.fromEntries(params), client = state.clients[p.client_id];
    if (!client) fail('invalid_client');
    if (!client.redirect_uris.includes(p.redirect_uri) || !classifyRedirect(p.redirect_uri)) fail('invalid_redirect_uri');
    if (p.response_type !== 'code') fail('unsupported_response_type');
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || '')) fail('invalid_request');
    if (p.resource !== resource) fail('invalid_target');
    if (typeof p.state !== 'string' || p.state.length > 2048) fail('invalid_request');
    const scope = scopes(p.scope);
    if (scope.split(' ').some(s => !client.scope.split(' ').includes(s))) fail('invalid_scope');
    if ([...pending.values()].filter(request=>request.client_id===p.client_id).length >= 3) fail('temporarily_unavailable', 503);
    const id = random(), matching_code = matchingCode(id);
    pending.set(id, {...p, scope, matching_code, requested_at:now(), expires:now()+CONSENT_MS});
    return {id, matching_code, url:localOrigin()+'/connect/chatgpt?request='+id};
  }
  function consent(id) {
    prune(); const request = pending.get(id); if (!request) fail('invalid_request');
    const client = state.clients[request.client_id], where = classifyRedirect(request.redirect_uri);
    return {client:client.client_name, scope:request.scope, redirect_uri:request.redirect_uri, redirect_host:where.host,
      registered_at:client.registered_at, requested_at:request.requested_at, is_chatgpt:where.kind === 'chatgpt', matching_code:request.matching_code};
  }
  // selectedScope lets the person grant less than requested (for example read only); never more.
  function approve(id, allow, selectedScope) {
    const info = consent(id), request = pending.get(id);
    let scope = request.scope;
    if (allow) {
      requirePairing();
      if (selectedScope !== undefined) {
        if (typeof selectedScope !== 'string' || !selectedScope.trim()) fail('invalid_scope');
        scope = scopes(selectedScope);
        if (scope.split(' ').some(s => !request.scope.split(' ').includes(s))) fail('invalid_scope');
      }
    }
    closePairing();
    const redirect = new URL(request.redirect_uri); redirect.searchParams.set('state',request.state); redirect.searchParams.set('iss',origin);
    if (!allow) {
      redirect.searchParams.set('error','access_denied');
      lifecycle(request.client_id, 'oauth.consent', 'denied', info.scope + ' -> ' + info.redirect_host, 'owner', request.redirect_uri);
    } else {
      state.clients[request.client_id].approved_at = now(); save();
      const code = random(); codes.set(hash(code), {...request, scope, expires:now()+CODE_MS}); redirect.searchParams.set('code',code);
      lifecycle(request.client_id, 'oauth.consent', 'allowed', scope + ' -> ' + info.redirect_host, 'owner', request.redirect_uri);
    }
    return redirect.href;
  }
  function revokeGrant(id) { delete state.grants[id]; }
  function issue(grant) {
    // One current refresh token per grant plus the previous hash as a replay detector, and at most
    // ACCESS_PER_GRANT access tokens: storage is bounded per grant, not by a global counter.
    const t = now(), access_token = random(), refresh_token = random(), expires = Math.min(t + accessLifetimeMs, grant.expires_at);
    grant.access = [{hash:hash(access_token), expires}, ...grant.access].slice(0, ACCESS_PER_GRANT);
    grant.previous_refresh = grant.refresh?.hash ?? null;
    grant.refresh = {hash:hash(refresh_token), expires:grant.expires_at};
    save(); return {access_token, token_type:'Bearer', expires_in:Math.floor((expires - t)/1000), refresh_token, scope:grant.scope};
  }
  function token(p) {
    prune(); if (!state.clients[p.client_id]) fail('invalid_client',401);
    // A refresh without a resource retains this grant's sole audience (RFC 8707).
    if ((p.grant_type==='authorization_code'||p.resource!==undefined)&&p.resource !== resource) fail('invalid_target');
    if (p.grant_type === 'authorization_code') {
      const key = hash(p.code || ''), code = codes.get(key); codes.delete(key);
      const proven = c => c.client_id === p.client_id && c.redirect_uri === p.redirect_uri &&
        /^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') && hash(p.code_verifier) === c.code_challenge;
      if (!code) {
        // RFC 6749 4.1.2: a replayed code revokes what it issued, but only for a caller that also holds
        // the PKCE verifier, so knowing a used code alone cannot disconnect someone.
        const used = usedCodes.get(key);
        if (used && proven(used) && state.grants[used.grant]) {
          revokeGrant(used.grant); save(); lifecycle(used.client_id, 'oauth.code_replay', 'revoked');
        }
        fail('invalid_grant');
      }
      if (code.expires <= now() || !proven(code)) fail('invalid_grant');
      const t = now(), grant = {id:random(), client_id:p.client_id, scope:code.scope, created_at:t, expires_at:t + GRANT_LIFETIME_MS,
        redirect_uri:code.redirect_uri, refresh:null, previous_refresh:null, access:[]};
      state.grants[grant.id] = grant;
      usedCodes.set(key, {grant:grant.id, client_id:code.client_id, redirect_uri:code.redirect_uri, code_challenge:code.code_challenge, expires:t + USED_CODE_MS});
      if (usedCodes.size > MAX_USED_CODES) usedCodes.delete(usedCodes.keys().next().value);
      return issue(grant);
    }
    if (p.grant_type !== 'refresh_token') fail('unsupported_grant_type');
    const found = byRefresh(hash(p.refresh_token || '')), grant = found?.grant;
    if (!grant || grant.client_id !== p.client_id) fail('invalid_grant');
    if (!found.current) { revokeGrant(grant.id); save(); lifecycle(grant.client_id, 'oauth.refresh_reuse', 'revoked'); fail('invalid_grant'); }
    if (p.scope && p.scope !== grant.scope) fail('invalid_scope');
    const issued = issue(grant); log.countRefresh(bucketOf(grant.client_id), clientInfo(grant.client_id, grant.redirect_uri));
    return issued;
  }
  function authenticate(value) {
    if (prune()) save();
    return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(value) ? view(byAccess(hash(value.slice(7)))) || null : null;
  }
  function credential(value) { const h = hash(value || ''); return byRefresh(h)?.grant ?? byAccess(h); }
  // Revocation never depends on audit room.
  function revoke(p) {
    const grant = credential(p.token);
    if (grant && grant.client_id === p.client_id) { revokeGrant(grant.id); save(); lifecycle(grant.client_id, 'oauth.revoke', 'completed'); }
  }
  // Rate partition only: knowing a public client_id must not consume its owner's budget.
  function credentialOwner(p) {
    const grant = credential(p.refresh_token ?? p.token);
    if (grant?.client_id === p.client_id) return grant.id;
    const code = codes.get(hash(p.code ?? ''));
    return code && code.client_id === p.client_id && hash(p.code_verifier ?? '') === code.code_challenge ? p.client_id : null;
  }
  // effect: a short local description of what the call does. Never pass tokens or raw arguments.
  function audit(grant, op, outcome, effect) {
    return log.record(grant.client_id, {actor:'ChatGPT', op, outcome, effect},
      {reserve:['completed','failed'].includes(outcome), info:clientInfo(grant.client_id, state.grants[grant.id]?.redirect_uri)});
  }
  // Ungated reads, tools/list and refusals: counted per op+outcome, never consuming action capacity.
  const auditRead = (grant, op, outcome) => log.read(grant.client_id, {actor:'ChatGPT', op, outcome}, clientInfo(grant.client_id, state.grants[grant.id]?.redirect_uri));
  const auditRoom = (grant, slots = 1) => log.room(grant.client_id, slots);
  function requests() {
    prune(); return [...pending.keys()].map(id => ({id, ...consent(id)}));
  }
  function revokeConnection(id) {
    const grant = state.grants[id]; if (!grant) return false;
    revokeGrant(id); save(); lifecycle(grant.client_id, 'oauth.revoke', 'completed', null, 'owner', grant.redirect_uri);
    return true;
  }
  function status() {
    if (prune()) save();
    const connections = grants().map(g => {
      const client = state.clients[g.client_id], where = g.redirect_uri ? classifyRedirect(g.redirect_uri) : null;
      return {id:g.id, client_id:g.client_id, client:client?.client_name, scope:g.scope, redirect_host:where?.host ?? null,
        is_chatgpt:where?.kind === 'chatgpt', registered_at:client?.registered_at ?? null, created_at:g.created_at, expires_at:g.expires_at};
    });
    const auditEntries = log.entries().map(e => ({...e, client:e.client ?? state.clients[e.client_id]?.client_name ?? null}));
    const pending_requests = [...pending.values()].map(r => {
      const where = classifyRedirect(r.redirect_uri);
      return {matching_code:r.matching_code, client:state.clients[r.client_id]?.client_name ?? null, redirect_host:where.host,
        is_chatgpt:where.kind === 'chatgpt', scope:r.scope, requested_at:r.requested_at};
    });
    return {url:resource, connected:connections.length > 0, pairing_until:pairingOpen() ? pairingUntil : null, pending_requests, connections,
      audit:auditEntries, audit_buckets:log.buckets(), audit_overflow:log.overflow()};
  }
  function disconnect() {
    state.grants = {}; state.clients = {}; codes.clear(); usedCodes.clear(); pending.clear(); pairingUntil = 0; save();
    log.record(LOCAL, {client_id:null, actor:'owner', op:'oauth.disconnect', outcome:'completed'}, {reserve:true});
  }
  return {metadata, resource, register, authorize, consent, approve, token, authenticate, revoke, audit, auditRead, auditRoom,
    credentialOwner, requests, revokeConnection, status, disconnect,
    openPairing:() => { pending.clear(); pairingUntil = now() + PAIRING_MS; return {pairing_until:pairingUntil}; },
    closePairing, pairingOpen,
    clearAudit:clientId => log.clear(clientId),
    active:grant => {if(prune())save();return Boolean(state.grants[grant.id]);}};
}
