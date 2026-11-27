// Only called after an independent inventory confirms this job's sandbox is gone.
// sbx rm leaves its scoped rules behind on some releases. Never change global rules.
export function scopedRules(result, sandbox) {
  // Exit status alone cannot prove a policy inventory is complete. Apply this
  // gate to both reads, before removing rules or allowing provisioned residue.
  if (result?.code !== 0 || String(result.stderr ?? '').trim() ||
    result.truncated || result.timedOut || result.killed || result.errorCode) return null;
  let listing;
  try { listing = JSON.parse(result.stdout); } catch { return null; }
  if (!Array.isArray(listing?.rules)) return null;
  const scope = 'sandbox:' + sandbox;
  if(listing.rules.some(rule=>!rule||typeof rule.scope!=='string'||typeof rule.applies_to!=='string'))return null;
  if(listing.rules.some(rule=>(rule.scope===scope||rule.applies_to===scope)&&rule.scope!==rule.applies_to))return null;
  const rules = listing.rules.filter(rule => rule?.applies_to === scope && rule.scope === scope &&
    rule.resource_type === 'network' && rule.status === 'active');
  return rules.some(rule=>typeof rule.id!=='string'||!rule.id)||new Set(rules.map(rule=>rule.id)).size!==rules.length ? null : rules;
}

// The exact shape sbx gives a rule it provisioned for one sandbox. Any other field value is not that rule.
function sbxProvisionedFor(rule, sandbox) {
  const scope = 'sandbox:' + sandbox;
  return rule.editable === false && rule.provenance?.created_via === 'provisioned' && rule.provenance.source === 'sandboxes' &&
    rule.layer === 'local' && rule.origin === 'scoped' && rule.scope === scope && rule.applies_to === scope;
}

// With `leaveProvisioned`, a rule that sbx itself provisioned for this sandbox and
// marked non-editable may stay once the sandbox is known to be gone: sbx removes
// such a rule only together with a sandbox that finished creating. The rule is
// never removed here and never counts as removed; `details.left` is how many stay.
// `details.failure` names why a call returned false, as a fixed class.
export async function removeSandboxPolicies(run, sandbox, details = {}, {leaveProvisioned = false, leaveKit = false} = {}) {
  details.blocked = false;
  details.failure = 'listing_failed';
  if (!/^wf-[a-f0-9]{16}$/.test(sandbox)) return false;
  const rules = scopedRules(await run(['policy', 'ls', '--json']), sandbox);
  if (!rules) return false;
  const kit=rule=>(rule.type==='kit'||rule.type===undefined&&sbxProvisionedFor(rule,sandbox))&&
    rule.decision==='allow'&&(rule.resource===undefined||rule.resource==='sandbox:'+sandbox);
  details.kitOnly=rules.length>0&&rules.every(kit);
  details.failure = 'removal_refused';
  for (const rule of rules.filter(rule=>rule.editable!==false&&!(leaveKit&&kit(rule)))) {
    const result = await run(['policy', 'rm', 'network', '--sandbox', sandbox, '--id', rule.id, '--force']);
    if (result.code !== 0) return false;
  }
  const remaining = scopedRules(await run(['policy', 'ls', '--json']), sandbox);
  details.blocked = remaining !== null && remaining.length > 0 && remaining.every(rule=>rule.editable===false);
  details.failure = remaining === null ? 'listing_failed' : 'rule_remains';
  if(leaveKit&&remaining?.length>0&&remaining.every(kit)){details.residue=remaining.map(({id})=>({id,type:'kit'}));details.left=remaining.length;details.blocked=false;return true;}
  if (leaveProvisioned && remaining?.length > 0 &&
    remaining.every(rule=>sbxProvisionedFor(rule,sandbox))) {
    details.left = remaining.length;
    return true;
  }
  return remaining !== null && remaining.length === 0;
}
