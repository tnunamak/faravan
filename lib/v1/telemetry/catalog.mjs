// The telemetry catalog's one door: every record and every batch is checked here, by the app, the coordinator, the UI
// bundle and the backend alike. It validates against the generated catalog.json (scripts/gen-telemetry-catalog.mjs), which
// keeps the history of every enum member, so a record from an old client stays valid at its own schema version.
// There is no free string type: see entries.mjs. The wire rules are in docs/design/TELEMETRY-WIRE.md.
//
// A failure throws TelemetrySchemaError. Its code and path name only declared keys, never input, so a caller
// can answer with the code and echo nothing.
import catalogJson from './catalog.json' with {type: 'json'};

export const BATCH_SCHEMA = 'faravan-telemetry';
export const INBOX_FORMAT = 'faravan-telemetry-inbox';
export const STREAMS = Object.freeze(['counts', 'diagnostics', 'quota']);
export const MAX_RECORDS_PER_BATCH = 200;
export const MAX_INBOX_FILE_BYTES = 16 * 1024;
export const isGeneration = value => Number.isSafeInteger(value) && value >= 0;

// The release formats that packaging/build.sh and packaging/deb-version.sh produce, and no others: no free suffix.
export const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-preview\.\d{8}\.\d{1,4})?$/;
const MINOR_RE = /^\d{1,4}\.\d{1,4}$/;
export const ID_PATTERNS = Object.freeze({
  rid: /^r-[A-Z2-7]{20}$/, batch_id: /^b-[A-Z2-7]{20}$/, epoch: /^e-[A-Z2-7]{20}$/, session: /^s-[A-Z2-7]{20}$/, trace: /^t-[A-Z2-7]{20}$/,
});
const PERIOD_RE = {hour: /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/, day: /^(\d{4})-(\d{2})-(\d{2})$/};
// The service that uploads each record origin. ui, phone and crash records ride in the app's batches.
export const ORIGIN_SERVICE = Object.freeze({app: 'app', ui: 'app', phone: 'app', crash: 'app', tray: 'tray', installer: 'installer', coordinator: 'coordinator'});
export const INBOX_ORIGINS = Object.freeze(['tray', 'installer', 'coordinator', 'crash']);
const OS_TYPES = ['linux', 'darwin', 'windows'];
const ARCHES = ['amd64', 'arm64'];
const CHANNELS = ['stable', 'preview'];
const SPAN_STATUS = ['ok', 'error'];

export class TelemetrySchemaError extends Error {
  constructor(code, path = '') {
    super(path ? code + ' at ' + path : code);
    this.name = 'TelemetrySchemaError';
    this.code = code;
    this.path = path;
  }
}
const fail = (code, path) => { throw new TelemetrySchemaError(code, path); };

/** Release version -> {major, minor, patch, channel, minorVersion}, or null when it is not a release format. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION_RE.exec(text) : null;
  if (!match) return null;
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), channel: match[4] ? 'preview' : 'stable', minorVersion: match[1] + '.' + match[2]};
}
export const channelOf = text => parseVersion(text)?.channel ?? null;
export const minorOf = text => parseVersion(text)?.minorVersion ?? null;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const join = (path, key) => (path ? path + '.' : '') + key;

/** Deep-sorted copy: the canonical form of a record, and the bytes the golden files hold. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
export const canonicalJson = value => JSON.stringify(canonicalize(value));

const MAX_DEPTH = 8, MAX_NODES = 100000;
// Proxies are refused before any reflective call, because their traps are caller code. The check needs Node's host
// primitive; a browser has none, and its objects come from our own UI code.
const isProxy = globalThis.process?.getBuiltinModule?.('node:util')?.types?.isProxy ?? (() => false);
/**
 * A stable, plain copy of untrusted input. It reads own data properties only, once: proxies, accessors, symbols, array
 * extras, holes, prototypes and cycles are rejected, so no later step can see a different value or run caller code.
 * Every value visited is charged to one budget, so a wide or deep input is refused before it is copied.
 * Validation then works on this copy and never on the original.
 */
export function snapshot(value) {
  let budget = MAX_NODES;
  const charge = count => { if ((budget -= count) < 0) fail('too_large'); };
  const copy = (item, depth) => {
    charge(1);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : fail('bad_type');
    if (typeof item !== 'object' || isProxy(item)) fail('bad_type');
    if (depth > MAX_DEPTH) fail('too_large');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) fail('bad_type');
      charge(item.length);
      const names = Object.getOwnPropertyNames(item);
      if (names.length !== item.length + 1 || Object.getOwnPropertySymbols(item).length) fail('bad_type');
      const out = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('bad_type');
        out.push(copy(descriptor.value, depth + 1));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) fail('bad_type');
    if (Object.getOwnPropertySymbols(item).length) fail('bad_type');
    const out = Object.create(null);
    for (const name of Object.getOwnPropertyNames(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('bad_type');
      out[name] = copy(descriptor.value, depth + 1);
    }
    return out;
  };
  return copy(value, 0);
}

function validDate(year, month, day, hour = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24;
}
function checkPeriod(unit, value, path) {
  const match = typeof value === 'string' ? PERIOD_RE[unit].exec(value) : null;
  if (!match || !validDate(Number(match[1]), Number(match[2]), Number(match[3]), unit === 'hour' ? Number(match[4]) : 0)) fail('bad_period', path);
  return value;
}

/**
 * A validator bound to one catalog document. The module exports one bound to the shipped catalog.json; tests build
 * others (an owner enum that lost a member, for instance).
 */
export function createCatalog(catalog) {
  const schemaVersionOf = options => options?.schemaVersion ?? catalog.schema_version;
  const liveAt = (item, version) => item.since <= version && (item.until === undefined || version < item.until);
  const memberSets = new Map();
  function membersAt(enumName, version) {
    const key = enumName + '@' + version;
    // A value that was retired and later returned has one interval per stay; it is a member when any interval is live.
    if (!memberSets.has(key)) memberSets.set(key, new Set(catalog.enums[enumName].filter(member => liveAt(member, version)).map(member => member.value)));
    return memberSets.get(key);
  }
  const bucketSet = name => catalog.bucket_sets[name] ?? fail('bad_bucket_set', name);

  /** Bucket scalar: the smallest bound >= value (or its label); "inf" above an open set, the last bound for a closed one. */
  function bucket(name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('bucket needs a finite number');
    const set = bucketSet(name);
    const index = set.bounds.findIndex(bound => value <= bound);
    if (index < 0) return set.closed ? labelOf(set, set.bounds.length - 1) : 'inf';
    return labelOf(set, index);
  }
  const labelOf = (set, index) => set.labels?.[index] ?? String(set.bounds[index]);
  /** Histogram bin: the first bound >= value, else the overflow bin. */
  function bucketIndex(name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('bucket needs a finite number');
    const bounds = bucketSet(name).bounds;
    const index = bounds.findIndex(bound => value <= bound);
    return index < 0 ? bounds.length : index;
  }
  const bucketLabels = name => {
    const set = bucketSet(name);
    return new Set([...set.bounds.map((_, index) => labelOf(set, index)), ...(set.closed ? [] : ['inf'])]);
  };

  function checkValue(type, value, path, version) {
    switch (type.type) {
      case 'enum':
        if (typeof value !== 'string') fail('bad_type', path);
        if (!membersAt(type.enum, version).has(value)) fail('not_member', path);
        return value;
      case 'bool':
        if (typeof value !== 'boolean') fail('bad_type', path);
        return value;
      case 'int':
        return checkInt(value, type.min, type.max, path);
      case 'bucket':
        if (value === null && type.nullable) return null;
        if (typeof value !== 'string') fail('bad_type', path);
        if (!bucketLabels(type.set).has(value)) fail('not_member', path);
        return value;
      case 'version':
        if (typeof value !== 'string') fail('bad_type', path);
        if (!VERSION_RE.test(value)) fail('bad_version', path);
        return value;
      case 'list': {
        if (!Array.isArray(value)) fail('bad_type', path);
        if (value.length < type.min || value.length > type.max) fail('bad_length', path);
        return value.map((item, index) => checkValue(type.of, item, path + '[' + index + ']', version));
      }
      case 'record':
        return checkFields(type.fields, value, path, version);
      default:
        throw new Error('unknown catalog type ' + type.type);
    }
  }
  /** Exactly the declared keys: unknown keys are rejected, absent keys only when optional. */
  function checkFields(fields, object, path, version) {
    if (!isPlainObject(object)) fail('bad_type', path);
    for (const key of Object.keys(object)) if (!Object.hasOwn(fields, key)) fail('unknown_key', path);
    const out = {};
    for (const [key, type] of Object.entries(fields)) {
      if (!Object.hasOwn(object, key)) {
        if (type.optional) continue;
        fail('missing_key', join(path, key));
      }
      out[key] = checkValue(type, object[key], join(path, key), version);
    }
    return out;
  }
  const checkInt = (value, min, max, path) => {
    if (!Number.isInteger(value)) fail('bad_type', path);
    if (value < min || value > max) fail('out_of_range', path);
    return value;
  };
  const checkId = (kind, value, path) => {
    if (typeof value !== 'string' || !ID_PATTERNS[kind].test(value)) fail('bad_pattern', path);
    return value;
  };

  function entryFor(raw, version, origin) {
    if (!isPlainObject(raw)) fail('not_object');
    const entry = typeof raw.name === 'string' && Object.hasOwn(catalog.entries, raw.name) ? catalog.entries[raw.name] : null;
    if (!entry || !liveAt(entry, version)) fail('unknown_name');
    if (!entry.origins.includes(origin)) fail('wrong_origin');
    return entry;
  }
  // Top-level keys by kind, besides name, attrs and the optional origin. `identity` is the app-assigned part of a diagnostic.
  function topKeys(entry, identity) {
    const time = entry.period ? ['period'] : [];
    if (entry.kind === 'sum') return {required: [...time, 'value'], optional: []};
    if (entry.kind === 'histogram') return {required: [...time, 'buckets', 'counts'], optional: []};
    if (entry.kind === 'record') return {required: [], optional: []};
    const own = ['kind', 'hour', ...(entry.kind === 'span' ? ['duration_ms', 'status'] : [])];
    if (!identity) return {required: own, optional: []};
    const ids = ['rid', 'epoch', 'session', 'seq', ...(entry.kind === 'span' ? ['trace'] : [])];
    return {required: [...own, ...ids], optional: entry.kind === 'event' ? ['trace'] : []};
  }

  function parseBody(raw, {origin, schemaVersion}, identity) {
    const entry = entryFor(raw, schemaVersion, origin);
    const {required, optional} = topKeys(entry, identity);
    const allowed = new Set(['name', 'attrs', 'origin', ...required, ...optional]);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) fail('unknown_key');
    if (Object.hasOwn(raw, 'origin') && raw.origin !== origin) fail('wrong_origin', 'origin');
    for (const key of ['attrs', ...required]) if (!Object.hasOwn(raw, key)) fail('missing_key', key);

    const out = {name: raw.name, attrs: checkFields(entry.attrs, raw.attrs, 'attrs', schemaVersion)};
    if (Object.hasOwn(raw, 'origin')) out.origin = raw.origin;
    if (entry.period) out.period = checkPeriod(entry.period, raw.period, 'period');
    if (entry.kind === 'sum') {
      if (!Number.isInteger(raw.value)) fail('bad_type', 'value');
      if (raw.value < 1 || raw.value > entry.maxPerPeriod) fail('out_of_range', 'value');
      out.value = raw.value;
    } else if (entry.kind === 'histogram') {
      const set = bucketSet(entry.buckets);
      if (raw.buckets !== entry.buckets) fail('not_member', 'buckets');
      if (!Array.isArray(raw.counts) || raw.counts.length !== set.bounds.length + 1) fail('bad_length', 'counts');
      if (!raw.counts.every(count => Number.isInteger(count) && count >= 0)) fail('bad_type', 'counts');
      const total = raw.counts.reduce((sum, count) => sum + count, 0);
      if (total < 1 || total > entry.maxPerPeriod) fail('out_of_range', 'counts');
      out.buckets = raw.buckets;
      out.counts = raw.counts;
    } else if (entry.kind !== 'record') {
      if (raw.kind !== entry.kind) fail('not_member', 'kind');
      out.kind = raw.kind;
      out.hour = checkPeriod('hour', raw.hour, 'hour');
      if (entry.kind === 'span') {
        out.duration_ms = checkInt(raw.duration_ms, 0, 2 ** 31 - 1, 'duration_ms');
        if (typeof raw.status !== 'string' || !SPAN_STATUS.includes(raw.status)) fail('not_member', 'status');
        out.status = raw.status;
      }
      if (identity) {
        for (const key of ['rid', 'epoch', 'session', 'trace']) if (Object.hasOwn(raw, key)) out[key] = checkId(key, raw[key], key);
        out.seq = checkInt(raw.seq, 0, 2 ** 31 - 1, 'seq');
      }
    }
    return canonicalize(out);
  }

  /**
   * A wire record (what a batch holds) -> the validated record in canonical key order.
   * `origin` is the record's origin: the caller derives it from the batch (parseEnvelope does).
   */
  function parseRecord(raw, options) {
    return parseBody(snapshot(raw), {origin: options?.origin, schemaVersion: schemaVersionOf(options)}, true);
  }

  /** One inbox file (a producer outside the app process), as text or parsed JSON. */
  function parseInboxFile(input) {
    if (typeof input === 'string' && Buffer.byteLength(input) > MAX_INBOX_FILE_BYTES) fail('too_large');
    let raw = input;
    if (typeof input === 'string') {
      try { raw = JSON.parse(input); } catch { fail('bad_json'); }
    } else raw = snapshot(input);
    if (!isPlainObject(raw)) fail('not_object');
    for (const key of Object.keys(raw)) if (!['format', 'schema_version', 'origin', 'gen', 'capture', 'record'].includes(key)) fail('unknown_key');
    if (raw.format !== INBOX_FORMAT) fail('not_member', 'format');
    if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1 || raw.schema_version > catalog.schema_version) fail('out_of_range', 'schema_version');
    if (typeof raw.origin !== 'string' || !INBOX_ORIGINS.includes(raw.origin)) fail('wrong_origin', 'origin');
    if (!isGeneration(raw.gen)) fail('out_of_range', 'gen');
    if(raw.capture!==undefined) {
      if(!isPlainObject(raw.capture) || Object.keys(raw.capture).sort().join(',')!=='captured_at,lease_id' ||
        typeof raw.capture.lease_id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.capture.lease_id) ||
        !Number.isSafeInteger(raw.capture.captured_at) || raw.capture.captured_at<0)fail('bad_capture');
    }
    const record = parseBody(raw.record, {origin: raw.origin, schemaVersion: raw.schema_version}, false);
    return {origin: raw.origin, gen: raw.gen, ...(raw.capture?{capture:raw.capture}:{}), schemaVersion: raw.schema_version, record};
  }

  function checkResource(stream, resource, version) {
    if (!isPlainObject(resource)) fail('bad_type', 'resource');
    if (stream === 'quota') {
      // No service name, OS, arch or full version: a preview version carries its build date. The origin is implied (app).
      for (const key of Object.keys(resource)) if (!['service.version_minor', 'deployment.environment.name'].includes(key)) fail('unknown_key', 'resource');
      if (typeof resource['service.version_minor'] !== 'string' || !MINOR_RE.test(resource['service.version_minor'])) fail('bad_version', 'resource.service.version_minor');
      if (!CHANNELS.includes(resource['deployment.environment.name'])) fail('not_member', 'resource.deployment.environment.name');
      return {service: 'app', resource: canonicalize(resource)};
    }
    const keys = ['service.name', 'service.version', 'deployment.environment.name', 'os.type', 'host.arch', 'os.major'];
    for (const key of Object.keys(resource)) if (!keys.includes(key)) fail('unknown_key', 'resource');
    for (const key of keys.slice(0, 5)) if (!Object.hasOwn(resource, key)) fail('missing_key', 'resource.' + key);
    if (!Object.keys(ORIGIN_SERVICE).some(origin => ORIGIN_SERVICE[origin] === resource['service.name'])) fail('not_member', 'resource.service.name');
    if (!parseVersion(resource['service.version'])) fail('bad_version', 'resource.service.version');
    if (resource['deployment.environment.name'] !== channelOf(resource['service.version'])) fail('not_member', 'resource.deployment.environment.name');
    if (!OS_TYPES.includes(resource['os.type'])) fail('not_member', 'resource.os.type');
    if (!ARCHES.includes(resource['host.arch'])) fail('not_member', 'resource.host.arch');
    if (Object.hasOwn(resource, 'os.major')) {
      if (resource['os.type'] !== 'darwin') fail('unknown_key', 'resource');
      if (!Number.isInteger(resource['os.major']) || resource['os.major'] < 10 || resource['os.major'] > 99) fail('out_of_range', 'resource.os.major');
    }
    return {service: resource['service.name'], resource: canonicalize(resource)};
  }

  /**
   * A batch as uploaded. One stream per batch; a quota batch holds exactly one record. Each record is parsed at the
   * batch's schema version with its origin: the record's own `origin`, else the batch's service. Counts cells must be unique.
   */
  function parseEnvelope(input) {
    const raw = snapshot(input);
    if (!isPlainObject(raw)) fail('not_object');
    for (const key of Object.keys(raw)) if (!['schema', 'schema_version', 'batch_id', 'stream', 'resource', 'records'].includes(key)) fail('unknown_key');
    if (raw.schema !== BATCH_SCHEMA) fail('not_member', 'schema');
    if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1 || raw.schema_version > catalog.schema_version) fail('out_of_range', 'schema_version');
    checkId('batch_id', raw.batch_id, 'batch_id');
    if (!STREAMS.includes(raw.stream)) fail('not_member', 'stream');
    const {service, resource} = checkResource(raw.stream, raw.resource, raw.schema_version);
    if (!Array.isArray(raw.records)) fail('bad_type', 'records');
    if (raw.records.length < 1 || raw.records.length > (raw.stream === 'quota' ? 1 : MAX_RECORDS_PER_BATCH)) fail('bad_length', 'records');
    const cells = new Set();
    const records = raw.records.map((record, index) => {
      const origin = isPlainObject(record) && Object.hasOwn(record, 'origin') ? record.origin : service;
      if (typeof origin !== 'string' || ORIGIN_SERVICE[origin] !== service) fail('wrong_origin', 'records[' + index + ']');
      // A record of another stream is a stream error whatever its attributes say, so the stream is checked before them.
      const named = isPlainObject(record) && typeof record.name === 'string' && Object.hasOwn(catalog.entries, record.name) ? catalog.entries[record.name] : null;
      if (named && named.stream !== raw.stream) fail('stream_mismatch', 'records[' + index + ']');
      let parsed;
      try { parsed = parseBody(record, {origin, schemaVersion: raw.schema_version}, true); } catch (error) {
        if (error instanceof TelemetrySchemaError) fail(error.code, 'records[' + index + ']' + (error.path ? '.' + error.path : ''));
        throw error;
      }
      if (catalog.entries[parsed.name].stream !== raw.stream) fail('stream_mismatch', 'records[' + index + ']');
      if (raw.stream === 'counts') {
        const cell = parsed.name + '|' + parsed.period + '|' + canonicalJson(parsed.attrs);
        if (cells.has(cell)) fail('duplicate_cell', 'records[' + index + ']');
        cells.add(cell);
      }
      return parsed;
    });
    return canonicalize({schema: raw.schema, schema_version: raw.schema_version, batch_id: raw.batch_id, stream: raw.stream, resource, records});
  }

  return {
    CATALOG: catalog, SCHEMA_VERSION: catalog.schema_version,
    parseRecord, parseInboxFile, parseEnvelope, bucket, bucketIndex,
    /** The names of the entries live at a schema version. */
    entryNamesAt: (version = catalog.schema_version) => Object.keys(catalog.entries).filter(name => liveAt(catalog.entries[name], version)),
    /** Members of an enum live at a schema version. */
    enumMembers: (name, version = catalog.schema_version) => [...membersAt(name, version)],
  };
}

const shipped = createCatalog(catalogJson);
export const {CATALOG, SCHEMA_VERSION, parseRecord, parseInboxFile, parseEnvelope, bucket, bucketIndex, entryNamesAt, enumMembers} = shipped;
