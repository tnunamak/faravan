export function updatesVM(data={}, checkFailed=false) {
  const managed=data.owner!=='faravan';
  let explanation=data.owner==='apt'?'Managed by apt. Install updates with your system package manager.':data.owner==='brew'?'Managed by Homebrew. Install updates with Homebrew.':data.owner==='disabled'?'Automatic updates are turned off on this computer.':managed?'Update management is unknown for this build.':'Updates install by themselves between jobs.';
  let headline='Update status unknown';
  if(data.state==='checking')headline='Checking for updates…';
  if(data.state==='current')headline='You’re up to date';
  if(data.state==='available')headline=data.candidate?'Faravan '+data.candidate+' is available':'An update is available';
  if(data.state==='managed')headline='Updates managed outside Faravan';
  if(data.state==='rolled_back'){headline='Your previous version was kept';if(!managed)explanation='The update was rolled back. Your previous version is still running.';}
  if(data.state==='staged')headline=data.waitingFor?'Updating after '+data.waitingFor+'’s job':'Update ready · waiting until this computer is free';
  if(data.state==='applied'||data.state==='restarting')headline='Faravan is restarting';
  if(headline==='Update status unknown'&&!managed)explanation='Update status is not available. Check now to try again.';
  if(checkFailed||data.error) {
    headline='Update status unknown';
    explanation='We couldn’t check for updates. Your installed version is still running. Try again.';
  }
  return {headline,explanation,canCheck:!managed&&!['applied','restarting'].includes(data.state),pending:data.state==='checking'&&!checkFailed&&!data.error,error:data.error??null};
}
