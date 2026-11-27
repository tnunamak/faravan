// Filename rules only: they do not establish that the remaining contents contain no secrets.
// Keep credentials separate from generated/dependency noise: committed build output can be source.
export const SECRET_FILE_RULES = Object.freeze({
  directories: Object.freeze(['.ssh', '.aws', '.kube']),
  names: Object.freeze(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'kubeconfig', 'credentials', 'credentials.json',
    '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '_netrc', '.git-credentials', '.pypirc']),
  patterns: Object.freeze([/^\.env(?:\..*)?$/, /^id_[a-z0-9_-]+$/, /\.(?:pem|key|p12|pfx|ppk)$/]),
});
export const NOISE_DIRECTORIES = Object.freeze(['.git', 'node_modules', 'dist', 'build']);
const EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);
const partsOf = path => String(path).toLowerCase().split('/').filter(part => part && part !== '.');
// Only credential directories match ancestors; a source folder named credentials or id_utils is allowed.
export function isSecretFile(path) {
  const parts=partsOf(path), file=parts.at(-1);
  return parts.some(part=>SECRET_FILE_RULES.directories.includes(part)) ||
    (!EXAMPLES.has(file) && (SECRET_FILE_RULES.names.includes(file) ||
      SECRET_FILE_RULES.patterns.some(pattern=>pattern.test(file??''))));
}
export function isNoiseFile(path) {
  return partsOf(path).some(part => NOISE_DIRECTORIES.includes(part));
}
// A private key keeps its header under any filename; only the first 4 KB, after optional BOM/whitespace, is checked.
const PRIVATE_KEY_HEADER = /^\s*(?:-----BEGIN (?:(?:RSA |EC |DSA |ENCRYPTED |OPENSSH )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|PuTTY-User-Key-File-)/;
export function sourceFileOmission(path, {tracked = false, bytes} = {}) {
  if (isSecretFile(path) || (bytes && PRIVATE_KEY_HEADER.test(bytes.subarray(0, 4096).toString('latin1').replace(/^\xef\xbb\xbf/, '')))) return {path, reason:'credentials'};
  // Git history can retain excluded credentials under any filename. Check the
  // binary pack signature and bundle header; ordinary text mentioning PACK is source.
  if (bytes && (bytes.subarray(0, 4).toString('ascii') === 'PACK' && bytes.length >= 12 && [2,3].includes(bytes.readUInt32BE(4)) ||
      /^# v[23] git bundle\r?\n/.test(bytes.subarray(0, 32).toString('ascii')))) return {path, reason:'not_source'};
  // Git metadata is never source, even when nested inside a committed tree.
  if (partsOf(path).includes('.git') || (!tracked && isNoiseFile(path))) return {path, reason:'not_source'};
  return null;
}
export function sourceOmissionLines(omitted = []) {
  return ['credentials', 'not_source'].flatMap(reason => {
    const matching=omitted.filter(file=>file.reason===reason),count=matching.length;
    const noun=matching.some(file=>file.kind==='directory') ? (count===1?'item':'items') : (count===1?'file':'files');
    return count ? [`${count} ${noun} not sent (${reason === 'credentials' ? 'looked like credentials' : 'not source'})`] : [];
  });
}
