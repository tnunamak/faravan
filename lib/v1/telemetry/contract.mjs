/** Frozen server/browser hand-off. The app mounts GET /api/telemetry/bootstrap behind normal app authentication.
 * No caller supplies identity. The UI posts {level:'on'|'off'} to the existing /api/telemetry/choose route.
 * observeFact(name, properties, {surface, off, headers}) is synchronous, never throws, and returns acceptance.
 * Missing facts stay absent/null; unknown keys and values are rejected, never coerced to free text.
 */
import { CATALOG, snapshot, TelemetrySchemaError } from './catalog.mjs';
import publicModels from './public-models.json' with {type:'json'};
export const CONSENT_SETTING = Object.freeze({key:'level', values:Object.freeze(['on','off'])});
export const BOOTSTRAP_ROUTE = '/api/telemetry/bootstrap';
export const POSTHOG_HOST = 'https://us.i.posthog.com';
export const POSTHOG_TOKEN = 'phc_nFhRBipngqr9ptSzJnSuCJTD4xAvrCHQiLbvmZPEBUY6';
/** Emergency build switch. When false neither capture nor any PostHog request is permitted. */
export const TELEMETRY_ENABLED = true;
const en = (...values) => Object.freeze({values:values.flat()});
const registry = name => en(CATALOG.enums[name].map(item=>item.value));
const num = max => Object.freeze({min:0,max});
const bool = Object.freeze({boolean:true});
const nullable = type => Object.freeze({...type,nullable:true});
const ms = num(2**31-1), count = num(1000000);
export const PUBLIC_MODELS = Object.freeze(publicModels);
/** Callers normalize custom model names before observation. Absent evidence remains null. */
export const publicModel = value => value == null ? null : PUBLIC_MODELS.includes(value) ? value : 'custom';
const model = nullable(en(PUBLIC_MODELS));
const provider = nullable(registry('provider')), harness = nullable(registry('harness')), effort = nullable(registry('effort'));
const job = {requested_provider:provider,requested_harness:harness,requested_model:model,requested_effort:effort};
const lifecycle = {uptime_ms:ms,lending_on:bool,gap_ms:ms,clean:bool,gap_reason:en('unknown')};
/** Person property keys only; optional values are checked by the same closed parser as facts. */
export const PERSON_PROPERTIES = Object.freeze({os_type:en('linux','darwin','windows','other'),os_major:num(999),arch:en('amd64','arm64','other'),
  cpu_class:en('intel','amd','apple','arm','other'),ram_bucket:en('4','8','16','32','64','128','256','inf'),docker_present:bool,
  docker_version:{version:true},app_version:{version:true},provider,plan:registry('plan'),claude_plan:registry('plan'),codex_plan:registry('plan'),subscription_source:en('user_selected'),subscription_verified:en(false),surfaces_used:{list:registry('surface'),max:9}});
/** Every key is optional unless the producer knows it. Explicit null is allowed only on evidence fields. */
export const FACT_SCHEMAS = Object.freeze({
 onboarding_step_changed:{step:en('hypervisor','kvm'),outcome:en('entered','completed','skipped','failed'),duration_ms:{...ms,integer:true},surface:registry('surface')},
 job_requested:job,
 job_execution_finished:{...job,executed_provider:provider,executed_harness:harness,executed_model:model,executed_effort:effort,role:registry('job_role'),outcome:registry('job_outcome'),duration_ms:ms,stop_reason:nullable(registry('stop_reason')),model_source:en('execution_report','unknown')},
 account_plan_observed:{provider,plan:registry('plan'),source:en('user_selected'),subscription_verified:en(false)},
 system_profile_observed:{available_parallelism:num(4096),total_ram_gib:num(1048576),os_type:PERSON_PROPERTIES.os_type,os_major:num(999),arch:PERSON_PROPERTIES.arch,cpu_class:PERSON_PROPERTIES.cpu_class,docker_installed:bool,docker_running:bool,docker_signed_in:bool,docker_version:{version:true}},
 app_started:lifecycle,app_heartbeat:lifecycle,app_resumed:lifecycle,app_closed:lifecycle,
 ui_presence_changed:{visible:bool,browser_online:bool,app_connection_state:en('connected','connecting','disconnected')},
 operation_completed:{op:registry('op'),surface:registry('surface'),duration_ms:ms,ok:bool,error_code:nullable(registry('error_type'))},
 mcp_client_connected:{client_family:en('claude','codex','chatgpt','cursor','vscode','other'),client_version:{numericVersion:true},source:en('reported')},
 resource_constraints_observed:{strategy:registry('preset'),slots:count,available_slots:count,daily_jobs_left:count,daily_minutes_left:count,wall_cap_minutes:count,reserve_pct:num(100),idle_only:bool,schedule_enabled:bool,disk_free_bucket:en('1','5','10','50','100','500','inf'),money_cap:num(1000000)},
 admission_blocked:{reason:en(CATALOG.enums.offer_reason.map(item=>item.value),'busy'),resource:en('cpu','ram','disk','quota','slots','money','schedule','unknown'),provider,model,requested_cpu:num(4096),requested_ram_gib:num(1048576)},
});
const fail=()=>{throw new TelemetrySchemaError('invalid_fact');};
function valueOf(value,type) {
 if(value===null&&type.nullable)return null;
 if(type.values)return type.values.includes(value)?value:fail();
 if(type.boolean)return typeof value==='boolean'?value:fail();
 if(type.version)return typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-preview\.\d{8}\.\d{1,4})?$/.test(value)?value:fail();
 if(type.numericVersion)return typeof value==='string'&&/^\d{1,4}(?:\.\d{1,4}){0,3}$/.test(value)?value:fail();
 if(type.list)return Array.isArray(value)&&value.length<=type.max?value.map(item=>valueOf(item,type.list)):fail();
 return typeof value==='number'&&Number.isFinite(value)&&(!type.integer||Number.isInteger(value))&&value>=type.min&&value<=type.max?value:fail();
}
export function parseProperties(input,schema) {
 const value=snapshot(input);
 if(!value||Array.isArray(value)||typeof value!=='object')return fail();
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,Object.hasOwn(schema,key)?valueOf(item,schema[key]):fail()]));
}
/** Validate facts and optional $set; the app supplies all envelope metadata, never the caller. */
export function parseFact(name,input) {
 if(!Object.hasOwn(FACT_SCHEMAS,name))return fail();
 const schema=FACT_SCHEMAS[name];
 const value=snapshot(input), {$set,...properties}=value;
 return {...parseProperties(properties,schema),...($set===undefined?{}:{$set:parseProperties($set,PERSON_PROPERTIES)})};
}
/** Bootstrap JSON: {installId:string|null,consent:'on'|'off',generation:number,remoteEnabled:boolean,recordings:boolean,noticePending:boolean}.
 * Off is the safe default on setup failure. The app must apply request/GPC restrictions before returning this object.
 */
export const stoppedBootstrap = () => ({installId:null,consent:'off',generation:0,remoteEnabled:false,recordings:false,noticePending:false});
