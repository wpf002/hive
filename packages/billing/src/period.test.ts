import test from 'node:test';
import assert from 'node:assert/strict';
import { periodBounds } from './period.js';

/**
 * Period boundaries decide which month a charge falls in, so an off-by-one
 * here moves real money between two invoices. They are pure arithmetic and
 * cheap to pin down; the parts that touch the database are exercised against
 * a real one in the integration suite.
 */

test('a period is the UTC month containing the instant', () => {
  const { start, end } = periodBounds(new Date('2026-03-17T12:34:56.000Z'));
  assert.equal(start.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-04-01T00:00:00.000Z');
});

test('the range is half-open, so no instant lands in two periods', () => {
  const march = periodBounds(new Date('2026-03-31T23:59:59.999Z'));
  const april = periodBounds(new Date('2026-04-01T00:00:00.000Z'));
  assert.equal(march.end.getTime(), april.start.getTime());
  assert.notEqual(march.start.getTime(), april.start.getTime());
});

test('December rolls into January of the next year', () => {
  const { start, end } = periodBounds(new Date('2026-12-09T00:00:00.000Z'));
  assert.equal(start.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('February in a leap year ends on the 1st of March, not the 29th', () => {
  const { end } = periodBounds(new Date('2028-02-15T00:00:00.000Z'));
  assert.equal(end.toISOString(), '2028-03-01T00:00:00.000Z');
});

test('boundaries are UTC regardless of the host timezone', () => {
  // A machine in UTC-5 asking about the 1st at 02:00 UTC must still get that
  // month, not the previous one — otherwise a customer's bill depends on which
  // server answered.
  const { start } = periodBounds(new Date('2026-06-01T02:00:00.000Z'));
  assert.equal(start.toISOString(), '2026-06-01T00:00:00.000Z');
});
