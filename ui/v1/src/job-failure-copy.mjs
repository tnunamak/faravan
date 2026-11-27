// Browser-safe display codes. failures.mjs imports node:crypto, so the parity
// regression checks this small list against its result_delivery classification.
export const RESULT_DELIVERY_FAILURE_CODES = Object.freeze([
  'candidate_missing','candidate_invalid','git_commit_unverified','git_commit_mismatch',
  'model_unverified','meter_unavailable','completion_rejected','result_not_delivered','result_kind_mismatch','git_failed',
  'output_path_invalid','output_copy_failed','output_missing','output_invalid','check_workspace_failed','check_workspace_mismatch',
]);
export const LENDER_INTERRUPTION_CODES = Object.freeze([
  'sandbox_crash','lender_failed','lender_stopped','restart_interrupted','sandbox_stop_failed','stop_report_pending',
]);
export function resultDeliveryCopy(code, phase, ownRun = false) {
  if (!RESULT_DELIVERY_FAILURE_CODES.includes(code)) return null;
  const computer = ownRun ? 'Your computer' : 'The lender’s computer';
  const cause = code === 'meter_unavailable' && phase === 'result'
    ? ' finished the work but could not send it back because its usage meter was unavailable.'
    : ' could not return a usable result.';
  return {headline:computer + ' could not send the work back',
    text:computer + cause + (ownRun ? ' Nothing was added to the sender’s code. The sender can send it again or choose another lender.'
      : ' Nothing was added to your code. You can send it again or choose another lender.')};
}
