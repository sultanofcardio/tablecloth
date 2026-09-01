import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { ConsoleBinding, StoredDataSource, TxState } from '../core/types';
import { ENV_COLOR_DOT, ENV_COLOR_HEX } from '../core/types';
import { sanitizeFileName } from '../core/util';
import type { DataSourceStore } from '../data/store';
import type { SessionManager } from '../drivers/sessions';
import type { MenuItem } from '../webview/menu';

const BINDINGS_KEY = 'tablecloth.bindings';
const TX_KEY = 'tablecloth.txStates';
const CONSOLE_DIR_SEP = '__';
const CUSTOM_LABELS = 'workbench.editor.customLabels.patterns';

const DEFAULT_TX: TxState = { mode: 'auto', isolation: 'default' };

/**
 * Query consoles are plain .sql files under global storage, one folder per data
 * source, bound to that source. Any other .sql file can be attached explicitly;
 * those bindings live in workspace state. Tab labels for console files are kept
 * IntelliJ-shaped ("console [kgtv.public]") through the editor's custom-label
 * patterns.
 */
export class ConsoleManager implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly txItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** Consoles with an open manual transaction (runtime-only, by uri string). */
  private readonly inTx = new Set<string>();
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  /** Fires when any binding or transaction state changed (console UIs re-render). */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusItem.command = 'tablecloth.selectSchema';
    this.txItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.txItem.command = 'tablecloth.txMode';
    this.disposables.push(
      this.statusItem,
      this.txItem,
      this.stateEmitter,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      this.store.onDidChange(() => {
        this.updateStatusBar();
        this.stateEmitter.fire();
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => void this.onDocumentClosed(doc)),
    );
    this.updateStatusBar();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------ bindings

  private bindings(): Record<string, ConsoleBinding> {
    return this.context.workspaceState.get<Record<string, ConsoleBinding>>(BINDINGS_KEY, {});
  }

  getBinding(uri: vscode.Uri): ConsoleBinding | undefined {
    const stored = this.bindings()[uri.toString()];
    if (stored && this.store.get(stored.dataSourceId)) return stored;

    // Console files carry their data source id in the folder name, so bindings
    // survive lost workspace state.
    const consolesRoot = vscode.Uri.joinPath(this.context.globalStorageUri, 'consoles').path;
    if (uri.path.startsWith(consolesRoot + '/')) {
      const folder = uri.path.slice(consolesRoot.length + 1).split('/')[0] ?? '';
      const sep = folder.lastIndexOf(CONSOLE_DIR_SEP);
      if (sep > 0) {
        const dsId = folder.slice(sep + CONSOLE_DIR_SEP.length);
        if (this.store.get(dsId)) return { dataSourceId: dsId };
      }
    }
    return undefined;
  }

  async setBinding(uri: vscode.Uri, binding: ConsoleBinding | undefined): Promise<void> {
    const all = { ...this.bindings() };
    if (binding) all[uri.toString()] = binding;
    else delete all[uri.toString()];
    await this.context.workspaceState.update(BINDINGS_KEY, all);
    await this.applyTabLabel(uri, binding);
    this.updateStatusBar();
    this.stateEmitter.fire();
  }

  /** Session key suffix for a console document. */
  consoleSuffix(uri: vscode.Uri): string {
    return uri.toString();
  }

  private async onDocumentClosed(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== 'sql') return;
    const binding = this.bindings()[doc.uri.toString()];
    if (!binding) return;
    // closing the console ends its session (rolling back anything uncommitted)
    this.inTx.delete(doc.uri.toString());
    await this.sessions.closeSession(binding.dataSourceId, this.consoleSuffix(doc.uri));
  }

  // ------------------------------------------------------------ transaction state

  getTxState(uri: vscode.Uri): TxState {
    const states = this.context.workspaceState.get<Record<string, TxState>>(TX_KEY, {});
    return states[uri.toString()] ?? DEFAULT_TX;
  }

  async setTxState(uri: vscode.Uri, state: TxState): Promise<void> {
    const states = { ...this.context.workspaceState.get<Record<string, TxState>>(TX_KEY, {}) };
    states[uri.toString()] = state;
    await this.context.workspaceState.update(TX_KEY, states);
    this.updateStatusBar();
    this.stateEmitter.fire();
  }

  isInTx(uri: vscode.Uri): boolean {
    return this.inTx.has(uri.toString());
  }

  setInTx(uri: vscode.Uri, value: boolean): void {
    if (value) this.inTx.add(uri.toString());
    else this.inTx.delete(uri.toString());
    this.updateStatusBar();
    this.stateEmitter.fire();
  }

  // ------------------------------------------------------------ tab labels

  /** "kgtv.public"-style bracket text for a binding. */
  private bracketLabel(ds: StoredDataSource, binding: ConsoleBinding | undefined): string {
    const parts = [binding?.database, binding?.schema].filter(Boolean);
    return parts.length > 0 ? parts.join('.') : ds.config.name;
  }

  /**
   * Keep console tabs reading "console [kgtv.public]" instead of the raw file
   * name by writing an editor custom-label pattern for the file. Only files
   * under our consoles directory are labeled; user-attached files keep their
   * own names.
   */
  private async applyTabLabel(uri: vscode.Uri, binding: ConsoleBinding | undefined): Promise<void> {
    const consolesRoot = vscode.Uri.joinPath(this.context.globalStorageUri, 'consoles').path;
    if (!uri.path.startsWith(consolesRoot + '/')) return;
    const relative = uri.path.slice(consolesRoot.length + 1).split('/');
    const folder = relative[0];
    const file = relative[relative.length - 1];
    if (!folder || !file) return;

    const config = vscode.workspace.getConfiguration();
    const patterns = { ...(config.inspect<Record<string, string>>(CUSTOM_LABELS)?.globalValue ?? {}) };
    const key = `**/consoles/${folder}/${file}`;
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    if (ds) {
      const base = file.replace(/\.sql$/, '');
      patterns[key] = `${base} [${this.bracketLabel(ds, binding)}]`;
    } else {
      delete patterns[key];
    }
    await config.update(CUSTOM_LABELS, patterns, vscode.ConfigurationTarget.Global);
  }

  // ------------------------------------------------------------ console files

  private consolesRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'consoles');
  }

  private consoleDir(ds: StoredDataSource): vscode.Uri {
    return vscode.Uri.joinPath(
      this.consolesRoot(),
      `${sanitizeFileName(ds.config.name)}${CONSOLE_DIR_SEP}${ds.config.id}`,
    );
  }

  /**
   * All persisted console files of a data source. Folders are matched by the
   * stable id suffix, so consoles survive renaming the data source.
   */
  async listConsoles(ds: StoredDataSource): Promise<{ uri: vscode.Uri; base: string; isDefault: boolean }[]> {
    const root = this.consolesRoot();
    let folders: [string, vscode.FileType][] = [];
    try {
      folders = await vscode.workspace.fs.readDirectory(root);
    } catch {
      return [];
    }
    const suffix = `${CONSOLE_DIR_SEP}${ds.config.id}`;
    const consoles: { uri: vscode.Uri; base: string; isDefault: boolean }[] = [];
    for (const [name, type] of folders) {
      if (type !== vscode.FileType.Directory || !name.endsWith(suffix)) continue;
      const dir = vscode.Uri.joinPath(root, name);
      for (const [file, fileType] of await vscode.workspace.fs.readDirectory(dir)) {
        if (fileType === vscode.FileType.File && file.endsWith('.sql')) {
          consoles.push({
            uri: vscode.Uri.joinPath(dir, file),
            base: file.slice(0, -4),
            isDefault: file === 'console.sql',
          });
        }
      }
    }
    consoles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.base.localeCompare(b.base));
    return consoles;
  }

  /** Every persisted console across all data sources, for the panel tree. */
  async listAllConsoleEntries(): Promise<
    { key: string; label: string; dsId: string; dsName: string; vendor: string; envColor: string | null }[]
  > {
    const entries: { key: string; label: string; dsId: string; dsName: string; vendor: string; envColor: string | null }[] =
      [];
    for (const ds of this.store.list()) {
      const consoles = await this.listConsoles(ds);
      for (const c of consoles) {
        entries.push({
          key: c.uri.toString(),
          label: c.base,
          dsId: ds.config.id,
          dsName: ds.config.name,
          vendor: ds.config.driver,
          envColor: ds.config.color === 'none' ? null : ENV_COLOR_HEX[ds.config.color],
        });
      }
    }
    return entries;
  }

  /** Open an existing console file, restoring its binding when state was lost. */
  async openConsole(uri: vscode.Uri, ds: StoredDataSource, database?: string, schema?: string): Promise<void> {
    if (!this.bindings()[uri.toString()]) {
      await this.setBinding(uri, {
        dataSourceId: ds.config.id,
        database: database ?? ds.config.database,
        schema: schema ?? this.defaultSchema(ds),
      });
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, 'tablecloth.console');
    this.updateStatusBar();
  }

  /** Create the next free console file for a data source and open it. */
  async newConsole(ds: StoredDataSource, database?: string, schema?: string): Promise<vscode.Uri> {
    const dir = this.consoleDir(ds);
    await vscode.workspace.fs.createDirectory(dir);

    let name = 'console.sql';
    for (let n = 2; ; n++) {
      const candidate = vscode.Uri.joinPath(dir, name);
      try {
        await vscode.workspace.fs.stat(candidate);
        name = `console_${n}.sql`;
      } catch {
        break;
      }
    }
    const uri = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
    await this.setBinding(uri, {
      dataSourceId: ds.config.id,
      database: database ?? ds.config.database,
      schema: schema ?? this.defaultSchema(ds),
    });

    await vscode.commands.executeCommand('vscode.openWith', uri, 'tablecloth.console');
    this.updateStatusBar();
    return uri;
  }

  /** Open the default console (console.sql), creating it when missing. */
  async openDefaultConsole(ds: StoredDataSource, database?: string, schema?: string): Promise<void> {
    const existing = (await this.listConsoles(ds)).find((c) => c.isDefault);
    if (existing) {
      await this.openConsole(existing.uri, ds, database, schema);
    } else {
      await this.newConsole(ds, database, schema);
    }
  }

  /**
   * The IntelliJ console dropdown, as menu DTOs: Default Query Console,
   * recent consoles (with rename/delete buttons), New Query Console, Show
   * Console Folder. Consumed by webview menus and the native picker alike.
   */
  async consoleMenuItems(ds: StoredDataSource): Promise<MenuItem[]> {
    const consoles = await this.listConsoles(ds);
    const bracket = (uri: vscode.Uri) => {
      const binding = this.getBinding(uri);
      return binding ? this.bracketLabel(ds, binding) : ds.config.name;
    };
    return [
      { id: 'default', label: 'Default Query Console', icon: 'terminal' },
      { kind: 'header', label: 'Recent Consoles' },
      ...consoles.map(
        (c): MenuItem => ({
          id: `open:${c.uri.toString()}`,
          label: `${c.base} [${bracket(c.uri)}]`,
          description: c.isDefault ? 'Default' : undefined,
          buttons: [
            { id: 'rename', icon: 'edit', tooltip: 'Rename console' },
            { id: 'delete', icon: 'trash', tooltip: 'Delete console' },
          ],
        }),
      ),
      { kind: 'separator' },
      { id: 'new', label: 'New Query Console', icon: 'add' },
      { id: 'folder', label: 'Show Console Folder', icon: 'folder' },
    ];
  }

  async handleConsoleMenuPick(
    ds: StoredDataSource,
    itemId: string,
    database?: string,
    schema?: string,
  ): Promise<void> {
    if (itemId.startsWith('open:')) {
      await this.openConsole(vscode.Uri.parse(itemId.slice('open:'.length)), ds, database, schema);
    } else if (itemId === 'default') {
      await this.openDefaultConsole(ds, database, schema);
    } else if (itemId === 'new') {
      await this.newConsole(ds, database, schema);
    } else if (itemId === 'folder') {
      await vscode.commands.executeCommand('revealFileInOS', this.consoleDir(ds));
    }
  }

  async handleConsoleMenuButton(ds: StoredDataSource, itemId: string, buttonId: string): Promise<void> {
    if (!itemId.startsWith('open:')) return;
    const uri = vscode.Uri.parse(itemId.slice('open:'.length));
    if (buttonId === 'rename') {
      await this.renameConsole(uri, ds);
    } else if (buttonId === 'delete') {
      const answer = await vscode.window.showWarningMessage(
        `Delete console "${basename(uri.path)}"? Its SQL is deleted from disk.`,
        { modal: true },
        'Delete',
      );
      if (answer === 'Delete') await this.deleteConsole(uri);
    }
  }

  /** Native fallback for palette invocations; webviews use consoleMenuItems. */
  async pickConsole(ds: StoredDataSource, database?: string, schema?: string): Promise<void> {
    const existing = await this.listConsoles(ds);
    if (existing.length === 0) {
      await this.openDefaultConsole(ds, database, schema);
      return;
    }

    type Item = vscode.QuickPickItem & { itemId?: string };
    const buttonFor = (id: string, icon: string, tooltip: string) => ({
      iconPath: new vscode.ThemeIcon(icon),
      tooltip,
      id,
    });

    const buildItems = async (): Promise<Item[]> => {
      const items = await this.consoleMenuItems(ds);
      return items.map((item): Item => {
        if (item.kind === 'header') return { label: item.label ?? '', kind: vscode.QuickPickItemKind.Separator };
        if (item.kind === 'separator') return { label: '', kind: vscode.QuickPickItemKind.Separator };
        return {
          label: item.icon ? `$(${item.icon === 'add' ? 'add' : item.icon}) ${item.label}` : (item.label ?? ''),
          description: item.description,
          itemId: item.id,
          buttons: item.buttons?.map((b) => buttonFor(b.id, b.icon, b.tooltip)),
        };
      });
    };

    const picker = vscode.window.createQuickPick<Item>();
    picker.placeholder = `Query consoles on ${ds.config.name}`;
    picker.items = await buildItems();

    picker.onDidTriggerItemButton(async (event) => {
      const itemId = event.item.itemId;
      const buttonId = (event.button as { id?: string }).id;
      if (!itemId || !buttonId) return;
      picker.hide();
      await this.handleConsoleMenuButton(ds, itemId, buttonId);
    });

    picker.onDidAccept(async () => {
      const item = picker.selectedItems[0];
      picker.hide();
      if (item?.itemId) await this.handleConsoleMenuPick(ds, item.itemId, database, schema);
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
  }

  /** Close any editor tab holding this console file. */
  private async closeConsoleTabs(uri: vscode.Uri): Promise<void> {
    const target = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        const resource =
          input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
        if (resource?.toString() === target) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  /** Move workspace-state entries (binding, tx) from one console path to another. */
  private async migrateConsoleState(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldKey = oldUri.toString();
    const newKey = newUri.toString();
    const bindings = { ...this.bindings() };
    if (bindings[oldKey]) {
      bindings[newKey] = bindings[oldKey]!;
      delete bindings[oldKey];
      await this.context.workspaceState.update(BINDINGS_KEY, bindings);
    }
    const txStates = { ...this.context.workspaceState.get<Record<string, TxState>>(TX_KEY, {}) };
    if (txStates[oldKey]) {
      txStates[newKey] = txStates[oldKey]!;
      delete txStates[oldKey];
      await this.context.workspaceState.update(TX_KEY, txStates);
    }
    if (this.inTx.delete(oldKey)) this.inTx.add(newKey);
  }

  /** Rename a console file, carrying its binding, labels, and tx state along. */
  async renameConsole(uri: vscode.Uri, ds: StoredDataSource): Promise<void> {
    const oldBase = basename(uri.path).replace(/\.sql$/, '');
    const input = await vscode.window.showInputBox({
      prompt: 'Console name',
      value: oldBase,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return 'Enter a name';
        if (!/^[A-Za-z0-9 _.-]+$/.test(trimmed)) return 'Letters, digits, spaces, dot, dash and underscore only';
        return undefined;
      },
    });
    const newBase = input?.trim();
    if (!newBase || newBase === oldBase) return;

    const dir = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) });
    const newUri = vscode.Uri.joinPath(dir, `${newBase}.sql`);
    try {
      await vscode.workspace.fs.stat(newUri);
      void vscode.window.showErrorMessage(`A console named "${newBase}" already exists.`);
      return;
    } catch {
      // free name
    }

    const wasOpen = vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === uri.toString()),
    );
    await this.closeConsoleTabs(uri);
    const binding = this.getBinding(uri);
    await vscode.workspace.fs.rename(uri, newUri);
    await this.migrateConsoleState(uri, newUri);
    await this.applyTabLabel(uri, undefined);
    await this.applyTabLabel(newUri, binding);
    this.stateEmitter.fire();
    if (wasOpen) await this.openConsole(newUri, ds);
  }

  /** Delete a console file and every trace of it. */
  async deleteConsole(uri: vscode.Uri): Promise<void> {
    await this.closeConsoleTabs(uri);
    await vscode.workspace.fs.delete(uri);
    const key = uri.toString();
    const bindings = { ...this.bindings() };
    delete bindings[key];
    await this.context.workspaceState.update(BINDINGS_KEY, bindings);
    const txStates = { ...this.context.workspaceState.get<Record<string, TxState>>(TX_KEY, {}) };
    delete txStates[key];
    await this.context.workspaceState.update(TX_KEY, txStates);
    this.inTx.delete(key);
    await this.applyTabLabel(uri, undefined);
    this.stateEmitter.fire();
  }

  private defaultSchema(ds: StoredDataSource): string | undefined {
    if (ds.config.driver === 'postgres') {
      const schemas = ds.config.schemas;
      if (schemas && schemas.length > 0) return schemas.includes('public') ? 'public' : schemas[0];
      return 'public';
    }
    return undefined;
  }

  /** Resolve the binding of a document, prompting to attach when there is none. */
  async resolveBinding(uri: vscode.Uri): Promise<{ ds: StoredDataSource; binding: ConsoleBinding } | undefined> {
    let binding = this.getBinding(uri);
    if (!binding) {
      binding = await this.promptAttach(uri);
      if (!binding) return undefined;
    }
    const ds = this.store.get(binding.dataSourceId);
    if (!ds) return undefined;
    return { ds, binding };
  }

  async promptAttach(uri: vscode.Uri): Promise<ConsoleBinding | undefined> {
    const sources = this.store.list();
    if (sources.length === 0) {
      const create = 'New Data Source…';
      const answer = await vscode.window.showInformationMessage('No data sources configured yet.', create);
      if (answer === create) await vscode.commands.executeCommand('tablecloth.addDataSource');
      return undefined;
    }
    const current = this.getBinding(uri);
    const picks: (vscode.QuickPickItem & { ds?: StoredDataSource; detach?: boolean })[] = sources.map((ds) => ({
      label: `${ENV_COLOR_DOT[ds.config.color]} ${ds.config.name}`.trim(),
      description: ds.config.driver,
      picked: current?.dataSourceId === ds.config.id,
      ds,
    }));
    if (current) {
      picks.push({ label: '$(close) Detach from data source', detach: true });
    }
    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Attach this file to a data source',
    });
    if (!chosen) return undefined;
    if (chosen.detach) {
      await this.setBinding(uri, undefined);
      return undefined;
    }
    const ds = chosen.ds!;
    const binding: ConsoleBinding = {
      dataSourceId: ds.config.id,
      database: ds.config.database,
      schema: this.defaultSchema(ds),
    };
    await this.setBinding(uri, binding);
    return binding;
  }

  // ------------------------------------------------------------ schema picker

  /** Schema switcher entries as menu DTOs (introspected, then Non-Introspected). */
  async schemaMenuItems(uri: vscode.Uri): Promise<MenuItem[] | undefined> {
    const binding = this.getBinding(uri);
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    if (!binding || !ds) return undefined;

    let catalog = this.sessions.getCatalog(ds.config.id);
    if (!catalog) {
      catalog = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Tablecloth: introspecting ${ds.config.name}…` },
        () => this.sessions.introspect(ds.config),
      );
    }

    const items: MenuItem[] = [];
    const current = [binding.database, binding.schema].filter(Boolean).join('.');
    const ctxItem = (database: string, schema?: string): MenuItem => {
      const label = schema ? `${database}.${schema}` : database;
      return { id: `ctx|${database}|${schema ?? ''}`, label, check: label === current };
    };

    const introspectedDbs = new Set<string>();
    for (const db of catalog.databases) {
      introspectedDbs.add(db.name);
      const implicit = db.schemas.length === 1 && db.schemas[0]!.implicit;
      if (implicit) {
        items.push(ctxItem(db.name));
        continue;
      }
      const introspectedSchemas = new Set(db.schemas.map((s) => s.name));
      for (const schema of db.schemas) items.push(ctxItem(db.name, schema.name));
      const rest = db.allSchemaNames.filter((s) => !introspectedSchemas.has(s));
      if (rest.length > 0) {
        items.push({ kind: 'header', label: 'Non-Introspected' });
        for (const schema of rest) items.push(ctxItem(db.name, schema));
      }
    }
    const restDbs = (catalog.allDatabaseNames ?? []).filter((d) => !introspectedDbs.has(d));
    if (restDbs.length > 0) {
      items.push({ kind: 'header', label: 'Non-Introspected' });
      for (const db of restDbs) items.push(ctxItem(db));
    }
    items.push({ kind: 'separator' });
    items.push({ id: 'changeDs', label: 'Change Data Source…', icon: 'plug' });
    return items;
  }

  /** Apply a schema-menu pick; returns 'changeDs' when the caller should offer sources. */
  async handleSchemaPick(uri: vscode.Uri, itemId: string): Promise<'changeDs' | 'done'> {
    if (itemId === 'changeDs') return 'changeDs';
    const binding = this.getBinding(uri);
    if (!binding) return 'done';
    const [, database, schema] = itemId.split('|');
    await this.setBinding(uri, {
      dataSourceId: binding.dataSourceId,
      database: database || undefined,
      schema: schema || undefined,
    });
    return 'done';
  }

  /** Data source entries for the "Change Data Source…" follow-up menu. */
  dataSourceMenuItems(currentDsId?: string): MenuItem[] {
    return this.store.list().map((ds) => ({
      id: `ds|${ds.config.id}`,
      label: `${ENV_COLOR_DOT[ds.config.color]} ${ds.config.name}`.trim(),
      description: ds.config.driver,
      check: ds.config.id === currentDsId,
    }));
  }

  async handleDataSourcePick(uri: vscode.Uri, itemId: string): Promise<void> {
    const dsId = itemId.split('|')[1];
    const ds = dsId ? this.store.get(dsId) : undefined;
    if (!ds) return;
    await this.setBinding(uri, {
      dataSourceId: ds.config.id,
      database: ds.config.database,
      schema: this.defaultSchema(ds),
    });
  }

  /** Native fallback for palette invocations; webviews use schemaMenuItems. */
  async pickSchema(uri: vscode.Uri): Promise<void> {
    const items = await this.schemaMenuItems(uri);
    if (!items) {
      await this.promptAttach(uri);
      return;
    }
    const binding = this.getBinding(uri);
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;
    type Item = vscode.QuickPickItem & { itemId?: string };
    const quickItems = items.map((item): Item => {
      if (item.kind === 'header' || item.kind === 'separator') {
        return { label: item.label ?? '', kind: vscode.QuickPickItemKind.Separator };
      }
      const mark = item.check === undefined ? '' : item.check ? '$(check) ' : '$(blank) ';
      return { label: `${mark}${item.label}`, itemId: item.id };
    });
    const chosen = await vscode.window.showQuickPick(quickItems, {
      placeHolder: `Schema for this console (${ds?.config.name ?? ''})`,
    });
    if (!chosen?.itemId) return;
    if ((await this.handleSchemaPick(uri, chosen.itemId)) === 'changeDs') {
      await this.promptAttach(uri);
    }
  }

  // ------------------------------------------------------------ status bar

  updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    const isSql = !!editor && editor.document.languageId === 'sql';
    const binding = isSql ? this.getBinding(editor.document.uri) : undefined;
    const ds = binding ? this.store.get(binding.dataSourceId) : undefined;

    void vscode.commands.executeCommand('setContext', 'tablecloth.consoleBound', !!ds);
    const tx = isSql && ds && editor ? this.getTxState(editor.document.uri) : undefined;
    void vscode.commands.executeCommand('setContext', 'tablecloth.txManual', tx?.mode === 'manual');

    if (!isSql) {
      this.statusItem.hide();
      this.txItem.hide();
      return;
    }
    if (!ds) {
      this.statusItem.text = '$(database) No data source';
      this.statusItem.tooltip = 'Attach this SQL file to a Tablecloth data source';
      this.statusItem.show();
      this.txItem.hide();
      return;
    }

    const dot = ENV_COLOR_DOT[ds.config.color];
    const context = [binding?.database, binding?.schema].filter(Boolean).join('.');
    this.statusItem.text = `$(database) ${dot ? dot + ' ' : ''}${ds.config.name}${context ? ' · ' + context : ''}`;
    const readOnly = ds.config.readOnly ? ' (read-only)' : '';
    this.statusItem.tooltip = `Attached to ${ds.config.name}${readOnly} — click to switch schema`;
    this.statusItem.show();

    const pending = editor && this.isInTx(editor.document.uri);
    this.txItem.text = `Tx: ${tx?.mode === 'manual' ? 'Manual' : 'Auto'}${pending ? ' ●' : ''}`;
    this.txItem.tooltip =
      tx?.mode === 'manual'
        ? `Manual commit${pending ? ' — transaction open' : ''} — click to change`
        : 'Statements are auto-committed — click to change';
    this.txItem.backgroundColor =
      tx?.mode === 'manual' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.txItem.show();
  }
}
