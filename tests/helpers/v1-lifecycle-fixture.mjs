import {appFixture as baseFixture} from './v1-app-fixture.mjs';
export * from './v1-app-fixture.mjs';

// Lifecycle journeys retain the account broker; provider and sandbox execution are synthetic.
export async function appFixture(t,options={}){
  const f=await baseFixture(t,options),start=f.start;
  f.start=(name='owner',extra={})=>start(name,{syntheticAccounts:true,idleReader:async()=>false,...extra});
  return f;
}
