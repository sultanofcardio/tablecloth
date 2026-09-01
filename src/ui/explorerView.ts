import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { StoredDataSource } from '../core/types';
import { errorMessage } from '../core/util';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { MenuItem } from '../webview/menu';
import { buildExplorerTree, type ExplorerRef } from './explorerModel';

export interface ExplorerActions {
  addDataSource(): void;
  editDataSource(ds?: StoredDataSource): void;
  duplicateDataSource(ds: StoredDataSource): Promise<void>;
  removeDataSource(ds: StoredDataSource): Promise<void>;
  disconnect(dsId: string): Promise<void>;
  toggleSystemSchemas(): Promise<void>;
  openTable(ref: ExplorerRef): Promise<void>;
  consoleMenuItems(ds: StoredDataSource): Promise<MenuItem[]>;
  consoleMenuPick(ds: StoredDataSource, itemId: string, db?: string, schema?: string): Promise<void>;
  consoleMenuButton(ds: StoredDataSource, itemId: string, buttonId: string): Promise<void>;
}

interface PendingMenu {
  kind: 'console' | 'consoleDs';
  ref?: ExplorerRef;
}

/** The Database explorer as a webview: IntelliJ tree + toolbar row. */
export class ExplorerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'tablecloth.explorer';

  /** True once the webview reported in (test hook). */
  resolved = false;

  private view?: vscode.WebviewView;
  private ready = false;
  private readonly errors = new Map<string, string>();
  private readonly pendingMenus = new Map<string, PendingMenu>();
  private postTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
    private readonly actions: ExplorerActions,
  ) {
    store.onDidChange(() => this.schedulePostTree());
    sessions.onDidChange(() => this.schedulePostTree());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  private post(message: unknown): void {
    if (this.view && this.ready) void this.view.webview.postMessage(message);
  }

  private schedulePostTree(): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => this.postTree(), 30);
  }

  private postTree(): void {
    const nodes = buildExplorerTree(this.store.list(), {
      getCatalog: (id) => this.sessions.getCatalog(id),
      isConnected: (id) => this.sessions.isConnected(id),
    });
    for (const node of nodes) {
      const dsId = node.ref?.dsId;
      const error = dsId ? this.errors.get(dsId) : undefined;
      // without a catalog there is nothing else to show (the auto-sync hint
      // included); the error node takes the children slot
      if (error && dsId && !this.sessions.getCatalog(dsId)) {
        node.lazy = false;
        node.children = [{ id: `${node.id}:error`, kind: 'error', label: error }];
      }
    }
    const showSystem = vscode.workspace
      .getConfiguration('tablecloth.explorer')
      .get<boolean>('showSystemSchemas', false);
    // screenshot rig only: '1' expands everything, any other value expands
    // containers/groups plus just the relation with that label
    const expandAll = process.env.TABLECLOTH_DEMO_EXPAND || undefined;
    this.post({ type: 'tree', nodes, showSystem, expandAll });
  }

  private dataSourceFor(ref: ExplorerRef | undefined): StoredDataSource | undefined {
    return ref ? this.store.get(ref.dsId) : undefined;
  }

  private async introspect(dsId: string, force: boolean): Promise<void> {
    const ds = this.store.get(dsId);
    if (!ds) return;
    this.errors.delete(dsId);
    try {
      await this.sessions.introspect(ds.config, force);
    } catch (err) {
      this.errors.set(dsId, errorMessage(err));
      // with a cached catalog the tree keeps its (stale) children and the
      // error node never renders; a notification is the only visible signal
      if (this.sessions.getCatalog(dsId)) {
        void vscode.window.showErrorMessage(`Tablecloth: refreshing ${ds.config.name} failed: ${errorMessage(err)}`);
      }
    }
    this.postTree();
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        this.ready = true;
        this.resolved = true;
        this.postTree();
        break;
      case 'introspect': {
        // expansion-triggered: honor auto-sync (explicit Refresh always works)
        const ds = this.store.get(String(message.dsId));
        if (ds?.config.autoSync) await this.introspect(ds.config.id, false);
        break;
      }
      case 'refresh': {
        const dsId = message.dsId ? String(message.dsId) : undefined;
        if (dsId) {
          await this.introspect(dsId, true);
        } else {
          for (const ds of this.store.list()) {
            if (this.sessions.isConnected(ds.config.id)) await this.introspect(ds.config.id, true);
          }
        }
        break;
      }
      case 'openTable':
        if (message.ref) await this.actions.openTable(message.ref as ExplorerRef);
        break;
      case 'action':
        await this.handleAction(String(message.name), message.ref as ExplorerRef | undefined);
        break;
      case 'consoleMenu':
        await this.openConsoleMenu(message.ref as ExplorerRef | undefined);
        break;
      case 'menuPick':
        await this.handleMenuPick(String(message.menuId), String(message.itemId));
        break;
      case 'menuButton': {
        const pending = this.pendingMenus.get(String(message.menuId));
        const ds = this.dataSourceFor(pending?.ref);
        if (pending?.kind === 'console' && ds) {
          await this.actions.consoleMenuButton(ds, String(message.itemId), String(message.buttonId));
        }
        break;
      }
    }
  }

  private async handleAction(name: string, ref: ExplorerRef | undefined): Promise<void> {
    const ds = this.dataSourceFor(ref);
    switch (name) {
      case 'addDataSource':
        this.actions.addDataSource();
        break;
      case 'properties':
        this.actions.editDataSource(ds);
        break;
      case 'duplicate':
        if (ds) await this.actions.duplicateDataSource(ds);
        break;
      case 'remove':
        if (ds) await this.actions.removeDataSource(ds);
        break;
      case 'disconnect':
        if (ds) await this.actions.disconnect(ds.config.id);
        break;
      case 'refresh':
        if (ref) await this.introspect(ref.dsId, true);
        break;
      case 'toggleSystem':
        await this.actions.toggleSystemSchemas();
        break;
      case 'copyName': {
        const name = ref?.leaf ?? ref?.name ?? ds?.config.name;
        if (name) await vscode.env.clipboard.writeText(name);
        break;
      }
    }
  }

  private async openConsoleMenu(ref: ExplorerRef | undefined): Promise<void> {
    let ds = this.dataSourceFor(ref);
    if (!ds) {
      const sources = this.store.list();
      if (sources.length === 0) {
        this.actions.addDataSource();
        return;
      }
      if (sources.length === 1) ds = sources[0];
    }
    const menuId = randomBytes(4).toString('hex');
    if (!ds) {
      // several sources and no selection: pick the source first
      this.pendingMenus.set(menuId, { kind: 'consoleDs' });
      this.post({
        type: 'menu',
        menuId,
        items: this.store.list().map((s) => ({
          id: s.config.id,
          label: s.config.name,
          description: s.config.driver,
        })),
      });
      return;
    }
    this.pendingMenus.set(menuId, { kind: 'console', ref: ref ?? { dsId: ds.config.id } });
    this.post({ type: 'menu', menuId, items: await this.actions.consoleMenuItems(ds) });
  }

  private async handleMenuPick(menuId: string, itemId: string): Promise<void> {
    const pending = this.pendingMenus.get(menuId);
    this.pendingMenus.delete(menuId);
    if (!pending) return;
    if (pending.kind === 'consoleDs') {
      await this.openConsoleMenu({ dsId: itemId });
      return;
    }
    const ds = this.dataSourceFor(pending.ref);
    if (ds) {
      await this.actions.consoleMenuPick(ds, itemId, pending.ref?.db, pending.ref?.schema);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'explorer.js'));
    const icon = (paths: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('explorer.css')}">
<link rel="stylesheet" href="${media('menu.css')}">
</head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="tb-add" class="tbtn" title="New Data Source…">${icon('<path d="M12 5l0 14"/><path d="M5 12l14 0"/>')}</button>
    <button id="tb-props" class="tbtn" title="Data Source Properties…">${icon('<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>')}</button>
    <span class="tbsep"></span>
    <button id="tb-refresh" class="tbtn" title="Refresh">${icon('<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>')}</button>
    <span class="tbsep"></span>
    <button id="tb-console" class="tbtn" title="Query Console…">${icon('<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/>')}</button>
    <button id="tb-table" class="tbtn" title="Open Table Data">${icon('<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M3 10h18"/><path d="M10 3v18"/>')}</button>
    <span class="tbsep"></span>
    <button id="tb-eye" class="tbtn" title="Show/Hide System Schemas">${icon('<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>')}</button>
  </div>
  <div id="tree" tabindex="0"></div>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
