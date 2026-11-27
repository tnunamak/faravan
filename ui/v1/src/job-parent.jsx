import {useResource} from './shared.jsx';
const digest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
export function ParentJobLink({parent,circle,api}) {
  const valid=Boolean(circle&&digest(parent?.job_digest)&&digest(parent?.result_digest));
  const state=useResource(api,valid&&api&&!parent.title?'jobs/'+encodeURIComponent(parent.job_digest)+'?circle='+encodeURIComponent(circle):null);
  if(!valid)return null;
  const title=parent.title||state.data?.local?.title||state.data?.title;
  return <p class="t-sm t-2 job-parent-link ph-no-capture" data-telemetry-private="job-parent">Follow-up to <a href={'#/job/'+encodeURIComponent(parent.job_digest)+'/'+encodeURIComponent(circle)}>{title||'the parent job…'}</a></p>;
}
