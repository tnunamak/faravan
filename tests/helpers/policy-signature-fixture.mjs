// A synthetic copy of the file Claude's CLI writes at ~/.claude/policy-limits.json.signature.json: the SHAPE the probe's redacted
// summary reported (compact JSON {"jws","receivedAt"}; a three-part JWS with header alg/typ/kid/x5c, a nine-key payload and an
// 86-character signature). Every value here is made up. Test data only.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
// A self-signed public test certificate made for this file (CN=synthetic-test-cert, no private key kept). x5c entries are standard base64 DER.
export const SYNTHETIC_CERTIFICATE = 'MIIBkzCCATmgAwIBAgIUJq2lLnYIBnH0S9O/RngSBSturKQwCgYIKoZIzj0EAwIwHjEcMBoGA1UEAwwTc3ludGhldGljLXRlc3QtY2VydDAgFw0yNjEwMjAxNzMwNDRaGA8yMTI2MDkyNjE3MzA0NFowHjEcMBoGA1UEAwwTc3ludGhldGljLXRlc3QtY2VydDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABB5FCh0N7n0Sb1uFANP2dSFiREzlX0fUjyqcaCweIUoqRFC3LHQOqK3h3PubWEBwPrxJ7/ZR5f8fKDh808Qrks6jUzBRMB0GA1UdDgQWBBTq961mq9pERXdrANsrCeLOWYQ/CzAfBgNVHSMEGDAWgBTq961mq9pERXdrANsrCeLOWYQ/CzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQCIFOsVBo1Us0SNPeDwN17YQYj87x/aF9sNPs3mU53LHwIgU/7eQbX+rrDpuCVhlzB5vvTd+pfij+JkfJ+HCsVcMTs=';

export const syntheticHeader = (overrides = {}) => ({ alg: 'ES256', typ: 'JWT', kid: 'synthetic-key-1', x5c: [SYNTHETIC_CERTIFICATE, SYNTHETIC_CERTIFICATE], ...overrides });
export const syntheticPayload = (overrides = {}) => ({ v: 1, typ: 'policy-limits', aud: 'synthetic-audience', sub: 'synthetic-subject', ws: 'synthetic-workspace',
  plan: 'synthetic-plan', iat: 1790000000, exp: 1790086400, sha: '0123456789abcdef'.repeat(2), ...overrides });
export const syntheticJws = ({ header = syntheticHeader(), payload = syntheticPayload(), signature = 'A'.repeat(86) } = {}) =>
  [b64url(header), b64url(payload), signature].join('.');
/** The exact bytes the CLI writes. */
export const syntheticSignatureFile = ({ jws = syntheticJws(), receivedAt = 1790000000123 } = {}) => `{"jws":"${jws}","receivedAt":${receivedAt}}`;

export async function writeSignatureFile(home, text = syntheticSignatureFile(), name = 'policy-limits.json.signature.json', dir = '.claude') {
  await mkdir(join(home, dir), { recursive: true });
  const file = join(home, dir, name);
  await writeFile(file, text);
  return file;
}
