// Standalone binary64 research arithmetic. Not interval-certified or live admission.
// No I/O, providers, empirical calibration, implicit coercion, or persistent ledger.
function num(x,n,min=0){if(typeof x!=='number'||!Number.isFinite(x)||x<min)throw new TypeError(n);return x;}
function pos(x,n){num(x,n);if(x===0)throw new TypeError(n);return x;}
function prob(x,n){pos(x,n);if(x>=1)throw new TypeError(n);return x;}
function obj(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw new TypeError('record');for(const k of keys)if(!Object.hasOwn(x,k))throw new TypeError('missing '+k);return x;}
function dense(x){if(!Array.isArray(x)||x.length===0||x.length>10000)throw new TypeError('dense nonempty array');for(let i=0;i<x.length;i++)if(!Object.hasOwn(x,i))throw new TypeError('array hole/inherited entry');return x;}
function shape(x,n){pos(x,n);if(x>10000||x<1e-8)throw new RangeError(n+' outside tested numerical domain');return x;}
function safe(x){if(!Number.isFinite(x))throw new RangeError('numeric overflow');return x;}
export function logGamma(z){shape(z,'gamma argument');const c=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];if(z<.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);z--;let x=.99999999999980993;for(let i=0;i<c.length;i++)x+=c[i]/(z+i+1);let t=z+7.5;return .9189385332046727+(z+.5)*Math.log(t)-t+Math.log(x);}
function cf(a,b,x){let qab=a+b,qap=a+1,qam=a-1,c=1,d=1-qab*x/qap;const tiny=1e-300;if(Math.abs(d)<tiny)d=tiny;d=1/d;let h=d;for(let m=1;m<=10000;m++){let m2=2*m,aa=m*(b-m)*x/((qam+m2)*(a+m2));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;h*=d*c;aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;let del=d*c;h*=del;if(Math.abs(del-1)<3e-14)return h;}throw new RangeError('beta convergence');}
export function betaI(x,a,b){num(x,'x');if(x>1)throw new TypeError('x');shape(a,'a');shape(b,'b');if(a+b>10000)throw new RangeError('shape sum');if(x===0||x===1)return x;let bt=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));let v=x<(a+1)/(a+b+2)?bt*cf(a,b,x)/a:1-bt*cf(b,a,1-x)/b;if(!Number.isFinite(v)||v< -1e-12||v>1+1e-12)throw new RangeError('beta numeric');return Math.max(0,Math.min(1,v));}
// Two observation kinds share one update. exact_latent is exact owner usage (paper 06 Theorem 1). rounded_upper_surrogate is a
// whole-point meter reading taken at its upper end r + v, a conservative stand-in for any usage below r + v (paper 06 section 5).
export function posterior(record){obj(record,['alpha','b','exposure','usage','observation']);const {alpha,b,exposure,usage,observation}=record;shape(alpha,'alpha');pos(b,'b');num(exposure,'exposure');num(usage,'usage');if(observation!=='exact_latent'&&observation!=='rounded_upper_surrogate')throw new TypeError('conjugacy requires exact latent usage or a rounded upper surrogate');if(exposure===0&&usage!==0||exposure>0&&usage===0)throw new TypeError(observation==='exact_latent'?'impossible exact Gamma observation':'impossible rounded Gamma observation');shape(alpha+exposure,'posterior alpha');return {alpha:alpha+exposure,b:safe(b+usage)};}
function law(p){obj(p,['k','alpha','b']);num(p.k,'k');shape(p.alpha,'alpha');pos(p.b,'b');if(p.k>0){shape(p.k,'k');if(p.k+p.alpha>9998)throw new RangeError('shape sum');}return p;}
// Preserve both beta coordinates and their logarithms; never form 1-z near z=0.
function coordinates(d,b){const ratio=safe(d/b),logRatio=ratio>0?Math.log(ratio):Math.log(d)-Math.log(b);return {z:ratio/(1+ratio),y:1/(1+ratio),lz:logRatio-Math.log1p(ratio),ly:-Math.log1p(ratio)};}
function betaLog(z,y,lz,ly,a,b){
  shape(a,'a');shape(b,'b');if(a+b>10000)throw new RangeError('shape sum');
  const bt=logGamma(a+b)-logGamma(a)-logGamma(b)+a*lz+b*ly;
  let v;
  if(z<(a+1)/(a+b+2))v=bt+Math.log(cf(a,b,z))-Math.log(a);
  else {const other=bt+Math.log(cf(b,a,y))-Math.log(b);if(other>1e-12)throw new RangeError('beta numeric');v=Math.log(-Math.expm1(Math.min(0,other)));}
  if(Number.isNaN(v)||v>1e-12)throw new RangeError('beta numeric');return Math.min(0,v);
}
function tailAt(d,p){const {z,y,lz,ly}=coordinates(d,p.b);return safe(Math.exp(betaLog(y,z,ly,lz,p.alpha,p.k)));}
export function survival(d,p){law(p);num(d,'d');if(p.k===0)return 0;if(d===0)return 1;return tailAt(d,p);}
// Log-demand bisection resolves tiny positive quantiles without an absolute cutoff.
// Endpoints bracket the COMPUTED tail only, not an interval certificate.
export function quantile(p,eta){
  law(p);prob(eta,'eta');if(p.k===0)return 0;
  if(p.k===1){const out=safe(p.b*Math.expm1(-Math.log(eta)/p.alpha));if(out===0)throw new RangeError('quantile underflow');return out;}
  let lo=Math.log(Number.MIN_VALUE),hi=Math.log(Number.MAX_VALUE);
  // The upper representable demand may have an unsupported ratio; bracket first
  // around b, extending only as far as needed by this quantile.
  let left=p.b,right=p.b;
  if(survival(p.b,p)>eta){for(let i=0;survival(right,p)>eta;i++){if(i>1074)throw new RangeError('quantile bracket');left=right;right=safe(right*2);}lo=Math.log(left);hi=Math.log(right);}
  else {for(let i=0;survival(left,p)<=eta;i++){right=left;left/=2;if(left===0)throw new RangeError('quantile underflow');if(i>1074)throw new RangeError('quantile bracket');}lo=Math.log(left);hi=Math.log(right);}
  for(let i=0;i<160;i++){const mid=lo+(hi-lo)/2;if(mid===lo||mid===hi)break;if(survival(Math.exp(mid),p)>eta)lo=mid;else hi=mid;}
  const out=safe(Math.exp(hi));if(out===0)throw new RangeError('quantile underflow');return out;
}
function bounded(v,cap,label){safe(v);if(cap===0?v!==0:v/cap< -1e-12||v/cap>1+1e-12)throw new RangeError(label+' numeric bounds');return Math.max(0,Math.min(cap,v));}
export function cappedMean(r,p){
  law(p);num(r,'r');if(r===0||p.k===0)return 0;if(p.alpha<=1)throw new RangeError('cappedMean implementation requires alpha>1');
  const ratio=safe(r/p.b);let fraction;
  if(p.k===1){const t=Math.log1p(ratio),v=safe((p.alpha-1)*t);fraction=ratio===0?1:(v===0?1:-Math.expm1(-v)/v)*(t/ratio);}
  else {const {z,y,lz,ly}=coordinates(r,p.b),logFirst=Math.log(p.k)-Math.log(p.alpha-1)+Math.log(p.b)-Math.log(r)+betaLog(z,y,lz,ly,p.k+1,p.alpha-1);fraction=Math.exp(logFirst)+survival(r,p);}
  return safe(r*bounded(fraction,1,'capped mean'));
}
export function loss(R,x,p){
  num(R,'R');num(x,'x');if(x>R)throw new TypeError('x');law(p);if(x===0)return 0;
  const upper=cappedMean(R,p),lower=cappedMean(R-x,p);
  // Avoid subtraction of nearly equal capped means for narrow lending intervals.
  const v=x<R*1e-5?x*integral(t=>survival(R-x+x*t,p),0,1,1e-12):safe(upper-lower);
  return bounded(v,x,'loss');
}
export function action(record){obj(record,['R','lambda','law','eta']);const {R,lambda,law:p,eta}=record;num(R,'R');if(![10,4,2].includes(lambda))throw new TypeError('lambda');law(p);if(eta!==null)prob(eta,'eta');const economicReserve=quantile(p,1/lambda),band=eta===null?0:quantile(p,eta),reserve=Math.max(economicReserve,band),x=Math.max(0,R-reserve);const L=safe(loss(R,x,p)),cost=safe(lambda*L),J=safe(x-cost);return {loan:J>0?x:0,loss:J>0?L:0,J:J>0?J:0,economicReserve,band,predictiveFeasible:eta===null||band<=R,label:'declared-model research only'};}
export function logMixture(record){obj(record,['candidate','exposure','usage','alpha','b']);const {candidate:q,exposure:a,usage:u,alpha,b}=record;pos(q,'candidate');num(a,'exposure');num(u,'usage');shape(alpha,'alpha');pos(b,'b');if(a===0){if(u!==0)throw new TypeError('origin');return 0;}if(u===0)throw new TypeError('zero exact usage');shape(alpha+a,'combined shape');return safe(alpha*Math.log(b)+logGamma(alpha+a)-logGamma(alpha)-(alpha+a)*Math.log(b+u)+q*u-a*Math.log(q));}
// Lower confidence endpoint for inverse-scale beta: small beta means high demand.
export function rateLower(record){obj(record,['exposure','usage','alpha','b','delta']);const {exposure:a,usage:u,alpha,b,delta}=record;prob(delta,'delta');logMixture({candidate:1,exposure:a,usage:u,alpha,b});if(a===0)return 0;let lo=0,hi=a/u;const threshold=-Math.log(delta);if(logMixture({candidate:hi,exposure:a,usage:u,alpha,b})>threshold)throw new RangeError('empty CS/numerical failure');for(let i=0;i<200;i++){let mid=lo+(hi-lo)/2;if(mid===lo||mid===hi)break;if(logMixture({candidate:mid,exposure:a,usage:u,alpha,b})>=threshold)lo=mid;else hi=mid;}return lo;}
// Gamma Chernoff future bound avoids a second special-function inverse.
export function gammaUpper(k,beta,eta){num(k,'k');num(beta,'beta');prob(eta,'eta');if(k===0)return 0;if(beta===0)return Infinity;const z=-Math.log(eta);return safe((k+Math.sqrt(2*k*z)+z)/beta);}
export function budget(lambda,h,j,mode){if(![10,4,2].includes(lambda)||!['bayes','frequentist'].includes(mode))throw new TypeError('dial/mode');for(const n of [h,j])if(!Number.isSafeInteger(n)||n<1||n>1e6)throw new TypeError('index');const e=1/lambda/(h*(h+1));return {delta:mode==='frequentist'?e/2:0,eta:e/(j*(j+1))*(mode==='frequentist'?.5:1)};}
export function carry(rows,usage){dense(rows);num(usage,'usage');let out=Infinity;for(const r of rows){obj(r,['reserve','usageAtIssue']);num(r.usageAtIssue,'usageAtIssue');if(r.usageAtIssue>usage)throw new TypeError('nonmonotone usage');if(r.reserve!==Infinity)num(r.reserve,'reserve');out=Math.min(out,r.reserve===Infinity?Infinity:Math.max(0,r.reserve-(usage-r.usageAtIssue)));}return out;}
// Pure continuous cost-ray intersection. Unknown/negative spare is not repaired.
export function chunk(resources){dense(resources);let size=Infinity;for(const r of resources){obj(r,['remaining','reserve','rate']);num(r.remaining,'remaining');pos(r.rate,'rate');if(r.reserve!==Infinity)num(r.reserve,'reserve');size=Math.min(size,r.reserve===Infinity?0:safe(Math.max(0,r.remaining-r.reserve)/r.rate));}return size;}
// Exact analytic Lomax mixture scenarios; all means/laws declared, not fitted.
export function scenario(name){const rows={light:[{w:1,b:10}],heavy:[{w:1,b:90}],bursty:[{w:.8,b:10},{w:.2,b:100}]};if(!Object.hasOwn(rows,name))throw new TypeError('scenario');return rows[name];}
export function scenarioAction(name,lambda,R=100,eta=null){num(R,'R');if(![10,4,2].includes(lambda))throw new TypeError('lambda');if(eta!==null)prob(eta,'eta');const rows=scenario(name),tail=d=>rows.reduce((s,r)=>s+r.w*(r.b/(r.b+d))**2,0);let lo=0,hi=100;const target=Math.min(1/lambda,eta??1);while(tail(hi)>target)hi=safe(hi*2);for(let i=0;i<160;i++){let mid=(lo+hi)/2;if(mid===lo||mid===hi)break;if(tail(mid)>target)lo=mid;else hi=mid;}const q=hi,x=Math.max(0,R-q),L=rows.reduce((s,r)=>s+r.w*r.b*r.b*(1/(r.b+R-x)-1/(r.b+R)),0);return {reserve:q,loan:x,loss:L,gain:x-L,J:x-lambda*L,exceedance:tail(R-x),predictiveFeasible:eta===null||tail(R)<=eta};}
function integral(f,a,b,tol=1e-10){if(a===b)return 0;const fa=f(a),fb=f(b),m=(a+b)/2,fm=f(m),whole=(b-a)*(fa+4*fm+fb)/6;function rec(a,b,fa,fm,fb,old,tol,n){const m=(a+b)/2,l=(a+m)/2,r=(m+b)/2,fl=f(l),fr=f(r),left=(m-a)*(fa+4*fl+fm)/6,right=(b-m)*(fm+4*fr+fb)/6,d=left+right-old;if(Math.abs(d)<=15*tol)return left+right+d/15;if(!n)throw new RangeError('quadrature convergence');return rec(a,m,fa,fl,fm,left,tol/2,n-1)+rec(m,b,fm,fr,fb,right,tol/2,n-1);}return rec(a,b,fa,fm,fb,whole,tol,24);}
// X=current short demand, W=X+Y=weekly demand; same latent beta, nested clocks.
export function nestedCdf(record){obj(record,['short','week','kShort','kLater','alpha','b']);const {short:s,week:w,kShort:k,kLater:l,alpha,b}=record;num(s,'short');num(w,'week');num(k,'kShort');num(l,'kLater');const p=law({k:k+l,alpha,b});if(k===0)return 1-survival(w,p);if(l===0)return 1-survival(Math.min(s,w),p);shape(k,'kShort');shape(l,'kLater');if(s===0||w===0)return 0;if(w<=s)return 1-survival(w,p);const logC=logGamma(k+l+alpha)-logGamma(k+l)-logGamma(alpha)-Math.log(b);const f=t=>Math.exp(logC+(k+l-1)*Math.log(t/b)-(k+l+alpha)*Math.log1p(t/b))*betaI(s/t,k,l);return Math.max(0,Math.min(1,1-survival(s,p)+integral(v=>{if(v===0)return 0;const L=Math.log(w/s),t=s*Math.exp(L*v**4);return f(t)*t*4*L*v**3;},0,1)));}
export function nestedAction(record){obj(record,['shortCapacity','weekCapacity','kShort','kLater','alpha','b','lambda','eta']);const {shortCapacity:C,weekCapacity:R,kShort,kLater,alpha,b,lambda,eta}=record;num(C,'shortCapacity');num(R,'weekCapacity');if(![10,4,2].includes(lambda))throw new TypeError('lambda');if(eta!==null)prob(eta,'eta');const cap=Math.min(C,R),cdf=x=>nestedCdf({short:C-x,week:R-x,kShort,kLater,alpha,b}),risk=x=>1-cdf(x),target=Math.min(1/lambda,eta??1);const initial=risk(0);let x=0;if(initial<target){let lo=0,hi=cap;for(let i=0;i<60;i++){const m=(lo+hi)/2;if(risk(m)<=target)lo=m;else hi=m;}x=lo;}const L=integral(risk,0,x,1e-7);return {loan:x,loss:L,gain:x-L,J:x-lambda*L,risk:risk(x),baselineExceedance:initial,predictiveFeasible:eta===null||initial<=eta};}
export function scenarioNestedAction(name,lambda,eta=null){if(![10,4,2].includes(lambda))throw new TypeError('lambda');if(eta!==null)prob(eta,'eta');const rows=scenario(name),C=2650/79,R=100,risk=x=>1-rows.reduce((s,r)=>s+r.w*nestedCdf({short:C-x,week:R-x,kShort:5/168,kLater:163/168,alpha:2,b:r.b}),0),initial=risk(0),target=Math.min(1/lambda,eta??1);let x=0;if(initial<target){let lo=0,hi=C;for(let i=0;i<60;i++){let m=(lo+hi)/2;if(risk(m)<=target)lo=m;else hi=m;}x=lo;}const L=integral(risk,0,x,1e-7);return {loan:x,shortDebit:x*158/53,loss:L,gain:x-L,J:x-lambda*L,risk:risk(x),baselineExceedance:initial,predictiveFeasible:eta===null||initial<=eta};}

// Epsilon-first event schedule; caller persists indices and sum of resource weights.
// Frequentist j=0 is the single CS failure event; Bayesian j=0 is a forecast.
// Unlike legacy budget(), this accepts an explicit predeclared resource weight.
export function riskBudget(epsilon,weight,j,mode){
  prob(epsilon,'epsilon');num(weight,'weight');if(weight>1)throw new TypeError('weight');
  if(!Number.isSafeInteger(j)||j<0||!Number.isSafeInteger(j+2))throw new TypeError('index');
  if(!['bayes','frequentist'].includes(mode))throw new TypeError('mode');
  const amount=epsilon*weight/(j+1)/(j+2);
  if(weight>0&&amount===0)throw new RangeError('budget underflow');
  return {event:mode==='frequentist'&&j===0?'confidence':'prediction',amount};
}
