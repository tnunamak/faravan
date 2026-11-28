// Shared read-only workspace facts for synthetic sandbox backends.
export async function syntheticReadiness(backend,requirements,context={}) {
      const report=await backend.probeCapabilities(),capabilities=await backend.lenderCapabilities();
      const required=Object.keys(requirements.limits??{}).filter(k=>requirements.limit_modes?.[k]!=='preferred');
      const preferred=Object.keys(requirements.limits??{}).filter(k=>requirements.limit_modes?.[k]==='preferred');
      const enforced=capabilities.enforced_limits??[],unenforced=Object.keys(requirements.limits??{}).filter(k=>!enforced.includes(k));
      const satisfied=required.every(k=>enforced.includes(k)&&capabilities.max_limits?.[k]>=requirements.limits[k]);
      const sourceEnforceable=!(context.source?.kind==='git'&&requirements.egress==='provider-only')||
        context.providerHosts?.some(host=>host==='github.com'||host==='**.github.com')===true;
      const ready=report.available===true&&report.preflight?.ok===true&&capabilities.available===true;
      return {source:'read-only-preflight',backend_id:'synthetic-only',observed_at:new Date().toISOString(),
        sandbox_ready:ready,version_gate:{ok:true,status:'synthetic'},egress:{requested:requirements.egress,
          enforceable:capabilities.egress.includes(requirements.egress),source_enforceable:sourceEnforceable},limits:{required,preferred,enforced,unenforced,satisfied},
        satisfied:ready&&satisfied&&sourceEnforceable&&capabilities.egress.includes(requirements.egress),preflight:report.preflight};
    }
