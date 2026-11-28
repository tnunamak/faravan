// This schema is also the export allowlist. No free text or open objects belong here.
import {FAILURE_CODES} from './failures.mjs';

const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const choice = values => ({type:['string','null'], enum:[...values, null]});
const boolean = {type:['boolean','null']};
const number = (maximum = 2147483647) => ({type:['number','null'], minimum:0, maximum});
const integer = (maximum = 2147483647) => ({...number(maximum), type:['integer','null']});
const list = (items, maxItems) => ({type:'array', items, maxItems});
const pattern = (pattern, maxLength) => ({type:['string','null'], pattern, maxLength});
const version = pattern('^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}(-preview\\.[0-9]{8}\\.[0-9]{1,4})?$', 40);
const instant = pattern('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$', 24);
// Random references relate rows within this export, never to coordinator job IDs.
const jobAlias = pattern('^job:[0-9a-f]{32}$', 36);
const source = choice(['ok','missing','unreadable','too_large','unsafe_path','partial']);
const providers = value => object({claude:value, codex:value});
const errorCode = choice(FAILURE_CODES);
const state = choice(['queued','claimed','result-accepted','completed','failed','cancelled','expired','released',
  'waiting','accepted','denied','idle','running','preparing','starting','stopping','stopped','paused','off','on',
  'waiting_for_sandbox','awaiting-approval','sending-result','result-unconfirmed','finished','limit-reached','reserve','declined']);

export const SUPPORT_LIMITS = Object.freeze({archiveBytes:128 * 1024, jsonBytes:120 * 1024,
  storeBytes:256 * 1024, tailBytes:256 * 1024, events:50, errors:50, jobs:30});

export const SUPPORT_READINESS_SCHEMA = object({
  observed_at:instant, ready:boolean, backend_id:choice(['docker-sbx']), sbx_version:version,
  version_compatible:boolean,
  checks:list(object({name:choice(['sbx_install','sbx_version','sbx_cli_contract','docker_runtime','sbx_daemon',
    'kvm_access','docker_login','network_policy','sbx_credential_store','socket_path_length','hypervisor_platform',
    'test_workspace','sandbox','v1_limits','sbx_keychain']), ok:boolean}), 24),
});

export const SUPPORT_SCHEMA = {
  $schema:'https://json-schema.org/draft/2020-12/schema',
  title:'Faravan support export',
  ...object({
    schema_version:{type:'integer', const:1},
    runtime:object({app:version, node:version, tray:version, os:choice(['linux','darwin','win32']),
      arch:choice(['x64','arm64','ia32','arm','riscv64']), os_release:pattern('^[0-9]{1,4}(\\.[0-9]{1,4}){1,3}$', 24)}),
    install:object({kind:choice(['apt','brew','faravan','development','msix']), channel:choice(['stable','preview'])}),
    settings:object({enabled:boolean, intent:choice(['on','off']), paused:boolean, pause_until:integer(4102444800000),
      joinMode:choice(['ask','auto']), learnFromLocalAgentLogs:boolean, agents:providers(boolean),
      limits:object({dailyJobs:integer(), dailyMinutes:integer(), maxWallSeconds:integer(), quotaReserve:number(100), idleOnly:boolean,
        lendingPolicy:object({strategy:choice(['automatic','fixed_share','custom']),
          protectionPosition:choice(['keep_more_for_me','balanced','share_more']),
          strategyParams:object({perJobPct:number(100), fixedSharePct:number(100), keepPct:number(100), e0:number(1)}),
          warningPct:number(100), effortMax:choice(['low','medium','high','xhigh','max']), allowFast:boolean, stopOnReturn:boolean,
          machineSlots:integer(32), accountSlots:integer(3), probeMinutes:integer(120), providerConsent:providers(boolean),
          accountPlans:providers(choice(['unknown','pro','max5','max20','plus','business','team']))})})}),
    lending:object({state, observed_at:instant}),
    readiness:SUPPORT_READINESS_SCHEMA,
    events:list(object({at:instant, type:choice(['job','approval','lending','lending-action','agents','attention']), job:jobAlias, state, code:errorCode}), SUPPORT_LIMITS.events),
    errors:list(object({at:instant, job:jobAlias, code:errorCode,
      phase:choice(['before_claim','before_start','prepare','start','run','result'])}), SUPPORT_LIMITS.errors),
    jobs:list(object({id:jobAlias, state, observed_at:instant}), SUPPORT_LIMITS.jobs),
    sources:object({settings:source, readiness:source, events:source, errors:source,
      app_version:source, install_kind:source}),
  }),
};
