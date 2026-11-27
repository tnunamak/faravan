import {AsyncLocalStorage} from 'node:async_hooks';
import * as runtime from '../../lib/sbx-runtime.mjs';
import * as commandDiagnostics from '../../lib/sandbox-command-diagnostic.mjs';
import {sandboxCommandDiagnostic} from '../../lib/sandbox-command-observation.mjs';
import {sbxChildEnv} from '../../lib/docker-backend.mjs';
import {DOCKER_SIGNED_OUT,DOCKER_SIGNIN_STATE_UNAVAILABLE} from '../../lib/v1/docker-state.mjs';
// A job context whose execution gate lets every launch through, so a test can exercise the transport fence on its own.
export function passThroughJobContext(){return new (class extends AsyncLocalStorage{getStore(){return {beforeExec:launch=>launch(),...super.getStore()};}})();}
export function transportPrelude(source){return source.slice(source.indexOf('export function spawnSbxChild('),source.indexOf('async function runSbx(')).replaceAll('export function ','function ').replaceAll('import.meta.url',JSON.stringify(new URL('../../lib/docker-backend.mjs',import.meta.url).href));}
export const transportGlobals={...runtime,...commandDiagnostics,sandboxCommandDiagnostic,performance,daemonJobContext:passThroughJobContext(),policyError:(code,message)=>Object.assign(new Error(message),{code}),DOCKER_SIGNED_OUT,DOCKER_SIGNIN_STATE_UNAVAILABLE,process,spawn(){throw new Error('Unexpected streaming transport');},execFile(){throw new Error('Unexpected buffered transport');},execFileCb(){throw new Error('Unexpected callback transport');},spawnSync(){throw new Error('Unexpected sync transport');}};
export {sbxChildEnv};
