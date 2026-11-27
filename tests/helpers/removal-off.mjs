// Tests of the report-only path import this first: the sweep removes nothing, whatever the default is.
import { REMOVE_ARTIFACTS_ENV } from '../../lib/disk-sweep-setting.mjs';
process.env[REMOVE_ARTIFACTS_ENV] = '0';
