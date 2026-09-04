import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSourceConfig, DataSourceSecrets, StorageScope, StoredDataSource } from '../core/types';
import { defaultStorageScope, errorMessage } from '../core/util';
import type { DataSourceStore } from '../data/store';
import { getDriver } from '../drivers/index';
import type { SessionManager } from '../drivers/sessions';
import { detachActiveEditor, getSurfacePresentation, openEmptyFloatingWindow } from './floatingWindow';

/** Map key for the one new-source dialog; edit dialogs key on their source id. */
const NEW_DIALOG_KEY = 'new';

/**
 * The Data Sources and Drivers dialog. Opens in its own compact floating
 * window (like the IntelliJ dialog), falling back to an editor tab on builds
 * that cannot detach windows or when `tablecloth.dataSourceDialog.openIn`
 * says so.
 */
export class DataSourceDialog {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** Serialises open(): two quick opens racing openEmptyFloatingWindow would
   * each open a window, and the loser's stays empty forever. */
  private pendingOpen: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
  ) {}

  open(existing?: StoredDataSource): void {
    const run = this.pendingOpen.then(() => this.openNow(existing));
    this.pendingOpen = run.catch(() => undefined);
  }

  private async openNow(existing?: StoredDataSource): Promise<void> {
    const panelKey = existing?.config.id ?? NEW_DIALOG_KEY;
    const already = this.panels.get(panelKey);
    if (already) {
      already.reveal(already.viewColumn);
      return;
    }

    const isNew = !existing;
    const config: DataSourceConfig = existing
      ? structuredClone(existing.config)
      : {
          id: randomUUID(),
          name: '',
          driver: 'postgres',
          color: 'none',
          readOnly: false,
          autoSync: true,
          auth: 'userPassword',
          host: 'localhost',
        };
    const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const projectScopeAvailable = hasWorkspaceFolder && vscode.workspace.isTrusted;
    const scope: StorageScope = existing?.scope ?? defaultStorageScope(hasWorkspaceFolder, vscode.workspace.isTrusted);

    // Same ordering as every Porcelain surface: create the window first so the
    // dialog renders where it belongs instead of appearing here and jumping.
    const floating = getSurfacePresentation() === 'floatingWindow';
    const detached = floating ? await openEmptyFloatingWindow() : false;

    const panel = vscode.window.createWebviewPanel(
      'tablecloth.dataSourceDialog',
      isNew ? 'New Data Source' : `Data Source: ${config.name}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );
    this.panels.set(panelKey, panel);
    panel.onDidDispose(() => {
      if (this.panels.get(panelKey) === panel) this.panels.delete(panelKey);
    });
    panel.webview.html = this.html(panel.webview);

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready': {
          const secrets = await this.store.getSecrets(config.id);
          void panel.webview.postMessage({
            type: 'init',
            config,
            scope,
            isNew,
            projectScopeAvailable,
            secretsPresent: {
              password: !!secrets.password,
              sshPassword: !!secrets.sshPassword,
              sshPassphrase: !!secrets.sshPassphrase,
            },
          });
          break;
        }
        case 'browse': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: message.title ?? 'Select file',
          });
          if (picked?.[0]) {
            void panel.webview.postMessage({ type: 'browsed', field: message.field, path: picked[0].fsPath });
          }
          break;
        }
        case 'test': {
          const result = await this.testConnection(config.id, message.config, message.secrets ?? {});
          void panel.webview.postMessage({ type: 'testResult', ...result });
          break;
        }
        case 'loadSchemas': {
          const result = await this.loadSchemas(config.id, message.config, message.secrets ?? {});
          void panel.webview.postMessage({ type: 'schemas', ...result });
          break;
        }
        case 'save': {
          try {
            await this.save(config.id, message.config, message.secrets ?? {}, message.scope === 'project' ? 'project' : 'global');
            panel.dispose();
          } catch (err) {
            void vscode.window.showErrorMessage(`Could not save data source: ${errorMessage(err)}`);
          }
          break;
        }
        case 'cancel':
          panel.dispose();
          break;
      }
    });

    // Builds without newEmptyEditorWindow render the dialog here first and
    // then move it, which the user sees as a brief flash.
    if (floating && !detached) {
      await detachActiveEditor(
        (tab) => tab.input instanceof vscode.TabInputWebview && tab.label === panel.title,
      );
    }
  }

  private normalizeIncoming(id: string, raw: any): DataSourceConfig {
    return {
      id,
      name: String(raw?.name ?? '').trim() || 'unnamed',
      driver: raw?.driver === 'mysql' || raw?.driver === 'sqlite' ? raw.driver : 'postgres',
      color: ['green', 'amber', 'red', 'blue', 'purple'].includes(raw?.color) ? raw.color : 'none',
      readOnly: !!raw?.readOnly,
      autoSync: raw?.autoSync !== false,
      host: str(raw?.host),
      port: num(raw?.port),
      database: str(raw?.database),
      user: str(raw?.user),
      auth: raw?.auth === 'pgpass' || raw?.auth === 'none' ? raw.auth : 'userPassword',
      file: str(raw?.file),
      ssl:
        raw?.ssl?.mode && raw.ssl.mode !== 'disable'
          ? { mode: raw.ssl.mode, caFile: str(raw.ssl.caFile) }
          : undefined,
      ssh: raw?.ssh?.enabled
        ? {
            enabled: true,
            host: String(raw.ssh.host ?? ''),
            port: num(raw.ssh.port) ?? 22,
            user: String(raw.ssh.user ?? ''),
            auth: raw.ssh.auth === 'keyFile' || raw.ssh.auth === 'agent' ? raw.ssh.auth : 'password',
            keyFile: str(raw.ssh.keyFile),
          }
        : undefined,
      schemas: Array.isArray(raw?.schemas) && raw.schemas.length > 0 ? raw.schemas.map(String) : undefined,
    };
  }

  private async mergedSecrets(id: string, typed: Record<string, unknown>): Promise<DataSourceSecrets> {
    const stored = await this.store.getSecrets(id);
    return {
      password: typeof typed.password === 'string' ? typed.password : stored.password,
      sshPassword: typeof typed.sshPassword === 'string' ? typed.sshPassword : stored.sshPassword,
      sshPassphrase: typeof typed.sshPassphrase === 'string' ? typed.sshPassphrase : stored.sshPassphrase,
    };
  }

  private async testConnection(
    id: string,
    rawConfig: any,
    typedSecrets: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const config = this.normalizeIncoming(id, rawConfig);
      const secrets = await this.mergedSecrets(id, typedSecrets);
      const driver = getDriver(config.driver);
      const session = await driver.connect({ config, secrets });
      const version = session.serverVersion;
      await session.close();
      return { ok: true, message: version };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  private async loadSchemas(
    id: string,
    rawConfig: any,
    typedSecrets: Record<string, unknown>,
  ): Promise<{ ok: boolean; list?: string[]; message?: string }> {
    try {
      const config = this.normalizeIncoming(id, rawConfig);
      const secrets = await this.mergedSecrets(id, typedSecrets);
      const driver = getDriver(config.driver);
      const session = await driver.connect({ config, secrets });
      try {
        return { ok: true, list: await driver.listSchemas(session) };
      } finally {
        await session.close();
      }
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  private async save(
    id: string,
    rawConfig: any,
    typedSecrets: Record<string, unknown>,
    scope: StorageScope,
  ): Promise<void> {
    const config = this.normalizeIncoming(id, rawConfig);
    if (scope === 'project' && (vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      throw new Error('Project scope needs an open workspace folder.');
    }
    for (const field of ['password', 'sshPassword', 'sshPassphrase'] as const) {
      if (typeof typedSecrets[field] === 'string') {
        await this.store.setSecret(id, field, typedSecrets[field] as string);
      }
    }
    await this.store.save(config, scope);
    await this.sessions.invalidate(id);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dialog.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dialog.js'));
    const validationJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'validation.js'),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div class="dlg">
  <div class="row head">
    <label>Name:</label>
    <input id="f-name" type="text" spellcheck="false">
    <select id="f-color" title="Environment color">
      <option value="none">No color</option>
      <option value="green">Green (dev)</option>
      <option value="amber">Amber (staging)</option>
      <option value="red">Red (prod)</option>
      <option value="blue">Blue</option>
      <option value="purple">Purple</option>
    </select>
    <select id="f-scope" title="Where this data source definition is stored">
      <option value="project">Project</option>
      <option value="global">Global</option>
    </select>
  </div>

  <div class="tabs">
    <button class="tab on" data-tab="general">General</button>
    <button class="tab" data-tab="options">Options</button>
    <button class="tab" data-tab="ssh">SSH/SSL</button>
    <button class="tab" data-tab="schemas">Schemas</button>
  </div>

  <div class="pane" id="pane-general">
    <div class="frm">
      <label>Driver:</label>
      <select id="f-driver">
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL / MariaDB</option>
        <option value="sqlite">SQLite</option>
      </select>

      <label class="net">Host:</label>
      <span class="net hostrow"><input id="f-host" type="text" spellcheck="false">
        <label class="inline">Port:</label><input id="f-port" type="text" class="port" spellcheck="false"></span>

      <label class="net">Authentication:</label>
      <select id="f-auth" class="net">
        <option value="userPassword">User &amp; Password</option>
        <option value="pgpass" data-pg-only="1">pgpass</option>
        <option value="none">No auth</option>
      </select>

      <label class="net cred">User:</label>
      <input id="f-user" type="text" class="net cred" spellcheck="false">

      <label class="net pass">Password:</label>
      <input id="f-password" type="password" class="net pass">

      <label class="net">Database:</label>
      <input id="f-database" type="text" class="net" spellcheck="false">

      <label class="lite">File:</label>
      <span class="lite filerow"><input id="f-file" type="text" spellcheck="false">
        <button id="b-file" class="btn">Browse…</button></span>

      <label>URL:</label>
      <code id="f-url" class="url"></code>
    </div>
  </div>

  <div class="pane" id="pane-options" hidden>
    <div class="frm">
      <label>Read-only:</label>
      <span><input id="f-readonly" type="checkbox"> <span class="hint">Sets the session read-only server-side; the data editor refuses edits as well.</span></span>
      <label>Introspection:</label>
      <span><input id="f-autosync" type="checkbox" checked> <span class="hint">Auto-sync: re-introspect on connect. Off = only on manual refresh.</span></span>
    </div>
  </div>

  <div class="pane" id="pane-ssh" hidden>
    <div class="frm">
      <label>SSH tunnel:</label>
      <span><input id="f-ssh-on" type="checkbox"></span>
      <label class="ssh">SSH host:</label>
      <span class="ssh hostrow"><input id="f-ssh-host" type="text" spellcheck="false">
        <label class="inline">Port:</label><input id="f-ssh-port" type="text" class="port" value="22" spellcheck="false"></span>
      <label class="ssh">SSH user:</label>
      <input id="f-ssh-user" type="text" class="ssh" spellcheck="false">
      <label class="ssh">SSH auth:</label>
      <select id="f-ssh-auth" class="ssh">
        <option value="password">Password</option>
        <option value="keyFile">Key file</option>
        <option value="agent">OpenSSH agent</option>
      </select>
      <label class="ssh sshpass">SSH password:</label>
      <input id="f-ssh-password" type="password" class="ssh sshpass">
      <label class="ssh sshkey">Key file:</label>
      <span class="ssh sshkey filerow"><input id="f-ssh-key" type="text" spellcheck="false">
        <button id="b-ssh-key" class="btn">Browse…</button></span>
      <label class="ssh sshkey">Passphrase:</label>
      <input id="f-ssh-passphrase" type="password" class="ssh sshkey">

      <label class="net">SSL mode:</label>
      <select id="f-ssl-mode" class="net">
        <option value="disable">disable</option>
        <option value="require">require</option>
        <option value="verify-ca">verify-ca</option>
        <option value="verify-full">verify-full</option>
      </select>
      <label class="net sslca">CA file:</label>
      <span class="net sslca filerow"><input id="f-ssl-ca" type="text" spellcheck="false">
        <button id="b-ssl-ca" class="btn">Browse…</button></span>
    </div>
  </div>

  <div class="pane" id="pane-schemas" hidden>
    <p class="hint">Choose which schemas are introspected and shown in the tree. Nothing checked = the driver default (PostgreSQL: public; MySQL: the connection's database).</p>
    <button id="b-schemas" class="btn">Load schemas from server</button>
    <div id="schema-list" class="schema-list"></div>
  </div>

  <div class="foot">
    <button id="b-test" class="btn link-like">Test Connection</button>
    <span id="test-result"></span>
    <span class="spacer"></span>
    <button id="b-cancel" class="btn">Cancel</button>
    <button id="b-save" class="btn primary">OK</button>
  </div>
</div>
<script nonce="${nonce}" src="${validationJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : undefined;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
