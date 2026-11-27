// The one setting that decides whether the disk sweep may remove anything. It is OFF unless it is
// set to exactly 1, and it has no screen. A missing, empty or unrecognized value is off. With it
// off, every sweep only reports the disk space a cleanup could free, and status and doctor say so
// in plain words.
export const REMOVE_ARTIFACTS_ENV = 'FARAVAN_DISK_SWEEP_REMOVES_ARTIFACTS';

export const removalEnabled = (env = process.env) => String(env?.[REMOVE_ARTIFACTS_ENV] ?? '').trim() === '1';

// The plain line that says cleanup is off (status and doctor show it when a sweep ran in report mode).
export const REMOVAL_OFF_LINE = 'Disk cleanup is turned off on this computer: Faravan reports the disk space it could free but removes no sandboxes or caches.';
