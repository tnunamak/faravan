// Pure helpers for proving a sandbox's effective network policy (S5.4, review 3 P1).
//
// sbx evaluates a sandbox's policy as: global allow rules + that sandbox's own rules, where a deny rule beats an
// allow rule that matches the same host. The global policy that ships with sbx allows about 190 destinations
// (package registries, GitHub, **.amazonaws.com, **.googleapis.com ...), so a job that must be provider-only can
// only be restricted by denying, per sandbox, every inherited allowance it did not ask for. These helpers decide
// what to deny and what to probe. They never run sbx.

/** A rule resource is `host`, `host:port`, a wildcard (`**.x`: any subdomain, `*.x`: one label), a glob, an IP or a CIDR. */
const isAddress = value => value.includes('/') || (value.match(/:/g) || []).length > 1;
const portAt = text => { const at = text.lastIndexOf(':'); return at > 0 && /^\d+$/.test(text.slice(at + 1)) ? at : -1; };

export function resourceHost(resource) {
  const text = String(resource).toLowerCase();
  if (isAddress(text)) return text;
  const at = portAt(text);
  return at > 0 ? text.slice(0, at) : text;
}
export function resourcePort(resource) {
  const text = String(resource).toLowerCase();
  if (isAddress(text)) return null;
  const at = portAt(text);
  return at > 0 ? text.slice(at + 1) : null;
}

/**
 * True when every destination `resource` allows is also allowed by `pattern`. Conservative: an unfamiliar shape
 * (a glob in the middle of a name, a CIDR) only covers an identical resource. A pattern without a port covers every port.
 */
export function covers(pattern, resource) {
  const pp = resourcePort(pattern), rp = resourcePort(resource);
  if (pp !== null && pp !== rp) return false;
  const ph = resourceHost(pattern), rh = resourceHost(resource);
  if (ph === rh) return true;
  if (isAddress(ph) || isAddress(rh)) return false;
  const deep = ph.startsWith('**.');
  if (!deep && !ph.startsWith('*.')) return false;
  const suffix = ph.slice(deep ? 3 : 2);
  if (suffix.includes('*')) return false;
  const wild = /^\*{1,2}\./.exec(rh);
  if (wild) {
    // A wildcard inside a pattern: `**.b` covers `*.b`; either is inside `**.x` when b is x or below it.
    const base = rh.slice(wild[0].length);
    if (base.includes('*')) return false;
    if (!deep) return false; // `*.x` equals `*.x` (handled above) and covers no other wildcard
    return base === suffix ? wild[0] === '*.' : base.endsWith('.' + suffix);
  }
  if (rh.includes('*') || !rh.endsWith('.' + suffix)) return false;
  return deep || !rh.slice(0, -suffix.length - 1).includes('.');
}

/** A destination that a rule's resource matches, for `sbx policy check`. The port is kept so a :80-only rule is probed on :80. */
export function probeTarget(resource) {
  const port = resourcePort(resource);
  let host = resourceHost(resource);
  if (isAddress(host)) host = host.split('/')[0];
  else host = host.replace(/^\*{1,2}\./, 'faravan-probe.').replaceAll('*', 'faravan-probe');
  return port ? host + ':' + port : host;
}

const hostCovers = (pattern, resource) => covers(resourceHost(pattern), resourceHost(resource));

/**
 * Sorts inherited allowances against what the job needs. `needed` is [{resource, origin}], origin 'agent' (provider hosts,
 * named registries) or 'source' (the Git clone).
 *   deny     covered by nothing needed and covering nothing needed
 *   wider    covers something needed (on any port), so a deny would block that too; `origins` says what it covers
 */
function classify(inherited, needed) {
  const deny = [], wider = [];
  for (const resource of new Set(inherited)) {
    if (needed.some(n => covers(n.resource, resource))) continue; // allowed by what the job asked for
    // Overlap on the host, and on the port unless one side names no port (all ports). 443 vs 80 do not overlap.
    const overlaps = n => hostCovers(resource, n.resource) && (resourcePort(resource) === null || resourcePort(n.resource) === null || resourcePort(resource) === resourcePort(n.resource));
    const origins = new Set(needed.filter(overlaps).map(n => n.origin));
    if (origins.size) wider.push({ resource, origins }); else deny.push(resource);
  }
  return { deny, wider };
}

/**
 * @param inherited   allow resources every sandbox inherits (global policy and any other layer, not this sandbox's own)
 * @param agent       destinations the agent run asked for: provider hosts and named registries
 * @param kit         initial sandbox allowances to restrict, not additional grants
 * @param source      destinations only the clone of a Git source needs (a window that closes before the agent starts)
 * @returns {deny, sourceOnly, window, scope, kitWider, refused}
 *   deny        inherited resources to deny when the sandbox is created
 *   sourceOnly  the source hosts the agent does not need: own allow rule, removed after the clone
 *   window      null, or {deny, remove}: what to deny, and which allow rules to remove, once the clone is done
 *   scope       null without a Git source; 'clone_only' when every source host closes afterwards; 'whole_run' when the
 *               provider covers a source host, so GitHub stays reachable (and the receipt says so)
 *   kitWider    empty; kit permissions never expand the signed policy
 *   refused     inherited resources wider than something the agent itself asked for
 */
export function planNetworkDeny({ inherited, agent, kit = [], source = [] }) {
  const tag = (list, origin) => list.map(resource => ({ resource, origin }));
  const sourceOnly = source.filter(host => !agent.some(a => hostCovers(a, host)));
  const allowances = [...inherited, ...kit];
  const during = classify(allowances, [...tag(agent, 'agent'), ...tag(sourceOnly, 'source')]);
  const after = classify(allowances, tag(agent, 'agent'));
  const kept = new Set(during.deny);
  const reopened = after.deny.filter(resource => !kept.has(resource));
  return {
    deny: during.deny,
    sourceOnly,
    window: sourceOnly.length ? { deny: [...new Set([...reopened, ...sourceOnly])], remove: [...sourceOnly] } : null,
    scope: !source.length ? null : sourceOnly.length === source.length ? 'clone_only' : 'whole_run',
    kitWider: [],
    refused: after.wider.map(w => w.resource),
  };
}

/** Rules that apply to one sandbox, from `sbx policy ls <sandbox> --json --type network`. null when the answer cannot be read. */
export function parsePolicyListing(stdout, sandbox) {
  let listing;
  try { listing = JSON.parse(stdout); } catch { return null; }
  if (!listing || !Array.isArray(listing.rules)) return null;
  const mine = `sandbox:${sandbox}`;
  const rules = listing.rules.filter(rule => rule && rule.status === 'active' && rule.resource_type === 'network' &&
    Array.isArray(rule.resources) && rule.resources.every(item => typeof item === 'string') &&
    (rule.applies_to === 'all' || rule.applies_to === mine));
  const own = rule => rule.applies_to === mine;
  return {
    inheritedAllow: rules.filter(rule => !own(rule) && rule.decision === 'allow').flatMap(rule => rule.resources),
    ownAllow: rules.filter(rule => own(rule) && rule.decision === 'allow').map(rule => ({ id: rule.id, resources: [...rule.resources] })),
    ownDeny: rules.filter(rule => own(rule) && rule.decision === 'deny').flatMap(rule => rule.resources),
  };
}

/**
 * Which denied resources to prove with `sbx policy check`. The listing proves every deny rule is installed; the checks
 * prove a deny takes effect against the inherited allowance. Every pattern is probed (a wildcard or an address range is
 * where matching can differ), plus an even spread of exact hosts, so one prepare stays at about fifty ~0.6 s calls
 * instead of two hundred.
 */
export function sampleForChecks(resources, exactLimit = 12) {
  const unique = [...new Set(resources)];
  const pattern = unique.filter(resource => /[*/]/.test(resource) || (resource.match(/:/g) || []).length > 1);
  const exact = unique.filter(resource => !pattern.includes(resource));
  const step = Math.max(1, Math.ceil(exact.length / exactLimit));
  return [...pattern, ...exact.filter((_, index) => index % step === 0)];
}
