import { checkAccountSelection } from './account-catalog.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fault, ok, publicAccount } from './accounts.mjs';
import { createAccountUsage } from './account-usage.mjs';
import { newAccountModelSettings } from './provider-defaults.mjs';

const digest = key => createHash('sha256').update(key).digest('hex');
const operationAt = (state, id) => Object.hasOwn(state.replacementOperations ?? {}, id) ? state.replacementOperations[id] : undefined;
const saveOperation = (state, id, value) => {
  state.replacementOperations ??= {};
  Object.defineProperty(state.replacementOperations, id, { value, writable: true, enumerable: true, configurable: true });
};
const validRotation = value => value && Object.hasOwn(value, 'secret') &&
  (value.expiresAtMs === null || (Number.isSafeInteger(value.expiresAtMs) && value.expiresAtMs >= 0));
export function createAccountBroker({ store, providers, clock = Date.now, proxy, authority }) {
  const now = typeof clock === 'function' ? clock : () => clock.now();
  const flows = new Map(), replacements = new Map(), cancellations = new Map(), refreshes = new Map(), keys = new Map(), readers = new Map();
  const signIns = new Set();
  let closed = false;
  const adapterFor = record => providers.getProvider(record.providerId);
  // An account that never saved model settings lends nothing; give it the new-account defaults once.
  // A record with any modelPreferences object, even an empty one, is left alone.
  const defaultsFor = record => {
    const found = providers.getProvider(record.providerId);
    return found.ok ? newAccountModelSettings(record.providerId, found.value.descriptor.models ?? []) : null;
  };
  if (Object.values(store.read().records).some(record => record.modelPreferences === undefined && defaultsFor(record)?.modelOrder.length)) {
    const backfill = store.transaction(state => {
      for (const record of Object.values(state.records)) {
        const defaults = record.modelPreferences === undefined ? defaultsFor(record) : null;
        if (defaults?.modelOrder.length) Object.assign(record, defaults);
      }
    }).catch(() => {}).finally(() => signIns.delete(backfill));
    signIns.add(backfill);
  }
  const unavailable = id => {
    const record = store.get(id);
    return !record || record.removalIntent || record.replacementIntent || !record.enabled;
  };
  const updateOperations = (accountId, fn) => store.transaction(state => {
    const record = state.records[accountId];
    if (!record) return;
    record.dispatchOperations ??= {};
    return fn(record.dispatchOperations, record);
  });
  const receiptConfirms = (receipt, operations) => receipt &&
    Array.isArray(receipt.aborted) && Array.isArray(receipt.unconfirmed) &&
    receipt.unconfirmed.length === 0 &&
    operations.every(op => op.upstreamId && receipt.aborted.includes(op.upstreamId));
  async function rotate(accountId, force = false) {
    if (closed) return fault('account_signed_out', accountId);
    if (refreshes.has(accountId)) return refreshes.get(accountId);
    const promise = store.exclusive(accountId, async () => {
      let record = store.get(accountId);
      if (!record) return fault('account_not_found', accountId);
      if (record.removalIntent) return fault('account_removal_pending', accountId);
      if (record.replacementIntent) return fault('credential_replacement_pending', accountId);
      if (record.authState !== 'signed_in') return fault(record.authState === 'signed_out' ? 'account_signed_out' : 'reauthorization_required', accountId);
      const found = adapterFor(record);
      if (!found.ok) return found;
      const adapter = found.value;
      if (adapter.descriptor.refreshKind === 'none') return ok(record);
      if (record.refreshIntent) {
        const intent = record.refreshIntent;
        if (intent.retryAtMs > now()) return fault('refresh_uncertain', accountId, intent.retryAtMs);
        let reconciliation;
        try { reconciliation = await adapter.reconcileRotation?.({ accountId, intentId: intent.id,
          generation: record.generation, signal: new AbortController().signal }); } catch { /* uncertain remains durable */ }
        if (reconciliation?.kind === 'unavailable') {
          await store.compareAndSwap(accountId, record.generation, { refreshIntent: { ...intent, retryAtMs: reconciliation.retryAtMs } });
          return fault('refresh_uncertain', accountId, reconciliation.retryAtMs);
        }
        if (reconciliation?.kind === 'recovered') {
          if (!validRotation(reconciliation.rotation)) return fault('invalid_provider_response', accountId);
          const published = await store.compareAndSwap(accountId, record.generation, {
            ...reconciliation.rotation, subjectVerificationPending: reconciliation.rotation.subjectVerificationPending === true,
            generation: record.generation + 1, refreshIntent: null,
          });
          return published ? ok(store.get(accountId)) : fault('refresh_uncertain', accountId);
        }
        if (reconciliation?.kind !== 'unchanged') {
          await store.compareAndSwap(accountId, record.generation, { authState: 'reauthorization_required' });
          return fault('reauthorization_required', accountId);
        }
        // Only a proven unchanged outcome permits a retry of the old secret.
        await store.compareAndSwap(accountId, record.generation, { refreshIntent: null });
        force = true;
        record = store.get(accountId);
      }
      if (!force && (record.expiresAtMs === null || record.expiresAtMs > now() + 120000)) return ok(record);
      const intent = { id: randomUUID(), generation: record.generation, atMs: now() };
      if (!await store.compareAndSwap(accountId, record.generation, { refreshIntent: intent })) return fault('refresh_uncertain', accountId);
      let result;
      try { result = await adapter.refresh({ secret: record.secret, generation: record.generation,
        signal: new AbortController().signal }); } catch { return fault('auth_temporarily_unavailable', accountId); }
      if (!result.ok) {
        if (result.error.code === 'account_signed_out') {
          await store.compareAndSwap(accountId, record.generation, { authState: 'reauthorization_required' });
          return fault('reauthorization_required', accountId);
        }
        return fault('auth_temporarily_unavailable', accountId);
      }
      if (!validRotation(result.value)) return fault('invalid_provider_response', accountId);
      if (!await store.compareAndSwap(accountId, record.generation, { ...result.value,
        // A rotation that proved its subject clears the flag explicitly; one that could not confirm it keeps the
        // flag so the account's shared usage schedule rechecks the identity.
        subjectVerificationPending: result.value.subjectVerificationPending === true,
        generation: record.generation + 1, refreshIntent: null })) return fault('refresh_uncertain', accountId);
      return ok(store.get(accountId));
    });
    refreshes.set(accountId, promise);
    try { return await promise; } finally { refreshes.delete(accountId); }
  }
  async function verify(binding, proof, minimumFence = -1, signal) {
    if (proof?.schemaVersion !== 1 || typeof proof.signedEnvelope !== 'string' || !proof.signedEnvelope) return fault('lease_invalid', binding.selection.accountId);
    let verified;
    try { verified = await authority.verify({ proof, selection: binding.selection, jobId: binding.jobId,
      attemptId: binding.attemptId, nowMs: now(), ...(signal ? { signal } : {}) }); } catch { return fault('authority_unavailable', binding.selection.accountId); }
    if (!verified?.ok) return verified ?? fault('authority_unavailable', binding.selection.accountId);
    const { expiresAtMs, fence } = verified.value;
    if (!Number.isSafeInteger(fence) || fence < minimumFence) return fault('lease_fenced', binding.selection.accountId);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()) return fault('lease_expired', binding.selection.accountId);
    return verified;
  }
  async function verifyPublication(binding, proof, minimumFence, signal) {
    // The provider has already replied. This coordinator read must not retain
    // dispatch ownership forever, even if the authority ignores cancellation.
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    const interrupted = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve(fault(
        signal.aborted ? 'job_key_revoked' : 'authority_unavailable', binding.selection.accountId)), { once: true });
    });
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort('publication_deadline'), 10000);
    try {
      if (signal.aborted) cancel();
      if (controller.signal.aborted) return await interrupted;
      return await Promise.race([verify(binding, proof, minimumFence, controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }
  const broker = {
    async list() {
      const state = store.read();
      const ids = [...new Set([...state.accountOrder, ...Object.keys(state.records)])];
      return ids.filter(id => state.records[id]).map(id => publicAccount(state.records[id]));
    },
    async enroll({ providerId, label, signal }) {
      if (closed) return fault('account_signed_out');
      const found = providers.getProvider(providerId);
      if (!found.ok) return found;
      const id = randomUUID();
      let result;
      try { result = await found.value.beginSignIn({ accountId: id, signal }); } catch { return fault('signin_failed', id); }
      if (result.ok) {
        if (typeof result.value?.flowId !== 'string' || !result.value.flowId ||
            flows.has(result.value.flowId) || replacements.has(result.value.flowId))
          return fault('invalid_provider_response', id);
        flows.set(result.value.flowId, { id, providerId, label, expiresAtMs: now() + 300000 });
        // Retain the exact late flow for close's cancellation sweep.
        if (closed) return fault('account_signed_out', id);
      }
      return result;
    },
    cancelSignIn(flowId) {
      if (cancellations.has(flowId)) return cancellations.get(flowId);
      const flow = flows.get(flowId) ?? replacements.get(flowId);
      if (!flow) return Promise.resolve(ok());
      const work = Promise.resolve().then(async () => {
        const found = providers.getProvider(flow.providerId);
        if (!found.ok) return found;
        try {
          const result = await found.value.cancelSignIn(flowId);
          if (result?.ok === false) return fault('signin_cancel_failed', flow.id);
          if (flows.get(flowId) === flow) flows.delete(flowId);
          if (replacements.get(flowId) === flow) replacements.delete(flowId);
          return ok();
        } catch { return fault('signin_cancel_failed', flow.id); }
      }).finally(() => cancellations.delete(flowId));
      cancellations.set(flowId, work);
      return work;
    },
    async complete({ flowId, answer, signal }) {
      if (cancellations.has(flowId)) return fault('signin_cancel_pending', flows.get(flowId)?.id ?? replacements.get(flowId)?.id);
      const flow = flows.get(flowId);
      if (!flow || flow.expiresAtMs <= now()) {
        flows.delete(flowId);
        if (flow) await providers.getProvider(flow.providerId).value.cancelSignIn(flowId);
        return fault('signin_expired', flow?.id);
      }
      flows.delete(flowId); // A completion has sole ownership of the flow.
      let result;
      try { result = await providers.getProvider(flow.providerId).value.finishSignIn({ flowId, answer, signal }); }
      catch { return fault('signin_failed', flow.id); }
      if (!result.ok) return result;
      if (closed) return fault('account_signed_out', flow.id);
      const enrollment = result.value;
      if (typeof enrollment?.subjectId !== 'string' || !enrollment.subjectId || !validRotation(enrollment)) return fault('invalid_provider_response', flow.id);
      return store.transaction(state => {
        const duplicate = Object.values(state.records).find(r => r.providerId === flow.providerId && r.subjectId === enrollment.subjectId);
        if (duplicate) return fault('account_exists', duplicate.id);
        const record = { schemaVersion: 1, id: flow.id, providerId: flow.providerId, label: flow.label,
          authState: 'signed_in', generation: 0, expiresAtMs: enrollment.expiresAtMs,
          enabled: true, modelOrder: [], subjectId: enrollment.subjectId, secret: enrollment.secret, refreshIntent: null };
        const defaults = defaultsFor(record);
        if (defaults?.modelOrder.length) Object.assign(record, defaults);
        state.records[record.id] = record;
        return ok(publicAccount(record));
      });
    },
    // Optional host-only API-key repair. Never exposed through a borrowed job port.
    async beginCredentialReplacement({ accountId, expectedGeneration, signal }) {
      if (closed) return fault('account_signed_out', accountId);
      const record = store.get(accountId);
      if (!record) return fault('account_not_found', accountId);
      const found = adapterFor(record);
      if (!found.ok) return found;
      if (found.value.descriptor.signInKind !== 'api_key' || found.value.descriptor.refreshKind !== 'none')
        return fault('adapter_unsupported', accountId);
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration >= Number.MAX_SAFE_INTEGER || record.generation !== expectedGeneration)
        return fault('operation_conflict', accountId);
      if (record.removalIntent) return fault('account_removal_pending', accountId);
      if (signal?.aborted) return fault('signin_cancelled', accountId);
      let result;
      try { result = await found.value.beginSignIn({ accountId, signal }); }
      catch { return fault('signin_failed', accountId); }
      if (result.ok) {
        if (typeof result.value?.flowId !== 'string' || !result.value.flowId ||
            flows.has(result.value.flowId) || replacements.has(result.value.flowId))
          return fault('invalid_provider_response', accountId);
        replacements.set(result.value.flowId, { id: accountId, providerId: record.providerId,
          subjectId: record.subjectId, generation: expectedGeneration, expiresAtMs: now() + 300000 });
        if (closed) return fault('account_signed_out', accountId);
      }
      return result;
    },
    async completeCredentialReplacement({ flowId, answer, operationId, signal }) {
      if (cancellations.has(flowId)) return fault('signin_cancel_pending', replacements.get(flowId)?.id);
      if (closed) return fault('account_signed_out');
      if (typeof operationId !== 'string' || !operationId || typeof flowId !== 'string' ||
          (answer !== undefined && typeof answer !== 'string')) return fault('operation_conflict');
      // Only a digest is durable. Neither the pasted answer nor the verified
      // candidate is stored in an intent or operation receipt.
      const fingerprint = digest(JSON.stringify([flowId, answer ?? null]));
      let previous;
      try { previous = operationAt(store.read(), operationId); }
      catch { return fault('credential_replacement_pending'); }
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fault('operation_conflict', previous.accountId);
        if (previous.status === 'completed') return ok(structuredClone(previous.account));
      }
      const flow = replacements.get(flowId);
      if (!flow || flow.expiresAtMs <= now()) {
        replacements.delete(flowId);
        return fault('signin_expired', flow?.id);
      }
      return store.exclusive(flow.id, async () => {
        try {
          const replay = operationAt(store.read(), operationId);
          if (replay) {
            if (replay.fingerprint !== fingerprint) return fault('operation_conflict', flow.id);
            if (replay.status === 'completed') return ok(structuredClone(replay.account));
          }
          let record = store.get(flow.id);
          if (!record) return fault('account_not_found', flow.id);
          if (record.removalIntent) return fault('account_removal_pending', flow.id);
          if (record.generation !== flow.generation || record.subjectId !== flow.subjectId ||
              record.providerId !== flow.providerId) return fault('operation_conflict', flow.id);
          const found = adapterFor(record);
          if (!found.ok) return found;
          if (found.value.descriptor.signInKind !== 'api_key' || found.value.descriptor.refreshKind !== 'none')
            return fault('adapter_unsupported', flow.id);
          if (signal?.aborted) return fault('signin_cancelled', flow.id);
          if (replacements.get(flowId) !== flow) return fault('signin_cancel_pending', flow.id);
          replacements.delete(flowId); // Completion owns the provider flow from here.
          const verified = await found.value.finishSignIn({ flowId, answer, signal });
          if (!verified.ok) return verified;
          if (closed) return fault('account_signed_out', flow.id);
          const candidate = verified.value;
          if (!validRotation(candidate) || typeof candidate.subjectId !== 'string' || !candidate.subjectId)
            return fault('invalid_provider_response', flow.id);
          if (candidate.subjectId !== flow.subjectId) return fault('job_binding_mismatch', flow.id);
          if (signal?.aborted) return fault('signin_cancelled', flow.id);
          if (flow.expiresAtMs <= now()) return fault('signin_expired', flow.id);
          const staged = await store.transaction(state => {
            const current = state.records[flow.id];
            if (!current || current.removalIntent || current.generation !== flow.generation ||
                current.subjectId !== flow.subjectId || current.providerId !== flow.providerId) return false;
            const entry = operationAt(state, operationId);
            if (entry && (entry.fingerprint !== fingerprint || entry.accountId !== flow.id)) return false;
            saveOperation(state, operationId, { fingerprint, accountId: flow.id, status: 'pending' });
            current.replacementIntent = { operationId, generation: flow.generation, atMs: now() };
            current.guestKeys ??= {};
            for (const key of Object.values(current.guestKeys)) key.revoked = true;
            return true;
          });
          if (!staged) return fault('operation_conflict', flow.id);
          record = store.get(flow.id);
          // Never await transport while holding a metadata transaction.
          for (const keyId of Object.keys(record.guestKeys ?? {})) await broker.revokeJobKey(keyId);
          const committed = await store.transaction(state => {
            const current = state.records[flow.id];
            if (!current || current.removalIntent || current.generation !== flow.generation ||
                current.subjectId !== flow.subjectId || current.providerId !== flow.providerId ||
                current.replacementIntent?.operationId !== operationId) return fault('operation_conflict', flow.id);
            if (closed || signal?.aborted || Object.keys(current.dispatchOperations ?? {}).length ||
                Object.values(current.guestKeys ?? {}).some(key => !key.confirmed))
              return fault('credential_replacement_pending', flow.id);
            // The store alone creates private references and publishes metadata.
            current.secret = candidate.secret;
            current.expiresAtMs = candidate.expiresAtMs;
            current.authState = 'signed_in';
            current.generation++;
            current.refreshIntent = null;
            current.replacementIntent = null;
            const account = publicAccount(current);
            saveOperation(state, operationId, { fingerprint, accountId: flow.id, status: 'completed', account });
            return ok(account);
          });
          if (committed.ok) replacements.delete(flowId);
          return committed;
        } catch { return fault('credential_replacement_pending', flow.id); }
      });
    },
    async remove(accountId) {
      if (closed) return fault('account_signed_out', accountId);
      // The metadata transaction is also the dispatch admission barrier.
      await store.transaction(state => {
        const record = state.records[accountId];
        if (!record) return;
        record.removalIntent ??= { atMs: now() };
        record.enabled = false;
        record.guestKeys ??= {};
        for (const key of Object.values(record.guestKeys)) key.revoked = true;
      });
      const record = store.get(accountId);
      if (!record) return ok();
      for (const keyId of Object.keys(record.guestKeys ?? {})) await broker.revokeJobKey(keyId);
      const result = await store.exclusive(accountId, () => store.transaction(state => {
        const current = state.records[accountId];
        if (!current) return ok();
        if (current.refreshIntent || Object.keys(current.dispatchOperations ?? {}).length ||
            Object.values(current.guestKeys ?? {}).some(key => !key.confirmed)) {
          return fault('account_removal_pending', accountId);
        }
        delete state.records[accountId];
        return ok();
      }));
      if (result.ok) {
        await readers.get(accountId)?.close();
        readers.delete(accountId);
      }
      return result;
    },
    async withAuth(accountId, fn) {
      if (closed) return fault('account_signed_out', accountId);
      const result = await rotate(accountId);
      if (!result.ok) return result;
      const record = result.value;
      try { return ok(await fn({ accountId, providerId: record.providerId, generation: record.generation, secret: record.secret,
        ...(record.subjectVerificationPending === true ? { subjectVerificationPending: true } : {}) })); }
      catch { return fault('auth_temporarily_unavailable', accountId); }
    },
    // Host-internal usage port; it shares exactly the same rotation singleflight.
    refreshAuth: accountId => rotate(accountId, true),
    getAccountUsage(accountId) {
      const record = store.get(accountId);
      if (!record) throw Object.assign(new Error('account_not_found'), fault('account_not_found', accountId).error);
      if (!readers.has(accountId)) readers.set(accountId, createAccountUsage({ accountId, store,
        broker, adapter: adapterFor(record).value, clock: now,
        enabled: () => store.get(accountId)?.enabled ?? false,
        running: () => (store.get(accountId)?.activeJobCount??0)>0||Object.values(store.get(accountId)?.guestKeys??{}).some(key=>!key.revoked) }));
      return readers.get(accountId);
    },
    requestUsageReads(reason='status') {
      return Promise.allSettled(Object.values(store.read().records).filter(record=>record.enabled&&!record.removalIntent)
        .map(record=>broker.getAccountUsage(record.id).requestRead({reason})));
    },
    async issueJobKey({ selection, jobId, attemptId, leaseProof }) {
      if (closed) return fault('account_signed_out', selection.accountId);
      const record = store.get(selection.accountId);
      if (!record) return fault('account_not_found', selection.accountId);
      if (record.providerId !== selection.providerId) return fault('job_binding_mismatch', selection.accountId);
      if (record.authState !== 'signed_in' || !record.enabled) return fault('account_signed_out', selection.accountId);
      const descriptor = adapterFor(record).value.descriptor;
      const selected = checkAccountSelection(record, descriptor, selection);
      if (selected.code) return fault(selected.code, selection.accountId);
      selection = { ...selection, effortId: selected.effortId };
      const binding = { selection: structuredClone(selection), jobId, attemptId };
      const generation = record.generation;
      const verified = await verify(binding, leaseProof);
      if (!verified.ok) return verified;
      const key = randomBytes(32).toString('base64url'), keyId = randomUUID();
      const value = { schemaVersion: 1, keyId, ...binding, expiresAtMs: Math.min(now() + 300000, verified.value.expiresAtMs), fence: verified.value.fence };
      const admitted = await store.transaction(state => {
        const current = state.records[selection.accountId];
        if (closed || !current || current.removalIntent || current.replacementIntent || !current.enabled ||
            current.generation !== generation || current.authState !== 'signed_in') return false;
        const effective = checkAccountSelection(current, adapterFor(current).value.descriptor, selection);
        if (effective.code) return effective.code;
        if (effective.effortId !== selection.effortId) return 'effort_unavailable';
        current.guestKeys ??= {};
        if(descriptor.maxConcurrentJobs!==null&&Object.values(current.guestKeys).filter(k=>!k.revoked).length>=descriptor.maxConcurrentJobs)return 'account_busy';
        current.guestKeys[keyId] = { revoked: false, confirmed: false, generation };
        return true;
      });
      if (admitted!==true) return fault(admitted || 'account_removal_pending', selection.accountId);
      keys.set(keyId, { ...value, generation,
        replacementBound: descriptor.signInKind === 'api_key' && descriptor.refreshKind === 'none',
        digest: digest(key), proof: leaseProof, revoked: false, acceptedObservations: new Set() });
      return ok({ ...value, key });
    },
    async renewJobKey({ keyId, leaseProof, forStart = false }) {
      const key = keys.get(keyId);
      if (!key || key.revoked) return fault('job_key_revoked');
      if (key.expiresAtMs <= now()) return fault('job_key_expired');
      const result = await verify(key, leaseProof, key.fence);
      if (!result.ok) return result;
      const valid = await store.transaction(state => {
        const current = state.records[key.selection.accountId];
        const owned = !closed && !key.revoked && current && current.enabled && current.authState === 'signed_in' &&
          !current.removalIntent && !current.replacementIntent && (!key.replacementBound || current.generation === key.generation) &&
          current.guestKeys?.[keyId]?.generation === key.generation && !current.guestKeys[keyId].revoked;
        if (!owned) return 'job_key_revoked';
        if (forStart) {
          const effective = checkAccountSelection(current, adapterFor(current).value.descriptor, key.selection);
          if (effective.code) return effective.code;
          if (effective.effortId !== key.selection.effortId) return 'effort_unavailable';
        }
        return null;
      });
      if (valid) return fault(valid, key.selection.accountId);
      key.proof = leaseProof;
      key.fence = result.value.fence;
      key.expiresAtMs = Math.min(now() + 300000, result.value.expiresAtMs);
      return ok({ keyId, expiresAtMs: key.expiresAtMs, fence: key.fence });
    },
    async revokeJobKey(keyId) {
      const key = keys.get(keyId);
      if (key) { key.revoked = true; key.acceptedObservations.clear(); }
      const accountId = key?.selection.accountId ?? Object.values(store.read().records)
        .find(record => Object.hasOwn(record.guestKeys ?? {}, keyId))?.id;
      if (accountId) await updateOperations(accountId, (_operations, record) => {
        if (record.guestKeys?.[keyId]) record.guestKeys[keyId].revoked = true;
      });
      return dispatcher.revokeStreams({ keyId, reason: 'revoked', accountId });
    },
    async close() {
      closed = true;
      for (const keyId of keys.keys()) await broker.revokeJobKey(keyId);
      // Begins may still supply a flow to cancel, and completions may still own a store write.
      await Promise.allSettled([...signIns, ...refreshes.values(), ...[...readers.values()].map(reader => reader.close())]);
      let cancellationFailed = false;
      for (const flowId of [...flows.keys(), ...replacements.keys()]) {
        try {
          const result = await broker.cancelSignIn(flowId);
          if (!result.ok) cancellationFailed = true;
        } catch { cancellationFailed = true; }
      }
      // Confirmed flows were retired by cancelSignIn. Keep the rest for the next close.
      if (cancellationFailed) throw Object.assign(new Error('signin_cancel_failed'), {code:'signin_cancel_failed'});
      flows.clear(); replacements.clear();
    },
  };
  const streams = new Map();
  const consumedBodies = new WeakSet();
  // Durable dispatch metadata remains cessation debt, even for rejected replies.
  // Only publication accepted by this live key can attest execution evidence.
  broker.executionObservation=({selection,jobId,attemptId})=>{
    const record=store.get(selection.accountId);
    if(closed||!record||!record.enabled||record.authState!=='signed_in'||record.removalIntent||record.replacementIntent)return null;
    const operations=Object.values(record?.dispatchOperations??{}).filter(op=>
      op.binding?.jobId===jobId&&op.binding?.attemptId===attemptId);
    if(!operations.length||operations.some(op=>{
      const key=keys.get(op.keyId),guest=record.guestKeys?.[op.keyId];
      return !key||key.revoked||key.expiresAtMs<=now()||!key.acceptedObservations.has(op.binding?.operationId)||
        key.fence!==op.fence||op.binding?.fence!==op.fence||op.binding?.generation!==op.generation||
        !guest||guest.revoked||guest.generation!==key.generation||
        ['providerId','accountId','modelId','effortId'].some(field=>op.binding?.selection?.[field]!==selection[field])||
        !op.observedModel||op.generation!==record.generation;
    }))return null;
    const models=new Set(operations.map(op=>op.observedModel));
    return models.size===1?{jobId,attemptId,selection:structuredClone(selection),model:[...models][0]}:null;
  };
  const dispatcher = {
    async dispatch({ key: bearer, request, signal }) {
      let disposed = false;
      const dispose = async () => { if (!disposed) { disposed = true; await request.body?.dispose?.(); } };
      let streamId, abort, transferred = false;
      try {
        if (request.body?.kind === 'one_shot') {
          if (consumedBodies.has(request.body)) { disposed = true; return fault('body_already_consumed'); }
          consumedBodies.add(request.body);
        }
        const key = typeof bearer === 'string' ? [...keys.values()].find(k => k.digest === digest(bearer)) : null;
        if (!key || closed) return fault('job_key_invalid');
        if (key.revoked) return fault('job_key_revoked');
        if (key.expiresAtMs <= now()) return fault('job_key_expired');
        const record = store.get(key.selection.accountId);
        if (!record) return fault('account_not_found', key.selection.accountId);
        const adapter = adapterFor(record).value;
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        // Guest binding hints are assertions, never routing authority.
        for (const [header, expected] of [['x-faravan-provider-id', key.selection.providerId], ['x-faravan-account-id', key.selection.accountId], ['x-faravan-job-id', key.jobId], ['x-faravan-attempt-id', key.attemptId]]) {
          if (headers.has(header) && headers.get(header) !== expected) return fault('job_binding_mismatch');
          headers.delete(header);
        }
        if (url.username || url.password || url.searchParams.has('accountId') ||
          !adapter.descriptor.destinations.some(d => d.origin === url.origin && d.methods.includes(request.method) &&
            d.pathPrefixes.some(prefix => url.pathname.startsWith(prefix)))) return fault('destination_denied');
        headers.delete('authorization'); headers.delete('proxy-authorization'); headers.delete('cookie'); headers.delete('x-api-key');
        const verified = await verify(key, key.proof, key.fence);
        if (!verified.ok) return verified;
        key.fence = verified.value.fence;
        let authorizedGeneration;
        const authorize = () => broker.withAuth(record.id, async auth => {
          authorizedGeneration = auth.generation;
          return adapter.authorizeRequest({ auth, request: { ...request, headers: Object.fromEntries(headers) } });
        });
        let authResult = await authorize();
        if (authResult.ok && !authResult.value.ok && authResult.value.error.code === 'auth_expired' &&
          request.body.kind !== 'one_shot' && adapter.classifyReplay({ method: request.method, url: request.url,
            dispatched: false, responseStatus: null }) === 'safe_if_reconstructable') {
          const refresh = await rotate(record.id, true);
          if (!refresh.ok) return refresh;
          const retryAuthority = await verify(key, key.proof, key.fence);
          if (!retryAuthority.ok) return retryAuthority;
          if (key.revoked) return fault('job_key_revoked');
          authResult = await authorize();
        }
        if (!authResult.ok) return authResult;
        if (!authResult.value.ok) return authResult.value;
        // Recheck authority after any queued refresh and before the upstream effect.
        const last = await verify(key, key.proof, key.fence);
        if (!last.ok) return last;
        if (key.revoked || key.expiresAtMs <= now() || unavailable(record.id) ||
            store.get(record.id)?.guestKeys?.[key.keyId]?.revoked) return fault('job_key_revoked');
        streamId = randomUUID();
        const controller = new AbortController();
        abort = () => { key.acceptedObservations.delete(streamId); controller.abort(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const binding = { operationId: streamId, keyId: key.keyId,
          selection: structuredClone(key.selection), jobId: key.jobId, attemptId: key.attemptId,
          generation: authorizedGeneration, fence: last.value.fence };
        const admitted = await updateOperations(record.id, (operations, current) => {
          if (current.removalIntent || current.replacementIntent || !current.enabled || current.authState !== 'signed_in' ||
              (key.replacementBound && current.generation !== key.generation) || current.generation !== authorizedGeneration ||
              current.guestKeys?.[key.keyId]?.generation !== key.generation || current.guestKeys[key.keyId].revoked) return false;
          operations[streamId] = { keyId: key.keyId, upstreamId: null, atMs: now(),
            generation: authorizedGeneration, fence: last.value.fence, binding: structuredClone(binding) };
          return true;
        });
        if (!admitted) return fault('job_key_revoked');
        let checking = false;
        const watch = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            if (unavailable(record.id) || store.get(record.id)?.guestKeys?.[key.keyId]?.revoked) {
              key.revoked = true;
              controller.abort('revoked');
              await broker.revokeJobKey(key.keyId);
            }
          } catch { key.revoked = true; controller.abort('revocation_check_failed'); }
          finally { checking = false; }
        }, 250);
        watch.unref?.();
        streams.set(streamId, { keyId: key.keyId, controller, dispose, watch, accountId: record.id });
        // Durable pre-dispatch entry survives ambiguity or process death; never replay it.
        // Only this closure can authorize the effect. The transport calls it
        // after consuming/validating the guest body, and supplies the finite
        // send thunk, never guest-controlled authority. No await separates the
        // final local checks from invoking that thunk.
        let sendClaimed = false;
        const authorizeSend = async send => {
          if (sendClaimed || typeof send !== 'function') return fault('authority_unavailable', record.id);
          sendClaimed = true;
          if (controller.signal.aborted || signal?.aborted) return fault('request_aborted', record.id);
          const proof = key.proof;
          const currentAuthority = await verify(key, proof, binding.fence);
          if (!currentAuthority.ok) return currentAuthority;
          if (controller.signal.aborted || signal?.aborted) return fault('request_aborted', record.id);
          if (closed || keys.get(key.keyId) !== key || key.revoked) return fault('job_key_revoked', record.id);
          if (key.expiresAtMs <= now()) return fault('job_key_expired', record.id);
          if (key.proof !== proof || currentAuthority.value.fence !== binding.fence)
            return fault('lease_fenced', record.id);
          const current = store.get(record.id), guest = current?.guestKeys?.[key.keyId];
          if (!current || current.removalIntent || current.replacementIntent || !current.enabled ||
              current.authState !== 'signed_in' || current.generation !== authorizedGeneration ||
              (key.replacementBound && current.generation !== key.generation) ||
              !guest || guest.revoked || guest.generation !== key.generation ||
              !Object.hasOwn(current.dispatchOperations ?? {}, streamId))
            return fault('job_key_revoked', record.id);
          return ok(await send());
        };
        const upstream = await proxy.dispatch({ key: bearer, request: authResult.value.value,
          signal: controller.signal, binding: structuredClone(binding), authorizeSend,
          observeResponse:input=>adapter.parseExecutionResponse?.(input)??null,
          // The served model is known only when the reply ends; it is recorded before the stream closes for the guest.
          onObservation:observation=>updateOperations(record.id,operations=>{
            if(operations[streamId]&&typeof observation?.model==='string')operations[streamId].observedModel=observation.model;}) });
        const publicationProof=key.proof;
        if (upstream.ok) await updateOperations(record.id, operations => {
          if (operations[streamId]) {operations[streamId].upstreamId = upstream.value.streamId;
            operations[streamId].observedModel = typeof upstream.value.observation?.model==='string'?upstream.value.observation.model:null;}
        });
        if (!upstream.ok) { signal?.removeEventListener('abort', abort); return fault(upstream.error?.code ?? 'auth_temporarily_unavailable', record.id); }
        const publicationAuthority=await verifyPublication(key,publicationProof,binding.fence,controller.signal);
        if(!publicationAuthority.ok){
          void upstream.value.response.body?.cancel().catch(()=>{});
          return publicationAuthority;
        }
        // Persistence above yields: a revoke may win after transport admission.
        // A late response must not be handed back as a successful guest dispatch.
        if (key.revoked || controller.signal.aborted || unavailable(record.id)) return fault('job_key_revoked', record.id);
        const response = upstream.value.response;
        const reader = response.body?.getReader();
        // Cancel a pending read independently of upstream signal cooperation.
        if (reader) streams.get(streamId).cancelReader = () => reader.cancel('revoked');
        const finish = async () => {
          clearInterval(watch); streams.delete(streamId);
          signal?.removeEventListener('abort', abort); await dispose();
          // EOF/bodyless response is delivery, not positive provider cessation.
          // Retain the journal until the transport's revocation receipt proves stop.
        };
        const body = reader ? new ReadableStream({
          async pull(controller) {
            try {
              if (key.revoked || unavailable(record.id)) {
                void reader.cancel().catch(() => {});
                controller.error(new Error('job_key_revoked')); await finish(); return;
              }
              const chunk = await reader.read();
              if (key.revoked || unavailable(record.id)) {
                controller.error(new Error('job_key_revoked')); await finish(); return;
              }
              if (chunk.done) { controller.close(); await finish(); } else controller.enqueue(chunk.value);
            } catch (error) { key.acceptedObservations.delete(streamId); controller.error(error); await finish(); }
          },
          async cancel(reason) { key.acceptedObservations.delete(streamId); try { await reader.cancel(reason); } finally { await finish(); } },
        }) : null;
        if (!reader) await finish();
        const current=store.get(record.id),operation=current?.dispatchOperations?.[streamId];
        if(closed||key.revoked||controller.signal.aborted||signal?.aborted||key.expiresAtMs<=now()||
          key.proof!==publicationProof||key.fence!==binding.fence||publicationAuthority.value.fence!==binding.fence||
          !current||!current.enabled||current.authState!=='signed_in'||current.removalIntent||current.replacementIntent||
          current.generation!==authorizedGeneration||!operation||current.guestKeys?.[key.keyId]?.revoked)
          return fault('job_key_revoked',record.id);
        const published=new Response(body,{status:response.status,headers:response.headers});
        // No await between the final checks, acceptance, and successful return.
        key.acceptedObservations.add(streamId);
        transferred = true;
        return ok({ streamId, response: published });
      } catch { return fault('auth_temporarily_unavailable'); }
      finally {
        if (!transferred) {
          if (abort) signal?.removeEventListener('abort', abort);
          if (streamId) { clearInterval(streams.get(streamId)?.watch); streams.delete(streamId); }
          await dispose();
        }
      }
    },
    async revokeStreams({ keyId, reason, accountId }) {
      const active = [...streams].filter(([, stream]) => stream.keyId === keyId);
      for (const [, stream] of active) {
        stream.controller.abort(reason);
        if (stream.cancelReader) void Promise.resolve().then(stream.cancelReader).catch(() => {});
        void Promise.resolve().then(stream.dispose).catch(() => {});
      }
      const id = accountId ?? active[0]?.[1].accountId ?? keys.get(keyId)?.selection.accountId;
      let receipt;
      try { receipt = await proxy.revokeStreams({ keyId, reason }); }
      catch { receipt = { aborted: [], unconfirmed: [keyId] }; }
      let rejectedReceipt = false;
      if (id) await updateOperations(id, (operations, record) => {
        const relevant = Object.entries(operations).filter(([, op]) => op.keyId === keyId);
        if (receipt && Object.hasOwn(receipt, 'reconciled')) {
          // This private receipt is supplied only by the injected transport. Validate
          // the entire batch before changing any row; foreign/conflicting evidence
          // must never clear an unrelated operation.
          const saved = record.dispatchCessations ?? {};
          const items = receipt.reconciled;
          const seen = new Set(), seenStreams = new Set();
          const valid = Array.isArray(items) && Array.isArray(receipt.aborted) &&
            Array.isArray(receipt.unconfirmed) && items.every(item => {
              if (!item || typeof item.operationId !== 'string' || !item.operationId ||
                  typeof item.streamId !== 'string' || !item.streamId ||
                  !Number.isSafeInteger(item.ceasedAtMs) || item.ceasedAtMs < 0 || item.ceasedAtMs > now() ||
                  seen.has(item.operationId) || seenStreams.has(item.streamId) || !receipt.aborted.includes(item.streamId) ||
                  receipt.unconfirmed.includes(item.operationId) || receipt.unconfirmed.includes(item.streamId)) return false;
              seen.add(item.operationId); seenStreams.add(item.streamId);
              const op = Object.hasOwn(operations, item.operationId) ? operations[item.operationId] : null;
              const prior = Object.hasOwn(saved, item.operationId) ? saved[item.operationId] : null;
              if (!op) return prior && prior.keyId === keyId &&
                prior.streamId === item.streamId && prior.ceasedAtMs === item.ceasedAtMs;
              const b = op.binding;
              return op.keyId === keyId && b?.keyId === keyId && b.operationId === item.operationId &&
                b.selection?.accountId === record.id && b.generation === op.generation && b.fence === op.fence &&
                Number.isSafeInteger(op.generation) && op.generation >= 0 &&
                Number.isSafeInteger(op.fence) && op.fence >= 0 &&
                (op.upstreamId === null || op.upstreamId === item.streamId);
            });
          if (!valid) {
            rejectedReceipt = true;
            if (record.guestKeys?.[keyId]) record.guestKeys[keyId].confirmed = false;
            return;
          }
          record.dispatchCessations ??= {};
          for (const item of items) {
            const op = operations[item.operationId];
            if (!op) continue; // already persisted, immutable replay
            Object.defineProperty(record.dispatchCessations, item.operationId, {
              value: { ...item, keyId, generation: op.generation, fence: op.fence },
              enumerable: true, writable: true, configurable: true,
            });
            delete operations[item.operationId];
          }
          if (record.guestKeys?.[keyId]) record.guestKeys[keyId].confirmed =
            receipt.unconfirmed.length === 0 && !Object.values(operations).some(op => op.keyId === keyId);
          return;
        }
        const confirmed = receiptConfirms(receipt, relevant.map(([, op]) => op));
        if (record.guestKeys?.[keyId]) record.guestKeys[keyId].confirmed = !!confirmed;
        if (confirmed) for (const [operationId] of relevant) delete operations[operationId];
      });
      const unresolved=id?Object.entries(store.get(id)?.dispatchOperations??{}).filter(([,op])=>op.keyId===keyId).map(([operationId])=>operationId):[];
      if(rejectedReceipt||!Array.isArray(receipt?.aborted)||!Array.isArray(receipt?.unconfirmed))return {aborted:[],unconfirmed:[keyId]};
      return {...receipt,unconfirmed:[...new Set([...receipt.unconfirmed,...unresolved])]};
    },
  };
  for (const name of ['enroll', 'beginCredentialReplacement', 'complete', 'completeCredentialReplacement']) {
    const operation = broker[name];
    broker[name] = async input => {
      if (closed) return fault('account_signed_out',
        name === 'beginCredentialReplacement' ? input?.accountId : undefined);
      // Register before invocation, including synchronous provider reentry.
      let settle;
      const owned = new Promise(resolve => { settle = resolve; });
      signIns.add(owned);
      try { return await operation(input); }
      finally { signIns.delete(owned); settle(); }
    };
  }
  return Object.assign(broker, { proxy: dispatcher });
}
