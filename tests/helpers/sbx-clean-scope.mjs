import {seedSandboxOwner} from './sandbox-owner.mjs';
// Prepare checks the sbx credential scope before any sandbox effect. This answers
// those commands with an empty secret inventory and SSH agent forwarding off.
export const withCleanCredentialScope = run => {
  seedSandboxOwner();
  return async (args, ...rest) => {
    if (args[0] === 'secret' && args[1] === 'ls') return { code: 0, stdout: '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}', stderr: '' };
    if (args[0] === 'settings') return { code: 0, stdout: args[1] === 'get' && args[2] === 'ssh.agentForwardingEnabled' ? 'false' : '', stderr: '' };
    return run(args, ...rest);
  };
};
