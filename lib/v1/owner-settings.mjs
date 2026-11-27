// The optional owner-set total-spend cap for one lent job. A change needs an owner and a reason, and is appended to the audit
// trail. A file that cannot be read is never overwritten, because its audit trail is not known.
import {constants, copyFileSync, readFileSync} from 'node:fs';
import {durableJson} from '../durable-write.mjs';
import {join} from 'node:path';

const FILE = 'owner-settings.json';
const FIELDS = Object.freeze(['maxJobUsd']);
const VALID = Object.freeze({maxJobUsd: value => Number.isFinite(value) && value > 0});
// The runtime default when the owner has saved no per-job limit (docs/protocol/app-api.md: "Unset means the runtime default of $4").
export const DEFAULT_OWNER_MAX_JOB_USD = 4;

// The value container is a plain object of the known fields. An array, a scalar or an unknown key is not an unset limit: it is unreadable.
const isValueContainer = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => FIELDS.includes(key));

function readState(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? {absent: true} : {unreadable: true};
  }
  const values = parsed?.values;
  const audit = parsed?.audit;
  if (parsed?.version !== 1 || !isValueContainer(values) || !Array.isArray(audit)) return {unreadable: true};
  for (const field of FIELDS) {
    if (values[field] !== null && values[field] !== undefined && !VALID[field](values[field])) return {unreadable: true};
  }
  return {values: Object.fromEntries(FIELDS.map((field) => [field, values[field] ?? null])), audit};
}

// The volume limits this build deleted were saved in one shape: version 1, the cap and two overrun allowances, and the audit trail.
// A file in exactly that shape is migrated: the allowances are removed, and the cap and the audit are kept. Any other content is not
// migrated and is left as it is, byte for byte, so it reads as unreadable rather than as unset.
const OLD_VOLUME_FIELDS = Object.freeze(['weeklyOverrunPoints', 'shortOverrunPoints']);
const OLD_VALID = Object.freeze({
  maxJobUsd: VALID.maxJobUsd,
  weeklyOverrunPoints: (value) => Number.isFinite(value) && value >= 0 && value < 1,
  shortOverrunPoints: (value) => Number.isFinite(value) && value >= 0 && value < 1,
});
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isOldShape(parsed) {
  if (!isPlainObject(parsed) || Object.keys(parsed).some((key) => !['version', 'values', 'audit'].includes(key))) return false;
  const {version, values, audit} = parsed;
  if (version !== 1 || !isPlainObject(values) || !Array.isArray(audit)) return false;
  if (!OLD_VOLUME_FIELDS.some((field) => Object.hasOwn(values, field))) return false;
  if (!Object.keys(values).every((key) => key === 'maxJobUsd' || OLD_VOLUME_FIELDS.includes(key))) return false;
  if (!Object.keys(values).every((key) => values[key] === null || OLD_VALID[key](values[key]))) return false;
  return audit.every((entry) => isPlainObject(entry) && Number.isFinite(entry.at) && typeof entry.by === 'string'
    && typeof entry.reason === 'string' && isPlainObject(entry.changed));
}

function migrateDeletedVolumeSettings(path, now) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return; }
  if (!isOldShape(parsed)) return;
  const {values} = parsed;
  const maxJobUsd = values.maxJobUsd ?? null;
  const audit = [...parsed.audit, {at: now(), by: 'faravan-migration', reason: 'Remove deleted lending volume limits',
    changed: {weeklyOverrunPoints: {from: values.weeklyOverrunPoints ?? null, to: null},
      shortOverrunPoints: {from: values.shortOverrunPoints ?? null, to: null}}}];
  durableJson(path, {version: 1, values: {maxJobUsd}, audit});
}

export function createOwnerSettings({directory, now = Date.now}) {
  const path = join(directory, FILE);
  migrateDeletedVolumeSettings(path, now);
  const current = () => readState(path);
  return {
    // The saved values, or null when no setting was ever saved or the file cannot be read. Admission reads limit() instead.
    values() {
      const state = current();
      return state.values ?? null;
    },
    // The per-job limit in one of three states. 'unset': no file, or no limit saved, so the runtime default applies.
    // 'unreadable': the file cannot be trusted, so there is no limit to apply and admission holds. Never read as unset.
    limit() {
      const state = current();
      if (state.unreadable) return {state: 'unreadable', maxJobUsd: null};
      const maxJobUsd = state.values?.maxJobUsd ?? null;
      return maxJobUsd === null ? {state: 'unset', maxJobUsd: null} : {state: 'set', maxJobUsd};
    },
    audit() {
      const state = current();
      return state.audit ?? [];
    },
    // Saves the given values after validating each one. Only the named fields change. Returns the saved values. A file that cannot be
    // read is refused unless replaceUnreadable is true. Then it is copied beside the new file, and the new audit trail records the
    // replacement, because the unreadable file's own trail cannot be read.
    set({by, reason, now, replaceUnreadable = false, ...changes}) {
      if (typeof by !== 'string' || by.trim() === '' || typeof reason !== 'string' || reason.trim() === '' || !Number.isFinite(now)) {
        throw new Error('invalid_owner_setting: a change needs an owner, a reason and a time');
      }
      const named = FIELDS.filter((field) => changes[field] !== undefined);
      if (named.length === 0) throw new Error('invalid_owner_setting: nothing to change');
      for (const field of named) {
        if (!VALID[field](changes[field])) throw new Error(`invalid_owner_setting: ${field} is out of range`);
      }
      const state = current();
      if (state.unreadable && replaceUnreadable !== true) {
        throw new Error('unreadable_owner_settings: refusing to overwrite a file whose audit is unknown; set replaceUnreadable to replace it');
      }
      const before = state.values ?? Object.fromEntries(FIELDS.map((field) => [field, null]));
      const changed = {};
      const values = {...before};
      for (const field of named) {
        if (before[field] !== changes[field]) changed[field] = {from: before[field], to: changes[field]};
        values[field] = changes[field];
      }
      let audit = state.audit ?? [];
      let entry = {at: now, by, reason, changed};
      if (state.unreadable) {
        // The copy is made first and never overwritten, so the damaged file survives even if the write below fails.
        const kept = `owner-settings.unreadable-${now}.json`;
        copyFileSync(path, join(directory, kept), constants.COPYFILE_EXCL);
        audit = [];
        entry = {at: now, by, reason: 'replaced unreadable settings', note: reason, changed, kept};
      }
      audit.push(entry);
      durableJson(path, {version: 1, values, audit});
      return values;
    },
  };
}
