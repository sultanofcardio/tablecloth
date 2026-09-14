import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_TIME_ZONE,
  canonicalTimeZone,
  localTimeZone,
  normalizeTimeZone,
  isImplicitTimeZone,
  sessionTimeZone,
  timeZoneNames,
  utcOffsetOf,
} from '../src/drivers/timeZone';

test('blank and Local mean the default, Server keeps the server setting', () => {
  assert.equal(normalizeTimeZone(undefined), undefined);
  assert.equal(normalizeTimeZone(''), undefined);
  assert.equal(normalizeTimeZone('  '), undefined);
  assert.equal(normalizeTimeZone('Local'), undefined);
  assert.equal(normalizeTimeZone('local'), undefined);
  assert.equal(normalizeTimeZone('Server'), SERVER_TIME_ZONE);
  assert.equal(normalizeTimeZone(' server '), SERVER_TIME_ZONE);
});

test('zone names are canonicalized and unknown ones are refused', () => {
  assert.equal(normalizeTimeZone('europe/london'), 'Europe/London');
  assert.equal(normalizeTimeZone('America/Jamaica'), 'America/Jamaica');
  assert.equal(normalizeTimeZone('utc'), 'UTC');
  assert.throws(() => normalizeTimeZone('Mars/Olympus_Mons'), /Unknown time zone "Mars\/Olympus_Mons"/);
  // settings.json is read leniently: the connect error names the bad value instead
  assert.equal(normalizeTimeZone('Mars/Olympus_Mons', { lenient: true }), 'Mars/Olympus_Mons');
  assert.equal(canonicalTimeZone('Nowhere/Land'), undefined);
});

test('the session zone follows the data source, SQLite has none', () => {
  assert.equal(sessionTimeZone({ driver: 'postgres', timeZone: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(sessionTimeZone({ driver: 'mysql', timeZone: SERVER_TIME_ZONE }), undefined);
  assert.equal(sessionTimeZone({ driver: 'postgres' }), localTimeZone());
  assert.equal(sessionTimeZone({ driver: 'sqlite', timeZone: 'Asia/Tokyo' }), undefined);
  assert.equal(isImplicitTimeZone({}), true);
  assert.equal(isImplicitTimeZone({ timeZone: 'Asia/Tokyo' }), false);
  assert.equal(isImplicitTimeZone({ timeZone: SERVER_TIME_ZONE }), false);
  assert.ok(localTimeZone().length > 0);
});

test('offsets are spelled the MySQL way and follow daylight saving', () => {
  assert.equal(utcOffsetOf('UTC'), '+00:00');
  assert.equal(utcOffsetOf('America/Jamaica'), '-05:00');
  assert.equal(utcOffsetOf('Asia/Kolkata'), '+05:30');
  assert.equal(utcOffsetOf('Europe/London', new Date('2026-07-01T12:00:00Z')), '+01:00');
  assert.equal(utcOffsetOf('Europe/London', new Date('2026-01-15T12:00:00Z')), '+00:00');
  assert.equal(utcOffsetOf('Pacific/Chatham', new Date('2026-01-15T12:00:00Z')), '+13:45');
});

test('the zone list starts with UTC and carries the runtime names', () => {
  const names = timeZoneNames();
  assert.equal(names[0], 'UTC');
  assert.ok(names.includes('America/Jamaica'));
  assert.ok(names.includes('Europe/London'));
  assert.equal(new Set(names).size, names.length);
});
