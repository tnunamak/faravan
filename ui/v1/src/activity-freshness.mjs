export function activityFreshness({stale=false,error=null,role,headline='' }={}) {
  const old=stale||Boolean(error);
  return {stale:old,headline:old&&headline?'Last known: '+headline:headline,
    empty:error&&error.status!==409?'Faravan couldn’t load what the agent is doing.':
      old?'No agent updates are available yet. Current activity is unconfirmed.':role==='ran'?'Your agent is starting. Its first update will appear here.':'The agent is starting. Its first update will appear here.'};
}
