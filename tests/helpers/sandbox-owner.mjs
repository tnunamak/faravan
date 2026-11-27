import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {sbxOwnerFile} from '../../lib/sbx-daemon-owner.mjs';

// Fake runners do not execute daemon startup, which normally writes this record.
export function seedSandboxOwner() {
  const file=sbxOwnerFile();
  if(process.env.FARAVAN_SBX_BIN===undefined){
    const bin=dirname(fileURLToPath(new URL('../fixtures/sbx-default/sbx',import.meta.url)));
    const paths=String(process.env.PATH||'').split(delimiter);
    if(!paths.includes(bin))process.env.PATH=[bin,...paths].join(delimiter);
  }
  if(existsSync(file))return;
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({id:randomBytes(32).toString('hex'),executable:process.execPath}),{mode:0o600});
}
