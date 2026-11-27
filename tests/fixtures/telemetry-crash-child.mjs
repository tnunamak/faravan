// A child process for tests/telemetry-crash.test.mjs: crashes, with or without the telemetry crash monitor.
import { installCrashMonitor } from '../../lib/v1/telemetry/crash.mjs';
if (process.env.MONITOR_DIR) installCrashMonitor({dir: process.env.MONITOR_DIR, env: {}});
const how = process.env.HOW;
if (how === 'reject') Promise.reject(new RangeError('private rejection /home/alice/x'));
else if (how === 'exit') { process.exitCode = 0; }
else setTimeout(() => { throw new TypeError('private message /home/alice/secret'); }, 0);
