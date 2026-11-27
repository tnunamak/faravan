import {PostHog} from 'posthog-js/dist/module.no-external';
import 'posthog-js/dist/posthog-recorder';
import {createBrowserTelemetry,createBrowserTransport,guardRecorder} from './posthog.mjs';
let browser;
let storage;try{storage=globalThis.localStorage;}catch{}
const transport=createBrowserTransport({storage,onReplayLimit:()=>browser?.stopReplay?.()});
const extensions=globalThis.__PosthogExtensions__;
extensions.rrweb.record=guardRecorder(extensions.rrweb.record,transport);
browser=createBrowserTelemetry({sdk:new PostHog(),createSdk:()=>new PostHog(),transport,storage});
export const browserTelemetry=browser;
