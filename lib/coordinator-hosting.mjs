/** Owner-scoped Gozar exposure shared by the coordinator and the ChatGPT gateway. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createGozar} from '@tnunamak/gozar';
import {ensureDurableDirectory} from './durable-directory.mjs';
import {saveJsonFile} from './local-state.mjs';
import {FaravanHostError} from './host.mjs';
import {hostingSecretBackend} from './hosting-secrets.mjs';
import {acquireProcessLock} from './v1/lock.mjs';

const known = value => ({known:true, value});
const capabilities = {'runtime.attached':known(true), 'runtime.durable':known(true), 'secrets.backend':known(true)};
export const hostingError = (code, message, details) => Object.assign(new FaravanHostError(message), {code, ...details});
const routeApproval = candidate => candidate.candidateToken && {
  kind:'route', candidateToken:candidate.candidateToken, consentFactsDigest:candidate.consentFactsDigest,
  disclosureRevision:candidate.disclosure.revision,
};
const setupApproval = action => ({
  kind:'setup', digest:action.digest, disclosureRevision:action.disclosure.revision,
  consentFactsDigest:action.consent.consentFactsDigest,
});
export function publishedOrigin(view, target) {
  const proof = view?.verification;
  return view?.state === 'usable' && proof?.status === 'verified' && proof.subject?.origin === view.published &&
    proof.subject?.target === target && proof.subject.handleGeneration === view.handle.generation &&
    proof.validUntil.known && Date.parse(proof.validUntil.value) > Date.now() &&
    (!view.binding.target.known || view.binding.target.value === target) ? view.published : null;
}

export function readHostingState(directory) {
  try {const state = JSON.parse(fs.readFileSync(path.join(directory, 'exposure.json'), 'utf8'));return state.spec ? state : null;}
  catch (error) {if (error.code !== 'ENOENT') throw error;return null;}
}

export function createHosting({directory, owner, api} = {}) {
  const home = path.join(directory, 'gz');
  const file = path.join(directory, 'exposure.json');
  const durableId = owner;
  api ??= createGozar({secretBackend:hostingSecretBackend(directory), hostCapabilities:capabilities});
  const read = () => readHostingState(directory);
  function save(state) {
    saveJsonFile(file, state, {base:directory});
    return state;
  }
  function query(spec, providerId) {
    const {target, reach, address = 'stable', origin, protocols = [], usage} = spec;
    return {schemaVersion:1, home, owner, target, ...(origin && {origin}), ...(providerId && {providerId}),
      usage:usage === 'durable' ? {kind:'durable', routeId:durableId} : {kind:'attached'},
      requirements:{reach, address, transport:reach === 'lan' ? 'any' : 'https',
        payloadAccess:'allow-provider', setup:'allow', protocols}};
  }
  async function offers(spec) {
    ensureDurableDirectory(home, {base:directory});
    const {candidates} = await api.catalogRoutes(query(spec, spec.providerId));
    return candidates.filter(row => row.eligible).map(row => ({
      providerId:row.providerId, display:row.display, properties:row.properties, configuration:row.configuration,
      setup:row.setup, consent:row.consent, approval:routeApproval(row),
    }));
  }
  async function select(spec, offer) {
    const specWithProvider = {...spec, providerId:offer.providerId};
    const current = read();
    if (current) {
      if (JSON.stringify(query(current.spec, current.spec.providerId)) !== JSON.stringify(query(specWithProvider, offer.providerId)))
        throw hostingError('operation_conflict', 'The saved exposure has a different destination or offer. Close it before changing it.');
      return current;
    }
    return save({spec:specWithProvider, routeOperationId:randomUUID()});
  }
  function selected() {
    const state = read();
    if (!state) throw hostingError('consent_required', 'Review and approve an exposure offer.');
    return state;
  }
  const setupRef = state => ({home, owner, providerId:state.spec.providerId, operationId:state.setupOperationId});
  async function setup() {
    let state = selected();
    if (state.setupOperationId) {
      try {return await api.readSetupOperation(setupRef(state));}
      catch (error) {if (error.code !== 'route_not_found') throw error;}
    }
    const [offer] = await offers(state.spec);
    if (!offer || offer.setup.state === 'ready') return null;
    const action = offer.setup.actions[0];
    if (!action) throw hostingError('setup_required', 'Gozar could not offer a setup action.');
    if (!state.setupOperationId) state = save({...state, setupOperationId:randomUUID()});
    return api.runSetupAction({...setupRef(state), actionId:action.id, expectedSetupRevision:0,
      expectedConfigurationRevision:offer.configuration.revision});
  }
  async function acceptSetup(approval, {value, secretHandle} = {}) {
    const state = selected(), ref = setupRef(state);
    const operation = await api.readSetupOperation(ref), action = operation.nextAction;
    if (!action || operation.revision !== approval.revision || operation.operationId !== approval.operationId ||
        action.consent.consentFactsDigest !== approval.consentFactsDigest)
      throw hostingError('candidate_stale', 'Review the current Gozar setup action.');
    const request = {...ref, actionId:action.id, expectedSetupRevision:operation.revision,
      expectedConfigurationRevision:operation.scope.configurationRevision, approval:setupApproval(action),
      ...(value !== undefined && {value}), ...(secretHandle !== undefined && {secretHandle})};
    return api.runSetupAction(request);
  }
  async function intake({operationId, revision, bytes}) {
    const state = selected(), operation = await api.readSetupOperation(setupRef(state));
    const {nextAction:action, scope} = operation;
    if (operation.operationId !== operationId || operation.revision !== revision || action?.kind !== 'provide-secret')
      throw hostingError('candidate_stale', 'Review the current Gozar setup action.');
    return api.storeSecret({home, owner, providerId:scope.providerId, scopeId:scope.scopeId,
      expectedConfigurationRevision:scope.configurationRevision, ...(scope.draftId && {draftId:scope.draftId}),
      inputId:action.inputId, bytes});
  }
  async function discardInput(handle) {
    try {await api.discardSecret({home,handle});}
    catch (error) {if (error.code !== 'secret_in_use') throw error;}
  }
  async function browser(approval, open) {
    const checked = await acceptSetup(approval);
    if (checked.state !== 'pending' || checked.nextAction?.kind !== 'open-url' || !checked.nextAction.step.browser) return checked;
    const interactive = await api.readSetupOperation({...setupRef(selected()), includeBrowserHandoff:true});
    if (interactive.operationId === checked.operationId && interactive.revision === checked.revision &&
        interactive.nextAction?.consent.consentFactsDigest === approval.consentFactsDigest && interactive.nextAction.href)
      await open(interactive.nextAction.href);
    return checked;
  }
  async function retainedHandle(state) {
    if (!state) return null;
    if (state.handle) return state.handle;
    const {routes} = await api.listRoutes({home, owner});
    return routes.find(route => route.operationId === state.routeOperationId)?.handle ?? null;
  }
  async function currentRoute(state = read()) {
    const handle = await retainedHandle(state);
    return handle ? api.routeStatus({home,handle}) : null;
  }
  function requireOperation(expected) {
    const state=read();
    // The launcher can start before the child has recorded the first handle.
    if(!expected?.routeOperationId||state?.routeOperationId!==expected.routeOperationId||
        !isDeepStrictEqual(state.spec,expected.spec)||expected.handle&&!isDeepStrictEqual(state.handle,expected.handle))
      throw hostingError('operation_conflict','The saved exposure no longer matches this host operation.');
    return state;
  }
  async function operationStatus(expected) {
    const state=requireOperation(expected),handle=await retainedHandle(state);
    const route=handle?await api.routeStatus({home,handle}):null;
    requireOperation(state);
    if(route&&(route.operationId!==state.routeOperationId||!isDeepStrictEqual(route.handle,handle)))
      throw hostingError('operation_conflict','Gozar returned a different host operation.');
    return route;
  }
  function confirmsSuspension(route,state) {
    return route?.state==='suspended'&&route.published===null&&route.cleanup?.state==='none'&&
      route.operationId===state.routeOperationId&&isDeepStrictEqual(route.handle,state.handle);
  }
  function matchesResumedRoute(route,state) {
    return route?.operationId===state.routeOperationId&&route.handle?.kind==='durable'&&
      route.handle.id===state.handle.id&&route.handle.generation===state.handle.generation+1;
  }
  function authorize(digest, {binding} = {}) {
    const state = selected();
    save({...state, pendingApproval:{digest,binding}});
  }
  async function start(approval, {binding, explicit = false, assertCurrent = ()=>{}, beforeMutation = ()=>{}} = {}) {
    assertCurrent();
    let state = selected();
    if (explicit && state.pendingApproval) {
      const {pendingApproval,...remaining} = state;
      const [offered] = await offers(state.spec);
      assertCurrent();
      // Catalog failure is retryable; a checked consent is single-use even when stale.
      state = save(remaining);
      if (!offered?.approval || offered.consent.consentFactsDigest !== pendingApproval.digest || pendingApproval.binding !== binding)
        throw hostingError('candidate_stale', 'The exposure offer changed. Review it again.');
      approval = offered.approval;
    }
    if (state.setupOperationId) beforeMutation();
    const operation = state.setupOperationId ? await setup() : null;
    assertCurrent();
    if (operation && operation.state !== 'complete')
      throw hostingError('setup_required', 'Finish the current Gozar setup before starting the exposure.', {operation});
    const request = query(state.spec, state.spec.providerId);
    const previous = await currentRoute(state);
    assertCurrent();
    if (previous && publishedOrigin(previous, request.target) && !approval) return previous;
    if (!approval && (request.usage.kind !== 'durable' || !previous))
      throw hostingError('consent_required', 'Review and approve the current Gozar exposure offer.');
    const resuming=!approval&&previous?.state==='suspended';
    if(resuming&&!confirmsSuspension(previous,state))
      throw hostingError('operation_conflict','The suspended route no longer matches the saved exposure.');
    let view;
    beforeMutation();
    // Replaying an explicit operation ID observes its journal. Omitting it
    // lets ensureRoute resume the SDK's retained, already approved operation.
    const routeRequest=resuming?request:{...request,operationId:state.routeOperationId};
    try {
      view = request.usage.kind === 'durable'
        ? await api.ensureRoute({...routeRequest, ...(approval && {approval, reconsent:true})})
        : await api.expose({...routeRequest, approval, wait:'verified'});
    } catch (error) {
      if (error.route?.handle&&(!resuming||matchesResumedRoute(error.route,state))) save({...state, handle:error.route.handle});
      throw error;
    }
    if(resuming&&!matchesResumedRoute(view,state))
      throw hostingError('operation_conflict','Gozar did not resume the exact approved durable exposure.');
    save({...state, handle:view.handle});
    return view;
  }
  async function close({origin,expected} = {}) {
    const bound=expected!==undefined,state=bound?requireOperation(expected):read();
    const handle = await retainedHandle(state);
    if (!handle) {
      if (!bound&&state?.pendingApproval) save({...state,pendingApproval:undefined});
      return null;
    }
    if(bound)requireOperation(state);
    const result = await api.closeRoute({home, handle, mode:'remove'});
    if (result.cleanup.state === 'confirmed') {
      if(bound)requireOperation(state);
      save({...state,spec:{...state.spec,...(origin&&{origin})},handle:undefined,pendingApproval:undefined,routeOperationId:randomUUID()});
    }
    return result;
  }
  async function cancelSetup() {
    const state = read();
    if (!state?.setupOperationId) return null;
    try {return await api.cancelSetupOperation(setupRef(state));}
    catch (error) {
      if (error.code !== 'route_not_found') throw error;
      save({...state,setupOperationId:undefined});
      return null;
    }
  }
  async function finishSetupCleanup(operation, {forgetSelection = false} = {}) {
    const state = read();
    if (!state) return true;
    if (operation && (operation.operationId !== state.setupOperationId || operation.state !== 'cancelled' ||
        operation.nextAction || operation.resources.some(row => !['confirmed','retained'].includes(row.removal)))) return false;
    if (state.setupOperationId && !operation) return false;
    if (state.handle) return false;
    if (forgetSelection) save({});
    else if (state.setupOperationId) save({...state,setupOperationId:undefined});
    return true;
  }
  async function* watch(view, signal) {
    for await (const event of api.watchRoutes({home, handle:view.handle, signal})) yield event.route;
  }
  async function shutdown(options) {
    // Durable intent is not proof of suspended forwarding. Retire every owned route.
    const route=await mutate(close)(options);
    if (route && route.cleanup.state !== 'confirmed')
      throw hostingError('cleanup_debt','Gozar could not confirm removal of the connector.',{route});
    return route;
  }
  async function suspend(owned) {
    const state=read();
    if(state?.spec.usage!=='durable'||state.routeOperationId!==owned.operationId||!isDeepStrictEqual(state.handle,owned.handle))
      throw hostingError('operation_conflict','The saved durable exposure changed before suspension.');
    const route=await api.suspendRoute({home,handle:state.handle});
    if(!confirmsSuspension(route,state))
      throw hostingError('cleanup_debt','Gozar could not confirm suspension of the durable exposure.',{route});
    return route;
  }
  const inspectLegacy = ({stateFiles,target,origin}) => api.inspectLegacyRoute({home,owner,source:{stateFiles},target,origin});
  const mutate = method => async (...args) => {
    const release = await acquireProcessLock(path.join(directory,'exposure'),{timeoutMs:15000});
    try {return await method(...args);} finally {release();}
  };
  return {read, offers, select:mutate(select), setup:mutate(setup), acceptSetup:mutate(acceptSetup), intake:mutate(intake),
    discardInput, browser:mutate(browser), authorize:mutate(authorize), start:mutate(start), status:currentRoute,
    operationStatus:mutate(operationStatus), close:mutate(close), shutdown, suspend:mutate(suspend), cancelSetup:mutate(cancelSetup), finishSetupCleanup:mutate(finishSetupCleanup), watch, inspectLegacy};
}

export const coordinatorHosting = (directory, api) => createHosting({directory,owner:'faravan-coordinator',api});
export function chatgptHosting(directory, api) {
  const privateDirectory = ensureDurableDirectory(path.join(directory,'ce'),{base:directory});
  return createHosting({directory:privateDirectory,owner:'faravan-chatgpt',api});
}
/** The member's own exposure scope: its route, owner and operation never overlap the coordinator, tray or ChatGPT gateway. */
export function memberHosting(directory, api) {
  const privateDirectory = ensureDurableDirectory(path.join(directory,'me'),{base:directory});
  return createHosting({directory:privateDirectory,owner:'faravan-member',api});
}
