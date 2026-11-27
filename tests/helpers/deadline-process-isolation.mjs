// Unit tests never register host timers or detached guards through the backend's
// default runner. Deadline tests inject their own runner; the crash test uses
// an explicit fake removal executable and the production detached guard.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,delimiter} from 'node:path';
import {SANDBOX_GUARD_BUILD_ID} from '../../lib/sandbox-deadline.mjs';
const directory=join(process.env.FARAVAN_TEST_HOME,'.deadline-process-shims');
mkdirSync(directory,{recursive:true});
const control=`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=${JSON.stringify(directory)},command=path.basename(process.argv[1]),args=process.argv.slice(2);
const clean=value=>value?.replace(/\\.(?:timer|service)$/,'');
const safe=unit=>/^faravan-[a-f0-9]{12}-deadline-(?:wf|dl)-[a-f0-9]{16}(?:-[a-f0-9]{12})?$/.test(unit??'');
const state=unit=>path.join(root,unit+'.json');
const reply=(type,data)=>console.log(JSON.stringify({type,data}));
if(command==='systemd-run'){
  const unit=args.find(arg=>arg.startsWith('--unit='))?.slice(7),at=args.indexOf('--');
  if(!safe(unit)||at<0)process.exit(1);
  const argv=args.slice(at+1),environment=args.filter(arg=>arg.startsWith('--setenv=')).map(arg=>arg.slice(9));
  fs.writeFileSync(state(unit),JSON.stringify({argv,environment}),{mode:0o600});
  try{const payload=JSON.parse(argv.at(-1));fs.writeFileSync(payload.statusPath,JSON.stringify({build_id:${JSON.stringify(SANDBOX_GUARD_BUILD_ID)},state:'armed',pid:process.ppid,start:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fs.readFileSync('/proc/'+process.ppid+'/stat','utf8').split(') ').at(-1).trim().split(/\\s+/)[19],binding:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}),{mode:0o600});}catch{}
}else if(command==='systemctl'){
  if(args.join(' ')==='--user show --property=Version --value')console.log('260');
  else {
    const unit=clean(args.find(arg=>arg.endsWith('.timer')||arg.endsWith('.service')));
    if(!safe(unit))process.exit(1);
    if(args.includes('stop'))fs.rmSync(state(unit),{force:true});
    else if(!fs.existsSync(state(unit)))process.exit(1);
  }
}else if(command==='busctl'){
  let unit;
  if(args.includes('GetUnit')){
    unit=clean(args.at(-1));if(!safe(unit)||!fs.existsSync(state(unit)))process.exit(1);
    reply('o',['/org/freedesktop/systemd1/unit/'+Buffer.from(unit).toString('hex')]);
  }else {
    const object=args.find(arg=>arg.startsWith('/org/freedesktop/systemd1/unit/'));
    unit=object&&Buffer.from(object.split('/').at(-1),'hex').toString();
    if(!safe(unit)||!fs.existsSync(state(unit)))process.exit(1);
    const saved=JSON.parse(fs.readFileSync(state(unit),'utf8'));
    if(args.at(-1)==='ExecStart')reply('a(sasbttttuii)',[[saved.argv[0],saved.argv,false,0,0,0,0,0,0,0]]);
    else if(args.at(-1)==='Environment')reply('as',saved.environment);else process.exit(1);
  }
}else process.exit(1);
`;
for(const command of ['systemd-run','systemctl','busctl'])writeFileSync(join(directory,command),control,{mode:0o755});
process.env.PATH=directory+delimiter+process.env.PATH;
