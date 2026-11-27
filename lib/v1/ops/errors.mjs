// Only errors deliberately built for callers may carry explanatory messages across the local API boundary.
const publicErrors=new WeakSet();
export const isPublicError=error=>publicErrors.has(error);
export function opError(code,status,message,extra={}) {
  const error=Object.assign(new Error(message??code),{...extra,code,status});
  publicErrors.add(error);
  return error;
}
