// Pinned SDK adapter. All SDK requests, including config and replay, cross this
// boundary before encoding. No SDK retry/batch queue or offline replay store.
import {TELEMETRY_ENABLED} from '../../../lib/v1/telemetry/contract.mjs';
import {ROUTES} from './helpers.mjs';
export const PROJECT_TOKEN = 'phc_nFhRBipngqr9ptSzJnSuCJTD4xAvrCHQiLbvmZPEBUY6';
export const INGEST_HOST = 'https://us.i.posthog.com';
export const CONFIG_URL = 'https://us-assets.i.posthog.com/array/' + PROJECT_TOKEN + '/config';
export const LIMITS = Object.freeze({eventsPerMinute:60,pendingBytes:1<<20,replayBytes:10<<20,replayActiveMs:15*60*1000});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCREENS = new Set(Object.keys(ROUTES));
const FLOWS=new Set(['borrowing','lending']),STEPS=new Set(['ready','joined','reviewed','useful','sandboxes','docker_signin','agent','isolation','check','circle','platform','codex_signin','claude_signin','complete']),SECTIONS=new Set(['setup-details','getting-started-example']);
const CONTROLS = new Set(['open-search','open-profile']);
export const PRIVATE_SELECTOR = '.ph-no-capture, [data-telemetry-private],img,svg,canvas,video,iframe,title,input[type="file"]';
const SAFE_URL = 'https://faravan.invalid/';
const bytes = value => new TextEncoder().encode(value).byteLength;

/** Rebuild properties, never forward the SDK's URL, title, DOM or person data. */
export function sanitizeEvent(event, installId, device = 'local') {
  if (!event || !['$pageview','$autocapture','$snapshot','screen_engagement','help_viewed','onboarding_step_changed'].includes(event.event)) return null;
  const raw = event.properties || {}, properties = {token:PROJECT_TOKEN,distinct_id:installId,$geoip_disable:true,$process_person_profile:true,surface:'ui',schema_version:1,device_class:device === 'paired' ? 'paired' : 'local'};
  for (const key of ['$session_id','$window_id']) if (UUID.test(raw[key] || '')) properties[key] = raw[key];
  for (const key of ['screen','from_screen']) if (SCREENS.has(raw[key])) properties[key] = raw[key];
  if(FLOWS.has(raw.flow))properties.flow=raw.flow;
  if(STEPS.has(raw.step))properties.step=raw.step;
  if(['entered','exited'].includes(raw.state))properties.state=raw.state;
  if(SECTIONS.has(raw.section_id))properties.section_id=raw.section_id;
  if(Number.isFinite(raw.elapsed_active_ms))properties.elapsed_active_ms=Math.max(0,Math.min(86400000,Math.round(raw.elapsed_active_ms)));
  if (CONTROLS.has(raw.control)) properties.control = raw.control;
  if (event.event === '$autocapture' && !properties.control) return null;
  if (Number.isFinite(raw.visible_focused_ms)) properties.visible_focused_ms = Math.min(86400000,Math.max(0,Math.round(raw.visible_focused_ms)));
  if (event.event === '$snapshot') {
    if (!Array.isArray(raw.$snapshot_data)) return null;
    properties.$snapshot_data = raw.$snapshot_data;
    if (Number.isFinite(raw.$snapshot_bytes)) properties.$snapshot_bytes = raw.$snapshot_bytes;
  }
  return {event:event.event,properties,...(UUID.test(event.uuid || '') ? {uuid:event.uuid} : {}),...(event.timestamp ? {timestamp:event.timestamp} : {})};
}

export function posthogConfig(installId, beforeSend) {
  return {
    api_host:INGEST_HOST,bootstrap:{distinctID:installId,isIdentifiedID:false},person_profiles:'always',
    persistence:'memory',disable_persistence:true,opt_out_capturing_persistence_type:'localStorage',
    capture_pageview:false,capture_pageleave:false,capture_dead_clicks:false,rageclick:false,
    autocapture:{dom_event_allowlist:['click'],css_selector_allowlist:['[data-telemetry-control]'],css_selector_ignorelist:['.ph-no-capture','[data-telemetry-private]'],capture_copied_text:false},
    mask_all_text:true,mask_all_element_attributes:true,
    disable_external_dependency_loading:true,enable_site_apps:false,disable_surveys:true,disable_surveys_automatic_display:true,disable_web_experiments:true,
    enable_heatmaps:false,enable_recording_console_log:false,capture_performance:false,capture_exceptions:false,capture_console:false,
    advanced_disable_feature_flags:true,advanced_disable_feature_flags_on_first_load:true,advanced_disable_toolbar_metrics:true,
    save_campaign_params:false,save_referrer:false,disable_capture_url_hashes:true,get_current_url:()=>SAFE_URL,
    request_batching:false,disable_compression:true,before_send:beforeSend,
    session_recording:{sampleRate:1,maskAllInputs:true,maskTextSelector:'*',maskTextFn:()=> '***',maskInputFn:()=> '***',maskAllElementAttributes:true,
      blockSelector:PRIVATE_SELECTOR,recordCrossOriginIframes:false,inlineStylesheet:false,inlineImages:false,collectFonts:false,recordHeaders:false,recordBody:false,
      captureCanvas:{enabled:false},recordConsole:false,recordNetwork:false,compress_events:false,
      maskCapturedNetworkRequestFn:()=>({name:SAFE_URL,url:SAFE_URL})},
  };
}

/** No retries: drop on failure/offline. Reserve bytes until fetch completes. */
export function createBrowserTransport({fetcher=globalThis.fetch,now=Date.now,online=()=>globalThis.navigator?.onLine !== false,onReplayLimit=()=>{},storage=null} = {}) {
  let replayBufferedBytes=0;
  let allowed=false,pending=0,windowStart=0,events=0,day=-1,replayBytes=0;
  const controllers=new Set();
  const resetDay=()=>{const next=Math.floor(now()/86400000);if(next!==day){day=next;replayBytes=0;}try{const saved=JSON.parse(storage?.getItem('faravan-replay-cap')||'null');if(saved?.day===day && Number.isFinite(saved.bytes))replayBytes=Math.max(replayBytes,saved.bytes);}catch{}};
  return {
    setAllowed(value){allowed=value;},
    reserveReplay(event){
      if(!allowed)return false;
      let size;try{size=bytes(JSON.stringify(event))+1;}catch{return false;}
      if(pending+replayBufferedBytes+size+4096>LIMITS.pendingBytes)return false;
      replayBufferedBytes+=size;return true;
    },
    get pendingBytes(){return pending;},
    stop(){allowed=false;replayBufferedBytes=0;for(const controller of controllers)controller.abort();controllers.clear();},
    send(options) {
      if(!allowed || !online())return;
      const config=options.url===CONFIG_URL && options.method==='GET';
      const ingest=options.method==='POST' && [INGEST_HOST+'/i/v0/e/',INGEST_HOST+'/e/',INGEST_HOST+'/s/'].includes(options.url.split('?')[0]);
      if(!config && !ingest)return;
      const data=options.data,records=Array.isArray(data)?data:[data];
      const replay=ingest && records.some(record=>record?.event==='$snapshot');
      let body;try{body=ingest?JSON.stringify(data):undefined;}catch{return;}
      const size=body?bytes(body):0;
      if(replay){
        const released=records.reduce((total,record)=>{const snapshots=record?.properties?.$snapshot_data;return total+(Array.isArray(snapshots)?snapshots.reduce((sum,event)=>sum+bytes(JSON.stringify(event))+1,0):0);},0);
        replayBufferedBytes=Math.max(0,replayBufferedBytes-released);
      }
      if(pending+size+replayBufferedBytes>LIMITS.pendingBytes)return;
      if(ingest && !replay){if(now()-windowStart>=60000){windowStart=now();events=0;}if(events+records.length>LIMITS.eventsPerMinute)return;events+=records.length;}
      if(replay){resetDay();if(replayBytes+size>LIMITS.replayBytes){onReplayLimit();return;}replayBytes+=size;try{storage?.setItem('faravan-replay-cap',JSON.stringify({day,bytes:replayBytes}));}catch{}}
      const controller=new AbortController();controllers.add(controller);pending+=size;
      const timeout=setTimeout(()=>controller.abort(),5000);
      // No sendBeacon: it cannot be aborted on a policy change.
      let request;try{request=fetcher(options.url,{method:options.method,body,credentials:'omit',referrerPolicy:'no-referrer',headers:ingest?{'Content-Type':'application/json'}:undefined,signal:controller.signal});}catch{request=Promise.reject();}
      Promise.resolve(request).then(async response=>{
        let json;try{json=await response.json();}catch{}
        if(allowed && !controller.signal.aborted)options.callback?.({statusCode:response.status,json});
      }).catch(()=>{}).finally(()=>{clearTimeout(timeout);pending-=size;controllers.delete(controller);});
    },
  };
}

/** Consent/identity belongs to the app; SDK state never grants permission. */
export function createBrowserTelemetry({sdk,transport,now=Date.now,document=globalThis.document,device='local',storage=null,createSdk=null,enabled=TELEMETRY_ENABLED} = {}) {
  let version=null,step=null,stepMs=0;
  let state=null,initialized=false,allowed=false,connected=false,screen=null,focusedMs=0,activeAt=now(),activeMs=0,replayStopped=false,day=-1,epoch=0;
  const discardReplay=()=>{if(initialized){sdk.sessionRecording?.dispose?.({discardBufferedEvents:true});sdk.stopSessionRecording();}};
  const replayStop=()=>{discardReplay();replayStopped=true;};
  const stop=()=>{epoch++;allowed=false;focusedMs=0;stepMs=0;activeAt=now();transport.stop();if(initialized){discardReplay();sdk.opt_out_capturing({clear_persistence:true});Promise.resolve(sdk.shutdown?.()).catch(()=>{});initialized=false;}};
  const capture=(name,properties)=>{if(allowed)sdk.capture(name,properties);};
  const page=next=>{if(!SCREENS.has(next))return;if(next===screen)return;const previous=screen;if(allowed && previous)capture('screen_engagement',{screen:previous,visible_focused_ms:focusedMs});screen=next;focusedMs=0;if(allowed)capture('$pageview',{screen:next,...(previous?{from_screen:previous}:{})});};
  return {
    stop,page,stopReplay:replayStop,
    captureAllowed:()=>allowed,
    version(value){version=typeof value==='string' && /^\d+\.\d+\.\d+(?:-preview\.\d{8}\.\d+)?$/.test(value)?value:null;},
    device(value){device=value==='paired'?'paired':'local';},
    connection(value){connected=value===true;if(!connected)stop();},
    bootstrap(next){
      const valid=enabled && globalThis.navigator?.globalPrivacyControl!==true && connected && next?.consent==='on' && next.remoteEnabled===true && next.noticePending===false && UUID.test(next.installId||'');
      if(!valid){state=next;stop();return;}
      if(initialized && (next.installId!==state?.installId || next.generation!==state?.generation)){stop();}
      state=next;
      if(allowed)return;
      focusedMs=0;stepMs=0;activeAt=now();
      allowed=true;transport.setAllowed(true);
      if(!initialized){
        if(createSdk)sdk=createSdk();
        // These two pinned-SDK entry points cover JSON config and all capture paths.
        // Replacing both keeps the SDK retry queue out of the transport entirely.
        const sdkEpoch=epoch;
        sdk._send_request=options=>{if(allowed && sdkEpoch===epoch)transport.send(options);};sdk._send_retriable_request=sdk._send_request;
        const config=posthogConfig(next.installId,event=>{
          if(!allowed || sdkEpoch!==epoch || (replayStopped && event.event==='$snapshot'))return null;
          const clean=sanitizeEvent(event,state.installId,device);
          if(clean)clean.properties.app_version=version;
          return clean;
        });
        config.disable_session_recording=replayStopped || activeMs>=LIMITS.replayActiveMs || next.recordings!==true;
        sdk.init(PROJECT_TOKEN,config);initialized=true;sdk.opt_in_capturing?.({captureEventName:false});
      }else{sdk.opt_in_capturing({captureEventName:false});if(!replayStopped && next.recordings===true)sdk.startSessionRecording();}
      if(screen)capture('$pageview',{screen});
      if(step)capture('onboarding_step_changed',{...step,state:'entered',elapsed_active_ms:0});
    },
    onboarding(next){
      if(!next || !FLOWS.has(next.flow) || !STEPS.has(next.step))next=null;
      if(next?.flow===step?.flow && next?.step===step?.step)return;
      if(step)capture('onboarding_step_changed',{...step,state:'exited',elapsed_active_ms:stepMs});
      step=next;stepMs=0;if(step)capture('onboarding_step_changed',{...step,state:'entered',elapsed_active_ms:0});
    },
    help(section){if(SECTIONS.has(section))capture('help_viewed',{screen,section_id:section});},
    click(target){
      if(!allowed || !target?.closest)return;
      const control=target.closest('[data-telemetry-control]');
      if(!control || control.closest('.ph-no-capture,[data-telemetry-private]') || !CONTROLS.has(control.dataset.telemetryControl))return;
      capture('$autocapture',{screen,control:control.dataset.telemetryControl});
    },
    tick(){
      const at=now(),today=Math.floor(at/86400000);if(today!==day){const resume=replayStopped && day!==-1;day=today;activeMs=0;replayStopped=false;if(resume && allowed && state?.recordings===true){sdk.set_config?.({disable_session_recording:false});sdk.startSessionRecording?.();}}
      try{const saved=JSON.parse(storage?.getItem('faravan-replay-active')||'null');if(saved?.day===day && Number.isFinite(saved.ms))activeMs=Math.max(activeMs,saved.ms);}catch{}
      if(allowed && document?.visibilityState==='visible' && document.hasFocus()){const elapsed=Math.max(0,Math.min(5000,at-activeAt));activeMs+=elapsed;focusedMs+=elapsed;if(step)stepMs+=elapsed;}activeAt=at;
      try{storage?.setItem('faravan-replay-active',JSON.stringify({day,ms:activeMs}));}catch{}
      if(activeMs>=LIMITS.replayActiveMs && !replayStopped)replayStop();
    },
    engagement(){if(allowed && screen)capture('screen_engagement',{screen,visible_focused_ms:focusedMs});focusedMs=0;},
    get epoch(){return epoch;},
  };
}

// Intercept rrweb's public emit callback before the SDK buffers or encodes it.
// This works with the pinned, minified recorder without private method names.
export function guardRecorder(record, transport) {
  const guarded=options=>record({...options,emit(event,...args){
    if(transport.reserveReplay(event))options.emit(event,...args);
  }});
  return Object.assign(guarded,record);
}
