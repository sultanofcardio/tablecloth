import { test } from 'node:test';
import assert from 'node:assert/strict';

// Copying or exporting an SQL Updates extract whose selected columns are all
// part of the key has nothing to SET. The user must hear why: the clipboard or
// file carries the note and the host repeats its sentence, never silence.

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

interface Seen {
  clipboard: string[];
  statusBar: string[];
  warnings: string[];
  infos: string[];
  written: { path: string; text: string }[];
}

const seen: Seen = { clipboard: [], statusBar: [], warnings: [], infos: [], written: [] };
let savePath: string | undefined;

// The controller module binds `vscode` once, so the stub is installed once and
// the recorded output is reset per test.
function harness() {
  const base: Record<string, unknown> = {
    workspace: {
      getConfiguration: () => ({ get: (_key: string, def?: unknown) => def }),
      fs: {
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
          seen.written.push({ path: uri.fsPath, text: Buffer.from(bytes).toString('utf8') });
        },
      },
    },
    env: {
      clipboard: {
        writeText: async (text: string) => {
          seen.clipboard.push(text);
        },
      },
    },
    window: new Proxy(
      {
        setStatusBarMessage: (text: string) => seen.statusBar.push(text),
        showWarningMessage: (text: string) => {
          seen.warnings.push(text);
          return Promise.resolve(undefined);
        },
        showInformationMessage: (text: string) => {
          seen.infos.push(text);
          return Promise.resolve(undefined);
        },
        showSaveDialog: () => Promise.resolve(savePath ? { fsPath: savePath } : undefined),
      } as Record<string, unknown>,
      { get: (t, p: string) => (p in t ? t[p] : flexi()) },
    ),
    Uri: { file: (p: string) => ({ fsPath: p }) },
  };
  const vscodeStub = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : flexi()) });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeModule = require('node:module');
  const realLoad = NodeModule._load;
  NodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.call(this, request, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GridController } = require('../src/ui/grid');
  NodeModule._load = realLoad;

  const provider = {
    dialect: 'postgres' as const,
    tableName: 'user_roles',
    keyColumns: ['user_id', 'role_id'],
    supportsFilter: true,
    fetchPage: async () => ({
      columns: [{ name: 'user_id', numeric: true }, { name: 'role_id', numeric: true }, { name: 'granted_at' }],
      rows: [
        [1, 2, '2026-01-01'],
        [1, 3, null],
      ],
      offset: 0,
      hasMore: false,
      durationMs: 1,
    }),
    fetchCount: async () => 2,
  };
  const controller = new GridController(flexi());
  controller.attach({ postMessage: async () => undefined });
  controller.onReady();
  const meta = { contextLabel: 'user_roles', env: 'none', readOnly: false, dsId: 'ds', dsName: 'acme' };
  return { controller, provider, meta };
}

let cached: ReturnType<typeof harness> | undefined;

function setup(save: string | undefined) {
  savePath = save;
  seen.clipboard.length = 0;
  seen.statusBar.length = 0;
  seen.warnings.length = 0;
  seen.infos.length = 0;
  seen.written.length = 0;
  cached ??= harness();
  return cached;
}

const SENTENCE =
  'Nothing to update: every selected column (user_id) is part of the key (user_id, role_id); select a column outside the key to get UPDATE statements.';

test('copying SQL Updates with only key columns selected tells the user why the clipboard has no statements', async () => {
  const { controller, provider, meta } = setup(undefined);
  await controller.show(provider, meta);
  await controller.handleMessage({ type: 'export', extractor: 'sql-updates', mode: 'copy', columns: [0] });
  assert.equal(seen.clipboard.length, 1, 'the clipboard is written once');
  assert.equal(seen.clipboard[0], `-- ${SENTENCE}\n`, 'the clipboard carries the note, not an empty string');
  assert.deepEqual(seen.statusBar, [`Tablecloth: ${SENTENCE}`], 'the status bar repeats the sentence');
});

test('exporting that extract to a file warns that the file holds only the note', async () => {
  const { controller, provider, meta } = setup('/tmp/user_roles.sql');
  await controller.show(provider, meta);
  await controller.handleMessage({ type: 'export', extractor: 'sql-updates', mode: 'file', columns: [0] });
  assert.deepEqual(
    seen.written.map((w) => w.text),
    [`-- ${SENTENCE}\n`],
    'the file holds the note',
  );
  assert.deepEqual(
    seen.warnings,
    [`Tablecloth: ${SENTENCE} /tmp/user_roles.sql contains only that note.`],
    'the user is warned, naming the file',
  );
  assert.deepEqual(seen.infos, [], 'no "Exported 2 rows" success message');
});

test('a selection outside the key still copies real UPDATE statements with the usual message', async () => {
  const { controller, provider, meta } = setup(undefined);
  await controller.show(provider, meta);
  await controller.handleMessage({ type: 'export', extractor: 'sql-updates', mode: 'copy', columns: [2] });
  assert.deepEqual(seen.clipboard, [
    "UPDATE user_roles SET granted_at = '2026-01-01' WHERE user_id = 1 AND role_id = 2;\n" +
      'UPDATE user_roles SET granted_at = NULL WHERE user_id = 1 AND role_id = 3;\n',
  ]);
  assert.deepEqual(seen.statusBar, ['Tablecloth: copied 2 rows as SQL Updates']);
});
