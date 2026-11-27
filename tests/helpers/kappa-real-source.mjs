import {createRealPace50Source, resourcesFromReadings} from './real-source.mjs';
import {createSyntheticPace50Source} from './pace50-synthetic-source.mjs';

// Only the provider responses and owner-demand evidence are fixtures. Normalization,
// proof validation, resource identities and per-provider rosters use the production source.
export function realKappaSource(clock, {kappaForUsage = null} = {}) {
 const used={claude:0,codex:0}, reads=[], codexMeasurements=new Map();
 const codexAccount='2222333344445555', codexPlan='pro';
 const synthetic=createSyntheticPace50Source({start:clock.at,used:{weekly:0,short:0},kappa:{weekly:100000,short:100000}});
 const source=createRealPace50Source({
  readings:async provider=>{
   reads.push(provider);
   const windows=[['weekly',10080,42*3600000],['short',300,1.25*3600000]].map(([kind,minutes,offset])=>({
    window_id:provider==='claude'?(kind==='weekly'?'seven_day':'five_hour'):`codex:${minutes}`,
    window_minutes:minutes,used_pct:used[provider],
    resets_at:clock.start+offset+Math.max(0,Math.floor((clock.at-clock.start-offset)/(minutes*60000))+1)*minutes*60000,
    observed_at:clock.at,state:'open'}));
   if(provider==='codex') {
    // Generate fresh fixture evidence with this provider run, before any conversion lookup.
    // Never relabel a retained measurement using the callback's requested binding.
    const {resources}=resourcesFromReadings(windows);
    codexMeasurements.clear();
    for(const r of resources) codexMeasurements.set(`codex:${r.id}`,{
     upper_micro:100000,provenance:{method:'fixture',label:'measured from your usage'},
     binding:{account_sha256_16:codexAccount},
    });
   }
   return {windows};
  },
  funding:provider=>({extra_usage:'disabled',observed_at:clock.at,
   guest_auth:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'},
   ...(provider==='codex'?{codex_plan:{plan_type:codexPlan,limit_reached:false}}:{}),
   identity:{account_sha256_16:provider==='claude'?'1111222233334444':codexAccount,email_sha256_16:'aaaa0000bbbb1111'},
   executor:{backend_id:'docker-sbx',sbx_version:'sbx version v0.49.2'},
   stop:{delivered:true,fallback:null,latency_ms:1,removed:true}}),
  expectedIdentity:()=>({email_sha256_16:'aaaa0000bbbb1111'}),
  expectedExecutor:{backend_id:'docker-sbx',accepts:()=>true},stopBoundMs:35_000,
  windowOrigin:(_provider,resources)=>new Map(resources.map(r=>[r.id,'owner'])),
  kappaForUsage:kappaForUsage ?? (({provider,resource})=>provider==='codex' ? codexMeasurements.get(resource) ?? null
   : {upper_micro:100000,binding:{account_sha256_16:'1111222233334444'},provenance:{method:'fixture',label:'measured from your usage'}}),
  // These synthetic rates sit below the shipped bounds on purpose, so the feedback arithmetic stays visible.
  kappaFloor:()=>null,
 });
 source.history=synthetic.history;source.objectiveInputFor=synthetic.objectiveInputFor;
 return {source,used,reads};
}
