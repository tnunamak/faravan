// The app's one date and time formatter (PRODUCT-UX-FIELD-RESEARCH §14.1). Every visible time goes through here, so
// a time is spelled the same way on every page. Dates follow the browser's language (navigator.language) even while
// the copy around them is English; the zone defaults to this computer's. Invalid input or an unknown zone gives ''
// — never "Invalid Date" on screen.
export const FALLBACK_LOCALE = 'en-US';
export function uiLocale(language = globalThis.navigator?.language) {
  try { return language && Intl.DateTimeFormat.supportedLocalesOf(language).length ? language : FALLBACK_LOCALE; }
  catch { return FALLBACK_LOCALE; }
}
const STYLES = Object.freeze({
  clock: {hour: 'numeric', minute: '2-digit'},
  clockSeconds: {hour: 'numeric', minute: '2-digit', second: '2-digit'},
  clock24: {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'},
  // A sortable calendar-day key (YYYY-MM-DD), for "is it today?" comparisons; not display text.
  dayKey: {year: 'numeric', month: '2-digit', day: '2-digit', locale: 'en-CA'},
  monthDay: {month: 'short', day: 'numeric'},
  monthDayLong: {month: 'long', day: 'numeric'},
  monthDayYear: {month: 'short', day: 'numeric', year: 'numeric'},
  weekday: {weekday: 'long'},
  weekdayDate: {weekday: 'short', month: 'short', day: 'numeric'},
  weekdayDateYear: {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'},
  weekdayDayMonth: {weekday: 'long', day: 'numeric', month: 'long'},
  numericDate: {year: 'numeric', month: 'numeric', day: 'numeric'},
  dateClock: {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'},
  longDate: {dateStyle: 'long'},
  // Decisions and records: the exact local time with its zone, as visible text.
  exact: {year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'},
  decision: {year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'},
});
const cache = new Map();
const zoneOf = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };
const ms = value => value instanceof Date ? value.valueOf() : typeof value === 'number' ? value
  : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;

function formatter(style, zone, language) {
  const spec = STYLES[style];
  if (!spec) return null;
  const key = style + '|' + (zone ?? '') + '|' + language;
  if (!cache.has(key)) {
    const {locale = language, ...options} = spec;
    try { cache.set(key, new Intl.DateTimeFormat(locale, {...options, ...(zone ? {timeZone: zone} : {})})); }
    catch { cache.set(key, null); }
  }
  return cache.get(key);
}

/** `style` is one of STYLES; `zone` an IANA zone (default: this computer's); `locale` defaults to the browser's. */
export function formatDate(value, style, {zone = zoneOf(), locale = uiLocale()} = {}) {
  const at = ms(value), format = Number.isFinite(at) ? formatter(style, zone, uiLocale(locale)) : null;
  try { return format ? format.format(at) : ''; } catch { return ''; }
}

/** The named parts ({weekday, day, month, ...}) for copy that orders them itself. */
export function dateParts(value, style, {zone = zoneOf(), locale = uiLocale()} = {}) {
  const at = ms(value), format = Number.isFinite(at) ? formatter(style, zone, uiLocale(locale)) : null;
  try { return format ? Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value])) : {}; } catch { return {}; }
}

const UNITS = [['year', 31536000000], ['month', 2592000000], ['week', 604800000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]];
const relatives = new Map();
/** "5 minutes ago", "in 2 hours", "yesterday"; under a minute is "now" (in the browser's language). */
export function formatRelative(value, {now = Date.now(), locale = uiLocale()} = {}) {
  const at = ms(value);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const language = uiLocale(locale);
  if (!relatives.has(language)) relatives.set(language, new Intl.RelativeTimeFormat(language, {numeric: 'auto'}));
  const relative = relatives.get(language);
  const delta = at - now;
  for (const [unit, size] of UNITS) if (Math.abs(delta) >= size) return relative.format(Math.round(delta / size), unit);
  return relative.format(0, 'second');
}

/** A deadline's calendar day in the viewing zone. Calendar arithmetic keeps "tomorrow" correct across DST. */
export function formatDayTime(value, {now = Date.now(), zone = zoneOf(), locale = uiLocale()} = {}) {
  const options = {zone, locale}, clock = formatDate(value, 'clock', options);
  const day = at => {
    const {year, month, day} = dateParts(at, 'dayKey', options);
    return year && month && day ? Date.UTC(Number(year), Number(month) - 1, Number(day)) : NaN;
  };
  const delta = (day(value) - day(now)) / 86400000;
  if (!clock || !Number.isFinite(delta)) return '';
  if (delta === 0) return clock + ' today';
  if (delta === 1) return 'tomorrow ' + clock;
  if (delta === -1) return 'yesterday ' + clock;
  return formatDate(value, 'monthDayYear', options) + ' at ' + clock;
}
