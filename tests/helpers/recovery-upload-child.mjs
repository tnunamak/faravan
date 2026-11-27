import fs from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openV1Store} from '../../lib/v1/store.mjs';
import {createV1Handler} from '../../lib/v1/server.mjs';
import * as p from '../../lib/protocol/index.mjs';
import {barrier} from './crash-process.mjs';
const [directory,phase]=process.argv.slice(2);
const golden=JSON.parse(fs.readFileSync(new URL('../../docs/protocol/vectors/golden.json',import.meta.url)));
const roster=golden.objects.roster.envelope,circle=roster.payload.circle,origin='http://127.0.0.1:18787',now=1791547200;
const file=join(directory,'store.sqlite'),blobDir=join(directory,'blobs');
fs.mkdirSync(blobDir,{recursive:true});
const store=openV1Store({path:file,origin,circle,rootFingerprint:golden.keys[2].fingerprint,initialRoster:roster,clock:()=>now});
if(phase==='create') {
  const bytes=Buffer.from('crash output'),ref={digest:p.digestBytes(bytes),bytes:bytes.length,media_type:'text/plain'};
  const proof=p.buildRequestProof({circle,roster_epoch:roster.payload.epoch,method:'PUT',
    target:origin+'/v1/circles/'+circle+'/artifacts/'+ref.digest.slice(7),body_digest:ref.digest,content_length:bytes.length,
    content_type:'application/octet-stream',artifact_media_type:ref.media_type,idempotency_key:'',created:now,nonce:randomBytes(16).toString('base64url')},
    p.privateKeyFromSeed(Buffer.from(golden.keys[0].seed_hex,'hex')));
  const device=golden.keys[0].fingerprint,r=store.reserveArtifact(device,ref,{proof,transport:true});
  store.finishArtifactUpload(device,r.reservation_id,ref,()=>{
    const fd=fs.openSync(join(blobDir,ref.digest.slice(7)),'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);
    const dir=fs.openSync(blobDir,'r');fs.fsyncSync(dir);fs.closeSync(dir);
    process.send({boundary:'blob-installed'});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  },r.owner_token,{verifiedInput:true});
} else {
  const handler=createV1Handler({store,blobDir,clock:()=>now});
  const db=new DatabaseSync(file);
  const reservations=db.prepare('SELECT count(*) AS n FROM reservations').get().n;
  const quota=JSON.parse(db.prepare("SELECT data FROM quota_counters WHERE id='circle'").get().data);
  fs.writeFileSync(join(directory,'recovered-upload.json'),JSON.stringify({reservations,quota,blobs:fs.readdirSync(blobDir)}));
  await barrier('upload-recovered','upload-recovered');
}
