import {MEASURED_LABEL} from '../../lib/v1/lending-kappa-measure.mjs';

// Lending converts only with the lent account's own measurement. Tests about other admission facts give every source a
// measurement bound to the account it asks for. The measured rate (1) is below every shipped bound, so the shipped
// bound for the window applies as the floor.
export const ownMeasurement = query => query?.account_id ? {upper_micro:1, lower_micro:null,
  binding:{account_sha256_16:query.account_id}, provenance:{method:'test measurement', label:MEASURED_LABEL}} : null;

export const withOwnMeasurement = real => ({...real,
  createRealPace50Source:options => real.createRealPace50Source({kappaForUsage:ownMeasurement, ...options})});
