// Legacy region utilities. Setup no longer asks for a country; old local policies still accept the field.
// telemetry-regions.test.mjs keeps the compatibility default aligned with consent.mjs.

// Retained for callers of the old region UI; launch policy no longer asks for a region.
export const ASK_FIRST_REGIONS = Object.freeze([]);

// The 249 ISO 3166-1 alpha-2 codes. Names come from Intl.DisplayNames. The browser's own region list also holds
// legacy codes (such as UK, which is not GB) and groupings (EU, UN), so the codes are listed here.
export const REGION_CODES = Object.freeze([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE',
  'BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CC','CD',
  'CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM',
  'DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM','HN','HR','HT','HU',
  'ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN',
  'KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME',
  'MF','MG','MH','MK','ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM',
  'PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI',
  'SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK',
  'TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'
]);

export const isRegionCode = value => typeof value === 'string' && /^[A-Z]{2}$/.test(value);
/** Compatibility with the old first-run model; the launch policy always defaults to diagnostics after disclosure. */
export const asksFirst = () => false;

/** [{code, name}] sorted by name for a <select>. Falls back to the code where the browser has no name. */
export function regionOptions(locales = undefined, codes = REGION_CODES) {
  let names = null;
  try { names = new Intl.DisplayNames(locales, {type: 'region', fallback: 'none'}); } catch { /* no DisplayNames: show codes */ }
  const collator = new Intl.Collator(locales);
  return codes.map(code => ({code, name: names?.of(code) ?? code})).sort((a, b) => collator.compare(a.name, b.name));
}
