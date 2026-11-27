/** Local owner custody for credentials Gozar references. Only ciphertext goes into the private store. */
import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {ensureDurableDirectory} from './durable-directory.mjs';
import {saveJsonFile} from './local-state.mjs';

const privateMode = 0o600;
const noFollow = fs.constants.O_NOFOLLOW;
function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== privateMode || stat.size > 65536)
      throw new Error('The exposure credential store is unavailable.');
    return fs.readFileSync(fd);
  } finally {fs.closeSync(fd);}
}

export function hostingSecretBackend(directory) {
  const folder = path.join(directory, 'exposure-secrets');
  const keyPath = path.join(folder, 'key');
  const file = handle => {
    if (!/^[0-9a-f-]{36}$/.test(handle)) throw new Error('Invalid credential reference.');
    return path.join(folder, handle + '.json');
  };
  function createKey() {
    ensureDurableDirectory(folder, {base:directory});
    try {return readPrivate(keyPath);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    const key = randomBytes(32);
    try {fs.writeFileSync(keyPath, key, {flag:'wx', mode:privateMode, flush:true});return key;}
    catch (error) {
      key.fill(0);
      if (error.code !== 'EEXIST') throw error;
      return readPrivate(keyPath);
    }
  }
  function record(scopeId, handle) {
    const value = JSON.parse(readPrivate(file(handle)).toString());
    if (value.scopeId !== scopeId) throw new Error('Invalid credential reference.');
    return value;
  }
  const associatedData = (scope, handle) => Buffer.from(JSON.stringify([scope, handle]));
  return {
    async put({scopeId, bytes}) {
      const handle = randomUUID(), iv = randomBytes(12), key = createKey();
      try {
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(associatedData(scopeId, handle));
        const contents = Buffer.concat([cipher.update(bytes), cipher.final()]);
        saveJsonFile(file(handle), {scopeId, iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'),
          contents:contents.toString('base64')}, {base:directory});
        return {handle};
      } finally {key.fill(0);}
    },
    async withSecret({scopeId, handle}, use) {
      const row = record(scopeId, handle), key = readPrivate(keyPath);
      let bytes;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
        decipher.setAAD(associatedData(scopeId, handle));
        decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
        bytes = Buffer.concat([decipher.update(Buffer.from(row.contents, 'base64')), decipher.final()]);
        return await use(bytes);
      } finally {key.fill(0);bytes?.fill(0);}
    },
    async presence({scopeId, handle}) {
      try {return {known:true, value:await this.withSecret({scopeId, handle}, async () => true)};}
      catch (error) {return error.code === 'ENOENT' && error.path === file(handle)
        ? {known:true, value:false} : {known:false, reason:'credential-store-unavailable'};}
    },
    async delete({scopeId, handle}) {
      try {record(scopeId, handle);fs.unlinkSync(file(handle));return {deleted:true};}
      catch (error) {if (error.code === 'ENOENT') return {deleted:true};throw error;}
    },
  };
}
