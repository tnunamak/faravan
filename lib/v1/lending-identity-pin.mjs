import {durableJson} from '../durable-write.mjs';
// The provider account this computer enrolled, when the provider's own status does not name it. Claude's status in the
// sandbox shows no e-mail, so the app cannot learn the account from it. The owner signed in through this app, so the first
// account a lending probe reads with that credential is the enrolled one: it is pinned. A later probe on another account is a
// mismatch until the owner chooses the agent for lending again, which clears the pin. Signing in again keeps the pin. Only the account hash from the guest is kept. An unreadable
// file yields no pin, and it is never overwritten, because its contents are unknown.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE = 'lending-identity-pins.json';
const HASH16 = /^[0-9a-f]{16}$/;

export function createIdentityPinStore({directory, now = Date.now}) {
  const path = join(directory, FILE);
  // The pins, or null when the file exists and cannot be trusted. A missing file has no pins.
  const read = () => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      return error?.code === 'ENOENT' ? {} : null;
    }
    if (parsed?.version !== 1 || !parsed.pins || typeof parsed.pins !== 'object' || Array.isArray(parsed.pins)) return null;
    return Object.values(parsed.pins).every((pin) => HASH16.test(pin?.account_sha256_16 ?? '')) ? parsed.pins : null;
  };
  const write = (pins) => {
    durableJson(path, {version: 1, pins});
  };
  return {
    // Read an existing pin without enrolling a new account.
    peek(provider) {
      const pin = read()?.[provider];
      return pin ? {account_sha256_16: pin.account_sha256_16} : null;
    },
    // The enrolled account for the provider: the pin, or else the observed account, which becomes the pin.
    // Returns null when there is neither, or when the file cannot be trusted.
    expected(provider, observed) {
      const pins = read();
      if (pins === null) return null;
      if (pins[provider]) return {account_sha256_16: pins[provider].account_sha256_16};
      const account = observed?.account_sha256_16;
      if (typeof account !== 'string' || !HASH16.test(account)) return null;
      write({...pins, [provider]: {account_sha256_16: account, pinned_at: now()}});
      return {account_sha256_16: account};
    },
    // Choosing the agent for lending again ends the enrollment, so the next probe pins the account then signed in.
    clear(provider) {
      const pins = read();
      if (pins === null || !pins[provider]) return;
      const {[provider]: _removed, ...rest} = pins;
      write(rest);
    },
  };
}
