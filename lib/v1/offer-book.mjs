import {LENDING_REASONS,lendingReasonCode} from './lending-reasons.mjs';
import {createHash} from 'node:crypto';

// What this computer finally decided about each offer it read, one decision per offer however many pool workers
// saw it and however often (TELEMETRY.md section 2.3). The book is one persisted object on the pool's shared root;
// every operation takes that root, changes it in place and returns the decisions it completed. The pool serializes
// the calls and persists the root, so a restart or a second worker never counts an offer twice.
// Offer keys are local: a hash of job digest and circle that never leaves the computer.
export const OFFER_OUTCOMES=Object.freeze(['admitted_auto','accepted_manual','declined_manual','hidden','expired_visible','taken_by_other','ineligible']);
export const OFFER_REASONS=Object.freeze(Object.keys(LENDING_REASONS));
export const NOT_EVALUATED = 'conditions_unavailable';
export const OFFER_MODES=Object.freeze(['ask','auto','rule']);
export const MAX_OFFERS=10000;

// The lender's other gate codes (a held machine, a pending stop, a too-long job) become the closest member.
export const offerReason=code=>code?lendingReasonCode(code):'none';

const kindOf=id=>id.startsWith('claude')?'claude-code':id==='codex'?'codex':'unknown';
const harnessOf=ids=>{const kinds=new Set((ids??[]).map(kindOf));return !kinds.size?'any':kinds.size===1?[...kinds][0]:kinds.has('unknown')?'unknown':'any';};

// An entry is `{x: expiresAt, f: 1}` once decided. Until then it also holds what the decision will report:
// harness h, wall seconds w, wait seconds d (from first sight to expiry), mode m, and each account's latest reason.
const describe=(view,at)=>{
  const job=view.job.payload,x=Date.parse(job.expires_at);
  return {key:createHash('sha256').update(view.job_digest+'\n'+job.circle).digest('hex').slice(0,32),
    x,h:harnessOf(job.requirements.harness),w:job.requirements.limits.wall_seconds,d:Math.max(0,Math.round((x-at)/1000))};
};
// Eligible for anyone on this computer counts as eligible; otherwise the latest ineligibility stands.
const reasonOf=e=>Object.values(e.by).includes('none')?'none':e.last;
const report=(key,e,outcome,reason,mode)=>({offerKey:key,outcome,reason:offerReason(reason),harness:e.h,mode,wallSeconds:e.w,deadline:e.d});

export function createOfferBook({now=Date.now}={}) {
  // Not persisted: when each offer was last listed in this process, and which offers the full book turned away.
  const listedAt=new Map(),turnedAway=new Set();

  function run(root,work) {
    const book=root.offerBook??={entries:{},overflow:0,reported:0};
    const out=[];let changed=false;
    const decide=(key,e,outcome,reason,mode=e.m)=>{out.push(report(key,e,outcome,reason,mode));book.entries[key]={x:e.x,f:1};changed=true;};
    // The offer left the list without a decision of its own: it expired, was taken, or never became eligible.
    const left=(key,e,expired)=>{const reason=reasonOf(e);
      if(reason!=='none')decide(key,e,'ineligible',reason);else decide(key,e,expired?'expired_visible':'taken_by_other','none');};
    for(const [key,e] of Object.entries(book.entries)) {
      if(e.x>now())continue;
      if(!e.f)left(key,e,true);
      delete book.entries[key];listedAt.delete(key);changed=true;
    }
    const open=d=>{
      if(book.entries[d.key])return book.entries[d.key];
      // An offer that has already expired is not opened again: the sweep above decided it once.
      if(d.x<=now())return null;
      if(Object.keys(book.entries).length>=MAX_OFFERS) {
        // The set only remembers which turned-away offers were already counted; it is bounded like the book itself.
        if(turnedAway.size>=MAX_OFFERS)turnedAway.clear();
        if(!turnedAway.has(d.key)){turnedAway.add(d.key);book.overflow++;changed=true;}
        return null;
      }
      changed=true;return book.entries[d.key]={x:d.x,h:d.h,w:d.w,d:d.d,m:'ask',by:{},last:'none'};
    };
    work({book,out,decide,left,open,touch:()=>{changed=true;}});
    if(out.length&&book.overflow>book.reported){out[0].mapOverflow=book.overflow;book.reported=book.overflow;changed=true;}
    return {decisions:out,changed};
  }

  return {
    /**
     * One account worker read the offer list at `readAt` and judged every listed offer: `listed` holds
     * `{view, reason, mode, outcome?}`. An `outcome` is the offer's final decision (a hidden offer). Offers that
     * were open and are missing from the list are over, unless another worker listed them after `readAt`.
     */
    sight(root,{account,readAt,listed}) {
      return run(root,({book,decide,left,open,touch})=>{
        const present=new Set();
        for(const {view,reason,mode,outcome} of listed) {
          const d=describe(view,now());present.add(d.key);
          const e=open(d);
          if(!e||e.f)continue;
          listedAt.set(d.key,now());
          if(outcome){decide(d.key,e,outcome,reason,mode);continue;}
          // A rule that matched for one account's agent makes the offer a rule offer for the computer.
          const kept=e.m==='rule'?'rule':mode;
          if(e.by[account]!==reason||e.m!==kept){e.by[account]=reason;e.last=reason;e.m=kept;touch();}
        }
        for(const [key,e] of Object.entries(book.entries))
          if(!e.f&&!present.has(key)&&(listedAt.get(key)??-Infinity)<readAt)left(key,e,false);
      });
    },
    /** A decision made outside a list read: a person accepted or declined, or the offer was taken during review. */
    settle(root,{view,outcome,reason='none',mode}) {
      return run(root,({decide,open})=>{
        const d=describe(view,now()),e=open(d);
        if(e&&!e.f)decide(d.key,e,outcome,reason,mode);
      });
    },
  };
}
