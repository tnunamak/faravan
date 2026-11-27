// What a provider route answers in a fake sandbox: 200 for the sandbox's scoped value when it is the real one, and 401 for any other
// scoped value, unless the computer's own global login answers instead (then every value gets 200).
export function answerCurl(args,secrets,{real,globalLogin=false}){
  if(args[0]!=='exec'||!args.includes('curl'))return null;
  const row=secrets.filter(secret=>args.includes(secret.scope)).at(-1);
  return {code:0,stdout:String(globalLogin||row?.token===real?200:401),stderr:''};
}
// `sbx secret set --force` replaces the sandbox's row for that service.
export function setScoped(secrets,args,input){
  const scope=args[args.indexOf('--sandbox')+1];
  for(let n=secrets.length-1;n>=0;n--)if(secrets[n].name===args[2]&&secrets[n].scope===scope)secrets.splice(n,1);
  secrets.push({name:args[2],scope,type:'service',token:input});
}
