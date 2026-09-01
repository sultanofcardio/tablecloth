import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { GridController, type GridMeta, type GridPage, type GridProvider } from './grid';
import { gridHtml } from './gridHtml';

export interface OutputEntry {
  kind: 'cmd' | 'meta' | 'error';
  prompt?: string;
  text: string;
}

const OUTPUT_TAB = '__output';

export interface InfoLine {
  label: string;
  value: string;
  /** Renders a blank line before this entry (the IntelliJ info grouping). */
  gap?: boolean;
}

export interface DataSourceActions {
  info(dsId: string): Promise<InfoLine[]>;
  consoleMenuItems(dsId: string): Promise<unknown[]>;
  consoleMenuPick(dsId: string, itemId: string): Promise<void>;
  consoleMenuButton(dsId: string, itemId: string, buttonId: string): Promise<void>;
  openProperties(dsId: string): void;
  disconnect(dsId: string): Promise<void>;
  /** Open a listed console's editor (key is the console file uri). */
  openConsoleFile(dsId: string, key: string): Promise<void>;
}

export interface ConsoleSyncEntry {
  key: string;
  label: string;
  dsId: string;
  dsName: string;
  vendor: string;
  envColor: string | null;
}

interface ResultTab {
  id: string;
  /** The statement that produced this tab; re-running it reuses the tab. */
  sqlKey: string;
  title: string;
  provider: GridProvider;
  meta: GridMeta;
  page: GridPage;
}

interface ConsoleEntry {
  key: string;
  label: string;
  dsId: string;
  dsName: string;
  vendor: string;
  envColor: string | null;
  /** "running…", "42 ms", "idle", "error". */
  status: string;
  tabs: ResultTab[];
  activeTabId: string;
  /** The content pane shows the error message instead of a tab's content. */
  showingError: boolean;
  resultCounter: number;
  /** This console's own Output log, like IntelliJ's per-console output. */
  output: OutputEntry[];
}

const OUTPUT_CAP = 500;

/**
 * The Tablecloth view in the bottom panel, shaped like IntelliJ's Services
 * tool window: a Database tree of consoles on the left, and per-console
 * result tabs (plus the Output audit log) on the right.
 */
export class ServicesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'tablecloth.services';

  readonly grid = new GridController();
  private readonly consoles = new Map<string, ConsoleEntry>();
  private activeConsoleKey: string | undefined;
  /** Set when the data source row (not a console) is selected in the tree. */
  private selectedDsId: string | undefined;
  private actions?: DataSourceActions;
  private view?: vscode.WebviewView;
  private viewReady = false;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.grid.onDidRender = (page) => {
      const tab = this.activeTab();
      if (tab) tab.page = page;
    };
  }

  setDataSourceActions(actions: DataSourceActions): void {
    this.actions = actions;
  }

  private activeConsole(): ConsoleEntry | undefined {
    return this.activeConsoleKey ? this.consoles.get(this.activeConsoleKey) : undefined;
  }

  private activeTab(): ResultTab | undefined {
    const entry = this.activeConsole();
    return entry?.tabs.find((t) => t.id === entry.activeTabId);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
      ],
    };
    view.webview.html = gridHtml(view.webview, this.extensionUri, 'services');
    view.webview.onDidReceiveMessage((message) => {
      switch (message?.type) {
        case 'ready':
          // A freshly loaded webview lost the output log and chrome; replay them.
          this.viewReady = true;
          this.grid.onReady();
          this.postChrome();
          this.postOutputReset();
          return;
        case 'selectConsole':
          void this.selectConsole(String(message.key));
          return;
        case 'openConsole': {
          const entry = this.consoles.get(String(message.key));
          if (entry && !entry.key.startsWith('script:')) {
            void this.actions?.openConsoleFile(entry.dsId, entry.key);
          }
          return;
        }
        case 'selectDataSource':
          void this.selectDataSource(String(message.dsId));
          return;
        case 'dsAction':
          void this.runDataSourceAction(String(message.action), String(message.dsId));
          return;
        case 'dsConsoleMenu':
          void this.openConsoleMenu(String(message.dsId));
          return;
        case 'menuPick':
          void this.actions?.consoleMenuPick(String(message.dsId), String(message.itemId));
          return;
        case 'menuButton':
          void this.actions?.consoleMenuButton(String(message.dsId), String(message.itemId), String(message.buttonId));
          return;
        case 'selectTab':
          void this.selectTab(String(message.id));
          return;
        case 'closeTab':
          void this.closeTab(String(message.id));
          return;
        default:
          void this.grid.handleMessage(message);
      }
    });
    view.onDidDispose(() => {
      this.grid.detach(view.webview);
      if (this.view === view) {
        this.view = undefined;
        this.viewReady = false;
      }
    });
    this.grid.attach(view.webview);
  }

  private post(message: unknown): void {
    if (this.view && this.viewReady) void this.view.webview.postMessage(message);
  }

  /** Push the tree + tab chrome to the webview. */
  private postChrome(): void {
    const groups = new Map<string, { dsId: string; dsName: string; vendor: string; envColor: string | null; selected: boolean; consoles: any[] }>();
    for (const entry of this.consoles.values()) {
      let group = groups.get(entry.dsId);
      if (!group) {
        group = {
          dsId: entry.dsId,
          dsName: entry.dsName,
          vendor: entry.vendor,
          envColor: entry.envColor,
          selected: entry.dsId === this.selectedDsId,
          consoles: [],
        };
        groups.set(entry.dsId, group);
      }
      group.consoles.push({
        key: entry.key,
        label: entry.label,
        status: entry.status,
        active: !this.selectedDsId && entry.key === this.activeConsoleKey,
      });
    }

    let tabs: any[];
    let dsActions: string | null = null;
    let error = false;
    if (this.selectedDsId) {
      // the IntelliJ data source view: an Information tab plus its action row
      tabs = [{ id: '__info', title: 'Information', active: true, closable: false }];
      dsActions = this.selectedDsId;
    } else {
      const active = this.activeConsole();
      // while an error is showing, no tab is active: the content pane holds
      // the error message, not a tab's content
      error = !!active?.showingError;
      tabs = active
        ? [
            { id: OUTPUT_TAB, title: 'Output', active: !error && active.activeTabId === OUTPUT_TAB, closable: false },
            ...active.tabs.map((t) => ({
              id: t.id,
              title: t.title,
              active: !error && t.id === active.activeTabId,
              closable: true,
            })),
          ]
        : [{ id: OUTPUT_TAB, title: 'Output', active: true, closable: false }];
    }
    this.post({ type: 'services', tree: [...groups.values()], tabs, dsActions, error });
  }

  // ------------------------------------------------------------ console registry

  /**
   * Mirror the persisted console files into the tree: consoles exist on disk
   * whether or not they ran anything this session. Entries keep their runtime
   * state (tabs, status) across syncs; entries whose file is gone drop out;
   * script runs (no backing file) stay.
   */
  syncConsoles(entries: ConsoleSyncEntry[]): void {
    const next = new Map<string, ConsoleEntry>();
    for (const entry of entries) {
      const existing = this.consoles.get(entry.key);
      next.set(entry.key, {
        ...(existing ?? {
          key: entry.key,
          status: 'idle',
          tabs: [],
          activeTabId: OUTPUT_TAB,
          showingError: false,
          resultCounter: 0,
          output: [],
        }),
        label: entry.label,
        dsId: entry.dsId,
        dsName: entry.dsName,
        vendor: entry.vendor,
        envColor: entry.envColor,
      });
    }
    for (const [key, entry] of this.consoles) {
      if (key.startsWith('script:') && !next.has(key)) next.set(key, entry);
    }
    this.consoles.clear();
    for (const [key, entry] of next) this.consoles.set(key, entry);
    if (this.activeConsoleKey && !this.consoles.has(this.activeConsoleKey)) {
      this.activeConsoleKey = undefined;
      this.postOutputReset();
    }
    if (this.selectedDsId && ![...this.consoles.values()].some((e) => e.dsId === this.selectedDsId)) {
      this.selectedDsId = undefined;
    }
    this.postChrome();
  }

  upsertConsole(key: string, label: string, dsId: string, dsName: string, vendor: string, envColor: string | null): void {
    const existing = this.consoles.get(key);
    if (existing) {
      existing.label = label;
      existing.dsId = dsId;
      existing.dsName = dsName;
      existing.vendor = vendor;
      existing.envColor = envColor;
    } else {
      this.consoles.set(key, {
        key,
        label,
        dsId,
        dsName,
        vendor,
        envColor,
        status: 'idle',
        tabs: [],
        activeTabId: OUTPUT_TAB,
        showingError: false,
        resultCounter: 0,
        output: [],
      });
    }
    this.postChrome();
  }

  setStatus(key: string, status: string): void {
    const entry = this.consoles.get(key);
    if (!entry) return;
    entry.status = status;
    this.postChrome();
  }

  nextResultNumber(key: string): number {
    const entry = this.consoles.get(key);
    if (!entry) return 1;
    entry.resultCounter += 1;
    return entry.resultCounter;
  }

  removeConsole(key: string): void {
    if (!this.consoles.delete(key)) return;
    if (this.activeConsoleKey === key) {
      this.activeConsoleKey = [...this.consoles.keys()].pop();
      const next = this.activeTab();
      if (next) void this.grid.show(next.provider, next.meta, next.page);
      this.postOutputReset();
    }
    this.postChrome();
  }

  // ------------------------------------------------------------ results

  /** Show a result in its tab; re-running the same statement reuses its tab, like IntelliJ. */
  async showResultTab(
    key: string,
    sqlKey: string,
    titleFactory: () => string,
    provider: GridProvider,
    meta: GridMeta,
    page: GridPage,
  ): Promise<void> {
    const entry = this.consoles.get(key);
    if (!entry) return;
    let tab = entry.tabs.find((t) => t.sqlKey === sqlKey);
    if (tab) {
      tab.provider = provider;
      tab.meta = meta;
      tab.page = page;
    } else {
      tab = { id: randomBytes(6).toString('hex'), sqlKey, title: titleFactory(), provider, meta, page };
      entry.tabs.push(tab);
    }
    entry.activeTabId = tab.id;
    entry.showingError = false;
    const consoleChanged = this.activeConsoleKey !== key;
    this.activeConsoleKey = key;
    this.selectedDsId = undefined;
    await this.grid.show(provider, meta, page);
    this.postChrome();
    if (consoleChanged) this.postOutputReset();
  }

  /** Errors render in the content pane without becoming a tab. */
  showError(key: string, text: string, meta: GridMeta): void {
    const entry = this.consoles.get(key);
    if (entry) entry.showingError = true;
    const consoleChanged = this.activeConsoleKey !== key;
    this.activeConsoleKey = key;
    this.selectedDsId = undefined;
    this.grid.showMessage(text, 'error', meta);
    this.postChrome();
    if (consoleChanged) this.postOutputReset();
  }

  private async selectConsole(key: string): Promise<void> {
    const entry = this.consoles.get(key);
    if (!entry) return;
    entry.showingError = false;
    const consoleChanged = this.activeConsoleKey !== key;
    this.selectedDsId = undefined;
    this.activeConsoleKey = key;
    const tab = this.activeTab();
    if (tab) await this.grid.show(tab.provider, tab.meta, tab.page);
    this.postChrome();
    if (consoleChanged) this.postOutputReset();
  }

  private async selectDataSource(dsId: string): Promise<void> {
    this.selectedDsId = dsId;
    this.postChrome();
    const lines = this.actions ? await this.actions.info(dsId).catch(() => []) : [];
    this.post({ type: 'info', lines });
  }

  private async openConsoleMenu(dsId: string): Promise<void> {
    if (!this.actions) return;
    const items = await this.actions.consoleMenuItems(dsId);
    this.post({ type: 'menu', dsId, items });
  }

  private async runDataSourceAction(action: string, dsId: string): Promise<void> {
    if (!this.actions) return;
    switch (action) {
      case 'properties':
        this.actions.openProperties(dsId);
        break;
      case 'disconnect':
        await this.actions.disconnect(dsId);
        // refresh the info view; the DBMS line reflects the dropped session
        await this.selectDataSource(dsId);
        break;
    }
  }

  private async selectTab(id: string): Promise<void> {
    if (id === '__info') return;
    const entry = this.activeConsole();
    if (!entry) return;
    entry.activeTabId = id;
    entry.showingError = false;
    if (id !== OUTPUT_TAB) {
      const tab = entry.tabs.find((t) => t.id === id);
      if (tab) await this.grid.show(tab.provider, tab.meta, tab.page);
    }
    this.postChrome();
  }

  private async closeTab(id: string): Promise<void> {
    const entry = this.activeConsole();
    if (!entry) return;
    const index = entry.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    entry.tabs.splice(index, 1);
    if (entry.activeTabId === id) {
      const next = entry.tabs[index] ?? entry.tabs[index - 1];
      entry.activeTabId = next?.id ?? OUTPUT_TAB;
      if (next) await this.grid.show(next.provider, next.meta, next.page);
    }
    this.postChrome();
  }

  // ------------------------------------------------------------ output log

  /** The webview shows only the active console's log; reload it wholesale. */
  private postOutputReset(): void {
    this.post({ type: 'outputReset', entries: this.activeConsole()?.output ?? [] });
  }

  appendOutput(key: string, entry: OutputEntry): void {
    const console = this.consoles.get(key);
    if (console) {
      console.output.push(entry);
      if (console.output.length > OUTPUT_CAP) console.output.splice(0, console.output.length - OUTPUT_CAP);
    }
    if (key === this.activeConsoleKey) this.post({ type: 'output', entry });
  }

  async reveal(): Promise<void> {
    // keep focus in the console when the view already exists; the focus
    // command is only needed to summon it the first time
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ServicesViewProvider.viewId}.focus`);
  }
}
