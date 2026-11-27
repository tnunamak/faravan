/** Local state paths and atomic private JSON writes shared by v1. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { compatEnv } from './compat/env.mjs';
import { channelDataHome } from './channel-identity.mjs';
import {migrateProductHome} from './product-home-move.mjs';
import {ensureDurableDirectory, syncDirectory} from './durable-directory.mjs';

// Move old profiles before any app state is created.
export function configHome() {
  const explicit = compatEnv('HOME');
  if (explicit) return explicit;
  const destination = channelDataHome();
  migrateProductHome(destination);
  return destination;
}

export function saveJsonFile(file, value, { mode = 0o600, base } = {}) {
  const dir = ensureDurableDirectory(path.dirname(file), {base});
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let ownsTemp = false;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    ownsTemp = true;
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    const completed = fd;
    fd = undefined;
    fs.closeSync(completed);
    fs.renameSync(tmp, file);
    ownsTemp = false;

    // After rename, a directory-sync error means durability is uncertain;
    // rolling back here could overwrite a newer concurrent save.
    syncDirectory(dir);
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (ownsTemp) fs.unlinkSync(tmp);
    }
  }
}
