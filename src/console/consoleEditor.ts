import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { computeCompletions } from '../complete/core';
import { ENV_COLOR_HEX, type StoredDataSource } from '../core/types';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { ConsoleManager } from './consoles';
import type { QueryHistory } from './history';
import type { QueryRunner } from './runner';

/**
 * The console surface: a custom editor with the IntelliJ toolbar row above a
 * Monaco editor. Registered only for files under this extension's consoles
 * directory; ordinary .sql files keep the native editor.
 */
export class ConsoleEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'tablecloth.console';

  /** True once any console webview reported Monaco up (test hook). */
  booted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleManager,
    private readonly runner: QueryRunner,
    private readonly history: QueryHistory,
    private readonly openDataSourceSettings: (ds: StoredDataSource) => void,
  ) {}

  register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(ConsoleEditorProvider.viewType, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private dataSource(uri: vscode.Uri): StoredDataSource | undefined {
    const binding = this.consoles.getBinding(uri);
    return binding ? this.store.get(binding.dataSourceId) : undefined;
  }

  private stateFor(uri: vscode.Uri) {
    const binding = this.consoles.getBinding(uri);
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    const tx = this.consoles.getTxState(uri);
    const context = [binding?.database, binding?.schema].filter(Boolean).join('.');
    return {
      dialect: ds?.config.driver ?? 'postgres',
      bindingLabel: ds ? context || ds.config.name : 'No data source',
      envColor: ds && ds.config.color !== 'none' ? ENV_COLOR_HEX[ds.config.color] : null,
      txMode: tx.mode,
      inTx: this.consoles.isInTx(uri),
      readOnly: !!ds?.config.readOnly,
    };
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const uri = document.uri;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };
    panel.webview.html = this.html(panel.webview);

    // Text the webview last sent us; used to swallow the echo when our own
    // applyEdit comes back through onDidChangeTextDocument.
    let lastWebviewText: string | undefined;
    const pushState = () => void panel.webview.postMessage({ type: 'state', state: this.stateFor(uri) });

    const subscriptions: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== document) return;
        const text = document.getText();
        if (text === lastWebviewText) return;
        void panel.webview.postMessage({ type: 'setText', text });
      }),
      this.consoles.onDidChangeState(() => pushState()),
    ];
    panel.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready':
          void panel.webview.postMessage({ type: 'init', text: document.getText(), state: this.stateFor(uri) });
          break;
        case 'booted':
          this.booted = true;
          break;
        case 'paste': {
          const text = await vscode.env.clipboard.readText();
          if (text) void panel.webview.postMessage({ type: 'insertText', sql: text });
          break;
        }
        case 'edit': {
          const text = String(message.text ?? '');
          lastWebviewText = text;
          if (text !== document.getText()) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), text);
            await vscode.workspace.applyEdit(edit);
          }
          break;
        }
        case 'run':
          if (typeof message.sql === 'string' && message.sql.trim()) {
            await this.runner.runSql(uri, message.sql);
          } else {
            void vscode.window.showInformationMessage('No statement at the caret.');
          }
          break;
        case 'runScript':
          await this.runner.runScriptFor(uri, document.getText(), 'console');
          break;
        case 'completions': {
          const ds = this.dataSource(uri);
          const catalog = ds ? this.sessions.getCatalog(ds.config.id) : undefined;
          if (ds && !catalog) void this.sessions.introspect(ds.config).catch(() => undefined);
          const entries =
            ds && catalog
              ? computeCompletions(catalog, ds.config.driver, String(message.text ?? ''), Number(message.offset ?? 0))
              : [];
          void panel.webview.postMessage({ type: 'completions', id: message.id, entries });
          break;
        }
        case 'action':
          await this.handleAction(String(message.name), uri);
          break;
        case 'menu':
          await this.openMenu(String(message.name), uri, panel);
          break;
        case 'menuPick':
          await this.handleMenuPick(String(message.name), String(message.id), uri, panel);
          break;
      }
    });
  }

  private async handleAction(name: string, uri: vscode.Uri): Promise<void> {
    switch (name) {
      case 'settings': {
        const ds = this.dataSource(uri);
        if (ds) this.openDataSourceSettings(ds);
        else await this.consoles.promptAttach(uri);
        break;
      }
      case 'commit':
        await this.runner.commit(uri);
        break;
      case 'rollback':
        await this.runner.rollback(uri);
        break;
    }
  }

  /** Anchored dropdowns for the console toolbar (Tx, schema, history). */
  private async openMenu(name: string, uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    switch (name) {
      case 'tx': {
        const menu = await this.runner.txMenuItems(uri);
        if (menu) void panel.webview.postMessage({ type: 'showMenu', name, items: menu.items, footer: menu.footer });
        break;
      }
      case 'schema': {
        const items = await this.consoles.schemaMenuItems(uri);
        if (items) {
          void panel.webview.postMessage({ type: 'showMenu', name, items });
        } else {
          const binding = this.consoles.getBinding(uri);
          void panel.webview.postMessage({
            type: 'showMenu',
            name: 'schemaDs',
            items: this.consoles.dataSourceMenuItems(binding?.dataSourceId),
          });
        }
        break;
      }
      case 'history':
        void panel.webview.postMessage({ type: 'showMenu', name, items: this.history.menuItems(), filter: true });
        break;
    }
  }

  private async handleMenuPick(name: string, id: string, uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    switch (name) {
      case 'tx':
        await this.runner.handleTxPick(uri, id);
        break;
      case 'schema':
        if ((await this.consoles.handleSchemaPick(uri, id)) === 'changeDs') {
          const binding = this.consoles.getBinding(uri);
          void panel.webview.postMessage({
            type: 'showMenu',
            name: 'schemaDs',
            items: this.consoles.dataSourceMenuItems(binding?.dataSourceId),
          });
        }
        break;
      case 'schemaDs':
        await this.consoles.handleDataSourcePick(uri, id);
        break;
      case 'history': {
        const entry = this.history.entryAt(Number(id));
        if (entry) void panel.webview.postMessage({ type: 'insertText', sql: entry.sql });
        break;
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const dist = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', file));
    // Monaco injects style elements and loads its codicon font; the worker is
    // fetched and started from a blob.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource}; worker-src blob:;">
<link rel="stylesheet" href="${dist('console.css')}">
<link rel="stylesheet" href="${media('console.css')}">
<link rel="stylesheet" href="${media('menu.css')}">
</head>
<body data-worker="${dist('editor.worker.js')}">
<div id="app">
  <div id="toolbar">
    <button id="tb-run" class="tbtn" title="Run statement at the caret (⌘⏎)">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12.2-7.5a.8.8 0 0 0 0-1.4L8.2 3.8A.8.8 0 0 0 7 4.5z"/></svg>
    </button>
    <button id="tb-runscript" class="tbtn" title="Run the whole console">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5v13l9-6.5z" fill="currentColor" stroke="none"/><path d="M15 5.5v13l6-6.5z" fill="currentColor" stroke="none"/></svg>
    </button>
    <span class="sep"></span>
    <button id="tb-history" class="tbtn" title="Query history">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 7v5l3 3"/></svg>
    </button>
    <button id="tb-settings" class="tbtn" title="Data source properties">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>
    </button>
    <span class="sep"></span>
    <button id="tb-tx" class="tbtn" title="Transaction mode and isolation">
      <span id="tx-label">Tx: Auto</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6l6 -6"/></svg>
    </button>
    <button id="tb-commit" class="tbtn" title="Commit transaction" hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5l10 -10"/></svg>
    </button>
    <button id="tb-rollback" class="tbtn" title="Roll back transaction" hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/></svg>
    </button>
    <span class="spacer"></span>
    <span id="tb-readonly" hidden>read-only 🔒</span>
    <button id="tb-schema" class="tbtn" title="Switch schema">
      <span id="schema-env" class="envdot" hidden></span>
      <svg class="site" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1"/><path d="M12 9l0 3"/></svg>
      <span id="schema-label">…</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6l6 -6"/></svg>
    </button>
  </div>
  <div id="editor"></div>
</div>
<script nonce="${nonce}" src="${dist('console.js')}"></script>
</body>
</html>`;
  }
}
