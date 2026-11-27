// Package removal uses the same evidence parser and verifier as the runtime.
import {readFileSync} from 'node:fs';
import {configHome} from './local-state.mjs';
import {installRoot} from './sbx-daemon-owner.mjs';
import {sbxDaemonUnitEvidence, verifySbxDaemonUnitForRemoval} from './docker-backend.mjs';
const [unit, dataHome, root] = process.argv.slice(2);
const info = sbxDaemonUnitEvidence(readFileSync(0, 'utf8'));
process.exitCode = verifySbxDaemonUnitForRemoval(info, unit, {dataHome:dataHome || configHome(), root:root || installRoot}) ? 0 : 1;
