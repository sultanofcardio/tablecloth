import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelledTip, placeTip } from '../src/webview/tooltip';

const viewport = { width: 800, height: 600 };

test('a tooltip sits below and to the right of the pointer', () => {
  assert.deepEqual(placeTip({ x: 100, y: 50 }, { width: 200, height: 40 }, viewport), { left: 112, top: 68 });
});

test('a tooltip near the right edge is pulled back inside the viewport', () => {
  const at = placeTip({ x: 760, y: 50 }, { width: 200, height: 40 }, viewport);
  assert.equal(at.left, 800 - 200 - 8);
  assert.equal(at.top, 68);
});

test('a tooltip with no room below goes above the pointer', () => {
  const at = placeTip({ x: 100, y: 580 }, { width: 200, height: 40 }, viewport);
  assert.equal(at.left, 112);
  assert.equal(at.top, 580 - 40 - 10);
});

test('a tooltip taller than the space above stays inside the top margin', () => {
  const at = placeTip({ x: 100, y: 590 }, { width: 200, height: 590 }, viewport);
  assert.equal(at.top, 8);
});

test('a tooltip wider than the viewport keeps the left margin', () => {
  const at = placeTip({ x: 10, y: 10 }, { width: 900, height: 40 }, viewport);
  assert.equal(at.left, 8);
});

test('an icon-only control gets its tooltip text as its accessible name too', () => {
  assert.deepEqual(labelledTip('Close'), { 'data-tip': 'Close', 'aria-label': 'Close' });
});
