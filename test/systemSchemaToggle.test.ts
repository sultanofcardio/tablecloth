import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercises the real activate() wiring for the showSystemSchemas toggle by
// stubbing the 'vscode' module: catalogs are dropped for every source, but a
// background re-introspection is kicked off only for sources that were already
// showing a catalog, and live sessions survive the toggle untouched.

type Listener = (e: unknown) => void;

class StubEventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

/** Callable, constructible, endlessly property-accessible stand-in for APIs the test never exercises. */
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

const disposable = () => ({ dispose: () => undefined });

test('showSystemSchemas toggle re-introspects only sources that had a catalog, keeping sessions live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablecloth-toggle-'));
  const sourceA = {
    id: 'ds-a',
    name: 'a',
    driver: 'sqlite',
    color: 'none',
    readOnly: false,
    auth: 'none',
    file: join(dir, 'a.db'),
  };
  // connected via a console-style run, never introspected (autoSync off)
  const sourceB = { ...sourceA, id: 'ds-b', name: 'b', autoSync: false, file: join(dir, 'b.db') };

  const settings: Record<string, unknown> = {
    'tablecloth.dataSources': [sourceA, sourceB],
    'tablecloth.explorer.showSystemSchemas': false,
  };
  const configListeners: Listener[] = [];
  const fullKey = (section: string | undefined, key: string) => (section ? `${section}.${key}` : key);

  const uri = (path: string) => ({ path, fsPath: path, toString: () => `file://${path}` });
  const base: Record<string, unknown> = {
    EventEmitter: StubEventEmitter,
    Disposable: class {
      constructor(public dispose: () => void = () => undefined) {}
      static from() {
        return disposable();
      }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: {
      file: uri,
      parse: (s: string) => ({ path: s, fsPath: s, toString: () => s }),
      joinPath: (b: { path: string }, ...parts: string[]) => uri([b.path, ...parts].join('/')),
    },
    workspace: {
      getConfiguration: (section?: string) => ({
        get: (key: string, def?: unknown) => settings[fullKey(section, key)] ?? def,
        inspect: (key: string) => ({ globalValue: settings[fullKey(section, key)] }),
        update: async (key: string, value: unknown) => {
          settings[fullKey(section, key)] = value;
        },
      }),
      onDidChangeConfiguration: (h: Listener) => {
        configListeners.push(h);
        return disposable();
      },
      isTrusted: true,
      onDidGrantWorkspaceTrust: () => disposable(),
      onDidCloseTextDocument: () => disposable(),
      onDidChangeTextDocument: () => disposable(),
      workspaceFolders: [],
      fs: {
        readDirectory: async () => [],
        readFile: async () => new Uint8Array(),
        createDirectory: async () => undefined,
      },
    },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: () => undefined, hide: () => undefined, dispose: () => undefined }),
      createTextEditorDecorationType: () => ({ key: 'stub', dispose: () => undefined }),
      setStatusBarMessage: () => disposable(),
      onDidChangeActiveTextEditor: () => disposable(),
      onDidChangeTextEditorSelection: () => disposable(),
      registerWebviewViewProvider: () => disposable(),
      registerCustomEditorProvider: () => disposable(),
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
    },
    commands: {
      registerCommand: () => disposable(),
      executeCommand: async () => undefined,
    },
    languages: { registerCompletionItemProvider: () => disposable() },
    env: { clipboard: { writeText: async () => undefined } },
  };
  const vscodeStub = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : flexi()) });

  // The vscode stub must be hooked into the CJS loader before the product
  // modules load, so this test uses runtime require() rather than imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeModule = require('node:module');
  const realLoad = NodeModule._load;
  NodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') return vscodeStub;
    return realLoad.call(this, request, ...rest);
  };

  try {
    // spy on the product SessionManager so the test can observe what activate()'s
    // config listener does with it
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sessionsMod = require('../src/drivers/sessions');
    const RealSessionManager = sessionsMod.SessionManager;
    let manager: any;
    const introspectCalls: string[] = [];
    sessionsMod.SessionManager = class extends RealSessionManager {
      constructor(deps: unknown) {
        super(deps);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        manager = this;
      }
      introspect(config: { id: string }, force?: boolean) {
        introspectCalls.push(config.id);
        return super.introspect(config, force);
      }
    };

    const memento = { get: (_k: string, d?: unknown) => d, update: async () => undefined, keys: () => [] };
    const context = {
      subscriptions: [] as { dispose(): void }[],
      globalState: memento,
      workspaceState: memento,
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
      extensionUri: uri('/ext'),
      globalStorageUri: uri(join(dir, 'storage')),
    };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ext = require('../src/extension');
    ext.activate(context);
    assert.ok(manager, 'activate() constructed the SessionManager');

    // source A: explorer-style introspection caches a catalog
    await manager.introspect(sourceA);
    // source B: console-style query execution connects without a catalog, and
    // leaves per-connection state (a temp table) that must survive the toggle
    await manager.run(sourceB, (s: any) => s.query('CREATE TEMP TABLE scratch (x)'));
    assert.ok(manager.getCatalog('ds-a'), 'A has a catalog before the toggle');
    assert.equal(manager.getCatalog('ds-b'), undefined, 'B never introspected');
    assert.ok(manager.isConnected('ds-a') && manager.isConnected('ds-b'));

    introspectCalls.length = 0;
    for (const listener of [...configListeners]) {
      listener({ affectsConfiguration: (k: string) => k === 'tablecloth.explorer.showSystemSchemas' });
    }

    // only the source that was showing a catalog refreshes in place
    assert.deepEqual(introspectCalls, ['ds-a']);
    assert.equal(manager.getCatalog('ds-b'), undefined, 'toggle must not introspect B');

    // sessions stayed live: B's temp table (per-connection state) is still there
    assert.ok(manager.isConnected('ds-a') && manager.isConnected('ds-b'));
    const rows = await manager.run(sourceB, (s: any) => s.query('SELECT count(*) FROM scratch'));
    assert.equal(Number(rows.rows[0][0]), 0);

    // the background re-introspection restores A's catalog
    const deadline = Date.now() + 5000;
    while (!manager.getCatalog('ds-a') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(manager.getCatalog('ds-a'), 'A catalog restored after the toggle');

    await ext.deactivate();
  } finally {
    NodeModule._load = realLoad;
  }
});
