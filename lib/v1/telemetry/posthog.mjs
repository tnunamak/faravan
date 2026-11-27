// One mapping per validated catalog record. Internal diagnostic identifiers never become Cloud properties.
import {createHash} from 'node:crypto';
import {installUuid} from './ids.mjs';
import {CATALOG,SCHEMA_VERSION,parseRecord,snapshot,TelemetrySchemaError} from './catalog.mjs';
import {FACT_SCHEMAS,parseFact,parseProperties} from './contract.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid=()=>{throw new TelemetrySchemaError('invalid_queue_record');};
/** Validate the private queue envelope as well as its public property schema. */
export function parseQueuedRecord(input,{schemaVersion=SCHEMA_VERSION}={}) {
 const raw=snapshot(input), {_posthog,...record}=raw;
 let wire;
 if(Object.hasOwn(FACT_SCHEMAS,record.name)) {
  if(Object.keys(record).some(key=>!['name','properties','origin'].includes(key)))invalid();
  if(!['app','ui','phone'].includes(record.origin))invalid();
  wire={name:record.name,properties:parseFact(record.name,record.properties),origin:record.origin};
 } else wire=parseRecord(record,{origin:record.origin??CATALOG.entries[record.name]?.origins[0]??'app',schemaVersion});
 if(_posthog!==undefined) {
  if(!_posthog || Object.keys(_posthog).sort().join(',')!=='surface,timestamp,uuid' || !UUID.test(_posthog.uuid))invalid();
  const timestamp=_posthog.timestamp;
  if(typeof timestamp!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp))invalid();
  const parsedTime=Date.parse(timestamp);
  if(!Number.isFinite(parsedTime) || new Date(parsedTime).toISOString()!==timestamp)invalid();
  parseProperties({surface:_posthog.surface},{surface:{values:CATALOG.enums.surface.map(item=>item.value)}});
  wire._posthog=_posthog;
 }
 return wire;
}
function timestampOf(record,at) {
  const period=record.hour??record.period;
  if(!period)return new Date(at).toISOString();
  return new Date(period.length===13 ? period+':00:00Z' : period+'T00:00:00Z').toISOString();
}
/** Stamp once, before disk append; retries and recovery reuse these bytes. */
export function stampRecord(record,{at=Date.now(),bytes,surface=record.attrs?.surface??record.origin??'background'}={}) {
  return {...record,_posthog:record._posthog??{
    uuid:installUuid(bytes),timestamp:timestampOf(record,at),surface:['app','crash'].includes(surface)?'background':surface,
  }};
}
export function catalogToPosthog(input,{installId,version,surface,schemaVersion=SCHEMA_VERSION}={}) {
 const record=parseQueuedRecord(input,{schemaVersion}), entry=CATALOG.entries[record.name];
 const properties=entry?{...record.attrs,...Object.fromEntries(['value','buckets','counts','duration_ms','status','period','hour'].filter(key=>record[key]!==undefined).map(key=>[key,record[key]]))}:record.properties;
 // Legacy unstamped queues are migration-purged; the deterministic fallback supports standalone catalog inspection.
 const hash=createHash('sha256').update(JSON.stringify(record)).digest('hex');
 const uuid=record._posthog?.uuid??`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
 const period=record.hour??record.period;
 return {event:record.name,distinct_id:installId,uuid,timestamp:record._posthog?.timestamp??new Date(period?(period.length===13?period+':00:00Z':period+'T00:00:00Z'):0).toISOString(),
  properties:{...properties,schema_version:schemaVersion,app_version:version,surface:surface??record._posthog?.surface??record.attrs?.surface??record.origin??'background',$geoip_disable:true}};
}
