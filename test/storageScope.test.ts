import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStorageScope } from '../src/core/util';

test('a new data source defaults to Project scope inside a trusted workspace', () => {
  assert.equal(defaultStorageScope(true, true), 'project');
});

test('Global is the fallback whenever Project scope cannot be written', () => {
  assert.equal(defaultStorageScope(false, true), 'global', 'no workspace folder open');
  assert.equal(defaultStorageScope(true, false), 'global', 'Restricted Mode');
  assert.equal(defaultStorageScope(false, false), 'global');
});
