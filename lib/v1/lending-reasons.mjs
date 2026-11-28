// Public lending outcomes. Backend diagnostics stay local; these are the words a person can act on.
export const LENDING_REASONS=Object.freeze({
 circle_access_refused:{kind:'wait',sentence:'The circle refused access. Check your circle membership and host address.',action:'Check circle membership'},
 platform_unsupported:{kind:'hold',sentence:'This computer cannot run the required sandbox.',action:'Use a supported computer'},
 local_state_unreadable:{kind:'hold',sentence:'This computer cannot read its lending history.',action:'Check lending details'},
 result_delivery_failed:{kind:'end',sentence:'The result could not be delivered.',action:'Check the saved job result'},
 job_ended:{kind:'end',sentence:'The job has already ended.',action:'Check the job result'},
 offer_taken:{kind:'end',sentence:'Another computer took this job.',action:'Wait for its result'},
 none:{kind:'none',sentence:'No lending hold applies.',action:'No action needed'},
 busy:{kind:'wait',sentence:'This computer is already running a job.',action:'Wait for the current job to finish'},
 circle_not_joined:{kind:'hold',sentence:'This computer has not joined a circle.',action:'Join or create a circle'},
 output_too_large:{kind:'end',sentence:'The job produced more output than allowed.',action:'Reduce the output and send the job again'},
 execution_failed:{kind:'end',sentence:'The job could not finish.',action:'Check the job result before trying again'},
 lending_off:{kind:'hold',sentence:'Lending is turned off.',action:'Turn lending on'},
 sandbox_cannot_start:{kind:'hold',sentence:'The sandbox cannot start on this computer.',action:'Open sandbox setup'},
 account_signed_out:{kind:'hold',sentence:'The agent account is signed out.',action:'Sign in to the account'},
 provider_limit_reached:{kind:'hold',sentence:'The agent account has reached its usage limit.',action:'Wait for the allowance to reset'},
 no_accounts:{kind:'hold',sentence:'No agent account is configured.',action:'Add an agent account'},
 outside_hours:{kind:'wait',sentence:'This computer is outside its lending hours.',action:'Wait for lending hours'},
 daily_limit:{kind:'wait',sentence:'This computer has reached its daily lending limit.',action:'Wait for the daily reset'},
 requester_limit:{kind:'wait',sentence:'This computer has reached its daily limit for this requester.',action:'Wait for the daily reset'},
 approval_pending:{kind:'wait',sentence:'The owner has not approved this job yet.',action:'Wait for approval'},
 owner_active:{kind:'wait',sentence:'The owner is using this computer.',action:'Wait for the computer to be idle'},
 cleanup_pending:{kind:'wait',sentence:'This computer is finishing sandbox cleanup.',action:'Wait for cleanup'},
 sandbox_check_pending:{kind:'wait',sentence:'The sandbox check has not finished.',action:'Wait for the next check'},
 circle_unreachable:{kind:'wait',sentence:'The circle cannot be reached.',action:'Wait for the circle to reconnect'},
 app_updating:{kind:'wait',sentence:'This computer needs an app update.',action:'Wait for the app to update'},
 lender_starting:{kind:'wait',sentence:'This computer is getting ready to lend.',action:'Wait for lending to start'},
 conditions_unavailable:{kind:'wait',sentence:'This computer is checking whether it can lend.',action:'Wait for the next check'},
 no_spare:{kind:'wait',sentence:'This account has no spare allowance now.',action:'Wait for spare allowance'},
 readiness_changed:{kind:'wait',sentence:'This computer needs to check its settings again.',action:'Wait for the next check'},
 cannot_run_here:{kind:'give_back',sentence:'This computer cannot run this job.',action:'Wait for another computer'},
 start_failed:{kind:'end',sentence:'The job could not start.',action:'Try the job again'},
 cancelled:{kind:'end',sentence:'The requester cancelled the job.',action:'Send a new job if needed'},
 job_expired:{kind:'end',sentence:'The job ran out of time.',action:'Send a new job'},
 stopped_by_lender:{kind:'end',sentence:'The owner stopped the job.',action:'Send a new job if needed'},
});
// Live backend causes and historical public codes. Only this mapping crosses into public lending reasons.
export const PRIVATE_LENDING_CAUSES=Object.freeze({
 cessation_unverified:'cleanup_pending',sandbox_cleanup_unverified:'cleanup_pending',stop_report_pending:'cleanup_pending',
 sandbox_not_ready:'sandbox_check_pending',agent_signed_out:'account_signed_out',agent_not_chosen:'lending_off',
 host_refused:'circle_access_refused',host_disk_low:'sandbox_cannot_start',host_disk_unreadable:'sandbox_check_pending',
 paused:'lending_off',off:'lending_off',lender_stopped:'lending_off',user_active:'owner_active',quota_reserve:'no_spare',owner_reserve:'no_spare',
 account_busy:'busy',lending_busy:'busy',machine_capacity:'busy',account_slots:'busy',native_attempt_in_flight:'no_spare',
 update_required:'app_updating',required_update:'app_updating',
 docker_signed_out:'sandbox_cannot_start',setup_required:'sandbox_cannot_start',guard_runtime_unavailable:'sandbox_cannot_start',
 docker_not_installed:'sandbox_cannot_start',docker_not_running:'sandbox_cannot_start',isolation_check_failed:'sandbox_cannot_start',
 no_ready_agent:'no_accounts',agent_not_ready:'no_accounts',native_credentials_owner_only:'cannot_run_here',
 reviewing_offer:'approval_pending',approval_unavailable:'approval_pending',approval_denied:'approval_pending',approval_skipped:'approval_pending',approval_timeout:'approval_pending',approval_expired:'approval_pending',
 observation_changed:'readiness_changed',standing_rule_changed:'readiness_changed',rule_changed:'readiness_changed',settings_conflict:'readiness_changed',policy_changed:'readiness_changed',
 machine_checking:'sandbox_check_pending',probe_deferred:'sandbox_check_pending',isolation_check_inconclusive:'sandbox_check_pending',
 wall_limit:'cannot_run_here',requirements_unsupported:'cannot_run_here',model_unavailable:'cannot_run_here',model_not_lendable:'cannot_run_here',
 model_unsupported:'cannot_run_here',git_unpinned:'cannot_run_here',host_too_old:'cannot_run_here',circle_update_needed:'cannot_run_here',policy_unenforceable:'cannot_run_here',limits_unenforceable:'cannot_run_here',too_large:'cannot_run_here',
 preparation_timeout:'cleanup_pending',preparation_failed:'start_failed',sandbox_start_failed:'start_failed',agent_error:'execution_failed',
 quota_unknown:'conditions_unavailable',meter_unavailable:'conditions_unavailable',refresh_failed:'conditions_unavailable',objective_evidence_unknown:'conditions_unavailable',
 resources_incomplete:'conditions_unavailable',stop_bound_unknown:'conditions_unavailable',window_not_open:'no_spare',
 lending_window_invalid:'conditions_unavailable',lending_window_missing:'conditions_unavailable',lending_window_memory_unreadable:'conditions_unavailable',
 account_week_mapping_unknown:'conditions_unavailable',conversion_unknown:'conditions_unavailable',confirming_surplus:'no_spare',rule_limit:'no_spare',
 invalid_counter_store:'local_state_unreadable',http_error:'result_delivery_failed',definitive_rejection:'result_delivery_failed',artifact_mismatch:'execution_failed',git_commit_unverified:'execution_failed',audit_unavailable:'conditions_unavailable',audit_failed:'conditions_unavailable',unavailable:'circle_unreachable',temporary_failure:'circle_unreachable',lease_expired_unproven:'cleanup_pending',
 wall_timeout:'job_expired',lease_expired:'execution_failed',expired:'job_expired',job_terminal:'job_ended',attempt_fenced:'job_ended',job_cancelled:'cancelled',conflict:'offer_taken',execution_observation_failed:'execution_failed',
 network_error:'circle_unreachable',offers_failed:'circle_unreachable',claim_failed:'circle_unreachable',
 invalid_response:'conditions_unavailable',completion_rejected:'execution_failed',internal_error:'conditions_unavailable',not_evaluated:'conditions_unavailable',
 invalid_projection:'conditions_unavailable',invalid_observation:'conditions_unavailable',contradictory_evidence:'conditions_unavailable',
 not_ready:'conditions_unavailable',lending_not_started:'conditions_unavailable',resume_failed:'conditions_unavailable',
});
export const LOW_DISK_DETAIL='This computer is low on disk space.';
export const LOW_DISK_ACTION=Object.freeze({id:'free_disk_space',label:'Free up disk space on this computer',target:{}});
export const lendingReasonCode=(code,fallback='conditions_unavailable')=>Object.hasOwn(LENDING_REASONS,code)?code:PRIVATE_LENDING_CAUSES[code]??fallback;
export const lendingReason=code=>LENDING_REASONS[lendingReasonCode(code)];
export function lendingReasonText(code,{until=null,nextAction=null,detail=null,formatTime=at=>new Date(at).toLocaleString()}={}){
 const row=lendingReason(code);
 return (detail??row.sentence)+(nextAction?.id==='free_disk_space'?' '+LOW_DISK_ACTION.label+'.':'')+
  (Number.isSafeInteger(until)?' Next check: '+formatTime(until)+'.':'');
}
// A changed offer or local rule is a give-back, never a failed sandbox start.
export function giveBackCode(code){
 if(code==='preparation_timeout')return 'cleanup_pending';
 if(['requirements_unsupported','model_unavailable','host_too_old','policy_unenforceable','limits_unenforceable','wall_limit','too_large'].includes(code))return 'cannot_run_here';
 if(['preparation_failed','sandbox_start_failed','execution_failed','agent_error'].includes(code))return 'start_failed';
 if(['approval_denied','approval_skipped','approval_timeout','approval_unavailable','approval_expired'].includes(code))return 'approval_pending';
 if(['standing_rule_changed','rule_changed','settings_conflict','policy_changed'].includes(code))return 'readiness_changed';
 if(['paused','stopped'].includes(code))return 'lending_off';
 if(['user_active'].includes(code))return 'owner_active';
 return lendingReasonCode(code);
}
