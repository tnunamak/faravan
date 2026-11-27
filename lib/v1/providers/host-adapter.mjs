import { fault } from '../accounts.mjs';

// Enrollment uses the existing host flow behind this port. The integration owner
// supplies the host-only completion/refresh/transport implementations. No default
// effect reads credentials, creates a runtime, or makes a provider request.
export function createHostAdapter({ descriptor, effects = {}, signInSpec, signInOptions, enrollmentFromFlow }) {
  const unsupported = async () => fault('adapter_unsupported');
  const flows = new Map();
  async function beginSignIn({ accountId, signal }) {
    if (!signInSpec || !enrollmentFromFlow) return unsupported();
    const { startProviderSignIn } = await import('../signin.mjs');
    const flow = await startProviderSignIn(signInSpec, { ...signInOptions,
      isActive: () => !signal?.aborted });
    flows.set(accountId, flow);
    return { ok: true, value: { flowId: accountId, state: 'waiting',
      presentation: { kind: 'browser', url: flow.url } } };
  }
  return {
    descriptor,
    beginSignIn: effects.beginSignIn ?? beginSignIn,
    finishSignIn: effects.finishSignIn ?? (async ({ flowId, answer }) => {
      const flow = flows.get(flowId);
      if (!flow) return fault('signin_expired');
      flows.delete(flowId);
      try { if (answer) await flow.submitCode(answer); await flow.waitForCompletion(); return await enrollmentFromFlow(flow); }
      finally { await flow.cleanup?.(); }
    }),
    cancelSignIn: effects.cancelSignIn ?? (async flowId => { const flow = flows.get(flowId); flows.delete(flowId); await flow?.cancel(); }),
    refresh: effects.refresh ?? unsupported,
    readUsage: effects.readUsage ?? (async () => ({ kind: 'unavailable', code: 'adapter_unsupported' })),
    authorizeRequest: effects.authorizeRequest ?? unsupported,
    makeRun: effects.makeRun ?? (() => fault('adapter_unsupported')),
    classifyReplay: effects.classifyReplay ?? (() => 'never'),
    parseJobUsage: effects.parseJobUsage ?? (() => fault('invalid_provider_response')),
    ...(effects.reconcileRotation ? { reconcileRotation: effects.reconcileRotation } : {}),
  };
}
