import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSslMode } from '../src/drivers/driver';

test('IAM auth lifts an absent or disabled SSL mode to require and leaves stricter modes alone', () => {
  assert.equal(effectiveSslMode({ auth: 'awsIam' }), 'require');
  assert.equal(effectiveSslMode({ auth: 'awsIam', ssl: { mode: 'disable' } }), 'require');
  assert.equal(effectiveSslMode({ auth: 'awsIam', ssl: { mode: 'verify-ca' } }), 'verify-ca');
  assert.equal(effectiveSslMode({ auth: 'awsIam', ssl: { mode: 'verify-full' } }), 'verify-full');
});

test('other auth modes keep the configured SSL mode, defaulting to disable', () => {
  assert.equal(effectiveSslMode({ auth: 'userPassword' }), 'disable');
  assert.equal(effectiveSslMode({ auth: 'userPassword', ssl: { mode: 'disable' } }), 'disable');
  assert.equal(effectiveSslMode({ auth: 'pgpass', ssl: { mode: 'require' } }), 'require');
  assert.equal(effectiveSslMode({ auth: 'none', ssl: { mode: 'verify-full' } }), 'verify-full');
});
