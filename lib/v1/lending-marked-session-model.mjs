// Exact finite research arithmetic. No providers, files, telemetry, or live admission.
export class Q {
  constructor(n, d=1n) { n=BigInt(n); d=BigInt(d); if(!d) throw Error('zero denominator'); if(d<0n){n=-n;d=-d;} const gcd=(a,b)=>b?gcd(b,a%b):a; const g=gcd(n<0n?-n:n,d); this.n=n/g; this.d=d/g; }
  add(b){b=q(b);return new Q(this.n*b.d+b.n*this.d,this.d*b.d);}
  sub(b){b=q(b);return new Q(this.n*b.d-b.n*this.d,this.d*b.d);}
  mul(b){b=q(b);return new Q(this.n*b.n,this.d*b.d);}
  div(b){b=q(b);return new Q(this.n*b.d,this.d*b.n);}
  cmp(b){b=q(b);const z=this.n*b.d-b.n*this.d;return z<0n?-1:z>0n?1:0;}
  toString(){return this.d===1n?`${this.n}`:`${this.n}/${this.d}`;}
  toJSON(){return this.toString();}
  number(){return Number(this.n)/Number(this.d);}
}
export function q(v){if(v instanceof Q)return v; if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('use rational strings, not floats');const s=String(v).split('/');if(s.length>2)throw Error('rational');return new Q(s[0],s[1]??1);}
const min=(a,b)=>q(a).cmp(b)<=0?q(a):q(b), max=(a,b)=>q(a).cmp(b)>=0?q(a):q(b);
const nonnegative=(x)=>{x=q(x);if(x.cmp(0)<0)throw Error('negative');return x;};
export const K5=q('79/50'), KW=q('53/100'), SHORT_IN_WEEK=q(100).mul(KW).div(K5);
export function budget(lambda,j){if(![10,4,2].includes(lambda)||!Number.isSafeInteger(j)||j<1)throw Error('ledger index/dial');return q(1).div(q(lambda).mul(j).mul(q(j).add(1)));}
export function validate(atoms){if(!atoms.length)throw Error('empty law');let mass=q(0);for(const a of atoms){mass=mass.add(nonnegative(a.p));nonnegative(a.d);}if(mass.cmp(1))throw Error('law mass');return atoms;}
// Demand may exceed R: loss is incremental, never raw unmet demand.
export function scalarLoss(d,R,x){d=nonnegative(d);R=nonnegative(R);x=nonnegative(x);if(x.cmp(R)>0)throw Error('loan');return min(d,R).sub(min(d,R.sub(x)));}
// Atoms here have scalar demand d; chance means predictive exceedance, not loss at x=0.
export function chooseScalar(atoms,R,lambda,eta=null){validate(atoms);R=nonnegative(R);if(![2,4,10].includes(lambda))throw Error('lambda');if(eta!==null&&(q(eta).cmp(0)<0||q(eta).cmp(1)>=0))throw Error('eta');const risk0=atoms.reduce((s,a)=>s.add(q(a.d).cmp(R)>0?a.p:0),q(0)); let best={x:q(0),loss:q(0),gain:q(0),J:q(0),risk:risk0,predictiveFeasible:eta===null||risk0.cmp(eta)<=0};
 const candidates=[q(0),R,...atoms.map(a=>max(0,min(R,R.sub(a.d))))];
 for(const x of candidates){const loss=atoms.reduce((s,a)=>s.add(q(a.p).mul(scalarLoss(a.d,R,x))),q(0));const risk=atoms.reduce((s,a)=>s.add(q(a.d).cmp(R.sub(x))>0?a.p:0),q(0));const J=x.sub(loss.mul(lambda));if(eta!==null&&risk.cmp(eta)>0)continue;if(J.cmp(best.J)>0||J.cmp(best.J)===0&&loss.cmp(best.loss)<0)best={x,loss,gain:x.sub(loss),J,risk,predictiveFeasible:true};}
 return best;}
// Total weekly target law plus maximally packed sessions, uniformly injected in slots.
// Projection onto one selected current slot; hidden full trajectories are NOT independent slots.
export function packedProjection(totalLaw=Array.from({length:101},(_,d)=>({d,p:'1/101'})),slots=34){validate(totalLaw);if(!Number.isSafeInteger(slots)||slots<1)throw Error('slots');const out=[];for(const a of totalLaw){let left=q(a.d);if(left.cmp(100)>0)throw Error('bounded-total model');const marks=[];while(left.cmp(0)>0){const m=min(left,SHORT_IN_WEEK);marks.push(m);left=left.sub(m);}if(marks.length>slots)throw Error('not enough distinct slots');out.push({p:q(a.p).mul(q(slots-marks.length).div(slots)),week:q(a.d),short:q(0)});for(const m of marks)out.push({p:q(a.p).div(slots),week:q(a.d),short:m});}return out.filter(a=>a.p.cmp(0)>0);}
export function jointAsScalar(atoms){return atoms.map(a=>{const w=nonnegative(a.week),s=nonnegative(a.short);if(w.cmp(100)>0||s.cmp(SHORT_IN_WEEK)>0||s.cmp(w)>0)throw Error('baseline feasibility');const safe=min(q(100).sub(w),SHORT_IN_WEEK.sub(s));return {p:a.p,d:SHORT_IN_WEEK.sub(safe)};});}
export function chooseJoint(atoms,lambda,eta=budget(lambda,1)){const r=chooseScalar(jointAsScalar(atoms),SHORT_IN_WEEK,lambda,eta);return {...r,shortDebit:r.x.mul(K5).div(KW),weekReserve:q(100).sub(r.x),shortReserve:q(100).sub(r.x.mul(K5).div(KW))};}
export function evaluateJoint(atoms,x,lambda){x=nonnegative(x);if(x.cmp(SHORT_IN_WEEK)>0||![2,4,10].includes(lambda))throw Error('action');const law=validate(jointAsScalar(atoms));const loss=law.reduce((s,a)=>s.add(q(a.p).mul(scalarLoss(a.d,SHORT_IN_WEEK,x))),q(0));const risk=x.cmp(0)===0?q(0):law.reduce((s,a)=>s.add(q(a.d).cmp(SHORT_IN_WEEK.sub(x))>0?a.p:0),q(0));return {x,loss,risk,gain:x.sub(loss),J:x.sub(loss.mul(lambda))};}
export function profiles(){return {light:packedProjection([{d:10,p:1}]),heavy:packedProjection([{d:90,p:1}]),bursty:packedProjection([{d:10,p:'4/5'},{d:100,p:'1/5'}]),idleThenBurst:[{p:q(1),week:q(100),short:SHORT_IN_WEEK}]};}
// Exact deterministic whole-percent observation kernel, normalized resource cap 100.
// Explicit rounding only: no inference of provider rounding semantics.
export function meter(value,rounding='floor'){value=nonnegative(value);if(value.cmp(100)>0)throw Error('meter exceeds cap');let n;if(rounding==='floor')n=value.n/value.d;else if(rounding==='nearest'){const shifted=value.add('1/2');n=shifted.n/shifted.d;}else if(rounding==='ceil')n=(value.n+value.d-1n)/value.d;else throw Error('unknown rounding');return Number(n);}
// Complete path hypotheses supply their actual charged trajectories under ALL past actions.
// Kernel is evaluated jointly: never multiply marginal probabilities of cumulative polls.
export function posterior(paths,polls,{rounding='floor'}={}){if(!paths.length)throw Error('empty paths');let initial=q(0);const weighted=paths.map(path=>{initial=initial.add(nonnegative(path.p));let p=q(path.p);for(const poll of polls){if(poll.missing)continue;if(!Number.isInteger(poll.reading)||poll.reading<0||poll.reading>100)throw Error('reading');const v=path.charged[poll.key];if(v===undefined)throw Error('missing predicted charge');if(meter(v,rounding)!==poll.reading)p=q(0);}return {...path,p};});if(initial.cmp(1))throw Error('prior mass');const z=weighted.reduce((s,a)=>s.add(a.p),q(0));if(z.cmp(0)===0)throw Error('model incompatible: zero evidence');return weighted.filter(a=>a.p.cmp(0)>0).map(a=>({...a,p:a.p.div(z)}));}
// Used only to illustrate censoring: no automatic claim that provider serves partially.
export function chargedDivisible(d,available){return min(nonnegative(d),nonnegative(available));}
// Safe carry-forward with a proved lower bound on latent demand since issuance.
export function carriedReserve(reserve,latentIncrementLower){return max(0,nonnegative(reserve).sub(nonnegative(latentIncrementLower)));}
// In-memory research ledger; real deployment must persist atomically before authorizing.
export class Ledger {constructor(lambda){budget(lambda,1);this.lambda=lambda;this.next=1;this.spent=q(0);}issue(){const eta=budget(this.lambda,this.next++);this.spent=this.spent.add(eta);return eta;}}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){for(const [name,atoms] of Object.entries({default:packedProjection(),...profiles()})){for(const lambda of [10,4,2]){const un=chooseJoint(atoms,lambda,null),bounded=chooseJoint(atoms,lambda);const week=chooseScalar(atoms.map(a=>({p:a.p,d:a.week})),100,lambda);const short=chooseScalar(atoms.map(a=>({p:a.p,d:a.short.mul(K5).div(KW)})),100,lambda);console.log(JSON.stringify({name,lambda,eta:budget(lambda,1),week,short,jointObjective:un,jointBand:bounded}));}}}
