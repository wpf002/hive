import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceConfigToSchema } from './schema-coerce.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['league', 'dateOffset'],
  properties: {
    league: { type: 'string', enum: ['nfl', 'nba', 'mlb'] },
    dateOffset: { type: 'integer', minimum: -7, maximum: 7, default: 0 },
    verbose: { type: 'boolean', default: false },
  },
};

test('coerces string numbers and booleans to their schema types', () => {
  const { config } = coerceConfigToSchema(SCHEMA, {
    league: 'nba',
    dateOffset: '2',
    verbose: 'true',
  });
  assert.equal(config.dateOffset, 2);
  assert.equal(config.verbose, true);
  assert.equal(config.league, 'nba');
});

test('fills defaults for missing optional fields', () => {
  const { config } = coerceConfigToSchema(SCHEMA, { league: 'nfl', dateOffset: 0 });
  assert.equal(config.verbose, false);
});

test('warns on missing required field', () => {
  const { warnings } = coerceConfigToSchema(SCHEMA, { dateOffset: 0 });
  assert.ok(warnings.some((w) => w.includes('league')));
});

test('warns on enum violation but keeps the value for the operator to fix', () => {
  const { config, warnings } = coerceConfigToSchema(SCHEMA, { league: 'cfl', dateOffset: 0 });
  assert.equal(config.league, 'cfl');
  assert.ok(warnings.some((w) => w.includes('league') && w.includes('cfl')));
});

test('warns on out-of-range numbers', () => {
  const { warnings } = coerceConfigToSchema(SCHEMA, { league: 'nba', dateOffset: 99 });
  assert.ok(warnings.some((w) => w.includes('maximum')));
});

test('drops unknown keys when additionalProperties is false', () => {
  const { config, warnings } = coerceConfigToSchema(SCHEMA, {
    league: 'nba',
    dateOffset: 0,
    bogus: 'x',
  });
  assert.ok(!('bogus' in config));
  assert.ok(warnings.some((w) => w.includes('bogus')));
});

test('keeps unknown keys when additionalProperties is allowed', () => {
  const open = { type: 'object', properties: { a: { type: 'string' } } };
  const { config } = coerceConfigToSchema(open, { a: 'hi', extra: 1 });
  assert.equal(config.extra, 1);
});

test('non-object config still fills defaults and warns on missing required', () => {
  const { config, warnings } = coerceConfigToSchema(SCHEMA, null);
  // No values supplied, but defaulted fields are filled and the required field
  // with no default is flagged for the operator.
  assert.deepEqual(config, { dateOffset: 0, verbose: false });
  assert.ok(warnings.some((w) => w.includes('league')));
});
