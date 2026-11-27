/** Shared loopback session boundary. Callers bind to 127.0.0.1 and emit no CORS headers. */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function isAllowedHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const value = host.toLowerCase();
  return /^(localhost|127\.0\.0\.1)(?::\d+)?$/.test(value) || /^\[::1\](?::\d+)?$/.test(value);
}

/** The session token from a request header only. A token in the query string would reach logs, history and other processes. */
export function requestToken(request) {
  const header = request.headers['x-faravan-session-token'];
  return typeof header === 'string' && header ? header : null;
}

/**
 * Every response from the owner listener refuses framing (clickjacking). Wraps writeHead so that static files, API
 * answers and route-specific headers all carry X-Frame-Options and frame-ancestors. An existing CSP gets the directive
 * added to it; a second CSP header is never sent.
 */
export function refuseFraming(response) {
  const writeHead = response.writeHead;
  response.writeHead = function writeHeadRefusingFraming(status, ...rest) {
    const at = rest.findIndex(value => value !== null && typeof value === 'object' && !Array.isArray(value));
    const headers = {...(at >= 0 ? rest[at] : {})};
    const cspName = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
    const existing = headers[cspName] ?? response.getHeader('content-security-policy');
    const directives = typeof existing === 'string' && existing.trim()
      ? existing.split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors(\s|$)/i.test(part))
      : [];
    headers[cspName] = [...directives, "frame-ancestors 'none'"].join('; ');
    headers['X-Frame-Options'] = 'DENY';
    rest.splice(at >= 0 ? at : rest.length, at >= 0 ? 1 : 0, headers);
    return writeHead.call(this, status, ...rest);
  };
  return response;
}

export function tokensMatch(actual, expected) {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export const LOCAL_SESSION_MAX_AGE_S = 30 * 86400;

/** One named cookie value from a Cookie header; null when absent or sent twice (a planted duplicate). */
export function readCookie(request, name) {
  const cookies = typeof request.headers.cookie === 'string' ? request.headers.cookie.split(';') : [];
  const values = cookies.map(item => item.trim()).filter(item => item.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

/**
 * Browser sign-in for this computer. Handoff codes stay in memory: bounded, 60 s, consumed once, gone at restart.
 * Each redeemed code becomes its own durable local session (browser-sessions.mjs), so a browser stays signed in
 * across app restarts and can be signed out on its own. The cookie name carries the store's stable instance id,
 * not the port: cookies ignore ports, and a second app home on this computer must not clobber this one.
 */
// Expiry runs on a monotonic clock: a wall-clock jump must neither extend nor cut a 60 s code short.
export function createLocalHandoff({now=()=>performance.now(),sessions}) {
  const codes=new Map(),name='faravan_local_session_'+sessions.instance;
  return {
    issue() {
      for(const [code,expires] of codes)if(expires<=now())codes.delete(code);
      while(codes.size>=32)codes.delete(codes.keys().next().value);
      const code=createSessionToken();codes.set(code,now()+60000);return code;
    },
    /** A new session secret for a valid code, or null. The code is gone either way. */
    async redeem(code) {
      const expires=codes.get(code);codes.delete(code);
      if(!(typeof expires==='number'&&now()<expires))return null;
      return (await sessions.create({kind:'local',label:'Browser on this computer'})).secret;
    },
    authenticated(request) {
      return sessions.verify(readCookie(request,name),'local')!==null;
    },
    cookie(value) {
      return name+'='+value+'; Path=/; Max-Age='+LOCAL_SESSION_MAX_AGE_S+'; HttpOnly; SameSite=Strict';
    },
    clear(){codes.clear();},
  };
}

/**
 * A private, per-app launch capability. Only the trusted owner-approved call
 * site should receive withHostingLaunchApproval; it is not an approval check.
 */
export function createHostingLaunchApprovals({now=()=>performance.now()}={}) {
  const pending=new Map();
  let closed=false;
  return {
    async withHostingLaunchApproval(tuple,launch) {
      if (!tuple || Object.getPrototypeOf(tuple)!==Object.prototype ||
          Object.keys(tuple).sort().join(',')!=='consentFactsDigest,providerId,usage' ||
          typeof tuple.providerId!=='string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tuple.providerId) ||
          !['attached','durable'].includes(tuple.usage) ||
          typeof tuple.consentFactsDigest!=='string' ||
          !/^consent-v[0-9]+:[A-Za-z0-9_-]{16,128}$/.test(tuple.consentFactsDigest) ||
          typeof launch!=='function') throw new TypeError('Invalid hosting launch approval');
      if (closed) throw new Error('Hosting launch approvals are closed');
      const began=now();
      for (const [id,entry] of pending) if (entry.expires<=began) pending.delete(id);
      if (pending.size>=32) throw new Error('Too many pending hosting launches');
      const id=createSessionToken();
      pending.set(id,{tuple:Object.freeze({...tuple}),expires:began+60000});
      try {return await launch(id);}
      finally {pending.delete(id);}
    },
    consume(id) {
      if (closed || typeof id!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
      const entry=pending.get(id);
      pending.delete(id);
      return entry && now()<entry.expires ? entry.tuple : null;
    },
    close() {
      closed=true;
      pending.clear();
    },
  };
}
