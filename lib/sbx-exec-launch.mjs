import {spawnSbxChild} from './docker-backend.mjs';
import {restoreSbxRuntime} from './sbx-runtime.mjs';
// systemd can delay execution after the parent checked its runtime. Check again in the process that execs it.
const descriptor=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));
const env={...process.env,FARAVAN_SBX_BIN:descriptor.binary.path};
process.env.FARAVAN_SBX_BIN=descriptor.binary.path;
const runtime=restoreSbxRuntime(descriptor,{env,cleanup:descriptor.purpose==='cleanup'});
spawnSbxChild(runtime,process.argv.slice(3),{mode:'execve',env});
