import {problemView} from './problem-catalog.mjs';

export function sessionRecovery(phone = false, localApp = true) {
  const context={surface:phone?'phone':'desktop',capabilities:{localApp}};
  const recovery=problemView({code:'unauthorized'},context);
  return {headline:recovery.title,text:recovery.detail,failureText:problemView({code:'app_load_failed'},context).detail};
}
// Generate the self-contained bootstrap callback from catalog values. No imports
// or duplicate copy have to run before the authenticated app bundle can load.
const views={phone:sessionRecovery(true,false),desktop:sessionRecovery(false,true),remote:sessionRecovery(false,false)};
export const recoveryBootstrapSource='(phone,localApp)=>('+JSON.stringify(views)+')[phone?"phone":localApp?"desktop":"remote"]';
