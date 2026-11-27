import {lendingHours, validateSchedule} from './lending-state.mjs';

// Discovery has no authority: it reads signed requests, never claims or downloads source.
export function createOfferReader({client,now=Date.now}={}) {
  let lastScan=-Infinity,cached={items:[],legacy:false},profileAt=-Infinity,profile,revision;
  return {forget(digest){cached={...cached,items:cached.items.filter(item=>item.job_digest!==digest)};},async read({signal,waitSeconds=30}={}) {
    if(!profile||now()-profileAt>=60000){profile=await client.capabilities({signal,refresh:true});profileAt=now();}
    if(profile.capabilities.includes('offers_v1')) {
      const items=[];
      for await(const item of client.listOffers({signal,waitSeconds,limit:100,since:revision,onRevision:value=>{revision=value;}}))items.push(item);
      return {items,legacy:false};
    }
    if(now()-lastScan<60000)return cached;
    const items=[];let count=0;
    for await(const item of client.listJobs({signal,limit:100})) {
      if(++count>2000){cached={items:[],legacy:true,label:"This circle's host is too old for offers; update it. Jobs use a 60-second hold."};lastScan=now();return cached;}
      if(item.state==='queued')items.push(item);
    }
    cached={items,legacy:false};lastScan=now();return cached;
  }};
}

export function validateStandingRules(rules=[]) {
  const invalid=()=>{throw Object.assign(new Error('invalid_standing_rule'),{code:'invalid_request'});};
  if(!Array.isArray(rules)||rules.length>100)invalid();
  const ids=new Set();
  return rules.map(rule=>{
    if(!rule||typeof rule!=='object'||Array.isArray(rule)||typeof rule.id!=='string'||!rule.id||ids.has(rule.id)||
      typeof rule.circle!=='string'||!rule.circle||!Array.isArray(rule.people)||(!rule.people.length&&rule.peopleScope!=='circle')||rule.people.some(p=>typeof p!=='string'||!p)||
      !Array.isArray(rule.agents)||rule.agents.some(a=>typeof a!=='string'||!a)||!Number.isFinite(rule.expiresAt))invalid();
    if(rule.maxWallSeconds!==null&&(!Number.isSafeInteger(rule.maxWallSeconds)||rule.maxWallSeconds<1))invalid();
    for(const name of ['dailyJobs','weeklyJobs','dailyMinutes','weeklyMinutes'])
      if(rule[name]!==null&&(!Number.isSafeInteger(rule[name])||rule[name]<1))invalid();
    ids.add(rule.id);
    return {...rule,people:[...new Set(rule.people)],agents:[...new Set(rule.agents)],schedule:validateSchedule(rule.schedule??null)};
  });
}

export function matchingRule(rules,job,harness,{now=Date.now(),timeZone,usage=()=>({})}={}) {
  return rules.find(rule=>{
    if(rule.expiresAt<=now||rule.circle!==job.circle||(rule.peopleScope!=='circle'&&!rule.people.includes(job.author))||!rule.agents.includes(harness)||
      (rule.maxWallSeconds!==null&&job.requirements.limits.wall_seconds>rule.maxWallSeconds)||
      rule.schedule&&!lendingHours(rule.schedule,now,rule.timeZone??timeZone).inside)return false;
    const used=usage(rule.id),reserve=job.requirements.limits.wall_seconds*1000;
    return (rule.dailyJobs===null||(used.dailyJobs??0)<rule.dailyJobs)&&
      (rule.weeklyJobs===null||(used.weeklyJobs??0)<rule.weeklyJobs)&&
      (rule.dailyMinutes===null||(used.dailyMs??0)+reserve<=rule.dailyMinutes*60000)&&
      (rule.weeklyMinutes===null||(used.weeklyMs??0)+reserve<=rule.weeklyMinutes*60000);
  })??null;
}
