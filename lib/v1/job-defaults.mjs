// Borrower defaults shared by the CLI, app and browser composer.
export const JOB_DEFAULTS = Object.freeze({max_attempts:3,deadline_seconds:86400,egress:'internet',
  limits:Object.freeze({wall_seconds:1200,cpu:2,memory_bytes:4294967296,disk_bytes:8589934592,output_bytes:16777216}),
  limit_modes:Object.freeze({wall_seconds:'required',cpu:'required',memory_bytes:'required',disk_bytes:'preferred',output_bytes:'required'})});
