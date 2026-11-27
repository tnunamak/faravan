import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {formatDate, dateParts, formatRelative} from './dates.mjs';

// PRODUCT-UX-FIELD-RESEARCH §14.1: one date and time formatter. Lists use relative or short times; decisions show
// the exact local time with its zone as visible text.
const at = Date.parse('2026-10-20T20:04:05Z');

test('styles produce the app’s one spelling of each kind of time', () => {
  const zone = 'America/Chicago', locale = 'en-US';
  assert.equal(formatDate(at, 'clock', {zone, locale}), '3:04 PM');
  assert.equal(formatDate(at, 'clock24', {zone, locale}), '15:04');
  assert.equal(formatDate(at, 'clockSeconds', {zone, locale}), '3:04:05 PM');
  assert.equal(formatDate(at, 'dayKey', {zone, locale}), '2026-10-20');
  assert.equal(formatDate(at, 'monthDay', {zone, locale}), 'Oct 20');
  assert.equal(formatDate(at, 'monthDayLong', {zone, locale}), 'October 20');
  assert.equal(formatDate(at, 'weekday', {zone, locale}), 'Tuesday');
  assert.equal(formatDate(at, 'exact', {zone, locale}), 'Oct 20, 2026, 3:04 PM CDT');
  assert.equal(formatDate(at, 'decision', {zone, locale}), 'Oct 20, 2026, 03:04:05 PM CDT');
  assert.equal(formatDate(at, 'longDate', {zone, locale}), 'October 20, 2026');
  assert.equal(dateParts(at, 'weekdayDayMonth', {zone, locale}).weekday, 'Tuesday');
});

test('dates follow the browser language; an unknown or missing language falls back to en-US', async () => {
  const {uiLocale} = await import('./dates.mjs');
  const zone = 'Europe/Berlin';
  assert.equal(formatDate(at, 'clock', {zone, locale: 'de-DE'}), '22:04');
  assert.equal(formatDate(at, 'longDate', {zone, locale: 'de-DE'}), '20. Oktober 2026');
  assert.equal(formatRelative(at - 5 * 60_000, {now: at, locale: 'de-DE'}), 'vor 5 Minuten');
  assert.equal(formatDate(at, 'dayKey', {zone, locale: 'de-DE'}), '2026-10-20', 'the day key is not display text');
  assert.equal(uiLocale('de-DE'), 'de-DE');
  assert.equal(uiLocale(''), 'en-US');
  assert.equal(uiLocale('not a locale!'), 'en-US');
  assert.equal(uiLocale(undefined), 'en-US');
});

test('invalid input, unknown styles and bad zones give an empty string, never "Invalid Date"', () => {
  assert.equal(formatDate('nope', 'clock'), '');
  assert.equal(formatDate(null, 'clock'), '');
  assert.equal(formatDate(at, 'nope'), '');
  assert.equal(formatDate(at, 'clock', {zone: 'Not/AZone'}), '');
  assert.deepEqual(dateParts('nope', 'weekdayDayMonth'), {});
  assert.equal(formatDate(new Date(at).toISOString(), 'dayKey', {zone: 'UTC'}), '2026-10-20');
});

test('relative times read naturally', () => {
  assert.equal(formatRelative(at - 30_000, {now: at, locale: 'en-US'}), 'now');
  assert.equal(formatRelative(at - 5 * 60_000, {now: at}), '5 minutes ago');
  assert.equal(formatRelative(at + 2 * 3600_000, {now: at}), 'in 2 hours');
  assert.equal(formatRelative(at - 26 * 3600_000, {now: at}), 'yesterday');
  assert.equal(formatRelative('nope', {now: at}), '');
});

test('no other module builds its own date formatter', () => {
  const dir = new URL('./', import.meta.url);
  const offenders = readdirSync(dir).filter(name => /\.(mjs|jsx)$/.test(name) && !/\.test\./.test(name) && name !== 'dates.mjs')
    .filter(name => /new Intl\.(DateTimeFormat|RelativeTimeFormat)\(|\.toLocale(Date|Time)?String\(/.test(readFileSync(new URL(name, dir), 'utf8')
      .replace(/Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)/g, '')));
  assert.deepEqual(offenders, []);
});
