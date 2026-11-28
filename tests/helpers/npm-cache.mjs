import { userInfo } from 'node:os';
import { join } from 'node:path';

// Offline staging (packaging/stage-app.sh, npm ci --offline) reads the npm cache that the checkout primed. A test process has a
// synthetic, empty HOME, so npm's default cache is empty there and every production dependency is ENOTCACHED. Name the
// account's cache explicitly, the way a release build does. userInfo() reads the account database, not HOME.
export const npmCacheEnv = () => ({ npm_config_cache: process.env.npm_config_cache ?? join(userInfo().homedir, '.npm') });
