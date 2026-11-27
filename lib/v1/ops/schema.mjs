import { opError } from './errors.mjs';
// The JSON Schema subset the operation registry uses, and a validator for it. Every surface (HTTP, CLI, MCP)
// validates op input with this one function, so a value one surface accepts is accepted by all of them.
// Supported keywords: type (string or array), properties, required, additionalProperties (boolean), enum, const,
// pattern, minLength, maxLength, minimum, maximum, items, maxItems, oneOf/anyOf (first-match), description, default.

export const S = {
  string: (extra = {}) => ({type:'string', minLength:1, maxLength:4096, ...extra}),
  text: (maxLength, extra = {}) => ({type:'string', minLength:1, maxLength, ...extra}),
  bool: (description, extra = {}) => ({type:'boolean', ...(description ? {description} : {}), ...extra}),
  int: (minimum, maximum, extra = {}) => ({type:'integer', minimum, maximum, ...extra}),
  num: (minimum, maximum, extra = {}) => ({type:'number', minimum, maximum, ...extra}),
  enum: (values, extra = {}) => ({type:'string', enum:values, ...extra}),
  obj: (properties = {}, required = [], extra = {}) => ({type:'object', properties, ...(required.length ? {required} : {}), additionalProperties:false, ...extra}),
  // Output shapes are documented, not frozen: the app may add fields, so outputs allow extra properties.
  out: (properties = {}, required = [], extra = {}) => ({type:'object', properties, required, additionalProperties:true, ...extra}),
  list: (items = {type:'object'}, extra = {}) => ({type:'array', items, ...extra}),
  any: (description) => ({...(description ? {description} : {})}),
};
export const DIGEST = S.string({pattern:'^sha256:[0-9a-f]{64}$', maxLength:71, description:'Job digest.'});
export const JOB_ID = S.string({maxLength:71, pattern:'^(sha256:)?[0-9a-f]{6,64}$', description:'Digest or prefix.'});
export const CIRCLE = S.string({maxLength:256, description:'Name or ID.'});
export const KEY_ID = S.string({pattern:'^sha256:[0-9a-f]{64}$', maxLength:71, description:'Computer.'});

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' :
  Number.isInteger(value) ? 'integer' : typeof value;
const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

/** Returns null when `value` satisfies `schema`, else the first problem as {path, message}. */
export function check(schema, value, path = '') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.oneOf || schema.anyOf) {
    const problem = check({...schema, oneOf:undefined, anyOf:undefined}, value, path);
    if (problem) return problem;
    const options = schema.oneOf ?? schema.anyOf;
    const passing = options.filter(option => check(option, value, path) === null);
    if (!passing.length) return {path, message:'does not match any allowed form'};
    if (schema.oneOf && passing.length > 1) return {path, message:'matches more than one allowed form'};
    return null;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => matchesType(value, type))) return {path, message:'must be ' + types.join(' or ')};
  }
  if (schema.const !== undefined && value !== schema.const) return {path, message:'must be ' + JSON.stringify(schema.const)};
  if (schema.enum && !schema.enum.includes(value)) return {path, message:'must be one of ' + schema.enum.join(', ')};
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return {path, message:'is too short'};
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return {path, message:'is too long'};
    if (value.includes('\0')) return {path, message:'contains a NUL character'};
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return {path, message:'has the wrong format'};
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return {path, message:'must be finite'};
    if (schema.minimum !== undefined && value < schema.minimum) return {path, message:'must be at least ' + schema.minimum};
    if (schema.maximum !== undefined && value > schema.maximum) return {path, message:'must be at most ' + schema.maximum};
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return {path, message:'has too many items'};
    if (schema.minItems !== undefined && value.length < schema.minItems) return {path, message:'has too few items'};
    if (schema.items) for (const [index, item] of value.entries()) {
      const problem = check(schema.items, item, path + '[' + index + ']');
      if (problem) return problem;
    }
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return {path:join(path, key), message:'is required'};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const problem = check(properties[key], item, join(path, key));
        if (problem) return problem;
      } else if (schema.additionalProperties === false) return {path:join(path, key), message:'is not a known field'};
    }
  }
  return null;
}
const join = (path, key) => path ? path + '.' + key : key;

/** Throws {code:'invalid_request'} with the field path when invalid. */
export function validate(schema, value, label = 'input') {
  const problem = check(schema, value);
  if (problem) throw opError('invalid_request',400,(problem.path ? label + '.' + problem.path : label) + ' ' + problem.message + '.',
    {field:problem.path || null});
  return value;
}
