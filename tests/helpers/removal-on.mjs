// The disk sweep's removal code is kept behind one setting that is off by default (lib/disk-sweep-setting.mjs).
// A test file that covers that code imports this first, so every sweep in the file may remove.
import { REMOVE_ARTIFACTS_ENV } from '../../lib/disk-sweep-setting.mjs';
process.env[REMOVE_ARTIFACTS_ENV] = '1';
