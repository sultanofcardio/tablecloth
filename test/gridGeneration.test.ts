import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ColumnModel } from '../src/core/types';

// A filter that the server rejects keeps the last good page on screen. The
// change set the webview built on that page must still be submittable, so the
// page identity the host checks may only move when a new page is posted.

/** Callable, endlessly property-accessible stand-in for APIs this test never exercises. */
function flexi(): any {
  const fn: any = function () {
    return flexi();
  };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === 'then') return undefined;
      if (p === 'dispose') return () => undefined;
      if (p === Symbol.toPrimitive || p === 'toString') return () => 'stub';
      return flexi();
    },
    apply: () => flexi(),
    construct: () => flexi(),
  });
}

const tableColumns: ColumnModel[] = [
  { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
  { name: 'status', dataType: 'text', nullable: true, primaryKey: false },
];

function setup() {
  const base: Record<string, unknown> = {
    workspace: {
      getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }),
    },
  };
  const vscodeStub = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : flexi()) });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeModule = require('node:module');
  const realLoad = NodeModule._load;
  NodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.call(this, request, ...rest);
  };
  const restore = () => {
    NodeModule._load = realLoad;
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GridController } = require('../src/ui/grid');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeEditTarget } = require('../src/edit/changeSet');

  const posted: any[] = [];
  const page = {
    columns: [{ name: 'id', numeric: true }, { name: 'status' }],
    rows: [[1, 'pending']],
    offset: 0,
    hasMore: false,
    durationMs: 1,
  };
  let fail = false;
  const submitted: unknown[][] = [];
  const provider = {
    dialect: 'postgres' as const,
    tableName: '"orders"',
    keyColumns: ['id'],
    supportsFilter: true,
    fetchPage: async () => {
      if (fail) throw new Error('column "bogus" does not exist');
      return { ...page, rows: page.rows.map((r) => [...r]) };
    },
    fetchCount: async () => 1,
    editing: {
      targetFor: (p: any) => makeEditTarget('postgres', '"orders"', tableColumns, p.columns, false),
      submit: async (statements: unknown[]) => {
        submitted.push(statements);
      },
    },
  };
  const controller = new GridController(flexi());
  controller.attach({ postMessage: async (m: unknown) => posted.push(m) });
  controller.onReady();
  const meta = { contextLabel: 'orders', env: 'none', readOnly: false, dsId: 'ds', dsName: 'acme' };
  return { controller, provider, meta, posted, submitted, setFail: (v: boolean) => (fail = v), restore };
}

const CHANGES = { updates: { 0: { 1: { kind: 'value', text: 'shipped' } } }, deletes: [], inserts: [] };

test('a submit is still accepted after a failed filter left the page on screen', async () => {
  const { controller, provider, meta, posted, setFail, restore } = setup();
  try {
    await controller.show(provider, meta);
    const result = posted.find((m) => m.type === 'result');
    assert.ok(result, 'the first page is posted');
    const generation = result.page.generation;

    posted.length = 0;
    setFail(true);
    await controller.setFilter({ where: 'bogus = 1', orderBy: '' });
    assert.ok(
      posted.some((m) => m.type === 'notice' && m.kind === 'error'),
      'the filter error is shown under the grid',
    );
    assert.ok(!posted.some((m) => m.type === 'result'), 'the page the webview holds is left alone');

    posted.length = 0;
    await controller.handleMessage({ type: 'submit', changes: CHANGES, generation });
    const preview = posted.find((m) => m.type === 'submitPreview');
    assert.ok(preview, 'the change set built on that page is still submittable');
    assert.deepEqual(preview.statements, [`UPDATE "orders" SET status = 'shipped' WHERE id = 1;`]);
  } finally {
    restore();
  }
});

test('a submit built on a page that has since been replaced is rejected', async () => {
  const { controller, provider, meta, posted, restore } = setup();
  try {
    await controller.show(provider, meta);
    const generation = posted.find((m) => m.type === 'result').page.generation;

    posted.length = 0;
    await controller.setFilter({ where: 'id = 1', orderBy: '' });
    const reloaded = posted.find((m) => m.type === 'result');
    assert.ok(reloaded, 'a successful reload posts a new page');
    assert.notEqual(reloaded.page.generation, generation, 'a posted page gets a new identity');

    posted.length = 0;
    await controller.handleMessage({ type: 'submit', changes: CHANGES, generation });
    assert.ok(!posted.some((m) => m.type === 'submitPreview'), 'the stale change set is not previewed');
    assert.ok(
      posted.some((m) => m.type === 'notice' && /reloaded while you were editing/.test(m.text)),
      'the webview is told why',
    );
  } finally {
    restore();
  }
});
