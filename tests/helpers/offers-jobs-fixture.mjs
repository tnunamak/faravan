import {appFixture as baseFixture} from './v1-app-fixture.mjs';
export * from './v1-app-fixture.mjs';

// Offer and job journeys use the real account broker with a synthetic provider.
export async function appFixture(t,options={}){
  const f=await baseFixture(t,options),start=f.start;
  f.start=(name='owner',extra={})=>start(name,{syntheticAccounts:true,...extra});
  return f;
}
