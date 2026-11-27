// The owner retains the restart obligation until stop(), including a crash
// during startup. Platform service managers supervise this owner in turn.
export function superviseProcess({launch,shouldRestart=()=>true,delayMs=1000,maxDelayMs=30000,stopGraceMs=65000}) {
  let child,timer,killTimer,stopping=false,error,failures=0,resolveFinished;
  const finished=new Promise(resolve=>{resolveFinished=resolve;});
  const finish=code=>{clearTimeout(timer);clearTimeout(killTimer);resolveFinished(code);};
  function start() {
    if(stopping||!shouldRestart())return finish(0);
    const started=Date.now();
    error=null;
    try {child=launch();}catch(cause){error=cause;return retry(1,started);}
    child.once('error',cause=>{error=cause;});
    child.once('close',code=>retry(code,started));
  }
  function retry(code,started) {
    if(stopping||!shouldRestart())return finish(code);
    failures=Date.now()-started>30000?0:failures+1;
    timer=setTimeout(start,Math.min(maxDelayMs,delayMs*2**Math.max(0,Math.min(failures-1,10))));
  }
  start();
  return {get child(){return child;},get error(){return error;},finished,
    stop(signal='SIGTERM'){
      if(stopping)return finished;
      stopping=true;clearTimeout(timer);
      child?.stdin?.end();
      if(child?.pid&&child.exitCode===null&&child.signalCode===null){
        const target=child;
        target.kill(signal);
        // Allow the app's 60-second cleanup proof to drain, then bound a stuck child.
        if(signal!=='SIGKILL')killTimer=setTimeout(()=>{
          if(target.exitCode===null&&target.signalCode===null)target.kill('SIGKILL');
        },stopGraceMs);
      }
      else finish(0);
      return finished;
    }};
}
