import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CellValue } from '../src/core/types';
import { compareCells, compareNumericText } from '../src/webview/grid/compare';

const sortAsc = (values: CellValue[], numeric: boolean) => [...values].sort((a, b) => compareCells(a, b, numeric));

test('integers beyond 2^53 keep their order', () => {
  assert.equal(compareCells('9007199254740992', '9007199254740993', true), -1);
  assert.equal(compareCells('9007199254740993', '9007199254740992', true), 1);
  assert.equal(compareCells('9007199254740993', '9007199254740993', true), 0);
  assert.equal(compareCells('-9007199254740993', '-9007199254740992', true), -1);
  assert.deepEqual(sortAsc(['9007199254740993', '9007199254740992', '18446744073709551616', '-1'], true), [
    '-1',
    '9007199254740992',
    '9007199254740993',
    '18446744073709551616',
  ]);
});

test('decimals compare exactly, whatever their scale', () => {
  assert.equal(compareCells('0.30000000000000004', '0.3', true), 1);
  assert.equal(compareCells('1.10', '1.1', true), 0);
  assert.equal(compareCells('-0.0', '0', true), 0);
  assert.equal(compareCells('.5', '0.50', true), 0);
  assert.equal(compareCells('123456789012345678.1', '123456789012345678.09', true), 1);
  assert.equal(compareCells('-2.5', '-2.25', true), -1);
  assert.equal(compareCells('2', '10', true), -1);
  assert.equal(compareCells('+7', '7', true), 0);
  assert.equal(compareNumericText('1e3', '999'), undefined);
});

test('mixed numeric text falls back to doubles, NULLs sort first, text sorts by locale', () => {
  assert.equal(compareCells('1e3', '999', true), 1);
  assert.equal(compareCells(1000, '1e3', true), 0);
  assert.equal(compareCells(null, '1', true), -1);
  assert.equal(compareCells('1', null, true), 1);
  assert.equal(compareCells(null, null, true), 0);
  assert.ok(compareCells('abc', '10', true) > 0);
  assert.ok(compareCells('10', 'abc', true) < 0);
  assert.deepEqual(sortAsc([null, '10', 2, '1.5', '9007199254740993', '9007199254740992'], true), [
    null,
    '1.5',
    2,
    '10',
    '9007199254740992',
    '9007199254740993',
  ]);
  assert.deepEqual(sortAsc(['10', '9', 'b', 'a'], false), ['10', '9', 'a', 'b']);
});
