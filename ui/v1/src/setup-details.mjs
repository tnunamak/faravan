const LABELS = {
  test_workspace:'Test workspace',
  sbx_install:'Docker Sandboxes is installed', sbx_version:'Docker Sandboxes is up to date', sbx_cli_contract:'Docker Sandboxes supports the required commands',
  sbx_daemon:'Docker Sandboxes is running', docker_runtime:'Docker is running', docker_login:'Docker is signed in',
  sbx_credential_store:'Docker can store sign-in on this computer',socket_path_length:'The sandbox files can be reached',windows_file_permissions:'Sandbox-file access permissions are restricted to this account',
  network_policy:'The sandbox network rules are ready', v1_limits:'The job limits can be enforced',
  hypervisor_platform:'Windows can run sandboxes', kvm_access:'This account can run sandboxes',
};
// Unknown or explicitly inconclusive evidence never becomes a passed assurance.
export function setupDetailsVM(readiness) {
  if (!readiness) return {rows:[],summary:'Loading protection checks…'};
  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  const rows = checks.map(check => {
    const inconclusive = /inconclusive|unverified|unknown|not tested|could not (?:be )?verif/i.test([check.status,check.label,check.detail].filter(Boolean).join(' '));
    const waiting = check.name === 'network_policy' && checks.some(c => c.name === 'docker_login' && c.ok !== true);
    const state = waiting ? 'Waiting' : inconclusive || typeof check.ok !== 'boolean' ? 'Not confirmed' : check.ok ? 'Passed' : 'Needs attention';
    const name = typeof check.name === 'string' ? check.name.replace(/[_-]+/g,' ').trim() : '';
    return {label:LABELS[check.name] || (name ? 'Additional protection: ' + name : 'Unnamed protection'),state,
      ...(check.name === 'windows_file_permissions' ? {detail:'This does not hide job contents from the computer’s owner or administrator.'} : {})};
  });
  return {rows, summary:rows.some(r => r.state === 'Not confirmed') ? 'Some protections have not been confirmed.' : rows.some(r => r.state === 'Needs attention') ? 'A protection check needs attention.' : rows.some(r => r.state === 'Waiting') ? 'Some checks wait for Docker sign-in.' : rows.length ? 'The other required checks reported no problems.' : 'No protection checks have been recorded yet.'};
}

export function setupRowsVM(steps) {
  const status={ok:'ok',need:'blocked',bad:'blocked',waits:'waits',now:'unknown',todo:'waits'};
  const keys={sandboxes:'docker_installed','docker-account':'docker_signin',agents:'agent',circle:'circle'};
  const items=steps.map(step=>({key:step.id.startsWith('agent:')?'agent':keys[step.id]||step.id,agent:step.id.startsWith('agent:')?step.id.slice(6):undefined,label:step.title,detail:step.detail,status:status[step.state],step}));
  return {items,needsYou:items.filter(item=>item.status==='blocked')};
}
