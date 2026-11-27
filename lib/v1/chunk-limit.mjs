// A chunk size is chosen by the objective allocator. This module only applies the owner's total-spend cap and the request's own limit.
// Integer micro-dollars keep this boundary exact; headroom is subtracted after the gross limit is selected.
const micro = value => Number.isSafeInteger(value) && value >= 0;

export function chunkLimitUsdMicro({sizeUsdMicro, ownerLimitUsdMicro = null, jobLimitUsdMicro = null} = {}) {
  if (!micro(sizeUsdMicro) || sizeUsdMicro === 0 ||
      ownerLimitUsdMicro !== null && !micro(ownerLimitUsdMicro) ||
      jobLimitUsdMicro !== null && !micro(jobLimitUsdMicro)) return null;
  return Math.min(sizeUsdMicro, ownerLimitUsdMicro ?? Number.MAX_SAFE_INTEGER,
    jobLimitUsdMicro ?? Number.MAX_SAFE_INTEGER);
}
